import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { classifyDocument, cleanText, emptyResult, mergeResults, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { catalogTextMatches } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";
import { documentUrlLooksDownloadable } from "./document-url.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

const SCHNEIDER_PRODUCT_URL_TEMPLATES = [
  "https://www.se.com/us/en/product/{part}/",
  "https://www.se.com/ww/en/product/{part}/",
  "https://www.se.com/id/en/product/{part}/",
  "https://www.se.com/sg/en/product/{part}/",
  "https://www.se.com/au/en/product/{part}/",
  "https://www.se.com/in/en/product/{part}/",
  "https://www.se.com/uk/en/product/{part}/",
  "https://www.se.com/ie/en/product/{part}/",
  "https://www.se.com/za/en/product/{part}/",
  "https://www.se.com/ca/en/product/{part}/",
  "https://telemecaniquesensors.com/us/en/product/reference/{part}",
  "https://telemecaniquesensors.com/global/en/product/reference/{part}",
  "https://www.se.com/ww/products/US/en/products/{part}",
  "https://shop.se.com/pro/us/en/product/{part}"
];
const SCHNEIDER_DATASHEET_READER_URL_TEMPLATES = [
  "https://r.jina.ai/http://www.se.com/us/en/product/download-pdf/{part}",
  "https://r.jina.ai/http://www.se.com/ww/en/product/download-pdf/{part}",
  "https://r.jina.ai/http://www.se.com/uk/en/product/download-pdf/{part}",
  "https://r.jina.ai/http://www.se.com/ie/en/product/download-pdf/{part}",
  "https://r.jina.ai/http://www.se.com/au/en/product/download-pdf/{part}",
  "https://r.jina.ai/http://www.se.com/sg/en/product/download-pdf/{part}",
  "https://r.jina.ai/http://www.se.com/in/en/product/download-pdf/{part}",
  "https://r.jina.ai/http://www.se.com/za/en/product/download-pdf/{part}",
  "https://r.jina.ai/http://www.se.com/ca/en/product/download-pdf/{part}",
  "https://r.jina.ai/http://www.se.com/id/en/product/download-pdf/{part}"
];
const SCHNEIDER_PARSER = "schneider-product-page";
const SCHNEIDER_DATASHEET_READER_PARSER = "schneider-datasheet-reader";
const TELEMECANIQUE_PARSER = "schneider-telemecanique-product-page";
const SCHNEIDER_CONFIDENCE = 0.9;

const SCHNEIDER_DATASHEET_LABELS = [
  "[Ics] rated service short-circuit breaking capacity",
  "[Ith] conventional free air thermal current",
  "[Ie] rated operational current",
  "[Ue] rated operational voltage",
  "[Ui] rated insulation voltage",
  "[Uimp] rated impulse withstand voltage",
  "[Us] rated supply voltage",
  "Ambient air temperature for operation",
  "Ambient Air Temperature for Storage",
  "Analogue input number",
  "Analogue input type",
  "Analogue output number",
  "Analogue output type",
  "Apparent power",
  "Base load current at high overload",
  "Bezel material",
  "Breaking capacity",
  "Category",
  "Climatic withstand",
  "Color",
  "Communication Port Protocol",
  "Connections - terminals",
  "Contact operation",
  "Contacts material",
  "Contacts type and composition",
  "Contacts usage",
  "Control Type",
  "Country of origin",
  "Depth",
  "Device Application",
  "Device presentation",
  "Device short name",
  "Dielectric strength",
  "Discrete input logic",
  "Discrete input number",
  "Discrete input type",
  "Discrete output number",
  "Discrete output type",
  "Discount Schedule",
  "Discontinued on",
  "Efficiency",
  "Electrical durability",
  "Electromagnetic compatibility",
  "EMC filter",
  "Enclosure Type",
  "Environmental class",
  "Fire resistance",
  "Fixing collar material",
  "Fixing mode",
  "Format of the drive",
  "GTIN",
  "Head type",
  "Height",
  "IK degree of protection",
  "IP degree of protection",
  "Input protection type",
  "Input current",
  "Input impedance",
  "Inrush current",
  "Important message",
  "Line current",
  "Line Rated Current",
  "Magnetic tripping current",
  "Main Range",
  "Main Range of Product",
  "Marking",
  "Maximum Horse Power Rating",
  "Maximum Input Current per Phase",
  "Maximum output frequency",
  "Maximum output voltage",
  "Maximum switching current",
  "Maximum transient current",
  "Mechanical durability",
  "Minimum switching current",
  "Motor power kW",
  "Mounting diameter",
  "Mounting Mode",
  "Mounting position",
  "Network frequency",
  "Network Frequency",
  "Network number of phases",
  "Network type",
  "Nominal input voltage",
  "Nominal switching frequency",
  "nominal output current",
  "Operating altitude",
  "Operating force",
  "Operating position",
  "Operating travel",
  "Operator profile",
  "Option",
  "Output voltage",
  "Output voltage adjustment",
  "Overvoltage category",
  "Phase failure sensitivity",
  "Poles description",
  "Pollution degree",
  "Power dissipation in W",
  "Power dissipation per pole",
  "Power factor",
  "Power supply output current",
  "Power supply type",
  "Product availability",
  "Product certifications",
  "Product destination",
  "Product name",
  "Product or Component Type",
  "Product range",
  "Product Specific Application",
  "Product Weight",
  "Prospective line Isc",
  "Protection type",
  "Protective treatment",
  "Rated power in VA",
  "Rated power in W",
  "Rated supply voltage",
  "Rated duty",
  "Range",
  "Range of Product",
  "Relay output type",
  "Resistance to high pressure washer",
  "Returnability",
  "Sale per indivisible quantity",
  "Shape of screw head",
  "Shape of signaling unit head",
  "Short-circuit protection",
  "Standards",
  "Status LED",
  "Suitability for isolation",
  "Supply",
  "Supply voltage",
  "Switching frequency",
  "Terminals description",
  "Thermal protection adjustment range",
  "Tightening torque",
  "Trip unit technology",
  "Type of operator",
  "Unit Type of Package 1",
  "Utilisation category",
  "Variant",
  "Warranty (in months)",
  "Width"
].sort((left, right) => right.length - left.length);

const SCHNEIDER_SENSOR_DATASHEET_LABELS = [
  "[Sn] nominal sensing distance",
  "[Us] rated supply voltage",
  "Cable composition",
  "Cable length",
  "Current consumption",
  "Delay first up",
  "Delay recovery",
  "Delay response",
  "Detection face",
  "Detector flush mounting acceptance",
  "Differential travel",
  "Discrete input voltage",
  "Electrical connection",
  "Enclosure material",
  "Front material",
  "Material",
  "Output circuit type",
  "Range of product",
  "Sensor design",
  "Sensor name",
  "Sensor type",
  "Series name",
  "Shock resistance",
  "Size",
  "Switching capacity in mA",
  "Thread type",
  "Type of output signal",
  "Vibration resistance",
  "Voltage drop",
  "Voltage state 0 guaranteed",
  "Voltage state 1 guaranteed",
  "Wire insulation material",
  "Wiring technique"
];

const SCHNEIDER_ALL_DATASHEET_LABELS = [...new Set([...SCHNEIDER_DATASHEET_LABELS, ...SCHNEIDER_SENSOR_DATASHEET_LABELS])].sort(
  (left, right) => right.length - left.length
);

const SCHNEIDER_CHAINED_DATASHEET_LABELS = [
  "Product availability",
  "Important message",
  "Main Range of Product",
  "Range of Product",
  "Main Range",
  "Product range",
  "Product name",
  "Product or Component Type",
  "Device short name",
  "Device Application",
  "Discontinued on"
].sort((left, right) => right.length - left.length);

const TELEMECANIQUE_LABELS = [
  ...SCHNEIDER_ALL_DATASHEET_LABELS,
  "[Sn] nominal sensing distance",
  "[Us] rated supply voltage",
  "Ambient air temperature for operation",
  "Ambient air temperature for storage",
  "Cable composition",
  "Cable length",
  "Current consumption",
  "Delay first up",
  "Delay recovery",
  "Delay response",
  "Detection face",
  "Detector flush mounting acceptance",
  "Differential travel",
  "Discrete output function",
  "Discrete output type",
  "Electrical connection",
  "Enclosure material",
  "Front material",
  "IP degree of protection",
  "Material",
  "Output circuit type",
  "Product certifications",
  "Range of product",
  "Sensor design",
  "Sensor name",
  "Sensor type",
  "Series name",
  "Shock resistance",
  "Size",
  "Status LED",
  "Switching capacity in mA",
  "Switching frequency",
  "Thread type",
  "Type of output signal",
  "Vibration resistance",
  "Voltage drop",
  "Wire insulation material",
  "Wiring technique"
].sort((left, right) => right.length - left.length);

const TELEMECANIQUE_SECTIONS = [
  "Main",
  "Complementary",
  "Environment",
  "Packing Units",
  "Ordering and shipping details"
];

const SCHNEIDER_DATASHEET_SECTIONS = [
  "Ordering and shipping details",
  "Contractual warranty",
  "Product data sheet",
  "Environmental Data",
  "Packing Units",
  "Complementary",
  "Environment",
  "Specifications",
  "Main"
].sort((left, right) => right.length - left.length);

type JsonObject = Record<string, unknown>;

interface SchneiderProductInfo {
  brand?: string;
  description?: string;
  productId?: string;
  title?: string;
  canonicalUrl?: string;
  metaDescription?: string;
}

export class SchneiderConnector implements ManufacturerConnector {
  readonly id = "schneider";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const officialResults: ProductResult[] = [];
    let firstFailure: ProductResult | undefined;

    const allUrls = buildSchneiderOfficialUrls(catalogNumber);
    const psCounter = { count: 0 };

    // Parallelize the first 5 locales — first rich result wins; the rest are discarded but their cache writes persist.
    const headBatch = allUrls.slice(0, 5);
    const tailBatch = allUrls.slice(5);
    const headFetched = await Promise.all(headBatch.map((url) => fetchSchneiderProductPage(url, context, psCounter)));

    let richFound = false;
    for (let i = 0; i < headBatch.length; i++) {
      const fetched = headFetched[i];
      if (!fetched) continue;
      const officialUrl = headBatch[i];
      const result = isTelemecaniqueProductUrl(officialUrl, fetched.effectiveUrl)
        ? parseTelemecaniqueProductPage(catalogNumber, fetched)
        : parseSchneiderProductPage(catalogNumber, fetched);
      if (result.status !== "failed") {
        officialResults.push(result);
        if (isRichSchneiderResult(result)) {
          richFound = true;
          break;
        }
      } else {
        firstFailure ??= result;
      }
    }

    if (!richFound) {
      for (const officialUrl of tailBatch) {
        const fetched = await fetchSchneiderProductPage(officialUrl, context, psCounter);
        if (!fetched) continue;
        const result = isTelemecaniqueProductUrl(officialUrl, fetched.effectiveUrl)
          ? parseTelemecaniqueProductPage(catalogNumber, fetched)
          : parseSchneiderProductPage(catalogNumber, fetched);
        if (result.status !== "failed") {
          officialResults.push(result);
          if (isRichSchneiderResult(result)) break;
        } else {
          firstFailure ??= result;
        }
      }
    }

    const directResult = officialResults.length
      ? officialResults.slice(1).reduce((merged, result) => mergeResults(merged, result), officialResults[0])
      : undefined;
    const datasheetReader = shouldFetchSchneiderDatasheetReader(directResult)
      ? await fetchSchneiderDatasheetReader(catalogNumber, context)
      : undefined;

    if (directResult) {
      return datasheetReader ? mergeResults(directResult, datasheetReader) : directResult;
    }

    const result = firstFailure ?? emptyResult("schneider", catalogNumber, "No Schneider product page could be fetched.");
    const { result: fallback, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: this.id });
    const recovered = datasheetReader && fallback
      ? mergeResults(datasheetReader, fallback)
      : datasheetReader ?? fallback ?? result;
    return withDiscoveryFallbackDiagnostics(recovered, discovery);
  }
}

