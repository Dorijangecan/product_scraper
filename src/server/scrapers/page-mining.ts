import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, PageMiningRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import { catalogTextMatches } from "./catalog-number.js";
import { classifyDocument, cleanText, splitNameValue } from "./normalizer.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";

export interface PageMiningResult {
  attributes: AttributeRecord[];
  documents: DocumentRecord[];
  record: PageMiningRecord;
}

export interface PageMiningOptions {
  manufacturerId: ProductResult["manufacturerId"];
  catalogNumber: string;
  stage: string;
  method: PageMiningRecord["method"];
  sourceType?: SourceRecord["sourceType"];
  confidence?: number;
}

const PRODUCT_JSON_KEYS = /(?:product|sku|catalog|article|part|mpn|mlfb|technical|spec|attribute|characteristic|classification|document|download|resource|asset|image|media|datasheet|manual)/i;
const USEFUL_LABEL = /(?:weight|mass|dimension|height|width|depth|length|material|voltage|current|protection|ip\s*rating|nema|certificate|approval|standard|color|colour|finish|temperature|type\s*code|model|gtin|ean|tariff|country|origin|mounting|connection|frequency|phase|poles|datasheet|manual|image|cad)/i;
const USEFUL_VALUE = /(?:\d+(?:[.,]\d+)?\s*(?:kg|g|lb|lbs|mm|cm|m|in|inch|v|vac|vdc|a|ma|ka|hz|w|kw|degc|c|°c)|\b(?:IP|IK)\s*\d{2}|\bNEMA\b|\b(?:UL|CE|CSA|RoHS|REACH|WEEE|UKCA|IEC|EN)\b)/i;
const URL_VALUE = /https?:\/\/[^\s"'<>\\]+|\/[A-Za-z0-9][^\s"'<>\\]*/g;
const KNOWN_INLINE_LABELS = [
  "Rated current",
  "Nominal current",
  "Current rating",
  "Rated voltage",
  "Nominal voltage",
  "Supply voltage",
  "Operating voltage",
  "Protection rating",
  "Degree of protection",
  "Material",
  "Dimensions",
  "Height",
  "Width",
  "Depth",
  "Length",
  "Weight",
  "Mass",
  "Color",
  "Colour",
  "Finish",
  "Operating temperature",
  "Ambient temperature",
  "Type code",
  "Model code",
  "GTIN",
  "EAN",
  "Country of origin",
  "Tariff code"
];

export function minePage(fetched: FetchedText, options: PageMiningOptions): PageMiningResult {
  const started = Date.now();
  const $ = cheerio.load(fetched.text);
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const signals = new Set<string>();
  const sourceType = options.sourceType ?? "official-fallback";
  const confidence = options.confidence ?? defaultConfidence(options.method);

  const pushAttribute = (group: string, name: string, value: string, parser = "page-mining") => {
    const cleanName = cleanText(name).replace(/^data[-_ ]/i, "");
    const cleanValue = cleanText(value);
    if (!isUsefulAttribute(cleanName, cleanValue)) return;
    attributes.push({
      group,
      name: cleanName.slice(0, 140),
      value: cleanValue.slice(0, 500),
      sourceUrl: fetched.effectiveUrl,
      sourceType,
      parser,
      stage: options.stage,
      confidence
    });
  };

  const pushDocument = (rawUrl: string | undefined, label: string, context = "") => {
    if (rawUrl && /^\/[a-z][a-z0-9-]*$/i.test(cleanText(rawUrl))) return;
    const absolute = toAbsoluteUrl(rawUrl, fetched.effectiveUrl);
    if (!absolute) return;
    const fullContext = cleanText(`${label} ${context} ${absolute}`);
    const urlType = documentTypeFromUrl(absolute);
    const labelType = classifyDocument(label, absolute);
    const type = isLikelyImageUrl(absolute)
      ? "image"
      : urlType ?? (labelType === "other" ? classifyDocument(fullContext, absolute) : labelType);
    if (type === "other" && !isLikelyDocumentUrl(absolute, fullContext)) return;
    documents.push({
      type,
      label: cleanText(label) || documentLabelFromUrl(absolute),
      url: absolute,
      sourceUrl: fetched.effectiveUrl,
      sourceType,
      parser: "page-mining",
      stage: options.stage,
      confidence
    });
  };

  mineHiddenDom($, pushAttribute, pushDocument, signals);
  mineDataAttributes($, pushAttribute, pushDocument, signals);
  mineImages($, pushDocument, signals);
  mineSemanticKeyValueShapes($, pushAttribute, signals);
  mineCatalogNeighborhood($, fetched.text, options.catalogNumber, pushAttribute, pushDocument, signals);
  mineEmbeddedJson($, fetched.text, options.catalogNumber, pushAttribute, pushDocument, signals);
  mineUrlsInText(fetched.text, pushDocument, signals);

  const cleanAttributes = dedupeAttributes(attributes).slice(0, 240);
  const cleanDocuments = dedupeDocuments(documents).slice(0, 120);
  return {
    attributes: cleanAttributes,
    documents: cleanDocuments,
    record: {
      stage: options.stage,
      url: fetched.effectiveUrl,
      method: options.method,
      attributeCount: cleanAttributes.length,
      documentCount: cleanDocuments.length,
      candidateCount: attributes.length + documents.length,
      usefulAttributeCount: cleanAttributes.length,
      usefulDocumentCount: cleanDocuments.length,
      signals: [...signals].slice(0, 20),
      elapsedMs: Date.now() - started,
      reason: cleanAttributes.length || cleanDocuments.length
        ? "Page mining found additional source-backed candidates."
        : "Page mining did not find useful additional candidates."
    }
  };
}

function mineHiddenDom(
  $: cheerio.CheerioAPI,
  pushAttribute: (group: string, name: string, value: string) => void,
  pushDocument: (url: string | undefined, label: string, context?: string) => void,
  signals: Set<string>
) {
  const selectors = [
    "template",
    "noscript",
    "[hidden]",
    "[aria-hidden='true']",
    "[style*='display:none' i]",
    "[style*='display: none' i]",
    "[style*='visibility:hidden' i]",
    "[class*='collapse' i]",
    "[class*='accordion' i]",
    "[class*='tab' i]",
    "[class*='drawer' i]",
    "[class*='modal' i]"
  ];
  const hidden = $(selectors.join(","));
  if (hidden.length > 250) signals.add("capped:hidden-dom");
  hidden.slice(0, 250).each((_, element) => {
    const text = cleanText($(element).text());
    if (!text || text.length < 8) return;
    signals.add("hidden-dom");
    for (const pair of textPairs(text).slice(0, 20)) {
      pushAttribute("Hidden DOM", pair.name, pair.value);
    }
    const context = cleanText(text.slice(0, 500));
    for (const url of urlsFromText(text)) {
      pushDocument(url, documentLabelFromContext(context, url), context);
    }
  });
}

function mineDataAttributes(
  $: cheerio.CheerioAPI,
  pushAttribute: (group: string, name: string, value: string) => void,
  pushDocument: (url: string | undefined, label: string, context?: string) => void,
  signals: Set<string>
) {
  const allElements = $("*");
  if (allElements.length > 4000) signals.add("capped:data-attributes");
  allElements.slice(0, 4000).each((_, element) => {
    const attrs = (element as unknown as { attribs?: Record<string, string> }).attribs ?? {};
    const context = cleanText($(element).text()).slice(0, 500);
    for (const [name, value] of Object.entries(attrs)) {
      if (!value || value.length > 5000) continue;
      if (/^(?:data|aria)[-_]/i.test(name)) {
        signals.add("data-attributes");
        if (URL_VALUE.test(value) || isLikelyDocumentLabel(name)) {
          pushDocument(value, labelFromAttrName(name), context);
        }
        if (isUsefulAttribute(name, value)) {
          pushAttribute("Data Attributes", name, value);
        }
        URL_VALUE.lastIndex = 0;
      }
      if (/^(?:href|src|poster|action|formaction)$/i.test(name)) {
        pushDocument(value, labelFromAttrName(name), context);
      }
    }
  });
}

function mineImages(
  $: cheerio.CheerioAPI,
  pushDocument: (url: string | undefined, label: string, context?: string) => void,
  signals: Set<string>
) {
  $("img,source,picture,[style*='background' i]").slice(0, 500).each((_, element) => {
    const attrs = (element as unknown as { attribs?: Record<string, string> }).attribs ?? {};
    const context = cleanText([attrs.alt, attrs.title, attrs["aria-label"], $(element).closest("article,li,div,section").text()].filter(Boolean).join(" ")).slice(0, 600);
    const candidates = [
      attrs.src,
      attrs["data-src"],
      attrs["data-original"],
      attrs["data-lazy-src"],
      attrs["data-zoom-image"],
      attrs.poster,
      ...srcsetUrls(attrs.srcset),
      ...srcsetUrls(attrs["data-srcset"]),
      ...backgroundUrls(attrs.style)
    ];
    for (const url of candidates) {
      if (!url || !isLikelyImageUrl(url)) continue;
      signals.add("lazy-images");
      pushDocument(url, attrs.alt || attrs.title || "Product image", context);
    }
  });
}

function mineSemanticKeyValueShapes(
  $: cheerio.CheerioAPI,
  pushAttribute: (group: string, name: string, value: string) => void,
  signals: Set<string>
) {
  const tableRows = $("tr");
  if (tableRows.length > 1200) signals.add("capped:key-value-table");
  tableRows.slice(0, 1200).each((_, element) => {
    const cells = $(element).find("th,td").map((__, cell) => cleanText($(cell).text())).get().filter(Boolean);
    if (cells.length >= 2) {
      signals.add("key-value-table");
      pushAttribute("Mined Table", cells[0], cells.slice(1).join(" | "));
    }
  });

  $("dt").slice(0, 800).each((_, element) => {
    const name = cleanText($(element).text());
    const value = cleanText($(element).next("dd").text());
    if (name && value) {
      signals.add("definition-list");
      pushAttribute("Mined Definition List", name, value);
    }
  });

  $("li,p,div").slice(0, 1800).each((_, element) => {
    const text = cleanText($(element).text());
    if (text.length < 5 || text.length > 300) return;
    const pair = splitNameValue(text);
    if (pair) {
      signals.add("text-pairs");
      pushAttribute("Mined Text Pair", pair.name, pair.value);
    }
  });

  $("h2,h3,h4,h5,h6").slice(0, 300).each((_, element) => {
    const heading = cleanText($(element).text());
    if (!USEFUL_LABEL.test(heading)) return;
    const value = cleanText($(element).nextAll("p,div,ul,table").slice(0, 2).text());
    if (value) {
      signals.add("heading-context");
      for (const pair of textPairs(value).slice(0, 12)) {
        pushAttribute(`Mined ${heading}`.slice(0, 80), pair.name, pair.value);
      }
    }
  });
}

function mineCatalogNeighborhood(
  $: cheerio.CheerioAPI,
  html: string,
  catalogNumber: string,
  pushAttribute: (group: string, name: string, value: string) => void,
  pushDocument: (url: string | undefined, label: string, context?: string) => void,
  signals: Set<string>
) {
  const bodyText = cleanText($("body").text() || html);
  const compactNeedle = catalogNumber.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const compactHaystack = bodyText.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!compactNeedle || !compactHaystack.includes(compactNeedle)) return;
  // The catalog number often appears multiple times (breadcrumb/title, comparison table,
  // spec block). The first occurrence is frequently a heading with no specs next to it, so
  // mine a window around EACH occurrence rather than only the first.
  const occurrences = catalogOccurrenceIndices(bodyText, catalogNumber);
  let processedWindowEnd = -1;
  for (const index of occurrences) {
    // Skip occurrences that fall inside the previous window — they would re-mine the same text.
    if (index <= processedWindowEnd) continue;
    const start = Math.max(0, index - 2000);
    const end = Math.min(bodyText.length, index + 2500);
    processedWindowEnd = end;
    const context = bodyText.slice(start, end);
    if (!catalogTextMatches(context, catalogNumber, { compact: true, ignoreCase: true, afterColon: true })) continue;
    signals.add("catalog-neighborhood");
    for (const pair of textPairs(context).slice(0, 30)) {
      pushAttribute("Catalog Neighborhood", pair.name, pair.value);
    }
    for (const url of urlsFromText(context)) {
      pushDocument(url, documentLabelFromContext(context, url), context);
    }
  }
}

