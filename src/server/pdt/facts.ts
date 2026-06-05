import type { AttributeRecord, ManufacturerConfig, ProductResult, RunItemRecord, SourceRecord } from "../../shared/types.js";
import type { PdtRepair } from "./ai-cleanup.js";
import { pdtProductUrlRule } from "./rules.js";

export type PdtFactSourceKind = "attribute" | "document" | "normalized" | "generated-rule" | "repair";

export interface PdtFact {
  key: string;
  value: string;
  sourceKind: PdtFactSourceKind;
  sourceUrl?: string;
  sourceType?: SourceRecord["sourceType"];
  parser?: string;
  stage?: string;
  confidence: number;
  ruleName?: string;
  reason: string;
}

export interface PdtFactIndex {
  facts: PdtFact[];
  byKey: Map<string, PdtFact[]>;
}

export interface PdtFactInput {
  item: RunItemRecord;
  manufacturer: ManufacturerConfig;
  deviceType?: string;
  repair?: PdtRepair;
}

export function buildPdtFactIndex(input: PdtFactInput): PdtFactIndex {
  const result = input.item.result;
  const facts: PdtFact[] = [];

  addGenerated(facts, "articleNumber", input.item.catalogNumber, "catalog-number", "Catalog number from the uploaded input row.");
  addGenerated(facts, "manufacturerName", input.manufacturer.canonicalName, "manufacturer-config", "Manufacturer name from the selected manufacturer config.");
  addGenerated(facts, "manufacturerUrl", manufacturerUrl(input.manufacturer), "manufacturer-config", "Manufacturer homepage from the selected manufacturer config.");
  addGenerated(facts, "deviceType", input.deviceType, "device-classifier", "Device type classified from scraped product evidence.");

  if (!result) return indexFacts(facts);

  const pdtUrlRule = pdtProductUrlRule({
    manufacturerId: result.manufacturerId ?? input.manufacturer.id,
    catalogNumber: input.item.catalogNumber
  });
  addGenerated(
    facts,
    "productUrl",
    pdtUrlRule?.value ?? result.productUrl,
    pdtUrlRule?.name ?? "product-url",
    pdtUrlRule?.rationale ?? "Product URL selected by the scraper after identity checks."
  );
  addGenerated(facts, "localizedProductUrlEn", result.localizedUrls?.en, "localized-product-url", "English product URL selected by the scraper.");
  addGenerated(facts, "localizedProductUrlDe", result.localizedUrls?.de, "localized-product-url", "German product URL selected by the scraper.");
  addGenerated(facts, "shortDescription", safeDescription(result.title, input.item.catalogNumber), "product-title", "Product title selected by the scraper.");
  addGenerated(facts, "longDescription", result.description, "product-description", "Product description selected by the scraper.");
  addGenerated(facts, "localizedShortDescriptionDe", result.localizedDescriptions?.de?.title, "localized-product-title", "German product title scraped from localized page.");
  addGenerated(facts, "localizedLongDescriptionDe", result.localizedDescriptions?.de?.description, "localized-product-description", "German product description scraped from localized page.");

  addNormalized(facts, result, "weight", result.normalized.weight);
  addNormalized(facts, result, "dimensions", result.normalized.dimensions);
  addNormalized(facts, result, "material", result.normalized.material);
  addNormalized(facts, result, "finish", result.normalized.finish);
  addNormalized(facts, result, "color", result.normalized.color);
  addNormalized(facts, result, "ratedVoltage", result.normalized.voltage);
  addNormalized(facts, result, "ratedCurrent", result.normalized.current);
  addNormalized(facts, result, "protection", result.normalized.protection);
  addNormalized(facts, result, "certificates", result.normalized.certificates);

  // Customer-document attributes are authoritative — when one clearly looks like voltage
  // or current and the normalizer didn't pick it up (often because of a column-style label
  // with the unit in parens), promote it directly so the PDT cell still gets written.
  addCustomerDocFact(facts, result, "ratedVoltage", /\b(voltage|volt|spannung|u_?e|u_?n)\b/i, "V");
  addCustomerDocFact(facts, result, "ratedCurrent", /\b(current|amp(?:ere)?s?|strom|i_?e|i_?n|rated\s*current)\b/i, "A");

  addAttributeFact(facts, result, "eanOrGtin", /\b(ean|gtin)\b/i);
  addAttributeFact(facts, result, "customsTariff", /\b(customs tariff|tariff code|tariff|hs code|commodity code|cn ?8|cn code|combined nomenclature)\b/i);
  addAttributeFact(facts, result, "typeCode", /\b(type code|typecode|model code|modellcode|extended product type|type designation|product main type|main type|catalog(?:ue)? type|order type)\b/i);
  addAttributeFact(facts, result, "productFamily", /\b(product family|product range|series|family)\b/i);
  addAttributeFact(facts, result, "productDesignation", /\b(product designation|manufacturer.*designation|product type|article designation)\b/i);
  addEclassFacts(facts, result);

  // Cabinet / enclosure ECLASS fallback: scrapers like Saginaw don't publish ECLASS codes,
  // so the REFERENCE_FEATURE_GROUP_ID / SYSTEM_NAME columns stay blank. When the device type
  // is clearly an enclosure (and nothing else has filled the eclass facts), pin the canonical
  // ECLASS 13 class for enclosures (27-18-01-01).
  if (isCabinetDeviceType(input.deviceType) && !facts.some((fact) => fact.key === "eclassCode")) {
    addGenerated(
      facts,
      "eclassCode",
      "27180101",
      "cabinet-eclass-default",
      "Default ECLASS class 27180101 applied for cabinet/enclosure device type."
    );
    addGenerated(
      facts,
      "eclassSystemVersion",
      "13",
      "cabinet-eclass-default",
      "Default ECLASS version 13 paired with the cabinet/enclosure class."
    );
  }

  addRepair(facts, "eclassCode", input.repair?.eclassCode, "pdt-repair", "Deterministic PDT cleanup produced an ECLASS code from scraped evidence.");
  addRepair(facts, "eclassSystemVersion", input.repair?.eclassSystemVersion, "pdt-repair", "Deterministic PDT cleanup produced an ECLASS system version.");
  addRepair(facts, "ratedVoltage", input.repair?.controlVoltage ?? input.repair?.voltageMax, "pdt-repair", "Deterministic PDT cleanup produced a voltage value.");
  addRepair(facts, "ratedCurrent", input.repair?.ratedCurrent ?? input.repair?.currentMax, "pdt-repair", "Deterministic PDT cleanup produced a current value.");
  addRepair(facts, "powerLossPerPole", input.repair?.powerLossPerPole, "pdt-repair", "Deterministic PDT cleanup produced a power-loss value.");
  addRepair(facts, "voltageType", input.repair?.voltageType, "pdt-repair", "Deterministic PDT cleanup produced a voltage type.");
  addRepair(facts, "shortDescription", input.repair?.shortDescription, "pdt-repair", "Deterministic PDT cleanup produced a short description.");
  addRepair(facts, "longDescription", input.repair?.longDescription, "pdt-repair", "Deterministic PDT cleanup produced a long description.");

  return indexFacts(dedupeFacts(facts));
}

