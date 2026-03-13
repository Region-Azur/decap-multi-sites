/**
 * Admin routes — site management, permissions, and user listing.
 *
 * All routes require the caller to be an admin.
 * Write operations are additionally throttled by adminWriteLimiter.
 */

const crypto = require("crypto");
const express = require("express");
const db = require("../db");
const config = require("../config");
const logger = require("../shared/logger");
const { requireAdmin } = require("../lib/auth");
const { getOctokit, parseRepo, commitMultipleFiles } = require("../lib/github-client");
const { generateAllFavicons } = require("../utils/favicon-generator");
const { getTemplateFiles } = require("../templates");
const { adminWriteLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

// ─── Helper: Validate image size ──────────────────────────────────────────────

/**
 * Check if a base64-encoded image is too large
 * Returns { isWarning: boolean, message: string }
 */
function validateImageSize(base64Url, fieldName) {
  if (!base64Url || !base64Url.startsWith("data:")) {
    return null; // Not a base64 image, skip validation
  }

  // Extract the actual base64 data (after comma)
  const base64Data = base64Url.split(",")[1];
  if (!base64Data) return null;

  // Calculate size: base64 is ~33% larger than binary
  // Each base64 character = 6 bits, so actual size ≈ (base64Length * 6) / 8
  const binarySizeBytes = Math.ceil((base64Data.length * 6) / 8);
  const sizeKB = binarySizeBytes / 1024;
  const sizeMB = sizeKB / 1024;

  // Warnings
  if (sizeMB > 2) {
    return {
      isWarning: true,
      message: `⚠️  ${fieldName} is very large (${sizeMB.toFixed(2)}MB). This will increase the size of your website and may slow down page loads. Consider compressing or resizing your image.`,
    };
  } else if (sizeKB > 500) {
    return {
      isWarning: true,
      message: `⚠️  ${fieldName} is large (${sizeKB.toFixed(0)}KB). Consider optimizing or compressing your image for better performance.`,
    };
  }

  return null; // No warning
}

// ...existing code...

// ─── GET /admin/sites ─────────────────────────────────────────────────────────

router.get("/sites", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sites = await db("sites").orderBy("display_name");
  res.json({ sites });
});

// ─── POST /admin/sites ────────────────────────────────────────────────────────

router.post("/sites", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const {
    id, display_name, github_repo,
    branch = "main", content_path = "content",
    media_path = "static/uploads/", domain = null,
    page_title = null, suptitle = "Built with Decap CMS",
    brand_icon = null, favicon = null, enabled = true,
    theme = "minima",
  } = req.body;

  if (!id || !display_name || !github_repo) {
    res.status(400).json({ error: "id, display_name, github_repo required" });
    return;
  }

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
  const safeRepoPattern = /^[a-zA-Z0-9_.\-]+$/;
  if (!safeRepoPattern.test(repoOwnerPart) || !safeRepoPattern.test(repoNamePart)) {
    res.status(400).json({ error: "github_repo contains invalid characters" });
    return;
  }
  const finalGithubRepo = `${repoOwnerPart}/${repoNamePart}`;

  await db("sites").insert({
    id, display_name, github_repo: finalGithubRepo, branch,
    content_path, media_path, domain, page_title, suptitle,
    brand_icon, favicon, enabled: Boolean(enabled),
  });

  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(finalGithubRepo);

    const templateUrls = getTemplateFiles(theme, display_name, {
      pageTitle: page_title || display_name,
      suptitle: suptitle || "Built with Decap CMS",
      avatarIcon: brand_icon || "",
      favicon: favicon || "",
      domain: domain || "",
      githubRepo: finalGithubRepo,
    });

    logger.info(`Applying theme '${theme}' to repository`, { repo: finalGithubRepo });
    await commitMultipleFiles(octokit, owner, repo, branch, templateUrls, `Initialize theme: ${theme}`);

    try {
      await octokit.repos.createPagesSite({ owner, repo, build_type: "workflow", source: undefined });
      logger.debug("GitHub Pages enabled", { buildType: "workflow", repo: finalGithubRepo });
    } catch (pagesErr) {
      logger.warn("Failed to enable GitHub Pages", { 
        repo: finalGithubRepo, 
        error: pagesErr.message 
      });
    }

    if (domain) {
      let sha;
      try {
        const { data: f } = await octokit.repos.getContent({ owner, repo, path: "CNAME", ref: branch });
        sha = f.sha;
      } catch (_) { /* 404 ok */ }
      await octokit.repos.createOrUpdateFileContents({
        owner, repo, path: "CNAME",
        message: `Configure custom domain: ${domain}`,
        content: Buffer.from(domain).toString("base64"),
        branch, sha,
      });
    }
  } catch (err) {
    console.error(`DEBUG: Post-creation setup failed: ${err.message}`);
  }

  res.status(201).json({ id });
});

