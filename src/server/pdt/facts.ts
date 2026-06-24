import type { AttributeRecord, DocumentRecord, ManufacturerConfig, ProductResult, RunItemRecord, SourceRecord } from "../../shared/types.js";
import { getManufacturerConfig } from "../config/manufacturers.js";
import { matchProperty, understand } from "../scrapers/ontology.js";
import { normalizeFields } from "../scrapers/normalizer.js";
import type { PdtRepair } from "./ai-cleanup.js";
import { compactFamilyShortDescription } from "./description-formatting.js";
import { isSignalDeviceType, soleEclassDefaultForDeviceType } from "./device-type-profiles.js";
import { pdtProductUrlRule } from "./rules.js";
import { splitTemperatureRange } from "./unit-cleanup.js";

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

export const PDT_ONTOLOGY_FACT_KEYS: Record<string, string[]> = {
  controlVoltage: ["ratedVoltage"],
  ratedVoltage: ["ratedVoltage"],
  ratedCurrent: ["ratedCurrent"],
  breakingCapacity: ["breakingCapacity"],
  insulationVoltage: ["insulationVoltage"],
  impulseVoltage: ["impulseVoltage"],
  voltageDrop: ["voltageDrop"],
  leakageCurrent: ["leakageCurrent"],
  operatingTemperature: ["operatingTemperature", "operatingTemperatureMin", "operatingTemperatureMax"],
  storageTemperature: ["storageTemperature", "storageTemperatureMin", "storageTemperatureMax"],
  wallThickness: ["wallThickness"],
  sensingDistance: ["sensingDistance"],
  altitude: ["altitude"],
  strippingLength: ["strippingLength"],
  stroke: ["stroke"],
  bore: ["bore"],
  orificeSize: ["orificeSize"],
  blindZone: ["blindZone"],
  weight: ["weight"],
  width: ["dimensions"],
  height: ["dimensions"],
  depth: ["dimensions"],
  diameter: ["dimensions"],
  flowRate: ["flowRate"],
  pressure: ["pressure"],
  frequency: ["frequency"],
  switchingFrequency: ["switchingFrequency"],
  torque: ["torque"],
  power: ["power"],
  powerLoss: ["powerLoss"],
  powerConsumption: ["powerConsumption"],
  coilPower: ["powerConsumption"],
  coolingOutput: ["coolingOutput"],
  heatingCapacity: ["heatingCapacity"],
  material: ["material"],
  color: ["color"],
  finish: ["finish"],
  protection: ["protection"],
  typeCode: ["typeCode"],
  ean: ["eanOrGtin"]
};

export const PDT_ONTOLOGY_QUANTITY_FACT_KEYS: Record<string, string> = {
  breakingCapacity: "breakingCapacity",
  insulationVoltage: "insulationVoltage",
  impulseVoltage: "impulseVoltage",
  voltageDrop: "voltageDrop",
  leakageCurrent: "leakageCurrent",
  operatingTemperature: "operatingTemperature",
  storageTemperature: "storageTemperature",
  wallThickness: "wallThickness",
  sensingDistance: "sensingDistance",
  altitude: "altitude",
  strippingLength: "strippingLength",
  stroke: "stroke",
  bore: "bore",
  orificeSize: "orificeSize",
  blindZone: "blindZone",
  flowRate: "flowRate",
  pressure: "pressure",
  frequency: "frequency",
  switchingFrequency: "switchingFrequency",
  torque: "torque",
  power: "power",
  powerLoss: "powerLoss",
  powerConsumption: "powerConsumption",
  coilPower: "powerConsumption",
  coolingOutput: "coolingOutput",
  heatingCapacity: "heatingCapacity"
};

