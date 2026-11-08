const { buildActRecords, buildKnowledgeBase } = require("../services/knowledgeBase");
const { SECTION_86_XML, fixtureFor } = require("./fixtures");

const ERA_URL = "https://www.legislation.gov.uk/ukpga/1996/18/data.xml";
const WTR_URL = "https://www.legislation.gov.uk/uksi/1998/1833/made/data.xml";

// A fake Pinecone namespace that remembers what was upserted
const fakeIndex = (existing = 0) => {
  const upserted = [];
  return {
    upserted,
    describeIndexStats: jest.fn(async () => ({ namespaces: { "legislation-v2": { recordCount: existing } } })),
    namespace: jest.fn(() => ({
      upsert: jest.fn(async (records) => upserted.push(...records)),
      deleteAll: jest.fn(async () => {}),
    })),
  };
};

const deps = (overrides = {}) => ({
  sources: [ERA_URL, WTR_URL],
  fetchXml: jest.fn(async (url) => fixtureFor(url)),
  embedTexts: jest.fn(async (texts) => texts.map((_, i) => [i, 0.5])),
  index: fakeIndex(),
  namespace: "legislation-v2",
  log: () => {},
  ...overrides,
});

describe("buildActRecords", () => {
  it("turns one Act's XML into labelled records with readable ids", async () => {
    const { title, records } = await buildActRecords(ERA_URL, SECTION_86_XML);

    expect(title).toBe("Employment Rights Act 1996");
    expect(records[0].id).toBe("EMP_1996_000");
    expect(records[0].metadata).toMatchObject({
      act_title: "Employment Rights Act 1996",
      legislation_type: "employment",
      legislation_year: 1996,
      provisions: "Section 86(1) to Section 86(2)",
      source: "https://www.legislation.gov.uk/ukpga/1996/18/data.pdf",
    });
    expect(records[0].metadata.text).toMatch(/^Employment Rights Act 1996\n\nAn Act to consolidate/);
  });
});

describe("title guard (#21)", () => {
  it("refuses XML that is a different Act from the one expected for the URL", async () => {
    // the bug: ukpga/1998/39 is the National Minimum Wage Act, not the Human Rights Act
    const wrong = SECTION_86_XML.replace("Employment Rights Act 1996", "National Minimum Wage Act 1998");
    await expect(buildActRecords(ERA_URL, wrong)).rejects.toThrow(/expected "Employment Rights Act 1996"/);
  });

  it("ignores harmless title differences such as 'The' and 'etc.'", async () => {
    const hswa = "https://www.legislation.gov.uk/ukpga/1974/37/data.xml";
    const official = SECTION_86_XML.replace("Employment Rights Act 1996", "Health and Safety at Work etc. Act 1974");
    await expect(buildActRecords(hswa, official)).resolves.toMatchObject({ title: "Health and Safety at Work etc. Act 1974" });
  });
});

describe("buildKnowledgeBase", () => {
  it("is a dry run by default: nothing is embedded or written", async () => {
    const d = deps();
    const result = await buildKnowledgeBase(d);

    expect(result).toMatchObject({ dryRun: true, acts: 2, records: 2 });
    expect(d.embedTexts).not.toHaveBeenCalled();
    expect(d.index.upserted).toEqual([]);
  });

  it("embeds and upserts every record into the chosen namespace", async () => {
    const d = deps({ dryRun: false });
    const result = await buildKnowledgeBase(d);

    expect(d.index.namespace).toHaveBeenCalledWith("legislation-v2");
    expect(d.index.upserted.map((r) => r.id)).toEqual(["EMP_1996_000", "EMP_1998_000"]);
    expect(d.index.upserted[0]).toMatchObject({ values: [0, 0.5], metadata: { act_title: "Employment Rights Act 1996" } });
    expect(result).toMatchObject({ dryRun: false, acts: 2, records: 2, upserted: 2 });
  });

  it("upserts in batches", async () => {
    const d = deps({ dryRun: false, batchSize: 1 });
    await buildKnowledgeBase(d);
    expect(d.embedTexts).toHaveBeenCalledTimes(2);
  });

  it("refuses to write into the default namespace used by the live site", async () => {
    await expect(buildKnowledgeBase(deps({ dryRun: false, namespace: "" }))).rejects.toThrow(/namespace/);
  });

  it("refuses a namespace that already has records unless replace is set", async () => {
    await expect(buildKnowledgeBase(deps({ dryRun: false, index: fakeIndex(1855) }))).rejects.toThrow(/already has 1855 records/);

    const d = deps({ dryRun: false, index: fakeIndex(1855), replace: true });
    await buildKnowledgeBase(d);
    expect(d.index.namespace.mock.results[0].value.deleteAll).toHaveBeenCalled();
  });

  it("reports a failed download and carries on with the other Acts", async () => {
    const d = deps({ fetchXml: jest.fn().mockRejectedValueOnce(new Error("timeout")).mockImplementation(async (url) => fixtureFor(url)) });
    const result = await buildKnowledgeBase(d);
    expect(result.acts).toBe(1);
    expect(result.errors).toEqual([expect.stringContaining("timeout")]);
  });
});
