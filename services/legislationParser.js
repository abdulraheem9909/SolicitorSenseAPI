// Turns legislation.gov.uk XML into labelled text pieces and chunks for the knowledge base.
const xml2js = require("xml2js");

// The Acts loaded into the knowledge base
const LEGISLATION_SOURCES = [
  "https://www.legislation.gov.uk/ukpga/1996/18/data.xml", // Employment Rights Act 1996
  "https://www.legislation.gov.uk/uksi/1998/1833/made/data.xml", // Working Time Regulations 1998
  "https://www.legislation.gov.uk/ukpga/1998/42/data.xml", // Human Rights Act 1998
  "https://www.legislation.gov.uk/ukpga/1998/39/data.xml", // National Minimum Wage Act 1998
  "https://www.legislation.gov.uk/ukpga/1999/26/data.xml", // Employment Relations Act 1999
  "https://www.legislation.gov.uk/ukpga/2010/15/data.xml", // Equality Act 2010
  "https://www.legislation.gov.uk/ukpga/2002/22/data.xml", // Employment Act 2002
  "https://www.legislation.gov.uk/ukpga/2009/25/data.xml", // Coroners and Justice Act 2009
  "https://www.legislation.gov.uk/ukpga/1974/37/data.xml", // Health and Safety at Work Act 1974
];

// Map URL patterns to legislation details
const LEGISLATION_MAP = {
  "ukpga/1996/18": { title: "Employment Rights Act 1996", type: "employment", year: 1996 },
  "uksi/1998/1833": { title: "Working Time Regulations 1998", type: "employment", year: 1998 },
  "ukpga/1998/42": { title: "Human Rights Act 1998", type: "human_rights", year: 1998 },
  // idPrefix: another employment Act from 1998 (Working Time Regulations) already uses EMP_1998
  "ukpga/1998/39": { title: "National Minimum Wage Act 1998", type: "employment", year: 1998, idPrefix: "NMW" },
  "ukpga/1999/26": { title: "Employment Relations Act 1999", type: "employment", year: 1999 },
  "ukpga/2010/15": { title: "Equality Act 2010", type: "equality", year: 2010 },
  "ukpga/2002/22": { title: "Employment Act 2002", type: "employment", year: 2002 },
  "ukpga/2009/25": { title: "Coroners and Justice Act 2009", type: "criminal", year: 2009 },
  "ukpga/1974/37": { title: "Health and Safety at Work Act 1974", type: "health_safety", year: 1974 },
};

// Get legislation info from URL
function getLegislationInfo(url) {
  for (const [pattern, info] of Object.entries(LEGISLATION_MAP)) {
    if (url.includes(pattern)) {
      return info;
    }
  }
  return { title: "Unknown Legislation", type: "general", year: null };
}

// Ordered children ($$) keep text and inline elements (<Term>, <Citation>) in document
// order. With the default options, text next to an inline element lands under "_" with
// holes in it, which dropped about two-thirds of the Employment Rights Act.
const PARSE_OPTIONS = {
  explicitChildren: true,
  preserveChildrenOrder: true,
  charsAsChildren: true,
  includeWhiteChars: true,
};

const parseLegislationXml = (xml) => xml2js.parseStringPromise(xml, PARSE_OPTIONS);

// Footnote markers and annotations: not part of the law's text
const NOT_LAW = new Set(["CommentaryRef", "Commentary", "Commentaries"]);

