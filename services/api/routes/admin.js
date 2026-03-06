const express = require("express");
const { getTemplateFiles } = require("../templates");
const { createDb } = require("../shared/db");
const config = require("../config");
const {
  getOctokit,
  parseRepo,
  commitMultipleFiles,
  preserveHomePage
} = require("../services/github");
const { generateAllFavicons } = require("../utils/favicon-generator");

const router = express.Router();
const db = createDb(config.DATABASE_URL);

// Helper to require admin
async function requireAdmin(req, res) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    res.status(401).json({ error: "Missing authorization" });
    return null;
  }

  const apiToken = await db("api_tokens")
    .join("users", "api_tokens.user_id", "users.id")
    .where("api_tokens.token", token)
    .select("users.*")
    .first();

  if (!apiToken || !apiToken.is_admin) {
    res.status(403).json({ error: "Admin access required" });
    return null;
  }

  return apiToken;
}

// GET /api/admin/sites
router.get("/sites", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const sites = await db("sites").orderBy("display_name");
  res.json({ sites });
});

// POST /api/admin/sites
router.post("/sites", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

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
    theme = "chirpy"
  } = req.body;

  if (!id || !display_name || !github_repo) {
    res.status(400).json({ error: "id, display_name, github_repo required" });
    return;
  }

  // Sanitize github_repo - trim whitespace and validate format
  const sanitizedRepo = github_repo.trim();
  const repoParts = sanitizedRepo.split("/");
  
  if (repoParts.length !== 2) {
    res.status(400).json({ error: "github_repo must be in format owner/repo" });
    return;
  }

  const owner = repoParts[0].trim();
  const repo = repoParts[1].trim();
  
  if (!owner || !repo) {
    res.status(400).json({ error: "github_repo owner and repo cannot be empty" });
    return;
  }

  const finalGithubRepo = `${owner}/${repo}`;

  console.log(`DEBUG: Creating site ${id} with repo ${finalGithubRepo}`);

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
    theme,
    enabled: Boolean(enabled),
  });

  // Auto-configuration (Templates & Pages)
  try {
    const octokit = await getOctokit();
    const { owner: parsedOwner, repo: parsedRepo } = parseRepo(finalGithubRepo);

    const templateFiles = getTemplateFiles(theme, display_name, {
      pageTitle: page_title || display_name,
      suptitle: suptitle || 'Built with Decap CMS',
      avatarIcon: brand_icon || '',
      favicon: favicon || '',
    });

    // Generate favicons automatically if favicon or brand_icon is provided
    const faviconSource = favicon || brand_icon;
    if (faviconSource) {
      console.log(`DEBUG: Generating favicons from: ${faviconSource.substring(0, 50)}...`);
      const faviconFiles = await generateAllFavicons(faviconSource);

      // Merge favicon files into template files
      Object.assign(templateFiles, faviconFiles);
      console.log(`DEBUG: Added ${Object.keys(faviconFiles).length} favicon files`);
    }

    console.log(`DEBUG: Deploying ${Object.keys(templateFiles).length} template files to ${finalGithubRepo}...`);
    await commitMultipleFiles(octokit, parsedOwner, parsedRepo, branch, templateFiles, `Initial commit: ${theme} theme`);

    try {
      await octokit.repos.createPagesSite({
        owner: parsedOwner,
        repo: parsedRepo,
        build_type: 'workflow',
        source: undefined
      });
    } catch (e) {
      console.error(`DEBUG: Failed to create Pages site (may already exist): ${e.message}`);
    }

    if (domain) {
      let sha = undefined;
      try {
        const { data: existingFile } = await octokit.repos.getContent({
          owner: parsedOwner, repo: parsedRepo, path: "CNAME", ref: branch
        });
        sha = existingFile.sha;
      } catch (e) { }

      await octokit.repos.createOrUpdateFileContents({
        owner: parsedOwner, repo: parsedRepo, path: "CNAME",
        message: `Configure custom domain: ${domain}`,
        content: Buffer.from(domain).toString("base64"),
        branch,
        sha
      });
    }

  } catch (err) {
    console.error(`DEBUG: Post-creation setup failed: ${err.message}`);
    console.error(err.stack);
  }

  res.status(201).json({ id });
});

