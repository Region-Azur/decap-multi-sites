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

// ─── Route modules ─────────────────────────────────────────────────────────────
const adminRouter = require("./routes/admin");
const contentRouter = require("./routes/content");
const githubProxyRouter = require("./routes/github-proxy");

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();

// Trust the first proxy (oauth2-proxy / nginx) so rate-limiters and IP-based
// logic read the real client IP from X-Forwarded-For.
app.set("trust proxy", 1);

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
  if (!config.JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable must be set");
  }
  await ensureSchema(db);
  app.listen(config.PORT, () => {
    console.log(`API listening on ${config.PORT}`);
    console.log("API Service v4 (Modular)");
  });
})();

