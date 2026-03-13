/**
 * Helpers for commit messages, author anonymisation, and front-matter enrichment.
 */

const DECAP_COMMITTER = { name: "Decap CMS" };

/**
 * Returns an anonymous author object preserving the original commit date.
 * Committer is intentionally omitted so GitHub uses the GitHub App bot
 * identity — required to trigger Actions workflows.
 */
function buildAnonymousAuthor(originalAuthor) {
  return {
    name: DECAP_COMMITTER.name,
    email: "decap@users.noreply.github.com",
    date: (originalAuthor && originalAuthor.date) || new Date().toISOString(),
  };
}

/**
 * Strips PII from a Decap CMS commit message and falls back to a sensible
 * default derived from the file path and HTTP method.
 */
function getAnonymizedDecapCommitMessage(originalMessage, filePath = "", method = "") {
  const cleanedOriginal =
    typeof originalMessage === "string"
      ? originalMessage
          .replace(/\s+by\s+.+$/i, "")
          .replace(/\s*\([^)]*@[\w.-]+\)\s*$/i, "")
          .trim()
      : "";

  if (cleanedOriginal) return cleanedOriginal;

  const filename = (filePath || "").split("/").filter(Boolean).pop() || "content";
  const pageName = filename.replace(/\.[^.]+$/, "") || "content";
  const action = String(method || "").toUpperCase() === "DELETE" ? "Deleting" : "Updating";
  return `${action} Page: ${pageName}`;
}

/**
 * Ensures Chirpy-theme required front-matter fields are present / up-to-date
 * (layout, toc, date, last_modified_at, permalink).
 * Non-.md files are passed through unchanged.
 */
function enrichChirpyFrontMatter(content, filePath) {
  if (typeof content !== "string") return content;

  const normalizedPath = String(filePath || "").toLowerCase();
  if (!normalizedPath.endsWith(".md") && !normalizedPath.endsWith(".markdown")) {
    return content;
  }

  const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontMatterMatch) {
    const filename = String(filePath || "").split("/").filter(Boolean).pop() || "";
    const slug = filename.replace(/\.(md|markdown)$/i, "").trim();
    return `---
layout: page
toc: true
permalink: /${slug}/
date: ${new Date().toISOString()}
last_modified_at: ${new Date().toISOString()}
---

${content}`;
  }

  const nowIso = new Date().toISOString();
  const frontMatterRaw = frontMatterMatch[1];
  const hasLayout   = /^layout\s*:/m.test(frontMatterRaw);
  const hasDate     = /^date\s*:/m.test(frontMatterRaw);
  const hasUpdated  = /^last_modified_at\s*:/m.test(frontMatterRaw);
  const hasPermalink = /^permalink\s*:/m.test(frontMatterRaw);
  const hasToc      = /^toc\s*:/m.test(frontMatterRaw);

  const filename = String(filePath || "").split("/").filter(Boolean).pop() || "";
  const slug = filename.replace(/\.(md|markdown)$/i, "").trim();

  let updatedFrontMatter = frontMatterRaw;
  if (!hasLayout)   updatedFrontMatter += `\nlayout: page`;
  if (!hasToc)      updatedFrontMatter += `\ntoc: true`;
  if (!hasDate)     updatedFrontMatter += `\ndate: ${nowIso}`;

  if (hasUpdated) {
    updatedFrontMatter = updatedFrontMatter.replace(
      /^last_modified_at\s*:.*$/m,
      `last_modified_at: ${nowIso}`
    );
  } else {
    updatedFrontMatter += `\nlast_modified_at: ${nowIso}`;
  }

  if (!hasPermalink && slug) updatedFrontMatter += `\npermalink: /${slug}/`;

  return content.replace(
    /^---\n([\s\S]*?)\n---\n?/,
    `---\n${updatedFrontMatter}\n---\n`
  );
}

module.exports = {
  buildAnonymousAuthor,
  getAnonymizedDecapCommitMessage,
  enrichChirpyFrontMatter,
};

