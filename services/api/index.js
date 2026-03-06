const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");
const { createDb, ensureSchema } = require("./shared/db");
const { getTemplateFiles } = require("./templates");
const { generateAllFavicons } = require("./utils/favicon-generator");

const PORT = Number(process.env.API_PORT || 4000);
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET; // Required — validated at startup
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const DEFAULT_OIDC_ISSUER =
  process.env.OIDC_ISSUER || process.env.HITOBITO_OIDC_ISSUER || "";
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
const GITHUB_APP_PRIVATE_KEY_BASE64 =
  process.env.GITHUB_APP_PRIVATE_KEY_BASE64 === "true"; // NOTE: The private key is used only for authenticating the GitHub App. It must never be sent to the client in any API response.
const API_BODY_LIMIT = process.env.API_BODY_LIMIT || "2mb";

const app = express();
const db = createDb(DATABASE_URL);

// Trust the first proxy (oauth2-proxy / nginx) so rate-limiters and
// IP-based logic read the real client IP from X-Forwarded-For.
app.set("trust proxy", 1);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "same-site" },
  contentSecurityPolicy: false, // CSP is set per-page in the portal; API returns JSON only
}));

// General rate limiter — 300 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use(generalLimiter);

// Stricter limiter for admin write operations — 30 per minute per IP
const adminWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests, please slow down." },
});

const DECAP_COMMITTER = {
  name: "Decap CMS",
  // email intentionally left unset here — it is filled in per-commit below
};

// Anonymous author used for all commits proxied through the CMS.
// We preserve the original `date` so the commit timeline stays accurate.
// We do NOT override committer — when omitted, GitHub uses the GitHub App's
// own bot identity, which is the authenticated pusher and is what makes the
// push event trustworthy enough to trigger GitHub Actions workflows.
function buildAnonymousAuthor(originalAuthor) {
  return {
    name: DECAP_COMMITTER.name,
    email: "decap@users.noreply.github.com",
    date: (originalAuthor && originalAuthor.date) || new Date().toISOString(),
  };
}

function getAnonymizedDecapCommitMessage(originalMessage, filePath = "", method = "") {
  const cleanedOriginal = typeof originalMessage === "string"
    ? originalMessage
      .replace(/\s+by\s+.+$/i, "")
      .replace(/\s*\([^)]*@[\w.-]+\)\s*$/i, "")
      .trim()
    : "";

  if (cleanedOriginal) {
    return cleanedOriginal;
  }

  const filename = (filePath || "").split("/").filter(Boolean).pop() || "content";
  const pageName = filename.replace(/\.[^.]+$/, "") || "content";
  const action = String(method || "").toUpperCase() === "DELETE" ? "Deleting" : "Updating";
  return `${action} Page: ${pageName}`;
}


function enrichChirpyFrontMatter(content, filePath) {
  if (typeof content !== "string") {
    return content;
  }

  const normalizedPath = String(filePath || "").toLowerCase();
  if (!normalizedPath.endsWith(".md") && !normalizedPath.endsWith(".markdown")) {
    return content;
  }

  const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontMatterMatch) {
    // No front matter at all - add minimal required front matter
    const filename = String(filePath || "")
      .split("/")
      .filter(Boolean)
      .pop() || "";
    const slug = filename.replace(/\.(md|markdown)$/i, "").trim();

    const minimalFrontMatter = `---
layout: page
toc: true
permalink: /${slug}/
date: ${new Date().toISOString()}
last_modified_at: ${new Date().toISOString()}
---

${content}`;
    return minimalFrontMatter;
  }

  const nowIso = new Date().toISOString();
  const frontMatterRaw = frontMatterMatch[1];
  const hasLayout = /^layout\s*:/m.test(frontMatterRaw);
  const hasDate = /^date\s*:/m.test(frontMatterRaw);
  const hasUpdated = /^last_modified_at\s*:/m.test(frontMatterRaw);
  const hasPermalink = /^permalink\s*:/m.test(frontMatterRaw);
  const hasToc = /^toc\s*:/m.test(frontMatterRaw);

  const filename = String(filePath || "")
    .split("/")
    .filter(Boolean)
    .pop() || "";
  const slug = filename.replace(/\.(md|markdown)$/i, "").trim();

  let updatedFrontMatter = frontMatterRaw;

  // Always ensure layout is set for content pages
  if (!hasLayout) {
    updatedFrontMatter += `
layout: page`;
  }

  // Always ensure TOC is enabled by default if not specified
  if (!hasToc) {
    updatedFrontMatter += `
toc: true`;
  }

  if (!hasDate) {
    updatedFrontMatter += `
date: ${nowIso}`;
  }

  if (hasUpdated) {
    updatedFrontMatter = updatedFrontMatter.replace(/^last_modified_at\s*:.*$/m, `last_modified_at: ${nowIso}`);
  } else {
    updatedFrontMatter += `
last_modified_at: ${nowIso}`;
  }

  // Always ensure permalink is set for proper URL structure
  if (!hasPermalink && slug) {
    updatedFrontMatter += `
permalink: /${slug}/`;
  }

  return content.replace(/^---\n([\s\S]*?)\n---\n?/, `---\n${updatedFrontMatter}\n---\n`);
}

app.use(express.json({ limit: API_BODY_LIMIT }));