export function bestFact(index: PdtFactIndex | undefined, key: string): PdtFact | undefined {
  return index?.byKey.get(key)?.[0];
}

export function factsMatchingValue(index: PdtFactIndex | undefined, value: string): PdtFact[] {
  const comparable = comparableValue(value);
  if (!comparable) return [];
  return (index?.facts ?? []).filter((fact) => {
    const factValue = comparableValue(fact.value);
    return Boolean(factValue && (factValue === comparable || factValue.includes(comparable) || comparable.includes(factValue)));
  });
}

function addGenerated(facts: PdtFact[], key: string, value: string | undefined, ruleName: string, reason: string): void {
  const cleanValue = clean(value);
  if (!cleanValue) return;
  facts.push({ key, value: cleanValue, sourceKind: "generated-rule", confidence: 0.99, ruleName, reason });
}

function addRepair(facts: PdtFact[], key: string, value: string | undefined, ruleName: string, reason: string): void {
  const cleanValue = clean(value);
  if (!cleanValue) return;
  facts.push({ key, value: cleanValue, sourceKind: "repair", confidence: 0.78, ruleName, reason });
}

function addNormalized(facts: PdtFact[], result: ProductResult, key: string, value: string | undefined): void {
  const cleanValue = clean(value);
  if (!cleanValue) return;
  const source = sourceForNormalizedValue(result, key, cleanValue);
  if (!source) return;
  facts.push({
    key,
    value: cleanValue,
    sourceKind: "normalized",
    sourceUrl: source?.sourceUrl,
    sourceType: source?.sourceType,
    parser: source?.parser,
    stage: "normalize",
    confidence: result.confidence || 0.72,
    reason: `Normalized ${key} derived from scraped attributes or documents.`
  });
}

