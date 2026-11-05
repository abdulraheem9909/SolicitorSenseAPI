// Unit tests for legalChat's routing decisions. All model calls are mocked.
jest.mock("@langchain/openai", () => ({
  ChatOpenAI: jest.fn(() => ({})),
  OpenAIEmbeddings: jest.fn(() => ({ embedQuery: jest.fn() })),
}));
jest.mock("langchain/chains", () => {
  const invoke = jest.fn(async () => ({ response: "Answer using the document" }));
  return { ConversationChain: jest.fn(() => ({ invoke })), __invoke: invoke };
});
jest.mock("../services/document.service", () => ({
  ...jest.requireActual("../services/document.service"),
  getSessionDocuments: jest.fn(),
}));

const { legalChat } = require("../services/chat.service");
const { getSessionDocuments } = require("../services/document.service");
const { __invoke: chainInvoke } = require("langchain/chains");
const { UK_CONTRACT } = require("./fixtures");

const storedContract = {
  id: "doc1",
  filename: "contract.txt",
  documentType: "uk_employment_contract",
  summary: "Employment contract for Jane Smith",
  extractedText: UK_CONTRACT,
};

let session = 0;
const baseArgs = () => ({
  sessionId: `test-session-${++session}`,
  pastMessages: [],
  userId: "user1",
  hasValidDocuments: false,
  irrelevantDocuments: [],
});

afterEach(() => jest.clearAllMocks());

describe("legalChat with rejected documents", () => {
  const irrelevant = [{ filename: "recipe.txt", reason: "not related to UK legal matters" }];

  it("returns the canned rejection when only irrelevant files were sent and no message was typed", async () => {
    const result = await legalChat({
      ...baseArgs(),
      userInput: "I received documents that don't appear to be related to UK legal matters.",
      irrelevantDocuments: irrelevant,
      userMessageProvided: false,
    });

    expect(result.text).toContain("recipe.txt");
    expect(result.text).toContain("don't appear to be related to UK legal matters");
    expect(getSessionDocuments).not.toHaveBeenCalled();
    expect(chainInvoke).not.toHaveBeenCalled();
  });

  it("returns the canned rejection when the user asks about 'this document'", async () => {
    const result = await legalChat({
      ...baseArgs(),
      userInput: "What does this document say?",
      irrelevantDocuments: irrelevant,
    });
    expect(result.text).toContain("recipe.txt");
    expect(chainInvoke).not.toHaveBeenCalled();
  });
});

describe("legalChat with uploaded documents", () => {
  it("uses the document context when files arrive with this message, even without referencing them", async () => {
    getSessionDocuments.mockResolvedValueOnce([storedContract]);

    const result = await legalChat({
      ...baseArgs(),
      userInput: "Is the notice period lawful for someone with 5 years service?",
      hasValidDocuments: true,
    });

    expect(chainInvoke).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: "Answer using the document",
      documentContext: true,
      sources: ["Uploaded: contract.txt"],
    });
  });

  it("uses the document context for a later question that references the document", async () => {
    getSessionDocuments.mockResolvedValueOnce([storedContract]);

    const result = await legalChat({
      ...baseArgs(),
      userInput: "Is the notice clause in this contract fair?",
    });

    expect(chainInvoke).toHaveBeenCalledTimes(1);
    expect(result.documentContext).toBe(true);
  });
});
