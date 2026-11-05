const User = require("../models//user");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const client = new OAuth2Client();

const createSession = (user) => {
  const token = jwt.sign(
    { id: user._id, email: user.email },
    process.env.JWT_SECRET,
    {
      expiresIn: "1Y",
    }
  );

  return { token, email: user.email, name: user.name };
};

const signup = async ({ name, email, password }) => {
  const existingUser = await User.findOne({ email });
  if (existingUser) throw new Error("User already exists");

  const user = new User({ name, email, password });
  await user.save();
  return { message: "Signup successful", user: createSession(user) };
};

const login = async ({ email, password }) => {
  const user = await User.findOne({ email });
  if (!user) throw new Error("User not found");

  // Google-created accounts have no password
  if (!user.password) throw new Error("Invalid credentials");

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw new Error("Invalid credentials");

  return createSession(user);
};
const googleLogin = async (data) => {
  const { credential, clientId } = data;
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    const { email, given_name, family_name } = payload;

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        email,
        name: `${given_name} ${family_name}`,
      });
    }
    return createSession(user);
  } catch (err) {
    console.log("error which signin google server ", err);
    throw new Error("Google sign-in failed");
  }
};

module.exports = { signup, login, googleLogin };
