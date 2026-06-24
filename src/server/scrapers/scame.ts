import { PDFParse } from "pdf-parse";
import type { AttributeRecord, DocumentRecord, LocalizedProductUrls, ProductResult, SourceRecord } from "../../shared/types.js";
import { catalogNumberVariants } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";
import { extractDocumentTextAttributes } from "./document-enrichment.js";
import { cleanText, emptyResult, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

const SCAME_PARSER_VERSION = "scame-v1";
const SCAME_TECHSHEET_BASE = "https://techsheet.scame.com";
const SCAME_FETCH_TIMEOUT_MS = 12000;
const SCAME_INFODATA_LOCALES = ["en", "en-US", "it", "fr", "es"] as const;

type ScameDownloadKind = "pdf" | "dwg" | "step";

export interface ScameDownloadCandidate {
  kind: ScameDownloadKind;
  url: string;
  extension: "pdf" | "dwg" | "zip";
  type: DocumentRecord["type"];
  label: string;
  parser: string;
  confidence: number;
}

interface ScamePdfProbe {
  url: string;
  statusCode: number;
  contentType: string;
}

interface ScamePdfFetch extends ScamePdfProbe {
  buffer: Buffer;
}

interface ScameInfoParseResult {
  title?: string;
  description?: string;
  attributes: AttributeRecord[];
  downloadKinds: Set<ScameDownloadKind>;
}

export class ScameConnector implements ManufacturerConnector {
  id = "scame";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const candidates = buildScamePdfCandidates(catalogNumber);
    const attemptedUrls = [...candidates.infoData, ...candidates.cadDocuments.map((candidate) => candidate.url)];
    const attributes: AttributeRecord[] = [];
    const documents: DocumentRecord[] = [];
    const sources: SourceRecord[] = [];
    const advertisedDownloadKinds = new Set<ScameDownloadKind>();
    let title: string | undefined;
    let description: string | undefined;

    for (const url of candidates.infoData) {
      const fetched = await fetchScamePdf(url, context.signal);
      if (!fetched) continue;
      const document = scameDocument("datasheet", catalogNumber, fetched.url, "SCAME product information sheet", 0.86);
      documents.push(document);
      sources.push(sourceFromProbe(fetched, "scame-infodata", "Validated SCAME product-info PDF"));
      const text = await readPdfText(fetched.buffer);
      const parsed = parseScameInfoText(catalogNumber, fetched.url, text);
      attributes.push(...parsed.attributes);
      title = title ?? parsed.title;
      description = description ?? parsed.description;
      for (const kind of parsed.downloadKinds) advertisedDownloadKinds.add(kind);
      break;
    }

    for (const candidate of cadCandidatesForProbe(candidates.cadDocuments, {
      hasInfoSheet: documents.some((doc) => doc.type === "datasheet"),
      advertisedDownloadKinds
    })) {
      if (documents.some((doc) => sameUrl(doc.url, candidate.url))) continue;
      const probe = await probeScameDownload(candidate, context.signal);
      if (!probe) continue;
      documents.push(scameDocument(candidate.type, catalogNumber, probe.url, candidate.label, candidate.confidence, candidate.parser));
      sources.push(sourceFromProbe(probe, candidate.parser, `Validated ${candidate.label}`));
    }

    if (!attributes.length && !documents.length) {
      const { result: fallback, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: this.id });
      const result = fallback ?? emptyResult("scame", catalogNumber, "SCAME did not publish a validated techsheet PDF for this catalog number and official discovery did not find a parseable product page.");
      return withDiscoveryFallbackDiagnostics(
        {
          ...result,
          diagnostics: {
            ...result.diagnostics,
            attemptedUrls: [...(result.diagnostics?.attemptedUrls ?? []), ...attemptedUrls]
          }
        },
        discovery
      );
    }

    if (!attributes.some((attr) => /catalog|code|article|part/i.test(attr.name))) {
      attributes.unshift(scameAttribute("SCAME Product", "Catalog Number", catalogNumber, documents[0]?.url ?? SCAME_TECHSHEET_BASE, 0.72));
    }

    const cleanAttributes = dedupeAttributes(attributes);
    const cleanDocuments = dedupeDocuments(documents);
    const normalized = normalizeFields(cleanAttributes, cleanDocuments);
    const confidence = cleanAttributes.length >= 4 ? 0.84 : 0.66;
    const productUrl = cleanDocuments.find((doc) => doc.type === "datasheet")?.url ?? cleanDocuments[0]?.url;

    return {
      manufacturerId: "scame",
      catalogNumber,
      status: "partial",
      confidence,
      productUrl,
      localizedUrls: buildScameLocalizedUrls(productUrl),
      title,
      description,
      normalized,
      attributes: cleanAttributes,
      documents: cleanDocuments,
      sources,
      diagnostics: {
        attemptedUrls,
        notes: cleanDocuments.some((doc) => doc.type === "datasheet")
          ? ["SCAME product data came from the official techsheet PDF endpoint."]
          : ["Only a SCAME technical drawing PDF was validated for this catalog number."]
      }
    };
  }
}

