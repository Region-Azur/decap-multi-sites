module.exports = {
  PORT: Number(process.env.PORTAL_PORT || 3000),
  DATABASE_URL: process.env.DATABASE_URL,
  ADMIN_EMAILS: (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
  DEFAULT_OIDC_ISSUER: process.env.OIDC_ISSUER || process.env.HITOBITO_OIDC_ISSUER || "",
  API_BASE_URL: process.env.API_BASE_URL || process.env.PORTAL_BASE_URL || "",
  USERINFO_URL_OVERRIDE:
    process.env.OIDC_USERINFO_URL || process.env.HITOBITO_USERINFO_URL || "",
};
