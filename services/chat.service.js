// services/chat.service.js (MODIFIED - only added document context support)
const { ChatOpenAI } = require("@langchain/openai");
const {
  ChatPromptTemplate,
  MessagesPlaceholder,
} = require("@langchain/core/prompts");
const { BufferMemory, ChatMessageHistory } = require("langchain/memory");
const { ConversationChain } = require("langchain/chains");
const { OpenAIEmbeddings } = require("@langchain/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const {
  createStuffDocumentsChain,
} = require("langchain/chains/combine_documents");
const { Document } = require("langchain/document");

// *** NEW IMPORT - Document service ***
const {
  getSessionDocuments,
  createDocumentContext,
  isQueryAboutDocuments,
} = require("./document.service");

const llm = new ChatOpenAI({
  modelName: "gpt-4o",
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.1,
});

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
// PINECONE_NAMESPACE selects which build of the knowledge base to search
// (unset = the default namespace, the original build)
const pineconeIndex = process.env.PINECONE_NAMESPACE
  ? pinecone.Index(process.env.PINECONE_INDEX_NAME).namespace(process.env.PINECONE_NAMESPACE)
  : pinecone.Index(process.env.PINECONE_INDEX_NAME);

// A fresh memory for every request, built from the history stored in MongoDB.
// The database is the only source of truth: nothing is cached in server RAM, so the
// history cannot go stale, grow duplicates, or differ between server instances.
const createSessionMemory = (pastMessages = []) =>
  new BufferMemory({
    memoryKey: "chat_history",
    chatHistory: new ChatMessageHistory([...pastMessages]),
    returnMessages: true,
  });

// *** MODIFIED SYSTEM PROMPT - Added document awareness ***
const SYSTEM_PROMPT = `
You are "SolicitorSense", a comprehensive UK legal assistant.
**STRICT SCOPE:** You answer questions related to all UK law , legal law queries and question. 

**For non-legal queries:** Politely decline with: "I specialize in UK legal matters. For other topics, please consult a relevant expert."

**SCOPE:** You answer questions about ALL areas of UK law, including but not limited to:
- Employment law, Health & safety law, Equality law, Human rights law
- Immigration law, Family law, Property law, Criminal law, Tax law
- Company law, Contract law, Tort law, Constitutional law
- Planning law, Environmental law, Intellectual property law


**Document Analysis Capability:**
When users upload documents (contracts, policies, letters, etc.), you can analyze and reference their specific content to provide tailored legal advice based on both the uploaded documents and general UK legal principles.

**Response Structure:**
1. **Direct Answer**: Address the specific legal question clearly
2. **Legal Authority**: Cite the relevant Act, section, or regulation (and uploaded document provisions when relevant)
3. **Practical Application**: Explain what this means in real-world terms  
4. **Key Requirements**: Highlight specific legal duties, rights, or obligations
5. **Additional Considerations**: Note any exceptions, related provisions, or practical factors
6. **Next Steps**: Suggest appropriate actions where relevant

**When Documents Are Available:**
- Reference specific clauses, terms, or provisions from uploaded documents
- Compare document terms with statutory requirements
- Identify potential issues or conflicts between document terms and legal requirements
- Provide document-specific guidance alongside general legal principles

**Citation Standards:**
- For legislation: "Under Section 1 of the Employment Rights Act 1996..."
- For uploaded documents: "According to clause 5 of your employment contract..." or "Your company policy states..."
- Always distinguish between statutory rights and contractual terms

**Professional Guidelines:**
- Distinguish between legal requirements and best practices
- Explain legal tests: "reasonable", "proportionate", "necessary", "practicable"
- Note when specialist advice is needed: "This is general guidance. For advice on your specific situation, please consult a qualified solicitor specializing in [area] law."
- For non-UK law queries: "I specialize in UK law. For other jurisdictions, please consult the appropriate legal expert."

**Tone:**
- Professional yet accessible
- Clear explanations without unnecessary jargon
- Helpful and practical
- Acknowledge complexity where it exists

**First Interaction:**
Start with: "Hello, I'm SolicitorSense, your UK legal assistant."
`.trim();