export function buildScamePdfCandidates(catalogNumber: string): {
  infoData: string[];
  drawings: string[];
  cadDocuments: ScameDownloadCandidate[];
} {
  const slugs = buildScameSlugVariants(catalogNumber);
  const drawingCandidates = slugs.map((value) => scameCadCandidate(value, "pdf"));

  return {
    infoData: uniqueStrings(slugs.flatMap((value) =>
      SCAME_INFODATA_LOCALES.map((locale) => `${SCAME_TECHSHEET_BASE}/infodata/${locale}/${encodeURIComponent(value)}.pdf`)
    )),
    drawings: uniqueStrings(drawingCandidates.map((candidate) => candidate.url)),
    cadDocuments: dedupeCadCandidates(slugs.flatMap((value) => [
      scameCadCandidate(value, "pdf"),
      scameCadCandidate(value, "dwg"),
      scameCadCandidate(value, "step")
    ]))
  };
}

export function scamePdfSlug(catalogNumber: string): string {
  return scameRawPdfSlug(catalogNumber).toLowerCase();
}

function scameRawPdfSlug(catalogNumber: string): string {
  return cleanText(catalogNumber)
    .replace(/\\/g, "/")
    .replace(/\//g, "_")
    .replace(/\s+/g, "");
}

function buildScameSlugVariants(catalogNumber: string): string[] {
  const variants = catalogNumberVariants(catalogNumber);
  return uniqueStrings([
    scameRawPdfSlug(catalogNumber),
    scamePdfSlug(catalogNumber),
    scameRawPdfSlug(catalogNumber).toUpperCase(),
    scameRawPdfSlug(variants.afterColon),
    scamePdfSlug(variants.afterColon),
    scameRawPdfSlug(variants.compact),
    scamePdfSlug(variants.compact),
    scameRawPdfSlug(variants.compact).toUpperCase()
  ]).filter((value) => value.length >= 3);
}

function scameCadCandidate(slug: string, kind: ScameDownloadKind): ScameDownloadCandidate {
  if (kind === "dwg") {
    return {
      kind,
      url: `${SCAME_TECHSHEET_BASE}/Download/dms/cad/dwg/${encodeURIComponent(slug)}.dwg`,
      extension: "dwg",
      type: "cad",
      label: "SCAME technical drawing DWG",
      parser: "scame-cad-dwg",
      confidence: 0.62
    };
  }
  if (kind === "step") {
    return {
      kind,
      url: `${SCAME_TECHSHEET_BASE}/Download/dms/cad/step/${encodeURIComponent(slug)}.zip`,
      extension: "zip",
      type: "cad",
      label: "SCAME 3D STEP package",
      parser: "scame-cad-step",
      confidence: 0.62
    };
  }
  return {
    kind,
    url: `${SCAME_TECHSHEET_BASE}/Download/dms/cad/pdf/${encodeURIComponent(slug)}.pdf`,
    extension: "pdf",
    type: "cad",
    label: "SCAME technical drawing PDF",
    parser: "scame-cad-pdf",
    confidence: 0.68
  };
}

function dedupeCadCandidates(candidates: ScameDownloadCandidate[]): ScameDownloadCandidate[] {
  const byUrl = new Map<string, ScameDownloadCandidate>();
  for (const candidate of candidates) {
    const key = candidate.url;
    if (!byUrl.has(key)) byUrl.set(key, candidate);
  }
  return [...byUrl.values()];
}

function cadCandidatesForProbe(
  candidates: ScameDownloadCandidate[],
  options: { hasInfoSheet: boolean; advertisedDownloadKinds: Set<ScameDownloadKind> }
): ScameDownloadCandidate[] {
  if (!options.hasInfoSheet) return candidates;
  if (!options.advertisedDownloadKinds.size) return [];
  return candidates.filter((candidate) => options.advertisedDownloadKinds.has(candidate.kind));
}

export function parseScameInfoText(catalogNumber: string, sourceUrl: string, text: string): ScameInfoParseResult {
  const lines = normalizeScamePdfLines(text);
  const catalogIndex = lines.findIndex((line) => compact(line) === compact(catalogNumber));
  const summaryLines = collectScameSummaryLines(lines, catalogIndex >= 0 ? catalogIndex + 1 : 0);
  const title = summaryLines[0];
  const description = summaryLines.slice(1).join(" ");
  const downloadKinds = extractScameDownloadKinds(text);
  const attributes: AttributeRecord[] = [
    scameAttribute("SCAME Product", "Catalog Number", catalogNumber, sourceUrl, 0.86)
  ];
  if (title) attributes.push(scameAttribute("SCAME Product", "Product Name", title, sourceUrl, 0.84));
  if (description) attributes.push(scameAttribute("SCAME Product", "Summary", description, sourceUrl, 0.8));
  attributes.push(
    ...extractDocumentTextAttributes({
      catalogNumber,
      document: {
        label: "SCAME product information sheet",
        type: "datasheet",
        url: sourceUrl
      },
      text
    }).map((attr) => ({
      ...attr,
      sourceType: "official" as const,
      parser: "scame-infodata",
      stage: "scame-infodata",
      confidence: attr.confidence ?? 0.82
    }))
  );
  return {
    title,
    description: description || undefined,
    attributes: dedupeAttributes(attributes),
    downloadKinds
  };
}

export function extractScameDownloadKinds(text: string): Set<ScameDownloadKind> {
  const kinds = new Set<ScameDownloadKind>();
  const pattern = /(?:technical\s+drawing|3d\s+model|download)[^\n\r]{0,120}\[\s*(pdf|dwg|stp|step)\s*\]/gi;
  for (const match of text.matchAll(pattern)) {
    const value = match[1]?.toLowerCase();
    if (value === "pdf") kinds.add("pdf");
    if (value === "dwg") kinds.add("dwg");
    if (value === "stp" || value === "step") kinds.add("step");
  }
  return kinds;
}

function buildScameLocalizedUrls(productUrl: string | undefined): LocalizedProductUrls | undefined {
  if (!productUrl) return undefined;
  return { en: productUrl };
}

async function fetchScamePdf(url: string, signal?: AbortSignal): Promise<ScamePdfFetch | undefined> {
  throwIfAborted(signal);
  const request = createTimeoutSignal(signal, SCAME_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/pdf,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 (compatible; ProductScraper/1.0)"
      },
      signal: request.signal
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!isPdfResponse(response, buffer)) return undefined;
    return {
      url: response.url || url,
      statusCode: response.status,
      contentType: response.headers.get("content-type") ?? "",
      buffer
    };
  } catch (error) {
    if (signal?.aborted) throw new Error("Cancelled by user.");
    return undefined;
  } finally {
    request.cleanup();
  }
}