// CSRF protection: for state-changing requests that do NOT use a Bearer token,
// ensure the Origin or Referer header matches the server's own host.
// Bearer-token requests (Decap CMS, API clients) are exempt because custom headers
// cannot be set by cross-origin forms/scripts without CORS pre-flight.
app.use((req, res, next) => {
  const safeMethods = ["GET", "HEAD", "OPTIONS"];
  if (safeMethods.includes(req.method)) return next();

  // Bearer-token requests are inherently CSRF-safe
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return next();

  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  const host = req.headers.host || "";

  const allowed = origin
    ? (origin.includes(host))
    : (referer.includes(host));

  if (!allowed) {
    console.warn(`CSRF: rejected ${req.method} ${req.url} origin="${origin}" referer="${referer}"`);
    return res.status(403).json({ error: "Forbidden: CSRF check failed" });
  }
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
  // Check for Bearer token FIRST (for Decap CMS and headless access)
  const authHeader = req.header("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);

    // Look up api_tokens by SHA-256 hash of the token (tokens are stored hashed)
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const apiToken = await db("api_tokens").where({ token: tokenHash }).first();
    if (apiToken) {
      // Reject expired tokens (expires_at is null for legacy tokens — treat as valid)
      if (apiToken.expires_at && new Date(apiToken.expires_at) < new Date()) {
        console.log("INFO: Rejected expired API token");
      } else {
        const user = await db("users").where({ id: apiToken.user_id }).first();
        if (user) {
          console.log(`INFO: Authenticated via API token for user id=${user.id}`);
          return {
            issuer: user.oidc_issuer,
            sub: user.oidc_sub,
            email: user.email,
            name: user.name,
            siteId: apiToken.site_id,
            isApiToken: true
          };
        }
      }
    }

    // Verify the JWT signature — reject any token with an invalid or missing signature
    if (JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
        if (decoded && decoded.email) {
          const jwtUser = await db("users").where({ email: decoded.email }).first();
          if (jwtUser) {
            const siteId = decoded.siteId || null;
            console.log(`INFO: Authenticated via verified JWT for user id=${jwtUser.id}, siteId=${siteId}`);
            return {
              issuer: jwtUser.oidc_issuer,
              sub: jwtUser.oidc_sub,
              email: jwtUser.email,
              name: jwtUser.name,
              siteId: siteId,
              isJwt: true
            };
          }
        }
      } catch (jwtErr) {
        console.log(`INFO: JWT verification failed: ${jwtErr.message}`);
      }
    }
  }

  // Fall back to oauth2-proxy headers (from nginx)
  const issuer = req.header("x-auth-request-issuer") || DEFAULT_OIDC_ISSUER;

  // Try X-Auth-Request headers first, then fall back to X-Forwarded headers
  const sub = req.header("x-auth-request-user") || req.header("x-forwarded-user");
  const emailHeader = req.header("x-auth-request-email") || req.header("x-forwarded-email");
  const preferredUsername = req.header("x-auth-request-preferred-username") || req.header("x-forwarded-preferred-username");

  const email = normalizeEmail(emailHeader) || normalizeEmail(preferredUsername);
  const name = preferredUsername || sub || emailHeader;

  if (!issuer || !sub || !email) {
    return null;
  }

  // OAuth/X-Auth-Request headers – look up user and site permissions to provide siteId
  const dbUser = await db("users").where({ email }).first();
  let siteId = null;
  if (dbUser) {
    const perm = await db("site_permissions").where({ user_id: dbUser.id }).first();
    if (perm) siteId = perm.site_id;
  }
  return {
    issuer,
    sub,
    email,
    name,
    siteId,
  };
}

async function getOrCreateUser(auth) {
  const existing = await db("users")
    .where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub })
    .first();

  if (existing) {
    return existing;
  }

  const id = crypto.randomUUID();

  await db.transaction(async (trx) => {
    // Re-check inside the transaction to avoid the race between count and insert
    const alreadyExists = await trx("users")
      .where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub })
      .first();
    if (alreadyExists) return; // lost the race — another request already created this user

    const isFirstUser = (await trx("users").count("id as count").first()).count === 0;
    const isAdmin = isFirstUser || ADMIN_EMAILS.includes(auth.email);

    await trx("users").insert({
      id,
      oidc_issuer: auth.issuer,
      oidc_sub: auth.sub,
      email: auth.email,
      name: auth.name,
      is_admin: isAdmin,
    });
  });

  // Re-fetch (handles both the created-now and already-existed-inside-tx cases)
  return db("users").where({ oidc_issuer: auth.issuer, oidc_sub: auth.sub }).first();
}

function normalizePrivateKey(rawKey) {
  if (!rawKey) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is required");
  }

  const decoded = GITHUB_APP_PRIVATE_KEY_BASE64
    ? Buffer.from(rawKey, "base64").toString("utf8")
    : rawKey;
  let normalized = decoded.replace(/\\n/g, "\n");

  if (!normalized.includes("-----BEGIN")) {
    normalized = `-----BEGIN RSA PRIVATE KEY-----\n${normalized}\n-----END RSA PRIVATE KEY-----`;
  }

  return normalized;
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

