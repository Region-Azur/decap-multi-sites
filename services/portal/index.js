const express = require("express");
const path = require("path");
const { createDb, ensureSchema } = require("./shared/db");
const config = require("./config");
const { getAuthInfo, getOrCreateUser } = require("./middleware/auth");
const { listPermittedSites, hasPermission } = require("./middleware/permissions");
const { renderSitePicker } = require("./views/sitePicker");
const { renderAdminPanel } = require("./views/adminPanel");
const { renderDecapShell } = require("./views/decapShell");

const app = express();
const db = createDb(config.DATABASE_URL);

// Helper to check if user is admin based on ADMIN_EMAILS
function isAdmin(email) {
  return config.ADMIN_EMAILS.includes(email.toLowerCase());
}

// Serve static files (CSS, JS, images)
app.use(express.static(path.join(__dirname, "public")));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});


// Sites picker - for normal users (previously /admin)
app.get("/sites", async (req, res) => {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).send("Unauthorized");
    return;
  }

  const user = await getOrCreateUser(db, auth);
  const sites = await listPermittedSites(db, user);
  const userIsAdmin = isAdmin(user.email);

  res.type("html").send(renderSitePicker(user, sites, userIsAdmin));
});

// Admin panel - admins only (previously /admin-panel)
app.get("/admin", async (req, res) => {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).send("Unauthorized");
    return;
  }

  const user = await getOrCreateUser(db, auth);

  // Check if user is admin
  if (!isAdmin(user.email)) {
    res.status(403).send("Forbidden. Access restricted to admins.");
    return;
  }

  const sites = await db("sites").orderBy("display_name");
  const permissions = await db("site_permissions")
    .join("users", "site_permissions.user_id", "users.id")
    .join("sites", "site_permissions.site_id", "sites.id")
    .select(
      "site_permissions.user_id",
      "site_permissions.site_id",
      "users.email as user_email",
      "sites.display_name as site_name",
      "sites.id as site_slug"
    )
    .orderBy("users.email");
  const allUsers = await db("users").orderBy("name");

  res.type("html").send(renderAdminPanel(user, sites, permissions, allUsers));
});

// Minimal config.yml for Decap CMS (fallback)
app.get("/sites/config.yml", (_req, res) => {
  res.type("text/yaml").send("backend:\n  name: git-gateway\n");
});

// Decap CMS editor for a specific site
app.get("/sites/:siteId", async (req, res) => {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).send("Unauthorized");
    return;
  }

  const user = await getOrCreateUser(db, auth);
  const siteId = req.params.siteId;

  if (!(await hasPermission(db, user, siteId))) {
    res.status(403).send("Forbidden");
    return;
  }

  // Generate session token
  const base64Url = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const header = base64Url({ alg: "HS256", typ: "JWT" });
  const payload = base64Url({
    sub: user.id,
    email: user.email,
    siteId: siteId,
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60, // 1 year expiry
  });
  const signature = "dummy_signature";
  const token = `${header}.${payload}.${signature}`;

  await db("api_tokens").insert({
    token,
    user_id: user.id,
    site_id: siteId,
    created_at: new Date().toISOString(),
  });

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    res.status(404).send("Site not found");
    return;
  }

  res.type("html").send(renderDecapShell(site, token));
});

// Legacy config endpoint (for backward compatibility)
app.get("/configs/:siteId.yml", async (req, res) => {
  console.log(`DEBUG: Config request for ${req.params.siteId}`);

  const auth = await getAuthInfo(req);
  if (!auth) {
    console.log("DEBUG: Config request unauthorized (no auth info)");
    res.status(401).send("Unauthorized");
    return;
  }

  const user = await getOrCreateUser(db, auth);
  const siteId = req.params.siteId;

  const permitted = await hasPermission(db, user, siteId);
  console.log(`DEBUG: Permission check for user ${user.email} on site ${siteId}: ${permitted}`);

  if (!permitted) {
    res.status(403).send("Forbidden");
    return;
  }

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    console.log(`DEBUG: Site ${siteId} not found in DB`);
    res.status(404).send("Not found");
    return;
  }

  const configYaml = `backend: 
  name: git-gateway
  api_root: ${config.API_BASE_URL}/.netlify/git
  repo: ${site.github_repo}
  branch: ${site.branch}
media_folder: ${site.media_path}
public_folder: ${site.media_path}
collections: 
  - name: "pages"
    label: "Pages"
    folder: "${site.content_path}"
    create: true
    extension: "md"
    format: "frontmatter"
    slug: "{{slug}}"
    preview_path: "{{slug}}"
    fields: 
      - { label: "Title", name: "title", widget: "string" }
      - { label: "Show in sidebar", name: "sidebar", widget: "boolean", default: false, required: false }
      - { label: "Sidebar title", name: "sidebar_title", widget: "string", required: false }
      - label: "Sidebar icon (Font Awesome Free)"
        name: "sidebar_icon"
        widget: "select"
        required: false
        default: ""
        options:
          - { label: "None", value: "" }
          - { label: "Book", value: "fa-solid fa-book" }
          - { label: "Graduation Cap", value: "fa-solid fa-graduation-cap" }
          - { label: "Chalkboard", value: "fa-solid fa-chalkboard" }
          - { label: "Users", value: "fa-solid fa-users" }
          - { label: "House", value: "fa-solid fa-house" }
          - { label: "Folder", value: "fa-solid fa-folder" }
          - { label: "File Lines", value: "fa-solid fa-file-lines" }
          - { label: "List", value: "fa-solid fa-list" }
          - { label: "Circle Info", value: "fa-solid fa-circle-info" }
          - { label: "Calendar", value: "fa-solid fa-calendar" }
          - { label: "Image", value: "fa-solid fa-image" }
          - { label: "Link", value: "fa-solid fa-link" }
          - { label: "Globe", value: "fa-solid fa-globe" }
          - { label: "Envelope", value: "fa-solid fa-envelope" }
          - { label: "Phone", value: "fa-solid fa-phone" }
          - { label: "Paperclip", value: "fa-solid fa-paperclip" }
          - { label: "Gear", value: "fa-solid fa-gear" }
          - { label: "Star", value: "fa-solid fa-star" }
      - { label: "Sidebar order", name: "sidebar_order", widget: "number", required: false }
      - { label: "Layout", name: "layout", widget: "select", default: "page", options: ["page", "post"], hint: "Use 'page' for regular content pages with TOC support. Use 'post' for blog posts with date/author metadata." }
      - { label: "Posted", name: "date", widget: "datetime", format: "YYYY-MM-DD HH:mm:ss Z", date_format: "YYYY-MM-DD", time_format: "HH:mm:ss", default: "", required: false, hint: "Optional: Only needed for blog posts" }
      - { label: "Updated", name: "last_modified_at", widget: "datetime", format: "YYYY-MM-DD HH:mm:ss Z", date_format: "YYYY-MM-DD", time_format: "HH:mm:ss", required: false }
      - { label: "Table of contents", name: "toc", widget: "boolean", default: true, required: false, hint: "Show table of contents sidebar" }
      - { label: "Body", name: "body", widget: "markdown" }
`;
  res.type("text/yaml").send(configYaml);
});


// Root: redirect to sites (auth handled by /sites)
app.get("/", (_req, res) => {
  res.redirect(302, "/sites");
});

// Start server
(async () => {
  await ensureSchema(db);
  app.listen(config.PORT, () => {
    console.log(`Portal listening on ${config.PORT}`);
  });
})();
