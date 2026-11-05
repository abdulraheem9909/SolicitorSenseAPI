const mammoth = require("mammoth");
const pdf = require("pdf-parse");
const { ChatOpenAI } = require("@langchain/openai");
const { OpenAIEmbeddings } = require("@langchain/openai");
const UploadedDocument = require("../models/uploadDocument");

const llm = new ChatOpenAI({
  modelName: "gpt-4o",
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.1,
});

const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: "text-embedding-3-small",
});

// Extract text from uploaded file
async function extractTextFromFile(buffer, filename) {
  const fileExtension = filename.toLowerCase().split(".").pop();

  try {
    switch (fileExtension) {
      case "pdf":
        const pdfData = await pdf(buffer);
        return {
          text: pdfData.text,
          metadata: { pages: pdfData.numpages, type: "PDF" },
        };

      case "doc":
      case "docx":
        const docResult = await mammoth.extractRawText({ buffer });
        return {
          text: docResult.value,
          metadata: { type: "Word Document" },
        };

      case "txt":
        return {
          text: buffer.toString("utf-8"),
          metadata: { type: "Text File" },
        };

      default:
        throw new Error(`Unsupported file type: ${fileExtension}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to extract text from ${filename}: ${error.message}`
    );
  }
}

// Analyze document content and generate summary
async function analyzeDocumentContent(text, filename) {
  const textLower = text.toLowerCase();

  let documentType = "unknown";
  if (
    textLower.includes("employment contract") ||
    textLower.includes("contract of employment")
  ) {
    documentType = "uk_employment_contract";
  } else if (
    textLower.includes("company policy") ||
    textLower.includes("workplace policy")
  ) {
    documentType = "uk_company_policy";
  } else if (
    textLower.includes("employee handbook") ||
    textLower.includes("staff handbook")
  ) {
    documentType = "uk_employee_handbook";
  } else if (
    textLower.includes("disciplinary") &&
    textLower.includes("procedure")
  ) {
    documentType = "uk_disciplinary_procedure";
  } else if (
    textLower.includes("grievance") &&
    textLower.includes("procedure")
  ) {
    documentType = "uk_grievance_procedure";
  } else if (
    textLower.includes("redundancy") ||
    textLower.includes("consultation")
  ) {
    documentType = "uk_redundancy_notice";
  } else if (
    textLower.includes("settlement agreement") ||
    textLower.includes("compromise agreement")
  ) {
    documentType = "uk_settlement_agreement";
  } else if (
    textLower.includes("service agreement") ||
    textLower.includes("consultancy agreement")
  ) {
    documentType = "uk_service_agreement";
  } else if (
    textLower.includes("contract") ||
    textLower.includes("agreement")
  ) {
    documentType = "uk_legal_agreement";
  } else if (textLower.includes("policy") || textLower.includes("procedure")) {
    documentType = "uk_policy_document";
  }

  // Generate concise summary (for efficient context use)
  try {
    const summaryPrompt = `Analyze this legal document and provide a concise 2-3 sentence summary focusing on:
1. Document type and purpose
2. Key terms, amounts, dates, or obligations
3. Most important legal provisions

Document: ${filename}
Content: ${text.substring(0, 2000)}...

Provide a brief, factual summary:`;

    const summaryResponse = await llm.invoke(summaryPrompt);

    return {
      documentType,
      summary: summaryResponse.content,
      wordCount: text.split(/\s+/).length,
      keyElements: extractKeyElements(text),
    };
  } catch (error) {
    console.warn("Failed to generate summary:", error.message);
    return {
      documentType,
      summary: `${documentType.replace("_", " ")} - ${text.substring(
        0,
        200
      )}...`,
      wordCount: text.split(/\s+/).length,
      keyElements: extractKeyElements(text),
    };
  }
}

// Extract key elements from document
function extractKeyElements(text) {
  const elements = [];

  // Monetary amounts
  const amounts = text.match(/£[\d,]+(?:\.\d{2})?/g);
  if (amounts) elements.push({ type: "amounts", values: amounts.slice(0, 3) });

  // Dates
  const dates = text.match(
    /\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}/gi
  );
  if (dates) elements.push({ type: "dates", values: dates.slice(0, 3) });

  // Section references
  const sections = text.match(/(?:section|clause|paragraph)\s+\d+/gi);
  if (sections)
    elements.push({ type: "sections", values: sections.slice(0, 3) });

  return elements;
}

