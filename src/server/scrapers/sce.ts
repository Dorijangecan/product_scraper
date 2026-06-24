import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { AttributeRecord, DocumentRecord, MarkerExtractionRule, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { classifyDocument, cleanText, emptyResult, mergeResults, normalizeFields, splitNameValue } from "./normalizer.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { catalogTextMatches } from "./catalog-number.js";
import { extractMarkerData } from "./marker-extractor.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

const SCE_BASE = "https://www.saginawcontrol.com";

export class SCEConnector implements ManufacturerConnector {
  id = "sce";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const partNumber = cleanText(catalogNumber) || catalogNumber.trim();
    let search: FetchedText | undefined;
    try {
      const searchBody = new URLSearchParams({
        PartNumberSearchString: partNumber,
        radio: "Exact",
        PartNumberSubmit: "Search"
      });
      search = await context.http.fetchText(`${SCE_BASE}/advanced-part-search/`, {
        method: "POST",
        body: searchBody,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal: context.signal
      });
    } catch {
      // SCE's search endpoint is useful but non-essential. Some Windows/proxy setups reject
      // the POST, while the direct product URL still works.
    }

    try {
      const detailUrl = findExactDetailUrl(partNumber, search?.text ?? "") ?? buildSceProductUrl(partNumber);
      const detail = await fetchSceGet(context, detailUrl);
      const cad = context.downloadDocuments === false || context.imageOnly
        ? undefined
        : await fetchSceGet(context, `${SCE_BASE}/download-doc/?PartNumber=${encodeURIComponent(partNumber)}`).catch(() => undefined);
      const primary = parseSceProductPage(partNumber, detail, search, cad, context.manufacturer.markerRules);
      if (primary.status !== "failed" && primary.status !== "partial") return primary;

      return mergeSceDiscoveryFallback(primary, partNumber, context);
    } catch (error) {
      const primary = emptyResult("sce", partNumber, error instanceof Error ? error.message : "SCE fetch failed.");
      return mergeSceDiscoveryFallback(primary, partNumber, context);
    }
  }
}

async function mergeSceDiscoveryFallback(primary: ProductResult, partNumber: string, context: ScrapeContext): Promise<ProductResult> {
  const { result: fallback, discovery } = await scrapeDiscoveredFallback(partNumber, context, { idPrefix: "sce" });
  return withDiscoveryFallbackDiagnostics(mergeResults(primary, fallback), discovery);
}

function buildSceProductUrl(catalogNumber: string): string {
  return `${SCE_BASE}/partnumber_info/?n=${encodeURIComponent(cleanText(catalogNumber) || catalogNumber.trim())}`;
}

async function fetchSceGet(context: ScrapeContext, url: string): Promise<FetchedText> {
  try {
    return await context.http.fetchText(url, { signal: context.signal });
  } catch {
    return context.http.fetchTextViaPowerShell(url, { timeoutMs: 30000, signal: context.signal });
  }
}

