module.exports = {
  PORT: Number(process.env.API_PORT || 4000),
  DATABASE_URL: process.env.DATABASE_URL,
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
  GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
  JWT_SECRET: process.env.JWT_SECRET, // Required — no fallback; startup will throw if missing
  API_BODY_LIMIT: process.env.API_BODY_LIMIT || "50mb", // Increased from 100kb default to support large settings
};

