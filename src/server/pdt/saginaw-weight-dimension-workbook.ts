import ExcelJS from "exceljs";
import path from "node:path";
import type { AttributeRecord, ManufacturerConfig, RunItemRecord } from "../../shared/types.js";
import { collapseWhitespaceOrUndefined as clean } from "../text-util.js";

/**
 * Saginaw-only companion workbook that ships next to the PDT.
 *
 * Saginaw publishes Height/Width/Depth in inches and "Est. Ship Weight" in pounds on every
 * product page. The PDT (and the products workbook) carry the normalised, rounded values, so the
 * customer asked for a second, deliberately dumb sheet that repeats Saginaw's own numbers plus
 * their metric equivalents — with **no rounding anywhere**.
 *
 * Imperial columns: the page's digits are copied one-for-one; only the unit marker is dropped
 * (`9.50"` → `9.50`, `5.00 lbs` → `5.00`; the unit lives in the column header) and the decimal
 * point becomes a decimal comma (`9,50`).
 *
 * Metric columns: `inch → mm` and `lb → kg` are *exact* decimal conversions (25.4 and 0.45359237
 * are exact definitions, so a finite decimal input always has a finite decimal result). They are
 * computed with BigInt integer arithmetic — never floating point — so nothing is rounded or
 * truncated: `59.94"` becomes exactly `1522,476` mm and `26 lbs` exactly `11,79340162` kg.
 *
 * Everything is written as text (`numFmt "@"`) because a numeric cell would let Excel swallow
 * `9,50` into `9,5` and re-round the long metric decimals.
 */

const SAGINAW_MANUFACTURER_ID = "sce";

/** 1 in = 25.4 mm, exactly (international inch). */
const MM_PER_INCH = { digits: 254n, decimals: 1 };
/** 1 lb = 0.45359237 kg, exactly (international avoirdupois pound). */
const KG_PER_POUND = { digits: 45359237n, decimals: 8 };

export interface SaginawWeightDimensionRow {
  catalogNumber: string;
  description?: string;
  descriptionDe?: string;
  height?: string;
  width?: string;
  depth?: string;
  weight?: string;
  heightMm?: string;
  widthMm?: string;
  depthMm?: string;
  weightKg?: string;
  productUrl?: string;
}