export function parseSceProductPage(
  catalogNumber: string,
  detail: FetchedText,
  search?: FetchedText,
  cad?: FetchedText,
  markerRules?: MarkerExtractionRule[]
): ProductResult {
  const $ = cheerio.load(detail.text);
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const sources: SourceRecord[] = [];
  if (search) {
    sources.push({
      url: search.effectiveUrl,
      sourceType: "official",
      parser: "sce-advanced-part-search",
      parserVersion: "sce-v2",
      fetchedAt: search.fetchedAt,
      statusCode: search.statusCode
    });
    attributes.push(...parseSearchResultAttributes(catalogNumber, search));
  }
  sources.push({
    url: detail.effectiveUrl,
    sourceType: "official",
    parser: "sce-product-page",
    parserVersion: "sce-v2",
    fetchedAt: detail.fetchedAt,
    statusCode: detail.statusCode
  });

  const pageTitle = cleanText($("title").first().text());
  const h1 = cleanText($("h1").first().text());
  const title = (pageTitle.split(" - ")[0] || h1 || catalogNumber).trim();

  attributes.push(...parseProductSpecificationAttributes($, detail.effectiveUrl));
  const description = findSceDescription(attributes);
  if (description) {
    attributes.push({
      group: "SCE Product Data",
      name: "Product Type",
      value: description,
      sourceUrl: detail.effectiveUrl,
      sourceType: "official",
      parser: "sce-product-page",
      confidence: 0.95
    });
  }
  attributes.push(...parseDetailSectionAttributes($, detail.effectiveUrl));
  attributes.push(...parseAlternativeAttributes($, detail.effectiveUrl));
  attributes.push(...deriveSceElectricalRatingAttributes(attributes, detail.effectiveUrl));
  attributes.push(...deriveSceSpecialtyAttributes(attributes, detail.effectiveUrl));
  attributes.push(...deriveSceCertificationAttributes(attributes, detail.effectiveUrl));
  attributes.push(...deriveSceProseAttributes(catalogNumber, attributes, detail.effectiveUrl));
  const inferredVoltage = inferSceCatalogVoltage(catalogNumber);
  if (inferredVoltage && !hasExplicitSceVoltageEvidence(attributes)) {
    attributes.push({
      group: "SCE Catalog Inference",
      name: "Voltage",
      value: inferredVoltage,
      sourceUrl: detail.effectiveUrl,
      sourceType: "generated",
      parser: "sce-catalog-code",
      confidence: 0.64
    });
  }
  const inferredMaterial = inferSceDescriptionMaterial(description);
  if (inferredMaterial && !hasExplicitSceMaterialEvidence(attributes)) {
    attributes.push({
      group: "SCE Description Inference",
      name: "Material",
      value: inferredMaterial,
      sourceUrl: detail.effectiveUrl,
      sourceType: "official",
      parser: "sce-description-inference",
      confidence: 0.74
    });
  }
  attributes.push(...deriveSceFamilyAttributes(catalogNumber, attributes, detail.effectiveUrl));

  $("span.product-dimension").each((index, element) => {
    const value = cleanText($(element).text());
    const labels = ["Height", "Width", "Depth"];
    if (value) attributes.push({ group: "Dimensions", name: labels[index] ?? `Dimension ${index + 1}`, value, sourceUrl: detail.effectiveUrl });
  });

  const markerData = extractMarkerData(detail.text, markerRules, detail.effectiveUrl);
  attributes.push(...markerData.attributes);
  documents.push(...filterSceMarkerDocuments(markerData.documents, catalogNumber));

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
    const isFileDownload = /\.(pdf|zip|dwg|dxf|stp|step)(\?|$)/i.test(absolute);
    const isCadDownloadPage = /\/download-doc\/?\?/i.test(absolute) && /(?:part|partnumber)=/i.test(absolute);
    if (!isFileDownload && !isCadDownloadPage) return;
    const label = cleanText($(element).text()) || absolute.split("/").pop() || "Document";
    documents.push({
      type: isCadDownloadPage ? "cad" : classifyDocument(label, absolute),
      label,
      url: absolute,
      sourceUrl: detail.effectiveUrl
    });
  });

  const image = findProductImage($, catalogNumber, detail.effectiveUrl);
  if (image) {
    documents.push({
      type: "image",
      label: image.label,
      url: image.url,
      sourceUrl: detail.effectiveUrl
    });
  }

  if (cad) {
    sources.push({
      url: cad.effectiveUrl,
      sourceType: "official",
      parser: "sce-cad-download-page",
      parserVersion: "sce-v2",
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

  const matched = catalogTextMatches(detail.text, catalogNumber) && !/search yielded 0 results/i.test(detail.text);
  if (!matched) {
    return {
      ...emptyResult("sce", catalogNumber, "SCE product page did not contain the catalog number."),
      sources
    };
  }

  // Every Saginaw attribute came off the official product page. Several sites in this file push
  // attributes without an explicit sourceType (Industry Standards onmouseover, section parsers,
  // dimensions), which then trip the PDT exporter's "unproven" gate and silently drops cells.
  // Stamp the missing provenance here so downstream resolution doesn't have to guess.
  const stampedAttributes = attributes.map((attr) => ({
    ...attr,
    sourceType: attr.sourceType ?? "official",
    parser: attr.parser ?? "sce-product-page",
    confidence: attr.confidence ?? 0.9
  }));
  const cleanAttributes = dedupeAttributes(stampedAttributes);
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
    description: findDescription($, title, cleanAttributes),
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
      return href && catalogTextMatches(text, catalogNumber) ? new URL(href, SCE_BASE).toString() : undefined;
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
    if (!catalogTextMatches(text, catalogNumber)) return;
    const description = cleanText($(element).find(".part-desc p").first().text());
    if (description) attributes.push({ group: "Search Result", name: "Description", value: description, sourceUrl: fetched.effectiveUrl });
    const dimensions = cleanText($(element).find(".product-dimension").map((__, span) => $(span).text()).get().join(" x "));
    if (dimensions) attributes.push({ group: "Search Result", name: "Dimensions", value: dimensions, sourceUrl: fetched.effectiveUrl });
    const standard = cleanText($(element).find("a[href*='industry-standards']").attr("onmouseover") || $(element).find("a[href*='industry-standards']").text());
    if (standard) attributes.push({ group: "Search Result", name: "Industry Standard", value: standard, sourceUrl: fetched.effectiveUrl });
  });
  return attributes;
}

function parseProductSpecificationAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  return $(".prod-specs .prod-info-body")
    .map((_, element) => {
      const label = cleanText($(element).find("strong").first().text());
      const clone = $(element).clone();
      clone.find("strong").remove();
      const value = cleanText(clone.text().replace(/^:/, ""));
      if (!label || !value) return undefined;
      return {
        group: "Product Specifications",
        name: normalizeSceSpecLabel(label),
        value,
        sourceUrl,
        sourceType: "official",
        parser: "sce-product-page",
        confidence: 0.96
      } satisfies AttributeRecord;
    })
    .get()
    .filter(Boolean);
}

function parseDetailSectionAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $(".prod-details-div").each((_, section) => {
    const group = cleanText($(section).children(".prod-info-header").first().text()) || cleanText($(section).find(".prod-info-header").first().text());
    if (!group) return;

    const partAttributes = linkedPartAttributes($, section, group, sourceUrl);
    if (partAttributes.length) {
      attributes.push(...partAttributes);
      return;
    }

    const bodyWrap = $(section).children(".prod-info-body-wrap").first();
    const candidates = bodyWrap.length
      ? bodyWrap.children(".prod-info-body, li, p")
      : $(section).children(".prod-info-body, li, p").not(".prod-info-header");
    candidates.each((__, item) => {
      const text = cleanText($(item).text());
      if (!text || text === group || text.length > 1000 || /also bought|similar part|add to bill/i.test(text)) return;
      const pair = splitNameValue(text);
      if (pair) {
        attributes.push({ group, ...pair, sourceUrl });
        return;
      }
      attributes.push({ group, name: sectionValueName(group), value: text, sourceUrl });
    });
  });
  return attributes;
}

function parseAlternativeAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  return $(".bom-message a[href*='partnumber_info']")
    .map((_, link) => {
      const partNumber = linkedPartNumber($, link);
      if (!partNumber) return undefined;
      const message = cleanText($(link).parent().text()).replace(partNumber, "").replace(/^[-\s]+/, "");
      return {
        group: "Recommended Alternative",
        name: "Alternative Part",
        value: [partNumber, message].filter(Boolean).join(" - "),
        sourceUrl
      } satisfies AttributeRecord;
    })
    .get()
    .filter(Boolean);
}

function linkedPartAttributes($: cheerio.CheerioAPI, section: AnyNode, group: string, sourceUrl: string): AttributeRecord[] {
  return $(section)
    .find(".part-acc a[href*='partnumber_info']")
    .map((_, link) => {
      const partNumber = linkedPartNumber($, link);
      if (!partNumber) return undefined;
      const label = linkedPartLabel($, link);
      const description = cleanLinkedPartDescription(label, partNumber);
      const note = cleanText($(link).siblings(".prod-acc-notes").first().text());
      const value = [partNumber, description].filter(Boolean).join(" - ") + (note ? ` (${note})` : "");
      return {
        group,
        name: linkedPartName(group),
        value,
        sourceUrl
      } satisfies AttributeRecord;
    })
    .get()
    .filter(Boolean);
}

