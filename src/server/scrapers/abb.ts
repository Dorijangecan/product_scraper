import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, MarkerExtractionRule, ProductResult } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { delay, type FetchedText } from "./http-client.js";
import { classifyDocument, cleanText, emptyResult, mergeResults, normalizeFields, splitNameValue } from "./normalizer.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { catalogTextMatches, sameCatalogNumber } from "./catalog-number.js";
import { extractMarkerData } from "./marker-extractor.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";

const ABB_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const ABB_PARTCOMMUNITY_BASE_URL = "https://abb-control-products.partcommunity.com/3d-cad-models/";
const ABB_PARTCOMMUNITY_CATALOG = "abb_ww";
const ABB_PARTCOMMUNITY_PROJECTS = [
  {
    path: "abb_ww/low_voltage/breakers/demo/emax2/emax2_asmtab.prj",
    title: "E1.3 - ABB Low Voltage & Systems"
  }
];

export class ABBConnector implements ManufacturerConnector {
  id = "abb";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const searchLookup = await buildAbbSearchProductUrlLookup(catalogNumber, context, 2500);
    if (searchLookup.definitiveEmpty) {
      return abbOfficialMissingResult(catalogNumber, searchLookup);
    }

    const urls = searchLookup.urls.length ? searchLookup.urls : buildAbbOfficialUrls(catalogNumber);
    const officialResults: ProductResult[] = [];
    let lastError: unknown;

    let lastAemFetch: FetchedText | undefined;
    for (const url of urls) {
      try {
        const fetched = await fetchAbbPage(url, context);
        const parsed = parseAbbProductPage(catalogNumber, fetched, context.manufacturer.markerRules);
        officialResults.push(parsed);
        // Remember the page body that looked like an AEM-CMS product page so we can enrich it
        // afterwards by hitting the ds.library.abb.com widget API the page would call client-side.
        const isAemPage = isAemAbbPage(fetched.text);
        if (isAemPage && !lastAemFetch) lastAemFetch = fetched;
        if (context.imageOnly && hasProductImage(parsed)) break;
        if (isAemPage) break;
        if (isUsefulAbbSearchResult(parsed)) break;
        if (isRichAbbResult(parsed)) break;
      } catch (error) {
        lastError = error;
      }
    }

    const directPrimary = bestAbbResult(officialResults);
    // For AEM-style pages (PLCs, drives, robotics), the English /products/{id} URL serves a thin
    // AEM page and the full PIS data is only available under /products/{locale}/{id}/{slug}.
    // Only run search resolution when direct URLs did not already provide rich PIS data. This
    // keeps ordinary ABB product IDs fast while preserving the AEM/alias rescue path.
    const searchUrls = (context.imageOnly && hasProductImage(directPrimary)) || isRichAbbResult(directPrimary) || searchLookup.urls.length
      ? []
      : (await buildAbbSearchProductUrlLookup(catalogNumber, context, 8000)).urls;
    const searchPrimary = searchUrls.length
      ? bestAbbResult(await fetchAbbSearchResults(catalogNumber, context, searchUrls))
      : undefined;

    // Explicit locale fallback for AEM products. The English /products/{id} URL serves the thin
    // AEM CMS page; the same catalog number under /products/{de,pl,it}/{id} consistently serves
    // the rich PIS page with the `var model = {...}` blob that contains ProductNetWeight,
    // ProductNetDepth/Height/Width, etc. We only pay this cost when EN + PIS search both failed
    // to surface PIS data, so non-AEM products are not slowed down.
    let localeFallbackPrimary: ProductResult | undefined;
    if (!hasAbbPisData(directPrimary) && !hasAbbPisData(searchPrimary) && (lastAemFetch || searchLookup.urls.length > 0 || searchUrls.length > 0)) {
      localeFallbackPrimary = bestAbbResult(await fetchAbbLocaleFallbackResults(catalogNumber, context));
    }

    // AEM enrichment via ABB Library widget API, when document discovery is enabled.
    let aemEnriched: ProductResult | undefined;
    if (lastAemFetch && context.downloadDocuments !== false && !context.imageOnly) {
      aemEnriched = await enrichFromAbbLibraryApi(catalogNumber, lastAemFetch, context);
    }

    // Browser render last resort: if no PIS data anywhere yet AND we have an AEM page available,
    // render it via Playwright so the client-side widgets populate the DOM with the technical data
    // table, then re-parse. Only fires for AEM products where every static-HTML path has failed.
    let browserPrimary: ProductResult | undefined;
    const haveAnyPisData = [directPrimary, searchPrimary, localeFallbackPrimary, aemEnriched].some(hasAbbPisData);
    if (!haveAnyPisData && lastAemFetch && context.browserRenderer && !context.imageOnly) {
      browserPrimary = await renderAbbAemPageInBrowser(catalogNumber, lastAemFetch.effectiveUrl, context);
    }

    const initialMerged = mergeAbbResults(directPrimary, searchPrimary, localeFallbackPrimary, aemEnriched, browserPrimary);
    const needsCadCatalog = !initialMerged || initialMerged.status === "failed" || (!isRichAbbResult(initialMerged) && (!context.imageOnly || !hasProductImage(initialMerged)));
    const cadCatalogResult = needsCadCatalog
      ? await fetchAbbPartcommunityCadCatalogResult(catalogNumber, context)
      : undefined;
    const merged = mergeAbbResults(directPrimary, searchPrimary, localeFallbackPrimary, aemEnriched, browserPrimary, cadCatalogResult);
    if (merged && isRichAbbResult(merged)) return merged;
    if (merged && merged.status !== "failed") return merged;

    const primary =
      merged ??
      directPrimary ??
      officialResults.find((result) => result.status === "partial") ??
      officialResults[0] ??
      emptyResult("abb", catalogNumber, abbFetchFailureMessage(lastError));

    if (context.imageOnly) return primary;
    if (primary.status === "found" && primary.documents.length > 0) return primary;
    const enriched = primary;

    try {
      const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
      return mergeResults(enriched, fallback);
    } catch (error) {
      return {
        ...enriched,
        error: enriched.error ?? (error instanceof Error ? error.message : "ABB fallback failed.")
      };
    }
  }
}

function abbFetchFailureMessage(_error: unknown): string {
  return "ABB official product pages and PIS search did not return exact product data.";
}

async function fetchAbbPartcommunityCadCatalogResult(
  catalogNumber: string,
  context: ScrapeContext
): Promise<ProductResult | undefined> {
  const directUrl = abbPartcommunityPartUrl(catalogNumber);
  const directFetched = await fetchAbbPartcommunityOptional(directUrl, context);
  if (directFetched) {
    const direct = parseAbbPartcommunityDetailPage(catalogNumber, directFetched);
    if (direct) return direct;
  }

  for (const project of ABB_PARTCOMMUNITY_PROJECTS) {
    const projectUrl = abbPartcommunityProjectFileUrl(project.path);
    const projectFetched = await fetchAbbPartcommunityOptional(projectUrl, context);
    if (!projectFetched || !abbPartcommunityProjectMentionsCatalog(projectFetched.text, catalogNumber)) continue;

    const familyUrl = abbPartcommunityFamilyUrl(project.path);
    const familyFetched = await fetchAbbPartcommunityOptional(familyUrl, context);
    return buildAbbPartcommunityProjectResult(catalogNumber, project, projectFetched, familyFetched, directFetched);
  }

  return undefined;
}