async function commitMultipleFiles(octokit, owner, repo, branch, filesMap, message) {
  try {
    const tree = [];

    for (const [path, content] of Object.entries(filesMap)) {
      const buffer = Buffer.isBuffer(content)
        ? content
        : Buffer.from(String(content));

      const blob = await octokit.git.createBlob({
        owner,
        repo,
        content: buffer.toString("base64"),
        encoding: "base64",
      });

      tree.push({ path, mode: "100644", type: "blob", sha: blob.data.sha });
    }

    let commitSha;
    let treeSha;

    try {
      const { data: refData } = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`
      });
      commitSha = refData.object.sha;

      const { data: commitData } = await octokit.git.getCommit({
        owner,
        repo,
        commit_sha: commitSha
      });
      treeSha = commitData.tree.sha;
    } catch (refErr) {
      if (refErr.status !== 404) {
        throw refErr;
      }

      const { data: repoData } = await octokit.repos.get({ owner, repo });

      if (repoData.size === 0) {
        const { data: initialTree } = await octokit.git.createTree({
          owner,
          repo,
          tree,
        });

        const { data: initialCommit } = await octokit.git.createCommit({
          owner,
          repo,
          message,
          tree: initialTree.sha,
          parents: [],
        });

        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: initialCommit.sha,
        });

        console.log(`DEBUG: Atomic initial commit successful: ${initialCommit.sha}`);
        return initialCommit.sha;
      }

      const defaultBranch = repoData.default_branch;
      const { data: defaultRef } = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`,
      });

      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: defaultRef.object.sha,
      });

      commitSha = defaultRef.object.sha;
      const { data: commitData } = await octokit.git.getCommit({
        owner,
        repo,
        commit_sha: commitSha,
      });
      treeSha = commitData.tree.sha;
    }

    const { data: newTree } = await octokit.git.createTree({
      owner, repo, base_tree: treeSha, tree
    });

    const { data: newCommit } = await octokit.git.createCommit({
      owner, repo,
      message,
      tree: newTree.sha,
      parents: [commitSha]
    });

    await octokit.git.updateRef({
      owner, repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha
    });

    console.log(`DEBUG: Atomic commit successful: ${newCommit.sha}`);
    return newCommit.sha;
  } catch (err) {
    console.error(`DEBUG: Atomic commit failed: ${err.message}`);
    throw err;
  }
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

  const user = await getOrCreateUser(auth);
  // Propagate siteId from auth context (e.g. from JWT lookup or API token)
  if (auth.siteId) {
    user.siteId = auth.siteId;
  }
  return user;
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

async function preserveHomePage(octokit, owner, repo, branch, filesMap) {
  const protectedPath = "content/index.md";
  if (!filesMap[protectedPath]) {
    return filesMap;
  }

  try {
    await octokit.repos.getContent({ owner, repo, path: protectedPath, ref: branch });
    console.log(`DEBUG: ${protectedPath} exists on ${owner}/${repo}@${branch}; preserving user content.`);
    const { [protectedPath]: _removed, ...rest } = filesMap;
    return rest;
  } catch (err) {
    if (err.status === 404 || err.status === 409) {
      return filesMap;
    }
    console.error(`DEBUG: Failed to check ${protectedPath}: ${err.message}`);
    throw err;
  }
}

async function gitGatewaySettings(req, res) {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }

  const site = await getSiteForUser(user, req.params.siteId);
  if (!site) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { owner, repo } = parseRepo(site.github_repo);

  // Check if the repo has any content
  try {
    const { data: repoData } = await getOctokit().repos.get({ owner, repo });
    if (repoData.size === 0) {
      // Empty repo – return default settings
      return res.json({
        github_enabled: true,
        git_gateway: { roles: [] },
        api_root: "/.netlify/git",
        pages_enabled: false,
      });
    }
  } catch (err) {
    console.error(`DEBUG: Failed to check repo content: ${err.message}`);
  }

  // For non-empty repos, fall back to existing logic
  res.json({
    github_enabled: true,
    git_gateway: { roles: [] },
    api_root: "/.netlify/git",
  });
}

// Router for flexible path handling (handles /api prefix stripping)
const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Git Gateway Settings Endpoint - Required by Decap CMS
router.get("/settings", (_req, res) => {
  res.json({
    github_enabled: true,
    git_gateway: { roles: [] },
    // Indicates Git Gateway is available
    api_root: "/.netlify/git"
  });
});

// Get current user info - Required by Decap CMS
router.get("/user", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }

  res.json({
    email: user.email,
    name: user.name,
    login: user.email,
    id: user.id
  });
});

