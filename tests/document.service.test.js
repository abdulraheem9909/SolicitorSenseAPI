jest.mock("@langchain/openai", () => {
  const embedQuery = jest.fn();
  const embedDocuments = jest.fn();
  return {
    ChatOpenAI: jest.fn(() => ({ invoke: jest.fn(async () => ({ content: "Mocked summary" })) })),
    OpenAIEmbeddings: jest.fn(() => ({ embedQuery, embedDocuments })),
    __embedQuery: embedQuery,
    __embedDocuments: embedDocuments,
  };
});
const { __embedQuery: embedQuery, __embedDocuments: embedDocuments } = require("@langchain/openai");

const {
  extractTextFromFile,
  isQueryAboutDocuments,
  createDocumentContext,
  isUKLegalDocument,
  findRelevantDocuments,
  extractKeyElements,
  queryWords,
  splitIntoChunks,
  embedDocumentChunks,
  WHOLE_DOCUMENT_CHARS,
} = require("../services/document.service");
const { UK_CONTRACT, RECIPE } = require("./fixtures");

const doc = (overrides = {}) => ({
  filename: "contract.txt",
  documentType: "uk_employment_contract",
  summary: "Employment contract for Jane Smith",
  extractedText: UK_CONTRACT,
  ...overrides,
});

describe("extractTextFromFile", () => {
  it("reads plain text files", async () => {
    const { text, metadata } = await extractTextFromFile(Buffer.from("hello"), "notes.TXT");
    expect(text).toBe("hello");
    expect(metadata.type).toBe("Text File");
  });

  it("throws for unsupported extensions", async () => {
    await expect(extractTextFromFile(Buffer.from("x"), "image.png")).rejects.toThrow(
      /Unsupported file type: png/
    );
  });

  it("wraps parser errors with the filename", async () => {
    await expect(
      extractTextFromFile(Buffer.from("definitely not a pdf"), "broken.pdf")
    ).rejects.toThrow(/Failed to extract text from broken.pdf/);
  });
});

describe("isUKLegalDocument", () => {
  it("accepts a UK employment contract", () => {
    const result = isUKLegalDocument(UK_CONTRACT, "contract.txt");
    expect(result.isRelevant).toBe(true);
    expect(result.hasStrongUKIndicator).toBe(true);
  });

  it("rejects unrelated text", () => {
    const result = isUKLegalDocument(RECIPE, "recipe.txt");
    expect(result.isRelevant).toBe(false);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });
});

describe("queryWords", () => {
  it("lowercases, strips punctuation and drops short words", () => {
    expect(queryWords("Is the notice clause lawful for an employee with 5 years service?")).toEqual([
      "notice", "clause", "lawful", "employee", "with", "years", "service",
    ]);
  });

  it("keeps letters with accents and digits", () => {
    expect(queryWords("Café pay rise of £2,000?")).toEqual(["café", "rise", "2000"]);
  });
});

describe("isQueryAboutDocuments", () => {
  it("matches words that end with punctuation", () => {
    const doc = { summary: "", extractedText: "Length of service determines the notice period." };
    // Before: "service?" and "length?" never matched (0 of 4). Now 2 of 4 match.
    expect(isQueryAboutDocuments("Pension contributions? Service? Length?", [doc])).toBe(true);
  });

  it("is false when there are no documents", () => {
    expect(isQueryAboutDocuments("what does this document say?", [])).toBe(false);
  });

  it("detects explicit references", () => {
    expect(isQueryAboutDocuments("Is this contract fair?", [doc()])).toBe(true);
  });

  it("detects heavy word overlap with the document", () => {
    expect(isQueryAboutDocuments("salary annual leave holiday entitlement", [doc()])).toBe(true);
  });

  it("is false for unrelated questions", () => {
    expect(isQueryAboutDocuments("What is the Human Rights Act?", [doc()])).toBe(false);
  });
});

describe("findRelevantDocuments", () => {
  it("ranks matching documents first and caps at 3", () => {
    const docs = [
      doc({ filename: "policy.txt", documentType: "uk_policy_document", extractedText: "pension scheme rules", summary: "" }),
      doc({ filename: "a.txt" }),
      doc({ filename: "b.txt" }),
      doc({ filename: "c.txt" }),
    ];
    const result = findRelevantDocuments(docs, "notice period salary");
    expect(result).toHaveLength(3);
    expect(result.map((d) => d.filename)).not.toContain("policy.txt");
  });
});