async function fetchAbbPartcommunityOptional(url: string, context: ScrapeContext): Promise<FetchedText | undefined> {
  try {
    const fetched = await context.http.fetchText(url, {
      timeoutMs: 10000,
      cacheTtlMs: 1000 * 60 * 60 * 24 * 7,
      signal: context.signal,
      maxAttempts: 1,
      headers: {
        "user-agent": ABB_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain,application/octet-stream,*/*;q=0.8"
      }
    });
    return fetched.statusCode < 500 ? fetched : undefined;
  } catch {
    return undefined;
  }
}

function parseAbbPartcommunityDetailPage(catalogNumber: string, fetched: FetchedText): ProductResult | undefined {
  const $ = cheerio.load(fetched.text);
  const partNumber = cleanText($("h1.part-nb").first().text());
  if (!sameCatalogNumber(partNumber, catalogNumber)) return undefined;

  const sourceUrl = fetched.effectiveUrl;
  const partId = cleanText($("#PCOM_CURRENT_PARTID").text());
  const partIdValues = parsePartcommunityPartId(partId);
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];

  const addAttr = (name: string, value: string | undefined, confidence = 0.9) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    attributes.push({
      group: "ABB CAD Catalog",
      name,
      value: cleaned,
      sourceUrl,
      sourceType: "official",
      parser: "abb-partcommunity-cad-catalog",
      confidence
    });
  };

  $(".editable-part-table tbody tr, .catalog-info-unit-table tbody tr, tr").each((_, row) => {
    const cells = $(row)
      .find("th,td")
      .map((__, cell) => cleanText($(cell).text()))
      .get()
      .filter(Boolean);
    if (cells.length < 2) return;
    const name = cells[0].replace(/:\s*$/, "");
    const value = cells[1];
    if (!name || !value || name === value) return;
    addAttr(name, value, 0.88);
  });

  addAttr("Product ID", catalogNumber, 0.98);
  addAttr("Bill of material", partIdValues.NB ?? partIdValues.PN_BMECAT_HELP, 0.94);
  addAttr("Product Number", partIdValues.PN, 0.94);
  addAttr("Extended Product Type", partIdValues.DESCSHORT, 0.9);
  addAttr("Catalog Description", partIdValues.DESCSHORT, 0.9);
  addAttr("Long Description", partIdValues.DESCLONG, 0.9);
  addAttr("EAN / GTIN", partIdValues.INTNO, 0.86);
  addAttr("Customs Tariff Number", partIdValues.CTN, 0.84);
  addAttr("Manufacturer Name", partIdValues.MANUNAME, 0.84);
  addAttr("PARTcommunity Current Part ID", partId, 0.8);

  const imageUrl = abbPartcommunityImageUrl(partIdValues.PATH ? `${ABB_PARTCOMMUNITY_CATALOG}/${partIdValues.PATH}.png` : ABB_PARTCOMMUNITY_PROJECTS[0].path.replace(/\.prj$/i, ".png"));
  documents.push({
    type: "image",
    label: "ABB CAD catalog product image",
    url: imageUrl,
    sourceUrl,
    sourceType: "official",
    parser: "abb-partcommunity-cad-catalog",
    confidence: 0.82
  });

  if (partIdValues.AAQ326) {
    documents.push({
      type: "other",
      label: "ABB product detail page",
      url: partIdValues.AAQ326,
      sourceUrl,
      sourceType: "official",
      parser: "abb-partcommunity-cad-catalog",
      confidence: 0.75
    });
  }

  const title = cleanText(partIdValues.DESCSHORT) || partNumber;
  const description = cleanText(partIdValues.DESCLONG) || cleanText($("meta[name='description']").attr("content"));
  const cleanAttributes = dedupeAttributes(attributes);
  const cleanDocuments = dedupeDocuments(documents);

  return {
    manufacturerId: "abb",
    catalogNumber,
    status: cleanAttributes.length || cleanDocuments.length ? "found" : "partial",
    confidence: 0.86,
    productUrl: sourceUrl,
    localizedUrls: buildLocalizedProductUrls("abb", catalogNumber, sourceUrl),
    title,
    description,
    normalized: normalizeFields(cleanAttributes, cleanDocuments),
    attributes: cleanAttributes,
    documents: cleanDocuments,
    sources: [
      {
        url: sourceUrl,
        sourceType: "official",
        parser: "abb-partcommunity-cad-catalog",
        parserVersion: "abb-v2",
        stage: "partcommunity-order-number",
        reason: "ABB CAD Download Center returned an exact order-number page.",
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode
      }
    ]
  };
}

function buildAbbPartcommunityProjectResult(
  catalogNumber: string,
  project: { path: string; title: string },
  projectFetched: FetchedText,
  familyFetched?: FetchedText,
  directFetched?: FetchedText
): ProductResult {
  const metadata = familyFetched ? parseAbbPartcommunityFamilyMetadata(familyFetched.text) : {};
  const projectMetadata = parseAbbPartcommunityProjectMetadata(projectFetched.text);
  const sourceUrl = projectFetched.effectiveUrl;
  const exactPartUrl = abbPartcommunityPartUrl(catalogNumber);
  const detailStatus = directFetched ? parsePartcommunityTopMessage(directFetched.text) : undefined;
  const title = metadata.title || project.title;
  const description = metadata.description || metadata.breadcrumbs?.join(" > ") || project.title;
  const imageUrl = abbPartcommunityImageUrl(project.path.replace(/\.prj$/i, ".png"));
  const attributes: AttributeRecord[] = [
    {
      group: "ABB CAD Catalog",
      name: "Product ID",
      value: catalogNumber,
      sourceUrl,
      sourceType: "official",
      parser: "abb-partcommunity-cad-project",
      confidence: 0.98
    },
    {
      group: "ABB CAD Catalog",
      name: "Catalog Match Evidence",
      value: `PN_BMECAT_HELP.EQ.'${catalogNumber}'`,
      sourceUrl,
      sourceType: "official",
      parser: "abb-partcommunity-cad-project",
      confidence: 0.96
    },
    {
      group: "ABB CAD Catalog",
      name: "CAD Catalog Project",
      value: project.path,
      sourceUrl,
      sourceType: "official",
      parser: "abb-partcommunity-cad-project",
      confidence: 0.92
    },
    {
      group: "ABB CAD Catalog",
      name: "Catalog Description",
      value: title,
      sourceUrl: familyFetched?.effectiveUrl ?? sourceUrl,
      sourceType: "official",
      parser: "abb-partcommunity-cad-project",
      confidence: 0.82
    },
    {
      group: "ABB CAD Catalog",
      name: "Long Description",
      value: description,
      sourceUrl: familyFetched?.effectiveUrl ?? sourceUrl,
      sourceType: "official",
      parser: "abb-partcommunity-cad-project",
      confidence: 0.82
    },
    ...optionalPartcommunityProjectAttribute("Catalog File Date", projectMetadata.date, sourceUrl),
    ...optionalPartcommunityProjectAttribute("Geometry Date", projectMetadata.geometryDate, sourceUrl),
    ...optionalPartcommunityProjectAttribute("QA State", projectMetadata.qaState, sourceUrl),
    ...optionalPartcommunityProjectAttribute("Published State", projectMetadata.published, sourceUrl),
    ...optionalPartcommunityProjectAttribute("Catalog Breadcrumb", metadata.breadcrumbs?.join(" > "), familyFetched?.effectiveUrl ?? sourceUrl),
    ...optionalPartcommunityProjectAttribute("Exact Part Page Status", detailStatus, directFetched?.effectiveUrl ?? exactPartUrl)
  ];
  const documents: DocumentRecord[] = [
    {
      type: "image",
      label: "ABB CAD catalog family image",
      url: imageUrl,
      sourceUrl: familyFetched?.effectiveUrl ?? sourceUrl,
      sourceType: "official",
      parser: "abb-partcommunity-cad-project",
      confidence: 0.78
    },
    {
      type: "cad",
      label: "ABB CAD catalog family page",
      url: abbPartcommunityFamilyUrl(project.path),
      sourceUrl,
      sourceType: "official",
      parser: "abb-partcommunity-cad-project",
      confidence: 0.72
    }
  ];
  const cleanAttributes = dedupeAttributes(attributes);
  const cleanDocuments = dedupeDocuments(documents);

  return {
    manufacturerId: "abb",
    catalogNumber,
    status: "found",
    confidence: 0.78,
    productUrl: exactPartUrl,
    localizedUrls: buildLocalizedProductUrls("abb", catalogNumber, exactPartUrl),
    title,
    description,
    normalized: normalizeFields(cleanAttributes, cleanDocuments),
    attributes: cleanAttributes,
    documents: cleanDocuments,
    sources: [
      {
        url: sourceUrl,
        sourceType: "official",
        parser: "abb-partcommunity-cad-project",
        parserVersion: "abb-v2",
        stage: "partcommunity-cad-project",
        reason: "ABB CADENAS project file contains the exact catalog number in its published classification restriction.",
        fetchedAt: projectFetched.fetchedAt,
        statusCode: projectFetched.statusCode
      },
      ...(familyFetched
        ? [{
            url: familyFetched.effectiveUrl,
            sourceType: "official" as const,
            parser: "abb-partcommunity-cad-project",
            parserVersion: "abb-v2",
            stage: "partcommunity-cad-family",
            reason: "ABB CAD Download Center family page supplied catalog metadata and image.",
            fetchedAt: familyFetched.fetchedAt,
            statusCode: familyFetched.statusCode
          }]
        : []),
      ...(directFetched
        ? [{
            url: directFetched.effectiveUrl,
            sourceType: "official" as const,
            parser: "abb-partcommunity-cad-project",
            parserVersion: "abb-v2",
            stage: "partcommunity-order-number",
            reason: detailStatus || "Checked ABB CAD Download Center exact order-number page.",
            fetchedAt: directFetched.fetchedAt,
            statusCode: directFetched.statusCode
          }]
        : [])
    ],
    diagnostics: {
      notes: detailStatus
        ? [`ABB CAD catalog file lists ${catalogNumber}; exact Partcommunity order-number page reported: ${detailStatus}`]
        : [`ABB CAD catalog file lists ${catalogNumber}.`]
    }
  };
}

function optionalPartcommunityProjectAttribute(name: string, value: string | undefined, sourceUrl: string): AttributeRecord[] {
  const cleaned = cleanText(value);
  if (!cleaned) return [];
  return [{
    group: "ABB CAD Catalog",
    name,
    value: cleaned,
    sourceUrl,
    sourceType: "official",
    parser: "abb-partcommunity-cad-project",
    confidence: 0.78
  }];
}

function parseAbbPartcommunityFamilyMetadata(html: string): { title?: string; description?: string; breadcrumbs?: string[] } {
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text());
  const description = cleanText($("meta[name='description']").attr("content") ?? $("meta[property='description']").attr("content"));
  const breadcrumbs = $("ol.breadcrumb [property='name']")
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean);
  return { title, description, breadcrumbs: breadcrumbs.length ? breadcrumbs : undefined };
}

function parseAbbPartcommunityProjectMetadata(text: string): { date?: string; geometryDate?: string; qaState?: string; published?: string } {
  return {
    date: firstPartcommunityProjectField(text, "DATE"),
    geometryDate: firstPartcommunityProjectField(text, "GEOMDATE"),
    qaState: firstPartcommunityProjectField(text, "QASTATE"),
    published: firstPartcommunityProjectField(text, "PUBLISHED")
  };
}

function firstPartcommunityProjectField(text: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${escapeRegExp(key)}=([^\\r\\n\\s]+(?:\\s+[^\\r\\n\\s]+)?)`, "i").exec(text);
  return cleanText(match?.[1]);
}

function parsePartcommunityTopMessage(html: string): string | undefined {
  const match = html.match(/showTopMessage\(\s*['"]error['"]\s*,\s*['"]([^'"]+)['"]/i);
  return cleanText(match?.[1]);
}

function parsePartcommunityPartId(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of value.matchAll(/\{([^={}]+)=([^}]*)\}/g)) {
    result[cleanText(match[1])] = cleanText(match[2]);
  }
  return result;
}

function abbPartcommunityProjectMentionsCatalog(text: string, catalogNumber: string): boolean {
  const escaped = escapeRegExp(catalogNumber);
  return new RegExp(`PN_BMECAT_HELP\\.EQ\\.'${escaped}'`, "i").test(text);
}

function abbPartcommunityPartUrl(catalogNumber: string): string {
  const params = new URLSearchParams({
    catalog: ABB_PARTCOMMUNITY_CATALOG,
    part: catalogNumber
  });
  return `${ABB_PARTCOMMUNITY_BASE_URL}?${params.toString()}`;
}

function abbPartcommunityFamilyUrl(projectPath: string): string {
  const params = new URLSearchParams({ info: projectPath });
  return `${ABB_PARTCOMMUNITY_BASE_URL}?${params.toString()}`;
}

function abbPartcommunityProjectFileUrl(projectPath: string): string {
  const encodedPath = projectPath.split("/").map(encodeURIComponent).join("/");
  return `${ABB_PARTCOMMUNITY_BASE_URL}FileService/CatalogFile/${encodedPath}`;
}

function abbPartcommunityImageUrl(previewPath: string): string {
  const params = new URLSearchParams({
    previewPath,
    width: "512",
    height: "512",
    color: "transparent",
    depth: "32"
  });
  return `https://abb-control-products.partcommunity.com/FileService/CatalogImage/?${params.toString()}`;
}

function mergeAbbResults(...candidates: Array<ProductResult | undefined>): ProductResult | undefined {
  const usable = candidates.filter((c): c is ProductResult => Boolean(c) && c!.status !== "failed");
  if (!usable.length) return undefined;
  // Pick the most informative as the base, then merge the rest on top.
  usable.sort((a, b) => abbResultScore(b) - abbResultScore(a));
  let merged = usable[0];
  for (const next of usable.slice(1)) merged = mergeResults(merged, next);
  return merged;
}

function isAemAbbPage(html: string): boolean {
  // AEM-CMS ABB product pages don't ship `var model =` but DO load the abbDownloadSection widget
  // pointing at ds.library.abb.com. They also contain the `pisproductdetails` placeholder div
  // that's populated client-side.
  return !/\bvar\s+model\s*=/.test(html) && /abbDownloadSection\s*\(/i.test(html);
}

async function enrichFromAbbLibraryApi(
  catalogNumber: string,
  fetched: FetchedText,
  context: ScrapeContext
): Promise<ProductResult | undefined> {
  const widgetConfig = parseAbbWidgetConfig(fetched.text);
  if (!widgetConfig?.cid || !widgetConfig.productId) return undefined;
  const params = new URLSearchParams({
    categoryIds: widgetConfig.cid,
    languageCode: widgetConfig.languageCode || "en",
    countryCode: widgetConfig.countryCode || "*",
    clientCode: widgetConfig.clientCode || "aotaem",
    includeDocumentsFromSubcategories: "true",
    source: widgetConfig.applicationCode || "sf",
    productIds: widgetConfig.productId,
    productIdDomains: widgetConfig.productIdDomain || "*",
    pageNumber: "1",
    pageSize: "200"
  });
  const listUrl = `https://ds.library.abb.com/api/downloadsection/documents/public/list/${encodeURIComponent(widgetConfig.countryCode || "*")}/${encodeURIComponent(widgetConfig.languageCode || "en")}/c?${params.toString()}`;
  const synopsisUrl = `https://ds.library.abb.com/api/downloadsection/documents/public/synopsis/${encodeURIComponent(widgetConfig.countryCode || "*")}/${encodeURIComponent(widgetConfig.languageCode || "en")}/c?${params.toString()}`;

  let documentList: AbbLibraryDocGroup[] = [];
  let synopsis: AbbLibrarySynopsis | undefined;
  try {
    const listFetched = await context.http.fetchText(listUrl, {
      timeoutMs: 25000,
      signal: context.signal,
      maxAttempts: 2,
      headers: { accept: "application/json", referer: fetched.effectiveUrl, origin: "https://new.abb.com" }
    });
    if (listFetched.statusCode < 400) {
      documentList = JSON.parse(listFetched.text) as AbbLibraryDocGroup[];
    }
  } catch {
    // Fall through with empty doc list — synopsis may still work.
  }
  try {
    const synopsisFetched = await context.http.fetchText(synopsisUrl, {
      timeoutMs: 25000,
      signal: context.signal,
      maxAttempts: 2,
      headers: { accept: "application/json", referer: fetched.effectiveUrl, origin: "https://new.abb.com" }
    });
    if (synopsisFetched.statusCode < 400) {
      synopsis = JSON.parse(synopsisFetched.text) as AbbLibrarySynopsis;
    }
  } catch {
    // No synopsis — that's fine, we'll still have docs.
  }

  const attributes = [...buildAbbLibraryAttributes(synopsis, fetched.effectiveUrl)];
  const documents = [...buildAbbLibraryDocuments(documentList, fetched.effectiveUrl)];
  if (!attributes.length && !documents.length) return undefined;

  return {
    manufacturerId: "abb",
    catalogNumber,
    status: "found",
    confidence: 0.86,
    productUrl: fetched.effectiveUrl,
    localizedUrls: buildLocalizedProductUrls("abb", catalogNumber, fetched.effectiveUrl),
    title: "",
    description: "",
    normalized: normalizeFields(attributes, documents),
    attributes,
    documents,
    sources: [
      {
        url: listUrl,
        sourceType: "official",
        parser: "abb-aem-library-api",
        parserVersion: "abb-v2",
        fetchedAt: new Date().toISOString(),
        statusCode: 200
      }
    ]
  };
}

interface AbbWidgetConfig {
  cid?: string;
  productId?: string;
  productIdDomain?: string;
  clientCode?: string;
  languageCode?: string;
  countryCode?: string;
  applicationCode?: string;
}

function parseAbbWidgetConfig(html: string): AbbWidgetConfig | undefined {
  const block = html.match(/abbDownloadSection\(\s*(\{[\s\S]*?\})\s*\)/);
  if (!block) return undefined;
  const config: AbbWidgetConfig = {};
  for (const [key, prop] of [
    ["cid", "cid"],
    ["productId", "productId"],
    ["productIdDomain", "productIdDomain"],
    ["clientCode", "clientCode"],
    ["languageCode", "languageCode"],
    ["countryCode", "countryCode"],
    ["applicationCode", "applicationCode"]
  ] as const) {
    const match = new RegExp(`["']${prop}["']\\s*:\\s*["']([^"']*)["']`, "i").exec(block[1]);
    if (match && match[1]) config[key] = match[1];
  }
  // The widget initializes countryCode dynamically via window.aot. Default to "*" so the API
  // returns documents for all regions.
  if (!config.countryCode || config.countryCode === "global") config.countryCode = "*";
  return config;
}

interface AbbLibraryDocument {
  DocumentID?: string;
  RevisionID?: string;
  DocumentPartID?: string;
  Title?: string;
  DocumentLanguageTitle?: string;
  Summary?: string;
  TranslatedDocumentKind?: string;
  RepresentationFileNameSuffix?: string;
  LanguageCode?: string[];
  Language?: string[];
  NormalizedSecurityLevels?: string[];
  Level0Names?: string[];
}

interface AbbLibraryDocGroup {
  Key?: string;
  Value?: AbbLibraryDocument[];
}

interface AbbLibrarySynopsisCategory {
  Title?: string;
  ID?: string;
  HitCount?: number;
  SubCategories?: AbbLibrarySynopsisCategory[];
}

interface AbbLibrarySynopsis {
  Countries?: Array<{ Code?: string; Name?: string; HitCount?: number }>;
  Languages?: Array<{ Code?: string; Name?: string; HitCount?: number }>;
  DocumentKinds?: Array<{ Key?: string; Value?: Array<{ Title?: string; HitCount?: number }> }>;
  CategoriesProductsAndIndustries?: AbbLibrarySynopsisCategory[];
  CurrentCategory?: { Title?: string; ID?: string };
  NumberOfHitsInCurrentAllCategories?: number;
}

function buildAbbLibraryDocuments(groups: AbbLibraryDocGroup[], sourceUrl: string): DocumentRecord[] {
  if (!Array.isArray(groups)) return [];
  const documents: DocumentRecord[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const kind = cleanText(group.Key ?? "");
    for (const doc of group.Value ?? []) {
      const id = cleanText(doc.DocumentID ?? "");
      if (!id) continue;
      const title = cleanText(doc.Title ?? doc.DocumentLanguageTitle ?? "");
      const language = doc.LanguageCode?.[0] ?? "en";
      const url = abbLibraryDownloadUrlWithLang(id, language, doc.DocumentPartID ?? "");
      const key = `${url}|${kind}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      documents.push({
        type: classifyAbbLibraryDocument(kind, title, doc.RepresentationFileNameSuffix),
        label: `${kind ? `${kind}: ` : ""}${title || id}`,
        url,
        sourceUrl,
        sourceType: "official",
        parser: "abb-aem-library-api",
        confidence: 0.92,
        meta: {
          documentId: id,
          revision: doc.RevisionID,
          languages: doc.Language?.join(", "),
          summary: doc.Summary?.slice(0, 500)
        }
      } as unknown as DocumentRecord);
    }
  }
  return documents;
}

function abbLibraryDownloadUrlWithLang(documentId: string, languageCode: string, documentPartId: string): string {
  const params = new URLSearchParams({
    DocumentID: documentId,
    LanguageCode: languageCode || "en",
    DocumentPartId: documentPartId || "",
    Action: "Launch"
  });
  return `https://search.abb.com/library/Download.aspx?${params.toString()}`;
}

function classifyAbbLibraryDocument(
  kind: string,
  title: string,
  suffix: string | undefined
): DocumentRecord["type"] {
  const text = `${kind} ${title}`.toLowerCase();
  if (/manual|instruction|hardware manual|software manual|operating|user guide/i.test(text)) return "manual";
  if (/data sheet|datasheet|technical (?:data|information|note)|catalog|catalogue|brochure/i.test(text)) return "datasheet";
  if (/certificate|declaration|conformity|rohs|reach|atex|csa|ul|vde|cmrt|tsca|weee|epd/i.test(text)) return "certificate";
  if (/cad|drawing|dimension|3d model|step|dxf|dwg/i.test(text)) return "cad";
  if (/software|firmware|driver|installer|setup/i.test(text)) return "other";
  if (suffix && /^(?:stp|step|dxf|dwg|igs|iges)$/i.test(suffix)) return "cad";
  if (suffix && /^(?:pdf|txt|html)$/i.test(suffix)) return "other";
  return "other";
}

function buildAbbLibraryAttributes(synopsis: AbbLibrarySynopsis | undefined, sourceUrl: string): AttributeRecord[] {
  if (!synopsis) return [];
  const attributes: AttributeRecord[] = [];
  // Category breadcrumb path (e.g. ABB Products > PLC Automation > AC500 > Accessories).
  const path = collectAbbLibraryCategoryPath(synopsis.CategoriesProductsAndIndustries ?? []);
  if (path.length > 0) {
    attributes.push({
      group: "ABB Product Classification",
      name: "Library Category Path",
      value: path.join(" > "),
      sourceUrl,
      sourceType: "official",
      parser: "abb-aem-library-api",
      confidence: 0.86
    });
  }
  if (synopsis.CurrentCategory?.Title) {
    attributes.push({
      group: "ABB Product Classification",
      name: "Library Category",
      value: cleanText(synopsis.CurrentCategory.Title),
      sourceUrl,
      sourceType: "official",
      parser: "abb-aem-library-api",
      confidence: 0.86
    });
  }
  // Available document kinds — a quick "what kinds of docs exist for this product".
  for (const kindBucket of synopsis.DocumentKinds ?? []) {
    for (const kind of kindBucket.Value ?? []) {
      if (!kind.Title) continue;
      attributes.push({
        group: "ABB Library Documents",
        name: `${cleanText(kindBucket.Key ?? "Kind")}: ${cleanText(kind.Title)}`,
        value: `${kind.HitCount ?? 0} document(s)`,
        sourceUrl,
        sourceType: "official",
        parser: "abb-aem-library-api",
        confidence: 0.8
      });
    }
  }
  for (const lang of (synopsis.Languages ?? []).slice(0, 12)) {
    if (!lang.Name) continue;
    attributes.push({
      group: "ABB Library Documents",
      name: `Language available: ${cleanText(lang.Name)}`,
      value: `${lang.HitCount ?? 0} document(s)`,
      sourceUrl,
      sourceType: "official",
      parser: "abb-aem-library-api",
      confidence: 0.7
    });
  }
  return attributes;
}

function collectAbbLibraryCategoryPath(categories: AbbLibrarySynopsisCategory[]): string[] {
  // The synopsis returns a deeply-nested tree of categories. Walk down the most-hit branch
  // until we hit a leaf to produce a human-readable breadcrumb.
  let current = categories;
  const path: string[] = [];
  while (current && current.length > 0) {
    const best = current.reduce((winner, item) =>
      !winner || (item.HitCount ?? 0) > (winner.HitCount ?? 0) ? item : winner
    );
    if (best.Title) path.push(cleanText(best.Title));
    current = best.SubCategories ?? [];
  }
  return path;
}

function bestAbbResult(results: ProductResult[]): ProductResult | undefined {
  const useful = results.filter((result) => result.status !== "failed");
  return useful.sort((left, right) => abbResultScore(right) - abbResultScore(left))[0];
}

function isRichAbbResult(result: ProductResult | undefined): boolean {
  return Boolean(result && result.status === "found" && result.attributes.some((attr) => attr.group === "ABB Product Data") && result.attributes.length >= 25);
}

function isUsefulAbbSearchResult(result: ProductResult): boolean {
  if (isRichAbbResult(result)) return true;
  if (result.status !== "found" || !hasAbbPisData(result)) return false;
  const hasUsefulNormalizedData = Boolean(
    result.normalized.voltage ||
    result.normalized.current ||
    result.normalized.dimensions ||
    result.normalized.weight ||
    result.normalized.protection ||
    result.documents.some((doc) => doc.type === "datasheet")
  );
  return result.attributes.length >= 8 && hasUsefulNormalizedData;
}

function hasProductImage(result: ProductResult | undefined): boolean {
  return Boolean(result?.documents.some((doc) => doc.type === "image" && Boolean(doc.url || doc.localPath || doc.candidateUrls?.length)));
}

function abbResultScore(result: ProductResult): number {
  if (result.status === "failed") return -1000;
  const abbProductDataCount = result.attributes.filter((attr) => attr.group === "ABB Product Data").length;
  const electricalScore = (result.normalized.voltage ? 40 : 0) + (result.normalized.current ? 40 : 0);
  const physicalScore = (result.normalized.dimensions ? 20 : 0) + (result.normalized.weight ? 20 : 0) + (result.normalized.protection ? 15 : 0);
  return result.confidence * 100 + result.attributes.length + result.documents.length * 5 + abbProductDataCount * 4 + electricalScore + physicalScore;
}

async function fetchAbbPage(url: string, context: ScrapeContext) {
  let lastFetched: FetchedText | undefined;
  let lastError: unknown;
  // Try plain HTTP first (with retries — ABB occasionally returns HTTP/2 protocol errors
  // or empty bodies under load, and a quick retry typically succeeds).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fetched = await context.http.fetchText(url, {
        timeoutMs: 8000,
        signal: context.signal,
        headers: {
          "user-agent": ABB_USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9"
        },
        maxAttempts: 1
      });
      lastFetched = fetched;
      if (isFinalAbbNotFoundStatus(fetched.statusCode)) return fetched;
      if (shouldRetryAbbFetch(fetched)) {
        if (attempt < 2 && context.manufacturer.rateLimitMs !== 0) await delay(800 * (attempt + 1), context.signal);
        continue;
      }
      if (!shouldUsePowerShellForAbbFetch(fetched)) return fetched;
      break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2 && context.manufacturer.rateLimitMs !== 0) {
      await delay(800 * (attempt + 1), context.signal);
    }
  }
  if (process.platform === "win32") {
    try {
      return await context.http.fetchTextViaPowerShell(url, { timeoutMs: 8000, signal: context.signal });
    } catch (error) {
      lastError = error;
    }
  }
  if (lastFetched) return lastFetched;
  if (lastError instanceof Error) throw lastError;
  return context.http.fetchText(url, { timeoutMs: 8000, signal: context.signal });
}

function shouldRetryAbbFetch(fetched: FetchedText): boolean {
  const bodyLength = fetched.text.trim().length;
  return fetched.statusCode >= 500 || (fetched.statusCode >= 200 && fetched.statusCode < 400 && bodyLength < 32);
}

function shouldUsePowerShellForAbbFetch(fetched: FetchedText): boolean {
  return [401, 403, 406, 408, 429].includes(fetched.statusCode);
}

function isFinalAbbNotFoundStatus(statusCode: number): boolean {
  return statusCode === 404 || statusCode === 410;
}

function buildAbbOfficialUrls(catalogNumber: string): string[] {
  const smartlinksParams = new URLSearchParams({
    ProductId: catalogNumber,
    Language: "en",
    PrintPreview: "False",
    pid: catalogNumber
  });

  return [
    `https://new.abb.com/products/${encodeURIComponent(catalogNumber)}`,
    `https://new.abb.com/products/en/${encodeURIComponent(catalogNumber)}`,
    `https://www.abb.com/global/en/products/${encodeURIComponent(catalogNumber)}`,
    `https://new.abb.com/smartlinks/en?${smartlinksParams.toString()}`
  ];
}

type AbbSearchProductUrlLookup = {
  searchUrl: string;
  fetched?: FetchedText;
  urls: string[];
  definitiveEmpty: boolean;
};

function abbOfficialMissingResult(catalogNumber: string, lookup: AbbSearchProductUrlLookup): ProductResult {
  return {
    ...emptyResult("abb", catalogNumber, `ABB official search did not return ${catalogNumber}; product is not listed on the ABB official site.`),
    sources: lookup.fetched
      ? [
          {
            url: lookup.fetched.effectiveUrl || lookup.searchUrl,
            sourceType: "official",
            parser: "abb-pis-search",
            parserVersion: "abb-v2",
            stage: "official-search",
            reason: "ABB official PIS search returned no matching product candidates.",
            fetchedAt: lookup.fetched.fetchedAt,
            statusCode: lookup.fetched.statusCode
          }
        ]
      : []
  };
}

/**
 * AEM-page rescue: try the catalog number under non-English locales that consistently serve
 * the rich PIS page (with `var model = {...}` containing ProductNetWeight, ProductNetDepth,
 * etc.) even when the EN URL redirects to a static AEM CMS page. The server adds the canonical
 * slug itself, so a placeholder is enough — no PisSearchApi call needed. Only invoked when
 * neither the EN URLs nor the PIS search yielded PIS data, so non-AEM products aren't slowed.
 */
async function fetchAbbLocaleFallbackResults(catalogNumber: string, context: ScrapeContext): Promise<ProductResult[]> {
  const encoded = encodeURIComponent(catalogNumber);
  const urls = [
    `https://new.abb.com/products/pl/${encoded}/product`,
    `https://new.abb.com/products/de/${encoded}/product`,
    `https://new.abb.com/products/it/${encoded}/product`
  ];
  const results: ProductResult[] = [];
  for (const url of urls) {
    try {
      const fetched = await fetchAbbPage(url, context);
      const parsed = parseAbbProductPage(catalogNumber, fetched, context.manufacturer.markerRules);
      if (parsed.status !== "failed") results.push(parsed);
      // Stop after first PIS hit — subsequent locales would just duplicate.
      if (hasAbbPisData(parsed)) break;
    } catch {
      // Try the next locale.
    }
  }
  return results;
}

/**
 * Returns true if the parsed page produced any attributes from the embedded PIS `var model`
 * blob (group === "ABB Product Data"). This is what distinguishes a rich PIS product page
 * from a thin AEM CMS page that only ships JSON-LD + breadcrumbs.
 */
function hasAbbPisData(result: ProductResult | undefined): boolean {
  if (!result || result.status === "failed") return false;
  return result.attributes.some((attr) => attr.group === "ABB Product Data");
}

/**
 * Last-resort AEM rescue: render the AEM CMS product page in Playwright so the client-side
 * abbDownloadSection / pisproductdetails widgets execute and inject the technical data table
 * into the DOM. We then re-parse the rendered HTML with the same parseAbbProductPage so any
 * data the widgets revealed becomes regular attributes/documents. Skipped when imageOnly is
 * set (the run-mode that only wants an image) or no browserRenderer is wired in.
 */
async function renderAbbAemPageInBrowser(
  catalogNumber: string,
  url: string,
  context: ScrapeContext
): Promise<ProductResult | undefined> {
  if (!context.browserRenderer) return undefined;
  try {
    const rendered = await context.browserRenderer.renderProductPage(
      url,
      ABB_AEM_BROWSER_RECIPE,
      context.signal
    );
    if (rendered.error || !rendered.fetched) {
      if (rendered.error) console.warn(`[abb] AEM browser render failed for ${catalogNumber} @ ${url}: ${rendered.error}`);
      return undefined;
    }
    const parsed = parseAbbProductPage(catalogNumber, rendered.fetched, context.manufacturer.markerRules);
    if (parsed.status === "failed") return undefined;
    parsed.sources = parsed.sources.map((source) => ({
      ...source,
      parser: source.parser ?? "abb-aem-browser-render",
      stage: source.stage ?? "abb-aem-browser-render"
    }));
    return parsed;
  } catch (error) {
    console.warn(`[abb] AEM browser render exception for ${catalogNumber} @ ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

// Minimal Playwright recipe for ABB AEM pages: click cookie banners, expand any "Technical data"
// / "Klassifizierungen" / "Downloads" buttons, and give the widget JS a moment to inject the
// PIS table. The defaults in browser-renderer already cover the most common patterns.
const ABB_AEM_BROWSER_RECIPE = {
  interactionPolicy: {
    networkIdleTimeoutMs: 15000,
    scrollPasses: 2,
    maxClicks: 30,
    closeOverlaySelectors: [
      "#onetrust-accept-btn-handler",
      "button:has-text('Accept all cookies')",
      "button:has-text('Accept all')",
      "button:has-text('I accept')"
    ],
    expandSelectors: [
      "button:has-text('Technical data')",
      "button:has-text('Technische Daten')",
      "button:has-text('Specifications')",
      "button:has-text('Downloads')",
      "button:has-text('Documents')",
      "button:has-text('Classifications')",
      "button:has-text('Klassifizierungen')",
      "button:has-text('Show more')",
      "button:has-text('Mehr anzeigen')"
    ],
    waitForSelectors: [
      "#pisproductdetails",
      ".pis-attribute-group",
      "[data-attribute-code]",
      "table"
    ]
  }
} as unknown as Parameters<NonNullable<ScrapeContext["browserRenderer"]>["renderProductPage"]>[1];

async function fetchAbbSearchResults(catalogNumber: string, context: ScrapeContext, urls: string[]): Promise<ProductResult[]> {
  const results: ProductResult[] = [];
  for (const url of urls) {
    try {
      const fetched = await fetchAbbPage(url, context);
      const result = parseAbbProductPage(catalogNumber, fetched, context.manufacturer.markerRules);
      if (result.status !== "failed") results.push(result);
      if (isUsefulAbbSearchResult(result)) break;
    } catch {
      // Keep trying the other official product-id candidates.
    }
  }
  return results;
}

async function buildAbbSearchProductUrlLookup(catalogNumber: string, context: ScrapeContext, timeoutMs = 8000): Promise<AbbSearchProductUrlLookup> {
  const searchUrl = `https://new.abb.com/api/PisSearchApi?query=${encodeURIComponent(catalogNumber)}&pageNumber=1&pageSize=8&lang=en`;
  let fetched: FetchedText;
  try {
    fetched = await context.http.fetchText(searchUrl, {
      timeoutMs,
      cacheTtlMs: 1000 * 60 * 60 * 24,
      signal: context.signal,
      headers: { accept: "application/json,text/plain,*/*", "user-agent": ABB_USER_AGENT }
    });
  } catch {
    return { searchUrl, urls: [], definitiveEmpty: false };
  }

  const searchItems = parseAbbSearchItems(fetched.text, catalogNumber);
  const urlGroups = searchItems.map((item) => abbSearchItemProductUrls(item.productId, item.alias ?? catalogNumber));
  const urls: string[] = [];
  for (let priority = 0; priority < 6; priority += 1) {
    for (const group of urlGroups) {
      if (group[priority]) urls.push(group[priority]);
    }
  }
  const definitiveEmpty = isDefinitiveEmptyAbbSearch(fetched.text, searchItems.length);
  return { searchUrl, fetched, urls: [...new Set(urls)].slice(0, 24), definitiveEmpty };
}

function isDefinitiveEmptyAbbSearch(text: string, matchingItems: number): boolean {
  if (matchingItems > 0) return false;
  try {
    const parsed = JSON.parse(text) as { Items?: unknown[]; TotalResultsCount?: unknown };
    const total = typeof parsed.TotalResultsCount === "number" ? parsed.TotalResultsCount : undefined;
    return Array.isArray(parsed.Items) && parsed.Items.length === 0 && total === 0;
  } catch {
    return false;
  }
}

function abbSearchItemProductUrls(productId: string, alias: string): string[] {
  const encodedId = encodeURIComponent(productId);
  const slug = abbProductSlug(alias);
  // Order matters: try localized PIS URLs first because /en redirects to the AEM shell that
  // strips technical data. Polish currently resolves the richest ABB detail page for the
  // benchmarked devices, then German and Italian serve as localized fallbacks.
  return [
    `https://new.abb.com/products/pl/${encodedId}/${slug}`,
    `https://new.abb.com/products/de/${encodedId}/${slug}`,
    `https://new.abb.com/products/it/${encodedId}/${slug}`,
    `https://new.abb.com/products/${encodedId}/${slug}`,
    `https://new.abb.com/products/${encodedId}`,
    `https://www.abb.com/global/en/products/${encodeURIComponent(productId.toLowerCase())}`
  ];
}

function parseAbbSearchItems(text: string, catalogNumber: string): Array<{ productId: string; alias?: string; score: number }> {
  try {
    const parsed = JSON.parse(text) as { Items?: Array<Record<string, unknown>> };
    return (parsed.Items ?? [])
      .flatMap((item): Array<{ productId: string; alias: string; score: number }> => {
        const productId = firstStringOrNumber(item.ProductId, item.productId);
        if (!productId) return [];
        const alias =
          firstExactCatalogText(catalogNumber, item.GlobalCommercialAlias, item.ExtendedProductType, item.Title) ??
          firstTextMatchingCatalog(catalogNumber, item.GlobalCommercialAlias, item.ExtendedProductType, item.Title, item.CatalogDescription);
        const haystack = cleanText(
          [item.ProductId, item.GlobalCommercialAlias, item.ExtendedProductType, item.Title, item.CatalogDescription, item.LongDescription]
            .map((value) => firstStringOrNumber(value))
            .filter(Boolean)
            .join(" ")
        );
        if (!catalogTextMatches(haystack, catalogNumber) && !sameCatalogNumber(productId, catalogNumber)) return [];
        return [{
          productId,
          alias: alias && sameCatalogNumber(alias, catalogNumber) ? alias : catalogNumber,
          score: abbSearchItemScore(catalogNumber, productId, haystack)
        }];
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);
  } catch {
    return [];
  }
}

function firstTextMatchingCatalog(catalogNumber: string, ...values: unknown[]): string | undefined {
  return values
    .map((value) => firstStringOrNumber(value))
    .find((value): value is string => Boolean(value && catalogTextMatches(value, catalogNumber)));
}

function firstExactCatalogText(catalogNumber: string, ...values: unknown[]): string | undefined {
  return values
    .map((value) => firstStringOrNumber(value))
    .find((value): value is string => Boolean(value && sameCatalogNumber(value, catalogNumber)));
}

function abbSearchItemScore(catalogNumber: string, productId: string, haystack: string): number {
  let score = 0;
  if (sameCatalogNumber(productId, catalogNumber)) score += 100;
  if (catalogTextMatches(haystack, catalogNumber)) score += 80;
  if (new RegExp(`\\(${escapeRegExp(catalogNumber)}\\)`, "i").test(haystack)) score += 20;
  if (/\b(?:spare|replacement|kit|package)\b/i.test(haystack)) score -= 20;
  if (productId.toUpperCase().endsWith("P01")) score -= 15;
  return score;
}

function abbProductSlug(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "product";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseAbbProductPage(catalogNumber: string, fetched: FetchedText, markerRules?: MarkerExtractionRule[]): ProductResult {
  const $ = cheerio.load(fetched.text);
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const products = readJsonLdProducts($);
  const product = products.find((item) => {
    const sku = String(item.sku ?? item.productID ?? "");
    return sameCatalogNumber(sku, catalogNumber);
  }) ?? products[0];
  const productPayloads = extractAbbProductPayloads(fetched.text);

  if (product) {
    for (const [name, value] of Object.entries(product)) {
      if (value === undefined || value === null || typeof value === "object") continue;
      if (isNoiseJsonLdField(name)) continue;
      attributes.push({
        group: "Structured Data",
        name,
        value: cleanText(String(value)),
        sourceUrl: fetched.effectiveUrl
      });
    }
  }

  const embeddedAttributes = extractAbbEmbeddedAttributes(fetched.text, fetched.effectiveUrl, productPayloads);
  attributes.push(...embeddedAttributes);
  attributes.push(...extractAbbRelationshipAttributes(fetched.text, fetched.effectiveUrl, productPayloads));
  attributes.push(...extractAbbClassificationAttributes(fetched.text, fetched.effectiveUrl, productPayloads));
  // AEM-style ABB pages (e.g. AC500 PLC, drives, robotics) don't ship the embedded `var model =` blob
  // and instead load product data via JS widgets. We still scrape whatever IS in the static HTML:
  // category/classification breadcrumbs from window.aot, "Next steps" links, dataLayer fields.
  if (embeddedAttributes.length === 0) {
    attributes.push(...extractAbbAemAttributes(fetched.text, fetched.effectiveUrl));
  }
  documents.push(...extractAbbDocumentReferences(embeddedAttributes, fetched.effectiveUrl));
  const markerData = extractMarkerData(fetched.text, markerRules, fetched.effectiveUrl);
  attributes.push(...markerData.attributes);
  documents.push(...markerData.documents);
  documents.push(...extractAbbEmbeddedImages(fetched.text, fetched.effectiveUrl, productPayloads));

  $("meta").each((_, element) => {
    const name = $(element).attr("name") || $(element).attr("property");
    const value = $(element).attr("content");
    if (!name || !value) return;
    if (/description|brand|manufacturer|image|product|og:/i.test(name)) {
      attributes.push({
        group: "Meta",
        name,
        value: cleanText(value),
        sourceUrl: fetched.effectiveUrl
      });
    }
  });

  const imageUrl = firstImageUrl(product?.image) ?? $("meta[property='og:image']").attr("content") ?? $("meta[name='image']").attr("content");
  if (imageUrl) {
    documents.push({
      type: "image",
      label: "Product image",
      url: new URL(imageUrl, fetched.effectiveUrl).toString(),
      sourceUrl: fetched.effectiveUrl
    });
  }
  $("img[src],img[data-master]").each((_, element) => {
    const rawUrl = $(element).attr("data-master") || $(element).attr("src");
    if (!rawUrl || !/productimages\.abb\.com/i.test(rawUrl)) return;
    documents.push({
      type: "image",
      label: cleanText($(element).attr("alt") || "Product image"),
      url: new URL(rawUrl, fetched.effectiveUrl).toString(),
      sourceUrl: fetched.effectiveUrl
    });
  });

  $("tr").each((_, element) => {
    const cells = $(element)
      .find("th,td")
      .map((__, cell) => cleanText($(cell).text()))
      .get()
      .filter(Boolean);
    if (cells.length >= 2) {
      attributes.push({
        group: "Table",
        name: cells[0],
        value: dedupePipeJoinedCells(cells.slice(1)),
        sourceUrl: fetched.effectiveUrl
      });
    }
  });

  $("li,p").slice(0, 600).each((_, element) => {
    const pair = splitNameValue($(element).text());
    if (pair && pair.name.length <= 80 && pair.value.length <= 500) {
      attributes.push({ group: "Text", ...pair, sourceUrl: fetched.effectiveUrl });
    }
  });

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const absolute = new URL(href, fetched.effectiveUrl).toString();
    if (!/\.(pdf|zip|dwg|dxf|stp|step)(\?|$)/i.test(absolute) && !/library.*download/i.test(absolute)) return;
    const label = cleanText($(element).text()) || absolute.split("/").pop() || "Document";
    documents.push({
      type: classifyDocument(label, absolute),
      label,
      url: absolute,
      sourceUrl: fetched.effectiveUrl
    });
  });

  const title = cleanText(String(product?.name ?? $("h1").first().text() ?? $("title").text()));
  const description = cleanText(
    String(product?.description ?? $("meta[name='description']").attr("content") ?? $("meta[property='og:description']").attr("content") ?? "")
  );
  const productUrl = cleanText(String(product?.url ?? $("link[rel='canonical']").attr("href") ?? fetched.effectiveUrl));
  const matched =
    catalogTextMatches(fetched.text, catalogNumber) ||
    sameCatalogNumber(String(product?.sku ?? product?.productID ?? ""), catalogNumber);

  if (!matched) {
    return {
      ...emptyResult("abb", catalogNumber, "ABB product page did not contain the catalog number."),
      sources: [
        {
          url: fetched.effectiveUrl,
          sourceType: "official",
          parser: "abb-product-page",
          parserVersion: "abb-v2",
          fetchedAt: fetched.fetchedAt,
          statusCode: fetched.statusCode
        }
      ]
    };
  }

  attributes.push(...deriveAbbElectricalAttributes(attributes, title, description, fetched.effectiveUrl));
  const cleanAttributes = dedupeAttributes(attributes);
  const cleanDocuments = coalesceAbbImageDocuments(dedupeDocuments(documents));
  const normalized = normalizeFields(cleanAttributes, cleanDocuments);
  const hasUsefulData = Boolean(product) || cleanAttributes.length > 0 || cleanDocuments.length > 0;

  return {
    manufacturerId: "abb",
    catalogNumber,
    status: hasUsefulData ? "found" : "partial",
    confidence: product ? 0.9 : 0.65,
    productUrl,
    localizedUrls: buildLocalizedProductUrls("abb", catalogNumber, productUrl),
    title,
    description,
    normalized,
    attributes: cleanAttributes,
    documents: cleanDocuments,
    sources: [
      {
        url: fetched.effectiveUrl,
        sourceType: "official",
        parser: "abb-product-page",
        parserVersion: "abb-v2",
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode
      }
    ]
  };
}

function deriveAbbElectricalAttributes(
  attributes: AttributeRecord[],
  title: string,
  description: string,
  sourceUrl: string
): AttributeRecord[] {
  const candidates = uniqueStrings([
    title,
    description,
    ...attributes
      .filter((attr) => /\b(catalog description|long description|extended product type|display name|product name|short description)\b/i.test(attr.name))
      .map((attr) => attr.value)
  ]);
  const voltageRange = candidates.map(abbVoltageRangeFromText).find((value): value is string => Boolean(value));
  const voltageType = candidates.map(abbVoltageTypeFromText).find((value): value is string => Boolean(value));
  const derived: AttributeRecord[] = [];
  if (voltageRange) {
    derived.push({
      group: "ABB PDT Derived",
      name: "Derived Voltage Range",
      value: voltageRange,
      sourceUrl,
      sourceType: "official",
      parser: "abb-derived-electrical",
      confidence: 0.82
    });
  }
  if (voltageType) {
    derived.push({
      group: "ABB PDT Derived",
      name: "Derived Voltage Type",
      value: voltageType,
      sourceUrl,
      sourceType: "official",
      parser: "abb-derived-electrical",
      confidence: 0.82
    });
  }
  return derived;
}

function abbVoltageRangeFromText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/,/g, ".").replace(/\u2026/g, "...");
  const patterns = [
    /(-?\d+(?:\.\d+)?)\s*(?:\.\.\.|\.{2}|-|to|do)\s*\+?(-?\d+(?:\.\d+)?)\s*V(?:\b|AC\b|DC\b|A\.?C|D\.?C|\/)/i,
    /(-?\d+(?:\.\d+)?)\s*V\s*(?:\.\.\.|\.{2}|-|to|do)\s*\+?(-?\d+(?:\.\d+)?)\s*V/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const low = Number(match[1]);
    const high = Number(match[2]);
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
    return `${Math.min(low, high)}-${Math.max(low, high)}`;
  }
  return undefined;
}

function abbVoltageTypeFromText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/(?:^|[^A-Z])(?:V?AC|A\.?C\.?)\s*(?:\/|-|\s)\s*(?:V?DC|D\.?C\.?)(?:[^A-Z]|$)|\bACDC\b/i.test(value)) return "AC/DC";
  const hasAc = /\b(?:50|60)\s*hz\b|(?:^|[^A-Z])(?:V?AC|A\.?C\.?)(?:[^A-Z]|$)/i.test(value);
  const hasDc = /(?:^|[^A-Z])(?:V?DC|D\.?C\.?)(?:[^A-Z]|$)/i.test(value);
  if (hasAc && hasDc) return "AC/DC";
  if (hasAc) return "AC";
  if (hasDc) return "DC";
  return undefined;
}

// JSON-LD fields we drop on the floor:
//   - schema.org metadata that adds no product info (@type, @context, logo, url)
//   - identity fields that are always duplicated by PIS data (sku, productID)
//   - display fields that PIS provides under a clearer name (name → Display Name,
//     alternateName → Extended Product Type, description → Long Description)
// Image is kept because the document extractor consumes it.
const JSON_LD_NOISE_FIELDS = new Set([
  "@type",
  "@context",
  "logo",
  "url",
  "sku",
  "productid",
  "mpn",
  "name",
  "alternatename",
  "description",
  "category"
]);

function isNoiseJsonLdField(name: string): boolean {
  return JSON_LD_NOISE_FIELDS.has(name.toLowerCase());
}

function readJsonLdProducts($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = [];
  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).text();
    try {
      collectJsonLdProducts(JSON.parse(raw) as unknown, products);
    } catch {
      // Ignore malformed structured data.
    }
  });
  return products;
}

