const {
  parseLegislationXml,
  getActTitles,
  extractLegalPieces,
  createCoherentChunks,
  formatContentWithContext,
  processLegalText,
  generateCleanId,
  getLegislationInfo,
  LEGISLATION_SOURCES,
} = require("../services/legislationParser");

const { SECTION_86_XML } = require("./fixtures");

describe("parseLegislationXml + extractLegalPieces", () => {
  let pieces;
  beforeAll(async () => {
    const parsed = await parseLegislationXml(SECTION_86_XML);
    pieces = extractLegalPieces(parsed);
  });

  it("keeps only the law body: no metadata or commentary text", () => {
    const all = pieces.map((p) => p.content).join(" ");
    expect(all).not.toMatch(/Predictable Terms/);
    expect(all).not.toMatch(/omitted/);
    expect(all).not.toMatch(/consolidate enactments/); // long title is handled separately
  });

  it("keeps text around inline elements in document order", () => {
    const employeePiece = pieces.find((p) => p.content.includes("given by an employee"));
    expect(employeePiece.content).toBe(
      "The notice required to be given by an employee who has been continuously employed for one month or more is not less than one week."
    );
  });

  it("records the provision number of every piece", () => {
    expect(pieces.map((p) => p.context.provision)).toEqual([
      "Section 86(1)",
      "Section 86(1)(a)",
      "Section 86(1)(b)",
      "Section 86(2)",
    ]);
  });

  it("uses the nearest title as the section name and never emits titles as pieces", () => {
    expect(pieces.every((p) => p.context.section === "Rights of employer and employee to minimum notice.")).toBe(true);
    expect(pieces.some((p) => p.content === "Rights of employer and employee to minimum notice.")).toBe(false);
  });

  it("labels secondary legislation provisions as regulations", async () => {
    const parsed = await parseLegislationXml(
      "<Legislation><Secondary><Body><P1group><Title>Entitlement to annual leave</Title><P1><Pnumber>13</Pnumber><P1para><Text>A worker is entitled to four weeks’ annual leave in each leave year.</Text></P1para></P1></P1group></Body></Secondary></Legislation>"
    );
    expect(extractLegalPieces(parsed)[0].context.provision).toBe("Regulation 13");
  });
});

describe("getActTitles", () => {
  it("reads the title and long title from the prelims", async () => {
    const parsed = await parseLegislationXml(SECTION_86_XML);
    expect(getActTitles(parsed)).toEqual({
      title: "Employment Rights Act 1996",
      longTitle: "An Act to consolidate enactments relating to employment rights.",
    });
  });
});

describe("formatContentWithContext", () => {
  it("prefixes the provision and section name once", () => {
    expect(
      formatContentWithContext({
        content: "is not less than one week’s notice ...",
        context: { section: "Rights of employer and employee to minimum notice.", provision: "Section 86(1)(b)" },
      })
    ).toBe("[Section 86(1)(b), Rights of employer and employee to minimum notice.] is not less than one week’s notice ...");
  });

  it("adds no prefix when there is no context", () => {
    expect(formatContentWithContext({ content: "Text", context: {} })).toBe("Text");
  });
});

describe("createCoherentChunks", () => {
  const piece = (n, len) => ({ content: "x".repeat(len), context: { section: "S", provision: `Section ${n}` } });

  it("never splits a piece and keeps chunks within the limit", () => {
    const chunks = createCoherentChunks([piece(1, 500), piece(2, 500), piece(3, 500)], 1200);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.text.length <= 1200)).toBe(true);
  });

  it("repeats the section name only when it changes within a chunk", () => {
    const [chunk] = createCoherentChunks([
      { content: "First.", context: { section: "Notice", provision: "Section 86(1)" } },
      { content: "Second.", context: { section: "Notice", provision: "Section 86(2)" } },
      { content: "Third.", context: { section: "Pay", provision: "Section 88(1)" } },
    ]);
    expect(chunk.text).toBe(
      "[Section 86(1), Notice] First.\n\n[Section 86(2)] Second.\n\n[Section 88(1), Pay] Third."
    );
  });

  it("records the first and last provision of each chunk", () => {
    const chunks = createCoherentChunks([piece(1, 500), piece(2, 500), piece(3, 500)], 1200);
    expect(chunks.map((c) => c.provisions)).toEqual([
      ["Section 1", "Section 2"],
      ["Section 3"],
    ]);
  });
});

describe("processLegalText", () => {
  it("normalises spacing and section references", () => {
    expect(processLegalText("Section   86 ( 1 )  The notice required .Under section 86")).toBe(
      "Section 86 (1) The notice required. Under Section 86"
    );
  });
});

describe("generateCleanId and getLegislationInfo", () => {
  it("builds readable ids", () => {
    expect(generateCleanId({ type: "employment", year: 1996 }, 97)).toBe("EMP_1996_097");
    expect(generateCleanId({ type: "unknown", year: null }, 1)).toBe("LEG_0000_001");
  });

  it("looks the Act up from its URL", () => {
    expect(getLegislationInfo("https://www.legislation.gov.uk/ukpga/1996/18/data.xml")).toEqual({
      title: "Employment Rights Act 1996",
      type: "employment",
      year: 1996,
    });
  });
});

describe("LEGISLATION_SOURCES (#21)", () => {
  it("points at the intended Acts", () => {
    const titles = LEGISLATION_SOURCES.map((url) => getLegislationInfo(url).title);
    expect(titles).toEqual(expect.arrayContaining(["Human Rights Act 1998", "Coroners and Justice Act 2009", "National Minimum Wage Act 1998"]));
    expect(LEGISLATION_SOURCES).toContain("https://www.legislation.gov.uk/ukpga/1998/42/data.xml");
    expect(LEGISLATION_SOURCES).toContain("https://www.legislation.gov.uk/ukpga/2009/25/data.xml");
    expect(titles).not.toContain("Unknown Legislation");
  });

  it("gives every Act a distinct id prefix, so no Act overwrites another", () => {
    const prefixes = LEGISLATION_SOURCES.map((url) => generateCleanId(getLegislationInfo(url), 0));
    expect(new Set(prefixes).size).toBe(LEGISLATION_SOURCES.length);
    expect(generateCleanId(getLegislationInfo("https://www.legislation.gov.uk/ukpga/1998/39/data.xml"), 5)).toBe("NMW_1998_005");
  });
});