describe("extractKeyElements", () => {
  it("finds amounts and numbered clause headings", () => {
    expect(extractKeyElements(UK_CONTRACT)).toEqual([
      { type: "amounts", values: ["\u00a332,000"] },
      { type: "clauses", values: ["1. Salary", "2. Notice period", "3. Annual leave"] },
    ]);
  });

  it("still finds dates and section references", () => {
    expect(extractKeyElements("Signed 12 May 2024 under section 86 and clause 4.")).toEqual([
      { type: "dates", values: ["12 May 2024"] },
      { type: "sections", values: ["section 86", "clause 4"] },
    ]);
  });
});

describe("createDocumentContext", () => {
  it("returns null without documents", async () => {
    expect(await createDocumentContext([], "anything")).toBeNull();
  });

  it("includes an overview and the relevant document content", async () => {
    const context = await createDocumentContext([doc()], "notice period");
    expect(context).toContain("UPLOADED DOCUMENTS OVERVIEW");
    expect(context).toContain("contract.txt (uk_employment_contract)");
    expect(context).toContain("CONTENT FROM CONTRACT.TXT");
  });

  it("truncates documents that exceed the token budget", async () => {
    const huge = doc({ extractedText: `${UK_CONTRACT} ${"notice ".repeat(20000)}` });
    const context = await createDocumentContext([huge], "notice period", 2000);
    expect(context).toContain("(partial)");
    expect(context.length).toBeLessThan(8000);
  });
});

describe("long documents (#7)", () => {
  const paragraph = (label, n) => `${label} ${"word ".repeat(n)}`.trim();

  it("splits text into chunks of at most 1,000 characters without losing words", () => {
    const text = [paragraph("Intro", 300), paragraph("Notice", 120), paragraph("Pay", 50)].join("\n\n");
    const chunks = splitIntoChunks(text);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it("does not embed documents short enough to send whole", async () => {
    embedDocuments.mockClear();
    expect(await embedDocumentChunks(UK_CONTRACT)).toEqual([]);
    expect(embedDocuments).not.toHaveBeenCalled();
  });

  it("embeds each chunk of a long document once", async () => {
    embedDocuments.mockImplementationOnce(async (texts) => texts.map((_, i) => [i, 1]));
    const long = Array.from({ length: 30 }, (_, i) => paragraph(`Clause ${i + 1}.`, 150)).join("\n\n");
    expect(long.length).toBeGreaterThan(WHOLE_DOCUMENT_CHARS);

    const chunks = await embedDocumentChunks(long);

    expect(embedDocuments).toHaveBeenCalledTimes(1);
    expect(chunks.length).toBeGreaterThan(20);
    expect(chunks[0]).toEqual({ text: expect.stringContaining("Clause 1."), embedding: [0, 1] });
  });

  it("sends the most relevant sections of a long document instead of cutting it off", async () => {
    // 30 filler chunks pointing one way, one notice chunk pointing the way the question does
    const filler = Array.from({ length: 30 }, (_, i) => ({
      text: `Schedule ${i} filler ${"x".repeat(900)}`,
      embedding: [0, 1, i / 100],
    }));
    const notice = { text: "NOTICE CLAUSE: the employer will give 1 week notice regardless of service.", embedding: [1, 0, 0] };
    const chunks = [...filler.slice(0, 20), notice, ...filler.slice(20)];
    embedQuery.mockResolvedValueOnce([0.9, 0.1, 0]);

    const longDoc = doc({ extractedText: chunks.map((c) => c.text).join("\n\n"), chunks });
    const context = await createDocumentContext([longDoc], "Is the notice clause lawful?", 2000);

    expect(embedQuery).toHaveBeenCalledWith("Is the notice clause lawful?");
    expect(context).toContain("CONTENT FROM CONTRACT.TXT (most relevant sections)");
    expect(context).toContain("NOTICE CLAUSE");
    expect(context).not.toContain("(partial)");
    expect(context.length).toBeLessThan(8000);
  });

  it("still falls back to the start of the document for old uploads without chunks", async () => {
    const huge = doc({ extractedText: `${UK_CONTRACT} ${"notice ".repeat(20000)}` });
    const context = await createDocumentContext([huge], "notice period", 2000);
    expect(context).toContain("(partial)");
  });

  it("keeps short documents whole without any embedding call", async () => {
    embedQuery.mockClear();
    const context = await createDocumentContext([doc()], "notice period");
    expect(context).toContain("CONTENT FROM CONTRACT.TXT:\n");
    expect(embedQuery).not.toHaveBeenCalled();
  });
});