// Update site settings for permitted users (page title, suptitle, icon, favicon)
router.put("/sites/:siteId/settings", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }

  const { siteId } = req.params;
  const site = await getSiteForUser(user, siteId);
  if (!site) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const {
    page_title,
    suptitle,
    brand_icon,
    favicon,
    display_name
  } = req.body || {};

  const updatePayload = {
    ...(page_title !== undefined && { page_title }),
    ...(suptitle !== undefined && { suptitle }),
    ...(brand_icon !== undefined && { brand_icon }),
    ...(favicon !== undefined && { favicon }),
    ...(display_name !== undefined && { display_name }),
  };

  if (!Object.keys(updatePayload).length) {
    res.status(400).json({ error: "No settings provided" });
    return;
  }

  await db("sites").where({ id: siteId }).update(updatePayload);
  const updatedSite = await db("sites").where({ id: siteId }).first();

  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(updatedSite.github_repo);
    const siteTheme = updatedSite.theme || "chirpy";

    let templateFiles = getTemplateFiles(siteTheme, updatedSite.display_name, {
      pageTitle: updatedSite.page_title || updatedSite.display_name,
      suptitle: updatedSite.suptitle || "Built with Decap CMS",
      avatarIcon: updatedSite.brand_icon || "",
      favicon: updatedSite.favicon || "",
    });

    const faviconSource = updatedSite.favicon || updatedSite.brand_icon;
    if (faviconSource) {
      const faviconFiles = await generateAllFavicons(faviconSource);
      Object.assign(templateFiles, faviconFiles);
    }

    templateFiles = await preserveHomePage(octokit, owner, repo, updatedSite.branch, templateFiles);

    await commitMultipleFiles(
      octokit,
      owner,
      repo,
      updatedSite.branch,
      templateFiles,
      `Update site settings: ${updatedSite.display_name}`
    );
  } catch (err) {
    console.error(`DEBUG: Failed to sync templates for ${updatedSite.github_repo}: ${err.message}`);
  }

  res.json({ success: true });
});

router.get("/admin/sites", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) {
    return;
  }

  const sites = await db("sites").orderBy("display_name");
  res.json({ sites });
});


router.post("/admin/sites", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) {
    return;
  }

  const {
    id,
    display_name,
    github_repo,
    branch = "main",
    content_path = "content",
    media_path = "static/uploads/",
    domain = null,
    page_title = null,
    suptitle = "Built with Decap CMS",
    brand_icon = null,
    favicon = null,
    enabled = true,
    theme = "minima" // Default theme
  } = req.body;

  if (!id || !display_name || !github_repo) {
    res.status(400).json({ error: "id, display_name, github_repo required" });
    return;
  }

  // Validate and normalise github_repo format (must be "owner/repo", no extra slashes or spaces)
  const repoParts = github_repo.trim().split("/");
  if (repoParts.length !== 2) {
    res.status(400).json({ error: "github_repo must be in format owner/repo" });
    return;
  }
  const repoOwnerPart = repoParts[0].trim();
  const repoNamePart  = repoParts[1].trim();
  if (!repoOwnerPart || !repoNamePart) {
    res.status(400).json({ error: "github_repo owner and repo cannot be empty" });
    return;
  }
  // Only allow safe GitHub name characters
  const safeRepoPattern = /^[a-zA-Z0-9_.\-]+$/;
  if (!safeRepoPattern.test(repoOwnerPart) || !safeRepoPattern.test(repoNamePart)) {
    res.status(400).json({ error: "github_repo contains invalid characters" });
    return;
  }
  const finalGithubRepo = `${repoOwnerPart}/${repoNamePart}`;

  await db("sites").insert({
    id,
    display_name,
    github_repo: finalGithubRepo,
    branch,
    content_path,
    media_path,
    domain,
    page_title,
    suptitle,
    brand_icon,
    favicon,
    enabled: Boolean(enabled),
  });

  // --- Auto-Configuration (Templates & Pages) ---
  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(finalGithubRepo);
    const templateUrls = getTemplateFiles(theme, display_name, {
      pageTitle: page_title || display_name,
      suptitle: suptitle || 'Built with Decap CMS',
      avatarIcon: brand_icon || '',
      favicon: favicon || '',
      domain: domain || '',
      githubRepo: finalGithubRepo,
    });

    console.log(`INFO: Applying theme '${theme}' to ${finalGithubRepo}...`);
    await commitMultipleFiles(octokit, owner, repo, branch, templateUrls, `Initialize theme: ${theme}`);


    // 2. Enable GitHub Pages
    try {
      console.log(`DEBUG: Enabling GitHub Pages for ${github_repo}...`);
      const buildType = 'workflow';
      const source = undefined;

      await octokit.repos.createPagesSite({
        owner,
        repo,
        source,
        build_type: buildType
      });
      console.log(`DEBUG: GitHub Pages enabled (${buildType})`);
    } catch (pagesErr) {
      console.error(`DEBUG: Failed to enable Pages (might already be enabled or permission issue): ${pagesErr.message}`);
    }

    // 3. Auto-configure CNAME if domain is provided (Existing logic moved here)
    if (domain) {
      // ... (existing CNAME logic, simplified call)
      let sha;
      try {
        const { data: existingFile } = await octokit.repos.getContent({
          owner, repo, path: "CNAME", ref: branch
        });
        sha = existingFile.sha;
      } catch (e) { }

      await octokit.repos.createOrUpdateFileContents({
        owner, repo, path: "CNAME",
        message: `Configure custom domain: ${domain}`,
        content: Buffer.from(domain).toString("base64"),
        branch,
        sha
      });
    }

  } catch (err) {
    console.error(`DEBUG: Post-creation setup failed: ${err.message}`);
    // Site is in DB, so we return success but maybe warn?
  }

  res.status(201).json({ id });
});

