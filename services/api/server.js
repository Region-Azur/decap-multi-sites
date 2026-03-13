/**
 * API entry point.
 *
 * Responsibilities:
 *  - Boot-time validation (JWT_SECRET must be set)
 *  - Express app setup: body parser, security headers, rate limiting, CSRF
 *  - Mount route modules
 *  - Start the HTTP server + run DB migrations
 *
 * All business logic lives in the modules below — keep this file thin.
 */

const express = require("express");
const helmet = require("helmet");
const { ensureSchema } = require("./shared/db");
const config = require("./config");
const db = require("./db");
const { generalLimiter } = require("./middleware/rateLimiters");
const { requireUser } = require("./lib/auth");
const logger = require("./shared/logger");
const httpLogger = require("./shared/httpLogger");

// ─── Route modules ─────────────────────────────────────────────────────────────
const adminRouter = require("./routes/admin");
const contentRouter = require("./routes/content");
const githubProxyRouter = require("./routes/github-proxy");

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();

// Trust the first proxy (oauth2-proxy / nginx) so rate-limiters and IP-based
// logic read the real client IP from X-Forwarded-For.
app.set("trust proxy", 1);

// HTTP request logging middleware (should be first)
app.use(httpLogger);

// Security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "same-site" },
    contentSecurityPolicy: false, // CSP is set per-page in the portal; API returns JSON only
  })
);

// Global rate limiter — 300 req / min / IP
app.use(generalLimiter);

// JSON body parser
app.use(express.json({ limit: config.API_BODY_LIMIT }));

// ─── CSRF protection ──────────────────────────────────────────────────────────
// For state-changing requests that do NOT carry a Bearer token, verify that
// Origin/Referer matches the server's own host.  Bearer-token requests are
// inherently CSRF-safe because custom headers require a CORS pre-flight.
app.use((req, res, next) => {
  const safeMethods = ["GET", "HEAD", "OPTIONS"];
  if (safeMethods.includes(req.method)) return next();

  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return next();

  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  const host = req.headers.host || "";

  const allowed = origin ? origin.includes(host) : referer.includes(host);

  if (!allowed) {
    console.warn(
      `CSRF: rejected ${req.method} ${req.url} origin="${origin}" referer="${referer}"`
    );
    return res.status(403).json({ error: "Forbidden: CSRF check failed" });
  }
  next();
});

// ─── Shared router (handles /api prefix stripping & /.netlify/git aliases) ────

const router = express.Router();

// Health check
router.get("/health", (_req, res) => res.json({ status: "ok" }));

// Git Gateway / Decap CMS bootstrap endpoints
router.get("/settings", (_req, res) =>
  res.json({
    github_enabled: true,
    git_gateway: { roles: [] },
    api_root: "/.netlify/git",
  })
);

router.get("/user", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  res.json({ email: user.email, name: user.name, login: user.email, id: user.id });
});

// ─── Mount feature routers ────────────────────────────────────────────────────

router.use("/admin", adminRouter);
router.use("/sites", contentRouter);
router.use("/github", githubProxyRouter);

// ─── Path aliases ─────────────────────────────────────────────────────────────

app.use("/", router);
app.use("/api", router);
app.use("/.netlify/git", router);

// ─── Server bootstrap ─────────────────────────────────────────────────────────

(async () => {
  try {
    if (!config.JWT_SECRET) {
      throw new Error("JWT_SECRET environment variable must be set");
    }
    if (!config.GITHUB_APP_ID) {
      throw new Error("GITHUB_APP_ID environment variable must be set");
    }
    if (!config.GITHUB_APP_INSTALLATION_ID) {
      throw new Error("GITHUB_APP_INSTALLATION_ID environment variable must be set");
    }
    if (!config.GITHUB_APP_PRIVATE_KEY) {
      throw new Error("GITHUB_APP_PRIVATE_KEY environment variable must be set");
    }
    
    logger.info("API service starting...", {
      environment: process.env.NODE_ENV || 'development',
      debugLogging: logger.isDev(),
      port: config.PORT,
    });
    
    await ensureSchema(db);
    logger.debug("Database schema ensured");
    
    app.listen(config.PORT, () => {
      logger.success(`API listening on port ${config.PORT}`, {
        url: `http://localhost:${config.PORT}`,
      });
      logger.info("API service ready", {
        version: "4.0.0",
        timestamp: new Date().toISOString(),
      });
    });
  } catch (err) {
    logger.error("API startup failed", {
      error: err.message,
      stack: logger.isDev() ? err.stack : undefined,
    });
    process.exit(1);
  }
})();

