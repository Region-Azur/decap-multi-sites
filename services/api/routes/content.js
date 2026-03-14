/**
 * Site content routes.
 *
 * Handles per-site settings updates and the GitHub content/files API used by
 * Decap CMS to read and write repository files.
 * Mounted under /sites in server.js.
 */

const express = require("express");
const db = require("../db");
const { requireUser, getSiteForUser } = require("../lib/auth");
const { getOctokit, parseRepo, commitMultipleFiles, preserveHomePage } = require("../lib/github-client");
const { buildAnonymousAuthor, getAnonymizedDecapCommitMessage, enrichChirpyFrontMatter } = require("../lib/content-utils");
const { generateAllFavicons } = require("../utils/favicon-generator");
const { getTemplateFiles } = require("../templates");

const router = express.Router();

// ─── Helper: Validate image size ──────────────────────────────────────────────

/**
 * Check if a base64-encoded image is too large
 * Returns { isWarning: boolean, message: string } or null
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

// ─── PUT /sites/:siteId/settings ──────────────────────────────────────────────

router.put("/:siteId/settings", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const { siteId } = req.params;
  const site = await getSiteForUser(user, siteId);
  if (!site) { res.status(403).json({ error: "Forbidden" }); return; }

  const { page_title, suptitle, brand_icon, favicon, display_name } = req.body || {};

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

  const updatePayload = {
    ...(page_title    !== undefined && { page_title }),
    ...(suptitle      !== undefined && { suptitle }),
    ...(brand_icon    !== undefined && { brand_icon }),
    ...(favicon       !== undefined && { favicon }),
    ...(display_name  !== undefined && { display_name }),
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
      pageTitle:  updatedSite.page_title || updatedSite.display_name,
      suptitle:   updatedSite.suptitle   || "Built with Decap CMS",
      avatarIcon: updatedSite.brand_icon || "",
      favicon:    updatedSite.favicon    || "",
    });

    const faviconSource = updatedSite.favicon || updatedSite.brand_icon;
    if (faviconSource) {
      const faviconFiles = await generateAllFavicons(faviconSource);
      Object.assign(templateFiles, faviconFiles);
    }

    templateFiles = await preserveHomePage(octokit, owner, repo, updatedSite.branch, templateFiles);
    await commitMultipleFiles(octokit, owner, repo, updatedSite.branch, templateFiles,
      `Update site settings: ${updatedSite.display_name}`);
  } catch (err) {
    console.error(`DEBUG: Failed to sync templates for ${updatedSite.github_repo}: ${err.message}`);
  }

  // Return success with any warnings
  res.json({ 
    success: true,
    warnings: warnings.length > 0 ? warnings.map(w => w.message) : undefined
  });
});

// ─── GET /sites/:siteId/contents ──────────────────────────────────────────────

router.get("/:siteId/contents", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const site = await getSiteForUser(user, req.params.siteId);
  if (!site) { res.status(403).json({ error: "Forbidden" }); return; }

  const path = req.query.path || "";
  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(site.github_repo);
    const response = await octokit.repos.getContent({ owner, repo, path, ref: site.branch });
    res.json(response.data);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: "Not found" });
    console.error("GET /contents error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── PUT /sites/:siteId/contents ─────────────────────────────────────────────

router.put("/:siteId/contents", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const site = await getSiteForUser(user, req.params.siteId);
  if (!site) { res.status(403).json({ error: "Forbidden" }); return; }

  const { path, content, message, sha, encoding } = req.body;
  if (!path || !content) { res.status(400).json({ error: "path and content required" }); return; }

  const octokit = await getOctokit();
  const { owner, repo } = parseRepo(site.github_repo);

  const normalizedContent = encoding === "base64"
    ? Buffer.from(content, "base64").toString("utf8")
    : content;
  const preparedContent = enrichChirpyFrontMatter(normalizedContent, path);

  const payload = {
    owner, repo, path,
    message: getAnonymizedDecapCommitMessage(message, path, "PUT"),
    content: Buffer.from(preparedContent).toString("base64"),
    branch: site.branch,
    author: buildAnonymousAuthor(null),
    // committer intentionally omitted → GitHub App bot identity triggers Actions
  };
  if (sha) payload.sha = sha;

  try {
    const response = await octokit.repos.createOrUpdateFileContents(payload);
    res.json(response.data);
  } catch (err) {
    console.error("PUT /contents error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── DELETE /sites/:siteId/contents ──────────────────────────────────────────

router.delete("/:siteId/contents", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const site = await getSiteForUser(user, req.params.siteId);
  if (!site) { res.status(403).json({ error: "Forbidden" }); return; }

  const { path, sha, message } = req.body;
  if (!path || !sha) { res.status(400).json({ error: "path and sha required" }); return; }

  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(site.github_repo);
    const response = await octokit.repos.deleteFile({
      owner, repo, path,
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

// ─── GET /sites/:siteId/files ────────────────────────────────────────────────

router.get("/:siteId/files", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const site = await getSiteForUser(user, req.params.siteId);
  if (!site) { res.status(403).json({ error: "Forbidden" }); return; }

  const { path } = req.query;
  const octokit = await getOctokit();
  const { owner, repo } = parseRepo(site.github_repo);

  try {
    const { data: treeData } = await octokit.git.getTree({
      owner, repo, tree_sha: site.branch, recursive: 1,
    });

    const files = treeData.tree
      .filter((item) => item.path.startsWith(path) && item.type === "blob")
      .map((item) => ({
        path: item.path,
        sha: item.sha,
        size: item.size,
        name: item.path.replace(path, "").replace(/^\//, ""),
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
});

// Serve media files (images, etc.) for editor preview
// This allows Decap CMS to display images in the editor by fetching them through the API
router.get("/:siteId/media/*", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const site = await getSiteForUser(user, req.params.siteId);
  if (!site) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const mediaPath = req.params[0]; // Capture the * part (file path)
  console.log("DEBUG: Media fetch", { siteId: site.id, branch: site.branch, mediaPath });
  const octokit = await getOctokit();
  const { owner, repo } = parseRepo(site.github_repo);

  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: mediaPath,
      ref: site.branch,
    });

    // Set appropriate content type based on file extension
    const ext = mediaPath.split(".").pop().toLowerCase();
    const contentTypes = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
    };
    const contentType = contentTypes[ext] || "application/octet-stream";

    const sendBuffer = (buffer) => {
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Cache-Control", "public, max-age=3600"); // Cache for 1 hour
      res.setHeader("Access-Control-Allow-Origin", "*"); // Allow cross-origin access for editor preview
      res.send(buffer);
    };

    // Primary: content API returns inline base64
    if (data.encoding === "base64" && data.content) {
      sendBuffer(Buffer.from(data.content, "base64"));
      return;
    }

    // Fallback for large files (>1MB): fetch blob by SHA
    if (data.type === "file" && data.sha) {
      try {
        const blob = await octokit.git.getBlob({ owner, repo, file_sha: data.sha });
        if (blob.data && blob.data.encoding === "base64" && blob.data.content) {
          sendBuffer(Buffer.from(blob.data.content, "base64"));
          return;
        }
      } catch (blobErr) {
        console.error(`DEBUG: Failed blob fetch for ${mediaPath}: ${blobErr.message}`);
      }
    }

    // Text file fallback
    if (data.type === "file" && typeof data.content === "string") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(data.content);
      return;
    }

    res.status(404).json({ error: "File not found or is a directory" });
  } catch (err) {
    if (err.status === 404) {
      console.log("DEBUG: Media file not found", { mediaPath });
      res.status(404).json({ error: "Media file not found" });
    } else {
      console.error(`DEBUG: Failed to fetch media ${mediaPath}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  }
});

module.exports = router;