function linkedPartNumber($: cheerio.CheerioAPI, link: AnyNode): string | undefined {
  const href = $(link).attr("href");
  const fromHref = href ? new URL(href, SCE_BASE).searchParams.get("n") : undefined;
  const fromText = linkedPartLabel($, link).match(/\b(?:SCE|P)-[A-Z0-9][A-Z0-9-]*\b/i)?.[0];
  return cleanText(fromHref ?? fromText).toUpperCase() || undefined;
}

function linkedPartLabel($: cheerio.CheerioAPI, link: AnyNode): string {
  const labelNode = $(link).find(".prod-float-link").first();
  const label = (labelNode.length ? labelNode : $(link)).clone();
  label.find("br").replaceWith(" ");
  return cleanText(label.text());
}

function cleanLinkedPartDescription(label: string, partNumber: string): string {
  return cleanText(label.replace(new RegExp(partNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), ""));
}

function normalizeSceSpecLabel(label: string): string {
  if (/ship weight/i.test(label)) return "Weight";
  return label;
}

function findSceDescription(attributes: AttributeRecord[]): string | undefined {
  return attributes
    .filter((attr) => attr.group === "Product Specifications" && /^description$/i.test(attr.name))
    .map((attr) => cleanText(attr.value))
    .find((value) => value && !catalogLike(value));
}

function inferSceDescriptionMaterial(description: string | undefined): string | undefined {
  const text = cleanText(description ?? "");
  if (/\b(?:cleaner|cleaning|paint|label|gasket|filter|bulb)\b/i.test(text)) return undefined;
  if (/\b316(?:\/316L)?\b/i.test(text)) return "stainless steel Type 316/316L";
  if (/\bstainless\s+steel\s+type\s+304\b/i.test(text)) return "stainless steel Type 304";
  if (/\bS\.?\s*S\.?\b|\bstainless\s+steel\b/i.test(text)) return "stainless steel";
  if (/\bGALVANNEALED\b/i.test(text)) return "galvannealed steel";
  if (/\bGALV(?:ANIZED)?\b/i.test(text)) return "galvanized steel";
  if (/\bALUMIN(?:UM|IUM)\b|\b-?AL\b/i.test(text)) return "aluminum";
  if (/\bsub-?panel\b/i.test(text)) return "steel";
  return undefined;
}

function inferSceCatalogVoltage(catalogNumber: string): string | undefined {
  const match = catalogNumber.match(/(\d{2,3})V(AC|DC)?(?=[A-Z]*$|[-_])/i);
  if (!match) return undefined;
  const voltage = Number(match[1]);
  if (!Number.isFinite(voltage) || voltage < 5 || voltage > 600) return undefined;
  const suffix = match[2]?.toUpperCase();
  return cleanText(`${voltage} V${suffix ? ` ${suffix}` : ""}`);
}

function deriveSceElectricalRatingAttributes(attributes: AttributeRecord[], sourceUrl: string): AttributeRecord[] {
  const derived: AttributeRecord[] = [];
  for (const attr of attributes) {
    if (!/\bapplication\b/i.test(`${attr.group ?? ""} ${attr.name}`)) continue;
    const switchCapacity = attr.value.match(/\bswitch capacity\s+(.+?)(?:\.(?:\s|$)|$)/i)?.[1];
    if (switchCapacity) {
      derived.push({
        group: "SCE Electrical Ratings",
        name: "Switch Capacity",
        value: cleanText(switchCapacity),
        sourceUrl,
        sourceType: "official",
        parser: "sce-product-page",
        confidence: 0.9
      });
    }
    const setPointRange = attr.value.match(/\bset point range of\s+(.+?)(?:\s+and\s+(?:is|switch capacity)|[.;]|$)/i)?.[1];
    if (setPointRange) {
      derived.push({
        group: "SCE Thermal Ratings",
        name: "Set Point Range",
        value: cleanText(setPointRange),
        sourceUrl,
        sourceType: "official",
        parser: "sce-product-page",
        confidence: 0.86
      });
    }
  }
  return derived;
}

