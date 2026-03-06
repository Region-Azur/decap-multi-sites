function normalizePrivateKey(key) {
  if (!key) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is required");
  }
  let normalized = key.replace(/\\n/g, "\n").trim();
  if (!normalized.includes("-----BEGIN")) {
    normalized = `-----BEGIN RSA PRIVATE KEY-----\n${normalized}\n-----END RSA PRIVATE KEY-----`;
  }
  return normalized;
}
function parseRepo(repoString) {
  const parts = repoString.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid repo format: ${repoString}. Expected owner/repo`);
  }
  // Trim whitespace from both owner and repo to fix issues with spaces
  return { 
    owner: parts[0].trim(), 
    repo: parts[1].trim() 
  };
}
module.exports = {
  normalizePrivateKey,
  parseRepo,
};
