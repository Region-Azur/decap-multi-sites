/**
 * Shared rate-limiter instances.
 *
 * Import these in any route file that needs throttling instead of
 * re-declaring them in index.js.
 */

const rateLimit = require("express-rate-limit");

/** 300 req / min / IP — applied globally */
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

/** 30 req / min / IP — applied to admin write endpoints */
const adminWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests, please slow down." },
});

module.exports = { generalLimiter, adminWriteLimiter };

