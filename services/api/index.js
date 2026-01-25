const crypto = require("crypto");
const express = require("express");
const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");
const { createDb, ensureSchema } = require("./shared/db");

const PORT = Number(process.env.API_PORT || 4000);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const DEFAULT_OIDC_ISSUER = process.env.HITOBITO_OIDC_ISSUER || "";
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
const GITHUB_APP_PRIVATE_KEY_BASE64 =
  process.env.GITHUB_APP_PRIVATE_KEY_BASE64 === "true";
const API_BODY_LIMIT = process.env.API_BODY_LIMIT || "2mb";

const app = express();
const db = createDb(DATABASE_URL);

app.use(express.json({ limit: API_BODY_LIMIT }));

// Debug middleware to check incoming paths (fix 404 issues)
app.use((req, res, next) => {
  console.log(`DEBUG: Incoming Request ${req.method} ${req.url}`);
  next();
});

function normalizeEmail(value) {
  if (!value) {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") ? normalized : "";
}

async function getAuthInfo(req) {
  // Log all headers for debugging purposes
  console.log("DEBUG: Incoming headers:", JSON.stringify(req.headers, null, 2));

  const issuer = req.header("x-auth-request-issuer") || DEFAULT_OIDC_ISSUER;

  // Try X-Auth-Request headers first, then fall back to X-Forwarded headers
  const sub = req.header("x-auth-request-user") || req.header("x-forwarded-user");
  const emailHeader = req.header("x-auth-request-email") || req.header("x-forwarded-email");
  const preferredUsername = req.header("x-auth-request-preferred-username") || req.header("x-forwarded-preferred-username");

  const email = normalizeEmail(emailHeader) || normalizeEmail(preferredUsername);
  const name = preferredUsername || sub || emailHeader;

  if (!issuer || !sub || !email) {
    // Check for Bearer token for Decap/headless access
    const authHeader = req.header("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);

      const apiToken = await db("api_tokens").where({ token }).first();
      if (apiToken) {
        const user = await db("users").where({ id: apiToken.user_id }).first();
        if (user) {
          console.log(`DEBUG: Authenticated via API token for ${user.email}`);
          return {
            issuer: user.oidc_issuer,
            sub: user.oidc_sub,
            email: user.email,
            name: user.name,
            isApiToken: true
          };
        }
      }
    }

    return null;
  }

  return {
    issuer,
    sub,
    email,
    name,
  };
}

async function getOrCreateUser(auth) {
  const existing = await db("users")
    .where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub })
    .first();

  if (existing) {
    return existing;
  }

  const isFirstUser = (await db("users").count("id as count").first()).count === 0;
  const isAdmin = isFirstUser || ADMIN_EMAILS.includes(auth.email);
  const id = crypto.randomUUID();

  await db("users").insert({
    id,
    oidc_issuer: auth.issuer,
    oidc_sub: auth.sub,
    email: auth.email,
    name: auth.name,
    is_admin: isAdmin,
  });

  return db("users").where({ id }).first();
}

function normalizePrivateKey(rawKey) {
  if (!rawKey) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is required");
  }

  const decoded = GITHUB_APP_PRIVATE_KEY_BASE64
    ? Buffer.from(rawKey, "base64").toString("utf8")
    : rawKey;
  return decoded.replace(/\\n/g, "\n");
}

async function getOctokit() {
  if (!GITHUB_APP_ID || !GITHUB_APP_INSTALLATION_ID) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID are required");
  }

  const auth = createAppAuth({
    appId: GITHUB_APP_ID,
    privateKey: normalizePrivateKey(GITHUB_APP_PRIVATE_KEY),
    installationId: GITHUB_APP_INSTALLATION_ID,
  });

  const { token } = await auth({ type: "installation" });
  return new Octokit({ auth: token });
}