// Legal keywords added to a question before searching, so it lands near the right
// provisions. Patterns catch common wordings ("notice clause", "sacked", "holiday").
const QUERY_EXPANSIONS = [
  // Employment Law
  [/unfair(ly)? dismiss|dismissal|sacked|\bfired\b/, "unfair dismissal Employment Rights Act 1996 Section 94 Section 98 qualifying period"],
  [/redundan/, "redundancy consultation selection criteria redundancy payment Employment Rights Act 1996 Section 135"],
  [/working time|working hours|hours a week|hours per week|rest break/, "working time 48 hours rest breaks Working Time Regulations 1998"],
  [/maternity|pregnan/, "maternity leave statutory pay Employment Rights Act 1996 Section 71"],
  [/holiday|annual leave|paid leave|vacation/, "annual leave entitlement holiday pay Working Time Regulations 1998 regulation 13"],
  // "notice" alone also appears in housing questions ("evict me without notice")
  [/^(?=.*notice)(?=.*(employ|job|\bwork|dismiss|sack|fired|resign|contract)).*/, "minimum notice period termination continuous employment Employment Rights Act 1996 Section 86"],
  [/employment contract|contract of employment|written statement|terms and conditions/, "written statement of employment particulars terms Employment Rights Act 1996 Section 1"],

  // Health and Safety
  [/workplace safety|safe working|health and safety/, "workplace safety employer duties Health Safety Work Act 1974 Section 2"],
  [/risk assessment/, "risk assessment hazards control measures reasonably practicable"],
  [/health safety policy|safety policy/, "health safety policy statement Health Safety Work Act 1974"],
  [/safety training/, "safety training information instruction supervision Section 2"],

  // Equality Law
  [/discriminat/, "discrimination direct indirect Equality Act 2010 protected characteristics"],
  [/harass/, "harassment unwanted conduct dignity Equality Act 2010 Section 26"],
  [/reasonable adjustment/, "reasonable adjustments disability Equality Act 2010 Section 20"],
  [/equal pay/, "equal pay sex equality clause Equality Act 2010 Section 66"],
  [/protected characteristic/, "age disability gender race religion sex Equality Act 2010"],

  // Human Rights
  [/human rights/, "human rights fundamental freedoms Human Rights Act 1998 ECHR"],
  [/fair trial/, "fair trial Article 6 Human Rights Act 1998 due process"],
  [/privacy/, "privacy private family life Article 8 Human Rights Act 1998"],
  [/freedom of expression|free speech/, "freedom expression Article 10 Human Rights Act 1998"],

  // General Legal Terms
  [/statutory rights/, "statutory rights legislation parliament primary secondary"],
  [/legal duty/, "legal duty obligation requirement breach liability"],
  [/reasonabl/, "reasonable practicable objective standard test"],
  [/tribunal/, "employment tribunal industrial tribunal procedure"],
];

function enhanceUKLegalQuery(query) {
  let enhancedQuery = query.toLowerCase();

  for (const [pattern, expansion] of QUERY_EXPANSIONS) {
    if (pattern.test(enhancedQuery)) {
      enhancedQuery += " " + expansion;
    }
  }

  // Add general UK legal context
  enhancedQuery += " UK law legal statute regulation Act";

  return enhancedQuery;
}

const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: "text-embedding-3-small",
});

// Pinecone search for an already-embedded query, with optional metadata filter
async function searchPineconeDirectly(vector, topK = 5, filter = null) {
  const searchParams = {
    vector,
    topK: topK,
    includeMetadata: true,
  };

  if (filter) {
    searchParams.filter = filter;
  }

  const searchResults = await pineconeIndex.query(searchParams);

  // Convert to LangChain Document format
  const documents = searchResults.matches.map(
    (match) =>
      new Document({
        pageContent: match.metadata?.text || "",
        metadata: {
          id: match.id,
          score: match.score,
          source: match.metadata?.source,
          act_title: match.metadata?.act_title,
          legislation_type: match.metadata?.legislation_type,
          legislation_year: match.metadata?.legislation_year,
          section_context: match.metadata?.section_context,
          provisions: match.metadata?.provisions,
          chunk_index: match.metadata?.chunk_index,
        },
      })
  );

  return { documents, scores: searchResults.matches.map((m) => m.score) };
}

