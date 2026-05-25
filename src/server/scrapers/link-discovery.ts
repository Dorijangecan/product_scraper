import * as cheerio from "cheerio";
import { catalogTextMatches, compactCatalogNumber } from "./catalog-number.js";
import { cleanText } from "./normalizer.js";

export interface ProductLinkCandidate {
  url: string;
  score: number;
  reason: string;
}

export interface ProductLinkDiscoveryResult {
  candidates: ProductLinkCandidate[];
  rejected: ProductLinkCandidate[];
}

export function findBestProductLink(html: string, baseUrl: string, catalogNumber: string): string | undefined {
  return discoverProductLinks(html, baseUrl, catalogNumber)[0]?.url;
}

export function discoverProductLinks(html: string, baseUrl: string, catalogNumber: string): ProductLinkCandidate[] {
  return discoverProductLinksWithDiagnostics(html, baseUrl, catalogNumber).candidates;
}

export function discoverProductLinksWithDiagnostics(html: string, baseUrl: string, catalogNumber: string): ProductLinkDiscoveryResult {
  if (!html || !baseUrl) return { candidates: [], rejected: [] };
  const $ = cheerio.load(html);
  const candidates = new Map<string, ProductLinkCandidate>();
  const rejected = new Map<string, ProductLinkCandidate>();

  const addCandidate = (rawUrl: string | undefined, context: string, reason: string, baseScore = 0) => {
    const url = normalizeCandidateUrl(rawUrl, baseUrl);
    if (!url || url === normalizeCandidateUrl(baseUrl, baseUrl)) return;
    if (!candidateConfirmsCatalog(url, context, catalogNumber)) {
      addRejected(url, 0, `${reason}: no exact catalog identity`);
      return;
    }
    const score = scoreProductLink(url, context, catalogNumber, baseScore);
    if (score < 35) {
      addRejected(url, score, `${reason}: low score`);
      return;
    }
    const key = uniqueLinkKey(url);
    const existing = candidates.get(key);
    if (!existing || score > existing.score) {
      candidates.set(key, { url, score, reason });
    }
  };

  const addRejected = (url: string, score: number, reason: string) => {
    const key = uniqueLinkKey(url);
    if (!rejected.has(key)) rejected.set(key, { url, score, reason });
  };

  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).text();
    for (const product of readJsonLdProducts(raw)) {
      const context = cleanText([product.sku, product.mpn, product.name, product.description].map(String).join(" "));
      addCandidate(String(product.url ?? ""), context, "json-ld product url", 30);
    }
  });

  $("link[rel='canonical'][href], meta[property='og:url'][content], meta[name='twitter:url'][content]").each((_, element) => {
    const rawUrl = $(element).attr("href") || $(element).attr("content");
    const context = cleanText([$("h1").first().text(), $("title").first().text(), $("meta[name='description']").attr("content")].filter(Boolean).join(" "));
    addCandidate(rawUrl, context, "canonical/meta product url", 25);
  });

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const context = cleanText(
      [
        $(element).text(),
        $(element).attr("title"),
        $(element).attr("aria-label"),
        $(element).find("img").attr("alt"),
        $(element).closest("tr,li,article,.product,.product-card,.product-list,.search-result,.result,.card").text()
      ]
        .filter(Boolean)
        .join(" ")
    );
    addCandidate(href, context, "anchor");
  });

  const decoded = html.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const compactPart = compactCatalogNumber(catalogNumber).toLowerCase();
  if (compactPart) {
    const urlPattern = /https?:\/\/[^"'<>\s)]+|\/[a-z0-9][^"'<>\s)]*/gi;
    for (const match of decoded.matchAll(urlPattern)) {
      const rawUrl = match[0];
      if (!compactCatalogNumber(rawUrl).toLowerCase().includes(compactPart)) continue;
      addCandidate(rawUrl, rawUrl, "inline url", 10);
    }
  }

  return {
    candidates: [...candidates.values()].sort((left, right) => right.score - left.score || left.url.length - right.url.length).slice(0, 8),
    rejected: [...rejected.values()].sort((left, right) => right.score - left.score || left.url.length - right.url.length).slice(0, 20)
  };
}