function deriveSceSpecialtyAttributes(attributes: AttributeRecord[], sourceUrl: string): AttributeRecord[] {
  const derived: AttributeRecord[] = [];
  const push = (group: string, name: string, value: string, confidence = 0.86) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    derived.push({
      group,
      name,
      value: cleaned,
      sourceUrl,
      sourceType: "official",
      parser: "sce-product-page",
      confidence
    });
  };

  for (const attr of attributes) {
    const label = `${attr.group ?? ""} ${attr.name}`;
    const value = cleanText(attr.value);
    if (!value) continue;

    if (/^product specifications$/i.test(attr.group ?? "") && /^cfm$/i.test(attr.name)) {
      push("SCE Thermal Ratings", "Air Flow", /\bcfm\b/i.test(value) ? value : `${value} CFM`, 0.95);
    }
    if (/^product specifications$/i.test(attr.group ?? "") && /^watt$/i.test(attr.name) && /^\d+(?:[.,]\d+)?$/.test(value)) {
      push("SCE Electrical Ratings", "Power", `${value} W`, 0.95);
    }

    if (/\b(product specifications|sce product data)\b/i.test(label) && /\b(description|product type)\b/i.test(label)) {
      for (const match of value.matchAll(/\b(\d+(?:[.,]\d+)?)\s*BTU\s*\/?\s*Hr\.?\b/gi)) {
        push("SCE Thermal Ratings", "Cooling Capacity", `${match[1]} BTU/Hr`, 0.92);
      }
    }

    if (/\b(construction|application|notes?)\b/i.test(label)) {
      const materialComponents = materialComponentPhrases(value);
      if (materialComponents.length >= 2) push("SCE Mechanical Ratings", "Material Components", materialComponents.join("; "));

      const refrigerant = value.match(/\bR\d{3,4}[A-Z]?\s+Refrigerant\b/i)?.[0];
      if (refrigerant) push("SCE Thermal Ratings", "Refrigerant", refrigerant);

      const airVolume = value.match(/\bair volume of\s+(.+?)(?:\.|$)/i)?.[1];
      if (airVolume) push("SCE Thermal Ratings", "Air Flow", airVolume);

      const pressureRange = value.match(/\b\d+(?:[.,]\d+)?\s*(?:to|-|\.{2,3})\s*\d+(?:[.,]\d+)?\s*PSI\b(?:\s+Gage)?/i)?.[0];
      if (pressureRange) push("SCE Mechanical Ratings", "Pressure Range", pressureRange);

      const filterRating = value.match(/\b\d+(?:[.,]\d+)?\s*(?:um|µm|micron)\s+filter\b/i)?.[0];
      if (filterRating) push("SCE Mechanical Ratings", "Filter Rating", filterRating);

      const threadSize = value.match(/\b\d+(?:\/\d+)?\s*inch\s+NPT\b/i)?.[0];
      if (threadSize) push("SCE Mechanical Ratings", "Thread Size", threadSize);

      const coolingSetpoint = value.match(/\bcontroller\s+preset\s+(.+?\bto cool\b\s*-?\s*adjustable\s+.+?)(?:\.|$)/i)?.[1];
      if (coolingSetpoint) push("SCE Thermal Ratings", "Controller Cooling Setpoint", coolingSetpoint);

      const heatingSetpoint = value.match(/\bpreset\s+at\s+(.+?\bto heat\b\s*-?\s*adjustable\s+.+?)(?:\.|$)/i)?.[1];
      if (heatingSetpoint) push("SCE Thermal Ratings", "Controller Heating Setpoint", heatingSetpoint);

      const temperatureUnit = String.raw`(?:\u00b0|\u00c2\u00b0|deg(?:rees?)?)?\s*[FC]`;
      const preciseHysteresis = value.match(new RegExp(String.raw`\btemperature differential hysteresis\s+(-?\d+(?:[.,]\d+)?\s*${temperatureUnit})`, "i"))?.[1];
      if (preciseHysteresis) push("SCE Thermal Ratings", "Temperature Hysteresis", preciseHysteresis);

      const hysteresis = value.match(/\btemperature differential hysteresis\s+(\d+(?:[.,]\d+)?(?:\s*(?:Â?°|deg(?:rees?)?)\s*[FC])?)/i)?.[1];
      if (hysteresis && !preciseHysteresis) push("SCE Thermal Ratings", "Temperature Hysteresis", hysteresis);

      const highTempAlarm = value.match(/\bhigh temp(?:erature)? alarm\s+[^.]+/i)?.[0];
      if (highTempAlarm) push("SCE Thermal Ratings", "High Temperature Alarm", highTempAlarm.replace(/^high temp(?:erature)? alarm\s*/i, ""));

      const operatingRange = value.match(/\boperating temperature range\s+(?:from\s+)?[^.]+/i)?.[0];
      if (operatingRange) push("SCE Thermal Ratings", "Operating Temperature Range", operatingRange.replace(/^operating temperature range\s+(?:from\s+)?/i, ""));
    }
  }

  return dedupeAttributes(derived);
}

