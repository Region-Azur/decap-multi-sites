const express = require("express");
const crypto = require("crypto");
const path = require("path");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { createDb, ensureSchema } = require("./shared/db");
const config = require("./config");
const { getAuthInfo, getOrCreateUser } = require("./middleware/auth");
const { listPermittedSites, hasPermission } = require("./middleware/permissions");
const { renderSitePicker } = require("./views/sitePicker");
const { renderAdminPanel } = require("./views/adminPanel");
const { renderDecapShell } = require("./views/decapShell");
const logger = require("./shared/logger");
const httpLogger = require("./shared/httpLogger");

const app = express();
// Trust the first proxy (oauth2-proxy / nginx) so express-rate-limit and
// other IP-based logic sees the real client IP from X-Forwarded-For.
app.set("trust proxy", 1);
const db = createDb(config.DATABASE_URL);

// HTTP request logging middleware
app.use(httpLogger);

// Security headers (relaxed for the portal which serves HTML pages with inline scripts)
app.use(helmet({
  contentSecurityPolicy: false, // Set explicitly per-page in Fix 18
  crossOriginResourcePolicy: { policy: "same-site" },
}));

// Rate limiting — 120 page requests per minute per IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later.",
}));

// Helper to check if user is admin based on ADMIN_EMAILS
function isAdmin(email) {
  return config.ADMIN_EMAILS.includes(email.toLowerCase());
}

// Serve static files (CSS, JS, images)
app.use(express.static(path.join(__dirname, "public")));

// Health check
app.get("/health", (_req, res) => {
  logger.debug("Health check requested");
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

// Admin JWT token endpoint - generate token for admin API calls
app.get("/admin/token", async (req, res) => {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const user = await getOrCreateUser(db, auth);

  if (!isAdmin(user.email)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Generate JWT token for admin operations
  const token = jwt.sign(
    { sub: user.id, email: user.email },
    config.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "1h" }
  );

  logger.debug("Admin JWT token generated", { userId: user.id, email: user.email });

  res.json({ token });
});

// User JWT token endpoint - generate token for user API calls (site settings)
app.get("/sites/token", async (req, res) => {
  const auth = await getAuthInfo(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const user = await getOrCreateUser(db, auth);

  // Generate JWT token for user operations (site settings, content)
  const token = jwt.sign(
    { sub: user.id, email: user.email },
    config.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "1h" }
  );

  logger.debug("User JWT token generated", { userId: user.id, email: user.email });

  res.json({ token });
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

  // Generate a properly signed JWT session token
  const token = jwt.sign(
    { sub: user.id, email: user.email, siteId: siteId },
    config.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "365d" }
  );

  // Store a SHA-256 hash of the token (never the raw token) in the DB
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  await db("api_tokens").insert({
    token: tokenHash,
    user_id: user.id,
    site_id: siteId,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  });

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    res.status(404).send("Site not found");
    return;
  }

  // Generate a per-request nonce for the CSP so only our inline scripts are allowed
  const nonce = crypto.randomBytes(16).toString("base64");
  res.setHeader("Content-Security-Policy",
    `default-src 'self'; ` +
    // 'strict-dynamic' propagates trust from nonce-tagged scripts to any scripts they
    // dynamically create (required by Decap CMS internals: content.js, utils.js, etc.).
    // 'unsafe-eval' is needed by AJV schema compilation (Function() calls inside decap-cms.js).
    // 'unsafe-inline' is a CSP Level-1 fallback; modern browsers ignore it when a nonce is present.
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com; ` +
    `style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; ` +
    `img-src 'self' data: blob: https:; ` +
    `font-src 'self' https://cdnjs.cloudflare.com; ` +
    `connect-src 'self' blob: https://unpkg.com; ` +
    `frame-ancestors 'none';`
  );

  res.type("html").send(renderDecapShell(site, token, nonce));
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

  // Escape a value for safe embedding in a double-quoted YAML scalar
  const yamlStr = (v) => String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");

  const configYaml = `backend: 
  name: git-gateway
  api_root: "${yamlStr(config.API_BASE_URL)}/.netlify/git"
  repo: "${yamlStr(site.github_repo)}"
  branch: "${yamlStr(site.branch)}"
media_folder: "${yamlStr(site.media_path)}"
public_folder: "${yamlStr(site.media_path)}"
collections: 
  - name: "pages"
    label: "Pages"
    folder: "${yamlStr(site.content_path)}"
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
  try {
    if (!config.JWT_SECRET) {
      throw new Error("JWT_SECRET environment variable must be set");
    }
    if (!config.DEFAULT_OIDC_ISSUER) {
      throw new Error("OIDC_ISSUER or HITOBITO_OIDC_ISSUER environment variable must be set");
    }
    
    logger.info("Portal service starting...", {
      environment: process.env.NODE_ENV || 'development',
      debugLogging: logger.isDev(),
      port: config.PORT,
    });
    
    await ensureSchema(db);
    logger.debug("Database schema ensured");
    
    app.listen(config.PORT, () => {
      logger.success(`Portal listening on port ${config.PORT}`, {
        url: `http://localhost:${config.PORT}`,
      });
      logger.info("Portal service ready", {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
      });
    });
  } catch (err) {
    logger.error("Portal startup failed", {
      error: err.message,
      stack: logger.isDev() ? err.stack : undefined,
    });
    process.exit(1);
  }
})();