router.post("/admin/sites/:siteId/template", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const { theme } = req.body;

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(site.github_repo);
    const templateFiles = getTemplateFiles(theme, site.display_name, {
      pageTitle: site.page_title || site.display_name,
      suptitle: site.suptitle || 'Built with Decap CMS',
      avatarIcon: site.brand_icon || '',
      favicon: site.favicon || '',
    });

    console.log(`DEBUG: Re-applying theme '${theme}' to ${site.github_repo}...`);
    await commitMultipleFiles(octokit, owner, repo, site.branch, templateFiles, `Update theme: ${theme}`);


    // Update Pages settings
    const buildType = 'workflow';
    // Note: Updating existing pages sites via API can be tricky if they exist.
    // We catch errors.
    try {
      // First check if pages exists
      try {
        await octokit.repos.getPages({ owner, repo });
        // Update
        await octokit.repos.updateInformationAboutPagesSite({
          owner, repo,
          build_type: buildType,
          source: undefined
        });
      } catch (e) {
        // Create
        await octokit.repos.createPagesSite({
          owner, repo,
          build_type: buildType,
          source: undefined
        });
      }
    } catch (e) {
      console.error(`DEBUG: Failed to update Pages Settings: ${e.message}`);
    }

    res.json({ success: true, message: "Template deployed and Pages configured." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to deploy template: " + err.message });
  }
});

router.put("/admin/sites/:siteId", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const { domain, display_name, branch, enabled, page_title, suptitle, brand_icon, favicon } = req.body;

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  // Update DB
  await db("sites").where({ id: siteId }).update({
    domain: domain !== undefined ? domain : site.domain,
    display_name: display_name || site.display_name,
    branch: branch || site.branch,
    page_title: page_title !== undefined ? page_title : site.page_title,
    suptitle: suptitle !== undefined ? suptitle : site.suptitle,
    brand_icon: brand_icon !== undefined ? brand_icon : site.brand_icon,
    favicon: favicon !== undefined ? favicon : site.favicon,
    enabled: enabled !== undefined ? Boolean(enabled) : site.enabled
  });

  // Handle CNAME update if domain changed
  if (domain && domain !== site.domain) {
    try {
      const octokit = await getOctokit();
      const { owner, repo } = parseRepo(site.github_repo);
      const targetBranch = branch || site.branch;

      console.log(`DEBUG: Updating CNAME for ${site.github_repo} -> ${domain}`);

      let sha;
      try {
        const { data: existingFile } = await octokit.repos.getContent({
          owner,
          repo,
          path: "CNAME",
          ref: targetBranch
        });
        sha = existingFile.sha;
      } catch (e) {/* Ignore 404 */ }

      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: "CNAME",
        message: `Update custom domain: ${domain}`,
        content: Buffer.from(domain).toString("base64"),
        branch: targetBranch,
        sha
      });
    } catch (err) {
      console.error(`DEBUG: Failed to update CNAME: ${err.message}`);
    }
  }

  // Update _config.yml if title or domain changed
  if ((page_title && page_title !== site.page_title) || (domain && domain !== site.domain)) {
    try {
      const octokit = await getOctokit();
      const { owner, repo } = parseRepo(site.github_repo);
      const targetBranch = branch || site.branch;

      console.log(`DEBUG: Regenerating _config.yml for ${site.github_repo}...`);

      const { getTemplateFiles } = require('./templates');
      const configFiles = getTemplateFiles(site.theme || 'chirpy', display_name || site.display_name, {
        pageTitle: page_title || site.page_title || site.display_name,
        suptitle: suptitle !== undefined ? suptitle : site.suptitle,
        avatarIcon: brand_icon !== undefined ? brand_icon : site.brand_icon || '',
        favicon: favicon !== undefined ? favicon : site.favicon || '',
        domain: domain || '',
        githubRepo: site.github_repo,
      });

      // Update only the _config.yml file
      if (configFiles['_config.yml']) {
        let sha;
        try {
          const { data: existingFile } = await octokit.repos.getContent({
            owner,
            repo,
            path: "_config.yml",
            ref: targetBranch
          });
          sha = existingFile.sha;
        } catch (e) {/* Ignore 404 */ }

        await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: "_config.yml",
          message: "Update site configuration",
          content: Buffer.from(configFiles['_config.yml']).toString('base64'),
          branch: targetBranch,
          sha
        });

        console.log(`DEBUG: _config.yml updated successfully`);
      }
    } catch (err) {
      console.error(`DEBUG: Failed to update _config.yml: ${err.message}`);
    }
  }

  res.json({ success: true });
});

router.delete("/admin/sites/:siteId", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  // Cleanup related data
  await db("site_permissions").where({ site_id: siteId }).del();
  await db("api_tokens").where({ site_id: siteId }).del();

  // Delete the site
  await db("sites").where({ id: siteId }).del();

  res.status(204).send();
});

// GET /admin/sites/:siteId/reset-token
// Issues a short-lived signed token that must be passed back to the reset endpoint.
router.get("/admin/sites/:siteId/reset-token", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  // Token = HMAC(secret, siteId + 5-minute window) — valid for up to 5 minutes
  const window = Math.floor(Date.now() / (5 * 60 * 1000));
  const token = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`reset:${siteId}:${window}`)
    .digest("hex");

  res.json({ confirmationToken: token });
});