/**
 * Returns the start indices of up to 6 occurrences of the catalog number in the body text.
 * Falls back to a single mid-document window when the number is only present in compacted
 * form (e.g. broken up by markup-stripped whitespace) so we still mine something.
 */
function catalogOccurrenceIndices(bodyText: string, catalogNumber: string): number[] {
  const lowerBody = bodyText.toLowerCase();
  const needle = catalogNumber.toLowerCase();
  const indices: number[] = [];
  let from = 0;
  while (indices.length < 6) {
    const found = lowerBody.indexOf(needle, from);
    if (found < 0) break;
    indices.push(found);
    from = found + needle.length;
  }
  if (indices.length) return indices;
  return [Math.max(0, Math.floor(bodyText.length / 2) - 1200)];
}

function mineEmbeddedJson(
  $: cheerio.CheerioAPI,
  html: string,
  catalogNumber: string,
  pushAttribute: (group: string, name: string, value: string, parser?: string) => void,
  pushDocument: (url: string | undefined, label: string, context?: string) => void,
  signals: Set<string>
) {
  const chunks: string[] = [];
  const scripts = $("script");
  if (scripts.length > 250) signals.add("capped:embedded-json-scripts");
  scripts.slice(0, 250).each((_, element) => {
    const type = String($(element).attr("type") ?? "");
    const id = String($(element).attr("id") ?? "");
    const text = $(element).html() ?? "";
    if (!text || text.length > 900_000) return;
    if (/json|ld\+json/i.test(type) || /NEXT_DATA|NUXT|apollo|redux|state|product|data/i.test(id) || PRODUCT_JSON_KEYS.test(text.slice(0, 5000))) {
      chunks.push(text);
    }
  });
  chunks.push(...extractAssignedJsonChunks(html).slice(0, 30));
  chunks.push(...extractJsonAttributeChunks($).slice(0, 60));

  for (const chunk of chunks.slice(0, 80)) {
    for (const value of parseJsonCandidates(chunk).slice(0, 10)) {
      signals.add("embedded-json");
      flattenJsonValue(value, [], {
        catalogNumber,
        pushAttribute,
        pushDocument,
        seen: new Set()
      });
    }
  }
}

