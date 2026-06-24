import * as cheerio from "cheerio";
import type { DocumentRecord, SourceRecord } from "../../shared/types.js";
import { catalogTextMatches } from "./catalog-number.js";
import { documentUrlLooksDownloadable, documentUrlLooksRelevant } from "./document-url.js";
import { classifyDocument, cleanText } from "./normalizer.js";

export interface SourceDocumentDiscoveryResult {
  documents: DocumentRecord[];
  rejected: Array<{ url: string; score: number; reason: string }>;
}

export function discoverSourceDocumentsWithDiagnostics(
  text: string,
  baseUrl: string,
  catalogNumber: string,
  options: { sourceType?: SourceRecord["sourceType"]; parser?: string; stage?: string } = {}
): SourceDocumentDiscoveryResult {
  if (!text || !baseUrl) return { documents: [], rejected: [] };
  const documents = new Map<string, { document: DocumentRecord; score: number }>();
  const rejected = new Map<string, { url: string; score: number; reason: string }>();
  const sourceType = options.sourceType ?? "official-fallback";
  const parser = options.parser ?? "source-document-discovery";
  const stage = options.stage ?? "document-discovery";
  const baseUrlConfirmsCatalog = /search/i.test(stage) && catalogTextMatches(baseUrl, catalogNumber, { compact: true, afterColon: true, ignoreCase: true });

  const addRejected = (url: string, score: number, reason: string) => {
    const key = canonicalDocumentKey(url);
    if (!rejected.has(key)) rejected.set(key, { url, score, reason });
  };

  const add = (rawUrl: unknown, rawLabel: unknown, rawContext: unknown, reason: string, baseScore = 0) => {
    const url = typeof rawUrl === "string" ? toAbsoluteUrl(cleanUrl(rawUrl), baseUrl) : undefined;
    if (!url) return;
    const label = cleanText(String(rawLabel ?? "")) || documentLabelFromUrl(url);
    const context = cleanText([label, rawContext, url].filter(Boolean).join(" "));
    if (!catalogTextMatches(context, catalogNumber, { compact: true, afterColon: true, ignoreCase: true }) && !baseUrlConfirmsCatalog) {
      addRejected(url, 0, `${reason}: no exact catalog identity`);
      return;
    }
    const type = classifyDocument(label || context, url);
    if (!documentUrlLooksRelevant(url, context, type) && !documentUrlLooksDownloadable(url)) {
      addRejected(url, 5, `${reason}: not a relevant technical document`);
      return;
    }
    const score = scoreDocumentCandidate(url, context, type, baseScore);
    if (score < 35) {
      addRejected(url, score, `${reason}: low document score`);
      return;
    }
    const key = canonicalDocumentKey(url);
    const existing = documents.get(key);
    if (!existing || score > existing.score) {
      documents.set(key, {
        score,
        document: {
          type,
          label: label || documentLabelFromUrl(url),
          url,
          sourceUrl: baseUrl,
          sourceType,
          parser,
          stage,
          confidence: Math.min(0.86, Math.max(0.48, score / 100))
        }
      });
    }
  };

  const $ = cheerio.load(text);
  $("a[href],area[href]").each((_, element) => {
    const href = $(element).attr("href");
    const context = cleanText(
      [
        $(element).text(),
        $(element).attr("title"),
        $(element).attr("aria-label"),
        $(element).find("img").attr("alt"),
        $(element).closest("tr,li,article,.product,.product-card,.search-result,.result,.card,.resource,.download").text()
      ]
        .filter(Boolean)
        .join(" ")
    );
    add(href, $(element).text() || $(element).attr("title") || $(element).attr("aria-label"), context, "anchor document", 28);
  });

  $("[data-url],[data-href],[data-file],[data-download],[data-document-url],[data-datasheet-url],[data-manual-url],[data-resource-url],button[formaction],form[action]").each((_, element) => {
    const attrs = element.attribs ?? {};
    const context = cleanText(
      [
        $(element).text(),
        $(element).attr("title"),
        $(element).attr("aria-label"),
        $(element).closest("tr,li,article,.product,.product-card,.search-result,.result,.card,.resource,.download,form").text()
      ]
        .filter(Boolean)
        .join(" ")
    );
    for (const [name, value] of Object.entries(attrs)) {
      if (!/^(?:data-(?:url|href|file|download|document-url|datasheet-url|manual-url|resource-url)|href|action|formaction)$/i.test(name)) continue;
      add(value, $(element).text() || name, context, `element ${name} document`, 22);
    }
  });

  const decoded = text
    .replace(/\\u002f/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
  for (const entry of inlineDocumentUrlValues(decoded)) {
    const context = inlineContext(decoded, entry.index, entry.value.length);
    add(entry.value, entry.label, context, `inline ${entry.key} document`, 20);
  }
  for (const match of decoded.matchAll(/https?:\/\/[^"'<>\s)]+|\/[a-z0-9][^"'<>\s)]*/gi)) {
    const rawUrl = match[0];
    if (!looksDocumentish(rawUrl)) continue;
    const context = inlineContext(decoded, match.index ?? 0, rawUrl.length);
    add(rawUrl, documentLabelFromUrl(rawUrl), context, "inline document url", 14);
  }

  return {
    documents: [...documents.values()]
      .sort((left, right) => right.score - left.score || left.document.url.length - right.document.url.length)
      .map((entry) => entry.document)
      .slice(0, 12),
    rejected: [...rejected.values()].sort((left, right) => right.score - left.score || left.url.length - right.url.length).slice(0, 24)
  };
}

function inlineDocumentUrlValues(text: string): Array<{ key: string; value: string; label?: string; index: number }> {
  const values: Array<{ key: string; value: string; label?: string; index: number }> = [];
  const pattern =
    /["']?(url|href|downloadUrl|documentUrl|datasheetUrl|manualUrl|fileUrl|mediaUrl|resourceUrl|assetUrl|file|filename|path)["']?\s*:\s*["']([^"'<>]+)["']/gi;
  for (const match of text.matchAll(pattern)) {
    const key = match[1];
    const value = cleanUrl(match[2]);
    if (!value || !looksDocumentish(value)) continue;
    values.push({ key, value, label: documentLabelFromUrl(value), index: match.index ?? 0 });
  }
  return values;
}

function scoreDocumentCandidate(url: string, context: string, type: DocumentRecord["type"], baseScore: number): number {
  let score = baseScore;
  const text = `${context} ${url}`;
  if (documentUrlLooksDownloadable(url)) score += 35;
  if (type === "datasheet") score += 28;
  if (type === "manual") score += 18;
  if (/\b(?:data\s*sheet|datasheet|technical\s+(?:data|sheet|catalog|information)|spec(?:ification)?\s*sheet|catalogue?|catalog)\b/i.test(text)) score += 24;
  if (/\b(?:manual|instruction|installation|user\s+guide)\b/i.test(text)) score += 12;
  if (/\b(?:certificate|declaration|conformity|rohs|reach|weee|warranty|terms|privacy|cookie)\b/i.test(text)) score -= 22;
  return Math.max(0, Math.min(120, score));
}

function looksDocumentish(value: string): boolean {
  return (
    documentUrlLooksDownloadable(value) ||
    /\.(?:pdf|zip|dwg|dxf|stp|step|igs|iges)(?:[?#&]|$)/i.test(value) ||
    /\b(?:download|document|datasheet|data-sheet|manual|catalog|technical|specification|resource)\b/i.test(value)
  );
}

function inlineContext(text: string, index: number, length: number): string {
  return cleanText(text.slice(Math.max(0, index - 320), Math.min(text.length, index + length + 320)));
}

function cleanUrl(value: string): string {
  return value.trim().replace(/\\u002f/gi, "/").replace(/\\u0026/gi, "&").replace(/\\\//g, "/").replace(/&amp;/gi, "&");
}

function toAbsoluteUrl(value: string, baseUrl: string): string | undefined {
  if (!value || /^(?:javascript|mailto|tel|data):/i.test(value)) return undefined;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function documentLabelFromUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://example.test");
    const filename = decodeLoose(parsed.pathname.split("/").pop() ?? "");
    return cleanText(filename.replace(/\.(?:pdf|zip|dwg|dxf|stp|step|igs|iges)$/i, "").replace(/[-_]+/g, " ")) || "Source document";
  } catch {
    return "Source document";
  }
}

function canonicalDocumentKey(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:utm_|fbclid|gclid|sc_|cmp|campaign|source|medium)$/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function decodeLoose(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
