/**
 * HTML escape utility — prevents XSS in server-rendered HTML.
 * Use this for EVERY piece of user-controlled data inserted into HTML.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape a value for safe inline use in a JS string literal (single-quoted).
 * Use inside onclick="..." or <script> template interpolation.
 */
function escapeJs(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/<\/script>/gi, "<\\/script>");
}

module.exports = { escapeHtml, escapeJs };

