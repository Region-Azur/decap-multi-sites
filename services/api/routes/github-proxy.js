/**
 * Generic GitHub API proxy — Git Gateway compatibility layer.
 *
 * Proxies requests from /.netlify/git/github/* to the GitHub REST API,
 * rewrites paths to include the correct repo, anonymises commit authors,
 * and enforces per-user repository access controls.
 * Mounted at /github in server.js.
 */

const express = require("express");
const db = require("../db");
const { requireUser } = require("../lib/auth");
const { getOctokit } = require("../lib/github-client");
const { buildAnonymousAuthor, getAnonymizedDecapCommitMessage } = require("../lib/content-utils");

const router = express.Router();

router.all("/*", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const path = req.params[0];
  const method = req.method;
  const body = req.body;

  const proxiedBody = body && typeof body === "object" ? { ...body } : body;
  const isWriteMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  if (proxiedBody && typeof proxiedBody === "object" && isWriteMethod) {
    if (Object.prototype.hasOwnProperty.call(proxiedBody, "message")) {
      proxiedBody.message = getAnonymizedDecapCommitMessage(
        proxiedBody.message, proxiedBody.path, method
      );
    }
    if (Object.prototype.hasOwnProperty.call(proxiedBody, "author")) {
      proxiedBody.author = buildAnonymousAuthor(proxiedBody.author);
    }
    // committer intentionally omitted → GitHub App bot identity triggers Actions
  }

  // ── Determine target site / repo ──────────────────────────────────────────
  let finalPath = path;
  let targetSite = null;

  if (user.siteId) {
    console.log(`DEBUG: Using siteId from JWT: ${user.siteId}`);
    targetSite = await db("sites").where({ id: user.siteId }).first();
  } else if (!path.startsWith("repos/") && !path.startsWith("user")) {
    console.log(`DEBUG: No siteId in JWT, attempting to find permitted site (admin=${user.is_admin})...`);
    let permittedSites;
    if (user.is_admin) {
      permittedSites = await db("sites").where({ enabled: true }).select("*");
    } else {
      permittedSites = await db("sites")
        .join("site_permissions", "sites.id", "site_permissions.site_id")
        .where({ "site_permissions.user_id": user.id, "sites.enabled": true })
        .select("sites.*");
    }
    if (permittedSites && permittedSites.length > 0) {
      targetSite = permittedSites[0];
      console.log(`DEBUG: Found permitted site: ${targetSite.id} (${targetSite.github_repo})`);
    } else {
      console.log(`DEBUG: No permitted sites found for user ${user.email}`);
    }
  }

  if (targetSite && !path.startsWith("repos/")) {
    console.log(`DEBUG: Rewriting proxy request for site ${targetSite.id} (${targetSite.github_repo})`);
    finalPath = `repos/${targetSite.github_repo}/${path}`;
  }

  console.log(`DEBUG: Proxying GitHub request: ${method} /${path} -> /${finalPath}`);

  // ── Auto-create branch for GET /branches/:branch ──────────────────────────
  if (method === "GET" && finalPath.match(/^repos\/[^/]+\/[^/]+\/branches\/([^/]+)$/)) {
    try {
      const octokit = await getOctokit();
      const branchMatch = finalPath.match(/^repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/);
      const [, owner, repo, branch] = branchMatch;
      const { data: repoData } = await octokit.repos.get({ owner, repo });

      if (repoData.size === 0) {
        await octokit.repos.createOrUpdateFileContents({
          owner, repo, path: "README.md",
          message: "Initial commit by Decap CMS Proxy",
          content: Buffer.from("# " + repoData.name).toString("base64"),
          branch,
        });
        console.log(`DEBUG: Initialized empty repo with ${branch} branch.`);
      } else {
        try {
          await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
        } catch (_) {
          const { data: refData } = await octokit.git.getRef({ owner, repo, ref: `heads/${repoData.default_branch}` });
          await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: refData.object.sha });
          console.log(`DEBUG: Created missing branch ${branch} from ${repoData.default_branch}`);
        }
      }
    } catch (branchErr) {
      console.error(`DEBUG: Branch auto-creation failed: ${branchErr.message}`);
    }
  }

  // ── Access control (non-admins) ───────────────────────────────────────────
  if (!user.is_admin) {
    const match = finalPath.match(/^repos\/([^/]+)\/([^/]+)/);
    if (match) {
      const fullRepo = `${match[1]}/${match[2]}`;
      const permittedSite = await db("sites")
        .join("site_permissions", "sites.id", "site_permissions.site_id")
        .where({
          "site_permissions.user_id": user.id,
          "sites.github_repo": fullRepo,
          "sites.enabled": true,
        })
        .first();
      if (!permittedSite) {
        console.log(`DEBUG: Proxy denied for ${user.email} -> ${fullRepo}`);
        res.status(403).json({ error: "Forbidden: You do not have access to this repository." });
        return;
      }
    }
  }

  // ── Forward request to GitHub ─────────────────────────────────────────────
  try {
    const octokit = await getOctokit();
    let response;

    // Special handling: Decap sometimes sends "branch:path" in git/trees requests
    if (method === "GET" && finalPath.includes("/git/trees/") && finalPath.includes(":")) {
      const colonMatch = finalPath.match(/git\/trees\/([^:]+):(.+)$/);
      if (colonMatch) {
        const [, branch, treePath] = colonMatch;
        const repoPathMatch = finalPath.match(/^repos\/([^/]+)\/([^/]+)\//);
        const owner = repoPathMatch[1];
        const repo  = repoPathMatch[2];

        console.log(`DEBUG: Manual tree walk for ${owner}/${repo} ref=${branch} path=${treePath}`);
        try {
          const { data: rootData } = await octokit.git.getTree({ owner, repo, tree_sha: branch });
          let targetSha = null;
          const pathParts = treePath.split("/");
          let currentTree = rootData.tree;

          for (const part of pathParts) {
            if (!part) continue;
            const item = currentTree.find((t) => t.path === part && t.type === "tree");
            if (!item) { targetSha = null; break; }
            targetSha = item.sha;
            if (pathParts.indexOf(part) < pathParts.length - 1) {
              const { data: nextTree } = await octokit.git.getTree({ owner, repo, tree_sha: targetSha });
              currentTree = nextTree.tree;
            }
          }

          if (targetSha) {
            console.log(`DEBUG: Resolved path '${treePath}' to SHA ${targetSha}.`);
            response = await octokit.git.getTree({ owner, repo, tree_sha: targetSha });
          } else {
            console.log(`DEBUG: Could not resolve SHA for '${treePath}'. Falling back.`);
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

    // Debug logging for content / tree responses
    if (finalPath.includes("/contents/") || finalPath.includes("/git/trees/")) {
      console.log(`DEBUG: GitHub proxy response for ${finalPath}: status ${response.status}`);
      if (response.data && response.data.tree) {
        // Filter README.md to prevent CMS parsing errors
        response.data.tree = response.data.tree.filter(
          (f) => f.path !== "README.md" && !f.path.endsWith("/README.md")
        );
        console.log(`DEBUG: Tree (filtered): ${response.data.tree.map((f) => `${f.path} [${f.type}]`).join(", ")}`);
      } else if (Array.isArray(response.data)) {
        console.log(`DEBUG: Directory listing: ${response.data.map((f) => f.name).join(", ")}`);
      }
    }

    res.status(response.status).json(response.data);
  } catch (err) {
    // Empty tree / folder not yet created
    if (err.status === 404 && method === "GET" && finalPath.includes("/git/trees/")) {
      console.log(`DEBUG: Tree/path not found for ${finalPath} (likely empty folder), returning empty tree.`);
      res.json({ sha: "empty-tree", url: "", tree: [], truncated: false });
      return;
    }

    // Auto-recover: create branch if GET /branches/:branch returns 404
    if (err.status === 404 && method === "GET") {
      const branchMatch = finalPath.match(/^repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/);
      if (branchMatch) {
        const [, owner, repo, branch] = branchMatch;
        console.log(`DEBUG: Branch ${branch} not found for ${owner}/${repo}. Attempting auto-creation...`);
        try {
          const octokit = await getOctokit();
          const { data: repoData } = await octokit.repos.get({ owner, repo });
          if (repoData.size === 0) {
            await octokit.repos.createOrUpdateFileContents({
              owner, repo, path: "README.md",
              message: "Initial commit by Decap CMS Proxy",
              content: Buffer.from("# " + repoData.name).toString("base64"),
              branch,
            });
          } else {
            const { data: refData } = await octokit.git.getRef({ owner, repo, ref: `heads/${repoData.default_branch}` });
            await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: refData.object.sha });
            console.log(`DEBUG: Created ${branch} pointing to ${refData.object.sha}`);
          }
          const retryResponse = await octokit.request(`${method} /${finalPath}`, { data: proxiedBody });
          res.status(retryResponse.status).json(retryResponse.data);
          return;
        } catch (recoveryErr) {
          console.error(`DEBUG: Auto-recovery failed: ${recoveryErr.message}`);
        }
      }
    }

    console.error(`DEBUG: Proxy error: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;

