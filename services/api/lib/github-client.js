/**
 * Full GitHub App client and git helper utilities.
 *
 * Uses the richer `commitMultipleFiles` implementation from index.js that
 * handles empty repositories, branch creation, and atomic multi-file commits.
 */

const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");
const config = require("../config");

// ─── Private key normalisation ────────────────────────────────────────────────

function normalizePrivateKey(rawKey) {
  if (!rawKey) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is required");
  }

  const decoded = config.GITHUB_APP_PRIVATE_KEY_BASE64
    ? Buffer.from(rawKey, "base64").toString("utf8")
    : rawKey;

  let normalized = decoded.replace(/\\n/g, "\n");

  if (!normalized.includes("-----BEGIN")) {
    normalized = `-----BEGIN RSA PRIVATE KEY-----\n${normalized}\n-----END RSA PRIVATE KEY-----`;
  }

  return normalized;
}

// ─── Octokit factory ──────────────────────────────────────────────────────────

/**
 * Returns an authenticated Octokit instance using a fresh installation token.
 * A new token is requested on each call; caching is handled by @octokit/auth-app.
 */
async function getOctokit() {
  if (!config.GITHUB_APP_ID || !config.GITHUB_APP_INSTALLATION_ID) {
    throw new Error(
      "GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID are required"
    );
  }

  const auth = createAppAuth({
    appId: config.GITHUB_APP_ID,
    privateKey: normalizePrivateKey(config.GITHUB_APP_PRIVATE_KEY),
    installationId: config.GITHUB_APP_INSTALLATION_ID,
  });

  const { token } = await auth({ type: "installation" });
  return new Octokit({ auth: token });
}

// ─── Repo helpers ─────────────────────────────────────────────────────────────

function parseRepo(fullName) {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo format: ${fullName}`);
  }
  return { owner: owner.trim(), repo: repo.trim() };
}

// ─── Atomic multi-file commit ─────────────────────────────────────────────────

/**
 * Creates a single commit that adds/updates all files in `filesMap` atomically.
 * Handles empty repositories and auto-creates the target branch if it doesn't
 * exist yet.
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {Object<string, string>} filesMap  path → content (strings or Buffers)
 * @param {string} message  commit message
 * @returns {Promise<string>}  the new commit SHA
 */
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
        ref: `heads/${branch}`,
      });
      commitSha = refData.object.sha;

      const { data: commitData } = await octokit.git.getCommit({
        owner,
        repo,
        commit_sha: commitSha,
      });
      treeSha = commitData.tree.sha;
    } catch (refErr) {
      if (refErr.status !== 404) {
        throw refErr;
      }

      const { data: repoData } = await octokit.repos.get({ owner, repo });

      if (repoData.size === 0) {
        // Empty repo — create first commit directly
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

        console.log(`DEBUG: Atomic initial commit: ${initialCommit.sha}`);
        return initialCommit.sha;
      }

      // Repo has content but the target branch is missing — create from default
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
      owner,
      repo,
      base_tree: treeSha,
      tree,
    });

    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo,
      message,
      tree: newTree.sha,
      parents: [commitSha],
    });

    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });

    console.log(`DEBUG: Atomic commit successful: ${newCommit.sha}`);
    return newCommit.sha;
  } catch (err) {
    console.error(`DEBUG: Atomic commit failed: ${err.message}`);
    throw err;
  }
}

// ─── Home-page preservation ───────────────────────────────────────────────────

/**
 * If `content/index.md` already exists in the repo, remove it from `filesMap`
 * so a re-apply of templates doesn't overwrite the user's home page.
 */
async function preserveHomePage(octokit, owner, repo, branch, filesMap) {
  const protectedPath = "content/index.md";
  if (!filesMap[protectedPath]) {
    return filesMap;
  }

  try {
    await octokit.repos.getContent({
      owner,
      repo,
      path: protectedPath,
      ref: branch,
    });
    console.log(
      `DEBUG: ${protectedPath} exists on ${owner}/${repo}@${branch}; preserving user content.`
    );
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

module.exports = {
  normalizePrivateKey,
  getOctokit,
  parseRepo,
  commitMultipleFiles,
  preserveHomePage,
};


