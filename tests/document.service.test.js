jest.mock("@langchain/openai", () => ({
  ChatOpenAI: jest.fn(() => ({ invoke: jest.fn(async () => ({ content: "Mocked summary" })) })),
  OpenAIEmbeddings: jest.fn(() => ({})),
}));

const {
  extractTextFromFile,
  isQueryAboutDocuments,
  createDocumentContext,
  isUKLegalDocument,
  findRelevantDocuments,
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

describe("isQueryAboutDocuments", () => {
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