// Nesting depth of numbered provisions: P1 = section 86, P2 = (1), P3 = (a)
const PROVISION_DEPTH = { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

const normalise = (s) => s.replace(/\s+/g, " ").trim();

// Plain text of an element, children in document order
function textOf(node) {
  if (!node || typeof node !== "object") return "";
  if (node["#name"] === "__text__") return node._ || "";
  if (NOT_LAW.has(node["#name"])) return "";
  if (Array.isArray(node.$$)) return node.$$.map(textOf).join("");
  return typeof node._ === "string" ? node._ : "";
}

function getLawRoot(parsed) {
  const legislation = parsed?.Legislation || {};
  if (legislation.Primary) return { root: legislation.Primary[0], label: "Section" };
  if (legislation.Secondary) return { root: legislation.Secondary[0], label: "Regulation" };
  return { root: null, label: "Section" };
}

function getActTitles(parsed) {
  const legislation = parsed?.Legislation || {};
  const prelims =
    legislation.Primary?.[0]?.PrimaryPrelims?.[0] ||
    legislation.Secondary?.[0]?.SecondaryPrelims?.[0];
  return {
    title: normalise(textOf(prelims?.Title?.[0])),
    longTitle: normalise(textOf(prelims?.LongTitle?.[0])),
  };
}

const formatProvision = (label, numbers) => {
  const [first, ...rest] = numbers.filter(Boolean);
  return first ? `${label} ${first}${rest.map((n) => `(${n})`).join("")}` : "";
};

// One piece per <Text> block of the law body, with the section title and provision
// number it sits under. Metadata, commentaries and prelims are never visited.
function extractLegalPieces(parsed) {
  const { root, label } = getLawRoot(parsed);
  if (!root) return [];

  const pieces = [];

  const walk = (node, context) => {
    const name = node["#name"];
    if (!name || name === "__text__" || NOT_LAW.has(name)) return;
    if (name.endsWith("Prelims")) return; // title and long title come from getActTitles
    if (name === "Title" || name === "Pnumber" || name === "Number") return; // read by the parent

    if (name === "Text") {
      const content = normalise(textOf(node));
      if (content && !/^[\d\s.()]+$/.test(content)) {
        pieces.push({ content, context: { section: context.section, provision: context.provision } });
      }
      return;
    }

    const next = { ...context };

    const title = node.Title?.[0];
    if (title) {
      const titleText = normalise(textOf(title));
      if (titleText) next.section = titleText;
    }

    if (name === "Schedule") {
      const scheduleNumber = normalise(textOf(node.Number?.[0]));
      next.label = scheduleNumber ? `${scheduleNumber}, paragraph` : "Schedule paragraph";
      next.numbers = [];
    }

    const depth = PROVISION_DEPTH[name];
    if (depth && node.Pnumber?.[0]) {
      next.numbers = [...context.numbers.slice(0, depth - 1), normalise(textOf(node.Pnumber[0]))];
      next.provision = formatProvision(next.label || label, next.numbers);
    }

    (node.$$ || []).forEach((child) => walk(child, next));
  };

  // The root, read by name, carries no #name; its ordered children do
  const start = { section: "", provision: "", numbers: [], label: null };
  (root.$$ || []).forEach((child) => walk(child, start));
  return pieces;
}

// "[Section 86(1)(b), Section title] text"; the section title can be left out
function formatContentWithContext(item, includeSection = true) {
  const { section, provision } = item.context || {};
  const label = [provision, includeSection ? section : ""].filter(Boolean).join(", ");
  return label ? `[${label}] ${item.content}` : item.content;
}

// Joins whole pieces into chunks of at most maxLength characters (a single piece longer
// than that becomes its own chunk). The section title is repeated only when it changes.
function createCoherentChunks(pieces, maxLength = 1200) {
  const chunks = [];
  let current = null;

  const close = () => {
    if (!current) return;
    const provisions = current.provisions.filter(Boolean);
    const first = provisions[0];
    const last = provisions.at(-1);
    chunks.push({
      text: current.text,
      context: current.context,
      provisions: first === last ? provisions.slice(0, 1) : [first, last],
    });
    current = null;
  };

  for (const item of pieces) {
    const sameSection = current && current.section === item.context.section;
    let formatted = formatContentWithContext(item, !sameSection);

    if (current && current.text.length + 2 + formatted.length > maxLength) {
      close();
      formatted = formatContentWithContext(item, true);
    }

    if (!current) {
      current = { text: formatted, context: item.context, provisions: [item.context.provision] };
    } else {
      current.text += "\n\n" + formatted;
      current.provisions.push(item.context.provision);
    }
    current.section = item.context.section;
  }

  close();
  return chunks;
}

// Process and clean legal text
function processLegalText(text) {
  return (
    text
      // Remove excessive whitespace
      .replace(/\s+/g, " ")
      // Fix common legal formatting issues
      .replace(/\s+([\.,:;])/g, "$1")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      // Ensure proper sentence spacing
      .replace(/([\.!?])\s*([A-Z])/g, "$1 $2")
      // Clean up section references
      .replace(/Section\s+(\d+)/gi, "Section $1")
      .replace(/Part\s+(\d+)/gi, "Part $1")
      .replace(/Chapter\s+(\d+)/gi, "Chapter $1")
      .replace(/Schedule\s+(\d+)/gi, "Schedule $1")
      .trim()
  );
}

// Generate clean, meaningful ID
function generateCleanId(legislationInfo, chunkIndex) {
  const typeMap = {
    employment: "EMP",
    health_safety: "HSW",
    human_rights: "HRA",
    equality: "EQL",
    criminal: "CRM",
    general: "GEN",
  };

  const prefix = legislationInfo.idPrefix || typeMap[legislationInfo.type] || "LEG";
  const year = legislationInfo.year || "0000";
  const paddedIndex = chunkIndex.toString().padStart(3, "0");

  return `${prefix}_${year}_${paddedIndex}`;
}

module.exports = {
  LEGISLATION_SOURCES,
  LEGISLATION_MAP,
  getLegislationInfo,
  parseLegislationXml,
  getActTitles,
  extractLegalPieces,
  formatContentWithContext,
  createCoherentChunks,
  processLegalText,
  generateCleanId,
};