function candidateConfirmsCatalog(url: string, context: string, catalogNumber: string): boolean {
  return (
    catalogTextMatches(`${url} ${context}`, catalogNumber, { compact: true, afterColon: true }) ||
    pathContainsExactCatalogSegment(url, catalogNumber)
  );
}

function scoreProductLink(url: string, context: string, catalogNumber: string, baseScore: number): number {
  const haystack = `${url} ${context}`;
  const lowerUrl = url.toLowerCase();
  let score = baseScore;

  if (catalogTextMatches(haystack, catalogNumber, { compact: true, afterColon: true })) score += 55;
  if (catalogTextMatches(url, catalogNumber, { compact: true, afterColon: true })) score += 25;
  if (pathContainsExactCatalogSegment(url, catalogNumber)) score += 50;
  if (/\b(product|products|sku|catalog|detail|details|pdp|partnumber_info|skupage)\b|\/p\/|\/item\//i.test(lowerUrl)) score += 25;
  if (/\b(view|details?|product|catalog|part number|sku)\b/i.test(context)) score += 10;
  if (/[?&](?:q|query|search|s|term)=/i.test(lowerUrl)) score -= 15;
  if (/\b(cart|login|account|support|contact|news|blog|privacy|terms|download|pdf|image|thumbnail)\b/i.test(lowerUrl)) score -= 35;
  if (/\.(?:pdf|zip|dwg|dxf|stp|step|png|jpe?g|webp)(?:[?#]|$)/i.test(lowerUrl)) score -= 50;

  return score;
}

function normalizeCandidateUrl(rawUrl: string | undefined, baseUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  const cleaned = rawUrl.trim().replace(/\\u002f/gi, "/").replace(/\\u0026/gi, "&").replace(/&amp;/gi, "&");
  if (!cleaned || /^(?:javascript|mailto|tel|data):/i.test(cleaned)) return undefined;
  try {
    const parsed = new URL(cleaned, baseUrl);
    parsed.hash = "";
    canonicalizeProductCandidateUrl(parsed);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function canonicalizeProductCandidateUrl(parsed: URL) {
  if (/balluff\.com(?:\.cn)?$/i.test(parsed.hostname) && /\/products\/[^/]+\/?$/i.test(parsed.pathname)) {
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:pm|pf)$|^attrs\[/i.test(key)) parsed.searchParams.delete(key);
    }
  }
}

function pathContainsExactCatalogSegment(url: string, catalogNumber: string): boolean {
  try {
    const parsed = new URL(url);
    const compactPart = compactCatalogNumber(catalogNumber);
    return parsed.pathname
      .split("/")
      .map((part) => compactCatalogNumber(decodeURIComponent(part)))
      .some((part) => part === compactPart);
  } catch {
    return false;
  }
}

function uniqueLinkKey(url: string): string {
  try {
    const parsed = new URL(url);
    const keepParams = new URLSearchParams();
    for (const [key, value] of parsed.searchParams.entries()) {
      if (/^(?:q|query|search|term|utm_|fbclid|gclid)/i.test(key)) continue;
      keepParams.set(key, value);
    }
    parsed.search = keepParams.toString();
    return parsed.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function readJsonLdProducts(raw: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return flattenJsonLd(parsed).filter((entry) => {
      const type = entry["@type"];
      return type === "Product" || (Array.isArray(type) && type.includes("Product"));
    });
  } catch {
    return [];
  }
}

function flattenJsonLd(value: unknown): Record<string, unknown>[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const graph = Array.isArray(record["@graph"]) ? flattenJsonLd(record["@graph"]) : [];
  return [record, ...graph];
}
