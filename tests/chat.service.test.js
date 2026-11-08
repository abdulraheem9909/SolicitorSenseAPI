// Unit tests for legalChat's routing and the search helpers. All model and Pinecone calls are mocked.
jest.mock("@langchain/openai", () => {
  const embedDocuments = jest.fn(async (texts) => texts.map((_, i) => [i + 0.1, i + 0.2]));
  return {
    ChatOpenAI: jest.fn(() => ({})),
    OpenAIEmbeddings: jest.fn(() => ({ embedDocuments })),
    __embedDocuments: embedDocuments,
  };
});
jest.mock("@pinecone-database/pinecone", () => {
  const query = jest.fn();
  return { Pinecone: jest.fn(() => ({ Index: () => ({ query }) })), __query: query };
});
jest.mock("langchain/chains", () => {
  const invoke = jest.fn(async () => ({ response: "Answer using the document" }));
  return { ConversationChain: jest.fn(() => ({ invoke })), __invoke: invoke };
});
jest.mock("langchain/chains/combine_documents", () => {
  const invoke = jest.fn(async () => "RAG answer");
  return { createStuffDocumentsChain: jest.fn(async () => ({ invoke })), __invoke: invoke };
});
jest.mock("../services/document.service", () => ({
  ...jest.requireActual("../services/document.service"),
  getSessionDocuments: jest.fn(async () => []),
}));

const { HumanMessage, AIMessage } = require("@langchain/core/messages");
const {
  legalChat,
  categorizeQuery,
  enhanceUKLegalQuery,
  performIntelligentSearch,
  mergeSearchResults,
  selectStrongMatches,
  formatLegislationSources,
} = require("../services/chat.service");
const { getSessionDocuments } = require("../services/document.service");
const { ConversationChain, __invoke: chainInvoke } = require("langchain/chains");
const { createStuffDocumentsChain } = require("langchain/chains/combine_documents");
const { __embedDocuments: embedDocuments } = require("@langchain/openai");
const { __query: pineconeQuery } = require("@pinecone-database/pinecone");
const { UK_CONTRACT } = require("./fixtures");

const lawChunk = (id, text, extra = {}) => ({
  id,
  metadata: {
    text,
    act_title: "Employment Rights Act 1996",
    legislation_type: "employment",
    legislation_year: 1996,
    section_context: "Rights of employer and employee to minimum notice.",
    ...extra,
  },
});
const s86 = lawChunk(
  "EMP_1996_097",
  "[Section 86(1)(b)] is not less than one week’s notice for each year of continuous employment",
  { provisions: "Section 86(1) to Section 86(2)" }
);

// every Pinecone query returns the same matches with this score
const pineconeReturns = (score, matches = [s86]) =>
  pineconeQuery.mockResolvedValue({ matches: matches.map((m) => ({ ...m, score })) });

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

beforeEach(() => {
  jest.clearAllMocks();
  getSessionDocuments.mockResolvedValue([]);
  pineconeReturns(0.2);
});

describe("mergeSearchResults", () => {
  const doc = (id) => ({ metadata: { id } });

  it("keeps each chunk's highest score, not the first one seen", () => {
    // real scores from the walkthrough: raw search first, expanded search second
    const merged = mergeSearchResults([
      { documents: [doc("EMP_1996_097"), doc("EMP_1996_098")], scores: [0.592, 0.558] },
      { documents: [doc("EMP_1996_099"), doc("EMP_1996_098"), doc("EMP_1996_097")], scores: [0.692, 0.659, 0.655] },
    ]);
    expect(merged.map((r) => [r.doc.metadata.id, r.score])).toEqual([
      ["EMP_1996_099", 0.692],
      ["EMP_1996_098", 0.659],
      ["EMP_1996_097", 0.655],
    ]);
  });

  it("returns at most the limit, highest first", () => {
    const docs = [1, 2, 3, 4, 5, 6].map((n) => doc(`c${n}`));
    const merged = mergeSearchResults([{ documents: docs, scores: [0.1, 0.6, 0.3, 0.5, 0.2, 0.4] }]);
    expect(merged.map((r) => r.score)).toEqual([0.6, 0.5, 0.4, 0.3, 0.2]);
  });
});

