const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");
const config = require("../config");
const { normalizePrivateKey, parseRepo } = require("../utils/github");

let octokitInstance = null;

function getOctokit() {
  if (!octokitInstance) {
    const privateKey = normalizePrivateKey(config.GITHUB_APP_PRIVATE_KEY);

    octokitInstance = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.GITHUB_APP_ID,
        privateKey: privateKey,
        installationId: config.GITHUB_APP_INSTALLATION_ID,
      },
    });
  }

  return octokitInstance;
}

async function getDefaultBranch(owner, repo) {
  const octokit = getOctokit();
  const { data: repoData } = await octokit.repos.get({ owner, repo });
  return repoData.default_branch;
}

async function createOrUpdateFile(octokit, owner, repo, path, content, message, branch) {
  let sha;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref: branch });
    sha = data.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  return await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
    ...(sha && { sha }),
  });
}

async function commitMultipleFiles(octokit, owner, repo, branch, filesMap, message) {
  try {
    const tree = [];

    for (const [path, content] of Object.entries(filesMap)) {
      const blob = await octokit.git.createBlob({
        owner,
        repo,
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
      });
      tree.push({ path, mode: "100644", type: "blob", sha: blob.data.sha });
    }

    const { data: refData } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    const baseCommitSha = refData.object.sha;
    const { data: baseCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: baseCommitSha });
    const baseTreeSha = baseCommit.tree.sha;

    const { data: newTree } = await octokit.git.createTree({
      owner,
      repo,
      tree,
      base_tree: baseTreeSha,
    });

    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo,
      message,
      tree: newTree.sha,
      parents: [baseCommitSha],
    });

    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });

    console.log(`DEBUG: Committed ${Object.keys(filesMap).length} files to ${owner}/${repo}@${branch}`);
  } catch (err) {
    console.error(`DEBUG: Failed to commit files:`, err.message);
    throw err;
  }
}

async function preserveHomePage(octokit, owner, repo, branch, filesMap) {
  const protectedPath = "content/index.md";
  if (!filesMap[protectedPath]) {
    return filesMap;
  }

  try {
    await octokit.repos.getContent({ owner, repo, path: protectedPath, ref: branch });
    console.log(`DEBUG: ${protectedPath} already exists on ${owner}/${repo}@${branch}; preserving user content.`);
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
  getOctokit,
  getDefaultBranch,
  createOrUpdateFile,
  commitMultipleFiles,
  preserveHomePage,
  parseRepo,
};