function mineUrlsInText(
  text: string,
  pushDocument: (url: string | undefined, label: string, context?: string) => void,
  signals: Set<string>
) {
  for (const match of text.matchAll(URL_VALUE)) {
    const url = match[0].replace(/[),.;]+$/g, "");
    const index = match.index ?? 0;
    const context = cleanText(text.slice(Math.max(0, index - 180), Math.min(text.length, index + url.length + 180)));
    if (!isLikelyDocumentUrl(url, context) && !isLikelyImageUrl(url)) continue;
    signals.add("text-urls");
    pushDocument(url, documentLabelFromContext(context, url), context);
  }
}

function flattenJsonValue(
  value: unknown,
  path: string[],
  context: {
    catalogNumber: string;
    pushAttribute: (group: string, name: string, value: string, parser?: string) => void;
    pushDocument: (url: string | undefined, label: string, context?: string) => void;
    seen: Set<string>;
  }
) {
  if (path.length > 10 || context.seen.size > 700) return;
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const stringValue = cleanText(String(value));
    if (!stringValue) return;
    const label = path.filter(Boolean).slice(-4).join(" / ") || "Value";
    const key = `${label}|${stringValue}`.toLowerCase();
    if (context.seen.has(key)) return;
    context.seen.add(key);
    if (isLikelyDocumentUrl(stringValue, label) || isLikelyImageUrl(stringValue)) {
      context.pushDocument(stringValue, label, label);
    }
    if (PRODUCT_JSON_KEYS.test(label) || USEFUL_LABEL.test(label) || USEFUL_VALUE.test(stringValue) || catalogTextMatches(stringValue, context.catalogNumber, { compact: true, ignoreCase: true, afterColon: true })) {
      context.pushAttribute("Embedded JSON", label, stringValue, "page-mining-json");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 250).forEach((entry, index) => flattenJsonValue(entry, [...path, String(index)], context));
    return;
  }
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const pairName = firstStringValue(objectValue, ["name", "label", "title", "displayName", "attribute", "key"]);
    const pairValue = firstStringValue(objectValue, ["value", "displayValue", "text", "content"]);
    if (pairName && pairValue && isUsefulAttribute(pairName, pairValue)) {
      context.pushAttribute("Embedded JSON", pairName, pairValue, "page-mining-json");
    }
    const pairUrl = firstStringValue(objectValue, ["url", "href", "downloadUrl", "documentUrl", "assetUrl", "imageUrl", "src"]);
    if (pairUrl) {
      context.pushDocument(pairUrl, pairName ?? path.at(-1) ?? "Resource", pairName ?? path.join(" / "));
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!entryKeyLooksUseful(key, entry) && path.length > 2) continue;
      flattenJsonValue(entry, [...path, key], context);
    }
  }
}