describe("selectStrongMatches", () => {
  const result = (score, type = "employment") => ({ score, doc: { metadata: { legislation_type: type } } });

  it("keeps matches scoring 0.65 or more", () => {
    const { strongMatches, threshold, bestScore } = selectStrongMatches([result(0.687), result(0.649), result(0.4)]);
    expect(threshold).toBe(0.65);
    expect(strongMatches.map((r) => r.score)).toEqual([0.687]);
    expect(bestScore).toBe(0.687);
  });
});

describe("enhanceUKLegalQuery", () => {
  it("expands wordings the old exact-phrase list missed", () => {
    expect(enhanceUKLegalQuery("Is the notice clause lawful for an employee with 5 years service?")).toContain("Section 86");
    expect(enhanceUKLegalQuery("What is the minimum holiday entitlement in the UK?")).toContain("Working Time Regulations 1998");
    expect(enhanceUKLegalQuery("I was sacked without warning")).toContain("unfair dismissal");
  });

  it("only adds employment notice law when the question is about work", () => {
    expect(enhanceUKLegalQuery("Can my landlord evict me without notice?")).not.toContain("Section 86");
    expect(enhanceUKLegalQuery("How much notice must I give to resign?")).toContain("Section 86");
  });

  it("always adds the general UK law context", () => {
    expect(enhanceUKLegalQuery("hello")).toBe("hello UK law legal statute regulation Act");
  });
});

describe("performIntelligentSearch", () => {
  it("embeds the question and its expansion in ONE call and reuses the vectors", async () => {
    await performIntelligentSearch("Can my employer cut my working hours?");

    expect(embedDocuments).toHaveBeenCalledTimes(1);
    const [texts] = embedDocuments.mock.calls[0];
    expect(texts[0]).toBe("Can my employer cut my working hours?");
    expect(texts[1]).toContain("Working Time Regulations 1998");

    // raw + expanded + employment filter, filtered search reuses the raw vector
    expect(pineconeQuery).toHaveBeenCalledTimes(3);
    const [raw, expanded, filtered] = pineconeQuery.mock.calls.map(([params]) => params);
    expect(raw.vector).toEqual([0.1, 0.2]);
    expect(expanded.vector).toEqual([1.1, 1.2]);
    expect(filtered).toMatchObject({ vector: [0.1, 0.2], filter: { legislation_type: "employment" } });
  });
});

describe("formatLegislationSources", () => {
  it("includes provisions when the record has them", () => {
    expect(formatLegislationSources([{ metadata: s86.metadata }])).toEqual([
      "Employment Rights Act 1996 (1996) - Section 86(1) to Section 86(2), Rights of employer and employee to minimum notice.",
    ]);
  });

  it("still works for records built before provisions existed", () => {
    const { provisions, ...old } = s86.metadata;
    expect(formatLegislationSources([{ metadata: old }])).toEqual([
      "Employment Rights Act 1996 (1996) - Rights of employer and employee to minimum notice.",
    ]);
  });
});

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
    expect(getSessionDocuments).not.toHaveBeenCalled();
    expect(pineconeQuery).not.toHaveBeenCalled();
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
  it("answers from the document AND the matching law, citing both", async () => {
    getSessionDocuments.mockResolvedValueOnce([storedContract]);
    pineconeReturns(0.69);

    const result = await legalChat({
      ...baseArgs(),
      userInput: "Is the notice period lawful for someone with 5 years service?",
      hasValidDocuments: true,
    });

    expect(chainInvoke).toHaveBeenCalledTimes(1);
    const { prompt } = ConversationChain.mock.calls[0][0];
    expect(prompt.partialVariables.document_context).toContain("CONTENT FROM CONTRACT.TXT");
    expect(prompt.partialVariables.legal_context).toContain("one week’s notice for each year");
    expect(result).toMatchObject({
      text: "Answer using the document",
      documentContext: true,
      matchedChunks: 1,
      sources: [
        "Uploaded: contract.txt",
        "Employment Rights Act 1996 (1996) - Section 86(1) to Section 86(2), Rights of employer and employee to minimum notice.",
      ],
    });
  });

  it("says no provisions were found when the law search is weak", async () => {
    getSessionDocuments.mockResolvedValueOnce([storedContract]);
    pineconeReturns(0.3);

    const result = await legalChat({ ...baseArgs(), userInput: "Is this contract fair?", hasValidDocuments: true });

    const { prompt } = ConversationChain.mock.calls[0][0];
    expect(prompt.partialVariables.legal_context).toMatch(/No specific provisions were retrieved/);
    expect(result.sources).toEqual(["Uploaded: contract.txt"]);
  });

  it("does not crash on a document that contains curly braces", async () => {
    getSessionDocuments.mockResolvedValueOnce([
      { ...storedContract, extractedText: `${UK_CONTRACT}\nClause 5: bonus = {base salary} x 10%` },
    ]);

    await legalChat({ ...baseArgs(), userInput: "Is the bonus clause fair?", hasValidDocuments: true });

    const { prompt } = ConversationChain.mock.calls[0][0];
    const messages = await prompt.formatMessages({ input: "Is the bonus clause fair?", chat_history: [] });
    expect(messages.at(-1).content).toContain("{base salary}");
  });
});

