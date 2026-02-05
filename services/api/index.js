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
  process.env.GITHUB_APP_PRIVATE_KEY_BASE64 === "true"; // NOTE: The private key is used only for authenticating the GitHub App. It must never be sent to the client in any API response.
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
            siteId: apiToken.site_id, // Pass site context
            isApiToken: true
          };
        }
      }
    }

    return null;
  }

  // JWT auth – look up user and site permissions to provide siteId
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
  let normalized = decoded.replace(/\\n/g, "\n");

  if (!normalized.includes("-----BEGIN")) {
    console.log("DEBUG: Key missing headers, adding them...");
    normalized = `-----BEGIN RSA PRIVATE KEY-----\n${normalized}\n-----END RSA PRIVATE KEY-----`;
  }

  console.log(`DEBUG: Private Key loaded. Length: ${normalized.length}`);
  console.log(`DEBUG: Key Start: ${normalized.substring(0, 30)}...`);
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

const { getTemplateFiles } = require("./templates");

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
    content_path = "content",
    media_path = "static/uploads/",
    domain = null,
    enabled = true,
    theme = "minima" // Default theme
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
    domain,
    enabled: Boolean(enabled),
  });

  // --- Auto-Configuration (Templates & Pages) ---
  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(github_repo);
    const templateUrls = getTemplateFiles(theme, display_name);

    // 1. Commit Template Files
    // We need to fetch current tree or just update files individually?
    // createOrUpdateFileContents is easiest for individual files
    // For multiple, traversing is better, but let's do sequential for simplicity (it's only ~3-4 files)

    console.log(`DEBUG: Applying theme '${theme}' to ${github_repo}...`);

    for (const [filePath, content] of Object.entries(templateUrls)) {
      try {
        // Check if exists to get SHA
        let sha;
        try {
          const { data: existing } = await octokit.repos.getContent({
            owner, repo, path: filePath, ref: branch
          });
          sha = existing.sha;
        } catch (e) { } // 404

        await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: filePath,
          message: `Initialize theme: ${theme}`,
          content: Buffer.from(content).toString("base64"),
          branch,
          sha
        });
      } catch (fileErr) {
        console.error(`DEBUG: Failed to write ${filePath}: ${fileErr.message}`);
      }
    }

    // 2. Enable GitHub Pages
    try {
      console.log(`DEBUG: Enabling GitHub Pages for ${github_repo}...`);
      const buildType = theme === 'chirpy' ? 'workflow' : 'legacy';
      const source = buildType === 'legacy' ? { branch, path: '/' } : undefined;

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

router.post("/admin/sites/:siteId/template", async (req, res) => {
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
    const templateFiles = getTemplateFiles(theme, site.display_name);

    console.log(`DEBUG: Re-applying theme '${theme}' to ${site.github_repo}...`);

    for (const [filePath, content] of Object.entries(templateFiles)) {
      let sha;
      try {
        const { data: existing } = await octokit.repos.getContent({
          owner, repo, path: filePath, ref: site.branch
        });
        sha = existing.sha;
      } catch (e) { }

      await octokit.repos.createOrUpdateFileContents({
        owner, repo, path: filePath,
        message: `Update theme: ${theme}`,
        content: Buffer.from(content).toString("base64"),
        branch: site.branch,
        sha
      });
    }

    // Update Pages settings
    const buildType = theme === 'chirpy' ? 'workflow' : 'legacy';
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
          source: buildType === 'legacy' ? { branch: site.branch, path: '/' } : undefined
        });
      } catch (e) {
        // Create
        await octokit.repos.createPagesSite({
          owner, repo,
          build_type: buildType,
          source: buildType === 'legacy' ? { branch: site.branch, path: '/' } : undefined
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

router.put("/admin/sites/:siteId", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const { domain, display_name, branch, enabled } = req.body;

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

  res.json({ success: true });
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
  console.log(`DEBUG: Authenticated user object: ${JSON.stringify(user)}`);
  if (!user) return; // requireUser handles 401

  const path = req.params[0]; // Capture the * part
  let method = req.method;
  const body = req.body;
  let finalPath = path;

  // Context-aware proxying for generic requests (e.g., /branches/main)
  if (!path.startsWith("repos/") && !path.startsWith("user")) {
    if (user.siteId) {
      console.log(`DEBUG: Attempting site lookup for siteId=${user.siteId}`);
      const site = await db("sites").where({ id: user.siteId }).first();
      if (site) {
        console.log(`DEBUG: Rewriting generic proxy request request for site ${site.id} (${site.github_repo})`);
        // If requesting branches/main, map to repos/{owner}/{repo}/branches/main
        finalPath = `repos/${site.github_repo}/${path}`;
      }
    }
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
            response = await octokit.request(`${method} /${finalPath}`, { data: body });
          }

        } catch (walkErr) {
          console.error(`DEBUG: Manual walk failed: ${walkErr.message}. Falling back.`);
          response = await octokit.request(`${method} /${finalPath}`, { data: body });
        }
      } else {
        response = await octokit.request(`${method} /${finalPath}`, { data: body });
      }
    } else {
      response = await octokit.request(`${method} /${finalPath}`, { data: body });
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
            data: body,
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
  await ensureSchema(db);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on ${PORT}`);
    console.log("API Service v3 (Router Refactor)");
  });
})();
