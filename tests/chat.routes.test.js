const request = require("supertest");
const app = require("../app");
const Message = require("../models/chat");
const UploadedDocument = require("../models/uploadDocument");
const db = require("./helpers/db");
const { createUser } = require("./helpers/users");
const { UK_CONTRACT, RECIPE } = require("./fixtures");

// The LLM/RAG pipeline is tested separately; here we only check the HTTP layer.
jest.mock("../services/chat.service", () => ({
  legalChat: jest.fn(async () => ({ text: "Mocked legal answer", sources: ["ERA 1996"] })),
}));
// document.service asks GPT-4o for a summary of each upload
jest.mock("@langchain/openai", () => ({
  ChatOpenAI: jest.fn(() => ({ invoke: jest.fn(async () => ({ content: "Mocked summary" })) })),
  OpenAIEmbeddings: jest.fn(() => ({
    // chunk i points at [i, 1, 0]; the question points at chunk 38
    embedDocuments: jest.fn(async (texts) => texts.map((_, i) => [i, 1, 0])),
    embedQuery: jest.fn(async () => [38, 1, 0]),
  })),
}));
const { legalChat } = require("../services/chat.service");

beforeAll(db.connect);
afterEach(async () => {
  await db.clear();
  jest.clearAllMocks();
});
afterAll(db.close);

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const sendMessage = (token, { msg, sessionId, files = [] } = {}) => {
  const req = request(app).post("/api/chat").set(auth(token));
  if (msg !== undefined) req.field("msg", msg);
  if (sessionId) req.field("sessionId", sessionId);
  for (const [name, content] of files) req.attach("documents", Buffer.from(content), name);
  return req;
};