describe("legalChat without documents", () => {
  it("uses RAG with sources when a match clears the threshold", async () => {
    pineconeReturns(0.75);

    const result = await legalChat({ ...baseArgs(), userInput: "What is the minimum notice period?" });

    expect(createStuffDocumentsChain).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: "RAG answer",
      confidence: "high",
      sources: [
        "Employment Rights Act 1996 (1996) - Section 86(1) to Section 86(2), Rights of employer and employee to minimum notice.",
      ],
    });
  });

  it("falls back to a general answer with no sources when nothing is strong", async () => {
    pineconeReturns(0.4);

    const result = await legalChat({ ...baseArgs(), userInput: "What is the best chocolate cake recipe?" });

    expect(createStuffDocumentsChain).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fallback: true, sources: [] });
    const { prompt } = ConversationChain.mock.calls[0][0];
    await expect(prompt.formatMessages({ input: "x", chat_history: [] })).resolves.toBeDefined();
  });
});

describe("chat history (#14, #15)", () => {
  const earlier = () => [new HumanMessage("Earlier question"), new AIMessage("Earlier answer")];
  const historyOf = async (memory) => (await memory.chatHistory.getMessages()).map((m) => m.content);

  it("gives the model exactly the database history on every request, with no duplicates", async () => {
    getSessionDocuments.mockResolvedValue([storedContract]);
    const args = { ...baseArgs(), hasValidDocuments: true };

    await legalChat({ ...args, userInput: "First question about this contract" });
    await legalChat({ ...args, userInput: "Second question about this contract", pastMessages: earlier() });

    const secondMemory = ConversationChain.mock.calls[1][0].memory;
    expect(await historyOf(secondMemory)).toEqual(["Earlier question", "Earlier answer"]);
  });

  it("passes the database history to the RAG chain", async () => {
    pineconeReturns(0.75);
    const { __invoke: ragInvoke } = require("langchain/chains/combine_documents");

    await legalChat({ ...baseArgs(), userInput: "What is the minimum notice period?", pastMessages: earlier() });

    expect(ragInvoke.mock.calls[0][0].chat_history.map((m) => m.content)).toEqual(["Earlier question", "Earlier answer"]);
  });
});

describe("response fields (#17, #18)", () => {
  it("document route: documentContext true and the document count", async () => {
    getSessionDocuments.mockResolvedValueOnce([storedContract]);
    const result = await legalChat({ ...baseArgs(), userInput: "Is this contract fair?", hasValidDocuments: true });
    expect(result).toMatchObject({ documentContext: true, sessionHasDocuments: true, documentsAvailable: 1 });
  });

  it("RAG and fallback routes: documentContext false even when the chat has a document", async () => {
    getSessionDocuments.mockResolvedValue([storedContract]);

    pineconeReturns(0.75);
    const rag = await legalChat({ ...baseArgs(), userInput: "Can I be sacked for being pregnant?" });
    pineconeReturns(0.3);
    const fallback = await legalChat({ ...baseArgs(), userInput: "What is the best chocolate cake recipe?" });

    for (const result of [rag, fallback]) {
      expect(result).toMatchObject({ documentContext: false, sessionHasDocuments: true, documentsAvailable: 1 });
    }
  });
});

describe("categorizeQuery (#16)", () => {
  it.each([
    ["My manager shouted at me in a meeting", "employment law"],
    ["Which page of the form do I sign?", "general UK law"],
    ["Can I take my neighbour to court over a fence?", "general civil law"],
    ["Is age discrimination illegal?", "equality and discrimination law"],
    ["I was sacked yesterday", "employment law"],
    ["Is the agency allowed to do this?", "general UK law"],
    ["What is the sentence for theft?", "criminal law"],
  ])("%s -> %s", (query, category) => {
    expect(categorizeQuery(query)).toBe(category);
  });
});