// ─── POST /admin/sites/:siteId/template ───────────────────────────────────────

router.post("/sites/:siteId/template", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const { theme } = req.body;

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) { res.status(404).json({ error: "Site not found" }); return; }

  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(site.github_repo);
    const templateFiles = getTemplateFiles(theme, site.display_name, {
      pageTitle: site.page_title || site.display_name,
      suptitle: site.suptitle || "Built with Decap CMS",
      avatarIcon: site.brand_icon || "",
      favicon: site.favicon || "",
    });

    console.log(`DEBUG: Re-applying theme '${theme}' to ${site.github_repo}...`);
    await commitMultipleFiles(octokit, owner, repo, site.branch, templateFiles, `Update theme: ${theme}`);

    try {
      try {
        await octokit.repos.getPages({ owner, repo });
        await octokit.repos.updateInformationAboutPagesSite({ owner, repo, build_type: "workflow", source: undefined });
      } catch (_) {
        await octokit.repos.createPagesSite({ owner, repo, build_type: "workflow", source: undefined });
      }
    } catch (pagesErr) {
      console.error(`DEBUG: Failed to update Pages settings: ${pagesErr.message}`);
    }

    res.json({ success: true, message: "Template deployed and Pages configured." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to deploy template: " + err.message });
  }
});

// ─── PUT /admin/sites/:siteId ─────────────────────────────────────────────────

router.put("/sites/:siteId", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const { domain, display_name, branch, enabled, page_title, suptitle, brand_icon, favicon } = req.body;

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) { res.status(404).json({ error: "Site not found" }); return; }

  // Validate image sizes and collect warnings
  const warnings = [];
  
  if (brand_icon !== undefined && brand_icon) {
    const brandIconWarning = validateImageSize(brand_icon, "Chirpy Avatar (brand_icon)");
    if (brandIconWarning) warnings.push(brandIconWarning);
  }
  
  if (favicon !== undefined && favicon) {
    const faviconWarning = validateImageSize(favicon, "Favicon");
    if (faviconWarning) warnings.push(faviconWarning);
  }

  await db("sites").where({ id: siteId }).update({
    domain:       domain       !== undefined ? domain       : site.domain,
    display_name: display_name || site.display_name,
    branch:       branch       || site.branch,
    page_title:   page_title   !== undefined ? page_title   : site.page_title,
    suptitle:     suptitle     !== undefined ? suptitle     : site.suptitle,
    brand_icon:   brand_icon   !== undefined ? brand_icon   : site.brand_icon,
    favicon:      favicon      !== undefined ? favicon      : site.favicon,
    enabled:      enabled      !== undefined ? Boolean(enabled) : site.enabled,
  });

  // Update CNAME if domain changed
  if (domain && domain !== site.domain) {
    try {
      const octokit = await getOctokit();
      const { owner, repo } = parseRepo(site.github_repo);
      const targetBranch = branch || site.branch;
      let sha;
      try {
        const { data: f } = await octokit.repos.getContent({ owner, repo, path: "CNAME", ref: targetBranch });
        sha = f.sha;
      } catch (_) { /* 404 ok */ }
      await octokit.repos.createOrUpdateFileContents({
        owner, repo, path: "CNAME",
        message: `Update custom domain: ${domain}`,
        content: Buffer.from(domain).toString("base64"),
        branch: targetBranch, sha,
      });
    } catch (err) {
      console.error(`DEBUG: Failed to update CNAME: ${err.message}`);
    }
  }

  // Regenerate _config.yml if title or domain changed
  if ((page_title && page_title !== site.page_title) || (domain && domain !== site.domain)) {
    try {
      const octokit = await getOctokit();
      const { owner, repo } = parseRepo(site.github_repo);
      const targetBranch = branch || site.branch;
      const configFiles = getTemplateFiles(site.theme || "chirpy", display_name || site.display_name, {
        pageTitle:  page_title  || site.page_title  || site.display_name,
        suptitle:   suptitle   !== undefined ? suptitle   : site.suptitle,
        avatarIcon: brand_icon !== undefined ? brand_icon : site.brand_icon || "",
        favicon:    favicon    !== undefined ? favicon    : site.favicon    || "",
        domain:     domain || "",
        githubRepo: site.github_repo,
      });

      if (configFiles["_config.yml"]) {
        let sha;
        try {
          const { data: f } = await octokit.repos.getContent({ owner, repo, path: "_config.yml", ref: targetBranch });
          sha = f.sha;
        } catch (_) { /* 404 ok */ }
        await octokit.repos.createOrUpdateFileContents({
          owner, repo, path: "_config.yml",
          message: "Update site configuration",
          content: Buffer.from(configFiles["_config.yml"]).toString("base64"),
          branch: targetBranch, sha,
        });
        logger.debug("_config.yml updated successfully");
      }
    } catch (err) {
      logger.error("Failed to update _config.yml", { error: err.message });
    }
  }

  // Return success with any warnings
  res.json({ 
    success: true,
    warnings: warnings.length > 0 ? warnings.map(w => w.message) : undefined
  });
});