function parseRepo(fullName) {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo format: ${fullName}`);
  }
  return { owner, repo };
}

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

async function requireUser(req, res) {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  return getOrCreateUser(auth);
}

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

// Router for flexible path handling (handles /api prefix stripping)
const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/admin/sites", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) {
    return;
  }

  const sites = await db("sites").orderBy("display_name");
  res.json({ sites });
});

router.post("/admin/sites", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) {
    return;
  }

  const {
    id,
    display_name,
    github_repo,
    branch = "main",
    content_path = "content/",
    media_path = "static/uploads/",
    enabled = true,
  } = req.body;

  if (!id || !display_name || !github_repo) {
    res.status(400).json({ error: "id, display_name, github_repo required" });
    return;
  }

  await db("sites").insert({
    id,
    display_name,
    github_repo,
    branch,
    content_path,
    media_path,
    enabled: Boolean(enabled),
  });

  res.status(201).json({ id });
});

router.post("/admin/permissions", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) {
    return;
  }

  const { email, site_id, role } = req.body;
  if (!email || !site_id) {
    res.status(400).json({ error: "email and site_id required" });
    return;
  }

  const user = await db("users").where({ email: email.toLowerCase() }).first();
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }

  const site = await db("sites").where({ id: site_id }).first();
  if (!site) {
    res.status(404).json({ error: "site not found" });
    return;
  }

  await db("site_permissions")
    .insert({ user_id: user.id, site_id, role: role || null })
    .onConflict(["user_id", "site_id"])
    .merge();

  res.status(201).json({ user_id: user.id, site_id });
});

router.get("/admin/users", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) {
    return;
  }

  const q = (req.query.q || "").toLowerCase().trim();
  let query = db("users").orderBy("email");

  if (q) {
    query = query.where("email", "like", `%${q}%`);
  }

  const users = await query;
  res.json({ users });
});

// Git Gateway Compatibility Endpoints
router.get("/settings", async (_req, res) => {
  // Return empty settings or relevant git-gateway config
  // This endpoint confirms to the client that the backend is available.
  res.json({ git_gateway: { roles: null } });
});

router.get("/user", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    // requireUser handles the 401 response
    return;
  }

  // Return user structure compatible with what Decap expects
  // Usually it expects { email, name, avatar_url, ... }
  // + a token if we were doing token exchange, but here we just prove identity.
  res.json({
    email: user.email,
    name: user.name,
    login: user.email,
    id: user.id
  });
});

router.delete("/admin/permissions", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) {
    return;
  }

  const { email, site_id } = req.body;
  if (!email || !site_id) {
    res.status(400).json({ error: "email and site_id required" });
    return;
  }

  const user = await db("users").where({ email: email.toLowerCase() }).first();
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }

  await db("site_permissions")
    .where({ user_id: user.id, site_id })
    .del();

  res.status(204).send();
});

router.get("/sites/:siteId/contents", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }

  const site = await getSiteForUser(user, req.params.siteId);
  if (!site) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const path = req.query.path || "";
  const octokit = await getOctokit();
  const { owner, repo } = parseRepo(site.github_repo);

  const response = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref: site.branch,
  });

  res.json(response.data);
});

router.put("/sites/:siteId/contents", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }

  const site = await getSiteForUser(user, req.params.siteId);
  if (!site) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { path, content, message, sha, encoding } = req.body;
  if (!path || !content) {
    res.status(400).json({ error: "path and content required" });
    return;
  }

  const octokit = await getOctokit();
  const { owner, repo } = parseRepo(site.github_repo);
  const payload = {
    owner,
    repo,
    path,
    message: message || `[cms] ${user.email} update ${path}`,
    content:
      encoding === "base64" ? content : Buffer.from(content).toString("base64"),
    branch: site.branch,
  };

  if (sha) {
    payload.sha = sha;
  }

  const response = await octokit.repos.createOrUpdateFileContents(payload);
  res.json(response.data);
});

router.delete("/sites/:siteId/contents", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }

  const site = await getSiteForUser(user, req.params.siteId);
  if (!site) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { path, sha, message } = req.body;
  if (!path || !sha) {
    res.status(400).json({ error: "path and sha required" });
    return;
  }

  const octokit = await getOctokit();
  const { owner, repo } = parseRepo(site.github_repo);
  const response = await octokit.repos.deleteFile({
    owner,
    repo,
    path,
    message: message || `[cms] ${user.email} delete ${path}`,
    sha,
    branch: site.branch,
  });

  res.json(response.data);
});

// Generic GitHub Proxy for Git Gateway
// Proxies requests from /.netlify/git/github/* to https://api.github.com/*
router.all("/github/*", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return; // requireUser handles 401

  const path = req.params[0]; // Capture the * part
  const method = req.method;
  const body = req.body;

  console.log(`DEBUG: Proxying GitHub request: ${method} /${path}`);

  // Basic security check: ensure user has access to the repo they are trying to access
  if (!user.is_admin) {
    const match = path.match(/^repos\/([^/]+)\/([^/]+)/);
    if (match) {
      const owner = match[1];
      const repo = match[2];
      const fullRepo = `${owner}/${repo}`;

      const permittedSite = await db("sites")
        .join("site_permissions", "sites.id", "site_permissions.site_id")
        .where({
          "site_permissions.user_id": user.id,
          "sites.github_repo": fullRepo,
          "sites.enabled": true
        })
        .first();

      if (!permittedSite) {
        console.log(`DEBUG: Proxy denied for ${user.email} -> ${fullRepo}`);
        res.status(403).json({ error: "Forbidden: You do not have access to this repository." });
        return;
      }
    }
  }

  try {
    const octokit = await getOctokit();
    const response = await octokit.request(`${method} /${path}`, {
      data: body,
    });

    res.status(response.status).json(response.data);
  } catch (err) {
    console.error(`DEBUG: Proxy error: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.use("/", router);
app.use("/api", router);
app.use("/.netlify/git", router);

(async () => {
  await ensureSchema(db);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on ${PORT}`);
    console.log("API Service v3 (Router Refactor)");
  });
})();