// Intelligent search strategy based on query analysis
async function performIntelligentSearch(userInput) {
  // One embedding call for both texts; the topic-filtered searches reuse the raw vector
  const [rawVector, enhancedVector] = await embeddings.embedDocuments([
    userInput,
    enhanceUKLegalQuery(userInput),
  ]);

  const searches = [];

  // 1. Direct semantic search
  searches.push(searchPineconeDirectly(rawVector, 3));

  // 2. Enhanced search with legal terms
  searches.push(searchPineconeDirectly(enhancedVector, 3));

  // 3. Targeted searches based on query content
  const queryLower = userInput.toLowerCase();

  if (
    queryLower.includes("employ") ||
    queryLower.includes("work") ||
    queryLower.includes("job")
  ) {
    searches.push(
      searchPineconeDirectly(rawVector, 2, { legislation_type: "employment" })
    );
  }

  if (
    queryLower.includes("discriminat") ||
    queryLower.includes("equal") ||
    queryLower.includes("bias")
  ) {
    searches.push(
      searchPineconeDirectly(rawVector, 2, { legislation_type: "equality" })
    );
  }

  if (
    queryLower.includes("safety") ||
    queryLower.includes("health") ||
    queryLower.includes("risk")
  ) {
    searches.push(
      searchPineconeDirectly(rawVector, 2, {
        legislation_type: "health_safety",
      })
    );
  }

  if (
    queryLower.includes("human rights") ||
    queryLower.includes("freedom") ||
    queryLower.includes("privacy")
  ) {
    searches.push(
      searchPineconeDirectly(rawVector, 2, { legislation_type: "human_rights" })
    );
  }

  // 4. Year-based search for recent legislation
  if (
    queryLower.includes("recent") ||
    queryLower.includes("new") ||
    queryLower.includes("latest")
  ) {
    searches.push(
      searchPineconeDirectly(rawVector, 2, {
        legislation_year: { $gte: 2000 },
      })
    );
  }

  // Execute all searches in parallel
  const results = await Promise.all(searches);

  return results;
}

