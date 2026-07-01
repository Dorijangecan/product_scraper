import { sameUrlIgnoringHash as sameUrl } from "../url-util.js";
import { uniqueStrings as uniqueStringsBase } from "../text-util.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sanitize from "sanitize-filename";
import type { DocumentRecord, FallbackSourceConfig, ProductResult } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { dedupeDocuments } from "./dedupe.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";
import { emptyResult } from "./normalizer.js";

const SCHMERSAL_BASE_URL = "https://products.schmersal.com";
const SCHMERSAL_TARGET_LOCALES = [
  { locale: "de-DE", label: "German", code: "SDE" },
  { locale: "en-US", label: "English", code: "SEN" }
] as const;

type SchmersalLocale = (typeof SCHMERSAL_TARGET_LOCALES)[number];

interface SchmersalDocumentApiRecord {
  name?: string;
  url?: string;
  title?: string;
  revision?: string;
  customFields?: Record<string, unknown>;
  translated?: {
    customFields?: Record<string, unknown>;
  };
}

interface SchmersalPageData {
  productId: string;
  dataTabGroups: Array<{ technicalName: string; translatedName?: string } & Record<string, unknown>>;
}

interface AltchaChallenge {
  algorithm: string;
  challenge: string;
  maxnumber: number;
  salt: string;
  signature: string;
}

export class SchmersalConnector implements ManufacturerConnector {
  readonly id = "schmersal";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    let baseResult = await context.fallback.scrape(catalogNumber, schmersalSources(context));
    baseResult = await rescueSchmersalResultFromSearch(catalogNumber, context, baseResult);
    if (!baseResult) {
      const { result, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: this.id });
      if (!result) {
        return withDiscoveryFallbackDiagnostics(
          emptyResult(this.id, catalogNumber, `No Schmersal product page found for ${catalogNumber}.`),
          discovery
        );
      }
      baseResult = withDiscoveryFallbackDiagnostics(result, discovery);
    }

    if (context.imageOnly || context.downloadDocuments === false) {
      return withSchmersalDocuments(baseResult, baseResult.documents.filter((doc) => doc.type === "image"));
    }

    let page = await fetchBestSchmersalPage(baseResult, catalogNumber, context);
    if (!page) {
      const rescued = await rescueSchmersalResultFromSearch(catalogNumber, context, baseResult, { force: true });
      if (rescued && rescued !== baseResult) {
        baseResult = rescued;
        page = await fetchBestSchmersalPage(baseResult, catalogNumber, context);
      }
    }
    if (!page) {
      return withSchmersalDocuments(baseResult, baseResult.documents.filter((doc) => doc.type === "image"));
    }

    const targetedDocs: DocumentRecord[] = [];
    if (context.saveDocuments !== false) {
      targetedDocs.push(...(await generateSchmersalDatasheets(page, catalogNumber, context)));
    }
    targetedDocs.push(...(await fetchSchmersalManualDocuments(page.productId, context)));

    return withSchmersalDocuments(baseResult, [
      ...targetedDocs,
      ...baseResult.documents.filter((doc) => doc.type === "image")
    ]);
  }
}

function schmersalSources(context: ScrapeContext): FallbackSourceConfig[] {
  const searchTemplates = (context.manufacturer.scrapeRecipe?.searchUrlTemplates ?? []).map((url, index) => ({
    id: `schmersal-official-search-${index + 1}`,
    label: "Schmersal product search",
    enabled: true,
    sourceType: "official-fallback" as const,
    directUrlTemplates: [url],
    confidence: 0.72,
    fetchPolicy: { timeoutMs: 30000, minContentLength: 1000 }
  }));
  return [...searchTemplates, ...context.manufacturer.fallbackSources];
}

async function rescueSchmersalResultFromSearch(
  catalogNumber: string,
  context: ScrapeContext,
  currentResult?: ProductResult,
  options: { force?: boolean } = {}
): Promise<ProductResult | undefined> {
  if (!options.force && !shouldUseSchmersalSearchRescue(currentResult)) return currentResult;
  const detailUrl = await discoverSchmersalDetailUrl(catalogNumber, context, currentResult?.productUrl);
  if (!detailUrl) return currentResult;
  if (sameUrl(currentResult?.productUrl, detailUrl) && currentResult?.status !== "failed") return currentResult;

  const detailResult = await context.fallback.scrape(catalogNumber, [schmersalDetailSource(detailUrl)]);
  return detailResult && detailResult.status !== "failed" ? detailResult : currentResult;
}

function shouldUseSchmersalSearchRescue(result: ProductResult | undefined): boolean {
  if (!result) return true;
  if (result.status === "failed") return true;
  if (isSchmersalSearchUrl(result.productUrl)) return true;
  if (!isOfficialSchmersalDetailUrl(result.productUrl)) return true;
  if (!result.documents.some((doc) => doc.type === "image")) return true;
  return result.attributes.length === 0 && result.documents.length === 0;
}