function collectJsonLdProducts(value: unknown, target: Record<string, unknown>[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdProducts(item, target);
    return;
  }
  if (!isRecord(value)) return;
  const type = value["@type"];
  const types = Array.isArray(type) ? type.map((item) => String(item)) : [String(type ?? "")];
  if (types.some((item) => item.toLowerCase() === "product")) target.push(value);
  collectJsonLdProducts(value["@graph"], target);
}

function firstImageUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string");
  return undefined;
}

function extractAbbEmbeddedAttributes(html: string, sourceUrl: string, productPayloads = extractAbbProductPayloads(html)): AttributeRecord[] {
  const modelAttributes = extractAbbModelAttributes(html, sourceUrl, productPayloads);
  if (modelAttributes.length) return modelAttributes;
  return extractAbbRegexAttributes(html, sourceUrl);
}

/**
 * Extract attributes from ABB's AEM-CMS product pages (PLC, drives, etc.) that don't ship
 * the PIS `var model = {...}` blob. We pull what's available in static HTML:
 *   - JSON-LD product fields (already covered by parser)
 *   - `nextStepsDynamicObj` URLs (Configure, Where to buy, Contact)
 *   - window.dataLayer fields (cid, productId, category breadcrumbs)
 *   - the cid for the abbDownloadSection widget so we can link to library search
 */