// POST /admin/sites/:siteId/reset
// Requires a valid HMAC confirmation token obtained from /reset-token
router.post("/admin/sites/:siteId/reset", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const { confirmationToken } = req.body;

  // Validate the HMAC token (accept current window and the previous one for clock skew)
  const now = Math.floor(Date.now() / (5 * 60 * 1000));
  const validTokens = [now, now - 1].map((w) =>
    crypto.createHmac("sha256", JWT_SECRET).update(`reset:${siteId}:${w}`).digest("hex")
  );
  if (!confirmationToken || !validTokens.includes(confirmationToken)) {
    res.status(400).json({ error: "Invalid or expired confirmation token. Request a new one." });
    return;
  }

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(site.github_repo);

    // Get current template files (theme may have been changed)
    const currentTheme = site.theme || 'chirpy';
    let templateFiles = getTemplateFiles(currentTheme, site.display_name, {
      pageTitle: site.page_title || site.display_name,
      suptitle: site.suptitle || 'Built with Decap CMS',
      avatarIcon: site.brand_icon || '',
      favicon: site.favicon || '',
    });

    // Regenerate favicons if available
    const faviconSource = site.favicon || site.brand_icon;
    if (faviconSource) {
      const faviconFiles = await generateAllFavicons(faviconSource);
      Object.assign(templateFiles, faviconFiles);
    }

    // Reset: commit fresh template files, overwriting everything
    console.log(`DEBUG: Resetting repository ${site.github_repo} to initial state...`);
    await commitMultipleFiles(
      octokit,
      owner,
      repo,
      site.branch,
      templateFiles,
      `Reset repository to initial state (Decap admin action)`
    );

    // Trigger Pages rebuild
    try {
      try {
        await octokit.repos.getPages({ owner, repo });
        await octokit.repos.updateInformationAboutPagesSite({
          owner, repo,
          build_type: 'workflow',
          source: undefined
        });
      } catch (e) {
        await octokit.repos.createPagesSite({
          owner, repo,
          build_type: 'workflow',
          source: undefined
        });
      }
    } catch (e) {
      console.error(`DEBUG: Failed to update Pages Settings: ${e.message}`);
    }

    res.json({
      success: true,
      message: "Repository reset to initial state. GitHub Actions will rebuild the site shortly."
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset repository: " + err.message });
  }
});