function materialComponentPhrases(value: string): string[] {
  const components: string[] = [];
  const materialPattern =
    /\b((?:washable|removable|clear|frosted|protective|external|quick release|oil-resistant|single phase|brushed|powder coated|painted|light gray|gray|white|black)\s+)*(stainless steel|carbon steel|aluzinc coated steel|galvannealed steel|galvanized steel|aluminum|aluminium|polycarbonate|fiberglass|techpolymer|pvc|steel)\s+([a-z][a-z0-9/&().\s-]{2,45}?)(?=,|\band\b|\.|;|$)/gi;
  for (const match of value.matchAll(materialPattern)) {
    const material = cleanText(match[2]);
    const component = cleanText(match[3]).replace(/\s+(?:included|provided|installed|furnished|ships loose)$/i, "");
    if (!material || !component) continue;
    if (/^(?:and|or|with|for|from|over|type|cover ral|light gray)$/i.test(component)) continue;
    components.push(cleanText(`${material} ${component}`));
  }
  return [...new Set(components)].slice(0, 8);
}

function deriveSceFamilyAttributes(
  _catalogNumber: string,
  _existing: AttributeRecord[],
  _sourceUrl: string
): AttributeRecord[] {
  return [];
}

interface SceProseFact {
  scope: "default" | "galv";
  field: "Material" | "Finish";
  value: string;
  confidence: number;
}

function deriveSceProseAttributes(catalogNumber: string, attributes: AttributeRecord[], sourceUrl: string): AttributeRecord[] {
  const derived: AttributeRecord[] = [];
  const isGalvCatalog = /\bGALV\b|GALV$/i.test(catalogNumber);
  for (const attr of attributes) {
    if (!/\b(?:application|construction|finish|product specifications|sce product data)\b/i.test(`${attr.group ?? ""} ${attr.name}`)) continue;
    for (const fact of sceProseFacts(attr.value, attr.group)) {
      if (fact.scope === "galv" && !isGalvCatalog) continue;
      derived.push({
        group: fact.scope === "galv" ? "SCE Catalog Variant" : "SCE Prose Understanding",
        name: fact.field,
        value: fact.value,
        sourceUrl,
        sourceType: "official",
        parser: "sce-product-page",
        confidence: fact.confidence
      });
    }
  }
  return dedupeAttributes(derived);
}

function sceProseFacts(value: string, group: string | undefined): SceProseFact[] {
  const facts: SceProseFact[] = [];
  for (const sentence of splitSceProse(value)) {
    const scope: SceProseFact["scope"] = /\bGALV\b/i.test(sentence) ? "galv" : "default";
    const material = sceMaterialFromSentence(sentence, group);
    if (material) facts.push({ scope, field: "Material", value: material, confidence: scope === "galv" ? 0.94 : 0.91 });

    const finish = sceFinishFromSentence(sentence);
    if (finish) facts.push({ scope, field: "Finish", value: finish, confidence: scope === "galv" ? 0.92 : 0.9 });
  }
  return facts;
}

function splitSceProse(value: string): string[] {
  return cleanText(value)
    .split(/(?<=[.!?])\s+|;\s+/)
    .map((part) => cleanText(part.replace(/[.!?]+$/g, "")))
    .filter(Boolean);
}

function sceMaterialFromSentence(sentence: string, group: string | undefined): string | undefined {
  const madeOf = sentence.match(/\b(?:made|constructed|fabricated)\s+(?:of|from)\s+(.+?)(?:,|$)/i)?.[1];
  if (madeOf) return normalizeSceMaterialPhrase(madeOf);
  if (/\b(?:construction|material)\b/i.test(group ?? "") && sentence.length <= 120 && !isSceSecondaryComponentSentence(sentence)) {
    return normalizeSceMaterialPhrase(sentence);
  }
  return undefined;
}