function schmersalDetailSource(url: string): FallbackSourceConfig {
  return {
    id: "schmersal-discovered-product",
    label: "Schmersal product page",
    enabled: true,
    sourceType: "official-fallback",
    directUrlTemplates: [url],
    confidence: 0.86,
    fetchPolicy: { timeoutMs: 30000, minContentLength: 1000 }
  };
}

async function discoverSchmersalDetailUrl(
  catalogNumber: string,
  context: ScrapeContext,
  preferredUrl?: string
): Promise<string | undefined> {
  const urls = [
    preferredUrl,
    ...SCHMERSAL_TARGET_LOCALES.map((item) => `${SCHMERSAL_BASE_URL}/${localePath(item.locale)}/search?query=${encodeURIComponent(catalogNumber)}`)
  ].filter((url): url is string => Boolean(url));

  for (const url of uniqueStrings(urls)) {
    try {
      const fetched = await context.http.fetchText(localizeSchmersalUrl(url, "de-DE"), {
        timeoutMs: 30000,
        cacheTtlMs: context.manufacturer.fetchPolicy?.cacheTtlMs,
        signal: context.signal
      });
      const detailUrl = extractSchmersalDetailUrl(fetched.text, fetched.effectiveUrl, catalogNumber);
      if (detailUrl) return detailUrl;
    } catch {
      // Try the next search/result page candidate.
    }
  }
  return undefined;
}

