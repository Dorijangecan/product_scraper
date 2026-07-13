import type { AttributeRecord } from "../../shared/types.js";
import { compactCatalogNumber } from "./catalog-number.js";
import { cleanText } from "./normalizer.js";

/**
 * Extracts certifications from "compliance matrix" PDF pages — a table with one row per catalog
 * number and one column per standard (CE, UL, ATEX, ...), marking compliance with a checkmark
 * glyph instead of text (seen on Rockwell's 1606-td002 family datasheet, "Standards Compliance and
 * Certifications" page). Plain linear text extraction (pdf-parse's `getText()`) can't recover this:
 * the checkmark is a Private-Use-Area glyph in a custom symbol font (no real meaning outside that
 * font), and blank (unchecked) cells emit no placeholder at all — so a checkmark's column can only
 * be identified by its X position relative to the header row's column positions, which plain text
 * extraction throws away. This module works from `pdfjs-dist`'s raw positioned text items instead.
 */

const PUA_START = 0xe000;
const PUA_END = 0xf8ff;
/** Same "same row, different rendering pass" vertical offset seen between a catalog-number label
 * and its checkmark row in the source PDF (~2.6pt) is well under a row's own height (~11-13pt). */
const ROW_Y_TOLERANCE = 5;
/** Header labels sit in the same X range as the checkmark columns, well to the right of the
 * leftmost "Catalog Number" label column (which starts at the page margin). */
const HEADER_MIN_X = 100;

export interface PositionedTextItem {
  text: string;
  x: number;
  y: number;
}

/** A private-use-area codepoint has no meaning outside a specific embedded symbol font — in a
 * document/table context it is always an icon glyph (checkmark, bullet, etc.), never real text. */
function isGlyphCell(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (code < PUA_START || code > PUA_END) return false;
  }
  return true;
}

/** Cheap pre-check on already-extracted plain text, so callers can skip the (separate, costlier)
 * positional pdfjs-dist pass entirely for the overwhelming majority of PDFs that never need it. */
export function textHasComplianceMatrixGlyphs(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= PUA_START && code <= PUA_END) return true;
  }
  return false;
}

function clusterRows(items: PositionedTextItem[], tolerance = ROW_Y_TOLERANCE): PositionedTextItem[][] {
  const sorted = [...items].sort((left, right) => right.y - left.y);
  const rows: PositionedTextItem[][] = [];
  for (const item of sorted) {
    const row = rows.find((candidate) => Math.abs(candidate[0].y - item.y) <= tolerance);
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows;
}

/**
 * Pure matching logic (no PDF library involved) — given every positioned text item on a page and
 * a target catalog number, returns the header labels of every checked column on that catalog's
 * row. Returns `undefined` when the catalog's row isn't found on this page at all (caller should
 * try another page / fall back), or `[]` when the row is found but has no checked columns.
 */
export function matchComplianceMatrixCertificates(items: PositionedTextItem[], catalogNumber: string): string[] | undefined {
  const meaningful = items.filter((item) => item.text.trim().length > 0);
  const checkmarks = meaningful.filter((item) => isGlyphCell(item.text));
  if (!checkmarks.length) return undefined;

  const maxCheckmarkY = Math.max(...checkmarks.map((item) => item.y));
  const headers = meaningful.filter(
    (item) => !isGlyphCell(item.text) && item.x > HEADER_MIN_X && item.y > maxCheckmarkY + ROW_Y_TOLERANCE
  );
  if (headers.length < 2) return undefined;

  const targetCompact = compactCatalogNumber(catalogNumber);
  if (!targetCompact) return undefined;

  for (const row of clusterRows(meaningful)) {
    // The row's catalog-number label is the leftmost, non-checkmark cell (well left of the
    // checkmark/header column band).
    const label = row.find((item) => !isGlyphCell(item.text) && item.x < HEADER_MIN_X);
    if (!label) continue;
    // Exact match (not substring): each label is its own isolated table cell here, so there's no
    // risk of a shorter catalog number matching as a false-positive prefix of a longer sibling
    // (e.g. Rockwell's 1606-XLB60E vs 1606-XLB60EH) the way a substring scan over prose would.
    if (compactCatalogNumber(label.text) !== targetCompact) continue;

    const rowCheckmarks = row.filter((item) => isGlyphCell(item.text));
    if (!rowCheckmarks.length) return [];
    // Sort by the matched header's own column position (left to right), not the checkmark's row
    // order — clusterRows groups by Y only, so a row's items keep their original page-insertion
    // order, which reads as scrambled.
    const matched = rowCheckmarks
      .map((checkmark) =>
        headers.reduce((best, header) => (Math.abs(header.x - checkmark.x) < Math.abs(best.x - checkmark.x) ? header : best))
      )
      .sort((left, right) => left.x - right.x)
      .map((header) => cleanText(header.text));
    return [...new Set(matched.filter(Boolean))];
  }
  return undefined;
}

/**
 * Loads a PDF with `pdfjs-dist` (not `pdf-parse` — this needs raw positioned text items, which
 * `pdf-parse`'s public API doesn't expose) and runs `matchComplianceMatrixCertificates` against
 * every page until one matches. Callers should gate this behind `textHasComplianceMatrixGlyphs` on
 * text they've already extracted, so the PDF is only opened a second time for documents that
 * actually use this layout.
 */
export async function extractComplianceMatrixAttributes(
  data: Uint8Array,
  catalogNumber: string,
  sourceUrl: string
): Promise<AttributeRecord[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const items: PositionedTextItem[] = [];
        for (const item of content.items) {
          if (typeof (item as { str?: unknown }).str !== "string") continue;
          const textItem = item as { str: string; transform: number[] };
          items.push({ text: textItem.str, x: textItem.transform[4], y: textItem.transform[5] });
        }
        if (!items.some((item) => isGlyphCell(item.text))) continue;
        const labels = matchComplianceMatrixCertificates(items, catalogNumber);
        if (labels?.length) {
          return [
            {
              group: "PDF Compliance Matrix",
              name: "Certifications",
              value: labels.join(", "),
              sourceUrl,
              sourceType: "official",
              parser: "pdf-compliance-matrix",
              confidence: 0.88
            }
          ];
        }
      } finally {
        page.cleanup();
      }
    }
    return [];
  } finally {
    await doc.destroy();
  }
}