// One entry per chunk across all searches, keeping its BEST score, highest first
function mergeSearchResults(searchResults, limit = 5) {
  const best = new Map();

  searchResults.forEach(({ documents, scores }) => {
    documents.forEach((doc, idx) => {
      const id = doc.metadata.id;
      if (!best.has(id) || scores[idx] > best.get(id).score) {
        best.set(id, { doc, score: scores[idx] });
      }
    });
  });

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// Minimum similarity for a chunk to be used as evidence. Measured on the live index:
// off-topic questions scored at most 0.47, legal ones 0.58-0.74, so 0.65 keeps a wide
// margin while letting through questions like "minimum holiday entitlement" (0.69).
const SCORE_THRESHOLD = 0.65;

function selectStrongMatches(sortedResults) {
  const legislationTypes = [
    ...new Set(
      sortedResults.map((r) => r.doc.metadata.legislation_type).filter(Boolean)
    ),
  ];
  const threshold = SCORE_THRESHOLD;

  return {
    strongMatches: sortedResults.filter((result) => result.score >= threshold),
    threshold,
    bestScore: sortedResults[0]?.score || 0,
    legislationTypes,
  };
}

// "Employment Rights Act 1996 (1996) - Section 86(1) to Section 86(2), Rights of ..."
function formatLegislationSources(docs) {
  return [
    ...new Set(
      docs
        .map((doc) => {
          const { act_title, legislation_year, provisions, section_context } =
            doc.metadata || {};
          if (!act_title) return null;

          const where = [
            provisions,
            section_context !== "General" ? section_context : null,
          ]
            .filter(Boolean)
            .join(", ");

          let sourceString = act_title;
          if (legislation_year) sourceString += ` (${legislation_year})`;
          if (where) sourceString += ` - ${where}`;
          return sourceString;
        })
        .filter(Boolean)
    ),
  ];
}

// *** MODIFIED MAIN FUNCTION - Added document context support ***
const legalChat = async ({
  userInput,
  sessionId,
  pastMessages,
  userId,
  hasValidDocuments,
  irrelevantDocuments = [],
  userMessageProvided = true,
}) => {
  try {
    console.log(`Processing legal query: "${userInput}"`);

    const hasCurrentDocumentReferences =
      /\b(this document|the document|this file|the file|this contract|the contract|uploaded document)\b/i.test(
        userInput
      );

    if (
      (hasCurrentDocumentReferences || !userMessageProvided) &&
      irrelevantDocuments.length > 0 &&
      !hasValidDocuments
    ) {
      // User is asking about current rejected documents
      console.log(
        `User asking about rejected documents from current request`
      );

      const rejectedFileNames = irrelevantDocuments
        .map((d) => d.filename)
        .join(", ");
      const response = `The document(s) you just uploaded (${rejectedFileNames}) don't appear to be related to UK legal matters. I specialize in UK employment law, contracts, health and safety documents, and other UK legal documents. 

Please upload UK legal documents such as:
- Employment contracts
- Company policies
- Health and safety procedures  
- Legal agreements
- HR documentation

Or feel free to ask me any questions about UK law.`;

      return {
        text: response,
        sources: [],
        confidence: "high",
        documentContext: false,
        irrelevantDocuments: irrelevantDocuments.length,
        fallback: false,
      };
    }

    const sessionMemory = createSessionMemory(pastMessages);

    // *** NEW: Get uploaded documents for this session ***
    const uploadedDocuments = userId
      ? await getSessionDocuments(sessionId, userId)
      : [];
    const hasDocuments = uploadedDocuments.length > 0;

    console.log(
      `Found ${uploadedDocuments.length} uploaded documents for session`
    );

    // *** NEW: Check if query is about uploaded documents ***
    // Files attached to this very message are always what the user is asking about
    const isDocumentQuery =
      hasDocuments &&
      (hasValidDocuments || isQueryAboutDocuments(userInput, uploadedDocuments));

    // Law search runs for every remaining route: document questions are answered
    // from the document AND the matching provisions
    const sortedResults = mergeSearchResults(
      await performIntelligentSearch(userInput)
    );
    const { strongMatches, threshold, bestScore, legislationTypes } =
      selectStrongMatches(sortedResults);
    const relevantDocs = strongMatches.map((result) => result.doc);

    console.log(
      `Search results: ${
        sortedResults.length
      } docs, best score: ${bestScore.toFixed(3)}, ${
        strongMatches.length
      } above ${threshold}, types: ${legislationTypes.join(", ")}`
    );

    // User and law text go in as prompt VARIABLES, never into the template itself:
    // a "{" in a contract would otherwise be read as a template slot and crash the chat
    if (isDocumentQuery) {
      console.log(
        `Query appears to be about uploaded documents - enhancing context`
      );

      // Create enhanced context with document content
      const documentContext = await createDocumentContext(
        uploadedDocuments,
        userInput
      );

      if (documentContext) {
        const legalContext = relevantDocs.length
          ? relevantDocs.map((doc) => doc.pageContent).join("\n\n---\n\n")
          : "No specific provisions were retrieved; rely on your knowledge of UK legislation and say so.";

        // Enhanced prompt for document-aware responses
        const documentPrompt = await ChatPromptTemplate.fromMessages([
          [
            "system",
            "{system_prompt}\n\nDOCUMENT CONTEXT: The user has uploaded legal documents. Use both the document content and the UK legislation provisions provided to give comprehensive advice.",
          ],
          new MessagesPlaceholder("chat_history"),
          [
            "human",
            `{document_context}

RELEVANT UK LEGISLATION:
{legal_context}

USER QUESTION: {input}

Please provide a comprehensive answer considering both the uploaded documents and relevant UK legislation. Reference specific document clauses where applicable and compare with statutory requirements.`,
          ],
        ]).partial({
          system_prompt: SYSTEM_PROMPT,
          document_context: documentContext,
          legal_context: legalContext,
        });

        const documentChain = new ConversationChain({
          memory: sessionMemory,
          prompt: documentPrompt,
          llm,
        });

        const documentResult = await documentChain.invoke({ input: userInput });


        return {
          text: documentResult.response,
          sources: [
            ...uploadedDocuments.map((doc) => `Uploaded: ${doc.filename}`),
            ...formatLegislationSources(relevantDocs),
          ],
          confidence: "high",
          documentContext: true,
          sessionHasDocuments: true,
          documentsUsed: uploadedDocuments.length,
          documentsAvailable: uploadedDocuments.length,
          matchedChunks: strongMatches.length,
          bestScore,
          fallback: false,
        };
      }
    }

    // Note about uploads for the non-document routes (file names are user input)
    const documentsNote = hasDocuments
      ? `\n\nNOTE: User has uploaded ${
          uploadedDocuments.length
        } document(s): ${uploadedDocuments
          .map((d) => d.filename)
          .join(
            ", "
          )}. Consider mentioning if their query might relate to these documents.`
      : "";

    if (strongMatches.length > 0) {
      console.log(
        `Found ${strongMatches.length} matches above threshold ${threshold}`
      );

      // Create context summary for better responses
      const legislationContext = strongMatches.reduce((acc, result) => {
        const type = result.doc.metadata.legislation_type;
        const title = result.doc.metadata.act_title;
        if (!acc[type]) acc[type] = new Set();
        acc[type].add(title);
        return acc;
      }, {});

      const contextSummary = Object.entries(legislationContext)
        .map(([type, titles]) => `${type}: ${Array.from(titles).join(", ")}`)
        .join("; ");

      const ragPrompt = await ChatPromptTemplate.fromMessages([
        [
          "system",
          "{system_prompt}\n\nCONTEXT: You have access to relevant provisions from: {context_summary}",
        ],
        new MessagesPlaceholder("chat_history"),
        [
          "human",
          `Based on the following UK legislation provisions, please provide a comprehensive answer to the user's question.

RELEVANT LEGAL PROVISIONS:
{context}

USER QUESTION: {input}

Please structure your response with clear legal authority, practical explanation, and specific guidance. Always cite the relevant Acts and sections where applicable.`,
        ],
      ]).partial({
        system_prompt: SYSTEM_PROMPT + documentsNote,
        context_summary: contextSummary,
      });

      const combineDocsChain = await createStuffDocumentsChain({
        llm,
        prompt: ragPrompt,
      });

      const ragResult = await combineDocsChain.invoke({
        input: userInput,
        context: relevantDocs,
        chat_history: pastMessages,
      });


      return {
        text: ragResult,
        sources: formatLegislationSources(relevantDocs),
        confidence: "high",
        matchedChunks: strongMatches.length,
        bestScore: bestScore,
        legislationTypes: legislationTypes,
        searchStrategy: "intelligent_multi_strategy",
        documentContext: false,
        sessionHasDocuments: hasDocuments,
        documentsAvailable: uploadedDocuments.length,
      };
    }

    console.log(
      `No strong matches found (best: ${bestScore.toFixed(
        3
      )}). Using enhanced fallback.`
    );

    // Enhanced fallback that categorizes the query and provides general guidance
    const queryCategory = categorizeQuery(userInput);
    const contextualFallback = sortedResults
      .slice(0, 2)
      .map((result) => {
        const title = result.doc.metadata.act_title;
        const content = result.doc.pageContent.substring(0, 300);
        return `From ${title}: ${content}...`;
      })
      .join("\n\n");

    const fallbackNote = hasDocuments
      ? `\n\nNOTE: User has uploaded ${uploadedDocuments.length} document(s). If their query might relate to these documents, suggest they ask more specific questions about their uploaded documents.`
      : "";

    const fallbackPrompt = await ChatPromptTemplate.fromMessages([
      [
        "system",
        "{system_prompt}\n\nNote: Limited specific provisions were found for this query. The query appears to relate to {query_category}. Provide general UK legal guidance in this area, using any available context carefully.",
      ],
      new MessagesPlaceholder("chat_history"),
      [
        "human",
        contextualFallback
          ? "Some potentially relevant context:\n{fallback_context}\n\nQuestion: {input}"
          : "{input}",
      ],
    ]).partial({
      system_prompt: SYSTEM_PROMPT + fallbackNote,
      query_category: queryCategory,
      ...(contextualFallback ? { fallback_context: contextualFallback } : {}),
    });

    const fallbackChain = new ConversationChain({
      memory: sessionMemory,
      prompt: fallbackPrompt,
      llm,
    });

    const fallbackResult = await fallbackChain.invoke({ input: userInput });


    return {
      text: fallbackResult.response,
      sources: [],
      confidence: "medium",
      fallback: true,
      bestScore: bestScore,
      queryCategory: queryCategory,
      availableContext: sortedResults.length > 0,
      documentContext: false,
      sessionHasDocuments: hasDocuments,
      documentsAvailable: uploadedDocuments.length,
    };
  } catch (error) {
    console.error("Error in legalChat:", error);
    throw new Error(`Failed to process legal query: ${error.message}`);
  }
};

// Name the area of law for the fallback prompt. Patterns match from the START of a word
// ("employ" matches "employer"), and short words must match whole ("age" is not "manager").
const QUERY_CATEGORIES = [
  ["employment law", /\b(employ|job|work|dismiss|sack|fired\b|redundan|wage|salary|holiday|maternity|notice|manager\b|boss\b|colleague)/],
  ["health and safety law", /\b(safety|health|risk|hazard|accident|injur|workplace|equipment)/],
  ["equality and discrimination law", /\b(discriminat|equal|bias|harass|disab|race\b|racis|sex\b|sexis|age\b|ageis|religio)/],
  ["human rights law", /\b(human rights|freedom|privacy|fair trial|expression|assembly|liberty)/],
  ["criminal law", /\b(criminal|offence|crime|sentence|prosecut|penalt|theft|assault|arrest)/],
  ["general civil law", /\b(contract|tort|negligen|liabilit|damages|breach|court|dispute|neighbour|sue\b|claim)/],
];

function categorizeQuery(query) {
  const queryLower = query.toLowerCase();
  const match = QUERY_CATEGORIES.find(([, pattern]) => pattern.test(queryLower));
  return match ? match[0] : "general UK law";
}

module.exports = {
  legalChat,
  createSessionMemory,
  categorizeQuery,
  enhanceUKLegalQuery,
  performIntelligentSearch,
  mergeSearchResults,
  selectStrongMatches,
  formatLegislationSources,
};