function addAttributeFact(facts: PdtFact[], result: ProductResult, key: string, pattern: RegExp): void {
  const attr = bestAttribute(result.attributes, pattern);
  if (!attr) return;
  facts.push(factFromAttribute(key, attr, `Attribute "${attr.name}" matched canonical PDT fact ${key}.`));
}

/**
 * Promote a clearly-labeled customer-document attribute (e.g. column header "Rated current
 * (A)" with bare value "16") into a PDT fact so the cell gets written even if the
 * normalizer didn't pick the value up. Adds the unit when the label declared one and the
 * value didn't already include it — necessary for PDT validators that expect "16 A".
 */
function addCustomerDocFact(facts: PdtFact[], result: ProductResult, key: string, labelPattern: RegExp, unitHint: "V" | "A"): void {
  const matches = result.attributes
    .filter((attr) => attr.parser === "customer-document")
    .filter((attr) => labelPattern.test(`${attr.group ?? ""} ${attr.name ?? ""}`))
    .filter((attr) => clean(attr.value));
  if (matches.length === 0) return;
  matches.sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0));
  const attr = matches[0];
  const raw = clean(attr.value) ?? attr.value;
  const valueWithUnit = ensureUnit(raw, unitHint, `${attr.name ?? ""} ${attr.unit ?? ""}`);
  facts.push(factFromAttribute(key, { ...attr, value: valueWithUnit }, `Customer-document attribute "${attr.name}" promoted to PDT fact ${key}.`));
}

function ensureUnit(value: string, unit: "V" | "A", labelHint: string): string {
  const unitRx = new RegExp(String.raw`\b${unit}\b|\b${unit === "V" ? "volts?" : "amp(?:ere)?s?"}\b`, "i");
  if (unitRx.test(value)) return value;
  if (!/-?\d/.test(value)) return value; // no number → leave unchanged
  // Only append the unit when the label clearly declared it, so we don't accidentally
  // mark "Article number 16" as 16 amperes.
  const labelDeclaresUnit = new RegExp(String.raw`[\(\[\{\s/]${unit}[\)\]\}\s/]|\b${unit === "V" ? "volts?|voltage|spannung" : "amp(?:ere)?s?|current|strom"}\b`, "i");
  if (!labelDeclaresUnit.test(` ${labelHint} `)) return value;
  return `${value.trim()} ${unit}`;
}

function isCabinetDeviceType(deviceType: string | undefined): boolean {
  if (!deviceType) return false;
  return /\b(cabinet|enclosure|housing|geh[aä]use|schaltschrank|ormar)\b/i.test(deviceType);
}

function addEclassFacts(facts: PdtFact[], result: ProductResult): void {
  const attr = bestAttribute(result.attributes, /^eclass\b/i);
  if (!attr) return;
  const code = attr.value.match(/\d{2}(?:[-.]?\d{2}){1,3}/)?.[0] ?? clean(attr.value);
  if (code) facts.push(factFromAttribute("eclassCode", { ...attr, value: code }, `ECLASS code extracted from "${attr.name}".`));
  const version = attr.name.match(/\d+(?:\.\d+)+|\d+/)?.[0];
  if (version) facts.push(factFromAttribute("eclassSystemVersion", { ...attr, value: `ECLASS-${version}` }, `ECLASS system/version extracted from "${attr.name}".`));
}

function sourceForNormalizedValue(result: ProductResult, key: string, value: string): AttributeRecord | undefined {
  return result.attributes.find(
    (attr) => labelLooksLikeFact(`${attr.group ?? ""} ${attr.name}`, key) && normalizedValueCanComeFromAttribute(key, value, attr)
  );
}