// ─── DELETE /admin/sites/:siteId ───────────────────────────────────────���──────

router.delete("/sites/:siteId", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const site = await db("sites").where({ id: siteId }).first();
  if (!site) { res.status(404).json({ error: "Site not found" }); return; }

  await db("site_permissions").where({ site_id: siteId }).del();
  await db("api_tokens").where({ site_id: siteId }).del();
  await db("sites").where({ id: siteId }).del();
  res.status(204).send();
});

// ─── GET /admin/sites/:siteId/reset-token ─────────────────────────────────────

router.get("/sites/:siteId/reset-token", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const site = await db("sites").where({ id: siteId }).first();
  if (!site) { res.status(404).json({ error: "Site not found" }); return; }

  const window = Math.floor(Date.now() / (5 * 60 * 1000));
  const token = crypto
    .createHmac("sha256", config.JWT_SECRET)
    .update(`reset:${siteId}:${window}`)
    .digest("hex");
  res.json({ confirmationToken: token });
});

// ─── POST /admin/sites/:siteId/reset ──────────────────────────────────────────

router.post("/sites/:siteId/reset", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const { confirmationToken } = req.body;

  const now = Math.floor(Date.now() / (5 * 60 * 1000));
  const validTokens = [now, now - 1].map((w) =>
    crypto.createHmac("sha256", config.JWT_SECRET).update(`reset:${siteId}:${w}`).digest("hex")
  );
  if (!confirmationToken || !validTokens.includes(confirmationToken)) {
    res.status(400).json({ error: "Invalid or expired confirmation token. Request a new one." });
    return;
  }

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) { res.status(404).json({ error: "Site not found" }); return; }

  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(site.github_repo);

    let templateFiles = getTemplateFiles(site.theme || "chirpy", site.display_name, {
      pageTitle: site.page_title || site.display_name,
      suptitle:  site.suptitle  || "Built with Decap CMS",
      avatarIcon: site.brand_icon || "",
      favicon:   site.favicon   || "",
    });

    const faviconSource = site.favicon || site.brand_icon;
    if (faviconSource) {
      const faviconFiles = await generateAllFavicons(faviconSource);
      Object.assign(templateFiles, faviconFiles);
    }

    console.log(`DEBUG: Resetting repository ${site.github_repo} to initial state...`);
    await commitMultipleFiles(octokit, owner, repo, site.branch, templateFiles,
      "Reset repository to initial state (Decap admin action)");

    try {
      try {
        await octokit.repos.getPages({ owner, repo });
        await octokit.repos.updateInformationAboutPagesSite({ owner, repo, build_type: "workflow", source: undefined });
      } catch (_) {
        await octokit.repos.createPagesSite({ owner, repo, build_type: "workflow", source: undefined });
      }
    } catch (pagesErr) {
      console.error(`DEBUG: Failed to update Pages settings: ${pagesErr.message}`);
    }

    res.json({ success: true, message: "Repository reset to initial state. GitHub Actions will rebuild the site shortly." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset repository: " + err.message });
  }
});

// ─── POST /admin/permissions ──────────────────────────────────────────────────

router.post("/permissions", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { email, site_id, role } = req.body;
  if (!email || !site_id) { res.status(400).json({ error: "email and site_id required" }); return; }

  const user = await db("users").where({ email: email.toLowerCase() }).first();
  if (!user) { res.status(404).json({ error: "user not found" }); return; }

  const site = await db("sites").where({ id: site_id }).first();
  if (!site) { res.status(404).json({ error: "site not found" }); return; }

  await db("site_permissions")
    .insert({ user_id: user.id, site_id, role: role || null })
    .onConflict(["user_id", "site_id"])
    .merge();
  res.status(201).json({ user_id: user.id, site_id });
});

// ─── DELETE /admin/permissions ────────────────────────────────────────────────

router.delete("/permissions", adminWriteLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { email, site_id } = req.body;
  if (!email || !site_id) { res.status(400).json({ error: "email and site_id required" }); return; }

  const user = await db("users").where({ email: email.toLowerCase() }).first();
  if (!user) { res.status(404).json({ error: "user not found" }); return; }

  await db("site_permissions").where({ user_id: user.id, site_id }).del();
  res.status(204).send();
});

// ─── GET /admin/users ─────────────────────────────────────────────────────────

router.get("/users", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const q = (req.query.q || "").toLowerCase().trim();
  let query = db("users").orderBy("email");
  if (q) query = query.where("email", "like", `%${q}%`);

  const users = await query;
  res.json({ users });
});

module.exports = router;

