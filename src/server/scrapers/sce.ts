import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { classifyDocument, cleanText, emptyResult, mergeResults, normalizeFields, splitNameValue } from "./normalizer.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";

const SCE_BASE = "https://www.saginawcontrol.com";

export class SCEConnector implements ManufacturerConnector {
  id = "sce";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    try {
      const searchBody = new URLSearchParams({
        PartNumberSearchString: catalogNumber,
        radio: "Exact",
        PartNumberSubmit: "Search"
      });
      const search = await context.http.fetchText(`${SCE_BASE}/advanced-part-search/`, {
        method: "POST",
        body: searchBody,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal: context.signal
      });
      const detailUrl = findExactDetailUrl(catalogNumber, search.text) ?? `${SCE_BASE}/partnumber_info?n=${encodeURIComponent(catalogNumber)}`;
      const detail = await context.http.fetchText(detailUrl, { signal: context.signal });
      const cad = await context.http.fetchText(`${SCE_BASE}/download-doc/?PartNumber=${encodeURIComponent(catalogNumber)}`, {
        signal: context.signal
      });
      const primary = parseSceProductPage(catalogNumber, detail, search, cad);
      if (primary.status === "failed" || primary.status === "partial") {
        const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
        return mergeResults(primary, fallback);
      }
      return primary;
    } catch (error) {
      const primary = emptyResult("sce", catalogNumber, error instanceof Error ? error.message : "SCE fetch failed.");
      const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
      return mergeResults(primary, fallback);
    }
  }
}

export function parseSceProductPage(catalogNumber: string, detail: FetchedText, search?: FetchedText, cad?: FetchedText): ProductResult {
  const $ = cheerio.load(detail.text);
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const sources: SourceRecord[] = [];
  if (search) {
    sources.push({
      url: search.effectiveUrl,
      sourceType: "official",
      parser: "sce-advanced-part-search",
      fetchedAt: search.fetchedAt,
      statusCode: search.statusCode
    });
    attributes.push(...parseSearchResultAttributes(catalogNumber, search));
  }
  sources.push({
    url: detail.effectiveUrl,
    sourceType: "official",
    parser: "sce-product-page",
    fetchedAt: detail.fetchedAt,
    statusCode: detail.statusCode
  });

  const pageTitle = cleanText($("title").first().text());
  const h1 = cleanText($("h1").first().text());
  const title = (pageTitle.split(" - ")[0] || h1 || catalogNumber).trim();

  $(".prod-details-div").each((_, section) => {
    const group = cleanText($(section).find(".prod-info-header").first().text()) || "Product Details";
    $(section)
      .find(".prod-info-body, li, p")
      .each((__, item) => {
        const text = cleanText($(item).text());
        if (!text || text.length > 1000) return;
        const pair = splitNameValue(text);
        if (pair) {
          attributes.push({ group, ...pair, sourceUrl: detail.effectiveUrl });
          return;
        }
        if (!/also bought|similar part|add to bill/i.test(text)) {
          attributes.push({ group, name: "Detail", value: text, sourceUrl: detail.effectiveUrl });
        }
      });
  });

  $("span.product-dimension").each((index, element) => {
    const value = cleanText($(element).text());
    const labels = ["Height", "Width", "Depth"];
    if (value) attributes.push({ group: "Dimensions", name: labels[index] ?? `Dimension ${index + 1}`, value, sourceUrl: detail.effectiveUrl });
  });

  $("[onmouseover]").each((_, element) => {
    const tip = cleanText($(element).attr("onmouseover"));
    if (/NEMA|IEC|IP|UL|CSA/i.test(tip)) {
      attributes.push({ group: "Industry Standards", name: cleanText($(element).text()) || "Standard", value: tip, sourceUrl: detail.effectiveUrl });
    }
  });

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const absolute = new URL(href, detail.effectiveUrl).toString();
    if (!/\.(pdf|zip|dwg|dxf|stp|step)(\?|$)/i.test(absolute)) return;
    const label = cleanText($(element).text()) || absolute.split("/").pop() || "Document";
    documents.push({
      type: classifyDocument(label, absolute),
      label,
      url: absolute,
      sourceUrl: detail.effectiveUrl
    });
  });

  const imageUrl = findProductImageUrl($, catalogNumber, detail.effectiveUrl);
  if (imageUrl) {
    documents.push({
      type: "image",
      label: "Product image",
      url: imageUrl,
      sourceUrl: detail.effectiveUrl
    });
  }

  if (cad) {
    sources.push({
      url: cad.effectiveUrl,
      sourceType: "official",
      parser: "sce-cad-download-page",
      fetchedAt: cad.fetchedAt,
      statusCode: cad.statusCode
    });
    const $cad = cheerio.load(cad.text);
    const refresh = $cad("meta[http-equiv='Refresh'], meta[http-equiv='refresh']").attr("content");
    const refreshUrl = refresh?.match(/url=([^;]+)/i)?.[1];
    const cadHref = refreshUrl || $cad("a[href*='/download/']").first().attr("href");
    if (cadHref) {
      const cadUrl = new URL(cadHref, cad.effectiveUrl).toString();
      documents.push({
        type: "cad",
        label: `${catalogNumber} CAD package`,
        url: cadUrl,
        sourceUrl: cad.effectiveUrl
      });
    }
  }

  const bodyText = detail.text.toLowerCase();
  const matched = bodyText.includes(catalogNumber.toLowerCase()) && !/search yielded 0 results/i.test(detail.text);
  if (!matched) {
    return {
      ...emptyResult("sce", catalogNumber, "SCE product page did not contain the catalog number."),
      sources
    };
  }

  const cleanAttributes = dedupeAttributes(attributes);
  const cleanDocuments = dedupeDocuments(documents);
  const normalized = normalizeFields(cleanAttributes, cleanDocuments);
  if (!normalized.dimensions) {
    const dimensionMatch = cleanText($.text()).match(/(\d+(?:\.\d+)?H)\s*x\s*(\d+(?:\.\d+)?W)\s*x\s*(\d+(?:\.\d+)?D)/i);
    if (dimensionMatch) normalized.dimensions = `${dimensionMatch[1]} x ${dimensionMatch[2]} x ${dimensionMatch[3]}`;
  }

  return {
    manufacturerId: "sce",
    catalogNumber,
    status: cleanAttributes.length || cleanDocuments.length ? "found" : "partial",
    confidence: 0.9,
    productUrl: detail.effectiveUrl,
    localizedUrls: buildLocalizedProductUrls("sce", catalogNumber, detail.effectiveUrl),
    title,
    description: findDescription($, title),
    normalized,
    attributes: cleanAttributes,
    documents: cleanDocuments,
    sources
  };
}