export function saginawWorkbookPathForPdt(outputPath: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}_saginaw-weight-dimensions.xlsx`);
}

export function isSaginawManufacturer(manufacturer: Pick<ManufacturerConfig, "id">): boolean {
  return manufacturer.id === SAGINAW_MANUFACTURER_ID;
}

export function buildSaginawWeightDimensionRows(items: RunItemRecord[]): SaginawWeightDimensionRow[] {
  return [...items]
    .sort((left, right) => left.rowIndex - right.rowIndex)
    .filter((item) => !item.result || item.result.manufacturerId === SAGINAW_MANUFACTURER_ID)
    .map((item) => {
      const attributes = item.result?.attributes ?? [];
      const height = inchNumber(attributes, /^height$/i);
      const width = inchNumber(attributes, /^width$/i);
      const depth = inchNumber(attributes, /^depth$/i);
      const weight = poundNumber(attributes);
      const german = item.result?.localizedDescriptions?.de;
      return {
        catalogNumber: item.catalogNumber,
        description: pageDescription(attributes) ?? clean(item.result?.description),
        descriptionDe: clean(german?.description) ?? clean(german?.title),
        height: decimalComma(height),
        width: decimalComma(width),
        depth: decimalComma(depth),
        weight: decimalComma(weight),
        heightMm: decimalComma(convertExactly(height, MM_PER_INCH)),
        widthMm: decimalComma(convertExactly(width, MM_PER_INCH)),
        depthMm: decimalComma(convertExactly(depth, MM_PER_INCH)),
        weightKg: decimalComma(convertExactly(weight, KG_PER_POUND)),
        productUrl: clean(item.result?.productUrl) ?? clean(item.productUrl)
      };
    });
}

const NUMERIC_COLUMN_KEYS = ["height", "width", "depth", "weight", "heightMm", "widthMm", "depthMm", "weightKg"];

export async function writeSaginawWeightDimensionWorkbook(
  outputPath: string,
  manufacturer: Pick<ManufacturerConfig, "id">,
  items: RunItemRecord[]
): Promise<string | undefined> {
  if (!isSaginawManufacturer(manufacturer)) return undefined;
  const rows = buildSaginawWeightDimensionRows(items);
  if (rows.length === 0) return undefined;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Product Scraper";
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet("Saginaw Weight & Dimensions", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 1 }]
  });
  sheet.columns = [
    { header: "Part Number", key: "catalogNumber", width: 26 },
    { header: "Description", key: "description", width: 46 },
    { header: "Description DE", key: "descriptionDe", width: 46 },
    { header: "Height (in)", key: "height", width: 14 },
    { header: "Width (in)", key: "width", width: 14 },
    { header: "Depth (in)", key: "depth", width: 14 },
    { header: "Est. Ship Weight (lbs)", key: "weight", width: 22 },
    { header: "Height (mm)", key: "heightMm", width: 16 },
    { header: "Width (mm)", key: "widthMm", width: 16 },
    { header: "Depth (mm)", key: "depthMm", width: 16 },
    { header: "Est. Ship Weight (kg)", key: "weightKg", width: 22 },
    { header: "Product Page", key: "productUrl", width: 62 }
  ];
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    const added = sheet.addRow({
      ...row,
      productUrl: row.productUrl ? { text: row.productUrl, hyperlink: row.productUrl } : undefined
    });
    // Force text so the digits survive: a numeric cell would drop 9,50 to 9,5 and re-round
    // 11,79340162 to whatever the column happens to be formatted as.
    for (const key of NUMERIC_COLUMN_KEYS) {
      added.getCell(key).numFmt = "@";
    }
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };

  const workbookPath = saginawWorkbookPathForPdt(outputPath);
  await workbook.xlsx.writeFile(workbookPath);
  return workbookPath;
}

/** Saginaw's canonical per-part description ("S.S. PB Enclosure"), as printed on the page. */
function pageDescription(attributes: AttributeRecord[]): string | undefined {
  return pickAttributeValue(attributes, /^description$/i);
}

function inchNumber(attributes: AttributeRecord[], name: RegExp): string | undefined {
  const value = pickAttributeValue(attributes, name);
  // Silence beats wrong data: a metric value under an inch header would be a lie, and these pages
  // never print one. Anything that is not an inch/plain number is dropped.
  if (!value || /\b(?:mm|cm|m)\b|millimet|centimet/i.test(value)) return undefined;
  // Inch pages print 9.50", sometimes 20.00H / 20.00W / 20.00D in the dimension widget.
  return bareNumber(value.replace(/\s*(?:"|''|in\.?|inch(?:es)?|[HWD])$/i, ""));
}

function poundNumber(attributes: AttributeRecord[]): string | undefined {
  // The page label is "Est. Ship Weight"; the SCE parser normalises it to "Weight".
  const value = pickAttributeValue(attributes, /^(?:est\.?\s*ship\s+)?weight$/i);
  if (!value || /\bkgs?\b|\bg\b|kilogram/i.test(value)) return undefined;
  return bareNumber(value.replace(/\s*(?:lbs?\.?|pounds?|#)$/i, ""));
}

/**
 * Keep the page's digits and nothing else. Anything that is not a single plain number once the
 * unit was removed is dropped rather than guessed at (e.g. a blob like "20.00 x 16.00").
 */
function bareNumber(value: string): string | undefined {
  const bare = value.trim();
  return /^\d+(?:\.\d+)?$/.test(bare) ? bare : undefined;
}

/**
 * Exact decimal conversion — integer arithmetic only, so no floating-point drift and no rounding:
 * `59.94 × 25.4` is computed as `5994 × 254 / 10^3` = `1522.476`. Trailing zeros carried over from
 * the page's formatting are dropped (`6.00" → 152.4`, not `152.400`), which does not change value.
 */
function convertExactly(value: string | undefined, factor: { digits: bigint; decimals: number }): string | undefined {
  if (!value) return undefined;
  const [whole, fraction = ""] = value.split(".");
  const decimals = fraction.length + factor.decimals;
  const product = (BigInt(`${whole}${fraction}`) * factor.digits).toString().padStart(decimals + 1, "0");
  const pointAt = product.length - decimals;
  return `${product.slice(0, pointAt)}.${product.slice(pointAt)}`.replace(/0+$/, "").replace(/\.$/, "");
}

/** European decimal separator, as the customer's downstream import expects. */
function decimalComma(value: string | undefined): string | undefined {
  return value?.replace(".", ",");
}

function pickAttributeValue(attributes: AttributeRecord[], name: RegExp): string | undefined {
  const best = attributes
    .filter((attribute) => name.test(attribute.name.trim()))
    .map((attribute) => ({ attribute, rank: attributeRank(attribute) }))
    .sort((left, right) => right.rank - left.rank)[0];
  return clean(best?.attribute.value);
}

/** Prefer the product page's own "Product Specifications" block over derived/secondary sources. */
function attributeRank(attribute: AttributeRecord): number {
  const group = attribute.group ?? "";
  const groupRank = /^product specifications$/i.test(group)
    ? 30
    : /^dimensions$/i.test(group)
      ? 20
      : /^search result$/i.test(group)
        ? 10
        : 0;
  const parserRank = /^sce-/i.test(attribute.parser ?? "") ? 5 : 0;
  return groupRank + parserRank + (attribute.confidence ?? 0);
}