function buildSchneiderOfficialUrls(catalogNumber: string): string[] {
  const encoded = encodeURIComponent(catalogNumber);
  return SCHNEIDER_PRODUCT_URL_TEMPLATES.map((template) => template.replace("{part}", encoded));
}

const SCHNEIDER_PS_FALLBACK_ERROR = /403|429|TLS|certificate|timeout/i;
const SCHNEIDER_MAX_PS_INVOCATIONS = 2;

async function fetchSchneiderProductPage(
  url: string,
  context: ScrapeContext,
  psCounter?: { count: number }
): Promise<FetchedText | undefined> {
  let primaryError: unknown;
  try {
    const fetched = await context.http.fetchText(url, { timeoutMs: 25000, signal: context.signal });
    if (fetched.statusCode < 400) return fetched;
  } catch (err) {
    primaryError = err;
    // Fall through to PowerShell only for network errors that PS can plausibly work around.
  }

  // Gate PowerShell fallback: only spawn for 403/429/TLS/certificate/timeout AND cap total invocations per catalog number.
  const errMsg = primaryError instanceof Error ? primaryError.message : String(primaryError ?? "");
  if (primaryError !== undefined && !SCHNEIDER_PS_FALLBACK_ERROR.test(errMsg)) return undefined;
  if (psCounter && psCounter.count >= SCHNEIDER_MAX_PS_INVOCATIONS) return undefined;
  if (psCounter) psCounter.count += 1;

  try {
    const fetched = await context.http.fetchTextViaPowerShell(url, { timeoutMs: 35000, signal: context.signal });
    return fetched.statusCode < 400 ? fetched : undefined;
  } catch {
    return undefined;
  }
}

function shouldFetchSchneiderDatasheetReader(result: ProductResult | undefined): boolean {
  if (!result) return true;
  if (!result.documents.some((doc) => doc.type === "datasheet")) return true;
  return result.attributes.length < 30;
}

async function fetchSchneiderDatasheetReader(catalogNumber: string, context: ScrapeContext): Promise<ProductResult | undefined> {
  const allUrls = buildSchneiderDatasheetReaderUrls(catalogNumber);
  const headBatch = allUrls.slice(0, 4);
  const tailBatch = allUrls.slice(4);

  // Parallelize the first 4 Jina-proxied locales; pick the first passing result in priority order.
  const fetchOne = (url: string) =>
    context.http
      .fetchText(url, { timeoutMs: 30000, cacheTtlMs: 1000 * 60 * 60 * 24, signal: context.signal })
      .then((fetched) => parseSchneiderDatasheetReaderPage(catalogNumber, fetched))
      .catch(() => undefined);

  const headResults = await Promise.all(headBatch.map(fetchOne));
  for (const result of headResults) {
    if (result && result.status !== "failed") return result;
  }

  for (const url of tailBatch) {
    const result = await fetchOne(url);
    if (result && result.status !== "failed") return result;
  }
  return undefined;
}

function buildSchneiderDatasheetReaderUrls(catalogNumber: string): string[] {
  const encoded = encodeURIComponent(catalogNumber);
  return SCHNEIDER_DATASHEET_READER_URL_TEMPLATES.map((template) => template.replace("{part}", encoded));
}

