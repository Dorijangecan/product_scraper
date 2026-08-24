import type { AttributeRecord } from "../../shared/types.js";

type OrderingRowReader = (catalogNumber: string, options: { allowInference: boolean }) => AttributeRecord[];

/**
 * Eaton Rapid Link documents publish a finite, vendor-specific set of catalogue-number offsets.
 * Keep this evidence-preserving compatibility adapter out of the shared PDF table reader: the
 * transforms are not a general ordering-code grammar and must never run for another vendor.
 */
export function inferEatonRapidLinkOrderingRows(
  lines: string[],
  catalogNumber: string,
  sourceUrl: string,
  readOrderingRow: OrderingRowReader
): AttributeRecord[] {
  if (!mentionsHanQ5Legend(lines)) return [];
  const match = catalogNumber.trim().match(/^CDVRL(\d{5})$/i);
  if (!match || Number(match[1]) <= 48) return [];
  const target = Number(match[1]);
  const infer = (rule: OffsetRule) => inferOffset(target, catalogNumber, sourceUrl, readOrderingRow, rule);
  return infer({ offset: 48, allowBaseInference: false, canTransform: (model) => /-412/i.test(model), transform: (model) => model.replace(/-412/i, "-512"), basis: (base) => `Derived from ${base} ordering row and Eaton RASP5X type-code legend: 512 = HAN Q5 lower entrance.` })
    ?? infer({ offset: 144, allowBaseInference: true, applies: (value) => (value >= 20217 && value <= 20240) || (value >= 20649 && value <= 20672), canTransform: (model) => /-412/i.test(model), transform: (model) => model.replace(/-412/i, "-512"), basis: (base) => `Derived from ${base} ordering row and Eaton RASP5X type-code legend: 512 = HAN Q5 lower entrance in the C2 option sub-block.` })
    ?? infer({ offset: 168, allowBaseInference: true, applies: (value) => (value >= 20169 && value <= 20288) || (value >= 20601 && value <= 20720), canTransform: (model) => /-412/i.test(model), transform: (model) => model.replace(/-412/i, "-512"), basis: (base) => `Derived from ${base} ordering row and Eaton RASP5X type-code legend: 512 = HAN Q5 lower entrance in the C2 option block.` })
    ?? infer({ offset: 10000, allowBaseInference: true, canTransform: (model) => /^RASP5G-[^-]+PNT-/i.test(model), transform: (model) => model.replace(/^RASP5G-/i, "RASP5A-"), transformAttribute: ip65Attribute, basis: (base) => `Derived from ${base} ordering row and Eaton RASP5X type-code legend: 5A = advanced IP65 variant of 5G PROFINET.` })
    ?? infer({ offset: 10000, allowBaseInference: true, canTransform: (model) => /^RASP5A-/i.test(model) && /-(?:412|512)[R0][012][01][01]S1-/i.test(model), transform: (model) => model.replace(/(-(?:412|512)[R0][012])[01]([01]S1-)/i, (_match, prefix: string, suffix: string) => `${prefix}2${suffix}`), transformAttribute: ip65Attribute, basis: (base) => `Derived from ${base} ordering row and Eaton RASP5X type-code legend: EMC option 2 = C2 filter variant.` })
    ?? [];
}

interface OffsetRule {
  offset: number;
  allowBaseInference: boolean;
  applies?: (target: number) => boolean;
  canTransform: (model: string) => boolean;
  transform: (model: string) => string;
  transformAttribute?: (attribute: AttributeRecord) => AttributeRecord;
  basis: (baseCatalog: string) => string;
}

function inferOffset(target: number, catalogNumber: string, sourceUrl: string, readOrderingRow: OrderingRowReader, rule: OffsetRule): AttributeRecord[] | undefined {
  if (rule.applies && !rule.applies(target)) return undefined;
  const baseNumber = target - rule.offset;
  if (baseNumber <= 0) return undefined;
  const baseCatalog = `CDVRL${String(baseNumber).padStart(5, "0")}`;
  const baseAttributes = readOrderingRow(baseCatalog, { allowInference: rule.allowBaseInference });
  const baseModel = baseAttributes.find((attribute) => attribute.name === "Model Code")?.value;
  if (!baseModel || !rule.canTransform(baseModel)) return undefined;
  return baseAttributes.map((baseAttribute) => {
    const attribute = rule.transformAttribute?.(baseAttribute) ?? baseAttribute;
    if (attribute.name === "Catalog Number") return { ...attribute, group: "PDF Catalog Ordering Table Inferred", value: catalogNumber };
    if (attribute.name === "Model Code") return { ...attribute, group: "PDF Catalog Ordering Table Inferred", value: rule.transform(baseModel) };
    return { ...attribute, group: "PDF Catalog Ordering Table Inferred" };
  }).concat({ group: "PDF Catalog Ordering Table Inferred", name: "Inference basis", value: rule.basis(baseCatalog), sourceUrl });
}

function mentionsHanQ5Legend(lines: string[]): boolean {
  const text = lines.slice(0, 220).join(" ");
  return /\b512\s*=\s*HAN\s*Q5\b/i.test(text) && /\b412\s*=\s*HAN\s*Q4\/2\b/i.test(text);
}

function ip65Attribute(attribute: AttributeRecord): AttributeRecord {
  return attribute.name === "Degree of protection" ? { ...attribute, value: "IP65" } : attribute;
}