function sceFinishFromSentence(sentence: string): string | undefined {
  if (/\bGALV\b/i.test(sentence) && /\bgalvanized\b/i.test(sentence)) return "galvanized";
  const powderCoated = sentence.match(/\bpowder[-\s]?coated\s+(?:ANSI[-\s]?61\s+gr[ae]y|RAL\s*\d{4}|white|black|gr[ae]y|red|blue|green|yellow|orange|silver|natural)\b/i)?.[0];
  if (powderCoated) return cleanText(powderCoated);
  const ansiPowder = sentence.match(/\bANSI[-\s]?61\s+gr[ae]y\s+powder\s+coating(?:\s+inside\s+and\s+out)?\b/i)?.[0];
  if (ansiPowder) return cleanText(ansiPowder);
  return undefined;
}

function normalizeSceMaterialPhrase(value: string): string | undefined {
  const cleaned = cleanText(value)
    .replace(/\band\s+(?:powder[-\s]?coated|painted|finished|coated)\b.*$/i, "")
    .replace(/\b(?:heavy\s+gauge|washable|removable|clear|frosted|protective|external)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || isSceSecondaryComponentSentence(cleaned)) return undefined;
  if (/\bstainless\s+steel\s+type\s+316\/316L\b/i.test(cleaned)) return "stainless steel Type 316/316L";
  if (/\bstainless\s+steel\s+type\s+304\b/i.test(cleaned)) return "stainless steel Type 304";
  if (/\bgalvanized\s+steel\b/i.test(cleaned)) return "galvanized steel";
  if (/\bgalvannealed\s+steel\b/i.test(cleaned)) return "galvannealed steel";
  if (/\baluzinc\s+coated\s+steel\b/i.test(cleaned)) return "aluzinc coated steel";
  if (/\bcarbon\s+steel\b/i.test(cleaned)) return "carbon steel";
  if (/\bstainless\s+steel\b/i.test(cleaned)) return "stainless steel";
  if (/\bpolycarbonate\b/i.test(cleaned)) return "polycarbonate";
  if (/\btechpolymer\b/i.test(cleaned)) return "Techpolymer";
  if (/\balumin(?:um|ium)\b/i.test(cleaned)) return "aluminum";
  if (/\bsteel\b/i.test(cleaned)) return "steel";
  return undefined;
}

function isSceSecondaryComponentSentence(value: string): boolean {
  return /\b(?:screws?|washers?|hardware|fasteners?|filters?|grille|ports?|gaskets?|hinges?|latches?|lead wire|wire|cable|cord|connector)\b/i.test(value);
}

function deriveSceCertificationAttributes(attributes: AttributeRecord[], sourceUrl: string): AttributeRecord[] {
  const derived: AttributeRecord[] = [];
  for (const attr of attributes) {
    if (!/\bnotes?\b/i.test(`${attr.group ?? ""} ${attr.name}`)) continue;
    const value = cleanText(attr.value);
    const matches = [
      ...value.matchAll(/\bcULus\s+File\s+Component\s+Recognized\s+[A-Z0-9-]+/gi),
      ...value.matchAll(/\bcULus\s+Listed\s+[A-Z0-9-]+/gi),
      ...value.matchAll(/\bUL\s+File\s+[A-Z0-9-]+/gi),
      ...value.matchAll(/\bCSA\s+File\s+[A-Z0-9-]+/gi)
    ];
    for (const match of matches) {
      derived.push({
        group: "SCE Certification Details",
        name: "Certification Detail",
        value: cleanText(match[0]),
        sourceUrl,
        sourceType: "official",
        parser: "sce-product-page",
        confidence: 0.92
      });
    }
  }
  return dedupeAttributes(derived);
}

