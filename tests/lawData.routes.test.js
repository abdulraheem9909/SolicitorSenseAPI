const fs = require("fs");
const request = require("supertest");
const axios = require("axios");
const app = require("../app");
const { fixtureFor } = require("./fixtures");

jest.mock("axios");

let written;
beforeEach(() => {
  axios.get.mockImplementation(async (url) => ({ data: fixtureFor(url) }));
  written = null;
  // the route saves uk_legislation_chunks.json; capture it instead of writing into the repo
  jest.spyOn(fs, "writeFileSync").mockImplementation((file, data) => {
    written = JSON.parse(data);
  });
});
afterEach(() => jest.restoreAllMocks());

describe("admin protection", () => {
  it("refuses requests without the admin key", async () => {
    const res = await request(app).get("/api/parseXML");
    expect(res.status).toBe(401);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("refuses a wrong admin key", async () => {
    const res = await request(app).get("/api/parseXML/stats").set("x-admin-key", "guess");
    expect(res.status).toBe(401);
  });

  it("is disabled when no admin key is configured", async () => {
    const saved = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    try {
      const res = await request(app).get("/api/parseXML").set("x-admin-key", "anything");
      expect(res.status).toBe(403);
    } finally {
      process.env.ADMIN_API_KEY = saved;
    }
  });
});

describe("GET /api/parseXML", () => {
  it("builds labelled chunks from the law body only", async () => {
    const res = await request(app).get("/api/parseXML").set("x-admin-key", "test-admin-key");
    expect(res.status).toBe(200);

    const employmentRights = written.find((c) => c.original_url.includes("ukpga/1996/18"));
    expect(employmentRights).toMatchObject({
      id: "EMP_1996_000",
      act_title: "Employment Rights Act 1996",
      section_context: "Rights of employer and employee to minimum notice.",
      provisions: "Section 86(1) to Section 86(2)",
    });
    expect(employmentRights.text).toContain("[Section 86(1)(b)] is not less than one week’s notice for each year");
    expect(employmentRights.text).toContain("given by an employee who has been");
    expect(employmentRights.text).not.toMatch(/Predictable Terms|omitted/);
  });

  it("returns a summary computed from the real record fields", async () => {
    const res = await request(app).get("/api/parseXML").set("x-admin-key", "test-admin-key");
    const { summary } = res.body;

    expect(summary.processed).toBe(9);
    expect(summary.total_chunks).toBe(written.length);
    expect(summary.average_length).toBeGreaterThan(100);
    expect(summary.legislation_types).toEqual(
      expect.arrayContaining(["employment", "human_rights", "equality", "criminal", "health_safety"])
    );
    expect(summary.legislation_types).not.toContain(null);
    expect(summary.years_covered).toEqual([1974, 1996, 1998, 1999, 2002, 2009, 2010]);
    expect(summary.sections_covered).toBe(1);
    expect(res.body.sample_chunk).toMatch(/^Employment Rights Act 1996/);
  });

  it("records a failed download without stopping the other Acts", async () => {
    axios.get.mockRejectedValueOnce(new Error("timeout"));
    const res = await request(app).get("/api/parseXML").set("x-admin-key", "test-admin-key");
    expect(res.body.summary.processed).toBe(8);
    expect(res.body.summary.errors).toEqual([expect.stringContaining("timeout")]);
  });
});