function normalizedValueCanComeFromAttribute(key: string, normalizedValue: string, attr: AttributeRecord): boolean {
  const rawValue = clean(attr.value);
  if (!rawValue) return false;
  if (comparableValue(rawValue) === comparableValue(normalizedValue)) return true;
  if (comparableValue(rawValue).includes(comparableValue(normalizedValue))) return true;
  if (comparableValue(normalizedValue).includes(comparableValue(rawValue))) return true;

  if (key === "weight") return sameWeight(rawValue, normalizedValue);
  if (key === "dimensions") return sameLengthNumber(rawValue, normalizedValue);
  // Tabular customer sources often label the column "Rated current (A)" and put just "16"
  // in the cell. The unit isn't in the value but it IS in the attribute label, so fall back
  // to a unit-aware match where the label is allowed to supply the unit. Without this, every
  // PDT cell sourced from those rows is dropped as "no matching attribute".
  const attrLabel = `${attr.group ?? ""} ${attr.name ?? ""} ${attr.unit ?? ""}`;
  if (key === "ratedVoltage") return sameUnitNumber(rawValue, normalizedValue, "V", attrLabel);
  if (key === "ratedCurrent") return sameUnitNumber(rawValue, normalizedValue, "A", attrLabel);
  return false;
}

function sameUnitNumber(left: string, right: string, unit: "A" | "V", labelHint?: string): boolean {
  const leftNumbers = unitNumbers(left, unit, labelHint);
  const rightNumbers = unitNumbers(right, unit, labelHint);
  if (!leftNumbers.length || !rightNumbers.length) return false;
  return leftNumbers.some((leftNumber) => rightNumbers.some((rightNumber) => nearlyEqual(leftNumber, rightNumber)));
}

function sameWeight(left: string, right: string): boolean {
  const leftKg = firstWeightKg(left);
  const rightKg = firstWeightKg(right);
  return leftKg !== undefined && rightKg !== undefined && nearlyEqual(leftKg, rightKg, 0.01);
}

function sameLengthNumber(left: string, right: string): boolean {
  const leftMm = firstLengthMm(left);
  const rightMm = firstLengthMm(right);
  return leftMm !== undefined && rightMm !== undefined && nearlyEqual(leftMm, rightMm, 0.5);
}

function unitNumbers(value: string, unit: "A" | "V", labelHint?: string): number[] {
  const rx = new RegExp(String.raw`(-?\d+(?:[,.]\d+)?)\s*${unit}\b`, "gi");
  const matches = [...value.matchAll(rx)].map((match) => Number(match[1].replace(",", "."))).filter(Number.isFinite);
  if (matches.length > 0) return matches;
  // Label-supplied unit: when a column header says "(A)" or "Rated current [A]" the bare
  // numeric value in the cell should still count as amperes. Limit to the unit pattern in
  // parens/brackets or as a standalone word so we don't accept random "A" letters from
  // labels like "Article number".
  if (!labelHint) return [];
  const labelRx = new RegExp(String.raw`[\(\[\{\s/]${unit}[\)\]\}\s/]|\b${unit === "A" ? "amp(?:ere)?s?" : "volts?"}\b`, "i");
  if (!labelRx.test(` ${labelHint} `)) return [];
  const bareNumbers = [...value.matchAll(/(-?\d+(?:[,.]\d+)?)/g)]
    .map((match) => Number(match[1].replace(",", ".")))
    .filter(Number.isFinite);
  return bareNumbers;
}

function firstWeightKg(value: string): number | undefined {
  const match = value.match(/(-?\d+(?:[,.]\d+)?)\s*(kg|g|lb|lbs|oz)\b/i);
  if (!match) return undefined;
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2].toLowerCase();
  if (unit === "kg") return amount;
  if (unit === "g") return amount / 1000;
  if (unit === "lb" || unit === "lbs") return amount * 0.453592;
  if (unit === "oz") return amount * 0.0283495;
  return undefined;
}

function firstLengthMm(value: string): number | undefined {
  const quoted = value.match(/(-?\d+(?:[,.]\d+)?)\s*"/);
  if (quoted) {
    const amount = Number(quoted[1].replace(",", "."));
    return Number.isFinite(amount) ? amount * 25.4 : undefined;
  }
  const match = value.match(/(-?\d+(?:[,.]\d+)?)\s*(mm|cm|m|in|inch|inches|ft|feet|foot)\b/i);
  if (!match) return undefined;
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2].toLowerCase();
  if (unit === "mm") return amount;
  if (unit === "cm") return amount * 10;
  if (unit === "m") return amount * 1000;
  if (unit === "in" || unit === "inch" || unit === "inches") return amount * 25.4;
  if (unit === "ft" || unit === "feet" || unit === "foot") return amount * 304.8;
  return undefined;
}