// Process and save uploaded document
async function processUploadedDocument({
  buffer,
  filename,
  sessionId,
  userId,
}) {
  try {
    console.log(`Processing document: ${filename} for session: ${sessionId}`);

    // Extract text
    const { text, metadata: extractionMetadata } = await extractTextFromFile(
      buffer,
      filename
    );

    if (!text || text.trim().length < 50) {
      throw new Error("Document appears to be empty or too short");
    }
    const relevanceCheck = isUKLegalDocument(text, filename);

    if (!relevanceCheck.isRelevant) {
      throw new Error(
        `This document doesn't appear to be related to UK legal matters. I specialize in UK employment law, contracts, and legal documents. Please upload UK legal documents or ask general UK legal questions.`
      );
    }

    // Analyze content
    const analysis = await analyzeDocumentContent(text, filename);

    analysis.ukLegalRelevance = relevanceCheck;

    // Save to database
    const document = new UploadedDocument({
      sessionId,
      userId,
      filename: `doc_${Date.now()}_${filename}`,
      originalFilename: filename,
      extractedText: text,
      summary: analysis.summary,
      fileType: filename.split(".").pop().toLowerCase(),
      fileSize: buffer.length,
      documentType: analysis.documentType,
      metadata: {
        ...extractionMetadata,
        ...analysis,
        uploadedAt: new Date().toISOString(),
      },
    });

    await document.save();

    console.log(` Document saved: ${document._id}`);

    return {
      documentId: document._id,
      filename: document.originalFilename,
      documentType: document.documentType,
      summary: document.summary,
      wordCount: analysis.wordCount,
      extractedText: text, // Return for immediate use
    };
  } catch (error) {
    console.error("Document processing error:", error);
    throw new Error(`Document processing failed: ${error.message}`);
  }
}

// Get all documents for a session
async function getSessionDocuments(sessionId, userId) {
  try {
    const documents = await UploadedDocument.find({
      sessionId,
      userId,
      isActive: true,
    }).sort({ createdAt: -1 });

    return documents.map((doc) => ({
      id: doc._id,
      filename: doc.originalFilename,
      documentType: doc.documentType,
      summary: doc.summary,
      wordCount: doc.metadata?.wordCount || 0,
      uploadedAt: doc.createdAt,
      extractedText: doc.extractedText,
    }));
  } catch (error) {
    console.error("Error fetching session documents:", error);
    return [];
  }
}

// Create enhanced context from documents
async function createDocumentContext(documents, userQuery, maxTokens = 6000) {
  if (!documents || documents.length === 0) {
    return null;
  }

  // Always include document overview
  const overview = documents
    .map(
      (doc, index) =>
        `${index + 1}. ${doc.filename} (${doc.documentType}) - ${doc.summary}`
    )
    .join("\n");

  let context = `UPLOADED DOCUMENTS OVERVIEW:\n${overview}\n\n`;

  // Calculate remaining token budget for detailed content
  const overviewTokens = Math.ceil(context.length / 4);
  const remainingTokens = maxTokens - overviewTokens - 500; // Reserve 500 for user query

  // Find most relevant documents using simple keyword matching
  const relevantDocs = findRelevantDocuments(documents, userQuery);

  // Add detailed content from most relevant documents
  let usedTokens = 0;
  const detailedContent = [];

  for (const doc of relevantDocs) {
    const docTokens = Math.ceil(doc.extractedText.length / 4);

    if (usedTokens + docTokens < remainingTokens) {
      detailedContent.push(
        `CONTENT FROM ${doc.filename.toUpperCase()}:\n${doc.extractedText}`
      );
      usedTokens += docTokens;
    } else {
      // Include partial content if space allows
      const availableChars = (remainingTokens - usedTokens) * 4 - 100;
      if (availableChars > 200) {
        const partialContent =
          doc.extractedText.substring(0, availableChars) + "...";
        detailedContent.push(
          `CONTENT FROM ${doc.filename.toUpperCase()} (partial):\n${partialContent}`
        );
      }
      break;
    }
  }

  if (detailedContent.length > 0) {
    context += `RELEVANT DOCUMENT CONTENT:\n${detailedContent.join(
      "\n\n---\n\n"
    )}`;
  }

  return context;
}

