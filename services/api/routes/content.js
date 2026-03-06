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

// ─── PUT /sites/:siteId/settings ──────────────────────────────────────────────

router.put("/:siteId/settings", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const { siteId } = req.params;
  const site = await getSiteForUser(user, siteId);
  if (!site) { res.status(403).json({ error: "Forbidden" }); return; }

  const { page_title, suptitle, brand_icon, favicon, display_name } = req.body || {};

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

  res.json({ success: true });
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

module.exports = router;

