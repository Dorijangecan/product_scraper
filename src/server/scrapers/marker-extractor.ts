import type { AttributeRecord, DocumentRecord, MarkerExtractionRule } from "../../shared/types.js";
import { cleanText } from "./normalizer.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";

export interface MarkerExtractionResult {
  attributes: AttributeRecord[];
  documents: DocumentRecord[];
}

export function extractMarkerData(html: string, rules: MarkerExtractionRule[] | undefined, sourceUrl: string): MarkerExtractionResult {
  if (!rules?.length || !html) return { attributes: [], documents: [] };

  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  for (const rule of rules) {
    if (!rule.name || !rule.start) continue;
    const values = extractBetween(html, rule.start, rule.end, rule.caseSensitive).slice(0, 20);
    for (const rawValue of values) {
      const value = cleanMarkerValue(rawValue);
      if (!value) continue;
      if (rule.documentType) {
        const url = markerUrl(value, rule, sourceUrl);
        if (!url) continue;
        documents.push({
          type: rule.documentType,
          label: cleanText(rule.name),
          url,
          sourceUrl
        });
      } else {
        attributes.push({
          group: cleanText(rule.group) || "Marker Rules",
          name: cleanText(rule.name),
          value,
          sourceUrl
        });
      }
    }
  }

  return {
    attributes: dedupeAttributes(attributes),
    documents: dedupeDocuments(documents)
  };
}

function extractBetween(html: string, start: string, end: string | undefined, caseSensitive: boolean | undefined): string[] {
  const haystack = caseSensitive ? html : html.toLowerCase();
  const startNeedle = caseSensitive ? start : start.toLowerCase();
  const endNeedle = end ? (caseSensitive ? end : end.toLowerCase()) : "";
  const values: string[] = [];
  let cursor = 0;

  while (cursor < html.length && values.length < 100) {
    const startIndex = haystack.indexOf(startNeedle, cursor);
    if (startIndex < 0) break;
    const valueStart = startIndex + start.length;
    const endIndex = endNeedle ? haystack.indexOf(endNeedle, valueStart) : nextLooseBoundary(haystack, valueStart);
    if (endIndex < 0 || endIndex <= valueStart) {
      cursor = valueStart;
      continue;
    }
    values.push(html.slice(valueStart, endIndex));
    cursor = endIndex + Math.max(endNeedle.length, 1);
  }

  return values;
}

function nextLooseBoundary(haystack: string, start: number): number {
  const candidates = ['"', "'", "<", "\n", "\r"].map((token) => haystack.indexOf(token, start)).filter((index) => index >= 0);
  return candidates.length ? Math.min(...candidates) : -1;
}

function cleanMarkerValue(value: string): string {
  return cleanText(
    value
      .replace(/^[^<\n\r]{0,180}>/, "")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u002f/gi, "/")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#(?:039|x27);/gi, "'")
      .replace(/<br\s*\/?>/gi, "; ")
      .replace(/<\/?[^>]+>/g, " ")
  );
}

function markerUrl(value: string, rule: MarkerExtractionRule, sourceUrl: string): string | undefined {
  const rawUrl = `${rule.urlPrefix ?? ""}${value}${rule.urlSuffix ?? ""}`;
  try {
    return new URL(rawUrl, sourceUrl).toString();
  } catch {
    return undefined;
  }
}
