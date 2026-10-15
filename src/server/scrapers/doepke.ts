import * as cheerio from "cheerio";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { catalogTextMatches, fillCatalogTemplate } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments, dedupeSources } from "./dedupe.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";
import type { FetchedText } from "./http-client.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { classifyDocument, cleanText, emptyResult, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";

const DOEPKE_PARSER = "doepke-prodext";
const DOEPKE_PARSER_VERSION = "doepke-v1";
// `prodext.php` is a legacy but stable Doepke endpoint keyed directly off the article number
// (ARTNR) — every product family (RCCB, RCBO, accessories, ...) renders from the same static
// template, so a single GET resolves the product with no search/discovery step. English is tried
// first: its technical-data labels ("Weight", "Width", "Rated voltage (AC)", ...) line up with the
// shared ontology synonyms directly, while German is a same-content fallback for older articles
// that only publish a German page.
const DOEPKE_PRODEXT_TEMPLATES = [
  "https://www.doepke.de/source/prodext.php?ARTNR={part}&lang=en",
  "https://www.doepke.de/source/prodext.php?ARTNR={part}&lang=de"
];
// The real German not-found text is "Ein Produkt mit der Artikelnummer {ARTNR} ist uns leider
// nicht bekannt." — a guessed "kein produkt..." phrasing never matched it, so a not-found DE page
// (which echoes the searched article number back in its own text) passed catalogTextMatches as a
// false-positive "found" result with 0 attributes/documents, then fell through to the generic
// discovery fallback, which grabbed unrelated images (site logo, language flags, other products)
// from whatever page it found next.
const DOEPKE_NOT_FOUND_PATTERN = /not aware of any product|ist uns leider nicht bekannt/i;