function extractAbbAemAttributes(html: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: string, group = "ABB AEM Page") => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    const key = `${group}|${name}|${cleaned}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    attributes.push({
      group,
      name,
      value: cleaned,
      sourceUrl,
      sourceType: "official",
      parser: "abb-aem-static",
      confidence: 0.6
    });
  };

  const nextStepsMatch = html.match(/nextStepsDynamicObj\s*=\s*(\{[\s\S]*?\});\s*if\s*\(nextStepsDynamicObj/);
  if (nextStepsMatch) {
    try {
      const obj = JSON.parse(nextStepsMatch[1]) as Record<string, unknown>;
      const items = arrayAt(recordAt(recordAt(recordAt(obj, "root"), ":items"), "nextsteps"), "items");
      for (const entry of items) {
        if (!isRecord(entry)) continue;
        const label = firstStringOrNumber(entry.label) ?? "";
        const url = firstStringOrNumber(entry.url) ?? "";
        if (label && url) push(`Next step: ${label}`, url, "ABB AEM Next Steps");
      }
    } catch {
      // Ignore malformed JSON.
    }
  }

  // dataLayer entries (Adobe Analytics): contains category hierarchy, brand, productGroup, etc.
  const dataLayerMatches = html.matchAll(/dataLayer\.push\(\s*(\{[\s\S]*?\})\s*\)/g);
  for (const match of dataLayerMatches) {
    try {
      const obj = JSON.parse(match[1]) as Record<string, unknown>;
      const flattenAem = (value: unknown, path: string[]): void => {
        if (value === null || value === undefined) return;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          const name = path[path.length - 1];
          if (!name) return;
          const text = String(value).trim();
          if (!text || text.length > 300) return;
          // Skip noise (Tealium guids, technical flags).
          if (/^(?:event|eventSource|enablePubSub|pubsub|empty|true|false)$/i.test(name)) return;
          push(humanizeAbbAttributeCode(name), text, "ABB AEM Data Layer");
          return;
        }
        if (Array.isArray(value)) {
          value.forEach((item, i) => flattenAem(item, [...path, String(i + 1)]));
          return;
        }
        if (!isRecord(value)) return;
        for (const [k, v] of Object.entries(value)) flattenAem(v, [...path, k]);
      };
      flattenAem(obj, []);
    } catch {
      // Ignore non-JSON pushes.
    }
  }

  // The abbDownloadSection widget configuration contains the `cid` we can use to build a library URL.
  const cid = html.match(/\babbDownloadSection\([\s\S]{0,800}?["']cid["']\s*:\s*["']([^"']+)["']/i)?.[1];
  const widgetProductId = html.match(/abbDownloadSection\([\s\S]{0,800}?["']productId["']\s*:\s*["']([^"']+)["']/i)?.[1];
  if (cid) {
    push("Product Category ID (cid)", cid, "ABB AEM Page");
    push(
      "ABB Library Search URL",
      `https://library.abb.com/r?cid=${encodeURIComponent(cid)}&productid=${encodeURIComponent(widgetProductId ?? "")}&languagecode=en`,
      "ABB AEM Page"
    );
  }

  return attributes;
}

