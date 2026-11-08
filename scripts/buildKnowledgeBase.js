// Rebuilds the legislation knowledge base in Pinecone with the current parser.
//
//   npm run build:knowledge -- --namespace legislation-v2            dry run: download, parse, chunk, report
//   npm run build:knowledge -- --namespace legislation-v2 --upsert   embed and upload into that namespace
//   add --replace to empty a namespace that already has records first
//
// It never writes to the default namespace, which the live site reads until
// PINECONE_NAMESPACE is set. Switch the app over by setting PINECONE_NAMESPACE.
require("dotenv").config({ quiet: true });
const axios = require("axios");
const { OpenAIEmbeddings } = require("@langchain/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const { buildKnowledgeBase } = require("../services/knowledgeBase");

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const namespace = valueOf("--namespace");
const dryRun = !hasFlag("--upsert");

const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: "text-embedding-3-small",
});
const index = new Pinecone({ apiKey: process.env.PINECONE_API_KEY }).Index(
  process.env.PINECONE_INDEX_NAME
);

buildKnowledgeBase({
  fetchXml: async (url) => (await axios.get(url, { timeout: 120000 })).data,
  embedTexts: (texts) => embeddings.embedDocuments(texts),
  index,
  namespace,
  dryRun,
  replace: hasFlag("--replace"),
})
  .then((result) => {
    console.log("\n" + JSON.stringify({ ...result, perAct: undefined }, null, 2));
    console.table(result.perAct);
    if (dryRun) {
      console.log("Dry run only. Add --upsert to embed and upload.");
    } else {
      console.log(`Done. Point the app at it with PINECONE_NAMESPACE=${namespace}`);
    }
    process.exit(result.errors.length ? 1 : 0);
  })
  .catch((error) => {
    console.error("Build failed:", error.message);
    process.exit(1);
  });