function entryKeyLooksUseful(key: string, value: unknown): boolean {
  if (PRODUCT_JSON_KEYS.test(key) || USEFUL_LABEL.test(key)) return true;
  if (typeof value === "string" && (USEFUL_VALUE.test(value) || isLikelyDocumentUrl(value, key) || isLikelyImageUrl(value))) return true;
  if (Array.isArray(value) && /(?:attributes?|spec|documents?|assets?|images?|media|downloads?)/i.test(key)) return true;
  return typeof value === "object" && value !== null && /(?:product|sku|catalog|item|data|props|state|page)/i.test(key);
}

function parseJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  const trimmed = decodeScriptJson(text.trim());
  for (const chunk of extractJsonParseStringChunks(trimmed).slice(0, 12)) {
    candidates.push(...parseJsonCandidates(chunk));
  }
  for (const candidate of [trimmed, stripJsonAssignment(trimmed)].filter(Boolean)) {
    try {
      pushParsedJsonCandidate(candidates, JSON.parse(candidate));
      continue;
    } catch {
      // Continue with embedded object extraction.
    }
  }
  for (const chunk of extractBalancedJsonChunks(trimmed).slice(0, 20)) {
    try {
      pushParsedJsonCandidate(candidates, JSON.parse(chunk));
    } catch {
      // Ignore non-JSON JavaScript object literals.
    }
  }
  return candidates;
}