router.post("/admin/permissions", adminWriteLimiter, async (req, res) => {
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
  // roles: [] is safer than null for clients expecting an array
  res.json({ github_enabled: true, git_gateway: { roles: [] } });
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

router.delete("/admin/permissions", adminWriteLimiter, async (req, res) => {
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
  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(site.github_repo);
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: site.branch,
    });
    res.json(response.data);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: "Not found" });
    console.error("GET /contents error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
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
  const normalizedContent = encoding === "base64"
    ? Buffer.from(content, "base64").toString("utf8")
    : content;
  const preparedContent = enrichChirpyFrontMatter(normalizedContent, path);

  const payload = {
    owner,
    repo,
    path,
    message: getAnonymizedDecapCommitMessage(message, path, "PUT"),
    content: Buffer.from(preparedContent).toString("base64"),
    branch: site.branch,
    // author: anonymous but preserves the timestamp; committer omitted so GitHub
    // uses the GitHub App bot identity — this is required to trigger Actions workflows.
    author: buildAnonymousAuthor(null),
  };

  if (sha) {
    payload.sha = sha;
  }

  try {
    const response = await octokit.repos.createOrUpdateFileContents(payload);
    res.json(response.data);
  } catch (err) {
    console.error("PUT /contents error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
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

  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(site.github_repo);
    const response = await octokit.repos.deleteFile({
      owner,
      repo,
      path,
      message: getAnonymizedDecapCommitMessage(message, path, "DELETE"),
      sha,
      branch: site.branch,
      author: buildAnonymousAuthor(null),
      // committer omitted — GitHub App bot identity triggers Actions
    });
    res.json(response.data);
  } catch (err) {
    console.error("DELETE /contents error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// List files in a folder (recursive flattening)
async function listFiles(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const site = await getSiteForUser(user, req.params.siteId);
  if (!site) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { path } = req.query;
  const octokit = await getOctokit();
  const { owner, repo } = parseRepo(site.github_repo);

  try {
    // Get the recursive tree for the branch
    const { data: treeData } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: site.branch,
      recursive: 1,
    });

    // Filter items that start with the requested folder path
    const files = treeData.tree
      .filter((item) => item.path.startsWith(path) && item.type === "blob")
      .map((item) => ({
        path: item.path,
        sha: item.sha,
        size: item.size,
        name: item.path.replace(path, "").replace(/^\//, ""), // relative name
        type: "file",
      }));

    res.json(files);
  } catch (err) {
    if (err.status === 404) {
      console.log(`DEBUG: Tree/path not found for ${path}, returning empty list.`);
      res.json([]);
    } else {
      console.error("List files error:", err);
      res.status(500).json({ error: err.message });
    }
  }
}

router.get("/sites/:siteId/files", listFiles);

// Generic GitHub Proxy for Git Gateway
// Proxies requests from /.netlify/git/github/* to https://api.github.com/*
router.all("/github/*", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return; // requireUser handles 401

  const path = req.params[0]; // Capture the * part
  let method = req.method;
  const body = req.body;
  const proxiedBody = body && typeof body === "object"
    ? { ...body }
    : body;

  if (
    proxiedBody &&
    typeof proxiedBody === "object" &&
    ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
    Object.prototype.hasOwnProperty.call(proxiedBody, "message")
  ) {
    proxiedBody.message = getAnonymizedDecapCommitMessage(proxiedBody.message, proxiedBody.path, method);
  }

  if (proxiedBody && typeof proxiedBody === "object" && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    if (Object.prototype.hasOwnProperty.call(proxiedBody, "author")) {
      proxiedBody.author = buildAnonymousAuthor(proxiedBody.author);
    }
    // Do NOT override committer — omitting it tells GitHub to use the
    // GitHub App's own bot identity, which is what triggers Actions workflows.
  }
  let finalPath = path;

  // Context-aware proxying for generic requests (e.g., /branches/main)
  // Try to determine which site/repo this request is for
  let targetSite = null;

  if (user.siteId) {
    // Primary: Use siteId from JWT token (best case)
    console.log(`DEBUG: Using siteId from JWT: ${user.siteId}`);
    targetSite = await db("sites").where({ id: user.siteId }).first();
  } else if (!path.startsWith("repos/") && !path.startsWith("user")) {
    // Secondary: Try to find the site by checking user's permitted sites
    // This handles the case where JWT doesn't have siteId but user is still authenticated
    console.log(`DEBUG: No siteId in JWT, attempting to find permitted site for user (admin=${user.is_admin})...`);

    let permittedSites;
    if (user.is_admin) {
      // For admins, allow access to all enabled sites
      console.log(`DEBUG: User is admin, querying all enabled sites...`);
      permittedSites = await db("sites")
        .where({ enabled: true })
        .select("*");
    } else {
      // For regular users, only sites they have explicit permission for
      permittedSites = await db("sites")
        .join("site_permissions", "sites.id", "site_permissions.site_id")
        .where({
          "site_permissions.user_id": user.id,
          "sites.enabled": true
        })
        .select("sites.*");
    }

    if (permittedSites && permittedSites.length > 0) {
      // Use the first permitted site as default (in the future, could use a header to specify)
      targetSite = permittedSites[0];
      console.log(`DEBUG: Found permitted site: ${targetSite.id} (${targetSite.github_repo})`);
    } else {
      console.log(`DEBUG: No permitted sites found for user ${user.email}`);
    }
  }

  if (targetSite && !path.startsWith("repos/")) {
    console.log(`DEBUG: Rewriting generic proxy request for site ${targetSite.id} (${targetSite.github_repo})`);
    // If requesting branches/main, map to repos/{owner}/{repo}/branches/main
    finalPath = `repos/${targetSite.github_repo}/${path}`;
  }

  console.log(`DEBUG: Proxying GitHub request: ${method} /${path} -> /${finalPath}`);

  // Ensure branch exists for GET branch requests before security check
  if (method === "GET" && finalPath.match(/^repos\/[^/]+\/[^/]+\/branches\/([^/]+)$/)) {
    try {
      const octokit = await getOctokit();
      const branchMatch = finalPath.match(/^repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/);
      const [, owner, repo, branch] = branchMatch;
      const { data: repoData } = await octokit.repos.get({ owner, repo });
      if (repoData.size === 0) {
        // Empty repo – create initial README on target branch
        await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: "README.md",
          message: "Initial commit by Decap CMS Proxy",
          content: Buffer.from("# " + repoData.name).toString("base64"),
          branch,
        });
        console.log(`DEBUG: Initialized empty repo with ${branch} branch.`);
      } else {
        // Repo has content – ensure branch exists, create from default if missing
        try {
          await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
        } catch (_) {
          const { data: refData } = await octokit.git.getRef({
            owner,
            repo,
            ref: `heads/${repoData.default_branch}`,
          });
          await octokit.git.createRef({
            owner,
            repo,
            ref: `refs/heads/${branch}`,
            sha: refData.object.sha,
          });
          console.log(`DEBUG: Created missing branch ${branch} from ${repoData.default_branch}`);
        }
      }
    } catch (branchErr) {
      console.error(`DEBUG: Branch auto‑creation failed: ${branchErr.message}`);
    }
  }

  // Basic security check: ensure user has access to the repo they are trying to access
  if (!user.is_admin) {
    const match = finalPath.match(/^repos\/([^/]+)\/([^/]+)/);
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
    let response;

    // Fix for GitHub API "branch:path" syntax sometimes returning root tree unexpectedly
    // We manually walk the tree to find the correct SHA for the path
    if (method === "GET" && finalPath.includes("/git/trees/") && finalPath.includes(":")) {
      const match = finalPath.match(/git\/trees\/([^:]+):(.+)$/);
      if (match) {
        let [_, branch, path] = match;
        const repoPathMatch = finalPath.match(/^repos\/([^/]+)\/([^/]+)\//);
        const owner = repoPathMatch[1];
        const repo = repoPathMatch[2];

        console.log(`DEBUG: Manual Tree Walk for ${owner}/${repo} ref=${branch} path=${path}`);

        try {
          // 1. Get Root Tree of branch
          const { data: rootData } = await octokit.git.getTree({ owner, repo, tree_sha: branch }); // Non-recursive first level

          // 2. Find the SHA for the first path segment (assuming single level "content" for now, or standard recursion logic later if needed)
          // For "content", we just find "content"
          // If path is "content/sub", we would need to recurse. For now, let's handle single level which covers the use case.
          // Decap usually requests "branch:content" not deep paths for collections unless configured so.

          let targetSha = null;
          const pathParts = path.split("/"); // Handle simple nesting if needed
          let currentTree = rootData.tree;

          for (const part of pathParts) {
            if (!part) continue;
            const item = currentTree.find(t => t.path === part && t.type === "tree");
            if (!item) {
              console.log(`DEBUG: Path segment '${part}' not found in tree.`);
              targetSha = null;
              break;
            }
            targetSha = item.sha;
            // If more parts, fetch next tree? (Optimization: unlikely for this specific issue, but good for robustness)
            if (pathParts.indexOf(part) < pathParts.length - 1) {
              const { data: nextTree } = await octokit.git.getTree({ owner, repo, tree_sha: targetSha });
              currentTree = nextTree.tree;
            }
          }

          if (targetSha) {
            console.log(`DEBUG: Resolved path '${path}' to SHA ${targetSha}. Fetching directly...`);
            // 3. Request specific tree by SHA
            response = await octokit.git.getTree({ owner, repo, tree_sha: targetSha });
          } else {
            console.log(`DEBUG: Could not resolve SHA for path '${path}'. Falling back to original request.`);
            // Fallback to original if not found (404 likely)
            response = await octokit.request(`${method} /${finalPath}`, { data: proxiedBody });
          }

        } catch (walkErr) {
          console.error(`DEBUG: Manual walk failed: ${walkErr.message}. Falling back.`);
          response = await octokit.request(`${method} /${finalPath}`, { data: proxiedBody });
        }
      } else {
        response = await octokit.request(`${method} /${finalPath}`, { data: proxiedBody });
      }
    } else {
      response = await octokit.request(`${method} /${finalPath}`, { data: proxiedBody });
    }

    if (finalPath.includes("/contents/") || finalPath.includes("/git/trees/")) {
      console.log(`DEBUG: GitHub Proxy Response for ${finalPath}: Status ${response.status}`);
      if (response.data && response.data.tree) {
        // Filter out README.md from tree listing to prevent CMS parsing errors
        response.data.tree = response.data.tree.filter(f => f.path !== "README.md" && !f.path.endsWith("/README.md"));
        console.log(`DEBUG: Tree listing (filtered): ${response.data.tree.map(f => `${f.path} [${f.type}]`).join(", ")}`);
      } else if (Array.isArray(response.data)) {
        console.log(`DEBUG: Directory listing: ${response.data.map(f => f.name).join(", ")}`);
      }
    }

    res.status(response.status).json(response.data);
  } catch (err) {
    // Gracefully handle missing tree/folder (e.g. uploads folder not created yet)
    if (err.status === 404 && method === "GET" && finalPath.includes("/git/trees/")) {
      console.log(`DEBUG: Tree/path not found for ${finalPath} (likely empty folder), returning empty tree.`);
      res.json({ sha: "empty-tree", url: "", tree: [], truncated: false });
      return;
    }

    // Auto-Recovery: Create branch if missing
    if (err.status === 404 && method === "GET") {
      const branchMatch = finalPath.match(/^repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/);
      if (branchMatch) {
        const [, owner, repo, branch] = branchMatch;
        console.log(`DEBUG: Branch ${branch} not found for ${owner}/${repo}. Attempting auto-creation...`);

        try {
          const octokit = await getOctokit();
          // Check repo state
          const { data: repoData } = await octokit.repos.get({ owner, repo });

          let sha = null;
          if (repoData.size === 0) {
            console.log(`DEBUG: Repo is empty. Creating Initial Commit...`);
            // Repo is empty, create README.md to init
            const { data: commit } = await octokit.repos.createOrUpdateFileContents({
              owner,
              repo,
              path: "README.md",
              message: "Initial commit by Decap CMS Proxy",
              content: Buffer.from("# " + repoData.name).toString("base64"),
              branch
            });
            // After creating file, branch exists
            console.log(`DEBUG: Initialized repo with ${branch} branch.`);
          } else {
            // Repo has content, branch missing. Create from default branch.
            console.log(`DEBUG: Repo not empty. Creating ${branch} from ${repoData.default_branch}...`);
            // Get SHA of default branch
            const { data: refData } = await octokit.git.getRef({
              owner,
              repo,
              ref: `heads/${repoData.default_branch}`
            });
            sha = refData.object.sha;

            // Create new branch ref
            await octokit.git.createRef({
              owner,
              repo,
              ref: `refs/heads/${branch}`,
              sha
            });
            console.log(`DEBUG: Created ${branch} pointing to ${sha}`);
          }

          // Retry the original request
          const retryResponse = await octokit.request(`${method} /${finalPath}`, {
            data: proxiedBody,
          });
          res.status(retryResponse.status).json(retryResponse.data);
          return;

        } catch (recoveryErr) {
          console.error(`DEBUG: Auto-recovery failed: ${recoveryErr.message}`);
          // Fall through to return original error
        }
      }
    }

    console.error(`DEBUG: Proxy error: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.use("/", router);
app.use("/api", router);
app.use("/.netlify/git", router);

(async () => {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable must be set");
  }
  await ensureSchema(db);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on ${PORT}`);
    console.log("API Service v3 (Router Refactor)");
  });
})();
