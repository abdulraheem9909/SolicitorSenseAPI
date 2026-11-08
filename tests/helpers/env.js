// Loaded before every test file (jest "setupFiles"). Never point tests at the real Atlas DB.
process.env.MONGO_TEST_URI =
  process.env.MONGO_TEST_URI || "mongodb://127.0.0.1:27017/solicitorsense_test";
process.env.JWT_SECRET = "test-secret";
process.env.ADMIN_API_KEY = "test-admin-key";
// Dummy keys so OpenAI/Pinecone clients can be constructed; calls are mocked per test.
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.PINECONE_API_KEY = "test-pinecone-key";
process.env.PINECONE_INDEX_NAME = "test-index";
