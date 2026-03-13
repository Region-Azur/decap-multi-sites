/**
 * Authentication helpers.
 *
 * Provides:
 *  - getAuthInfo     — resolves the caller identity from Bearer token or proxy headers
 *  - getOrCreateUser — idempotent upsert into the `users` table
 *  - requireAdmin    — middleware-style guard that returns the admin user or sends 401/403
 *  - requireUser     — middleware-style guard that returns any authenticated user
 *  - getSiteForUser  — permission-aware site lookup
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const db = require("../db");
const config = require("../config");

// ─── Normalise email ──────────────────────────────────────────────────────────

function normalizeEmail(value) {
  if (!value) return "";
  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") ? normalized : "";
}

// ─── Resolve caller identity ──────────────────────────────────────────────────

/**
 * Extracts auth information from the request.
 *
 * Priority:
 *  1. Bearer token — API token (hashed) or signed JWT
 *  2. oauth2-proxy / nginx X-Auth-Request-* / X-Forwarded-* headers
 *
 * Returns `null` if no valid credentials are found.
 */
async function getAuthInfo(req) {
  const authHeader = req.header("authorization");

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);

    // ── API token (stored as SHA-256 hash) ──────────────────────────────────
    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const apiToken = await db("api_tokens").where({ token: tokenHash }).first();
    if (apiToken) {
      if (
        apiToken.expires_at &&
        new Date(apiToken.expires_at) < new Date()
      ) {
        console.log("INFO: Rejected expired API token");
      } else {
        const user = await db("users").where({ id: apiToken.user_id }).first();
        if (user) {
          console.log(
            `INFO: Authenticated via API token for user id=${user.id}`
          );
          return {
            issuer: user.oidc_issuer,
            sub: user.oidc_sub,
            email: user.email,
            name: user.name,
            siteId: apiToken.site_id,
            isApiToken: true,
          };
        }
      }
    }

    // ── Signed JWT ───────────────────────────────────────────────────────────
    if (config.JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, config.JWT_SECRET, {
          algorithms: ["HS256"],
        });
        if (decoded && decoded.email) {
          const jwtUser = await db("users")
            .where({ email: decoded.email })
            .first();
          if (jwtUser) {
            const siteId = decoded.siteId || null;
            console.log(
              `INFO: Authenticated via verified JWT for user id=${jwtUser.id}, siteId=${siteId}`
            );
            return {
              issuer: jwtUser.oidc_issuer,
              sub: jwtUser.oidc_sub,
              email: jwtUser.email,
              name: jwtUser.name,
              siteId,
              isJwt: true,
            };
          }
        }
      } catch (jwtErr) {
        console.log(`INFO: JWT verification failed: ${jwtErr.message}`);
      }
    }
  }

  // ── oauth2-proxy / nginx forwarded headers ───────────────────────────────
  const issuer =
    req.header("x-auth-request-issuer") || config.DEFAULT_OIDC_ISSUER;

  const sub =
    req.header("x-auth-request-user") || req.header("x-forwarded-user");
  const emailHeader =
    req.header("x-auth-request-email") || req.header("x-forwarded-email");
  const preferredUsername =
    req.header("x-auth-request-preferred-username") ||
    req.header("x-forwarded-preferred-username");

  const email =
    normalizeEmail(emailHeader) || normalizeEmail(preferredUsername);
  const name = preferredUsername || sub || emailHeader;

  if (!issuer || !sub || !email) {
    return null;
  }

  const dbUser = await db("users").where({ email }).first();
  let siteId = null;
  if (dbUser) {
    const perm = await db("site_permissions")
      .where({ user_id: dbUser.id })
      .first();
    if (perm) siteId = perm.site_id;
  }

  return { issuer, sub, email, name, siteId };
}

// ─── User upsert ─────────────────────────────────────────────────────────────

/**
 * Finds the user matching `auth.issuer + auth.sub`, or creates a new one.
 * The very first user in the database and any email listed in ADMIN_EMAILS
 * are granted the `is_admin` flag automatically.
 */
async function getOrCreateUser(auth) {
  const existing = await db("users")
    .where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub })
    .first();

  if (existing) return existing;

  const id = crypto.randomUUID();

  await db.transaction(async (trx) => {
    // Re-check inside the transaction to survive the race between SELECT and INSERT
    const alreadyExists = await trx("users")
      .where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub })
      .first();
    if (alreadyExists) return;

    const isFirstUser =
      (await trx("users").count("id as count").first()).count === 0;
    const isAdmin =
      isFirstUser || config.ADMIN_EMAILS.includes(auth.email);

    await trx("users").insert({
      id,
      oidc_issuer: auth.issuer,
      oidc_sub: auth.sub,
      email: auth.email,
      name: auth.name,
      is_admin: isAdmin,
    });
  });

  // Re-fetch (handles both created-now and already-existed-inside-tx cases)
  return db("users")
    .where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub })
    .first();
}

// ─── Route guards ─────────────────────────────────────────────────────────────

/**
 * Resolves the authenticated user and verifies they are an admin.
 * Sends 401/403 and returns `null` on failure.
 */
async function requireAdmin(req, res) {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  const user = await getOrCreateUser(auth);
  if (!user.is_admin) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }

  return user;
}

/**
 * Resolves any authenticated user.
 * Sends 401 and returns `null` on failure.
 */
async function requireUser(req, res) {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  const user = await getOrCreateUser(auth);
  // Propagate siteId from auth context (JWT / API token)
  if (auth.siteId) {
    user.siteId = auth.siteId;
  }
  return user;
}

// ─── Site lookup ──────────────────────────────────────────────────────────────

/**
 * Returns the site record if the user has access to it (admin = all enabled
 * sites, regular user = only their permitted sites).
 */
async function getSiteForUser(user, siteId) {
  if (user.is_admin) {
    return db("sites").where({ id: siteId, enabled: true }).first();
  }

  return db("sites")
    .join("site_permissions", "sites.id", "site_permissions.site_id")
    .where({
      "site_permissions.user_id": user.id,
      "sites.id": siteId,
      "sites.enabled": true,
    })
    .select("sites.*")
    .first();
}

module.exports = {
  normalizeEmail,
  getAuthInfo,
  getOrCreateUser,
  requireAdmin,
  requireUser,
  getSiteForUser,
};

