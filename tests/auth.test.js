const request = require("supertest");
const jwt = require("jsonwebtoken");
const app = require("../app");
const User = require("../models/user");
const db = require("./helpers/db");
const { createUser } = require("./helpers/users");

jest.mock("google-auth-library", () => {
  const verifyIdToken = jest.fn();
  return {
    OAuth2Client: jest.fn(() => ({ verifyIdToken })),
    __verifyIdToken: verifyIdToken,
  };
});
const { __verifyIdToken: verifyIdToken } = require("google-auth-library");

beforeAll(db.connect);
afterEach(db.clear);
afterAll(db.close);

describe("POST /api/auth/signup", () => {
  const valid = { name: "Jane Smith", email: "jane@test.com", password: "secret123" };

  it("creates the user and returns a usable session", async () => {
    const res = await request(app).post("/api/auth/signup").send(valid);

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Signup successful");
    expect(res.body.user).toMatchObject({ email: valid.email, name: valid.name });

    const decoded = jwt.verify(res.body.user.token, process.env.JWT_SECRET);
    expect(decoded.email).toBe(valid.email);
  });

  it("stores a bcrypt hash, never the plain password", async () => {
    await request(app).post("/api/auth/signup").send(valid);
    const user = await User.findOne({ email: valid.email });
    expect(user.password).not.toBe(valid.password);
    expect(user.password).toMatch(/^\$2[aby]\$/);
  });

  it("rejects a duplicate email", async () => {
    await request(app).post("/api/auth/signup").send(valid);
    const res = await request(app).post("/api/auth/signup").send(valid);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("User already exists");
  });

  it.each([
    [{ ...valid, email: "not-an-email" }, "Email must be valid"],
    [{ ...valid, password: "123" }, "Password must be at least 6 characters"],
    [{ ...valid, name: "Jo" }, "Name should be at least 3 characters"],
    [{ email: valid.email, password: valid.password }, '"name" is required'],
  ])("rejects invalid input %#", async (body, error) => {
    const res = await request(app).post("/api/auth/signup").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
  });
});

describe("POST /api/auth/login", () => {
  it("returns a token for correct credentials", async () => {
    const user = await createUser({ email: "login@test.com" });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "login@test.com", password: "secret123" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: "login@test.com", name: user.name });
    expect(res.body.token).toEqual(expect.any(String));
  });

  it("rejects a wrong password", async () => {
    await createUser({ email: "login@test.com" });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "login@test.com", password: "wrong-password" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid credentials");
  });

  it("rejects an unknown email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@test.com", password: "secret123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("User not found");
  });

  it("rejects password login for a Google-only account", async () => {
    await User.create({ name: "Google User", email: "google@test.com" });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "google@test.com", password: "anything" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid credentials");
  });

  it("requires email and password", async () => {
    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/google-auth", () => {
  it("creates a user on first Google sign-in", async () => {
    verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ email: "g@test.com", given_name: "Grace", family_name: "Hopper" }),
    });

    const res = await request(app)
      .post("/api/auth/google-auth")
      .send({ credential: "id-token", clientId: "client-id" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: "g@test.com", name: "Grace Hopper" });
    expect(await User.countDocuments({ email: "g@test.com" })).toBe(1);
  });

  it("returns 400 when Google rejects the credential", async () => {
    verifyIdToken.mockRejectedValueOnce(new Error("Invalid token signature"));

    const res = await request(app)
      .post("/api/auth/google-auth")
      .send({ credential: "bad", clientId: "client-id" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Google sign-in failed");
  });
});

describe("auth middleware", () => {
  it("rejects requests with no token", async () => {
    const res = await request(app).get("/api/chat/list");
    expect(res.status).toBe(401);
  });

  it("rejects a malformed token", async () => {
    const res = await request(app)
      .get("/api/chat/list")
      .set("Authorization", "Bearer garbage");
    expect(res.status).toBe(403);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = jwt.sign({ id: "507f1f77bcf86cd799439011" }, "some-other-secret");
    const res = await request(app)
      .get("/api/chat/list")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("rejects a valid token for a deleted user", async () => {
    const user = await createUser();
    await User.deleteMany({});
    const res = await request(app)
      .get("/api/chat/list")
      .set("Authorization", `Bearer ${user.token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("User not found");
  });
});