export function parseSchneiderProductPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  const $ = cheerio.load(fetched.text);
  const decoded = decodeEmbeddedHtml(fetched.text);
  const pageData = readSchneiderPageData($);
  const sourceUrl = fetched.effectiveUrl;
  const matched = catalogTextMatches(decoded, catalogNumber) || pageDataHasCatalogNumber(pageData, catalogNumber);
  const source = {
    url: sourceUrl,
    sourceType: "official",
    parser: SCHNEIDER_PARSER,
    fetchedAt: fetched.fetchedAt,
    statusCode: fetched.statusCode
  } satisfies SourceRecord;

  if (isNonProductSchneiderPage(decoded, sourceUrl)) {
    return {
      ...emptyResult("schneider", catalogNumber, "Schneider page was a selector or storefront page, not a product page."),
      sources: [source]
    };
  }

  if (isBlockedSchneiderPage(decoded, fetched.statusCode)) {
    return {
      ...emptyResult("schneider", catalogNumber, "Schneider page was blocked or unavailable."),
      sources: [source]
    };
  }

  if (!matched) {
    return {
      ...emptyResult("schneider", catalogNumber, "Schneider page did not contain the catalog number."),
      sources: [source]
    };
  }

  const productInfo = readProductInfo(decoded, pageData, catalogNumber);
  const structuredCharacteristics = extractStructuredCharacteristics(pageData, sourceUrl);
  const structuredSustainability = extractStructuredSustainabilityCharacteristics(pageData, sourceUrl);
  const structuredDocuments = extractStructuredDocuments(pageData, sourceUrl);
  const canonicalUrl = absoluteUrl(
    productInfo.canonicalUrl || $("link[rel='canonical']").attr("href") || sourceUrl,
    sourceUrl
  );
  const title = firstText(
    productInfo.description,
    productInfo.title,
    $("h1").first().text(),
    $("meta[property='og:title']").attr("content"),
    $("title").first().text()
  );
  const description = cleanText(
    productInfo.description ||
      productInfo.metaDescription ||
      $("meta[name='description']").attr("content") ||
      $("meta[property='og:description']").attr("content")
  );
  const attributes = stampSchneiderAttributes(
    dedupeAttributes([
      ...extractProductInfoAttributes(productInfo, catalogNumber, sourceUrl),
      ...extractStructuredMetadataAttributes(pageData, catalogNumber, sourceUrl),
      ...structuredCharacteristics,
      ...(structuredCharacteristics.length ? [] : extractCharacteristics(decoded, sourceUrl)),
      ...structuredSustainability,
      ...(structuredSustainability.length ? [] : extractSustainabilityCharacteristics(decoded, sourceUrl))
    ])
  );
  const documents = stampSchneiderDocuments(
    dedupeDocuments([
      ...structuredDocuments,
      ...extractImageDocuments(decoded, catalogNumber, sourceUrl),
      ...extractLinkedDocuments(decoded, sourceUrl)
    ])
  );
  if (!hasMeaningfulSchneiderProductData(attributes, documents)) {
    return {
      ...emptyResult("schneider", catalogNumber, "No Schneider product data found."),
      sources: [source]
    };
  }

  const normalized = normalizeFields(attributes, documents);

  return {
    manufacturerId: "schneider",
    catalogNumber,
    status: attributes.length || documents.length ? "found" : "partial",
    confidence: attributes.length || documents.length ? 0.86 : 0.55,
    productUrl: canonicalUrl,
    localizedUrls: buildLocalizedProductUrls("schneider", catalogNumber, canonicalUrl),
    title,
    description,
    normalized,
    attributes,
    documents,
    sources: [source],
    error: attributes.length || documents.length ? undefined : "No Schneider product data found."
  };
}

export function parseSchneiderDatasheetReaderPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  const text = decodeEmbeddedHtml(fetched.text);
  const sourceUrl = fetched.effectiveUrl;
  const source = {
    url: sourceUrl,
    sourceType: "official-fallback",
    parser: SCHNEIDER_DATASHEET_READER_PARSER,
    fetchedAt: fetched.fetchedAt,
    statusCode: fetched.statusCode
  } satisfies SourceRecord;

  if (fetched.statusCode >= 400 || isFailedSchneiderDatasheetReader(text) || !catalogTextMatches(text, catalogNumber)) {
    return {
      ...emptyResult("schneider", catalogNumber, "Schneider datasheet reader did not contain the catalog number."),
      sources: [source]
    };
  }

  const datasheetUrl = readReaderUrlSource(text) ?? `https://www.se.com/us/en/product/download-pdf/${encodeURIComponent(catalogNumber)}`;
  const productUrl = productUrlFromSchneiderDatasheetUrl(datasheetUrl, catalogNumber);
  const title = readSchneiderDatasheetTitle(text, catalogNumber);
  const attributes = stampSchneiderDatasheetAttributes(
    dedupeAttributes([
      { group: "Schneider Product Info", name: "Catalog Number", value: catalogNumber, sourceUrl },
      ...(title ? [{ group: "Schneider Product Info", name: "Description", value: title, sourceUrl }] : []),
      ...extractSchneiderDatasheetAttributes(text, sourceUrl)
    ])
  );
  const documents = stampSchneiderDatasheetDocuments([
    {
      type: "datasheet",
      label: `${catalogNumber} Product Datasheet`,
      url: datasheetUrl,
      candidateUrls: sourceUrl !== datasheetUrl ? [sourceUrl] : undefined,
      sourceUrl
    }
  ]);
  const normalized = normalizeFields(attributes, documents);

  return {
    manufacturerId: "schneider",
    catalogNumber,
    status: attributes.length > 1 ? "found" : "partial",
    confidence: attributes.length > 1 ? 0.8 : 0.58,
    productUrl,
    localizedUrls: buildLocalizedProductUrls("schneider", catalogNumber, productUrl),
    title,
    description: title,
    normalized,
    attributes,
    documents,
    sources: [source],
    error: attributes.length > 1 ? undefined : "No Schneider datasheet attributes found."
  };
}

function productUrlFromSchneiderDatasheetUrl(datasheetUrl: string, catalogNumber: string): string {
  try {
    const url = new URL(datasheetUrl);
    const productPath = url.pathname.replace(/\/product\/download-pdf\/[^/]+\/?$/i, `/product/${encodeURIComponent(catalogNumber)}/`);
    if (productPath !== url.pathname) {
      url.pathname = productPath;
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    // Fall back to the default locale below.
  }
  return `https://www.se.com/us/en/product/${encodeURIComponent(catalogNumber)}/`;
}

export function parseTelemecaniqueProductPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  const $ = cheerio.load(fetched.text);
  const sourceUrl = fetched.effectiveUrl;
  const decoded = decodeEmbeddedHtml(fetched.text);
  const source = {
    url: sourceUrl,
    sourceType: "official",
    parser: TELEMECANIQUE_PARSER,
    fetchedAt: fetched.fetchedAt,
    statusCode: fetched.statusCode
  } satisfies SourceRecord;

  if (fetched.statusCode >= 400 || !catalogTextMatches(decoded, catalogNumber)) {
    return {
      ...emptyResult("schneider", catalogNumber, "Telemecanique product page did not contain the catalog number."),
      sources: [source]
    };
  }

  const title = telemecaniqueTitle($, catalogNumber);
  const attributes = stampTelemecaniqueAttributes(
    dedupeAttributes([
      { group: "Schneider Product Info", name: "Catalog Number", value: catalogNumber, sourceUrl },
      { group: "Schneider Product Info", name: "Brand", value: "Telemecanique Sensors", sourceUrl },
      ...(title ? [{ group: "Schneider Product Info", name: "Description", value: title, sourceUrl }] : []),
      ...extractTelemecaniqueCharacteristics($, sourceUrl)
    ])
  );
  const documents = stampTelemecaniqueDocuments(
    dedupeDocuments([...extractTelemecaniqueDocuments($, sourceUrl), ...extractTelemecaniqueImages($, catalogNumber, sourceUrl)])
  );

  if (!hasMeaningfulSchneiderProductData(attributes, documents)) {
    return {
      ...emptyResult("schneider", catalogNumber, "No Telemecanique product data found."),
      sources: [source]
    };
  }

  const normalized = normalizeFields(attributes, documents);
  return {
    manufacturerId: "schneider",
    catalogNumber,
    status: "found",
    confidence: 0.84,
    productUrl: sourceUrl,
    localizedUrls: { en: sourceUrl },
    title,
    description: title,
    normalized,
    attributes,
    documents,
    sources: [source]
  };
}