function extractAbbRegexAttributes(html: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const pattern = /"attributeCode":"([^"]+)"[\s\S]{0,300}?"attributeName":"([^"]+)"[\s\S]{0,1600}?"values":\[(.*?)\]\s*,\s*"isInternal"/g;
  for (const match of html.matchAll(pattern)) {
    const code = cleanAbbJsonValue(match[1]);
    const name = canonicalAbbAttributeName(code, match[2]);
    const value = parseAbbAttributeValues(match[3]);
    if (!name || !value) continue;
    attributes.push({
      group: "ABB Product Data",
      name,
      value,
      sourceUrl,
      sourceType: "official",
      parser: "abb-embedded-json",
      confidence: 0.94
    });
  }
  return attributes;
}

function extractAbbModelAttributes(html: string, sourceUrl: string, productPayloads = extractAbbProductPayloads(html)): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  for (const product of productPayloads) {
    const productDetails = recordAt(product, "productDetails");
    const item = recordAt(productDetails, "item");
    pushUniqueAbbAttributes(attributes, attributesFromAbbMap(recordAt(item, "attributes"), "ABB Product Data", sourceUrl), seen);
    for (const groupContainer of [recordAt(item, "attributeGroups"), recordAt(productDetails, "attributeGroups"), recordAt(product, "attributeGroups")]) {
      for (const group of arrayAt(groupContainer, "items")) {
        if (!isRecord(group)) continue;
        const groupName = abbModelGroupName(group);
        pushUniqueAbbAttributes(attributes, attributesFromAbbMap(recordAt(group, "attributes"), groupName, sourceUrl), seen);
      }
    }
  }
  return attributes;
}

