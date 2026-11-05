const express = require("express");
const router = express.Router();
const authService = require("../services/auth.service");
const { signupSchema, loginSchema } = require("../services/authValidation");

// Signup route
router.post("/signup", async (req, res) => {
  const { error } = signupSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  try {
    const response = await authService.signup(req.body);
    res.status(201).json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login route
router.post("/login", async (req, res) => {
  const { error } = loginSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  try {
    const response = await authService.login(req.body);
    res.json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/google-auth", async (req, res) => {
  try {
    const response = await authService.googleLogin(req.body);
    res.json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