async function fetchBestSchmersalPage(
  result: ProductResult,
  catalogNumber: string,
  context: ScrapeContext
): Promise<SchmersalPageData | undefined> {
  const urls = [
    result.productUrl,
    result.localizedUrls?.de,
    result.localizedUrls?.en,
    ...SCHMERSAL_TARGET_LOCALES.map((item) => `${SCHMERSAL_BASE_URL}/${localePath(item.locale)}/search?query=${encodeURIComponent(catalogNumber)}`)
  ].filter((url): url is string => Boolean(url));

  for (const url of uniqueStrings(urls)) {
    if (/\/search(?:[/?#]|$)/i.test(url)) continue;
    try {
      const fetched = await context.http.fetchText(localizeSchmersalUrl(url, "de-DE"), {
        timeoutMs: 30000,
        cacheTtlMs: context.manufacturer.fetchPolicy?.cacheTtlMs,
        signal: context.signal
      });
      const page = extractSchmersalPageData(fetched.text);
      if (page) return page;
    } catch {
      // Try the next localized page candidate.
    }
  }

  return undefined;
}

async function fetchSchmersalManualDocuments(productId: string, context: ScrapeContext): Promise<DocumentRecord[]> {
  const documents: DocumentRecord[] = [];
  const recordsByLocale = new Map<SchmersalLocale["locale"], { apiUrl: string; records: SchmersalDocumentApiRecord[] }>();
  const localeRecords = await Promise.all(
    SCHMERSAL_TARGET_LOCALES.map(async (locale) => {
      const apiUrl = `${SCHMERSAL_BASE_URL}/api/products/${encodeURIComponent(productId)}/documents?locale=${encodeURIComponent(locale.locale)}`;
      try {
        const response = await context.http.fetchText(apiUrl, {
          timeoutMs: 30000,
          cacheTtlMs: context.manufacturer.fetchPolicy?.cacheTtlMs,
          headers: { accept: "application/json" },
          signal: context.signal
        });
        return {
          locale: locale.locale,
          apiUrl,
          records: JSON.parse(response.text) as SchmersalDocumentApiRecord[]
        };
      } catch {
        return { locale: locale.locale, apiUrl, records: [] };
      }
    })
  );
  for (const entry of localeRecords) recordsByLocale.set(entry.locale, { apiUrl: entry.apiUrl, records: entry.records });

  const allRecords = [...recordsByLocale.values()].flatMap((entry) => entry.records);
  for (const locale of SCHMERSAL_TARGET_LOCALES) {
    const localeRecords = recordsByLocale.get(locale.locale);
    const record =
      pickSchmersalManual(localeRecords?.records ?? [], locale, { allowFallback: true }) ??
      pickSchmersalManual(allRecords, locale, { allowFallback: false }) ??
      pickSchmersalManual(allRecords, locale, { allowFallback: true });
    if (!record?.url) {
      continue;
    }
    documents.push({
      type: "manual",
      label: `Operating instructions and Declaration of conformity - ${locale.label}`,
      url: withLocaleFragment(absoluteSchmersalUrl(record.url), locale.locale),
      sourceUrl: localeRecords?.apiUrl,
      parser: "schmersal-documents-api",
      stage: "schmersal-documents",
      sourceType: "official-fallback",
      confidence: 0.9
    });
  }
  return documents;
}

function pickSchmersalManual(
  records: SchmersalDocumentApiRecord[],
  locale: SchmersalLocale,
  options: { allowFallback: boolean }
): SchmersalDocumentApiRecord | undefined {
  const manuals = records.filter(isSchmersalManual);
  return manuals.find((record) => languageCode(record.name) === locale.code) ?? (options.allowFallback ? manuals[0] : undefined);
}

function isSchmersalManual(record: SchmersalDocumentApiRecord): boolean {
  const naming = namingConvention(record);
  return (
    naming === "DOC_MAN_MEC" ||
    naming === "DOC_MAN_EU" ||
    naming === "DOC_MAN_DECL" ||
    record.customFields?.document_type === "manual" ||
    /operating instructions|declaration of conformity|betriebsanleitung|konformit/i.test(`${record.title ?? ""} ${record.name ?? ""}`)
  );
}

async function generateSchmersalDatasheets(
  page: SchmersalPageData,
  catalogNumber: string,
  context: ScrapeContext
): Promise<DocumentRecord[]> {
  return Promise.all(SCHMERSAL_TARGET_LOCALES.map(async (locale): Promise<DocumentRecord> => {
    try {
      const pdf = await postSchmersalDatasheet(page, locale.locale, context.signal);
      const localPath = await writeSchmersalDatasheet(context.documentsDir, catalogNumber, locale, pdf.buffer, pdf.fileName);
      return {
        type: "datasheet",
        label: `Data sheet - ${locale.label}`,
        url: `${SCHMERSAL_BASE_URL}/api/datasheet/generate#${locale.locale}`,
        localPath,
        downloadStatus: "downloaded",
        sourceUrl: `${SCHMERSAL_BASE_URL}/api/datasheet/generate`,
        parser: "schmersal-datasheet-generator",
        stage: "schmersal-documents",
        sourceType: "official-fallback",
        confidence: 0.9
      };
    } catch (error) {
      return {
        type: "datasheet",
        label: `Data sheet - ${locale.label}`,
        url: `${SCHMERSAL_BASE_URL}/api/datasheet/generate#${locale.locale}`,
        downloadStatus: "failed",
        downloadError: error instanceof Error ? error.message : "Schmersal datasheet generation failed",
        parser: "schmersal-datasheet-generator",
        stage: "schmersal-documents",
        sourceType: "official-fallback",
        confidence: 0.9
      };
    }
  }));
}

async function postSchmersalDatasheet(
  page: SchmersalPageData,
  locale: string,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; fileName?: string }> {
  const altchaPayload = await solveSchmersalAltcha(signal);
  const body = {
    productId: page.productId,
    locale,
    selections: {
      attributeGroups: page.dataTabGroups.map((group) => group.technicalName).filter(Boolean),
      includeImages: true
    },
    format: "pdf",
    dataTabGroups: page.dataTabGroups,
    altchaPayload,
    timeZone: "Europe/Zagreb"
  };
  const response = await fetch(`${SCHMERSAL_BASE_URL}/api/datasheet/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/pdf"
    },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Schmersal datasheet generation failed with HTTP ${response.status}${message ? `: ${message.slice(0, 200)}` : ""}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("Schmersal datasheet response was not a PDF");
  }
  return {
    buffer,
    fileName: contentDispositionFileName(response.headers.get("content-disposition") ?? undefined)
  };
}

async function solveSchmersalAltcha(signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${SCHMERSAL_BASE_URL}/api/altcha/challenge`, {
    headers: { accept: "application/json" },
    signal
  });
  if (!response.ok) throw new Error(`ALTCHA challenge failed with HTTP ${response.status}`);
  const challenge = (await response.json()) as AltchaChallenge;
  const algorithm = challenge.algorithm.replace("-", "").toLowerCase();
  for (let number = 0; number <= challenge.maxnumber; number += 1) {
    const hash = crypto.createHash(algorithm).update(`${challenge.salt}${number}`).digest("hex");
    if (hash === challenge.challenge) {
      return Buffer.from(
        JSON.stringify({
          algorithm: challenge.algorithm,
          challenge: challenge.challenge,
          number,
          salt: challenge.salt,
          signature: challenge.signature
        })
      ).toString("base64");
    }
  }
  throw new Error("ALTCHA challenge could not be solved");
}

async function writeSchmersalDatasheet(
  documentsDir: string,
  catalogNumber: string,
  locale: SchmersalLocale,
  buffer: Buffer,
  sourceFileName?: string
): Promise<string> {
  await fs.mkdir(documentsDir, { recursive: true });
  const baseName = sanitize(sourceFileName || `${catalogNumber}-datasheet-${locale.locale}.pdf`) || `${catalogNumber}-datasheet-${locale.locale}.pdf`;
  const parsed = path.parse(baseName);
  const fileName = `${sanitize(catalogNumber) || "schmersal"}-datasheet-${locale.locale}${parsed.ext || ".pdf"}`;
  let candidate = path.join(documentsDir, fileName);
  let index = 2;
  while (await exists(candidate)) {
    candidate = path.join(documentsDir, `${path.parse(fileName).name}-${index}${path.parse(fileName).ext}`);
    index += 1;
  }
  await fs.writeFile(candidate, buffer);
  return candidate;
}

function withSchmersalDocuments(result: ProductResult, documents: DocumentRecord[]): ProductResult {
  return {
    ...result,
    documents: dedupeDocuments(documents)
  };
}

export function extractSchmersalPageData(rawHtml: string): SchmersalPageData | undefined {
  const html = unescapeNextPayload(rawHtml);
  const productId =
    html.match(/"product":\{[\s\S]{0,3000}?"id":"([^"]+)"/)?.[1] ??
    html.match(/"product":\{"id":"([^"]+)"/)?.[1] ??
    html.match(/"productId":"([^"]+)"/i)?.[1] ??
    html.match(/api\/og\?type=product&slug=([^&"]+)/)?.[1];
  if (!productId) return undefined;
  const rawGroups = extractJsonValueAfter(html, '"dataTabGroups":');
  if (!rawGroups) return undefined;
  try {
    const dataTabGroups = JSON.parse(rawGroups) as SchmersalPageData["dataTabGroups"];
    if (!Array.isArray(dataTabGroups) || dataTabGroups.length === 0) return undefined;
    return { productId, dataTabGroups };
  } catch {
    return undefined;
  }
}

function extractSchmersalDetailUrl(rawHtml: string, baseUrl: string, catalogNumber: string): string | undefined {
  const html = unescapeNextPayload(rawHtml).replace(/&amp;/g, "&");
  const escapedPart = escapeRegExp(catalogNumber);
  const patterns = [
    new RegExp(`/(?:de_DE|en_US|en_GB)/[^"'<>\\s]*${escapedPart}[^"'<>\\s]*`, "i"),
    new RegExp(`https://products\\.schmersal\\.com/(?:de_DE|en_US|en_GB)/[^"'<>\\s]*${escapedPart}[^"'<>\\s]*`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern)?.[0];
    if (!match || /\/search(?:[/?#]|$)/i.test(match)) continue;
    try {
      return localizeSchmersalUrl(new URL(match, baseUrl).toString(), "de-DE");
    } catch {
      // Continue to the next inline candidate.
    }
  }
  return undefined;
}

function extractJsonValueAfter(text: string, marker: string): string | undefined {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const openIndex = text.indexOf("[", markerIndex);
  if (openIndex < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, index + 1);
    }
  }
  return undefined;
}

function unescapeNextPayload(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, "&")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\n/g, "\n");
}

function namingConvention(record: SchmersalDocumentApiRecord): string | undefined {
  return (
    stringValue(record.customFields?.schmersal_pim_naming_convention) ??
    stringValue(record.translated?.customFields?.schmersal_media_naming_convention)
  );
}

function languageCode(name: string | undefined): string | undefined {
  return name?.match(/_(S[A-Z]{2})_/i)?.[1]?.toUpperCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function absoluteSchmersalUrl(url: string): string {
  return new URL(url, SCHMERSAL_BASE_URL).toString();
}

function withLocaleFragment(url: string, locale: string): string {
  const parsed = new URL(url);
  parsed.hash = locale;
  return parsed.toString();
}

function isSchmersalSearchUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase() === "products.schmersal.com" && /\/search(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return /products\.schmersal\.com\/[^/]+\/search/i.test(url);
  }
}

function isOfficialSchmersalDetailUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.toLowerCase() === "products.schmersal.com" &&
      !/\/search(?:\/|$)/i.test(parsed.pathname) &&
      /\/(?:de_DE|en_US|en_GB)\/[^/?#]+-\d{6,}(?:[/?#]|$)/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function localizeSchmersalUrl(url: string, locale: string): string {
  return url.replace(/\/(?:de_DE|de-DE|en_US|en-US|en_GB|en-GB)(?=\/)/, `/${localePath(locale)}`);
}

function localePath(locale: string): string {
  return locale.replace("-", "_");
}

function contentDispositionFileName(value: string | undefined): string | undefined {
  return value?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function uniqueStrings(values: string[]): string[] {
  return uniqueStringsBase(values, { filterEmpty: false });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