function extractAbbRelationshipAttributes(html: string, sourceUrl: string, productPayloads = extractAbbProductPayloads(html)): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  for (const product of productPayloads) {
    for (const relationship of arrayAt(recordAt(product, "productRelationships"), "items")) {
      if (!isRecord(relationship)) continue;
      const relationshipLabel = cleanText(firstStringOrNumber(relationship.description, relationship.type, relationship.code) ?? "Related Products");
      const relationshipName = abbRelationshipAttributeName(relationshipLabel);
      for (const row of arrayAt(recordAt(relationship, "table"), "rows")) {
        const values = recordAt(row, "values");
        if (!values) continue;
        const cells = abbRelationshipCells(values);
        const identifier = cells.get("identifier") ?? cells.get("product id") ?? cells.get("productid") ?? cells.get("part number");
        const description = cells.get("description");
        const type = cells.get("type");
        const quantity = cells.get("quantity");
        const unit = cells.get("unit of measure") ?? cells.get("unitofmeasure");
        const details = [
          identifier,
          description ? `- ${description}` : undefined,
          type && type !== identifier ? `(Type: ${type})` : undefined,
          quantity ? `(Qty: ${[quantity, unit].filter(Boolean).join(" ")})` : undefined
        ].filter(Boolean).join(" ");
        const value = cleanText(details || [...cells.entries()].map(([key, cell]) => `${key}: ${cell}`).join("; "));
        if (!value) continue;
        const attr = {
          group: `ABB ${relationshipLabel}`,
          name: relationshipName,
          value,
          sourceUrl,
          sourceType: "official" as const,
          parser: "abb-product-model-relationships",
          confidence: 0.9
        };
        const key = `${attr.group}|${attr.name}|${attr.value}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        attributes.push(attr);
      }
    }
  }
  return attributes;
}

function extractAbbClassificationAttributes(html: string, sourceUrl: string, productPayloads = extractAbbProductPayloads(html)): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  for (const product of productPayloads) {
    const items = recordAt(recordAt(product, "productClassifications"), "items");
    if (!items) continue;
    for (const [classification, rawPaths] of Object.entries(items)) {
      for (const path of arrayAt(rawPaths)) {
        const pathItems = arrayAt(path);
        const value = pathItems
          .map((item) => (isRecord(item) ? firstStringOrNumber(item.name, item.cid) : undefined))
          .filter((item): item is string => Boolean(item))
          .map(cleanText)
          .filter((item) => item && !/^root$/i.test(item))
          .join(" > ");
        if (!value) continue;
        const attr = {
          group: "ABB Product Classification",
          name: `${humanizeAbbAttributeCode(classification)} Path`,
          value,
          sourceUrl,
          sourceType: "official" as const,
          parser: "abb-product-model-classification",
          confidence: 0.88
        };
        const key = `${attr.name}|${attr.value}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        attributes.push(attr);
      }
    }
  }
  return attributes;
}

function attributesFromAbbMap(attributeMap: Record<string, unknown> | undefined, group: string, sourceUrl: string): AttributeRecord[] {
  if (!attributeMap) return [];
  const attributes: AttributeRecord[] = [];
  for (const value of Object.values(attributeMap)) {
    if (!isRecord(value)) continue;
    const code = cleanAbbJsonValue(firstStringOrNumber(value.attributeCode) ?? "");
    const fallbackName = firstStringOrNumber(value.attributeName, code);
    const name = canonicalAbbAttributeName(code, fallbackName ?? code);
    const attrValue = parseAbbAttributeValueObjects(arrayAt(value.values));
    if (!name || !attrValue) continue;
    attributes.push({
      group,
      name,
      value: attrValue,
      sourceUrl,
      sourceType: "official",
      parser: "abb-product-model",
      confidence: 0.96
    });
  }
  return attributes;
}

