const crypto = require("crypto");
const { normalizeEmail, fetchUserInfo, parseJwt } = require("../utils/oidc");
const config = require("../config");
const logger = require("../shared/logger");

async function getAuthInfo(req) {

  const issuer = req.header("x-auth-request-issuer") || config.DEFAULT_OIDC_ISSUER;
  const sub = req.header("x-auth-request-user") || req.header("x-forwarded-user");
  const emailHeader = req.header("x-auth-request-email") || req.header("x-forwarded-email");
  const preferredUsername = req.header("x-auth-request-preferred-username") || req.header("x-forwarded-preferred-username");
  const nameHeader = req.header("x-auth-request-name") || req.header("x-forwarded-name");
  const accessToken = req.header("x-auth-request-access-token") || req.header("x-forwarded-access-token");
  const idToken = req.header("x-auth-request-id-token") || req.header("x-forwarded-id-token");

  let email = normalizeEmail(emailHeader) || normalizeEmail(preferredUsername);
  let name = nameHeader || preferredUsername || sub || emailHeader;

  if (idToken) {
    const claims = parseJwt(idToken);
    if (claims) {
      logger.debug("ID Token claims parsed", { claimsKeys: Object.keys(claims) });
      if (claims.name) {
        name = claims.name;
      } else if (claims.nickname) {
        name = claims.nickname;
      } else if (claims.given_name) {
        name = claims.given_name;
        if (claims.family_name) name += ` ${claims.family_name}`;
      }
    }
  }

  logger.debug("Auth info extracted", { issuer: issuer.substring(0, 30), hasEmail: !!email, hasSub: !!sub });

  if (!issuer || !sub || !email) {
    logger.trace("Auth info missing required fields", { issuer: !!issuer, sub: !!sub, email: !!email });
    return null;
  }

  return {
    issuer,
    sub,
    email,
    name,
    accessToken,
  };
}

async function getOrCreateUser(db, auth) {
  const existing = await db("users")
    .where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub })
    .first();

  if (existing) {
    const nameIsId = existing.name === existing.oidc_sub || existing.name === auth.sub;
    const shouldSync = auth.accessToken && auth.issuer && (nameIsId || !existing.last_synced_at || Date.now() - new Date(existing.last_synced_at).getTime() > 24 * 60 * 60 * 1000);

    if (shouldSync) {
      logger.debug("Syncing user info", { email: auth.email });
      try {
        const userInfo = await fetchUserInfo(auth.issuer, auth.accessToken, config.USERINFO_URL_OVERRIDE);

        if (userInfo) {
          let newName = existing.name;
          const nickname = userInfo.nickname;
          const givenName = userInfo.given_name || userInfo.first_name;
          const familyName = userInfo.family_name || userInfo.last_name;
          const name = userInfo.name;

          if (nickname) {
            newName = nickname;
          } else if (givenName) {
            newName = givenName;
            if (familyName) {
              newName += ` ${familyName}`;
            }
          } else if (name) {
            newName = name;
          }

          await db("users").where({ id: existing.id }).update({
            name: newName,
            last_synced_at: new Date(),
          });

          return { ...existing, name: newName };
        }
      } catch (e) {
        console.warn(`DEBUG: Failed to sync user info (ignoring): ${e.message}`);
      }
    }
    return existing;
  }

  const id = crypto.randomUUID();

  let initialName = auth.name;
  let lastSyncedAt = null;

  if (auth.accessToken && auth.issuer) {
    try {
      const userInfo = await fetchUserInfo(auth.issuer, auth.accessToken, config.USERINFO_URL_OVERRIDE);
      if (userInfo) {
        lastSyncedAt = new Date();
        const { nickname, given_name, family_name, name } = userInfo;
        if (nickname) {
          initialName = nickname;
        } else if (given_name) {
          initialName = given_name;
          if (family_name) {
            initialName += ` ${family_name}`;
          }
        } else if (name) {
          initialName = name;
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch initial user info (using fallback): ${e.message}`);
    }
  }

  const finalName = initialName;
  const finalSyncedAt = lastSyncedAt;

  await db.transaction(async (trx) => {
    const alreadyExists = await trx("users")
      .where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub })
      .first();
    if (alreadyExists) return;

    const isFirstUser = (await trx("users").count("id as count").first()).count === 0;
    const isAdmin = isFirstUser || config.ADMIN_EMAILS.includes(auth.email);

    await trx("users").insert({
      id,
      oidc_issuer: auth.issuer,
      oidc_sub: auth.sub,
      email: auth.email,
      name: finalName,
      is_admin: isAdmin,
      last_synced_at: finalSyncedAt,
    });
  });

  // Re-fetch the final record (handles won/lost race transparently)
  return db("users").where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub }).first();
}

module.exports = {
  getAuthInfo,
  getOrCreateUser,
};

