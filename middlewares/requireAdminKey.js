const crypto = require("crypto");

// Guards admin-only routes (the legislation import). Callers send the key in the
// "x-admin-key" header. With no ADMIN_API_KEY configured, the routes are disabled.
const requireAdminKey = (req, res, next) => {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return res.status(403).json({ error: "Admin routes are disabled" });
  }

  const given = req.get("x-admin-key") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // constant-time comparison, so the key cannot be guessed from response timing
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid admin key" });
  }

  next();
};

module.exports = requireAdminKey;