function hasExplicitSceVoltageEvidence(attributes: AttributeRecord[]): boolean {
  return attributes.some((attr) => {
    if (/^sce catalog inference$/i.test(attr.group ?? "")) return false;
    const label = `${attr.group ?? ""} ${attr.name}`;
    const value = cleanText(attr.value);
    if (/\bvolts?\b/i.test(label) && /^\d+(?:[.,]\d+)?$/.test(value)) return true;
    if (/\b(?:voltage|volts?|input power|power input|supply)\b/i.test(label) && /\b(?:vac|vdc|v\s*(?:ac|dc)?|volts?)\b/i.test(value)) return true;
    if (/\b(product specifications|sce product data)\b/i.test(label) && /\b(description|product type|product name)\b/i.test(label)) {
      return /\b(?:vac|vdc|\d+(?:[.,]\d+)?\s*(?:v(?:ac|dc)?|volts?))\b/i.test(value);
    }
    return false;
  });
}

function hasExplicitSceMaterialEvidence(attributes: AttributeRecord[]): boolean {
  return attributes.some((attr) => {
    if (/^sce catalog inference$/i.test(attr.group ?? "")) return false;
    if (/^product specifications$/i.test(attr.group ?? "") && /^description$/i.test(attr.name)) return false;
    if (/^sce product data$/i.test(attr.group ?? "") && /^product type$/i.test(attr.name)) return false;
    if (!/\b(?:construction|application|finish|material|product specifications)\b/i.test(`${attr.group ?? ""} ${attr.name}`)) return false;
    if (/\b(?:screws?|washers?|hardware|fasteners?)\b/i.test(attr.value)) return false;
    return /\b(?:stainless steel|carbon steel|mild steel|galvannealed steel|galvanized steel|aluminum|aluminium|polycarbonate|fiberglass|plastic|steel type|S\.?\s*S\.?)\b/i.test(attr.value);
  });
}

function sectionValueName(group: string): string {
  if (/construction/i.test(group)) return "Construction Detail";
  if (/application/i.test(group)) return "Application";
  if (/finish/i.test(group)) return "Finish";
  if (/industry standards/i.test(group)) return "Standard";
  if (/notes?/i.test(group)) return "Note";
  if (/installation/i.test(group)) return "Manual";
  return "Detail";
}

function linkedPartName(group: string): string {
  if (/included/i.test(group)) return "Included Accessory";
  if (/optional/i.test(group)) return "Optional Accessory";
  if (/similar/i.test(group)) return "Similar Part";
  if (/purchased|bought|related/i.test(group)) return "Related Purchase";
  return "Linked Part";
}

function findDescription($: cheerio.CheerioAPI, title: string, attributes: AttributeRecord[]): string | undefined {
  const candidates = [
    cleanText($(".part-desc").first().text()),
    cleanText($(".prod-desc").first().text()),
    cleanText($("meta[name='description']").attr("content")),
    ...attributes
      .filter((attr) => /description/i.test(`${attr.group ?? ""} ${attr.name}`))
      .map((attr) => cleanText(attr.value))
  ].filter(Boolean);
  return candidates.find((candidate) => candidate !== title && candidate !== "Description" && !catalogLike(candidate));
}

function findProductImage($: cheerio.CheerioAPI, catalogNumber: string, baseUrl: string): { url: string; label: string } | undefined {
  const part = catalogNumber.toLowerCase();
  const candidates = $("img[src]")
    .map((_, element) => {
      const src = $(element).attr("src");
      const alt = cleanText($(element).attr("alt"));
      if (!src) return undefined;
      const haystack = `${src} ${alt}`.toLowerCase();
      if (!haystack.includes(part)) return undefined;
      return {
        url: new URL(src, baseUrl).toString(),
        label: alt && alt.toLowerCase().includes(part) ? `Product image - ${alt}` : `Product image - ${catalogNumber}`
      };
    })
    .get()
    .filter(Boolean);
  return candidates[0];
}

function filterSceMarkerDocuments(documents: DocumentRecord[], catalogNumber: string): DocumentRecord[] {
  const part = catalogNumber.toLowerCase();
  return documents.filter((doc) => {
    if (doc.type !== "image") return true;
    return doc.url.toLowerCase().includes(part);
  });
}

function catalogLike(value: string): boolean {
  return /^(?:SCE|P)-[A-Z0-9][A-Z0-9-]*$/i.test(value);
}
