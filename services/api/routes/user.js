const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { createDb } = require("../shared/db");
const config = require("../config");

const router = express.Router();
const db = createDb(config.DATABASE_URL);

// GET /api/user - Get authenticated user info
router.get("/user", authenticateToken, async (req, res) => {
  try {
    const user = await db("api_tokens")
      .join("users", "api_tokens.user_id", "users.id")
      .where("api_tokens.token", req.headers.authorization.replace(/^Bearer\s+/i, "").trim())
      .select("users.*")
      .first();

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      is_admin: user.is_admin,
    });
  } catch (err) {
    console.error("DEBUG: Error fetching user:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

module.exports = router;

