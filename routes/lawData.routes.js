// Admin-only (see middlewares/requireAdminKey.js). Previews the legislation import;
// the real rebuild of Pinecone is done by scripts/buildKnowledgeBase.js.
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { Pinecone } = require("@pinecone-database/pinecone");
const { LEGISLATION_MAP, LEGISLATION_SOURCES } = require("../services/legislationParser");
const { buildKnowledgeBase } = require("../services/knowledgeBase");

const router = express.Router();

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME);

// Preview: builds every record (no embedding, no Pinecone writes), saves them to
// uk_legislation_chunks.json for inspection and returns a summary
router.get("/", async (req, res) => {
  try {
    const allChunks = [];
    const fetchXml = async (url) => (await axios.get(url, { timeout: 30000 })).data;

    const result = await buildKnowledgeBase({
      fetchXml,
      dryRun: true,
      log: console.log,
      onRecords: (records) => records.forEach((r) => allChunks.push({ id: r.id, ...r.metadata })),
    });

    fs.writeFileSync("uk_legislation_chunks.json", JSON.stringify(allChunks, null, 2));

    const summary = {
      total_documents: LEGISLATION_SOURCES.length,
      processed: result.acts,
      chunks_created: result.records,
      errors: result.errors,
      total_chunks: allChunks.length,
      average_length:
        allChunks.length > 0
          ? Math.round(allChunks.reduce((sum, chunk) => sum + chunk.text_length, 0) / allChunks.length)
          : 0,
      legislation_types: [...new Set(allChunks.map((chunk) => chunk.legislation_type))],
      years_covered: [...new Set(allChunks.map((chunk) => chunk.legislation_year))]
        .filter(Boolean)
        .sort(),
      acts_processed: [...new Set(allChunks.map((chunk) => chunk.act_title))],
      sections_covered: new Set(allChunks.map((chunk) => chunk.section_context)).size,
      processing_completed: new Date().toISOString(),
    };

    console.log("Processing Summary:", summary);

    res.json({
      message: "UK legislation preview built. Run scripts/buildKnowledgeBase.js to load it into Pinecone.",
      summary,
      sample_chunk: allChunks[0]?.text.slice(0, 300),
      sample_acts: allChunks.slice(0, 3).map((c) => ({ title: c.act_title, type: c.legislation_type })),
    });
  } catch (err) {
    console.log("Global Error:", err);
    res.status(500).json({
      error: `Error processing legislation: ${err.message}`,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

// Get statistics about processed legislation
router.get("/stats", async (req, res) => {
  try {
    const stats = await pineconeIndex.describeIndexStats();

    res.json({
      message: "📊 Legislation Database Statistics",
      pinecone_stats: stats,
      namespace_in_use: process.env.PINECONE_NAMESPACE || "(default)",
      legislation_map: LEGISLATION_MAP,
      total_sources: LEGISLATION_SOURCES.length,
    });
  } catch (err) {
    console.log("Error getting stats:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
