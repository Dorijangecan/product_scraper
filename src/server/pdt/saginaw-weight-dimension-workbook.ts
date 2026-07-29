import ExcelJS from "exceljs";
import path from "node:path";
import type { AttributeRecord, ManufacturerConfig, RunItemRecord } from "../../shared/types.js";
import { collapseWhitespaceOrUndefined as clean } from "../text-util.js";

/**
 * Saginaw-only companion workbook that ships next to the PDT.
 *
 * Saginaw publishes Height/Width/Depth in inches and "Est. Ship Weight" in pounds on every
 * product page. The PDT (and the products workbook) carry the metric, normalised values, so the
 * customer asked for a second, deliberately dumb sheet that repeats Saginaw's own numbers
 * **verbatim** — no unit conversion, no rounding, no re-formatting.
 *
 * Only two presentational changes are applied to the page's digits: the unit marker is dropped
 * (`9.50"` → `9.50`, `5.00 lbs` → `5.00`; the unit lives in the column header instead) and the
 * decimal point becomes a decimal comma (`9,50`). The digits themselves are never touched, so
 * cells stay text (`numFmt "@"`) — a real number would let Excel swallow `9,50` into `9,5`.
 */

const SAGINAW_MANUFACTURER_ID = "sce";

export interface SaginawWeightDimensionRow {
  catalogNumber: string;
  description?: string;
  height?: string;
  width?: string;
  depth?: string;
  weight?: string;
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
      return {
        catalogNumber: item.catalogNumber,
        description: pageDescription(attributes) ?? clean(item.result?.description),
        height: inchValue(attributes, /^height$/i),
        width: inchValue(attributes, /^width$/i),
        depth: inchValue(attributes, /^depth$/i),
        weight: poundValue(attributes),
        productUrl: clean(item.result?.productUrl) ?? clean(item.productUrl)
      };
    });
}

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
    { header: "Height (in)", key: "height", width: 14 },
    { header: "Width (in)", key: "width", width: 14 },
    { header: "Depth (in)", key: "depth", width: 14 },
    { header: "Est. Ship Weight (lbs)", key: "weight", width: 22 },
    { header: "Product Page", key: "productUrl", width: 62 }
  ];
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    const added = sheet.addRow({
      catalogNumber: row.catalogNumber,
      description: row.description,
      height: row.height,
      width: row.width,
      depth: row.depth,
      weight: row.weight,
      productUrl: row.productUrl ? { text: row.productUrl, hyperlink: row.productUrl } : undefined
    });
    // Force text so the page's own digits survive: a numeric cell would drop 9,50 to 9,5.
    for (const key of ["height", "width", "depth", "weight"]) {
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

function inchValue(attributes: AttributeRecord[], name: RegExp): string | undefined {
  const value = pickAttributeValue(attributes, name);
  // Silence beats wrong data: a metric value under an inch header would be a lie, and these pages
  // never print one. Anything that is not an inch/plain number is dropped.
  if (!value || /\b(?:mm|cm|m)\b|millimet|centimet/i.test(value)) return undefined;
  // Inch pages print 9.50", sometimes 20.00H / 20.00W / 20.00D in the dimension widget.
  return decimalComma(value.replace(/\s*(?:"|''|in\.?|inch(?:es)?|[HWD])$/i, ""));
}

function poundValue(attributes: AttributeRecord[]): string | undefined {
  // The page label is "Est. Ship Weight"; the SCE parser normalises it to "Weight".
  const value = pickAttributeValue(attributes, /^(?:est\.?\s*ship\s+)?weight$/i);
  if (!value || /\bkgs?\b|\bg\b|kilogram/i.test(value)) return undefined;
  return decimalComma(value.replace(/\s*(?:lbs?\.?|pounds?|#)$/i, ""));
}

/**
 * Strip nothing but the separator: the page's digits are copied one-for-one and only `.` becomes
 * `,`. Anything that is not a bare number after the unit was removed is dropped rather than
 * guessed at (e.g. a multi-value dimension blob "20.00 x 16.00").
 */
function decimalComma(value: string): string | undefined {
  const bare = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(bare)) return undefined;
  return bare.replace(".", ",");
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