function isRichSchneiderResult(result: ProductResult): boolean {
  if (result.status === "failed") return false;
  const hasDatasheet = result.documents.some((doc) => doc.type === "datasheet");
  const hasProductImage = result.documents.some((doc) => doc.type === "image");
  const isTelemecanique = result.sources.some((source) => source.parser === TELEMECANIQUE_PARSER);
  const hasStructuredSpecs = result.attributes.some((attr) => /^schneider (?:main|complementary|environment)$/i.test(attr.group ?? ""));
  return result.attributes.length >= 20 && hasStructuredSpecs && hasDatasheet && (hasProductImage || isTelemecanique);
}

function isTelemecaniqueProductUrl(requestedUrl: string, effectiveUrl: string): boolean {
  return /telemecaniquesensors\.com/i.test(`${requestedUrl} ${effectiveUrl}`);
}

function hasMeaningfulSchneiderProductData(attributes: AttributeRecord[], documents: DocumentRecord[]): boolean {
  if (documents.length > 0) return true;
  return attributes.some(
    (attr) =>
      attr.name !== "Catalog Number" &&
      !/^Schneider Product Info$/i.test(attr.group ?? "") &&
      cleanText(attr.value).length > 0
  );
}

function stampSchneiderAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  return attributes.map((attr) => ({
    ...attr,
    sourceType: attr.sourceType ?? "official",
    parser: attr.parser ?? SCHNEIDER_PARSER,
    confidence: attr.confidence ?? SCHNEIDER_CONFIDENCE
  }));
}

function stampSchneiderDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  return documents.map((doc) => ({
    ...doc,
    sourceType: doc.sourceType ?? "official",
    parser: doc.parser ?? SCHNEIDER_PARSER,
    confidence: doc.confidence ?? SCHNEIDER_CONFIDENCE
  }));
}

function stampSchneiderDatasheetAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  return attributes.map((attr) => ({
    ...attr,
    sourceType: attr.sourceType ?? "official-fallback",
    parser: attr.parser ?? SCHNEIDER_DATASHEET_READER_PARSER,
    confidence: attr.confidence ?? 0.84
  }));
}

function stampSchneiderDatasheetDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  return documents.map((doc) => ({
    ...doc,
    sourceType: doc.sourceType ?? "official-fallback",
    parser: doc.parser ?? SCHNEIDER_DATASHEET_READER_PARSER,
    confidence: doc.confidence ?? 0.84
  }));
}

function stampTelemecaniqueAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  return attributes.map((attr) => ({
    ...attr,
    sourceType: attr.sourceType ?? "official",
    parser: attr.parser ?? TELEMECANIQUE_PARSER,
    confidence: attr.confidence ?? 0.88
  }));
}

function stampTelemecaniqueDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  return documents.map((doc) => ({
    ...doc,
    sourceType: doc.sourceType ?? "official",
    parser: doc.parser ?? TELEMECANIQUE_PARSER,
    confidence: doc.confidence ?? 0.88
  }));
}

function telemecaniqueTitle($: cheerio.CheerioAPI, catalogNumber: string): string | undefined {
  const title = cleanText($("title").first().text().split("|")[0]);
  const withoutPart = title.replace(new RegExp(`^${escapeRegExp(catalogNumber)}\\s*-\\s*`, "i"), "");
  return withoutPart || undefined;
}

function extractTelemecaniqueCharacteristics($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const tokens = telemecaniqueTextTokens($);
  const attributes: AttributeRecord[] = [];
  const start = tokens.findIndex((token, index) => /^datasheet$/i.test(token) && /^main$/i.test(tokens[index + 1] ?? ""));
  if (start < 0) return attributes;

  let section = "Main";
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^(?:technical drawings|documents & downloads|related products & accessories)$/i.test(token)) break;
    if (TELEMECANIQUE_SECTIONS.some((candidate) => candidate.toLowerCase() === token.toLowerCase())) {
      section = titleCase(token);
      continue;
    }

    const label = canonicalTelemecaniqueLabel(token);
    if (!label) continue;
    const value = nextTelemecaniqueValue(tokens, index + 1);
    if (value) pushAttribute(attributes, `Schneider ${section}`, label, cleanTelemecaniqueValue(value), sourceUrl);
  }
  return attributes;
}

function extractTelemecaniqueDocuments($: cheerio.CheerioAPI, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  $("a[href]").each((_, element) => {
    const rawHref = $(element).attr("href");
    if (!rawHref || /^javascript:/i.test(rawHref)) return;
    const url = absoluteUrl(rawHref, sourceUrl);
    if (!url || !isTelemecaniqueDocumentUrl(url)) return;
    const label = cleanText($(element).text()) || telemecaniqueDocumentLabel(url);
    documents.push({ type: classifySchneiderDocument(label, url), label, url, sourceUrl });
  });
  return documents;
}

function extractTelemecaniqueImages($: cheerio.CheerioAPI, catalogNumber: string, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  $("img[src],img[data-src]").each((_, element) => {
    const rawUrl = $(element).attr("src") || $(element).attr("data-src");
    const url = absoluteUrl(rawUrl, sourceUrl);
    if (!url || !isImageUrl(url)) return;
    const context = `${url} ${$(element).attr("alt") ?? ""} ${$(element).attr("title") ?? ""}`.toLowerCase();
    if (/logo|icon|sprite|loader|flag|social|placeholder/.test(context)) return;
    if (
      !context.includes(catalogNumber.toLowerCase()) &&
      !/p_doc_ref|download\.schneider-electric|downloads\.telemecaniquesensors|dam\.telemecaniquesensors\.com|telemecaniquesensors\.dam-broadcast\.com/.test(context)
    ) {
      return;
    }
    documents.push({ type: "image", label: cleanText($(element).attr("alt") || $(element).attr("title")) || "Product image", url, sourceUrl });
  });
  return documents.slice(0, 8);
}

function telemecaniqueTextTokens($: cheerio.CheerioAPI): string[] {
  return $("body")
    .text()
    .split(/[\r\n\t]+/)
    .map((token) => cleanText(token))
    .filter(Boolean);
}

function canonicalTelemecaniqueLabel(value: string): string | undefined {
  const normalized = normalizeSchneiderPdfLabel(value);
  return TELEMECANIQUE_LABELS.find((label) => normalizeSchneiderPdfLabel(label) === normalized);
}

function nextTelemecaniqueValue(tokens: string[], start: number): string | undefined {
  for (let index = start; index < Math.min(tokens.length, start + 3); index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (TELEMECANIQUE_SECTIONS.some((section) => section.toLowerCase() === token.toLowerCase())) return undefined;
    if (/^(?:technical drawings|documents & downloads|related products & accessories)$/i.test(token)) return undefined;
    if (canonicalTelemecaniqueLabel(token)) return undefined;
    return token;
  }
  return undefined;
}

function cleanTelemecaniqueValue(value: string): string {
  return cleanText(value.replace(/\bCSAE2UL\b/g, "CSA; UL"));
}

function isTelemecaniqueDocumentUrl(url: string): boolean {
  const knownHost = /downloads\.telemecaniquesensors\.com|telemecaniquesensors\.com|download\.schneider-electric\.com/i.test(url);
  return (
    (knownHost && documentUrlLooksDownloadable(url)) ||
    /downloads\.telemecaniquesensors\.com\/dam\/|telemecaniquesensors\.com\/(?:global|us|uk|be|tr|pl)\/en\/download\/dam\//i.test(url)
  );
}

function telemecaniqueDocumentLabel(url: string): string {
  const filename = url.split("/").pop() ?? "";
  return cleanText(filename.replace(/[-_]/g, " ")) || "Telemecanique document";
}

function readReaderUrlSource(text: string): string | undefined {
  return cleanText(text.match(/^URL Source:\s*(.+)$/im)?.[1]) || undefined;
}