async function probeScameDownload(candidate: ScameDownloadCandidate, signal?: AbortSignal): Promise<ScamePdfProbe | undefined> {
  throwIfAborted(signal);
  const url = candidate.url;
  const request = createTimeoutSignal(signal, SCAME_FETCH_TIMEOUT_MS);
  try {
    const head = await fetch(url, {
      method: "HEAD",
      headers: {
        accept: acceptForExtension(candidate.extension),
        "user-agent": "Mozilla/5.0 (compatible; ProductScraper/1.0)"
      },
      signal: request.signal
    });
    if (head.ok && isExpectedDownloadContentType(head.headers.get("content-type"), candidate.extension)) {
      return { url: head.url || url, statusCode: head.status, contentType: head.headers.get("content-type") ?? "" };
    }
    if (head.status === 403 || head.status === 404) return undefined;
  } catch (error) {
    if (signal?.aborted) throw new Error("Cancelled by user.");
    // Some servers do not support HEAD; fall back to a tiny ranged GET below.
  } finally {
    request.cleanup();
  }

  const rangedRequest = createTimeoutSignal(signal, SCAME_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: acceptForExtension(candidate.extension),
        range: "bytes=0-8",
        "user-agent": "Mozilla/5.0 (compatible; ProductScraper/1.0)"
      },
      signal: rangedRequest.signal
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!isDownloadResponse(response, buffer, candidate.extension)) return undefined;
    return { url: response.url || url, statusCode: response.status, contentType: response.headers.get("content-type") ?? "" };
  } catch (error) {
    if (signal?.aborted) throw new Error("Cancelled by user.");
    return undefined;
  } finally {
    rangedRequest.cleanup();
  }
}

