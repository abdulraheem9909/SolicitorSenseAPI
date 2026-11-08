// Builds the legislation knowledge base: Act XML -> labelled chunks -> embeddings -> Pinecone.
const {
  LEGISLATION_SOURCES,
  getLegislationInfo,
  parseLegislationXml,
  getActTitles,
  extractLegalPieces,
  createCoherentChunks,
  processLegalText,
  generateCleanId,
} = require("./legislationParser");

// Titles name the same Act if they match ignoring case, punctuation, "The" and "etc."
const normaliseTitle = (title) =>
  title
    .toLowerCase()
    .replace(/\betc\b\.?/g, "")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const sameAct = (a, b) => normaliseTitle(a) === normaliseTitle(b);

// One Act's XML -> [{ id, metadata }], metadata.text being what gets embedded
async function buildActRecords(url, xml) {
  const legislationInfo = getLegislationInfo(url);
  const parsed = await parseLegislationXml(xml);

  // Guard against a URL that points at a different Act than LEGISLATION_MAP says
  // (this once loaded the National Minimum Wage Act as the "Human Rights Act")
  const actTitles = getActTitles(parsed);
  if (actTitles.title && sameAct(actTitles.title, legislationInfo.title) === false) {
    throw new Error(
      `${url} holds "${actTitles.title}", expected "${legislationInfo.title}"`
    );
  }

  // Prefer the XML's own title when it is more complete than the map's
  const title =
    actTitles.title.length > legislationInfo.title.length
      ? actTitles.title
      : legislationInfo.title;
  const longTitle = actTitles.longTitle;

  const pieces = extractLegalPieces(parsed);
  const chunks = createCoherentChunks(pieces);

  const records = chunks.map((chunk, i) => {
    let text = `${title}\n\n`;
    if (i === 0 && longTitle && longTitle.length > 20) text += `${longTitle}\n\n`;
    text += processLegalText(chunk.text);

    return {
      id: generateCleanId(legislationInfo, i),
      metadata: {
        text,
        source: url.replace(/\.xml$/, ".pdf"),
        original_url: url,
        act_title: title,
        legislation_type: legislationInfo.type,
        legislation_year: legislationInfo.year,
        section_context: chunk.context.section || "General",
        provisions: chunk.provisions.join(" to "), // e.g. "Section 86(1) to Section 86(2)"
        chunk_index: i,
        total_chunks: chunks.length,
        content_type: "uk_legislation",
        processed_at: new Date().toISOString(),
        text_length: text.length,
      },
    };
  });

  return { title, pieces: pieces.length, records };
}

// Downloads every Act, builds its records and (unless dryRun) embeds and upserts them.
// Writes only to a named namespace, never the default one the live site reads, and
// refuses a namespace that already holds records unless `replace` is set.
async function buildKnowledgeBase({
  sources = LEGISLATION_SOURCES,
  fetchXml,
  embedTexts,
  index,
  namespace,
  dryRun = true,
  replace = false,
  batchSize = 100,
  log = console.log,
  onRecords = () => {}, // receives each Act's records, e.g. to save a preview file
}) {
  if (!dryRun) {
    if (!namespace) {
      throw new Error("Choose a namespace: the default namespace holds the live site's current data");
    }
    const stats = await index.describeIndexStats();
    const existing = stats.namespaces?.[namespace]?.recordCount || 0;
    if (existing > 0 && !replace) {
      throw new Error(`Namespace "${namespace}" already has ${existing} records; pass replace to overwrite it`);
    }
    if (existing > 0) {
      log(`Deleting ${existing} records from "${namespace}"`);
      await index.namespace(namespace).deleteAll();
    }
  }

  const target = dryRun ? null : index.namespace(namespace);
  const result = { dryRun, acts: 0, records: 0, upserted: 0, errors: [], perAct: [] };

  for (const url of sources) {
    try {
      const xml = await fetchXml(url);
      const { title, pieces, records } = await buildActRecords(url, xml);
      log(`${title}: ${pieces} pieces -> ${records.length} chunks`);
      onRecords(records);

      if (!dryRun) {
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const vectors = await embedTexts(batch.map((r) => r.metadata.text));
          await target.upsert(
            batch.map((r, j) => ({ id: r.id, values: vectors[j], metadata: r.metadata }))
          );
          result.upserted += batch.length;
          log(`  upserted ${Math.min(i + batchSize, records.length)}/${records.length}`);
        }
      }

      result.acts += 1;
      result.records += records.length;
      result.perAct.push({ title, pieces, chunks: records.length });
    } catch (error) {
      log(`Error processing ${url}: ${error.message}`);
      result.errors.push(`${url}: ${error.message}`);
    }
  }

  return result;
}

module.exports = { buildActRecords, buildKnowledgeBase };