function findExactDetailUrl(catalogNumber: string, html: string): string | undefined {
  const $ = cheerio.load(html);
  const candidates = $("a.part-link[href*='partnumber_info'], a[href*='partnumber_info']")
    .map((_, element) => {
      const href = $(element).attr("href");
      const text = cleanText($(element).text());
      return href && text.toLowerCase().includes(catalogNumber.toLowerCase()) ? new URL(href, SCE_BASE).toString() : undefined;
    })
    .get()
    .filter(Boolean);
  return candidates[0];
}

function parseSearchResultAttributes(catalogNumber: string, fetched: FetchedText): AttributeRecord[] {
  const $ = cheerio.load(fetched.text);
  const attributes: AttributeRecord[] = [];
  $(".product-archive-li").each((_, element) => {
    const text = cleanText($(element).text());
    if (!text.toLowerCase().includes(catalogNumber.toLowerCase())) return;
    const description = cleanText($(element).find(".part-desc p").first().text());
    if (description) attributes.push({ group: "Search Result", name: "Description", value: description, sourceUrl: fetched.effectiveUrl });
    const dimensions = cleanText($(element).find(".product-dimension").map((__, span) => $(span).text()).get().join(" x "));
    if (dimensions) attributes.push({ group: "Search Result", name: "Dimensions", value: dimensions, sourceUrl: fetched.effectiveUrl });
    const standard = cleanText($(element).find("a[href*='industry-standards']").attr("onmouseover") || $(element).find("a[href*='industry-standards']").text());
    if (standard) attributes.push({ group: "Search Result", name: "Industry Standard", value: standard, sourceUrl: fetched.effectiveUrl });
  });
  return attributes;
}

function findDescription($: cheerio.CheerioAPI, title: string): string | undefined {
  const candidates = [
    cleanText($(".part-desc").first().text()),
    cleanText($(".prod-desc").first().text()),
    cleanText($("meta[name='description']").attr("content"))
  ].filter(Boolean);
  return candidates.find((candidate) => candidate !== title);
}

function findProductImageUrl($: cheerio.CheerioAPI, catalogNumber: string, baseUrl: string): string | undefined {
  const part = catalogNumber.toLowerCase();
  const candidates = $("img[src]")
    .map((_, element) => {
      const src = $(element).attr("src");
      const alt = cleanText($(element).attr("alt"));
      if (!src) return undefined;
      const haystack = `${src} ${alt}`.toLowerCase();
      if (!haystack.includes(part)) return undefined;
      return new URL(src, baseUrl).toString();
    })
    .get()
    .filter(Boolean);
  return candidates[0];
}

function dedupeAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  const seen = new Set<string>();
  return attributes.filter((attr) => {
    const key = `${attr.group ?? ""}|${attr.name}|${attr.value}`.toLowerCase();
    if (!attr.name || !attr.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const seen = new Set<string>();
  return documents.filter((doc) => {
    const key = doc.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