async function readPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText({ first: 5 });
    return parsed.text;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function scameDocument(
  type: DocumentRecord["type"],
  catalogNumber: string,
  url: string,
  label: string,
  confidence: number,
  parser = type === "datasheet" ? "scame-infodata" : "scame-cad-pdf"
): DocumentRecord {
  return {
    type,
    label: `${label} ${catalogNumber}`,
    url,
    sourceUrl: url,
    sourceType: "official",
    parser,
    stage: parser,
    confidence
  };
}

function scameAttribute(group: string, name: string, value: string, sourceUrl: string, confidence: number): AttributeRecord {
  return {
    group,
    name,
    value: cleanText(value),
    sourceUrl,
    sourceType: "official",
    parser: "scame-infodata",
    stage: "scame-infodata",
    confidence
  };
}

function sourceFromProbe(probe: ScamePdfProbe, parser: string, reason: string): SourceRecord {
  return {
    url: probe.url,
    sourceType: "official",
    parser,
    parserVersion: SCAME_PARSER_VERSION,
    stage: parser,
    reason,
    fetchedAt: new Date().toISOString(),
    statusCode: probe.statusCode
  };
}

function isPdfResponse(response: Response, buffer: Buffer): boolean {
  return response.ok && (isPdfContentType(response.headers.get("content-type")) || buffer.subarray(0, 5).toString("utf8") === "%PDF-");
}

function isPdfContentType(contentType: string | null): boolean {
  return /application\/pdf|application\/octet-stream/i.test(contentType ?? "");
}

function isExpectedDownloadContentType(contentType: string | null, extension: ScameDownloadCandidate["extension"]): boolean {
  const normalized = (contentType ?? "").toLowerCase();
  if (extension === "pdf") return isPdfContentType(contentType);
  if (extension === "dwg") return /application\/acad|dwg|octet-stream|x-download|binary/.test(normalized);
  if (extension === "zip") return /zip|octet-stream|x-download|binary/.test(normalized);
  return normalized.length > 0 && !/text\/html/.test(normalized);
}

function acceptForExtension(extension: ScameDownloadCandidate["extension"]): string {
  if (extension === "pdf") return "application/pdf,*/*;q=0.8";
  if (extension === "zip") return "application/zip,application/x-zip-compressed,*/*;q=0.8";
  return "application/acad,application/octet-stream,*/*;q=0.8";
}

function isDownloadResponse(response: Response, buffer: Buffer, extension: ScameDownloadCandidate["extension"]): boolean {
  if (!response.ok) return false;
  if (extension === "pdf") return isPdfResponse(response, buffer);
  const contentType = response.headers.get("content-type");
  if (/text\/html/i.test(contentType ?? "")) return false;
  const prefix = buffer.subarray(0, 16).toString("utf8").trimStart();
  if (prefix.startsWith("<!DOCTYPE") || prefix.startsWith("<html")) return false;
  if (extension === "zip") return buffer.subarray(0, 2).toString("utf8") === "PK" || isExpectedDownloadContentType(contentType, extension);
  return buffer.length > 0 && isExpectedDownloadContentType(contentType, extension);
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    }
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Cancelled by user.");
}

function normalizeScamePdfLines(text: string): string[] {
  return text
    .replace(/\u0000/g, "")
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map(cleanText)
    .filter((line) => line && !/^--\s*\d+\s+of\s+\d+\s*--$/i.test(line));
}

function collectScameSummaryLines(lines: string[], start: number): string[] {
  const summary: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || isScameSectionHeading(line)) break;
    if (isScameMetadataLine(line)) continue;
    summary.push(line);
    if (summary.length >= 4) break;
  }
  return summary;
}

function isScameSectionHeading(line: string): boolean {
  return /^(general|technical|physical|dimensional)\s+characteristics$|^download$|^options\s*&\s*various\s*notes$/i.test(line);
}

function isScameMetadataLine(line: string): boolean {
  return (
    /^\*\s*product image may be indicative/i.test(line) ||
    /^en\s+-\s+\d+/i.test(line) ||
    /^www\.scame\.com$/i.test(line) ||
    /^scame@scame\.com$/i.test(line) ||
    /^scame parre s\.?p\.?a/i.test(line) ||
    /^via costa erta/i.test(line) ||
    /directive\s+\d{4}\/\d+/i.test(line) ||
    /^en\s+(?:iec\s+)?\d{4,}/i.test(line) ||
    /^iec\s+\d{4,}/i.test(line)
  );
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sameUrl(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.toString().toLowerCase() === rightUrl.toString().toLowerCase();
  } catch {
    return left.toLowerCase() === right.toLowerCase();
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