function readSchneiderDatasheetTitle(text: string, catalogNumber: string): string | undefined {
  const markdownContent = text.match(/Markdown Content:\s*([\s\S]*)/i)?.[1] ?? text;
  const contentLines = markdownContent
    .split(/\r?\n/)
    .map((line) => cleanSchneiderPdfLine(line.replace(/^#{1,6}\s*/, "")))
    .filter(Boolean);
  const catalogTitle = contentLines.find((line) => catalogTextMatches(line, catalogNumber) && isSchneiderDatasheetTitleCandidate(line));
  const firstTitle = contentLines.find(isSchneiderDatasheetTitleCandidate);
  const headingTitle = cleanSchneiderPdfLine(text.match(/^#\s+(.+)$/m)?.[1] ?? "");
  const title = catalogTitle || firstTitle || headingTitle || cleanText(text.match(/^Title:\s*(.+)$/im)?.[1]);
  if (!title || /\.pdf$/i.test(title) || /^schneider electric$/i.test(title)) return undefined;
  return withoutSchneiderBoilerplate(title, catalogNumber);
}

function isSchneiderDatasheetTitleCandidate(line: string): boolean {
  const cleaned = cleanSchneiderPdfLine(line);
  if (!cleaned || cleaned.length < 8) return false;
  if (/\.pdf$/i.test(cleaned) || /^schneider electric$/i.test(cleaned)) return false;
  if (/^(?:discontinued on|product availability|price is|main range|range of product|product data sheet|specifications)\b/i.test(cleaned)) return false;
  if (SCHNEIDER_DATASHEET_SECTIONS.some((section) => cleaned.toLowerCase() === section.toLowerCase())) return false;
  if (canonicalSchneiderDatasheetLabel(cleaned) || parseSchneiderDatasheetInlinePair(cleaned)) return false;
  return true;
}

function isFailedSchneiderDatasheetReader(text: string): boolean {
  return /\bTarget URL returned error\s+(?:403|404|410|451|5\d\d)\b|404:\s*Not Found|Access Denied|Request blocked/i.test(text);
}

function extractSchneiderDatasheetAttributes(text: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const lines = text
    .split(/\r?\n/)
    .map(cleanSchneiderPdfLine)
    .filter(Boolean);
  let section = "Main";

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (shouldSkipSchneiderPdfLine(line)) continue;

    const heading = parseSchneiderPdfHeading(line);
    if (heading) {
      section = heading.section;
      line = heading.content;
      if (!line) continue;
    }

    const pairs = parseSchneiderDatasheetLinePairs(line);
    if (pairs.length) {
      for (const pair of pairs) {
        pushAttribute(attributes, `Schneider ${pair.name === "Discontinued on" ? "Lifecycle" : section}`, pair.name, pair.value, sourceUrl);
      }
      continue;
    }

    const label = canonicalSchneiderDatasheetLabel(line);
    if (label) {
      const value = nextSchneiderDatasheetValue(lines, index + 1);
      if (value) pushAttribute(attributes, `Schneider ${section}`, label, value, sourceUrl);
    }
  }

  return attributes;
}

function parseSchneiderPdfHeading(line: string): { section: string; content: string } | undefined {
  const match = line.match(/^#{1,3}\s+(.+)$/);
  if (!match) return undefined;
  const text = cleanSchneiderPdfLine(match[1]);
  for (const section of SCHNEIDER_DATASHEET_SECTIONS) {
    if (text.toLowerCase() === section.toLowerCase()) return { section, content: "" };
    if (text.toLowerCase().startsWith(`${section.toLowerCase()} `)) {
      return { section, content: cleanText(text.slice(section.length)) };
    }
  }
  if (/product data sheet|specifications/i.test(text)) return { section: "Main", content: "" };
  if (/^discontinued on\b/i.test(text)) return { section: "Lifecycle", content: text };
  const colon = text.match(/^([^:]{2,90}):\s*(.+)$/);
  if (colon && isLikelySchneiderDatasheetLabel(colon[1])) {
    return {
      section: /^discontinued on$/i.test(cleanText(colon[1])) ? "Lifecycle" : "Main",
      content: text
    };
  }
  if (parseSchneiderDatasheetInlinePair(text)) return { section: "Main", content: text };
  return { section: "Main", content: "" };
}

function parseSchneiderDatasheetInlinePair(line: string): { name: string; value: string } | undefined {
  for (const label of SCHNEIDER_ALL_DATASHEET_LABELS) {
    const pattern = new RegExp(`^${flexibleLabelPattern(label)}(?:\\s+|$)(.*)$`, "i");
    const match = line.match(pattern);
    if (!match) continue;
    const value = cleanText(match[1]);
    if (!value || value.toLowerCase() === label.toLowerCase()) continue;
    return { name: canonicalSchneiderDatasheetLabel(label) ?? label, value };
  }
  return undefined;
}

function parseSchneiderDatasheetLinePairs(line: string): Array<{ name: string; value: string }> {
  const colon = line.match(/^([A-Z][^:]{2,90}):\s*(.+)$/);
  const leadingPair = colon && isLikelySchneiderDatasheetLabel(colon[1])
    ? { name: canonicalSchneiderDatasheetLabel(colon[1]) ?? cleanText(colon[1]), value: cleanText(colon[2]) }
    : parseSchneiderDatasheetInlinePair(line);
  return leadingPair ? splitChainedSchneiderDatasheetPairs(leadingPair) : [];
}

function splitChainedSchneiderDatasheetPairs(pair: { name: string; value: string }): Array<{ name: string; value: string }> {
  const pairs: Array<{ name: string; value: string }> = [];
  let name = canonicalSchneiderDatasheetLabel(pair.name) ?? pair.name;
  let value = cleanText(pair.value);

  for (let guard = 0; guard < 8 && value; guard += 1) {
    const next = nextChainedSchneiderDatasheetLabel(value);
    if (!next) {
      pairs.push({ name, value });
      break;
    }

    const currentValue = cleanText(value.slice(0, next.index));
    if (currentValue) pairs.push({ name, value: currentValue });
    name = canonicalSchneiderDatasheetLabel(next.label) ?? next.label;
    value = next.value;
  }

  return pairs.filter((entry) => entry.name && entry.value);
}

function nextChainedSchneiderDatasheetLabel(value: string): { label: string; index: number; value: string } | undefined {
  let best: { label: string; index: number; afterIndex: number } | undefined;
  for (const label of SCHNEIDER_CHAINED_DATASHEET_LABELS) {
    const match = value.match(new RegExp(`\\s+${flexibleLabelPattern(label)}\\s*:?(?:\\s+|$)`, "i"));
    if (!match || match.index === undefined) continue;
    const leading = match[0].match(/^\s*/)?.[0].length ?? 0;
    const index = match.index + leading;
    const afterIndex = match.index + match[0].length;
    const after = cleanText(value.slice(afterIndex));
    if (!after) continue;
    if (!best || index < best.index || (index === best.index && label.length > best.label.length)) {
      best = { label, index, afterIndex };
    }
  }
  if (!best) return undefined;
  return { label: best.label, index: best.index, value: cleanText(value.slice(best.afterIndex)) };
}

function canonicalSchneiderDatasheetLabel(value: string): string | undefined {
  const normalized = normalizeSchneiderPdfLabel(value);
  return SCHNEIDER_ALL_DATASHEET_LABELS.find((label) => normalizeSchneiderPdfLabel(label) === normalized);
}

function isLikelySchneiderDatasheetLabel(value: string): boolean {
  return Boolean(canonicalSchneiderDatasheetLabel(value)) || /^(product availability|note)$/i.test(cleanText(value));
}

function nextSchneiderDatasheetValue(lines: string[], start: number): string | undefined {
  for (let index = start; index < Math.min(lines.length, start + 4); index += 1) {
    const line = lines[index];
    if (!line || shouldSkipSchneiderPdfLine(line)) continue;
    if (parseSchneiderPdfHeading(line) || canonicalSchneiderDatasheetLabel(line) || parseSchneiderDatasheetInlinePair(line)) return undefined;
    return line;
  }
  return undefined;
}

function shouldSkipSchneiderPdfLine(line: string): boolean {
  return (
    /^Title:\s*/i.test(line) ||
    /^URL Source:\s*/i.test(line) ||
    /^Published Time:\s*/i.test(line) ||
    /^Number of Pages:\s*/i.test(line) ||
    /^Markdown Content:?$/i.test(line) ||
    /^Price is /i.test(line) ||
    /^Disclaimer:/i.test(line) ||
    /^>{0,1}\s*\d+\s*$/i.test(line) ||
    /^>?\s*(?:May|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}(?:\s+\d+)?$/i.test(line)
  );
}

function cleanSchneiderPdfLine(value: string): string {
  return cleanText(
    decodeEmbeddedHtml(value)
      .replace(/[\uE000-\uF8FF]/g, "")
      .replace(/\bSpeci\s+fi\s+c/gi, "Specific")
      .replace(/\bCerti\s+fi\s+cations?/gi, "Certifications")
      .replace(/\bEffi\s+ciency/gi, "Efficiency")
      .replace(/\bpro\s+fi\s+le/gi, "profile")
      .replace(/\*\*/g, "")
      .replace(/\s+\)/g, ")")
  );
}

function normalizeSchneiderPdfLabel(value: string): string {
  return cleanSchneiderPdfLine(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function flexibleLabelPattern(label: string): string {
  return escapeRegExp(label).replace(/\s+/g, "\\s+");
}

function readProductInfo(decoded: string, pageData: JsonObject[], catalogNumber: string): SchneiderProductInfo {
  const info: SchneiderProductInfo = {};
  for (const data of pageData) {
    info.brand ||= stringAt(data, ["base", "productInfo", "brand"]) || stringAt(data, ["brand"]);
    info.description ||=
      stringAt(data, ["base", "productInfo", "description"]) ||
      withoutSchneiderBoilerplate(stringAt(data, ["metaTags", "description"]), catalogNumber);
    info.productId ||=
      stringAt(data, ["metaTags", "productId"]) ||
      stringAt(data, ["base", "productId"]) ||
      stringAt(data, ["base", "productCR"]) ||
      stringAt(data, ["sku"]);
    info.title ||=
      stringAt(data, ["productName"]) ||
      withoutSchneiderBoilerplate(stringAt(data, ["metaTags", "title"]), catalogNumber);
    info.canonicalUrl ||= stringAt(data, ["metaTags", "canonicalUrl"]);
    info.metaDescription ||= withoutSchneiderBoilerplate(stringAt(data, ["metaTags", "description"]), catalogNumber);
  }

  return {
    brand: info.brand || readJsonString(decoded, /"brand":"([^"]+)"/),
    description: info.description || readJsonString(decoded, /"description":"([^"]+)"/),
    productId: info.productId || readJsonString(decoded, /"productId":"([^"]+)"/),
    title: info.title,
    canonicalUrl: info.canonicalUrl,
    metaDescription: info.metaDescription
  };
}

function extractProductInfoAttributes(
  productInfo: SchneiderProductInfo,
  catalogNumber: string,
  sourceUrl: string
): AttributeRecord[] {
  const attributes: AttributeRecord[] = [
    { group: "Schneider Product Info", name: "Catalog Number", value: catalogNumber, sourceUrl }
  ];
  if (productInfo.brand) attributes.push({ group: "Schneider Product Info", name: "Brand", value: productInfo.brand, sourceUrl });
  if (productInfo.productId) attributes.push({ group: "Schneider Product Info", name: "Product ID", value: productInfo.productId, sourceUrl });
  if (productInfo.description) attributes.push({ group: "Schneider Product Info", name: "Description", value: productInfo.description, sourceUrl });
  return attributes;
}

function readSchneiderPageData($: cheerio.CheerioAPI): JsonObject[] {
  const data: JsonObject[] = [];
  $("[plain-all-data]").each((_, element) => {
    const parsed = parseJsonObject($(element).attr("plain-all-data"));
    if (parsed) data.push(parsed);
  });

  $("[props]").each((_, element) => {
    const parsed = parseJsonObject($(element).attr("props"));
    if (!parsed) return;
    const decoded = decodeAstroValue(parsed);
    if (isRecord(decoded) && isSchneiderAstroProps(decoded)) data.push(decoded);
  });

  return data;
}

function isSchneiderAstroProps(value: JsonObject): boolean {
  return ["sku", "productName", "productSpecs", "productDocs", "productMedia", "brand"].some((key) => key in value);
}

function pageDataHasCatalogNumber(pageData: JsonObject[], catalogNumber: string): boolean {
  return pageData.some((data) =>
    [
      stringAt(data, ["metaTags", "productId"]),
      stringAt(data, ["base", "productId"]),
      stringAt(data, ["base", "productCR"]),
      stringAt(data, ["sku"])
    ].some((value) => value && catalogTextMatches(value, catalogNumber))
  );
}

function isBlockedSchneiderPage(decoded: string, statusCode?: number): boolean {
  if (statusCode !== undefined && statusCode >= 400) return true;
  const preview = decoded.slice(0, 3000);
  const hasProductPayload = /plain-all-data|productSpecs|characteristicTables|"characteristicName"|"productDocs"/i.test(decoded);
  return !hasProductPayload && /\b(access denied|request blocked|just a moment|captcha|forbidden)\b/i.test(preview);
}

function isNonProductSchneiderPage(decoded: string, sourceUrl: string): boolean {
  const preview = decoded.slice(0, 5000);
  if (/\/product-country-selector\/|\/country-selector\/|\/all-products\/|\/catalogsearch\/result\//i.test(sourceUrl)) return true;
  if (/<title>\s*(?:country selector|schneider .* store view marketplace)\s*<\/title>/i.test(preview)) return true;
  if (/\b(country selector|store view marketplace)\b/i.test(preview) && !/plain-all-data|productSpecs|characteristicTables|"productDocs"/i.test(decoded)) {
    return true;
  }
  return false;
}

function extractStructuredMetadataAttributes(pageData: JsonObject[], catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  for (const data of pageData) {
    pushAttribute(attributes, "Schneider Product Info", "Business Unit", stringAt(data, ["metaTags", "businessUnitName"]), sourceUrl);
    pushAttribute(attributes, "Schneider Product Info", "Keywords", stringAt(data, ["metaTags", "keywords"]), sourceUrl);
    pushAttribute(attributes, "Schneider Product Info", "Marketplace URL", stringAt(data, ["base", "marketplacePdpUrl"]), sourceUrl);

    const masterRange = stringAt(data, ["base", "masterRange", "rangeName"]);
    pushAttribute(attributes, "Schneider Product Info", "Master Range", masterRange, sourceUrl);

    for (const breadcrumb of arrayAt(data, ["breadcrumbs"])) {
      if (!isRecord(breadcrumb)) continue;
      const type = stringAt(breadcrumb, ["itemType"]);
      if (!type || /^(site|allproducts|product)$/i.test(type)) continue;
      const value = stringAt(breadcrumb, ["nameForChat"]) || stringAt(breadcrumb, ["name"]);
      pushAttribute(attributes, "Schneider Product Hierarchy", titleCase(type), value, sourceUrl);
    }

    for (const characteristic of arrayAt(data, ["base", "highlightedCharacteristics", "all"])) {
      if (!isRecord(characteristic)) continue;
      const label = stringAt(characteristic, ["label"]);
      const value = arrayAt(characteristic, ["values"]).map(formatScalar).filter(Boolean).join("; ");
      pushAttribute(attributes, "Schneider Product Info", label, value, sourceUrl);
    }

    const price = stringAt(data, ["base", "ctaArea", "price"]);
    const currency = stringAt(data, ["base", "ctaArea", "currency"]) || stringAt(data, ["metaTags", "currency"]);
    if (price) pushAttribute(attributes, "Schneider Commercial", "Price", currency ? `${price} ${currency}` : price, sourceUrl);

    for (const bullet of arrayAt(data, ["base", "bulletPoints"])) {
      if (!isRecord(bullet)) continue;
      pushAttribute(attributes, "Schneider Description", "Feature", stringAt(bullet, ["bulletPointText"]), sourceUrl);
    }

    const longDescription = arrayAt(data, ["specifications", "longDescSentences"]).map(formatScalar).filter(Boolean).join(" ");
    pushAttribute(attributes, "Schneider Description", "Long Description", longDescription, sourceUrl);

    const status = recordAt(data, ["base", "productStatus"]);
    pushAttribute(attributes, "Schneider Lifecycle", "Product Status", stringAt(status, ["title"]), sourceUrl);
    pushAttribute(attributes, "Schneider Lifecycle", "Commercial Message", stringAt(status, ["commercialMessage"]), sourceUrl);

    for (const selector of arrayAt(data, ["base", "variants", "chars"])) {
      if (!isRecord(selector)) continue;
      const title = stringAt(selector, ["title"]);
      const selected = arrayAt(selector, ["variants"]).find(
        (variant) =>
          isRecord(variant) &&
          (/selected/i.test(stringAt(variant, ["type"]) ?? "") ||
            catalogTextMatches(stringAt(variant, ["productId"]) ?? "", catalogNumber))
      );
      if (isRecord(selected)) pushAttribute(attributes, "Schneider Selected Variant", title, stringAt(selected, ["value"]), sourceUrl);
    }
  }
  return attributes;
}

function extractStructuredCharacteristics(pageData: JsonObject[], sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  for (const data of pageData) {
    const tables = [...arrayAt(data, ["specifications", "characteristicTables"]), ...arrayAt(data, ["productSpecs"])];
    for (const table of tables) {
      if (!isRecord(table)) continue;
      const tableName = stringAt(table, ["tableName"]);
      const group = tableName ? `Schneider ${tableName}` : "Schneider Characteristics";
      for (const row of arrayAt(table, ["rows"])) {
        if (!isRecord(row)) continue;
        const name = stringAt(row, ["characteristicName"]);
        const value = arrayAt(row, ["characteristicValues"]).map(formatCharacteristicValue).filter(Boolean).join("; ");
        pushAttribute(attributes, group, name, value, sourceUrl);
      }
    }
  }
  return attributes;
}

function extractStructuredSustainabilityCharacteristics(pageData: JsonObject[], sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  for (const data of pageData) {
    for (const group of arrayAt(data, ["environmentalData", "data", "groups"])) {
      if (!isRecord(group)) continue;
      for (const subGroup of arrayAt(group, ["subGroups"])) {
        if (!isRecord(subGroup)) continue;
        for (const record of arrayAt(subGroup, ["characteristicRecords"])) {
          if (!isRecord(record)) continue;
          const name = stringAt(record, ["charName", "labelText"]);
          const value = stringAt(record, ["charValue", "labelText"]) || stringAt(record, ["charValue", "externalUrl"]);
          pushAttribute(attributes, "Schneider Sustainability", name, value, sourceUrl);
        }
      }
    }
  }
  return attributes;
}

function extractStructuredDocuments(pageData: JsonObject[], sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const data of pageData) {
    addStructuredImage(documents, stringAt(data, ["metaTags", "ogImageSource"]), "Product image", sourceUrl);
    addProductMediaImages(documents, recordAt(data, ["base", "productMedia"]), sourceUrl);
    addProductMediaImages(documents, recordAt(data, ["productMedia"]), sourceUrl);

    const documentLists = [
      arrayAt(data, ["assetBarRelatedProducts", "assetBar", "documents"]),
      arrayAt(data, ["assetBarRelatedProducts", "assetBar", "secondaryDocuments"]),
      arrayAt(data, ["assetBar", "documents"]),
      arrayAt(data, ["assetBar", "secondaryDocuments"]),
      arrayAt(data, ["productDocs"])
    ];
    for (const list of documentLists) {
      for (const document of list) addStructuredDocument(documents, document, sourceUrl);
    }

    addEnvironmentalDocuments(documents, data, sourceUrl);
  }
  return documents;
}

function addStructuredDocument(documents: DocumentRecord[], value: unknown, sourceUrl: string): void {
  if (!isRecord(value)) return;
  const label =
    stringAt(value, ["titleForDisplay"]) ||
    stringAt(value, ["title"]) ||
    stringAt(value, ["documentType"]) ||
    stringAt(value, ["documentName"]) ||
    stringAt(value, ["label"]) ||
    "Schneider document";
  const urls = [stringAt(value, ["url"]), stringAt(value, ["downloadAll"]), stringAt(value, ["viewOnline"])]
    .map((url) => absoluteUrl(url, sourceUrl))
    .filter((url): url is string => Boolean(url));

  for (const url of urls) {
    const type = classifySchneiderDocument(label, url);
    documents.push({ type, label, url, sourceUrl });
  }

  for (const file of arrayAt(value, ["files"])) {
    addStructuredDocument(documents, file, sourceUrl);
  }
}

function addEnvironmentalDocuments(documents: DocumentRecord[], data: JsonObject, sourceUrl: string): void {
  for (const group of arrayAt(data, ["environmentalData", "data", "groups"])) {
    if (!isRecord(group)) continue;
    for (const subGroup of arrayAt(group, ["subGroups"])) {
      if (!isRecord(subGroup)) continue;
      for (const record of arrayAt(subGroup, ["characteristicRecords"])) {
        if (!isRecord(record)) continue;
        const url = absoluteUrl(stringAt(record, ["charValue", "externalUrl"]), sourceUrl);
        if (!url) continue;
        const label = stringAt(record, ["charName", "labelText"]) || stringAt(record, ["charValue", "labelText"]) || "Schneider document";
        documents.push({ type: classifySchneiderDocument(label, url), label, url, sourceUrl });
      }
    }
  }
}

function addProductMediaImages(documents: DocumentRecord[], media: JsonObject | undefined, sourceUrl: string): void {
  if (!media) return;
  walkRecords(media, (record) => {
    const url = stringAt(record, ["url"]);
    if (!isImageUrl(url)) return;
    const label = stringAt(record, ["title"]) || stringAt(record, ["alt"]) || imageLabelFromRef(readUrlParams(url).get("p_Doc_Ref") ?? "");
    addStructuredImage(documents, url, label, sourceUrl);
  });
}

function addStructuredImage(documents: DocumentRecord[], url: string | undefined, label: string, sourceUrl: string): void {
  const absolute = absoluteUrl(url, sourceUrl);
  if (!absolute || !isImageUrl(absolute)) return;
  documents.push({ type: "image", label: cleanText(label) || "Product image", url: absolute, sourceUrl });
}

function extractCharacteristics(decoded: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const pattern = /"characteristicName":"([^"]+)"[\s\S]{0,1200}?"characteristicValues":\[(.*?)\]/g;
  for (const match of decoded.matchAll(pattern)) {
    const name = cleanJsonValue(match[1]);
    const value = extractSchneiderValueList(match[2]).join("; ");
    if (!name || !value) continue;
    attributes.push({ group: "Schneider Characteristics", name, value, sourceUrl });
  }
  return attributes;
}

function extractSustainabilityCharacteristics(decoded: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const pattern = /"charName":\{"labelText":"([^"]+)"[\s\S]{0,600}?"charValue":\{([\s\S]{0,500}?)\}/g;
  for (const match of decoded.matchAll(pattern)) {
    const name = cleanJsonValue(match[1]);
    const value = extractSchneiderValueList(match[2]).join("; ");
    if (!name || !value) continue;
    attributes.push({ group: "Schneider Sustainability", name, value, sourceUrl });
  }
  return attributes;
}