function nearlyEqual(left: number, right: number, tolerance = 0.001): boolean {
  return Math.abs(left - right) <= tolerance;
}

function bestAttribute(attributes: AttributeRecord[], pattern: RegExp): AttributeRecord | undefined {
  const matches = attributes.filter((attr) => pattern.test(`${attr.group ?? ""} ${attr.name}`) && clean(attr.value));
  matches.sort((left, right) => sourceRank(right.sourceType) - sourceRank(left.sourceType) || (right.confidence ?? 0) - (left.confidence ?? 0));
  return matches[0];
}

function factFromAttribute(key: string, attr: AttributeRecord, reason: string): PdtFact {
  return {
    key,
    value: clean(attr.value) ?? attr.value,
    sourceKind: "attribute",
    sourceUrl: attr.sourceUrl,
    sourceType: attr.sourceType,
    parser: attr.parser,
    stage: attr.stage,
    confidence: attr.confidence ?? (attr.sourceType === "official" ? 0.9 : attr.sourceType === "official-fallback" ? 0.78 : attr.sourceType === "distributor" ? 0.45 : 0.65),
    reason
  };
}

function labelLooksLikeFact(label: string, key: string): boolean {
  const text = label.toLowerCase();
  if (key === "weight") return /\b(weight|mass|gewicht)\b/.test(text);
  if (key === "dimensions") return /\b(dimension|height|width|depth|length|size)\b/.test(text);
  if (key === "material") return /\b(material|housing|body|enclosure)\b/.test(text);
  if (key === "ratedVoltage") return /\b(voltage|spannung|volt)\b/.test(text);
  if (key === "ratedCurrent") return /\b(current|amp|strom)\b/.test(text);
  if (key === "color") return /\b(colou?r|farbe)\b/.test(text);
  if (key === "certificates") return /\b(cert|approval|standard|conformity)\b/.test(text);
  return false;
}

function manufacturerUrl(manufacturer: ManufacturerConfig): string | undefined {
  if (manufacturer.homepageUrl) return manufacturer.homepageUrl;
  const base = manufacturer.officialBaseUrls?.[0];
  if (!base) return undefined;
  try {
    return new URL(base).origin;
  } catch {
    return base;
  }
}

function safeDescription(value: string | undefined, catalogNumber: string): string | undefined {
  const cleaned = clean(value);
  if (!cleaned) return undefined;
  return comparableValue(cleaned) === comparableValue(catalogNumber) ? undefined : cleaned;
}

function indexFacts(facts: PdtFact[]): PdtFactIndex {
  const byKey = new Map<string, PdtFact[]>();
  for (const fact of facts) {
    const values = byKey.get(fact.key) ?? [];
    values.push(fact);
    byKey.set(fact.key, values);
  }
  for (const values of byKey.values()) values.sort((left, right) => factRank(right) - factRank(left));
  return { facts: [...facts].sort((left, right) => factRank(right) - factRank(left)), byKey };
}

function dedupeFacts(facts: PdtFact[]): PdtFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.key}|${comparableValue(fact.value)}|${fact.sourceKind}|${fact.sourceUrl ?? ""}|${fact.ruleName ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function factRank(fact: PdtFact): number {
  const kind = fact.sourceKind === "attribute" ? 40 : fact.sourceKind === "normalized" ? 34 : fact.sourceKind === "document" ? 32 : fact.sourceKind === "repair" ? 28 : 20;
  return kind + sourceRank(fact.sourceType) * 10 + fact.confidence;
}

function sourceRank(sourceType: SourceRecord["sourceType"] | undefined): number {
  if (sourceType === "official") return 4;
  if (sourceType === "official-fallback") return 3;
  if (sourceType === "generated") return 2;
  if (sourceType === "cache") return 1;
  if (sourceType === "distributor") return -2;
  return 0;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

function comparableValue(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
