const crypto = require("crypto");
const express = require("express");
const { createDb, ensureSchema } = require("./shared/db");

const PORT = Number(process.env.PORTAL_PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const DEFAULT_OIDC_ISSUER = process.env.HITOBITO_OIDC_ISSUER || "";
const API_BASE_URL = process.env.API_BASE_URL || process.env.PORTAL_BASE_URL || "";

const app = express();
const db = createDb(DATABASE_URL);

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

  console.log(`DEBUG: Extracted auth info: issuer=${issuer}, sub=${sub}, email=${email}, name=${name}`);

  if (!issuer || !sub || !email) {
    console.log("DEBUG: Auth info missing required fields");
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

async function listPermittedSites(user) {
  if (user.is_admin) {
    return db("sites").where({ enabled: true }).orderBy("display_name");
  }

  return db("sites")
    .join("site_permissions", "sites.id", "site_permissions.site_id")
    .where({ "site_permissions.user_id": user.id, "sites.enabled": true })
    .select("sites.*")
    .orderBy("sites.display_name");
}

async function hasPermission(user, siteId) {
  if (user.is_admin) {
    const site = await db("sites").where({ id: siteId, enabled: true }).first();
    return Boolean(site);
  }

  const permission = await db("site_permissions")
    .where({ user_id: user.id, site_id: siteId })
    .first();
  return Boolean(permission);
}

function renderSitePicker(user, sites) {
  const listItems = sites
    .map(
      (site) =>
        `<li><a href="/admin/${site.id}">${site.display_name}</a></li>`
    )
    .join("");

  const adminLink = user.is_admin
    ? '<p><a href="/admin-panel">Admin panel</a></p>'
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Decap CMS Portal</title>
  </head>
  <body>
    <h1>Welcome, ${user.name}</h1>
    ${adminLink}
    <h2>Available sites</h2>
    <ul>${listItems || "<li>No sites assigned.</li>"}</ul>
  </body>
</html>`;
}

function renderDecapShell(siteId) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Decap CMS - ${siteId}</title>
    <link rel="cms-config-url" href="/configs/${siteId}.yml" />
    <script src="https://unpkg.com/decap-cms@^3.0.0/dist/decap-cms.js"></script>
  </head>
  <body>
    <script>window.CMS.init();</script>
  </body>
</html>`;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function handleAdminHome(req, res) {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).send("Unauthorized");
    return;
  }

  const user = await getOrCreateUser(auth);
  const sites = await listPermittedSites(user);
  res.type("html").send(renderSitePicker(user, sites));
}

app.get("/", handleAdminHome);
app.get("/admin", handleAdminHome);

app.get("/admin/:siteId", async (req, res) => {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).send("Unauthorized");
    return;
  }

  const user = await getOrCreateUser(auth);
  const siteId = req.params.siteId;
  if (!(await hasPermission(user, siteId))) {
    res.status(403).send("Forbidden");
    return;
  }

  res.type("html").send(renderDecapShell(siteId));
});

app.get("/configs/:siteId.yml", async (req, res) => {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).send("Unauthorized");
    return;
  }

  const user = await getOrCreateUser(auth);
  const siteId = req.params.siteId;
  if (!(await hasPermission(user, siteId))) {
    res.status(403).send("Forbidden");
    return;
  }

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    res.status(404).send("Not found");
    return;
  }

  const config = `backend:\n  name: git-gateway\n  api_root: ${API_BASE_URL}/api\n  repo: ${site.github_repo}\n  branch: ${site.branch}\nmedia_folder: ${site.media_path}\npublic_folder: ${site.media_path}\ncollections: []\n`;
  res.type("text/yaml").send(config);
});

(async () => {
  await ensureSchema(db);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Portal listening on ${PORT}`);
  });
})();