function extractImageDocuments(decoded: string, catalogNumber: string, sourceUrl: string): DocumentRecord[] {
  const part = catalogNumber.toLowerCase();
  const documents: DocumentRecord[] = [];
  for (const url of extractDownloadUrls(decoded, sourceUrl)) {
    if (!/p_File_Type=rendition_/i.test(url)) continue;
    const params = readUrlParams(url);
    const ref = cleanText(params.get("p_Doc_Ref") ?? "");
    if (!ref.toLowerCase().includes(part)) continue;
    documents.push({
      type: "image",
      label: imageLabelFromRef(ref),
      url,
      sourceUrl
    });
  }
  return documents.sort((left, right) => imageRank(left.url) - imageRank(right.url)).slice(0, 8);
}

function extractLinkedDocuments(decoded: string, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const url of extractDownloadUrls(decoded, sourceUrl)) {
    if (/p_File_Type=rendition_/i.test(url)) continue;
    const params = readUrlParams(url);
    const label =
      cleanText(params.get("p_File_Name")) ||
      cleanText(params.get("p_Archive_Name")) ||
      cleanText(params.get("filename")) ||
      cleanText(params.get("p_enDocType")) ||
      cleanText(params.get("p_Doc_Ref")) ||
      "Schneider document";
    const type = classifySchneiderDocument(label, url);
    if (type === "other") continue;
    documents.push({ type, label, url, sourceUrl });
  }
  return documents;
}