// POST /api/admin/sites/:siteId/template
router.post("/sites/:siteId/template", async (req, res) => {
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
    let templateFiles = getTemplateFiles(theme, site.display_name, {
      pageTitle: site.page_title || site.display_name,
      suptitle: site.suptitle || 'Built with Decap CMS',
      avatarIcon: site.brand_icon || '',
      favicon: site.favicon || '',
    });

    const faviconSource = site.favicon || site.brand_icon;
    if (faviconSource) {
      const faviconFiles = await generateAllFavicons(faviconSource);
      Object.assign(templateFiles, faviconFiles);
    }

    templateFiles = await preserveHomePage(octokit, owner, repo, site.branch, templateFiles);

    console.log(`DEBUG: Re-applying theme '${theme}' to ${site.github_repo}...`);
    if (Object.keys(templateFiles).length) {
      await commitMultipleFiles(octokit, owner, repo, site.branch, templateFiles, `Update theme: ${theme}`);
    } else {
      console.log("DEBUG: No template files to update after preserving content/index.md.");
    }

    // Update Pages settings
    const buildType = 'workflow';
    try {
      try {
        await octokit.repos.getPages({ owner, repo });
        await octokit.repos.updateInformationAboutPagesSite({
          owner, repo,
          build_type: buildType,
          source: undefined
        });
      } catch (e) {
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

// PUT /api/admin/sites/:siteId
router.put("/sites/:siteId", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const { domain, display_name, branch, enabled, page_title, suptitle, brand_icon, favicon, theme } = req.body;

  const site = await db("sites").where({ id: siteId }).first();
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  // Update database
  await db("sites").where({ id: siteId }).update({
    ...(domain !== undefined && { domain }),
    ...(display_name && { display_name }),
    ...(branch && { branch }),
    ...(enabled !== undefined && { enabled: Boolean(enabled) }),
    ...(page_title !== undefined && { page_title }),
    ...(suptitle !== undefined && { suptitle }),
    ...(brand_icon !== undefined && { brand_icon }),
    ...(favicon !== undefined && { favicon }),
    ...(theme !== undefined && { theme }),
  });

  // Fetch updated site data
  const updatedSite = await db("sites").where({ id: siteId }).first();

  // Update GitHub repository with new template files (preserving home page content)
  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(updatedSite.github_repo);

    // Determine theme to use
    const siteTheme = updatedSite.theme || theme || 'chirpy';

    // Generate template files with updated settings
    let templateFiles = getTemplateFiles(siteTheme, updatedSite.display_name, {
      pageTitle: updatedSite.page_title || updatedSite.display_name,
      suptitle: updatedSite.suptitle || 'Built with Decap CMS',
      avatarIcon: updatedSite.brand_icon || '',
      favicon: updatedSite.favicon || '',
    });

    // Generate favicons automatically if favicon or brand_icon is provided
    const faviconSource = updatedSite.favicon || updatedSite.brand_icon;
    if (faviconSource) {
      console.log(`DEBUG: Generating favicons from: ${faviconSource.substring(0, 50)}...`);
      const faviconFiles = await generateAllFavicons(faviconSource);

      // Merge favicon files into template files
      Object.assign(templateFiles, faviconFiles);
      console.log(`DEBUG: Added ${Object.keys(faviconFiles).length} favicon files`);
    }

    // Preserve existing home page content
    templateFiles = await preserveHomePage(octokit, owner, repo, updatedSite.branch, templateFiles);

    console.log(`DEBUG: Updating template files for ${updatedSite.github_repo} after settings change...`);

    if (Object.keys(templateFiles).length > 0) {
      await commitMultipleFiles(
        octokit,
        owner,
        repo,
        updatedSite.branch,
        templateFiles,
        `Update site configuration: ${display_name || page_title || suptitle || 'settings changed'}`
      );
      console.log(`DEBUG: Successfully updated template files for ${updatedSite.github_repo}`);
    } else {
      console.log("DEBUG: No template files to update after preserving content/index.md.");
    }
  } catch (err) {
    console.error(`DEBUG: Failed to update template files: ${err.message}`);
    // Don't fail the request if GitHub update fails - settings are already saved in DB
  }

  res.json({ success: true, message: "Site settings updated and repository synchronized" });
});

// DELETE /api/admin/sites/:siteId
router.delete("/sites/:siteId", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;

  await db("site_permissions").where({ site_id: siteId }).delete();
  await db("sites").where({ id: siteId }).delete();

  res.json({ success: true });
});

// POST /api/admin/permissions
router.post("/permissions", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { email, site_id } = req.body;

  if (!email || !site_id) {
    res.status(400).json({ error: "email and site_id required" });
    return;
  }

  const user = await db("users").where({ email }).first();
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const site = await db("sites").where({ id: site_id }).first();
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  await db("site_permissions").insert({
    user_id: user.id,
    site_id: site_id,
  });

  res.json({ success: true });
});

// DELETE /api/admin/permissions
router.delete("/permissions", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { email, site_id } = req.body;

  if (!email || !site_id) {
    res.status(400).json({ error: "email and site_id required" });
    return;
  }

  const user = await db("users").where({ email }).first();
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  await db("site_permissions")
    .where({ user_id: user.id, site_id: site_id })
    .delete();

  res.status(204).send();
});

// POST /api/admin/sites/:siteId/reset
// Requires double confirmation token from client
router.post("/sites/:siteId/reset", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { siteId } = req.params;
  const { confirmationToken } = req.body;

  // Verify double confirmation token
  if (confirmationToken !== `reset-${siteId}-confirmed`) {
    res.status(400).json({ error: "Invalid confirmation token. Please confirm twice." });
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

module.exports = router;

