const jwt = require("jsonwebtoken");
const config = require("../config");

function verifyToken(token) {
  try {
    // Remove "Bearer " prefix if present
    const cleanToken = token.replace(/^Bearer\s+/i, "").trim();
    const decoded = jwt.verify(cleanToken, config.JWT_SECRET, { algorithms: ["HS256"] });
    return decoded;
  } catch (err) {
    console.error("DEBUG: Token verification failed:", err.message);
    return null;
  }
}

async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "No authorization header" });
  }

  const decoded = verifyToken(authHeader);

  if (!decoded) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // Attach user info to request
  req.user = decoded;
  next();
}

module.exports = {
  verifyToken,
  authenticateToken,
};