function extractDownloadUrls(decoded: string, sourceUrl: string): string[] {
  const urls = new Set<string>();
  const patterns = [
    /https?:\/\/download\.(?:schneider-electric|se)\.com\/files\?[^"'<>\s]+/gi,
    /https?:\/\/(?:www\.)?se\.com\/[^"'<>\s]*\/product\/download-pdf\/[^"'<>\s]+/gi,
    /\/[^"'<>\s]*\/product\/download-pdf\/[^"'<>\s]+/gi
  ];
  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      const url = absoluteUrl(cleanEmbeddedUrl(match[0]), sourceUrl);
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

function readUrlParams(url: string): URLSearchParams {
  try {
    return new URL(url).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function imageLabelFromRef(ref: string): string {
  if (/dimension/i.test(ref)) return "Technical illustration with dimensions";
  if (/main|iop/i.test(ref)) return "Product image";
  return cleanText(ref) || "Product image";
}

function imageRank(url: string): number {
  if (/iopmain|main/i.test(url)) return 0;
  if (/dimension/i.test(url)) return 1;
  return 2;
}

function readJsonString(decoded: string, pattern: RegExp): string | undefined {
  const match = decoded.match(pattern);
  return match ? cleanJsonValue(match[1]) : undefined;
}

function cleanJsonValue(value: string): string {
  return cleanText(
    value
      .replace(/\\u0026/g, "&")
      .replace(/\\u003c/g, "<")
      .replace(/\\u003e/g, ">")
      .replace(/\\u0027/g, "'")
      .replace(/\\u0022/g, '"')
      .replace(/\\\//g, "/")
      .replace(/<br\s*\/?>/gi, "; ")
      .replace(/<\/?[^>]+>/g, " ")
  );
}

function cleanEmbeddedUrl(value: string): string {
  return decodeEmbeddedHtml(value)
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\\//g, "/")
    .replace(/[),.;]+$/g, "");
}

function extractSchneiderValueList(block: string): string[] {
  const labels = [...block.matchAll(/"labelText":"([^"]*)"/g)].map((match) => cleanJsonValue(match[1]));
  const urls = labels.length ? [] : [...block.matchAll(/"externalUrl":"([^"]*)"/g)].map((match) => cleanEmbeddedUrl(match[1]));
  return [...new Set([...labels, ...urls].map(cleanText).filter(Boolean))];
}

function decodeEmbeddedHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseJsonObject(value: string | undefined): JsonObject | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function decodeAstroValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === "number") {
      if (value[0] === 1) return Array.isArray(value[1]) ? value[1].map(decodeAstroValue) : [];
      return decodeAstroValue(value[1]);
    }
    return value.map(decodeAstroValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeAstroValue(entry)]));
  }
  return value;
}

function formatCharacteristicValue(value: unknown): string {
  if (!isRecord(value)) return formatScalar(value);
  const parts = [stringAt(value, ["beforeText"]), stringAt(value, ["labelText"]), stringAt(value, ["afterText"])].filter(Boolean);
  return cleanSchneiderValue(parts.join(" ")) || stringAt(value, ["externalUrl"]) || "";
}

function formatScalar(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return cleanSchneiderValue(String(value));
  return "";
}

function pushAttribute(
  attributes: AttributeRecord[],
  group: string,
  name: string | undefined,
  value: string | undefined,
  sourceUrl: string
): void {
  const cleanName = cleanSchneiderValue(name ?? "");
  const cleanValue = cleanSchneiderValue(value ?? "");
  if (!cleanName || !cleanValue) return;
  attributes.push({ group, name: cleanName, value: cleanValue, sourceUrl });
}

function classifySchneiderDocument(label: string, url: string): DocumentRecord["type"] {
  const text = `${label} ${url}`;
  if (/product\s+data\s*sheet|datasheet|download-pdf|p_enDocType=Product\+Data\+Sheet/i.test(text)) return "datasheet";
  if (/catalog/i.test(text)) return "datasheet";
  if (/user\s+guide|instruction\s+sheet|manual|installation/i.test(text)) return "manual";
  if (/\bcad\b|3d|2d|stp|step|dxf|dwg/i.test(text)) return "cad";
  if (/certificate|certification|declaration|conformity|rohs|reach|weee|environmental|pep|circularity|end\s+of\s+life/i.test(text)) return "certificate";
  return classifyDocument(label, url);
}

function isImageUrl(url: string | undefined): url is string {
  if (!url || /^(?:box-|icon-|[a-z-]+$)/i.test(url)) return false;
  return /p_File_Type=rendition_|\/files\?.*p_Doc_Ref=|\/(?:images?|assets)\/.*\.(?:png|jpe?g|webp|gif)(?:\?|$)|\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(
    url
  );
}

function absoluteUrl(url: string | undefined, baseUrl: string): string | undefined {
  const cleanUrl = cleanText(url);
  if (!cleanUrl) return undefined;
  try {
    return new URL(cleanUrl, baseUrl).toString();
  } catch {
    return cleanUrl;
  }
}

function firstText(...values: Array<string | undefined>): string {
  for (const value of values) {
    const cleaned = withoutSchneiderBoilerplate(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function withoutSchneiderBoilerplate(value: string | undefined, catalogNumber?: string): string | undefined {
  let cleaned = cleanSchneiderValue(value ?? "")
    .replace(/\s+\|\s+Schneider Electric.*$/i, "")
    .replace(/^Schneider Electric\s+[A-Z]{2,}\.\s*/i, "");
  if (catalogNumber) {
    cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(catalogNumber)}\\s*-\\s*`, "i"), "");
  }
  return cleaned || undefined;
}

function cleanSchneiderValue(value: string): string {
  const cleaned = cleanJsonValue(decodeEmbeddedHtml(value)).replace(/\s*;\s*/g, "; ").replace(/\s+([,.;:)])/g, "$1").trim();
  return cleaned
    .split(";")
    .map((part) => (part.includes("(") ? part : part.replace(/\)+$/g, "")))
    .join("; ")
    .trim();
}

function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function recordAt(value: unknown, path: string[]): JsonObject | undefined {
  const found = readPath(value, path);
  return isRecord(found) ? found : undefined;
}

function arrayAt(value: unknown, path: string[]): unknown[] {
  const found = readPath(value, path);
  return Array.isArray(found) ? found : [];
}

function stringAt(value: unknown, path: string[]): string | undefined {
  const found = readPath(value, path);
  return formatScalar(found) || undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walkRecords(value: unknown, visitor: (record: JsonObject) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkRecords(item, visitor);
    return;
  }
  if (!isRecord(value)) return;
  visitor(value);
  for (const child of Object.values(value)) walkRecords(child, visitor);
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