function pushUniqueAbbAttributes(target: AttributeRecord[], incoming: AttributeRecord[], seen: Set<string>) {
  for (const attr of incoming) {
    const key = `${attr.name}|${attr.value}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(attr);
  }
}

// PIS responses come back in the request locale, so the same group ships as
// "Zgodność materiału" (PL), "Materialkonformität" (DE), "Conformità del materiale" (IT) or
// "Material compliance" (EN). Map every locale variant to one canonical English label so
// downstream consumers see consistent group names regardless of which PIS locale answered.
const ABB_GROUP_LABEL_CANONICAL: Record<string, string> = {
  "zgodność materiału": "Material compliance",
  "zgodnosc materialu": "Material compliance",
  "materialkonformität": "Material compliance",
  "materialkonformitat": "Material compliance",
  "conformità del materiale": "Material compliance",
  "conformita del materiale": "Material compliance",
  "zamawianie": "Ordering",
  "bestellinformationen": "Ordering",
  "bestelldaten": "Ordering",
  "bestellung": "Ordering",
  "informazioni di ordinazione": "Ordering",
  "ordering information": "Ordering",
  "ordering": "Ordering",
  "informacje o pakowaniu": "Packaging information",
  "verpackungsinformationen": "Packaging information",
  "informazioni sull'imballaggio": "Packaging information",
  "packaging information": "Packaging information",
  "dodatkowe informacje": "Additional information",
  "zusätzliche informationen": "Additional information",
  "zusatzliche informationen": "Additional information",
  "weitere informationen": "Additional information",
  "informazioni aggiuntive": "Additional information",
  "additional information": "Additional information",
  "zewnętrzne klasyfikacje i normy": "External classifications and standards",
  "zewnetrzne klasyfikacje i normy": "External classifications and standards",
  "externe klassifizierungen und normen": "External classifications and standards",
  "classificazioni esterne e standard": "External classifications and standards",
  "external classifications and standards": "External classifications and standards",
  "certyfikaty i deklaracje": "Certificates and declarations",
  "zertifikate und deklarationen": "Certificates and declarations",
  "certificati e dichiarazioni": "Certificates and declarations",
  "certificates and declarations": "Certificates and declarations",
  "klasyfikacja produktu": "Product classification",
  "produktklassifizierung": "Product classification",
  "classificazione del prodotto": "Product classification",
  "product classification": "Product classification",
  "dane produktu": "Product Data",
  "produktdaten": "Product Data",
  "dati di prodotto": "Product Data",
  "dati prodotto": "Product Data",
  "product data": "Product Data",
  "transport i magazynowanie": "Shipping and storage",
  "versand und lagerung": "Shipping and storage",
  "spedizione e stoccaggio": "Shipping and storage",
  "shipping and storage": "Shipping and storage",
  "specyfikacja techniczna": "Technical specification",
  "technische daten": "Technical specification",
  "technische spezifikation": "Technical specification",
  "specifiche tecniche": "Technical specification",
  "technical specification": "Technical specification",
  "wymiary": "Dimensions",
  "abmessungen": "Dimensions",
  "dimensioni": "Dimensions",
  "dimensions": "Dimensions",
  "środowisko pracy": "Operating environment",
  "srodowisko pracy": "Operating environment",
  "betriebsumgebung": "Operating environment",
  "condizioni operative": "Operating environment",
  "operating environment": "Operating environment",
  "kategoria": "Category",
  "kategorie": "Category",
  "categoria": "Category",
  "category": "Category",
  "klasyfikacje": "Classifications",
  "klassifizierungen": "Classifications",
  "classificazioni": "Classifications",
  "classifications": "Classifications"
};

function canonicaliseAbbGroupLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return trimmed;
  const canonical = ABB_GROUP_LABEL_CANONICAL[trimmed.toLowerCase()];
  return canonical ?? trimmed;
}

function abbModelGroupName(group: Record<string, unknown>): string {
  const raw = cleanText(firstStringOrNumber(group.description, group.code) ?? "Product Data");
  if (!raw) return "ABB Product Data";
  return `ABB ${canonicaliseAbbGroupLabel(raw)}`;
}

function abbRelationshipAttributeName(label: string): string {
  if (/accessor/i.test(label)) return "Accessory";
  if (/where\s*used|used\s*with/i.test(label)) return "Used With";
  if (/variant/i.test(label)) return "Variant Product";
  if (/spare/i.test(label)) return "Spare Part";
  return "Related Product";
}

function abbRelationshipCells(values: Record<string, unknown>): Map<string, string> {
  const cells = new Map<string, string>();
  for (const [key, cell] of Object.entries(values)) {
    const text = uniqueStrings(flattenAbbCellText(cell)).join("; ");
    if (text) cells.set(humanizeAbbAttributeCode(key).toLowerCase(), text);
  }
  return cells;
}

function flattenAbbCellText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenAbbCellText);
  if (isRecord(value)) {
    const ownText = firstStringOrNumber(value.text, value.value, value.displayValue, value.name);
    const link = recordAt(value, "link");
    const linkText = link ? firstStringOrNumber(link.text, link.productId, link.documentId, link.url) : undefined;
    return [ownText, linkText].map((item) => cleanText(item)).filter(Boolean);
  }
  const text = firstStringOrNumber(value);
  return text ? [cleanText(text)] : [];
}

function extractAbbProductPayloads(html: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  let offset = 0;
  const marker = "var model =";
  while (offset < html.length) {
    const markerIndex = html.indexOf(marker, offset);
    if (markerIndex < 0) break;
    const objectStart = html.indexOf("{", markerIndex);
    if (objectStart < 0) break;
    const objectText = extractBalancedJsonObject(html, objectStart);
    offset = objectStart + Math.max(1, objectText?.length ?? 1);
    if (!objectText) continue;
    try {
      const parsed = JSON.parse(objectText) as Record<string, unknown>;
      const product = recordAt(parsed, "ProductViewModel", "Product") ?? recordAt(parsed, "Product");
      if (product) payloads.push(product);
    } catch {
      // Ignore non-JSON scripts.
    }
  }
  return payloads;
}

function extractBalancedJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function recordAt(value: unknown, ...path: string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractAbbDocumentReferences(attributes: AttributeRecord[], sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const attr of attributes) {
    const type = abbDocumentType(attr.name, attr.value);
    if (!type) continue;
    for (const documentId of extractAbbDocumentIds(attr.value)) {
      documents.push({
        type,
        label: `${attr.name}: ${documentId}`,
        url: abbLibraryDownloadUrl(documentId),
        sourceUrl,
        sourceType: "official",
        parser: "abb-embedded-json-document-ref",
        confidence: 0.9
      });
    }
  }
  return documents;
}

function extractAbbEmbeddedImages(html: string, sourceUrl: string, productPayloads = extractAbbProductPayloads(html)): DocumentRecord[] {
  const modelImages = extractAbbModelImages(html, sourceUrl, productPayloads);
  if (modelImages.length) return modelImages;

  const imageUrlsByPath = new Map<string, string>();
  for (const match of html.matchAll(/https?:\\?\/\\?\/cdn\.productimages\.abb\.com\\?\/[^"')<\s]+/gi)) {
    const url = cleanAbbJsonValue(match[0]).replace(/\\\//g, "/");
    const key = abbImageUrlKey(url);
    const existing = imageUrlsByPath.get(key);
    if (!existing || abbImageUrlRank(url) < abbImageUrlRank(existing)) imageUrlsByPath.set(key, url);
  }
  const urls = [...imageUrlsByPath.values()].sort((left, right) => abbImageUrlRank(left) - abbImageUrlRank(right)).slice(0, 1);
  return urls.map((url) => ({
    type: "image" as const,
    label: imageLabelFromUrl(url),
    url: new URL(url, sourceUrl).toString(),
    sourceUrl,
    sourceType: "official" as const,
    parser: "abb-embedded-image",
    confidence: 0.86
  }));
}

function extractAbbModelImages(html: string, sourceUrl: string, productPayloads = extractAbbProductPayloads(html)): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const product of productPayloads) {
    for (const image of arrayAt(recordAt(product, "productDetails", "item"), "images")) {
      if (!isRecord(image)) continue;
      const candidates = uniqueStrings(
        [firstStringOrNumber(image.url), firstStringOrNumber(image.masterUrl), firstStringOrNumber(image.thumbnailUrl)]
          .map((url) => url?.replace(/\\\//g, "/"))
          .filter((url): url is string => Boolean(url))
      ).sort((left, right) => abbImageUrlRank(left) - abbImageUrlRank(right));
      const primary = candidates[0];
      if (!primary) continue;
      documents.push({
        type: "image",
        label: imageLabelFromUrl(primary),
        url: new URL(primary, sourceUrl).toString(),
        candidateUrls: candidates.slice(1).map((url) => new URL(url, sourceUrl).toString()),
        sourceUrl,
        sourceType: "official",
        parser: "abb-product-model-image",
        confidence: 0.9
      });
    }
  }
  return documents;
}

function abbImageUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/_(?:\d+x\d+|master|thumbnail|thumb)(?=\.[a-z0-9]+$)/i, "").toLowerCase();
  } catch {
    return (url.split("?")[0] ?? url).replace(/_(?:\d+x\d+|master|thumbnail|thumb)(?=\.[a-z0-9]+$)/i, "").toLowerCase();
  }
}

function abbImageUrlRank(url: string): number {
  const lower = url.toLowerCase();
  if (/_400x400\b|400\s*x\s*400/.test(lower)) return 0;
  if (/_master\b|master\./.test(lower)) return 1;
  if (/_100x100\b|thumbnail|thumb/.test(lower)) return 3;
  return 2;
}

function imageLabelFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (/_400x400\b|400\s*x\s*400/.test(lower)) return "Product image 400x400";
  if (/_master\b|master\./.test(lower)) return "Product image master";
  if (/_100x100\b|thumbnail|thumb/.test(lower)) return "Product image thumbnail";
  return "Product image";
}

function coalesceAbbImageDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const images = documents.filter((doc) => doc.type === "image");
  if (images.length <= 1) return documents;

  const rankedImages = [...images].sort((left, right) => abbImageUrlRank(left.url) - abbImageUrlRank(right.url));
  const primary = rankedImages[0];
  const candidateUrls = [
    ...new Set(
      rankedImages
        .slice(1)
        .flatMap((doc) => [doc.url, ...(doc.candidateUrls ?? [])])
        .filter((url): url is string => Boolean(url && url !== primary.url))
    )
  ];

  return [
    {
      ...primary,
      candidateUrls: candidateUrls.length ? candidateUrls : primary.candidateUrls
    },
    ...documents.filter((doc) => doc.type !== "image")
  ];
}

function abbDocumentType(name: string, value: string): DocumentRecord["type"] | undefined {
  const text = `${name} ${value}`;
  if (!extractAbbDocumentIds(value).length) return undefined;
  if (/\b(data\s*sheet|technical information|catalogue?|brochure)\b/i.test(text)) return "datasheet";
  if (/\b(instructions?|manuals?|user manual|installation)\b/i.test(text)) return "manual";
  if (/\b(cad|drawing|diagram|dimension|2d|3d|step|dxf)\b/i.test(text)) return "cad";
  if (/\b(declaration|certificate|certification|rohs|reach|atex|csa|vde|epd|environmental|cmrt|tsca|weee)\b/i.test(text)) return "certificate";
  if (/\bdocument\b/i.test(text)) return "other";
  return undefined;
}

function extractAbbDocumentIds(value: string): string[] {
  if (/\b(no certification needed|not available|not needed|not applicable)\b/i.test(value)) return [];
  return [
    ...new Set(
      (value.match(/\b[0-9][A-Z0-9]{7,}(?:[-_][A-Z0-9]+)?\b/g) ?? [])
        .filter((id) => !/^\d+$/.test(id))
        .filter((id) => !/^805\d{10}$/.test(id))
    )
  ];
}

function abbLibraryDownloadUrl(documentId: string): string {
  const params = new URLSearchParams({
    DocumentID: documentId,
    LanguageCode: "en",
    DocumentPartId: "",
    Action: "Launch"
  });
  return `https://search.abb.com/library/Download.aspx?${params.toString()}`;
}

function parseAbbAttributeValues(rawValues: string): string | undefined {
  const values: string[] = [];
  try {
    const parsed = JSON.parse(`[${rawValues}]`) as Array<Record<string, unknown>>;
    return parseAbbAttributeValueObjects(parsed);
  } catch {
    for (const match of rawValues.matchAll(/"(?:text|value)":"((?:\\.|[^"\\])*)"/g)) {
      values.push(cleanAbbJsonValue(match[1]));
    }
  }
  const unique = [...new Set(values.map(cleanText).filter(Boolean))];
  return unique.length ? unique.join("; ") : undefined;
}