// Find documents most relevant to user query
function findRelevantDocuments(documents, userQuery) {
  const queryWords = userQuery
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 3);

  // Score documents based on keyword overlap
  const scored = documents.map((doc) => {
    const docText = (doc.extractedText + " " + doc.summary).toLowerCase();
    const matchingWords = queryWords.filter((word) => docText.includes(word));
    const score = matchingWords.length / Math.max(queryWords.length, 1);

    // Boost score for employment contracts and agreements
    if (
      doc.documentType.includes("contract") ||
      doc.documentType.includes("agreement")
    ) {
      return { ...doc, score: score + 0.2 };
    }

    return { ...doc, score };
  });

  // Sort by relevance score and return top documents
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((doc) => doc.score > 0.1) // Only include docs with some relevance
    .slice(0, 3); // Max 3 documents for detailed content
}

// Check if query is likely about uploaded documents
function isQueryAboutDocuments(query, documents) {
  if (!documents || documents.length === 0) return false;

  const queryLower = query.toLowerCase();

  // Direct document references
  const documentRefs = [
    "this document",
    "the document",
    "this contract",
    "the contract",
    "this agreement",
    "the agreement",
    "uploaded",
    "above",
    "according to this",
    "in this",
    "document says",
  ];

  if (documentRefs.some((ref) => queryLower.includes(ref))) {
    return true;
  }

  // Check for content overlap
  const queryWords = queryLower.split(/\s+/).filter((word) => word.length > 3);
  const allDocText = documents
    .map((d) => d.summary + " " + d.extractedText.substring(0, 500))
    .join(" ")
    .toLowerCase();

  const matchingWords = queryWords.filter((word) => allDocText.includes(word));
  return matchingWords.length / Math.max(queryWords.length, 1) > 0.3;
}
function isUKLegalDocument(text, filename) {
  const textLower = text.toLowerCase();
  const filenameLower = filename.toLowerCase();

  // UK-specific legal legislation and acts
  const ukLegislation = [
    "employment rights act",
    "equality act",
    "human rights act",
    "data protection act",
    "health and safety at work act",
    "working time regulations",
    "minimum wage act",
    "trade union and labour relations act",
    "sex discrimination act",
    "race relations act",
    "disability discrimination act",
    "age discrimination regulations",
    "maternity and parental leave",
    "employment relations act",
    "employment act",
    "companies act",
    "insolvency act",
    "consumer rights act",
    "unfair contract terms act",
    "sale of goods act",
    "supply of goods and services act",
    "misrepresentation act",
    "contract terms act",
    "limitation act",
    "tort claims",
    "negligence claims",
    "gdpr",
    "uk gdpr",
    "freedom of information act",
    "public interest disclosure act",
    "whistleblowing",
    "transfer of undertakings",
    "tupe",
    "redundancy payments act",
    "pension schemes act",
  ];

  // UK legal institutions and bodies
  const ukLegalBodies = [
    "employment tribunal",
    "employment appeal tribunal",
    "county court",
    "high court",
    "court of appeal",
    "supreme court",
    "crown court",
    "magistrates court",
    "acas",
    "advisory conciliation and arbitration service",
    "hse",
    "health and safety executive",
    "equality and human rights commission",
    "information commissioner",
    "ico",
    "companies house",
    "hmrc",
    "her majesty's revenue and customs",
    "department for work and pensions",
    "citizens advice",
    "law society",
    "solicitors regulation authority",
    "bar council",
    "legal ombudsman",
    "financial ombudsman",
    "pensions ombudsman",
    "housing ombudsman",
    "tribunal service",
    "ministry of justice",
    "crown prosecution service",
    "serious fraud office",
  ];

  // UK employment and workplace terms
  const ukEmploymentTerms = [
    "contract of employment",
    "employment contract",
    "service agreement",
    "consultancy agreement",
    "zero hours contract",
    "fixed term contract",
    "permanent contract",
    "temporary contract",
    "notice period",
    "probationary period",
    "statutory notice",
    "garden leave",
    "unfair dismissal",
    "wrongful dismissal",
    "constructive dismissal",
    "summary dismissal",
    "redundancy",
    "redundancy pay",
    "redundancy consultation",
    "collective redundancy",
    "disciplinary procedure",
    "disciplinary action",
    "grievance procedure",
    "grievance policy",
    "statutory sick pay",
    "ssp",
    "statutory maternity pay",
    "smp",
    "statutory paternity pay",
    "shared parental leave",
    "adoption leave",
    "carers leave",
    "bereavement leave",
    "annual leave",
    "holiday entitlement",
    "bank holidays",
    "working time directive",
    "rest breaks",
    "night work",
    "maximum working week",
    "48 hour week",
    "national minimum wage",
    "national living wage",
    "apprentice minimum wage",
    "overtime pay",
    "holiday pay",
    "equal pay",
    "pay equity",
    "salary sacrifice",
    "workplace pension",
    "auto enrolment",
    "pension contributions",
    "nest pension",
    "performance management",
    "capability procedure",
    "performance improvement plan",
    "flexible working",
    "part time work",
    "job sharing",
    "compressed hours",
    "work from home",
    "remote working",
    "hybrid working",
    "right to disconnect",
  ];

  // UK legal procedures and concepts
  const ukLegalConcepts = [
    "without prejudice",
    "subject to contract",
    "in good faith",
    "reasonably practicable",
    "reasonable adjustments",
    "duty of care",
    "vicarious liability",
    "joint and several liability",
    "limitation period",
    "statute of limitations",
    "statutory rights",
    "common law rights",
    "implied terms",
    "express terms",
    "fundamental breach",
    "material breach",
    "mitigation of loss",
    "liquidated damages",
    "unliquidated damages",
    "nominal damages",
    "injunctive relief",
    "specific performance",
    "rescission",
    "rectification",
    "estoppel",
    "promissory estoppel",
    "proprietary estoppel",
    "equitable remedies",
    "fiduciary duty",
    "conflict of interest",
    "confidentiality",
    "non disclosure agreement",
    "restraint of trade",
    "restrictive covenant",
    "non compete clause",
    "garden leave clause",
    "intellectual property",
    "copyright",
    "trademark",
    "patent",
    "design rights",
    "data subject rights",
    "data controller",
    "data processor",
    "personal data",
    "sensitive personal data",
    "right to be forgotten",
    "data breach",
    "privacy notice",
  ];

  // UK discrimination and equality terms
  const ukEqualityTerms = [
    "protected characteristics",
    "age discrimination",
    "disability discrimination",
    "race discrimination",
    "sex discrimination",
    "gender discrimination",
    "sexual orientation discrimination",
    "religion discrimination",
    "belief discrimination",
    "marriage discrimination",
    "civil partnership",
    "pregnancy discrimination",
    "maternity discrimination",
    "gender reassignment",
    "direct discrimination",
    "indirect discrimination",
    "harassment",
    "victimisation",
    "reasonable adjustments",
    "auxiliary aids",
    "accessibility",
    "positive action",
    "occupational requirement",
    "genuine occupational qualification",
    "equal pay claim",
    "equal value claim",
    "job evaluation",
    "like work",
    "work of equal value",
  ];

  // UK health and safety terms
  const ukHealthSafetyTerms = [
    "health and safety policy",
    "risk assessment",
    "hazard identification",
    "safety management",
    "accident reporting",
    "near miss reporting",
    "riddor",
    "reporting of injuries diseases",
    "safety representative",
    "safety committee",
    "safety consultation",
    "safety training",
    "personal protective equipment",
    "ppe",
    "safe system of work",
    "method statement",
    "permit to work",
    "lone working",
    "display screen equipment",
    "dse assessment",
    "manual handling",
    "lifting operations",
    "working at height",
    "confined spaces",
    "noise at work",
    "vibration",
    "hazardous substances",
    "coshh assessment",
    "fire safety",
    "emergency procedures",
    "first aid",
    "occupational health",
    "workplace stress",
    "mental health",
    "wellbeing",
    "ergonomics",
  ];

  // UK geographical and currency indicators
  const ukGeographicalTerms = [
    "england",
    "scotland",
    "wales",
    "northern ireland",
    "united kingdom",
    "great britain",
    "london",
    "birmingham",
    "manchester",
    "edinburgh",
    "cardiff",
    "belfast",
    "yorkshire",
    "lancashire",
    "kent",
    "surrey",
    "essex",
    "devon",
    "cornwall",
    "midlands",
    "north west",
    "south east",
    "south west",
    "north east",
    "east midlands",
    "west midlands",
    "east of england",
    "isle of wight",
    "isle of man",
    "channel islands",
  ];

  const ukCurrencyTerms = [
    "£",
    "pounds",
    "pence",
    "gbp",
    "sterling",
    "pound sterling",
    "british pounds",
  ];

  // UK legal professional terms
  const ukLegalProfessionals = [
    "solicitor",
    "barrister",
    "counsel",
    "queen's counsel",
    "qc",
    "king's counsel",
    "kc",
    "chambers",
    "law firm",
    "legal executive",
    "paralegal",
    "trainee solicitor",
    "pupil barrister",
    "legal aid",
    "legal help",
    "legal representation",
    "without prejudice",
    "privileged",
    "client privilege",
    "litigation privilege",
  ];

  // UK business and corporate terms
  const ukBusinessTerms = [
    "limited company",
    "ltd",
    "plc",
    "public limited company",
    "limited liability partnership",
    "llp",
    "sole trader",
    "partnership",
    "community interest company",
    "cic",
    "registered office",
    "companies house number",
    "vat registration",
    "vat number",
    "corporation tax",
    "business rates",
    "employers liability insurance",
    "public liability",
    "professional indemnity",
    "directors and officers",
    "company secretary",
    "memorandum of association",
    "articles of association",
    "shareholders agreement",
    "directors duties",
    "fiduciary duties",
    "statutory accounts",
    "annual return",
  ];

  // Document type indicators
  const documentTypeIndicators = [
    "contract",
    "agreement",
    "policy",
    "procedure",
    "handbook",
    "manual",
    "terms and conditions",
    "service agreement",
    "employment terms",
    "staff handbook",
    "employee handbook",
    "company policy",
    "workplace policy",
    "code of conduct",
    "disciplinary policy",
    "grievance policy",
    "equal opportunities",
    "health and safety policy",
    "data protection policy",
    "privacy policy",
    "whistleblowing policy",
    "anti bribery policy",
    "conflict of interest policy",
    "social media policy",
    "it policy",
    "expense policy",
    "travel policy",
    "settlement agreement",
    "compromise agreement",
    "severance agreement",
    "consultancy agreement",
    "service level agreement",
    "licensing agreement",
    "distribution agreement",
    "agency agreement",
    "franchise agreement",
    "lease agreement",
    "tenancy agreement",
    "rental agreement",
  ];

  // UK legal formatting and structure indicators
  const ukLegalFormatting = [
    "whereas",
    "whereby",
    "herein",
    "hereof",
    "hereto",
    "hereunder",
    "therefor",
    "section",
    "subsection",
    "paragraph",
    "sub paragraph",
    "clause",
    "sub clause",
    "schedule",
    "appendix",
    "annexe",
    "part",
    "chapter",
    "article",
    "this agreement",
    "this contract",
    "the parties",
    "the employer",
    "the employee",
    "the company",
    "the contractor",
    "the consultant",
    "governing law",
    "jurisdiction",
    "disputes",
    "arbitration",
    "mediation",
    "construction",
    "interpretation",
    "definitions",
    "commencement",
    "termination",
    "expiry",
  ];

  // Scoring system
  let relevanceScore = 0;
  let indicators = {
    legislation: 0,
    legalBodies: 0,
    employmentTerms: 0,
    legalConcepts: 0,
    equalityTerms: 0,
    healthSafetyTerms: 0,
    geographical: 0,
    currency: 0,
    legalProfessionals: 0,
    businessTerms: 0,
    documentTypes: 0,
    legalFormatting: 0,
  };

  // Count matches in each category
  const categories = [
    { terms: ukLegislation, key: "legislation", weight: 5 },
    { terms: ukLegalBodies, key: "legalBodies", weight: 4 },
    { terms: ukEmploymentTerms, key: "employmentTerms", weight: 3 },
    { terms: ukLegalConcepts, key: "legalConcepts", weight: 3 },
    { terms: ukEqualityTerms, key: "equalityTerms", weight: 3 },
    { terms: ukHealthSafetyTerms, key: "healthSafetyTerms", weight: 3 },
    { terms: ukGeographicalTerms, key: "geographical", weight: 2 },
    { terms: ukCurrencyTerms, key: "currency", weight: 2 },
    { terms: ukLegalProfessionals, key: "legalProfessionals", weight: 3 },
    { terms: ukBusinessTerms, key: "businessTerms", weight: 2 },
    { terms: documentTypeIndicators, key: "documentTypes", weight: 1 },
    { terms: ukLegalFormatting, key: "legalFormatting", weight: 1 },
  ];

  categories.forEach((category) => {
    const matches = category.terms.filter(
      (term) => textLower.includes(term) || filenameLower.includes(term)
    );

    if (matches.length > 0) {
      indicators[category.key] = matches.length;
      relevanceScore += Math.min(matches.length, 3) * category.weight; // Cap matches per category
    }
  });

  // Bonus points for multiple categories
  const categoriesWithMatches = Object.values(indicators).filter(
    (count) => count > 0
  ).length;
  if (categoriesWithMatches >= 3) relevanceScore += 5;
  if (categoriesWithMatches >= 5) relevanceScore += 10;

  // Filename bonus
  if (
    filenameLower.includes("contract") ||
    filenameLower.includes("employment") ||
    filenameLower.includes("agreement") ||
    filenameLower.includes("policy")
  ) {
    relevanceScore += 3;
  }

  // Strong UK indicators (must have at least one)
  const hasStrongUKIndicator =
    indicators.legislation > 0 ||
    indicators.legalBodies > 0 ||
    indicators.geographical > 0 ||
    indicators.currency > 0 ||
    (indicators.employmentTerms > 2 && indicators.legalConcepts > 1);


  // Determine relevance
  const isRelevant = relevanceScore >= 8 && hasStrongUKIndicator;

  // Generate warnings/suggestions
  const warnings = [];
  if (relevanceScore < 8) {
    warnings.push("Document may not contain sufficient UK legal content");
  }
  if (!hasStrongUKIndicator) {
    warnings.push("Document lacks clear UK legal indicators");
  }
  if (indicators.documentTypes === 0) {
    warnings.push("Document type not clearly identifiable as legal document");
  }

  return {
    isRelevant,
    score: relevanceScore,
    indicators,
    categoriesMatched: categoriesWithMatches,
    hasStrongUKIndicator,
    warnings,
    suggestions: !isRelevant
      ? [
          "Ensure document relates to UK employment law, contracts, or policies",
          "Check document contains UK legal terms, legislation references, or UK institutions",
          "Verify document is in English and uses UK legal language",
        ]
      : [],
  };
}

module.exports = {
  processUploadedDocument,
  getSessionDocuments,
  createDocumentContext,
  isQueryAboutDocuments,
  extractTextFromFile,
  isUKLegalDocument,
  findRelevantDocuments,
};