function pushParsedJsonCandidate(candidates: unknown[], parsed: unknown) {
  if (typeof parsed === "string" && /^[\s"'`]*[{[]/.test(parsed)) {
    for (const nested of parseJsonCandidates(parsed).slice(0, 4)) {
      candidates.push(nested);
    }
    return;
  }
  candidates.push(parsed);
}

function extractJsonAttributeChunks($: cheerio.CheerioAPI): string[] {
  const chunks: string[] = [];
  $("*").slice(0, 4000).each((_, element) => {
    const attrs = (element as unknown as { attribs?: Record<string, string> }).attribs ?? {};
    for (const [name, rawValue] of Object.entries(attrs)) {
      if (!rawValue || rawValue.length < 20 || rawValue.length > 500_000) continue;
      if (!/^(?:data|aria|x-data|x-bind|wire|v-bind|:)/i.test(name) && !/(?:props|state|json|payload|product|data|config)/i.test(name)) continue;
      const decoded = decodeScriptJson(rawValue);
      if (!/[{[]/.test(decoded) || !PRODUCT_JSON_KEYS.test(`${name} ${decoded.slice(0, 5000)}`)) continue;
      chunks.push(decoded);
      if (chunks.length >= 80) return false;
    }
    return undefined;
  });
  return chunks;
}

function extractJsonParseStringChunks(text: string): string[] {
  const chunks: string[] = [];
  const pattern = /JSON\.parse\(\s*(["'`])((?:\\.|(?!\1).){20,})\1\s*\)/gims;
  for (const match of text.matchAll(pattern)) {
    const decoded = decodeJsStringLiteral(match[2]);
    if (decoded && /[{[]/.test(decoded) && PRODUCT_JSON_KEYS.test(decoded.slice(0, 5000))) {
      chunks.push(decoded);
    }
    if (chunks.length >= 20) break;
  }
  return chunks;
}

function extractAssignedJsonChunks(text: string): string[] {
  const chunks: string[] = [];
  const markers = ["__NEXT_DATA__", "__NUXT__", "__APOLLO_STATE__", "__INITIAL_STATE__", "__REDUX_STATE__", "livewire"];
  for (const marker of markers) {
    let offset = 0;
    while (offset < text.length) {
      const found = text.indexOf(marker, offset);
      if (found < 0) break;
      const start = text.indexOf("{", found);
      if (start < 0) break;
      const chunk = balancedChunk(text, start);
      if (chunk) chunks.push(chunk);
      offset = start + Math.max(1, chunk?.length ?? 1);
    }
  }
  return chunks;
}

function extractBalancedJsonChunks(text: string): string[] {
  const chunks: string[] = [];
  for (const match of text.matchAll(/[{[]/g)) {
    const chunk = balancedChunk(text, match.index ?? 0);
    if (chunk && chunk.length > 20 && chunk.length < 900_000) chunks.push(chunk);
    if (chunks.length >= 20) break;
  }
  return chunks;
}

function balancedChunk(text: string, start: number): string | undefined {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

function stripJsonAssignment(value: string): string {
  const equals = value.indexOf("=");
  if (equals < 0) return value;
  return value.slice(equals + 1).replace(/;\s*$/, "").trim();
}

function decodeScriptJson(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u007b/gi, "{")
    .replace(/\\u007d/gi, "}")
    .replace(/\\u005b/gi, "[")
    .replace(/\\u005d/gi, "]")
    .replace(/\\u0022/g, '"')
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/");
}

function decodeJsStringLiteral(value: string): string {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return decodeScriptJson(value.replace(/\\'/g, "'").replace(/\\`/g, "`"));
  }
}

function textPairs(text: string): Array<{ name: string; value: string }> {
  const pairs: Array<{ name: string; value: string }> = [];
  for (const line of text.split(/\r?\n|[|•]/).map(cleanText).filter(Boolean)) {
    const pair = splitNameValue(line);
    if (pair) pairs.push(pair);
  }
  const inline = cleanText(text);
  const labelPattern = KNOWN_INLINE_LABELS.map(escapeRegExp).join("|").replace(/\\ /g, "\\s+");
  const knownPattern = new RegExp(`\\b(${labelPattern})\\s*[:=]\\s*(.{1,180}?)(?=\\s+(?:${labelPattern})\\s*[:=]|$)`, "gi");
  for (const match of inline.matchAll(knownPattern)) {
    pairs.push({ name: cleanText(match[1]), value: cleanInlineValue(match[2]) });
  }
  for (const match of inline.matchAll(/\b([A-Za-z][A-Za-z0-9 /()[\].+-]{2,70})\s*[:=]\s*([^:;|]{1,180})(?=\s+[A-Za-z][A-Za-z0-9 /()[\].+-]{2,70}\s*[:=]|$)/g)) {
    pairs.push({ name: cleanText(match[1]), value: cleanInlineValue(match[2]) });
  }
  return pairs.filter((pair) => isUsefulAttribute(pair.name, pair.value)).slice(0, 80);
}

function firstStringValue(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      const clean = cleanText(String(value));
      if (clean) return clean;
    }
  }
  return undefined;
}

function cleanInlineValue(value: string): string {
  return cleanText(value)
    .replace(/\s+\b(?:Technical datasheet|Datasheet|Manual|Downloads?|Documents?|Resources?)\b.*$/i, "")
    .trim();
}

function isUsefulAttribute(name: string, value: string): boolean {
  const cleanName = cleanText(name);
  const cleanValue = cleanText(value);
  if (!cleanName || !cleanValue || cleanValue.length < 1 || cleanValue.length > 800) return false;
  if (/^(?:class|style|id|href|src|alt|title|role|target|rel|onclick)$/i.test(cleanName)) return false;
  if (/^(?:true|false|null|undefined|\[\]|\{\})$/i.test(cleanValue)) return false;
  if (cleanName.length > 160) return false;
  return USEFUL_LABEL.test(cleanName) || USEFUL_VALUE.test(cleanValue) || PRODUCT_JSON_KEYS.test(cleanName);
}

function urlsFromText(value: string): string[] {
  return [...value.matchAll(URL_VALUE)].map((match) => match[0].replace(/[),.;]+$/g, ""));
}

function srcsetUrls(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((part) => cleanText(part).split(/\s+/)[0]).filter(Boolean);
}

function backgroundUrls(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/url\((["']?)(.*?)\1\)/gi)].map((match) => cleanText(match[2])).filter(Boolean);
}

function isLikelyImageUrl(url: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|avif|svg)(?:[?#]|$)/i.test(url) || /(?:image|media|asset|product-photo|productimage)/i.test(url);
}

function isLikelyDocumentUrl(url: string, context = ""): boolean {
  if (/^\/[a-z][a-z0-9-]*$/i.test(url)) return false;
  return /\.(?:pdf|zip|dwg|dxf|stp|step|igs|iges|x_t|x_b)(?:[?#]|$)/i.test(url) ||
    /\b(?:download|document|datasheet|data sheet|manual|instruction|certificate|declaration|conformity|cad|drawing|technical|specification|resource)\b/i.test(`${url} ${context}`);
}

function isLikelyDocumentLabel(value: string): boolean {
  return /\b(?:url|href|file|download|document|datasheet|manual|resource|asset|image|media|cad)\b/i.test(value);
}

function labelFromAttrName(name: string): string {
  return cleanText(name.replace(/^data[-_]?/i, "").replace(/[-_]+/g, " ")) || "Resource";
}

function documentLabelFromContext(context: string, url: string): string {
  const type = classifyDocument(context, url);
  if (type === "datasheet") return "Datasheet";
  if (type === "manual") return "Manual";
  if (type === "certificate") return "Certificate";
  if (type === "cad") return "CAD";
  if (isLikelyImageUrl(url)) return "Product image";
  return documentLabelFromUrl(url);
}

function documentLabelFromUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://example.invalid");
    const name = parsed.pathname.split("/").filter(Boolean).at(-1);
    return cleanText(name?.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ")) || "Resource";
  } catch {
    return "Resource";
  }
}

function documentTypeFromUrl(url: string): DocumentRecord["type"] | undefined {
  if (/\b(?:manual|instruction|install(?:ation)?|user-guide)\b/i.test(url)) return "manual";
  if (/\b(?:datasheet|data-sheet|technical-data|spec(?:ification)?-sheet)\b/i.test(url)) return "datasheet";
  if (/\b(?:certificate|certification|declaration|conformity|rohs|reach)\b/i.test(url)) return "certificate";
  if (/\b(?:cad|drawing|dwg|dxf|step|stp|iges)\b/i.test(url)) return "cad";
  return undefined;
}

function toAbsoluteUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  const clean = cleanText(value).replace(/^["']|["']$/g, "");
  if (!clean || clean.startsWith("data:") || clean.startsWith("javascript:") || clean.startsWith("mailto:")) return undefined;
  try {
    const url = new URL(clean, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function defaultConfidence(method: PageMiningRecord["method"]): number {
  if (method === "browser-network") return 0.78;
  if (method === "rendered-dom") return 0.72;
  if (method === "learned-extractor") return 0.74;
  return 0.66;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
