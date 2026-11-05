const request = require("supertest");
const app = require("../../app");

let counter = 0;

// Signs up a fresh user and returns { token, email, name }
const createUser = async (overrides = {}) => {
  counter += 1;
  const body = {
    name: "Test User",
    email: `user${counter}_${Date.now()}@test.com`,
    password: "secret123",
    ...overrides,
  };
  const res = await request(app).post("/api/auth/signup").send(body);
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return res.body.user;
};

module.exports = { createUser };