// The page is a shared, decades-old FrontPage-style template with mismatched-case tags
// (`<div ...>...</DIV>`) and inline `javascript:` links. The generic understanding-engine
// heuristics (built for well-formed modern markup) mis-split this into garbage attributes and
// picked up a `javascript:` pseudo-URL as a "document". Every product page renders from the exact
// same fixed element ids below, so reading them directly is both simpler and far more reliable
// than fighting the generic table/prose extractors on this one template.
const DOEPKE_TITLE_SELECTOR = "#ART_RKopf";
const DOEPKE_DESCRIPTION_SELECTOR = "#ART_Text";
const DOEPKE_IMAGE_SELECTOR = "#ART_Bild img";
// Repeating `<div id="ART_EGn">Label<br><b>Value</b></div>` feature rows (poles, residual current
// type, rated current, ...). The id is reused on every row (invalid HTML, but consistent).
const DOEPKE_FEATURE_ROW_SELECTOR = 'div[id="ART_EGn"]';
// Real downloadable assets sit in `<div id="ART_Link"><a href="/uploads/...">Label</a></div>`
// rows. Accessory cross-reference links (other article numbers) and the "open in popup" javascript
// thumbnail link use the same `#ART_Link`-ish styling but never point at `/uploads/`.
const DOEPKE_DOWNLOAD_LINK_SELECTOR = 'div[id="ART_Link"] > a[href^="/uploads/"], div[id="ART_Link"] > a[href^="https://www.doepke.de/uploads/"]';
const DOEPKE_DATASHEET_LABEL_PREFIX = /^(?:data\s*sheet|datenblatt|hoja\s+de\s+datos)\s*/i;
// Ignore installer executables and raw tender-text export formats: not product facts, not
// something a customer document sheet needs, and .exe downloads are undesirable to surface at all.
const DOEPKE_IGNORED_DOWNLOAD_EXTENSIONS = /\.(?:exe|rtf|x81|p81|d81|html)(?:[?#]|$)/i;

export class DoepkeConnector implements ManufacturerConnector {
  readonly id = "doepke";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const attemptedUrls: string[] = [];

    for (const template of DOEPKE_PRODEXT_TEMPLATES) {
      const url = fillCatalogTemplate(template, catalogNumber);
      attemptedUrls.push(url);
      try {
        const fetched = await fetchDoepkeText(url, context);
        if (!doepkePageMatches(fetched.text, catalogNumber)) continue;
        return withDoepkeMetadata(catalogNumber, fetched, context);
      } catch {
        // Try the next locale template.
      }
    }

    // Neither the English nor the German prodext.php lookup matched (typo'd or discontinued
    // article number). Fall through to the shared official discovery net for a last resort.
    const { result: fallback, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: this.id });
    const result = fallback ?? emptyResult("doepke", catalogNumber, `Doepke product page was not found for ${catalogNumber}.`);
    return withDiscoveryFallbackDiagnostics(
      {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          attemptedUrls: [...new Set([...(result.diagnostics?.attemptedUrls ?? []), ...attemptedUrls])]
        }
      },
      discovery
    );
  }

  async enrichDocuments(catalogNumber: string, result: ProductResult, context: ScrapeContext): Promise<ProductResult> {
    if (context.downloadDocuments === false || context.imageOnly) return result;
    const isGenericDuplineGuide = (value: string | undefined) =>
      /doepke_5900102_dup_pl_web_en\.pdf|dupline planning aid/i.test(value ?? "");
    const relevantDocuments = result.documents.filter((document) => !isGenericDuplineGuide(document.url));
    const relevantAttributes = result.attributes.filter((attribute) => !isGenericDuplineGuide(attribute.sourceUrl));
    const productResult = relevantDocuments.length === result.documents.length && relevantAttributes.length === result.attributes.length
      ? result
      : { ...result, documents: relevantDocuments, attributes: relevantAttributes };
    let exactPdf = productResult.documents.find((document) =>
      document.type === "datasheet" && /doepke_\d+_dbl_[a-z]{2}\.pdf(?:[?#]|$)/i.test(document.url)
    ) ?? (/(?:DNP\s*8E|8-way input)/i.test(`${productResult.title ?? ""} ${productResult.description ?? ""}`)
      ? productResult.documents.find((document) => document.type === "manual" && /3931177\.pdf(?:[?#]|$)/i.test(document.url))
      : /\bDRD\s*2\b/i.test(`${productResult.title ?? ""} ${productResult.description ?? ""}`)
        ? productResult.documents.find((document) => document.type === "manual" && /3931203\.pdf(?:[?#]|$)/i.test(document.url))
        : undefined);
    let fallbackDownloaded: DocumentRecord | undefined;
    let fallbackText: string | undefined;
    let fallbackPageCount: number | undefined;
    if (!exactPdf && productResult.productUrl && catalogNumber) {
      // Several exact Doepke article pages expose only an operating manual in their legacy
      // English link list, while the same exact article's official datasheet follows this
      // article-number URL convention. Try the canonical English and German assets, but accept
      // either only after the PDF itself contains the requested article number.
      for (const language of ["en", "de"]) {
        const candidate: DocumentRecord = {
          type: "datasheet",
          label: "Data sheet",
          url: `https://www.doepke.de/uploads/tx_doepkeproducts/datenblatt/doepke_${catalogNumber}_dbl_${language}.pdf`,
          sourceUrl: productResult.productUrl
        };
        try {
          const downloaded = await context.downloadDocument(candidate);
          if (!downloaded.localPath) continue;
          const extracted = await extractDoepkePdfText(downloaded.localPath);
          if (!extracted.text.replace(/\D/g, "").includes(catalogNumber.replace(/\D/g, ""))) continue;
          exactPdf = candidate;
          fallbackDownloaded = downloaded;
          fallbackText = extracted.text;
          fallbackPageCount = extracted.pageCount;
          break;
        } catch {
          // A locale asset may not exist. The next language uses the same exact article number.
        }
      }
    }
    if (!exactPdf) return productResult;

    try {
      const downloaded = fallbackDownloaded ?? await context.downloadDocument(exactPdf);
      if (!downloaded.localPath) return productResult;
      // Long operating manuals put the technical table near the end. Extract the front page and
      // final five pages only for manuals over eight pages; exact article validation below must
      // still find the requested order number in the retained technical section.
      const extracted = fallbackText !== undefined
        ? { text: fallbackText, pageCount: fallbackPageCount ?? 0 }
        : await extractDoepkePdfText(downloaded.localPath, exactPdf.type === "manual");
      const text = extracted.text;
      const compactArticle = catalogNumber.replace(/\D/g, "");
      const compactText = text.replace(/\D/g, "");
      if (!compactText.includes(compactArticle)) return productResult;
      const exactAttributes = extractDoepkeExactDocumentAttributes(catalogNumber, productResult, exactPdf.url, text);
      const attributes = dedupeAttributes([...productResult.attributes, ...exactAttributes]);
      const updatedDownloaded = extracted.pageCount > 8 && exactPdf.type === "manual"
        ? { ...downloaded, enrichable: false, parseStatus: "parsed" as const }
        : downloaded;
      const documents = dedupeDocuments([
        ...productResult.documents.filter((document) => document.url !== exactPdf.url),
        updatedDownloaded
      ]);
      return {
        ...productResult,
        attributes,
        documents,
        normalized: normalizeFields(attributes, documents, "doepke"),
        diagnostics: {
          ...result.diagnostics,
          notes: [...(result.diagnostics?.notes ?? []), "Exact Doepke PDF technical rows were retained only after the document matched the requested article number and product designation."]
        }
      };
    } catch {
      return result;
    }
  }
}

export function doepkePageMatches(html: string, catalogNumber: string): boolean {
  if (DOEPKE_NOT_FOUND_PATTERN.test(html)) return false;
  return catalogTextMatches(html, catalogNumber);
}

function withDoepkeMetadata(catalogNumber: string, fetched: FetchedText, context: ScrapeContext): ProductResult {
  const sourceUrl = fetched.effectiveUrl;
  const $ = cheerio.load(fetched.text);

  const title = doepkeTitle($);
  const description = doepkeShortDescription($);
  const datasheet = doepkeDatasheetLink($, sourceUrl);
  const image = doepkeProductImage($, sourceUrl, catalogNumber);

  const attributes: AttributeRecord[] = [
    ...doepkeFeatureAttributes($, sourceUrl),
    ...doepkeDescriptionElectricalAttributes(description, sourceUrl),
    {
      group: "Doepke Product Data",
      name: "Catalog Number",
      value: catalogNumber,
      sourceUrl,
      sourceType: "official",
      parser: DOEPKE_PARSER,
      stage: DOEPKE_PARSER,
      confidence: 0.9
    },
    ...(title ? [{
      group: "Doepke Product Data",
      name: "Product Designation",
      value: title,
      sourceUrl,
      sourceType: "official" as const,
      parser: DOEPKE_PARSER,
      stage: DOEPKE_PARSER,
      confidence: 0.9
    }] : []),
    ...(datasheet?.typeCode
      ? [{
          group: "Doepke Product Data",
          name: "Type Code",
          value: datasheet.typeCode,
          sourceUrl,
          sourceType: "official" as const,
          parser: DOEPKE_PARSER,
          stage: DOEPKE_PARSER,
          confidence: 0.88
        }]
      : [])
  ];

  const documents: DocumentRecord[] = [
    ...(image ? [image] : []),
    ...(datasheet ? [datasheet.document] : []),
    ...doepkeDownloadDocuments($, sourceUrl, catalogNumber)
  ];

  const dedupedAttributes = dedupeAttributes(attributes);
  const dedupedDocuments = dedupeDocuments(documents);

  return {
    manufacturerId: "doepke",
    catalogNumber,
    status: dedupedAttributes.length || dedupedDocuments.length ? "found" : "partial",
    confidence: 0.8,
    productUrl: sourceUrl,
    localizedUrls: buildLocalizedProductUrls("doepke", catalogNumber, sourceUrl, context.manufacturer.localizedUrlTemplates),
    title,
    description,
    normalized: normalizeFields(dedupedAttributes, dedupedDocuments, "doepke"),
    attributes: dedupedAttributes,
    documents: dedupedDocuments,
    sources: dedupeSources([doepkeSource(fetched, "Doepke prodext.php article page accepted.")]),
    diagnostics: { chosenUrl: sourceUrl }
  };
}

/**
 * `#ART_RKopf` holds the product designation followed by a nested `#TLINK` div that repeats the
 * datasheet link ("&raquo; articles properties") for a second time on the page. Dropping that
 * whole nested div (not just the `<a>` inside it) is required to avoid a trailing "»" artifact.
 */
export function doepkeTitle($: cheerio.CheerioAPI): string | undefined {
  return cleanText($(DOEPKE_TITLE_SELECTOR).clone().find("#TLINK").remove().end().text()) || undefined;
}

/**
 * The `#ART_Text` block is a flat run of text and `<br>` tags starting with a one-line
 * plain-language description ("Residual current circuit-breakers, four-pole, 63 A, ..."), followed
 * by `<div id="ART_TXT_Z1">Function:</div>` (or "Funktion:", "Features:", ...) heading markers that
 * introduce the long-form marketing prose. Reading only the text nodes before the first such
 * heading div gives the short description without any string-splitting assumptions about language.
 */
export function doepkeShortDescription($: cheerio.CheerioAPI): string | undefined {
  const container = $(DOEPKE_DESCRIPTION_SELECTOR);
  if (!container.length) return undefined;
  const parts: string[] = [];
  for (const node of container.contents().toArray()) {
    if (node.type === "tag") {
      if (node.name.toLowerCase() === "div") break;
      continue;
    }
    if (node.type === "text") parts.push(node.data);
  }
  return cleanText(parts.join(" ")) || undefined;
}

/**
 * Accessory pages such as fork busbars publish their rated current only in the short product
 * description (for example "... 13,5 MW ..., 63 A"), not in the small Features table. This is
 * still exact product-page evidence, so expose an explicit rated-current attribute for the shared
 * normalizer instead of leaving the required current field blank.
 */
export function doepkeDescriptionElectricalAttributes(description: string | undefined, sourceUrl: string): AttributeRecord[] {
  if (!description) return [];
  const match = description.match(/(?:^|[,;])\s*(\d+(?:[.,]\d+)?)\s*A\b/i) ?? description.match(/\b(\d+(?:[.,]\d+)?)\s*A\b/i);
  if (!match) return [];
  return [{
    group: "Doepke Product Data",
    name: "Rated current",
    value: `${match[1].replace(",", ".")} A`,
    sourceUrl,
    sourceType: "official",
    parser: DOEPKE_PARSER,
    stage: DOEPKE_PARSER,
    confidence: 0.88
  }];
}

/**
 * Reads the "Features" mini spec table: repeating `<div id="ART_EGn">Label<br><b>Value</b></div>`
 * rows (poles, residual current type, rated current, IΔn, ...). This is the only structured product
 * data present on the HTML page — everything else (weight, dimensions, material, certificates,
 * voltage) lives exclusively in the datasheet PDF and is filled in later by document enrichment.
 */
export function doepkeFeatureAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $(DOEPKE_FEATURE_ROW_SELECTOR).each((_, element) => {
    const $row = $(element);
    const value = cleanText($row.find("b").first().text());
    const label = cleanText($row.clone().find("b").remove().end().text());
    if (!label || !value) return;
    attributes.push({
      group: "Doepke Features",
      name: label,
      value,
      sourceUrl,
      sourceType: "official",
      parser: DOEPKE_PARSER,
      stage: DOEPKE_PARSER,
      confidence: 0.9
    });
  });
  return attributes;
}

export function doepkeDatasheetLink(
  $: cheerio.CheerioAPI,
  baseUrl: string
): { document: DocumentRecord; typeCode?: string } | undefined {
  const link = $(DOEPKE_DOWNLOAD_LINK_SELECTOR)
    .filter((_, element) => /_dbl_[a-z]{2}\.pdf(?:[?#]|$)/i.test($(element).attr("href") ?? ""))
    .first();
  const href = link.attr("href");
  if (!href) return undefined;

  const url = absoluteDoepkeUrl(href, baseUrl);
  if (!url) return undefined;
  const label = cleanText(link.text()) || "Data sheet";
  const typeCode = cleanText(label.replace(DOEPKE_DATASHEET_LABEL_PREFIX, "")) || undefined;
  return {
    document: { type: "datasheet", label, url, sourceUrl: baseUrl },
    typeCode
  };
}

export function doepkeProductImage($: cheerio.CheerioAPI, baseUrl: string, catalogNumber: string): DocumentRecord | undefined {
  const src = $(DOEPKE_IMAGE_SELECTOR).first().attr("src");
  if (!src) return undefined;
  const url = absoluteDoepkeUrl(src, baseUrl);
  if (!url) return undefined;
  const imageArticle = url.match(/\/doepke_(\d+)_\d+px_(?:ml|en|de)\.png(?:[?#]|$)/i)?.[1];
  // A few Doepke article pages share an illustrative representative image with a sibling SKU.
  // Keep the exact product page, but do not attach a sibling photo as if it depicted this article.
  if (imageArticle && imageArticle !== catalogNumber) return undefined;
  return { type: "image", label: "Product image", url, sourceUrl: baseUrl };
}

/**
 * Every other real download (manual, technical info sheets, dimensional drawing, wiring diagram,
 * STEP file) lives in an `#ART_Link` anchor pointing at `/uploads/...`. The datasheet is excluded
 * here since `doepkeDatasheetLink` already emits it as the primary "datasheet" document.
 */
export function doepkeDownloadDocuments($: cheerio.CheerioAPI, baseUrl: string, catalogNumber: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  const seenUrls = new Set<string>();
  $(DOEPKE_DOWNLOAD_LINK_SELECTOR).each((_, element) => {
    const href = $(element).attr("href");
    if (!href || DOEPKE_IGNORED_DOWNLOAD_EXTENSIONS.test(href)) return;
    const url = absoluteDoepkeUrl(href, baseUrl);
    if (!url || seenUrls.has(url)) return;
    // This planning aid is a large family-wide table with values for many unrelated Dupline
    // devices. It is neither an exact-product document nor useful evidence for the requested SKU.
    if (/doepke_5900102_dup_pl_web_en\.pdf|dupline planning aid/i.test(url + " " + $(element).text())) return;
    const isDatasheet = /_dbl_[a-z]{2}\.pdf(?:[?#]|$)/i.test(href);
    if (isDatasheet) return;
    seenUrls.add(url);
    const label = cleanText($(element).text()) || `${catalogNumber} document`;
    documents.push({ type: doepkeDocumentType(label, url), label, url, sourceUrl: baseUrl });
  });
  return documents;
}

/**
 * `classifyDocument` treats any "technical information"/"technical data" label as a "datasheet",
 * but Doepke's "Technical information Derating graph"/"...dissipation power" links are shared,
 * series-wide bulletins (not per-article specs) reused across every DFS 2/4 catalog number.
 * Letting them share the "datasheet" type with the real per-article datasheet makes
 * `enrichResultFromDownloadedDocuments` parse and merge all of them together, and their unrelated
 * text can out-rank/corrupt attributes the real datasheet already resolved correctly. Demote them
 * to "other" so only the genuine per-article datasheet drives datasheet-priority enrichment.
 */
function doepkeDocumentType(label: string, url: string): DocumentRecord["type"] {
  if (/doepke_5900102_dup_pl_web_en\.pdf|dupline planning aid/i.test(url + " " + label)) return "other";
  if (/^(?:technical information|prospectus)\b/i.test(label)) return "other";
  // "Wiring diagram"/"Connection diagram" is a circuit schematic JPG, not a product photo — but
  // `classifyDocument` falls through to its generic `.jpe?g` check and tags it "image" since its
  // label doesn't contain "drawing" the way "Dimensional drawing" does. Left as "image" it competes
  // with the real product photo for the image slot.
  if (/^(?:wiring|connection)\s+diagram\b/i.test(label)) return "cad";
  // Tripping-characteristic/derating curve charts ("Characteristic B SK 30 mA", "Derating curve
  // ...") live under `/tx_doepkeproducts/diagramm/` and are always JPGs — `classifyDocument`'s
  // generic `.jpe?g` fallback tags them "image" the same as the real product photo, so
  // run-manager's per-product image cap keeps BOTH as distinct "gallery images" and downloads the
  // chart alongside (sometimes instead of) the actual product photo. These are graphs, not photos.
  if (/\/tx_doepkeproducts\/diagramm\//i.test(url)) return "other";
  return classifyDocument(label, url);
}

async function extractDoepkePdfText(filePath: string, compactLongManual = false): Promise<{ text: string; pageCount: number }> {
  const data = new Uint8Array(await readFile(filePath));
  const pdf = await getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  try {
    const pages: string[] = [];
    const pageNumbers = compactLongManual && pdf.numPages > 8
      ? [...new Set([1, pdf.numPages - 4, pdf.numPages - 3, pdf.numPages - 2, pdf.numPages - 1, pdf.numPages])]
      : Array.from({ length: pdf.numPages }, (_, index) => index + 1);
    for (const pageNumber of pageNumbers) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").filter(Boolean).join(" "));
    }
    return { text: pages.join("\n"), pageCount: pdf.numPages };
  } finally {
    await pdf.destroy();
  }
}

function extractDoepkeExactDocumentAttributes(
  catalogNumber: string,
  result: ProductResult,
  sourceUrl: string,
  rawText: string
): AttributeRecord[] {
  const text = cleanText(rawText.replace(/\s+/g, " "));
  const titleAndDescription = `${result.title ?? ""} ${result.description ?? ""} ${text}`;
  const rows: Array<{ name: string; value: string }> = [];
  const push = (name: string, value: string | undefined) => {
    if (value) rows.push({ name, value: cleanText(value) });
  };
  const acVoltage = text.match(/Rated voltage\s*\(AC\)\s*(\d+(?:[.,]\d+)?\s*V)/i)?.[1];
  const acCurrent = text.match(/Rated current\s*\(AC\)\s*(\d+(?:[.,]\d+)?\s*A)/i)?.[1];
  const designation = titleAndDescription.match(/\b(?:DRCA\s*[- ]?1\s*[- ]?Set|SIRO-SL|DSU\s*8\s*plus|DSI\s*1|DRP|RCBO\s*\d+[^\n]{0,40}|Tytan\s+II\s+D0-[^\s,;]+|SIR\s*16\s*M|DNP\s*8E|DBM\s*1|DLUX|DTS\s*1|DRD\s*2|DRT\s*1|DWS\s*1)\b/i)?.[0];
  push("Verified product designation", designation);
  push("Number of poles", text.match(/Number of poles\s+(\d+)\b/i)?.[1]);
  push("Rated short-circuit current", text.match(/Rated short-circuit current\s+(\d+(?:[.,]\d+)?\s*kA)/i)?.[1]);
  push("Rated insulation voltage", text.match(/Rated insulation voltage\s+(\d+(?:[.,]\d+)?\s*V)/i)?.[1]);
  push("Rated impulse withstand voltage", text.match(/Rated impulse withstand voltage\s+(\d+(?:[.,]\d+)?\s*kV)/i)?.[1]);

  if (/\bDRCA\s*[- ]?1\s*[- ]?Set\b/i.test(titleAndDescription)) {
    push("Measurement system function", "Residual current analysis system");
    push("Residual current measurement frequency range", text.match(/residual currents? from\s*(10\s*Hz\s*to\s*100\s*kHz)/i)?.[1]);
    push("Residual current measurement amplitude maximum", text.match(/amplitude\s+up\s+to\s+max\.?\s*(10\s*A)/i)?.[1]);
    push("DC residual current immunity", text.match(/immunity against DC residual currents\s+up\s+to\s*(3\s*A)/i)?.[1]);
    push("Current transformer inside diameter", text.match(/(70\s*mm)\s+inside diameter/i)?.[1]);
    push("Measuring cable length", text.match(/cable length\s*(3\s*m)/i)?.[1]);
    const width = text.match(/Width\s*(420\s*mm)/i)?.[1];
    const height = text.match(/Height\s*(345\s*mm)/i)?.[1];
    const depth = text.match(/Depth\s*(120\s*mm)/i)?.[1];
    if (width && height && depth) push("Verified device dimensions", "345 x 420 x 120 mm (H x W x D)");
  } else if (/\b(?:Modular )?residual current\b[\s\S]{0,80}\bDRP\b|\bMRCDs?\b/i.test(titleAndDescription)) {
    push("Monitoring device class", "MRCD residual current monitoring relay");
    push("Residual current response settings", text.match(/(?:max\. adjustable residual operating current|adjustment values).*?(0\.03\s*A[\s\S]{0,80}1\s*A)/i)?.[1]);
    push("Residual current response delay", text.match(/adjustable from\s*(30\s*ms\s*to\s*150\s*ms)/i)?.[1]);
    push("Rated control voltage options", text.match(/three control\/auxiliary voltages can be selected\s*\((230\s*V\s*[-–]\s*400\s*V\s*[-–]\s*500\s*V)\)/i)?.[1]);
  } else if (/\bSIRO-SL\b/i.test(titleAndDescription)) {
    push("Device function", "Roller shutter control slave module");
    const supplyVoltage = text.match(/(?:Betriebsspannung|Operating voltage)\s*\(DC\)\s*(24\s*V)\s*\(\s*21[.,]5\s*V\s*\.\.\.\s*26[.,]5\s*V\s*\)/i)?.[1];
    push("Device supply voltage", supplyVoltage?.replace(/\s*V$/i, " V DC"));
    const deviceSupplyCurrent = text.match(/Current consumption\s*\(AC\)\s*max\.?\s*(0[.,]012\s*A)/i)?.[1];
    push("Device supply current", deviceSupplyCurrent ? "12 mA AC" : undefined);
    push("Rated output load current", text.match(/(?:roller shutter control module for a\s*230\s*V\s*\/\s*(2\s*A)\s*motor|relays?[^.]{0,100}\b(2\s*A)\s*load capacity)/i)?.slice(1).find(Boolean));
    push("Rated output voltage", text.match(/roller shutter control module for a\s*(230\s*V)\s*\/\s*2\s*A\s*motor/i)?.[1]);
    const width = text.match(/Width\s*(35\s*mm)/i)?.[1];
    const height = text.match(/Height\s*(85\s*mm)/i)?.[1];
    const depth = text.match(/Depth\s*(65\s*mm)/i)?.[1];
    if (width && height && depth) push("Verified device dimensions", "85 x 35 x 65 mm (H x W x D)");
    push("Operating temperature", text.match(/Umgebungstemperatur\s*(-10\s*°C\s*\.\.\.\s*\+?45\s*°C)/i)?.[1]);
    push("Housing material", text.match(/Gehäusematerial\s*(Polycarbonat\s*\(PC\))/i)?.[1]);
    push("Protection class", text.match(/Schutzart\s*(IP\s*20)/i)?.[1]);
  } else if (/\bDSU\s*8\s*plus\b/i.test(titleAndDescription)) {
    const supplyVoltage = text.match(/Operating voltage\s*\(DC\)\s*(24\s*V)\s*\(\s*21[.,]5\s*V\s*\.\.\.\s*26[.,]5\s*V\s*\)/i)?.[1];
    const supplyCurrent = text.match(/Current consumption\s*\(DC\)\s*(0[.,]017\s*A)\s*\(\s*0[.,]013\s*A\s*\.\.\.\s*0[.,]025\s*A\s*\)/i);
    const busCurrent = text.match(/current consumption bus\s*(0[.,]9\s*mA|900\s*[µμ]A)\s*\(\s*(?:0[.,]8\s*mA|800\s*[µμ]A)\s*\.\.\.\s*(?:1(?:[.,]0)?\s*mA|1000\s*[µμ]A)\s*\)/i);
    push("Device supply voltage", supplyVoltage ? `${supplyVoltage} DC (21.5–26.5 V DC)` : undefined);
    push("Device supply current", supplyCurrent ? "17 mA (range 13–25 mA)" : undefined);
    push("Dupline bus current consumption", busCurrent ? "0.9 mA (range 0.8–1.0 mA)" : undefined);
    push("Input signal voltage (AC)", text.match(/Rated voltage\s*\(AC\)\s*(0\s*V\s*\.\.\.\s*230\s*V)/i)?.[1]);
    push("Input signal voltage (DC)", text.match(/Rated voltage\s*\(DC\)\s*(0\s*V\s*\.\.\.\s*230\s*V)/i)?.[1]);
    push("Input channels", text.match(/max\. number of input channels\s*(8)/i)?.[1]);
    push("Input switching thresholds", text.match(/switching thresholds?\s*(?:of\s*)?(20\s*V\s*(?:and|\/)\s*190\s*V)/i)?.[1]);
    const width = text.match(/Width\s*(72\s*mm)/i)?.[1];
    const height = text.match(/Height\s*(85\s*mm)/i)?.[1];
    const depth = text.match(/Depth\s*(65\s*mm)/i)?.[1];
    if (width && height && depth) push("Verified device dimensions", "85 x 72 x 65 mm (H x W x D)");
    push("Installation depth", text.match(/Installation depth\s*(58\s*mm)/i)?.[1]);
    push("Input channels", text.match(/up to\s*(8)\s+voltage signals/i)?.[1]);
  } else if (/\bDSI\s*1\b/i.test(titleAndDescription)) {
    push("Communication protocol", text.match(/Protocol(?:s)?\s*(Modbus\s*I-RTU)/i)?.[1]);
    push("Serial interface", text.match(/Specification\s*(RS\s*485)/i)?.[1]);
    push("Device supply voltage", text.match(/Operating voltage\s*\(DC\)\s*(5\s*V)/i)?.[1]?.replace(/\s*V$/i, " V DC"));
    push("Dupline bus current consumption", text.match(/current consumption bus\s*(10\s*[µμ]A)/i)?.[1]);
    const width = text.match(/Width\s*(55\s*mm)/i)?.[1];
    const height = text.match(/Height\s*(70\s*mm)/i)?.[1];
    const depth = text.match(/Depth\s*(16\s*mm)/i)?.[1];
    if (width && height && depth) push("Verified device dimensions", "70 x 55 x 16 mm (H x W x D)");
  } else if (/\bRCBO\s*1\b/i.test(titleAndDescription)) {
    push("Rated voltage (AC)", acVoltage);
    push("Rated current (AC)", acCurrent);
    push("Device supply voltage", acVoltage ? `${acVoltage} AC` : undefined);
    push("Device supply current", acCurrent);
  } else if (/\bTytan\s+II\s+D0-/i.test(titleAndDescription) && /fuse[-\s]?switch[-\s]?disconnector/i.test(titleAndDescription)) {
    push("Rated voltage (AC)", acVoltage);
    push("Rated current (AC)", acCurrent);
    push("Device supply voltage", acVoltage ? `${acVoltage} AC` : undefined);
    push("Device supply current", acCurrent);
  } else if (/\bSIR\s*16\s*M\b/i.test(titleAndDescription)) {
    const controlVoltage = text.match(/Operating voltage\s*\(DC\)\s*(24\s*V)\s*\(\s*21[.,]6\s*V\s*\.\.\.\s*26[.,]4\s*V\s*\)/i)?.[1];
    const controlCurrent = text.match(/(?:Rated current|Current consumption)\s*(?:\(DC\))?\s*(?:max\.?\s*)?(4\s*mA)\b/i)?.[1];
    push("Device supply voltage", controlVoltage ? `${controlVoltage} DC` : undefined);
    push("Device supply current", controlCurrent);
    push("Rated contact current", acCurrent);
    push("Relay operating mode", text.match(/monostable\s+load\s+relay/i)?.[0]);
    push("Rated switching capacity at cos φ = 1", text.match(/Switchung capacity\s*cos\s*j\s*=\s*1,0\s*(\d+\s*VA)/i)?.[1]);
  } else if (/\bDNP\s*8E\b/i.test(titleAndDescription)) {
    const nominalVoltage = text.match(/Rated operating voltage\s+(?:10\s*V\s*DC\s*)?(24\s*V\s*DC)/i)?.[1]?.replace(/\s*V\s*DC/i, " V DC");
    const supplyCurrent = [...text.matchAll(/Current input\s+(\d+(?:[.,]\d+)?\s*mA)/gi)].at(-1)?.[1];
    const contactVoltage = text.match(/No-load voltage\s+(\d+(?:[.,]\d+)?\s*V\s*DC)/i)?.[1];
    const contactLoad = text.match(/Contact load\s+(\d+(?:[.,]\d+)?\s*mA)/i)?.[1];
    push("Rated operating voltage", nominalVoltage);
    push("Device supply voltage", nominalVoltage);
    push("Device supply current", supplyCurrent);
    push("Input contact supply voltage", contactVoltage);
    push("Maximum input contact load", contactLoad);
    push("Input channels", text.match(/Input channels\s+(8\s+(?:semiconductor\s+)?inputs?)/i)?.[1]);
    const boardDimensions = text.match(/Dimensions\s+(73\s*x\s*59)\s*\(W\s*x\s*H\s+in\s+mm\)/i)?.[1];
    push("Input signal capacity", text.match(/permits\s+(eight|8)\s+switch\s+signals/i)?.[0]);
    push("Board dimensions", boardDimensions ? `${boardDimensions} mm (W x H)` : undefined);
    push("Dimensions", boardDimensions ? `${boardDimensions} mm` : undefined);
  } else if (/\bDBM\s*1\b/i.test(titleAndDescription) && /motion detector/i.test(titleAndDescription)) {
    const busCurrent = text.match(/Current consumption\s+bus\s*(\d+(?:[.,]\d+)?\s*µA)\s*\(max\.?\s*(\d+(?:[.,]\d+)?\s*µA)\)/i);
    const currentValue = busCurrent
      ? `${Number.parseFloat(busCurrent[1].replace(",", ".")) / 1000} mA (max. ${Number.parseFloat(busCurrent[2].replace(",", ".")) / 1000} mA)`
      : undefined;
    push("Device supply current", currentValue);
    push("Motion detection range", text.match(/(?:max\.?\s*)?range\s+(?:of\s+)?(?:up\s+to\s+)?(\d+(?:[.,]\d+)?\s*m)/i)?.[1]);
    push("Motion detection angle", text.match(/(?:scanning|scan|detection)\s+angle\s*(\d+(?:[.,]\d+)?\s*°)/i)?.[1]);
    push("Motion detection zones", text.match(/Number of scanning zones\s+(\d+)/i)?.[1]);
    push("Motion detection areas", text.match(/Number of scanning areas\s+(\d+)/i)?.[1]);
  } else if (/\b(?:DLUX|DTS\s*1|DRD\s*2|DRT\s*1|DWS\s*1)\b/i.test(titleAndDescription)) {
    const isDrd2 = /\bDRD\s*2\b/i.test(titleAndDescription);
    const sourceBusSignal = /(?:Operating voltage|voltage source)\s*(?:source\s*)?(?:from\s*)?(?:the\s*)?Dupline\s+(?:signal\s+)?(?:bus|signal conductors?)/i.test(text) ||
      /Operating voltage\s*source\s*Bus signal/i.test(text);
    if (sourceBusSignal) push("Operating voltage source", "Dupline bus signal");

    const consumption = text.match(/Current consumption\s*(?:bus\s*)?(?:max\.?\s*)?(\d+(?:[.,]\d+)?)\s*([µμu]A|mA)(?:\s*\(\s*(\d+(?:[.,]\d+)?)\s*[µμu]A\s*\.\.\.\s*(\d+(?:[.,]\d+)?)\s*[µμu]A\s*\))?/i);
    const busCurrent = consumption && /^D(?:LUX|TS\s*1|RT\s*1|WS\s*1)$/i.test(designation?.replace(/\s+/g, "") ?? "");
    if (busCurrent && consumption) {
      const toMilliAmps = (amount: string, unit: string) => {
        const numeric = Number.parseFloat(amount.replace(",", "."));
        return unit.toLowerCase() === "ma" ? numeric : numeric / 1000;
      };
      const nominal = toMilliAmps(consumption[1], consumption[2]);
      const range = consumption[3] && consumption[4]
        ? ` (range ${toMilliAmps(consumption[3], "µA")}–${toMilliAmps(consumption[4], "µA")} mA)`
        : "";
      const isMaximum = /current consumption\s*(?:bus\s*)?max\.?/i.test(text);
      push("Device supply current", `${isMaximum ? "max. " : ""}${nominal} mA${range}`);
    }

    if (isDrd2) {
      const minAndMax = text.match(/Current input\s+(\d+(?:[.,]\d+)?)\s*[µμu]A\s+(\d+(?:[.,]\d+)?)\s*mA/i);
      if (minAndMax) {
        const min = Number.parseFloat(minAndMax[1].replace(",", ".")) / 1000;
        push("Minimum bus current input", `${min} mA`);
        push("Device supply current", `max. ${minAndMax[2]} mA`);
      }
      push("Detector principle", text.match(/Type\s+(optical\s*\(?(?:acc\.?\s*to\s*)?Tyndall[- ]Effect\)?)/i)?.[1]);
      push("Device function", text.match(/Smoke and Fire Detector DRD 2/i)?.[0]);
      push("Input channels", text.match(/Input channels\s+(2\s*\([^)]*\))/i)?.[1] ?? text.match(/Input channels\s+(2)\b/i)?.[1]);
      push("Monitored floor area", text.match(/maximum floor area of\s+(\d+\s*m²)/i)?.[1]);
      push("Maximum monitored ceiling clearance", text.match(/h(?:e|i)ght of up to\s+(\d+\s*m)/i)?.[1]);
      const ambient = text.match(/Ambient temperature\s*([+-]?\d+)\s*°C\s*([+-]?\d+)\s*°C/i);
      if (ambient) push("Ambient temperature", `${ambient[1]} °C ... ${ambient[2]} °C`);
      push("Housing material", text.match(/Material\s+(Polycarbonate|ABS resin|polycarbonate)/i)?.[1]);
    }
    const thermostatMin = text.match(/min\.?\s*Sensor measuring range temperature\s*(\d+(?:[.,]\d+)?\s*°?C)/i)?.[1];
    const thermostatMax = text.match(/max\.?\s*Sensor measuring range temperature\s*(\d+(?:[.,]\d+)?\s*°?C)/i)?.[1];
    const thermostatRange = thermostatMin && thermostatMax
      ? `${thermostatMin} to ${thermostatMax}`
      : text.match(/(?:temperature sensor range|sensor range|adjustment range)\s*(\d+(?:[.,]\d+)?\s*°?C\s*(?:\.\.\.|to|–|-)\s*\d+(?:[.,]\d+)?\s*°?C)/i)?.[1];
    push("Temperature sensing range", thermostatRange);
    push("Temperature hysteresis", text.match(/hysteresis(?:\s+temperature)?\s*(\d+(?:[.,]\d+)?\s*°?C)/i)?.[1]);
    const sensorVoltage = text.match(/Rated voltage\s*\(DC\)\s*(max\.?\s*\d+(?:[.,]\d+)?\s*V)/i)?.[1];
    push("Sensor input voltage", sensorVoltage);
  }

  return rows.map(({ name, value }) => ({
    group: "Doepke exact technical data",
    name,
    value,
    sourceUrl,
    sourceType: "generated",
    parser: "doepke-exact-pdf",
    stage: "enrich-documents",
    confidence: 0.96,
    matchLevel: "exact"
  }));
}

function absoluteDoepkeUrl(rawUrl: string, baseUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl, baseUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function doepkeSource(fetched: FetchedText, reason: string): SourceRecord {
  return {
    url: fetched.effectiveUrl,
    sourceType: "official",
    parser: DOEPKE_PARSER,
    parserVersion: DOEPKE_PARSER_VERSION,
    stage: DOEPKE_PARSER,
    reason,
    fetchedAt: fetched.fetchedAt,
    statusCode: fetched.statusCode
  };
}

async function fetchDoepkeText(url: string, context: ScrapeContext): Promise<FetchedText> {
  const policy = context.manufacturer.fetchPolicy ?? {};
  return context.http.fetchText(url, {
    timeoutMs: policy.timeoutMs ?? 15000,
    maxAttempts: policy.maxAttempts ?? 1,
    retryBackoffMs: policy.retryBackoffMs,
    cacheTtlMs: policy.cacheTtlMs,
    headers: {
      ...(policy.acceptLanguage ? { "accept-language": policy.acceptLanguage } : {}),
      ...(policy.referer ? { referer: policy.referer } : {}),
      ...(policy.userAgent ? { "user-agent": policy.userAgent } : {})
    },
    signal: context.signal
  });
}