describe("POST /api/chat", () => {
  let user;
  beforeEach(async () => {
    user = await createUser();
  });

  it("requires authentication", async () => {
    const res = await request(app).post("/api/chat").field("msg", "hello");
    expect(res.status).toBe(401);
  });

  it("rejects a request with no message and no files", async () => {
    const res = await sendMessage(user.token, { msg: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("No input provided");
    expect(legalChat).not.toHaveBeenCalled();
  });

  it("starts a new session and saves both messages", async () => {
    const res = await sendMessage(user.token, { msg: "What is unfair dismissal?" });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toEqual(expect.any(String));
    expect(res.body.userMessage).toMatchObject({ type: "Human", msg: "What is unfair dismissal?" });
    expect(res.body.aiMessage).toMatchObject({ type: "AI", msg: "Mocked legal answer" });

    const stored = await Message.find({ sessionId: res.body.sessionId }).sort({ createdAt: 1 });
    expect(stored.map((m) => m.type)).toEqual(["Human", "AI"]);
  });

  it("passes earlier messages of the same session to the model", async () => {
    const first = await sendMessage(user.token, { msg: "First question" });
    await sendMessage(user.token, { msg: "Follow-up", sessionId: first.body.sessionId });

    const secondCall = legalChat.mock.calls[1][0];
    expect(secondCall.sessionId).toBe(first.body.sessionId);
    expect(secondCall.pastMessages.map((m) => m.content)).toEqual([
      "First question",
      "Mocked legal answer",
    ]);
  });

  it("processes a UK legal document and stores it for the session", async () => {
    const res = await sendMessage(user.token, { files: [["contract.txt", UK_CONTRACT]] });

    expect(res.status).toBe(201);
    expect(res.body.uploadResults).toEqual([
      expect.objectContaining({
        filename: "contract.txt",
        processed: true,
        irrelevant: false,
        documentType: "uk_employment_contract",
      }),
    ]);
    expect(res.body.userMessage).toMatchObject({ hasDocuments: true, processedCount: 1 });
    expect(legalChat.mock.calls[0][0]).toMatchObject({
      hasValidDocuments: true,
      userMessageProvided: false,
    });

    const docs = await UploadedDocument.find({ sessionId: res.body.sessionId });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ originalFilename: "contract.txt", summary: "Mocked summary" });
  });

  it("stores embedded chunks for a long document (#7)", async () => {
    const longContract = Array.from({ length: 40 }, (_, i) => `${i + 1}. Clause ${i + 1}: ${UK_CONTRACT}`).join("\n\n");
    expect(longContract.length).toBeGreaterThan(20000);

    const res = await sendMessage(user.token, { files: [["long_contract.txt", longContract]] });

    expect(res.status).toBe(201);
    const [stored] = await UploadedDocument.find({ sessionId: res.body.sessionId });
    expect(stored.chunks.length).toBeGreaterThan(20);
    expect(stored.chunks.every((c) => c.text.length <= 1000 && c.embedding.length === 3)).toBe(true);
  });

  it("retrieves the relevant sections of a long document loaded back from MongoDB (#7)", async () => {
    const { getSessionDocuments, createDocumentContext } = jest.requireActual("../services/document.service");
    const longContract = Array.from({ length: 40 }, (_, i) => `${i + 1}. Clause ${i + 1}: ${UK_CONTRACT}`).join("\n\n");
    const res = await sendMessage(user.token, { files: [["long_contract.txt", longContract]] });

    const docs = await getSessionDocuments(res.body.sessionId, user.id || (await require("../models/user").findOne({ email: user.email }))._id.toString());
    const context = await createDocumentContext(docs, "Is the notice clause lawful?", 2000);

    expect(context).toContain("(most relevant sections)");
    expect(context).not.toContain("(partial)");
  });

  it("stores no chunks for a short document", async () => {
    const res = await sendMessage(user.token, { files: [["contract.txt", UK_CONTRACT]] });
    const [stored] = await UploadedDocument.find({ sessionId: res.body.sessionId });
    expect(stored.chunks).toEqual([]);
  });

  it("flags a non-legal document as irrelevant without storing it", async () => {
    const res = await sendMessage(user.token, { files: [["recipe.txt", RECIPE]] });

    expect(res.status).toBe(201);
    expect(res.body.uploadResults[0]).toMatchObject({ processed: false, irrelevant: true });
    expect(res.body.irrelevantDocuments).toBe(1);
    expect(legalChat.mock.calls[0][0].irrelevantDocuments).toHaveLength(1);
    expect(await UploadedDocument.countDocuments()).toBe(0);
  });

  it("returns 400 when the only document fails to process and there is no message", async () => {
    const res = await sendMessage(user.token, { files: [["empty.txt", "too short"]] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Document processing failed");
  });

  it("still answers the message when an attached document fails to process", async () => {
    const res = await sendMessage(user.token, {
      msg: "Check this",
      files: [["empty.txt", "too short"]],
    });
    expect(res.status).toBe(201);
    expect(res.body.technicalErrors).toBe(1);
  });

  it("rejects unsupported file types with a JSON error", async () => {
    const res = await sendMessage(user.token, { msg: "hi", files: [["virus.exe", "MZ"]] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported file type: \.exe/);
  });

  it("rejects files over 10MB with a JSON error", async () => {
    const big = "a".repeat(10 * 1024 * 1024 + 1);
    const res = await sendMessage(user.token, { msg: "hi", files: [["big.txt", big]] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Files must be under 10MB each");
  });

  it("rejects more than 5 files with a JSON error", async () => {
    const files = [1, 2, 3, 4, 5, 6].map((i) => [`c${i}.txt`, UK_CONTRACT]);
    const res = await sendMessage(user.token, { msg: "hi", files });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Maximum 5 files per request");
  });

  it("returns JSON 500 when the model fails", async () => {
    legalChat.mockRejectedValueOnce(new Error("OpenAI is down"));
    const res = await sendMessage(user.token, { msg: "hello" });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/OpenAI is down/);
  });
});

describe("chat history and sessions", () => {
  let alice;
  let bob;
  let aliceSession;

  beforeEach(async () => {
    alice = await createUser({ name: "Alice" });
    bob = await createUser({ name: "Bob" });
    aliceSession = (await sendMessage(alice.token, { msg: "Alice's question" })).body;
  });

  it("GET /api/chat requires a sessionId", async () => {
    const res = await request(app).get("/api/chat").set(auth(alice.token));
    expect(res.status).toBe(400);
  });

  it("GET /api/chat returns the session's messages in order", async () => {
    await sendMessage(alice.token, { msg: "Second", sessionId: aliceSession.sessionId });
    const res = await request(app)
      .get(`/api/chat?sessionId=${aliceSession.sessionId}`)
      .set(auth(alice.token));

    expect(res.status).toBe(200);
    expect(res.body.map((m) => m.msg)).toEqual([
      "Alice's question",
      "Mocked legal answer",
      "Second",
      "Mocked legal answer",
    ]);
  });

  it("GET /api/chat does not leak another user's session", async () => {
    const res = await request(app)
      .get(`/api/chat?sessionId=${aliceSession.sessionId}`)
      .set(auth(bob.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/chat/list returns [] for a user with no chats", async () => {
    const res = await request(app).get("/api/chat/list").set(auth(bob.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/chat/list returns the first message of each session, newest first", async () => {
    await sendMessage(alice.token, { msg: "Follow-up", sessionId: aliceSession.sessionId });
    await sendMessage(alice.token, { msg: "Newer session" });

    const res = await request(app).get("/api/chat/list").set(auth(alice.token));
    expect(res.status).toBe(200);
    expect(res.body.map((m) => m.msg)).toEqual(["Newer session", "Alice's question"]);
  });

  it("GET /api/chat/:id returns own message and hides others'", async () => {
    const id = aliceSession.userMessage._id;

    const own = await request(app).get(`/api/chat/${id}`).set(auth(alice.token));
    expect(own.status).toBe(200);
    expect(own.body.msg).toBe("Alice's question");

    const other = await request(app).get(`/api/chat/${id}`).set(auth(bob.token));
    expect(other.status).toBe(404);

    const anon = await request(app).get(`/api/chat/${id}`);
    expect(anon.status).toBe(401);
  });

  it("DELETE /api/chat/:id only deletes the caller's own message", async () => {
    const id = aliceSession.userMessage._id;

    const other = await request(app).delete(`/api/chat/${id}`).set(auth(bob.token));
    expect(other.status).toBe(404);
    expect(await Message.exists({ _id: id })).toBeTruthy();

    const own = await request(app).delete(`/api/chat/${id}`).set(auth(alice.token));
    expect(own.status).toBe(200);
    expect(await Message.exists({ _id: id })).toBeNull();
  });

  it("DELETE /api/chat/:id removes a question together with its answer (#20)", async () => {
    const second = (await sendMessage(alice.token, { msg: "Second", sessionId: aliceSession.sessionId })).body;

    const res = await request(app).delete(`/api/chat/${second.userMessage._id}`).set(auth(alice.token));

    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(2);
    const left = await Message.find({ sessionId: aliceSession.sessionId }).sort({ createdAt: 1 });
    expect(left.map((m) => m.msg)).toEqual(["Alice's question", "Mocked legal answer"]);
  });

  it("DELETE /api/chat/:id on an answer also removes its question (#20)", async () => {
    const res = await request(app).delete(`/api/chat/${aliceSession.aiMessage._id}`).set(auth(alice.token));
    expect(res.body.deletedCount).toBe(2);
    expect(await Message.countDocuments({ sessionId: aliceSession.sessionId })).toBe(0);
  });

  it("DELETE /api/chat/session/:sessionId deletes the whole chat and its documents (#20)", async () => {
    const withDoc = (await sendMessage(alice.token, { files: [["contract.txt", UK_CONTRACT]] })).body;
    await sendMessage(alice.token, { msg: "Follow-up", sessionId: withDoc.sessionId });
    const bobSession = (await sendMessage(bob.token, { msg: "Bob's question" })).body;

    const other = await request(app).delete(`/api/chat/session/${withDoc.sessionId}`).set(auth(bob.token));
    expect(other.status).toBe(404);

    const res = await request(app).delete(`/api/chat/session/${withDoc.sessionId}`).set(auth(alice.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deletedMessages: 4, deletedDocuments: 1 });
    expect(await Message.countDocuments({ sessionId: withDoc.sessionId })).toBe(0);
    expect(await UploadedDocument.countDocuments({ sessionId: withDoc.sessionId })).toBe(0);

    // other chats are untouched
    expect(await Message.countDocuments({ sessionId: aliceSession.sessionId })).toBe(2);
    expect(await Message.countDocuments({ sessionId: bobSession.sessionId })).toBe(2);
  });
});

describe("response fields (#17, #18)", () => {
  it("passes the service's document fields through unchanged", async () => {
    const user = await createUser();
    legalChat.mockResolvedValueOnce({
      text: "Answer", sources: [], documentContext: false, sessionHasDocuments: true, documentsAvailable: 1,
    });

    const res = await sendMessage(user.token, { msg: "Is the cake recipe legal?" });

    expect(res.body).toMatchObject({ documentContext: false, sessionHasDocuments: true, documentsAvailable: 1 });
  });
});

describe("session documents", () => {
  let user;
  let sessionId;

  beforeEach(async () => {
    user = await createUser();
    const res = await sendMessage(user.token, { files: [["contract.txt", UK_CONTRACT]] });
    sessionId = res.body.sessionId;
  });

  it("GET /api/chat/documents/:sessionId lists uploaded documents", async () => {
    const res = await request(app)
      .get(`/api/chat/documents/${sessionId}`)
      .set(auth(user.token));

    expect(res.status).toBe(200);
    expect(res.body.totalDocuments).toBe(1);
    expect(res.body.documents[0]).toMatchObject({
      filename: "contract.txt",
      documentType: "uk_employment_contract",
    });
    expect(res.body.documents[0].extractedText).toBeUndefined();
  });

  it("DELETE /api/chat/documents/:id removes it from the session", async () => {
    const list = await request(app)
      .get(`/api/chat/documents/${sessionId}`)
      .set(auth(user.token));
    const docId = list.body.documents[0].id;

    const del = await request(app)
      .delete(`/api/chat/documents/${docId}`)
      .set(auth(user.token));
    expect(del.status).toBe(200);

    const after = await request(app)
      .get(`/api/chat/documents/${sessionId}`)
      .set(auth(user.token));
    expect(after.body.totalDocuments).toBe(0);
  });

  it("DELETE /api/chat/documents/:id cannot remove another user's document", async () => {
    const other = await createUser();
    const doc = await UploadedDocument.findOne({ sessionId });

    const res = await request(app)
      .delete(`/api/chat/documents/${doc._id}`)
      .set(auth(other.token));
    expect(res.status).toBe(404);
    expect((await UploadedDocument.findById(doc._id)).isActive).toBe(true);
  });
});