function parseAbbAttributeValueObjects(items: unknown[]): string | undefined {
  const values: string[] = [];
  for (const item of items) {
    if (isRecord(item)) {
      const text = abbValueText(item);
      if (text) values.push(cleanAbbJsonValue(text));
    } else {
      const text = firstStringOrNumber(item);
      if (text) values.push(cleanAbbJsonValue(text));
    }
  }
  const unique = uniqueStrings(values.map(cleanText).filter(Boolean));
  return unique.length ? unique.join("; ") : undefined;
}

function abbValueText(item: Record<string, unknown>): string | undefined {
  const rawText = firstStringOrNumber(item.text, item.value, item.displayValue, item.name);
  const unit = firstStringOrNumber(item.unit, item.unitOfMeasure, item.uom, item.symbol);
  if (!rawText) return undefined;
  if (unit && /^\d+(?:[.,]\d+)?$/.test(rawText) && !rawText.toLowerCase().includes(unit.toLowerCase())) {
    return `${rawText} ${unit}`;
  }
  return rawText;
}

function firstStringOrNumber(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function canonicalAbbAttributeName(code: string, fallbackName: string): string {
  const baseCode = baseAbbAttributeCode(code);
  const known: Record<string, string> = {
    "#DisplayName": "Display Name",
    "ABB.Type": "ABB Type Designation",
    AmpereRating: "Ampere Rating",
    A2LCertificateUL: "A2L Certificate UL",
    CatalogDescription: "Catalog Description",
    CadDimensionalDrawing: "CAD Dimensional Drawing",
    ClosureType: "Closure Type",
    Color: "Color",
    ConMinRepTem: "Conflict Minerals Reporting Template (CMRT)",
    ConCapMaiCon: "Connecting Capacity Main Circuit",
    ConCapUlCsa: "Connecting Capacity UL/CSA",
    ConFreAirTheCur: "Conventional Free-air Thermal Current",
    ConTheCur: "Conventional Thermal Current",
    ConfigurationType: "Configuration Type",
    CoverPlateType: "Cover Plate Type",
    CoverStyle: "Cover Style",
    CountryOfOrigin: "Country of Origin",
    CustomsTariffNumber: "Customs Tariff Number",
    DataSheetTechnicalInformation: "Data Sheet, Technical Information",
    DatSheTecInf: "Data Sheet, Technical Information",
    DegreeOfProtection: "Degree of Protection",
    DieTesVol: "Dielectric Test Voltage",
    DinPlaceUnits: "DIN Place Units",
    DisplayName: "Display Name",
    DoorMaterial: "Door Material",
    DoorType: "Door Type",
    DooSurFin: "Door Surface Finishing",
    Ean: "EAN",
    Eclass: "eClass",
    EnergyLimitingClass: "Energy Limiting Class",
    EnclosureMaterial: "Enclosure Material",
    EnvProDecEpd: "Environmental Product Declaration - EPD",
    ExtendedProductType: "Extended Product Type",
    Frequency: "Frequency",
    Function: "Function",
    GloComAli: "Global Commercial Alias",
    HandleType: "Handle Type",
    HousingMaterial: "Housing Material",
    HorsePowerRating: "Horsepower Rating UL/CSA",
    ImpResRat: "Impact Resistance Rating",
    InsMan: "Instructions and Manuals",
    InputVoltage: "Input Voltage",
    InputVoltageType: "Input Voltage Type",
    LongDescription: "Long Description",
    MaxOpeVolUlCsa: "Maximum Operating Voltage UL/CSA",
    MountingType: "Mounting Type",
    NeutralType: "Neutral Type",
    NumberOfPoles: "Number of Poles",
    NumberOfModules: "Number of Modules",
    NumberOfRows: "Number of Rows",
    NumOfLinTer: "Number of Line Terminals",
    NumProPol: "Number of Protected Poles",
    ObjClaCod: "Object Classification Code",
    OperationalVoltage: "Rated Operational Voltage",
    OvervoltageCategory: "Overvoltage Category",
    OutputCurrent: "Output Current",
    OutputPower: "Output Power",
    OutputVoltage: "Output Voltage",
    PackageLevel1Ean: "Package Level 1 EAN",
    PacLev1GroWei: "Package Level 1 Gross Weight",
    PoleNetWeight: "Pole Net Weight",
    PowerLoss: "Power Loss",
    ProductMainType: "Product Main Type",
    ProductId: "Product ID",
    ProAvaCla: "Product Availability Class",
    ProductNetDepth: "Product Net Depth / Length",
    ProductNetHeight: "Product Net Height",
    ProductNetWeight: "Product Net Weight",
    ProductNetWidth: "Product Net Width",
    ProductName: "Product Name",
    ProductSalesStatus: "Product Sales Status",
    ProductType: "Product Type",
    RatConShoCirCur: "Rated Conditional Short-Circuit Current",
    RatConCirVol: "Rated Control Circuit Voltage",
    RatedCurrent: "Rated Current",
    RatedInputVoltage: "Rated Input Voltage",
    RatImpWitVol: "Rated Impulse Withstand Voltage",
    RatInsVol: "Rated Insulation Voltage",
    RatOpeCurAc1: "Rated Operational Current AC-1",
    RatOpeCurAc3: "Rated Operational Current AC-3",
    RatOpeCurAc3e: "Rated Operational Current AC-3e",
    RatOpeCurAc15: "Rated Operational Current AC-15",
    RatOpeCurAc21: "Rated Operational Current AC-21A",
    RatOpeCurAc21a: "Rated Operational Current AC-21A",
    RatOpeCurAc22: "Rated Operational Current AC-22A",
    RatOpeCurAc22a: "Rated Operational Current AC-22A",
    RatOpeCurAc23: "Rated Operational Current AC-23A",
    RatOpeCurAc23a: "Rated Operational Current AC-23A",
    RatOpeCurDc1: "Rated Operational Current DC-1",
    RatOpeCurDc3: "Rated Operational Current DC-3",
    RatOpeCurDc5: "Rated Operational Current DC-5",
    RatOpeCurDc13: "Rated Operational Current DC-13",
    RatOpePowAc23: "Rated Operational Power AC-23A",
    RatOpePowAc23a: "Rated Operational Power AC-23A",
    RatOpeVol: "Rated Operational Voltage",
    RatSerShoCirBreCap: "Rated Service Short-Circuit Breaking Capacity",
    RatShoCirCap: "Rated Short-Circuit Capacity",
    RatShoCirMakCap: "Rated Short-circuit Making Capacity",
    RatShoTimWitCur: "Rated Short-time Withstand Current",
    RatUltShoCirBreCap: "Rated Ultimate Short-Circuit Breaking Capacity",
    RatedFrequency: "Rated Frequency",
    RatedOutputCurrent: "Rated Output Current",
    RatedOutputPower: "Rated Output Power",
    RatedOutputVoltage: "Rated Output Voltage",
    RatedOuputVoltage: "Rated Output Voltage",
    RalNum: "RAL Number",
    ReachDeclaration: "REACH Declaration",
    ReachDate: "REACH Date",
    ReachInformation: "REACH Information",
    RoHSDate: "RoHS Date",
    RoHSInformation: "RoHS Declaration",
    RoHSStatus: "RoHS Information",
    SellingUnitOfMeasure: "Selling Unit of Measure",
    ScrewTerminalType: "Screw Terminal Type",
    ShortCircuitCapacity: "Short Circuit Capacity",
    StandardizationBody: "Standardization Body",
    Standards: "Standards",
    SuitableForClass: "Suitable for Product Class",
    TerminalType: "Terminal Type",
    TransparentDoor: "Transparent Door",
    TriCha: "Tripping Characteristic",
    WeeeCategory: "WEEE Category",
    WirStrLen: "Wire Stripping Length"
  };
  if (known[code]) return known[code];
  if (known[baseCode]) return known[baseCode];
  const officialName = cleanAbbJsonValue(fallbackName);
  if (isUsefulAbbEnglishAttributeName(officialName)) return officialName;
  const humanized = humanizeAbbAttributeCode(baseCode);
  return humanized || officialName;
}

function baseAbbAttributeCode(code: string): string {
  return code.replace(/_[A-Z0-9]+$/, "");
}

function humanizeAbbAttributeCode(code: string): string {
  return cleanText(
    code
      .replace(/[.#_]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/\bId\b/g, "ID")
      .replace(/\bEan\b/g, "EAN")
      .replace(/\bAc\b/g, "AC")
      .replace(/\bDc\b/g, "DC")
      .replace(/\bUl\b/g, "UL")
      .replace(/\bCsa\b/g, "CSA")
      .replace(/\bIp\b/g, "IP")
  );
}

function isUsefulAbbEnglishAttributeName(value: string): boolean {
  if (!value || value.length > 90) return false;
  return /\b(?:abb|alias|approval|cad|catalog|certificate|circuit|class|code|color|colour|commercial|configuration|connection|contact|country|current|data|declaration|depth|description|designation|dimension|display|door|drawing|ean|electrical|enclosure|environmental|finish(?:ing)?|frequency|gross|height|housing|iec|information|instructions?|manuals?|material|module|mounting|name|net|number|operat(?:e|ing|ional)|order|package|pole|power|product|protection|quantity|rated|reach|rohs|sales|sheet|standard|status|surface|tariff|terminal|technical|type|ul|unit|voltage|weight|width|weee)\b/i.test(value);
}

function cleanAbbJsonValue(value: string): string {
  return cleanText(
    value
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/\\"/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/<br\s*\/?>/gi, "; ")
      .replace(/<\/?[^>]+>/g, " ")
  );
}

function dedupePipeJoinedCells(cells: string[]): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const cell of cells) {
    const trimmed = cleanText(cell);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique.join(" | ");
}