export function buildPdtFactIndex(input: PdtFactInput): PdtFactIndex {
  const result = input.item.result;
  const manufacturer = result?.manufacturerId ? getManufacturerConfig(result.manufacturerId) ?? input.manufacturer : input.manufacturer;
  const facts: PdtFact[] = [];

  addGenerated(facts, "articleNumber", input.item.catalogNumber, "catalog-number", "Catalog number from the uploaded input row.");
  addGenerated(facts, "typeCode", input.item.catalogNumber, "catalog-number", "Manufacturer type code fallback from the uploaded catalog number.");
  addGenerated(facts, "manufacturerName", manufacturer.canonicalName, "manufacturer-config", "Manufacturer name from the selected manufacturer config.");
  addGenerated(facts, "manufacturerUrl", manufacturerUrl(manufacturer), "manufacturer-config", "Manufacturer homepage from the selected manufacturer config.");
  addGenerated(facts, "deviceType", input.deviceType, "device-classifier", "Device type classified from scraped product evidence.");

  if (!result) return indexFacts(facts);

  const pdtUrlRule = pdtProductUrlRule({
    manufacturerId: result.manufacturerId ?? input.manufacturer.id,
    catalogNumber: input.item.catalogNumber
  });
  const productUrl = result.manufacturerId === "eaton" ? result.productUrl ?? pdtUrlRule?.value : pdtUrlRule?.value ?? result.productUrl;
  addGenerated(
    facts,
    "productUrl",
    productUrl,
    result.manufacturerId === "eaton" && result.productUrl ? "product-url" : pdtUrlRule?.name ?? "product-url",
    result.manufacturerId === "eaton" && result.productUrl
      ? "Eaton product URL selected by the scraper after resolving the actual skuPage identifier."
      : pdtUrlRule?.rationale ?? "Product URL selected by the scraper after identity checks."
  );
  addGenerated(facts, "localizedProductUrlEn", result.localizedUrls?.en, "localized-product-url", "English product URL selected by the scraper.");
  addGenerated(facts, "localizedProductUrlDe", result.localizedUrls?.de, "localized-product-url", "German product URL selected by the scraper.");
  addGenerated(
    facts,
    "shortDescription",
    pdtShortDescription(result, input.item.catalogNumber),
    "product-title",
    "Product title selected by the scraper and normalized for PDT import."
  );
  addGenerated(
    facts,
    "longDescription",
    pdtLongDescription(result, input.item.catalogNumber),
    "product-description",
    "Product description selected by the scraper and normalized for PDT import."
  );
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
  addSemanticNormalizedFacts(facts, result);
  addDocumentCertificateFacts(facts, result);

  // Customer-document attributes are authoritative — when one clearly looks like voltage
  // or current and the normalizer didn't pick it up (often because of a column-style label
  // with the unit in parens), promote it directly so the PDT cell still gets written.
  addCustomerDocFact(facts, result, "ratedVoltage", /\b(voltage|volt|spannung|u_?e|u_?n)\b/i, "V");
  addCustomerDocFact(facts, result, "ratedCurrent", /\b(current|amp(?:ere)?s?|strom|i_?e|i_?n|rated\s*current)\b/i, "A");
  addOntologyAttributeFacts(facts, result);
  addSignalPdtAttributeFacts(facts, result, input.deviceType);
  addPhysicalPdtAttributeFacts(facts, result);

  addAttributeFact(facts, result, "eanOrGtin", /\b(ean|gtin)\b/i);
  addAttributeFact(facts, result, "customsTariff", /\b(customs tariff|tariff code|tariff|hs code|commodity code|cn ?8|cn code|combined nomenclature)\b/i);
  addAttributeFact(facts, result, "typeCode", /\b(type code|typecode|model code|modellcode|extended product type|type designation|product main type|main type|catalog(?:ue)? type|order type)\b/i);
  addProductFamilyFact(facts, result);
  addAttributeFact(facts, result, "productDesignation", /\b(product designation|manufacturer.*designation|product type|article designation)\b/i);
  addEclassFacts(facts, result);
  addDeviceTypePdtFacts(facts, input);
  addRockwellIoCatalogFacts(facts, input);
  addRockwellCompact5000IoFacts(facts, input);

  addRepair(facts, "eclassCode", input.repair?.eclassCode, "pdt-repair", "Deterministic PDT cleanup produced an ECLASS code from scraped evidence.");
  addRepair(facts, "eclassSystemVersion", input.repair?.eclassSystemVersion, "pdt-repair", "Deterministic PDT cleanup produced an ECLASS system version.");
  addRepair(facts, "ratedVoltage", input.repair?.controlVoltage ?? input.repair?.voltageMax, "pdt-repair", "Deterministic PDT cleanup produced a voltage value.");
  addRepair(facts, "ratedCurrent", input.repair?.ratedCurrent ?? input.repair?.currentMax, "pdt-repair", "Deterministic PDT cleanup produced a current value.");
  addRepair(facts, "powerLossPerPole", input.repair?.powerLossPerPole, "pdt-repair", "Deterministic PDT cleanup produced a power-loss value.");
  addRepair(facts, "voltageType", input.repair?.voltageType, "pdt-repair", "Deterministic PDT cleanup produced a voltage type.");
  addRepair(
    facts,
    "shortDescription",
    repairShortDescription(input),
    "pdt-repair",
    "Deterministic PDT cleanup produced a short description."
  );
  addRepair(facts, "longDescription", repairLongDescription(input), "pdt-repair", "Deterministic PDT cleanup produced a long description.");

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

function addDeterministicRepair(facts: PdtFact[], key: string, value: string | undefined, ruleName: string, reason: string): void {
  const cleanValue = clean(value);
  if (!cleanValue) return;
  facts.push({ key, value: cleanValue, sourceKind: "repair", confidence: 0.86, ruleName, reason });
}

function addTypeDefault(facts: PdtFact[], key: string, value: string | undefined, ruleName: string, reason: string): void {
  const cleanValue = clean(value);
  if (!cleanValue) return;
  facts.push({ key, value: cleanValue, sourceKind: "repair", confidence: 0.62, ruleName, reason });
}

function addTypeDefaultIfMissing(facts: PdtFact[], key: string, value: string | undefined, ruleName: string, reason: string): void {
  if (facts.some((fact) => fact.key === key)) return;
  addTypeDefault(facts, key, value, ruleName, reason);
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

function addSemanticNormalizedFacts(facts: PdtFact[], result: ProductResult): void {
  const normalized = normalizeFields(result.attributes, result.documents);
  if (!clean(result.normalized.weight)) addSemanticNormalizedIfMissing(facts, result, "weight", normalized.weight);
  if (!clean(result.normalized.dimensions)) addSemanticNormalizedIfMissing(facts, result, "dimensions", normalized.dimensions);
  if (!clean(result.normalized.material)) addSemanticNormalizedIfMissing(facts, result, "material", normalized.material);
  if (!clean(result.normalized.finish)) addSemanticNormalizedIfMissing(facts, result, "finish", normalized.finish);
  if (!clean(result.normalized.color)) addSemanticNormalizedIfMissing(facts, result, "color", normalized.color);
  if (!clean(result.normalized.voltage)) addSemanticNormalizedIfMissing(facts, result, "ratedVoltage", normalized.voltage);
  if (!clean(result.normalized.current)) addSemanticNormalizedIfMissing(facts, result, "ratedCurrent", normalized.current);
}

function addDocumentCertificateFacts(facts: PdtFact[], result: ProductResult): void {
  if (facts.some((fact) => fact.key === "certificates" || fact.key === "pdtCertificates")) return;
  const certificateDoc = bestCertificateDocument(result.documents);
  if (!certificateDoc) return;
  const value =
    clean(normalizeFields(result.attributes, []).certificates) ??
    clean(result.normalized.certificates) ??
    clean(normalizeFields(result.attributes, result.documents).certificates);
  if (!value) return;
  const sourceType = certificateDoc.sourceType ?? "official";
  const confidence =
    certificateDoc.confidence ??
    (sourceType === "official" ? 0.86 : sourceType === "official-fallback" ? 0.74 : sourceType === "distributor" ? 0.45 : 0.62);
  const base: Omit<PdtFact, "key"> = {
    value,
    sourceKind: "document",
    sourceUrl: certificateDoc.url,
    sourceType,
    parser: certificateDoc.parser,
    stage: certificateDoc.stage ?? certificateDoc.parseStatus ?? "document-normalize",
    confidence,
    reason: `Certificate value derived from source document "${certificateDoc.label}".`
  };
  facts.push({ key: "certificates", ...base }, { key: "pdtCertificates", ...base });
}

function bestCertificateDocument(documents: DocumentRecord[]): DocumentRecord | undefined {
  const matches = documents.filter(
    (doc) =>
      !/\bwarranty\b/i.test(doc.label) &&
      (doc.type === "certificate" || /\b(certificate|declaration|conformity|rohs|weee|ce declaration)\b/i.test(doc.label))
  );
  matches.sort((left, right) => sourceRank(right.sourceType) - sourceRank(left.sourceType) || (right.confidence ?? 0) - (left.confidence ?? 0));
  return matches[0];
}

function addSemanticNormalizedIfMissing(facts: PdtFact[], result: ProductResult, key: string, value: string | undefined): void {
  if (facts.some((fact) => fact.key === key)) return;
  const cleanValue = clean(value);
  if (!cleanValue) return;
  const source = sourceForNormalizedValue(result, key, cleanValue) ?? sourceForSemanticLabel(result, key);
  if (!source) return;
  facts.push({
    key,
    value: cleanValue,
    sourceKind: "normalized",
    sourceUrl: source.sourceUrl,
    sourceType: source.sourceType,
    parser: source.parser,
    stage: source.stage ?? "semantic-normalize",
    confidence:
      source.confidence ??
      (source.sourceType === "official"
        ? 0.88
        : source.sourceType === "official-fallback"
          ? 0.76
          : source.sourceType === "distributor"
            ? 0.45
            : source.sourceType === "generated"
              ? 0.64
              : 0.6),
    reason: `Semantic ${key} derived from source-backed attribute "${source.name}" via the manufacturer-agnostic ontology.`
  });
}

function sourceForSemanticLabel(result: ProductResult, key: string): AttributeRecord | undefined {
  const matches = result.attributes.filter((attr) => clean(attr.value) && labelLooksLikeFact(`${attr.group ?? ""} ${attr.name}`, key));
  matches.sort((left, right) => sourceRank(right.sourceType) - sourceRank(left.sourceType) || (right.confidence ?? 0) - (left.confidence ?? 0));
  return matches[0];
}

function addAttributeFact(facts: PdtFact[], result: ProductResult, key: string, pattern: RegExp): void {
  const attr = bestAttribute(result.attributes, pattern);
  if (!attr) return;
  facts.push(factFromAttribute(key, attr, `Attribute "${attr.name}" matched canonical PDT fact ${key}.`));
}

function addProductFamilyFact(facts: PdtFact[], result: ProductResult): void {
  const matches = result.attributes
    .filter((attr) => /\b(product core group|product category|product family|product range|series|family)\b/i.test(`${attr.group ?? ""} ${attr.name}`))
    .filter((attr) => {
      const value = clean(attr.value);
      return value && !isUnhelpfulProductFamily(value);
    });
  matches.sort((left, right) => {
    const semanticRank = productFamilyAttributeRank(right) - productFamilyAttributeRank(left);
    return semanticRank || sourceRank(right.sourceType) - sourceRank(left.sourceType) || (right.confidence ?? 0) - (left.confidence ?? 0);
  });
  const attr = matches[0];
  if (!attr) return;
  const value = clean(attr.value);
  if (!value) return;
  facts.push(factFromAttribute("productFamily", attr, `Attribute "${attr.name}" matched canonical PDT fact productFamily.`));
}

function productFamilyAttributeRank(attr: AttributeRecord): number {
  const label = `${attr.group ?? ""} ${attr.name}`;
  if (/\bproduct core group\b/i.test(label)) return 4;
  if (/\bproduct category\b/i.test(label)) return 3;
  if (/\bproduct family\b/i.test(label)) return 2;
  return 1;
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

function addOntologyAttributeFacts(facts: PdtFact[], result: ProductResult): void {
  const sorted = [...result.attributes]
    .filter((attr) => clean(attr.value))
    .sort((left, right) => sourceRank(right.sourceType) - sourceRank(left.sourceType) || (right.confidence ?? 0) - (left.confidence ?? 0));
  for (const attr of sorted) {
    const label = `${attr.group ?? ""} ${attr.name ?? ""} ${attr.unit ?? ""}`;
    const ontologyKey = matchProperty(label)?.key;
    if ((ontologyKey === "ratedVoltage" || ontologyKey === "controlVoltage") && !facts.some((fact) => fact.key === "ratedVoltage")) {
      const value = ontologyElectricalValue(attr, "V");
      if (value) facts.push(factFromAttribute("ratedVoltage", { ...attr, value }, `Ontology label "${attr.name}" promoted to canonical PDT ratedVoltage.`));
    }
    if (ontologyKey === "ratedCurrent" && !facts.some((fact) => fact.key === "ratedCurrent")) {
      const value = ontologyElectricalValue(attr, "A");
      if (value) facts.push(factFromAttribute("ratedCurrent", { ...attr, value }, `Ontology label "${attr.name}" promoted to canonical PDT ratedCurrent.`));
    }
    if (ontologyKey === "operatingTemperature" || ontologyKey === "storageTemperature") {
      addTemperatureFacts(facts, attr, ontologyKey);
      continue;
    }
    const genericQuantityFact = ontologyQuantityFactKey(ontologyKey);
    if (genericQuantityFact && ontologyKey && !facts.some((fact) => fact.key === genericQuantityFact)) {
      const value = ontologyQuantityValue(attr, ontologyKey, genericQuantityKind(ontologyKey));
      if (value) {
        facts.push(factFromAttribute(genericQuantityFact, { ...attr, value }, `Ontology label "${attr.name}" promoted to canonical PDT ${genericQuantityFact}.`));
      }
    }
  }
}

function addSignalPdtAttributeFacts(facts: PdtFact[], result: ProductResult, deviceType: string | undefined): void {
  if (!isSignalDeviceType(deviceType)) return;

  const voltageAttr = bestAttribute(result.attributes, /\b(rated voltage|operating voltage|supply voltage|nominal voltage|voltage)\b/i);
  if (voltageAttr) {
    const voltage = ontologyElectricalValue(voltageAttr, "V");
    if (voltage && !hasAttributeFact(facts, "pdtRatedVoltage")) {
      facts.push(factFromAttribute("pdtRatedVoltage", { ...voltageAttr, value: firstNumberWithUnit(voltage, "V") ?? voltage }, `Signal-device attribute "${voltageAttr.name}" promoted to PDT rated voltage.`));
    }
    const voltageType = voltageTypeText(voltageAttr.value);
    if (voltageType && !hasAttributeFact(facts, "pdtVoltageTypeText")) {
      facts.push(factFromAttribute("pdtVoltageTypeText", { ...voltageAttr, value: voltageType }, `Signal-device attribute "${voltageAttr.name}" promoted to PDT voltage type.`));
    }
  }

  const colorAttr = bestAttribute(result.attributes, /\b(lens colou?r|lamp colou?r|light colou?r|color of lamp|colour of lamp|cover colou?r|covering colou?r)\b/i);
  if (colorAttr && !hasAttributeFact(facts, "pdtLampColor")) {
    facts.push(factFromAttribute("pdtLampColor", colorAttr, `Signal-device attribute "${colorAttr.name}" promoted to PDT lamp color.`));
  }

  const diameterAttr = bestAttribute(result.attributes, /\b(diameter|outer diameter|outside diameter|lens diameter|signal diameter)\b/i);
  const diameter = firstNumberWithUnit(lengthValueWithUnit(diameterAttr), "mm");
  if (diameterAttr && diameter && !hasAttributeFact(facts, "pdtSignalDiameter")) {
    facts.push(factFromAttribute("pdtSignalDiameter", { ...diameterAttr, value: diameter }, `Signal-device attribute "${diameterAttr.name}" promoted to PDT signal diameter.`));
  }

  const soundAttr = bestAttribute(result.attributes, /\b(loudness|sound pressure|sound level|acoustic|audible|noise level)\b/i);
  const soundLevel = firstNumberWithUnit(soundValueWithUnit(soundAttr), "dB");
  if (soundAttr && soundLevel && !hasAttributeFact(facts, "pdtSoundLevel")) {
    facts.push(factFromAttribute("pdtSoundLevel", { ...soundAttr, value: soundLevel }, `Signal-device attribute "${soundAttr.name}" promoted to PDT sound level.`));
  }
}

function addPhysicalPdtAttributeFacts(facts: PdtFact[], result: ProductResult): void {
  addMetricLengthPdtFact(facts, result, "pdtDepthMm", /\b(depth|length)\b/i);
  addMetricLengthPdtFact(facts, result, "pdtWidthMm", /\bwidth\b/i);
  addMetricLengthPdtFact(facts, result, "pdtHeightMm", /\bheight\b/i);
}

function addMetricLengthPdtFact(facts: PdtFact[], result: ProductResult, key: "pdtDepthMm" | "pdtWidthMm" | "pdtHeightMm", pattern: RegExp): void {
  if (hasAttributeFact(facts, key)) return;
  const attr = bestAttribute(result.attributes, pattern);
  const valueWithUnit = lengthValueWithUnit(attr);
  if (!attr || !valueWithUnit || !/\bmm\b/i.test(valueWithUnit)) return;
  const value = firstNumberWithUnit(valueWithUnit, "mm");
  if (!value) return;
  facts.push(factFromAttribute(key, { ...attr, value }, `Physical attribute "${attr.name}" promoted to PDT ${key}.`));
}

function hasAttributeFact(facts: PdtFact[], key: string): boolean {
  return facts.some((fact) => fact.key === key && fact.sourceKind === "attribute");
}

function lengthValueWithUnit(attr: AttributeRecord | undefined): string | undefined {
  const value = clean(attr?.value);
  if (!value) return undefined;
  if (unitAlreadyPresent(value, "length") || !clean(attr?.unit)) return value;
  return `${value} ${attr?.unit}`;
}

function soundValueWithUnit(attr: AttributeRecord | undefined): string | undefined {
  const value = clean(attr?.value);
  if (!value) return undefined;
  if (/\bdB(?:A)?\b/i.test(value) || !clean(attr?.unit)) return value;
  return `${value} ${attr?.unit}`;
}

function addTemperatureFacts(facts: PdtFact[], attr: AttributeRecord, ontologyKey: "operatingTemperature" | "storageTemperature"): void {
  const raw = clean(attr.value);
  if (!raw || !/-?\d/.test(raw)) return;
  const valueWithUnit = unitAlreadyPresent(raw, "temperature") || !clean(attr.unit) ? raw : `${raw} ${attr.unit}`;
  const range = splitTemperatureRange(valueWithUnit);
  if (!range.min && !range.max) return;
  const baseKey = ontologyKey;
  if (!facts.some((fact) => fact.key === baseKey)) {
    const display = range.min && range.max ? `${range.min}..${range.max} C` : `${range.min ?? range.max} C`;
    facts.push(factFromAttribute(baseKey, { ...attr, value: display }, `Ontology label "${attr.name}" promoted to canonical PDT ${baseKey}.`));
  }
  const minKey = `${baseKey}Min`;
  const maxKey = `${baseKey}Max`;
  if (range.min && !facts.some((fact) => fact.key === minKey)) {
    facts.push(factFromAttribute(minKey, { ...attr, value: `${range.min} C` }, `Ontology label "${attr.name}" promoted to canonical PDT ${minKey}.`));
  }
  if (range.max && !facts.some((fact) => fact.key === maxKey)) {
    facts.push(factFromAttribute(maxKey, { ...attr, value: `${range.max} C` }, `Ontology label "${attr.name}" promoted to canonical PDT ${maxKey}.`));
  }
}

function ontologyElectricalValue(attr: AttributeRecord, unit: "V" | "A"): string | undefined {
  const raw = clean(attr.value);
  if (!raw || !/-?\d/.test(raw)) return undefined;
  const withUnit = ensureUnit(raw, unit, `${attr.name ?? ""} ${attr.unit ?? ""}`);
  if (!unitNumbers(withUnit, unit, `${attr.name ?? ""} ${attr.unit ?? ""}`).length) return undefined;
  return withUnit;
}

function ontologyQuantityValue(attr: AttributeRecord, ontologyKey: string, kind: "current" | "voltage" | "length" | "flowRate" | "pressure" | "power" | "frequency" | "torque"): string | undefined {
  const raw = clean(attr.value);
  if (!raw || !/-?\d/.test(raw)) return undefined;
  const label = `${attr.group ?? ""} ${attr.name ?? ""} ${attr.unit ?? ""}`;
  const valueWithUnit = unitAlreadyPresent(raw, kind) || !clean(attr.unit) ? raw : `${raw} ${attr.unit}`;
  const parsed = understand(label, valueWithUnit);
  if (parsed.property?.key !== ontologyKey) return undefined;
  const quantity = parsed.quantities.find((candidate) => candidate.kind === kind);
  if (!quantity) return undefined;
  if (kind === "frequency" && quantity.values?.length && quantity.unit) {
    const values = quantity.values.filter((value) => Number.isFinite(value));
    return values.length ? `${values.map(formatFactNumber).join("/")} ${quantity.unit}` : undefined;
  }
  const value = quantity.value ?? quantity.max ?? (quantity.values?.length ? Math.max(...quantity.values) : undefined);
  if (value === undefined || !Number.isFinite(value) || !quantity.unit) return undefined;
  return `${formatFactNumber(value)} ${quantity.unit}`;
}

function ontologyQuantityFactKey(ontologyKey: string | undefined): string | undefined {
  return ontologyKey ? PDT_ONTOLOGY_QUANTITY_FACT_KEYS[ontologyKey] : undefined;
}

function genericQuantityKind(ontologyKey: string): "current" | "voltage" | "length" | "flowRate" | "pressure" | "power" | "frequency" | "torque" {
  if (ontologyKey === "breakingCapacity" || ontologyKey === "leakageCurrent") return "current";
  if (ontologyKey === "insulationVoltage" || ontologyKey === "impulseVoltage" || ontologyKey === "voltageDrop") return "voltage";
  if (
    [
      "wallThickness",
      "sensingDistance",
      "altitude",
      "strippingLength",
      "stroke",
      "bore",
      "orificeSize",
      "blindZone"
    ].includes(ontologyKey)
  ) {
    return "length";
  }
  if (ontologyKey === "flowRate") return "flowRate";
  if (ontologyKey === "pressure") return "pressure";
  if (ontologyKey === "frequency" || ontologyKey === "switchingFrequency") return "frequency";
  if (ontologyKey === "torque") return "torque";
  return "power";
}

function unitAlreadyPresent(value: string, kind: "current" | "voltage" | "temperature" | "length" | "flowRate" | "pressure" | "power" | "frequency" | "torque"): boolean {
  const text = value.replace(/\u00b3/g, "3");
  if (kind === "current") return /\b(?:uA|mA|kA|A|amps?|amperes?)\b/i.test(text);
  if (kind === "voltage") return /\b(?:mV|kV|V|VAC|VDC|volts?)\b/i.test(text);
  if (kind === "temperature") return /\b(?:°?\s*C|deg\s*C|degrees?\s*C|celsius)\b/i.test(text);
  if (kind === "length") return /\b(?:mm|cm|m)\b/i.test(text);
  if (kind === "flowRate") return /\b(?:Nl\s*\/\s*min|l\s*\/\s*min|lpm|m3\s*\/\s*h|m3\s*\/\s*min|dm3\s*\/\s*min|gpm|cfm)\b/i.test(text);
  if (kind === "pressure") return /\b(?:mbar|kPa|MPa|Pa|bar|psi)\b/i.test(text);
  if (kind === "frequency") return /\b(?:MHz|kHz|Hz|hertz)\b/i.test(text);
  if (kind === "torque") return /\b(?:N\s*[·*]?\s*m|Nm|newton\s*meters?)\b/i.test(text);
  return /\b(?:mW|kW|W|hp|horsepower)\b/i.test(text);
}

function formatFactNumber(value: number): string {
  return String(Number(value.toFixed(6)));
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

function addEclassFacts(facts: PdtFact[], result: ProductResult): void {
  const attr = bestAttribute(result.attributes, /^eclass\b/i);
  if (!attr) return;
  const code = attr.value.match(/\d{2}(?:[-.]?\d{2}){1,3}/)?.[0] ?? clean(attr.value);
  if (code) facts.push(factFromAttribute("eclassCode", { ...attr, value: code }, `ECLASS code extracted from "${attr.name}".`));
  const version = attr.name.match(/\d+(?:\.\d+)+|\d+/)?.[0];
  if (version) facts.push(factFromAttribute("eclassSystemVersion", { ...attr, value: `ECLASS-${version}` }, `ECLASS system/version extracted from "${attr.name}".`));
}

function addDeviceTypePdtFacts(facts: PdtFact[], input: PdtFactInput): void {
  const result = input.item.result;
  const deviceType = input.deviceType;
  if (!result || !deviceType) return;
  const eclassDefault = soleEclassDefaultForDeviceType(deviceType);
  if (eclassDefault) {
    addTypeDefaultIfMissing(facts, "eclassCode", eclassDefault.code, "device-type-profile-eclass-default", `Default ECLASS class for ${deviceType} PDT profile.`);
    addTypeDefaultIfMissing(facts, "eclassSystemVersion", eclassDefault.system, "device-type-profile-eclass-default", `Default ECLASS version for ${deviceType} PDT profile.`);
  }

  if (isSignalDeviceType(deviceType)) {
    addTypeDefault(facts, "pdtRatedVoltage", voltageNumberForPdt(result) ?? firstNumberWithUnit(firstFactValue(facts, "ratedVoltage"), "V"), "device-type-signal-voltage-default", "Rated voltage derived from scraped signal-device voltage.");
    addTypeDefault(
      facts,
      "pdtVoltageTypeText",
      voltageTypeText(result.normalized.voltage ?? firstFactValue(facts, "ratedVoltage") ?? attributeValue(result, /\b(rated voltage|operating voltage|supply voltage)\b/i)),
      "device-type-signal-voltage-default",
      "Voltage type derived from scraped signal-device voltage."
    );
    addTypeDefault(facts, "pdtLampColor", signalColor(result) ?? firstFactValue(facts, "color"), "device-type-signal-color-default", "Signal color derived from scraped lamp/lens color.");
    addTypeDefault(facts, "pdtSignalDiameter", signalDiameter(result) ?? firstDimensionNumber(firstFactValue(facts, "dimensions")), "device-type-signal-diameter-default", "Signal diameter derived from scraped diameter or dimensions.");
    addTypeDefault(facts, "pdtSoundLevel", soundLevel(result), "device-type-signal-sound-default", "Sound level derived from scraped audible signal data.");
  }

}

function firstFactValue(facts: PdtFact[], key: string): string | undefined {
  return facts.find((fact) => fact.key === key)?.value;
}

function attributeValue(result: ProductResult, pattern: RegExp): string | undefined {
  return clean(bestAttribute(result.attributes, pattern)?.value);
}

function voltageNumberForPdt(result: ProductResult): string | undefined {
  return (
    firstNumberWithUnit(result.normalized.voltage, "V") ??
    firstNumberWithUnit(normalizeFields(result.attributes, result.documents).voltage, "V") ??
    firstNumberWithUnit(attributeValue(result, /\b(rated voltage|operating voltage|supply voltage|voltage)\b/i), "V")
  );
}

function voltageTypeText(value: string | undefined): string | undefined {
  const text = clean(value);
  if (!text) return undefined;
  const hasAc = /\bAC\b|\b50\s*Hz\b|\b60\s*Hz\b/i.test(text);
  const hasDc = /\bDC\b/i.test(text);
  if (hasAc && hasDc) return "AC/DC";
  if (hasAc) return "AC";
  if (hasDc) return "DC";
  return undefined;
}

function signalColor(result: ProductResult): string | undefined {
  return (
    attributeValue(result, /\b(lens colou?r|lamp colou?r|light colou?r|color of lamp|colour of lamp|cover colou?r|covering colou?r)\b/i) ??
    clean(result.normalized.color) ??
    normalizeFields(result.attributes, result.documents).color
  );
}

function signalDiameter(result: ProductResult): string | undefined {
  return (
    firstNumberWithUnit(attributeValue(result, /\b(diameter|outer diameter|outside diameter|lens diameter)\b/i), "mm") ??
    firstDimensionNumber(result.normalized.dimensions) ??
    firstDimensionNumber(normalizeFields(result.attributes, result.documents).dimensions)
  );
}

function soundLevel(result: ProductResult): string | undefined {
  return firstNumberWithUnit(attributeValue(result, /\b(loudness|sound pressure|sound level|acoustic|audible)\b/i), "dB");
}

function firstNumberWithUnit(value: string | undefined, unit: string): string | undefined {
  const text = clean(value);
  if (!text) return undefined;
  const escapedUnit = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unitMatch = text.replace(",", ".").match(new RegExp(String.raw`(-?\d+(?:\.\d+)?)\s*${escapedUnit}\b`, "i"));
  if (unitMatch) return unitMatch[1];
  const first = text.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return first?.[0];
}

function firstDimensionNumber(value: string | undefined): string | undefined {
  const text = clean(value);
  if (!text || !/\bmm\b/i.test(text)) return undefined;
  return text.replace(",", ".").match(/-?\d+(?:\.\d+)?/)?.[0];
}

function addRockwellCompact5000IoFacts(facts: PdtFact[], input: PdtFactInput): void {
  const result = input.item.result;
  if (!result || !isRockwell(input)) return;
  const catalog = clean(input.item.catalogNumber) ?? "";
  const compact5000Io = /\b5069-[IO][A-Z0-9-]*\b/i.test(catalog);
  if (!compact5000Io) return;
  const inputCount = rockwellIoCatalogPointCount(catalog, "digitalInput");
  const outputCount = rockwellIoCatalogPointCount(catalog, "digitalOutput");

  addDeterministicRepair(
    facts,
    "pdtDigitalInputCount",
    inputCount,
    "rockwell-compact-5000-io-point-count",
    "Rockwell Compact 5000 I/O input modules encode their digital point count in the 5069-I* catalog suffix."
  );
  addDeterministicRepair(
    facts,
    "pdtDigitalOutputCount",
    outputCount,
    "rockwell-compact-5000-io-point-count",
    "Rockwell Compact 5000 I/O output modules encode their digital point count in the 5069-O* catalog suffix."
  );
}

function addRockwellIoCatalogFacts(facts: PdtFact[], input: PdtFactInput): void {
  if (!input.item.result || !isRockwell(input)) return;
  const catalog = clean(input.item.catalogNumber) ?? "";
  const specs = [
    {
      key: "pdtDigitalInputCount",
      kind: "digitalInput" as const,
      label: "digital input",
      rule: "rockwell-io-catalog-digital-input-count"
    },
    {
      key: "pdtDigitalOutputCount",
      kind: "digitalOutput" as const,
      label: "digital output",
      rule: "rockwell-io-catalog-digital-output-count"
    },
    {
      key: "pdtAnalogInputCount",
      kind: "analogInput" as const,
      label: "analog input",
      rule: "rockwell-io-catalog-analog-input-count"
    },
    {
      key: "pdtAnalogOutputCount",
      kind: "analogOutput" as const,
      label: "analog output",
      rule: "rockwell-io-catalog-analog-output-count"
    }
  ];
  for (const spec of specs) {
    addDeterministicRepair(
      facts,
      spec.key,
      rockwellIoCatalogPointCount(catalog, spec.kind),
      spec.rule,
      `Rockwell I/O modules encode their ${spec.label} point count in the catalog suffix.`
    );
  }
}

function rockwellIoCatalogPointCount(
  catalogNumber: string,
  kind: "digitalInput" | "digitalOutput" | "analogInput" | "analogOutput"
): string | undefined {
  const catalog = clean(catalogNumber)?.toUpperCase() ?? "";
  if (!/\b(?:1734|1756|1769|1794|2085|5069|5094)-/.test(catalog)) return undefined;
  const module = catalog.match(/\b(?:1734|1756|1769|1794|2085|5069|5094)-([A-Z]+)(\d{1,3})[A-Z0-9-]*\b/)?.slice(1, 3);
  if (!module) return undefined;
  const [prefix, count] = module;
  const digitalInputPrefixes = ["IA", "IB", "IC", "IM", "IN", "IQ", "IV"];
  const digitalOutputPrefixes = ["OA", "OB", "OC", "OW", "OX", "OV"];
  const analogInputPrefixes = ["IF", "IE", "IR", "IT", "IJ"];
  const analogOutputPrefixes = ["OF", "OE"];
  const expected =
    kind === "digitalInput" ? digitalInputPrefixes :
    kind === "digitalOutput" ? digitalOutputPrefixes :
    kind === "analogInput" ? analogInputPrefixes :
    analogOutputPrefixes;
  return expected.some((entry) => prefix.startsWith(entry)) ? count : undefined;
}

function isRockwell(input: PdtFactInput): boolean {
  return (input.item.result?.manufacturerId ?? input.manufacturer.id) === "rockwell";
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
  const ontologyKey = matchProperty(label)?.key;
  if (ontologyKey && ontologyFactKeys(ontologyKey).includes(key)) return true;
  if (key === "weight") return /\b(weight|mass|gewicht)\b/.test(text);
  if (key === "dimensions") return /\b(dimension|height|width|depth|length|size)\b/.test(text);
  if (key === "material") return /\b(material|housing|body|enclosure)\b/.test(text);
  if (key === "ratedVoltage") return /\b(voltage|spannung|volt)\b/.test(text);
  if (key === "ratedCurrent") return /\b(current|amp|strom)\b/.test(text);
  if (key === "color") return /\b(colou?r|farbe)\b/.test(text);
  if (key === "certificates") return /\b(cert|approval|standard|conformity)\b/.test(text);
  return false;
}

function isUnhelpfulProductFamily(value: string): boolean {
  return /^(?:sku\s*page|product\s+sku|product\s+page|page)$/i.test(value.trim());
}

function ontologyFactKeys(ontologyKey: string): string[] {
  return PDT_ONTOLOGY_FACT_KEYS[ontologyKey] ?? [];
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

function pdtShortDescription(result: ProductResult, catalogNumber: string): string | undefined {
  const value = safeDescription(result.title, catalogNumber);
  return compactFamilyShortDescription(value) ?? value;
}

function pdtLongDescription(result: ProductResult, catalogNumber: string): string | undefined {
  const value = safeDescription(result.description, catalogNumber);
  return value;
}

function repairShortDescription(input: PdtFactInput): string | undefined {
  const value = input.repair?.shortDescription;
  if (!value) return undefined;
  return compactFamilyShortDescription(value) ?? value;
}

function repairLongDescription(input: PdtFactInput): string | undefined {
  const value = input.repair?.longDescription;
  if (!value) return undefined;
  return value;
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
