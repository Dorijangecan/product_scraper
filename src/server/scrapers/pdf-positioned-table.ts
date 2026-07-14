import { compactCatalogNumber } from "./catalog-number.js";
import { cleanText } from "./normalizer.js";

/**
 * Recovers Weight and Dimensions for one catalog number from a "Catalog Number" multi-model
 * comparison table using pdfjs-dist's raw positioned text items, instead of guessing from
 * pdf-parse's tab/newline heuristic (buildVariantColumnContext in tight-context.ts).
 *
 * Why this exists: Rockwell's 1606-td002 datasheet prints some tables where several catalog names
 * share ONE data column (identical electrical specs apart from a footnoted connector/coating
 * detail) — e.g. "1606-XLE120E", "1606-XLE120EC", "1606-XLE120EL", "1606-XLE120EH",
 * "1606-XLE120ED" all print in the SAME column, stacked as 5 separate header lines. Their compact
 * names don't share a common prefix ("...192BM" vs "...192BDM" diverge one character before the
 * end), so no text-based heuristic can reliably tell which names are merged siblings — confirmed
 * this produces confidently wrong answers (see buildVariantColumnContext's sanity check in
 * tight-context.ts, which now refuses these instead of guessing). But raw item POSITIONS make the
 * grouping unambiguous: merged sibling names are printed at the exact same x, one above the other
 * (confirmed live: "1606-XLE192BM" at x=194/y=623 sits directly above "1606-XLE192BDM" at x=192/
 * y=615, both distinct in x from every other column, and the actual data values below align to
 * the SAME x cluster). Clustering by x, rather than parsing tabs, recovers the table's true visual
 * column layout directly.
 *
 * Scoped narrowly to Weight/Dimensions (not a general table reader): a full row-by-row
 * reconstruction ran into inconsistent label-vs-value vertical ordering in this document (a row's
 * label sometimes sits ~4pt above its value, sometimes ~8pt below it) that a generic per-row state
 * machine couldn't reliably resolve. Weight/Dimensions rows are simple enough to find directly by
 * label text and gather every matching-column value within a generous y-window around it, without
 * needing to reconstruct every row in between.
 */

export interface PositionedTextItem {
  text: string;
  x: number;
  y: number;
}

/** Header names and their column's own data values are NOT printed at the same x — values sit
 * ~13-18pt further right than the header label above them in the real PDF (confirmed live: header
 * "1606-XLE120B" at x=124, but that column's "12V"/"10 A" data values sit at x=139) — likely
 * because values are laid out with a small fixed cell padding the (longer, wrapped) header names
 * don't share. Columns themselves are ~65-95pt apart, so a tolerance this wide still can't confuse
 * two different columns. */
const COLUMN_X_TOLERANCE = 30;
/** How far above (or at) the "Catalog Number" label's own y a wrapped header name can sit and
 * still count as part of THIS table's header (rather than trailing content from whatever came
 * before it on the page). Comfortably covers the deepest wrap seen (5 stacked names, ~32pt) with
 * margin, without reaching far enough to plausibly catch an unrelated preceding paragraph. */
const HEADER_WRAP_MAX_HEIGHT = 100;
/** How far right of the label column's own x a header name must sit to count as a data column
 * (excludes the "Catalog Number" label text itself). */
const LABEL_COLUMN_MARGIN = 20;
/** Anything within this of the label column's own x still counts as "the label column". */
const LABEL_COLUMN_TOLERANCE = 15;
/** A labeled row's own value(s) — including a second wrapped line (e.g. Dimensions' metric line
 * plus its imperial-unit continuation) — sit within this many points of the label's own y, in
 * EITHER direction (confirmed live: "Weight"'s value sits ~8pt above it; "Output Voltage, Nom"'s
 * sits ~4pt below it). Small enough that it can't reach into an adjacent, unrelated spec row
 * (~12-15pt further away). */
const VALUE_Y_WINDOW = 10;
/** Sub-point y jitter tolerance for items sharing the anchor's own visual row (see headerItems'
 * filter below). */
const SAME_ROW_SLACK = 2;
const CATALOG_LIKE_TOKEN_PATTERN = /^[A-Z0-9]{2,}(?:[-:\/.][A-Z0-9]+)+$|^[A-Z]{2,}[0-9]{3,}$/i;

function isVariantToken(text: string): boolean {
  return CATALOG_LIKE_TOKEN_PATTERN.test(text.trim());
}

function clusterByCoordinate(values: number[], tolerance: number): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  const clusters: number[][] = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && value - last[last.length - 1] <= tolerance) last.push(value);
    else clusters.push([value]);
  }
  return clusters.map((cluster) => cluster.reduce((sum, value) => sum + value, 0) / cluster.length);
}

function nearestIndex(value: number, anchors: number[], maxDistance: number): number {
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < anchors.length; index += 1) {
    const distance = Math.abs(anchors[index] - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestDistance <= maxDistance ? bestIndex : -1;
}

interface MatchedColumn {
  columnXs: number[];
  ourColumnIndex: number;
  ourColumnX: number;
  anchor: PositionedTextItem;
  nextAnchor: PositionedTextItem | undefined;
}

function matchColumnForCatalog(meaningful: PositionedTextItem[], catalogNumber: string): MatchedColumn | undefined {
  const compactCatalog = compactCatalogNumber(catalogNumber);
  if (!compactCatalog) return undefined;

  const anchors = meaningful
    .filter((item) => /^catalog\s*number$/i.test(item.text.trim()))
    .sort((left, right) => right.y - left.y);

  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
    const anchor = anchors[anchorIndex];
    const nextAnchor = anchors[anchorIndex + 1];

    const headerItems = meaningful.filter(
      (item) =>
        // A name sharing the anchor's own visual row can have a y a fraction of a point below it
        // (confirmed live: "1606-XLE192BDM" at y=614.756 vs the "Catalog Number" anchor's own
        // y=614.76, on the SAME printed line) — a strict >= excluded it entirely. SAME_ROW_SLACK
        // absorbs that without reaching far enough to catch a genuinely different, lower row.
        item.y >= anchor.y - SAME_ROW_SLACK &&
        item.y <= anchor.y + HEADER_WRAP_MAX_HEIGHT &&
        item.x > anchor.x + LABEL_COLUMN_MARGIN &&
        isVariantToken(item.text)
    );
    if (!headerItems.length) continue;

    const columnXs = clusterByCoordinate(
      headerItems.map((item) => item.x),
      COLUMN_X_TOLERANCE
    );

    const exactMatch = headerItems.find((item) => compactCatalogNumber(item.text) === compactCatalog);
    const matchedItem =
      exactMatch ??
      headerItems.find((item) => {
        const token = compactCatalogNumber(item.text);
        return token.length >= 3 && (token.includes(compactCatalog) || compactCatalog.includes(token));
      });
    if (!matchedItem) continue;

    const ourColumnIndex = nearestIndex(matchedItem.x, columnXs, COLUMN_X_TOLERANCE);
    if (ourColumnIndex < 0) continue;

    return { columnXs, ourColumnIndex, ourColumnX: columnXs[ourColumnIndex], anchor, nextAnchor };
  }
  return undefined;
}

/** Finds every occurrence of a row label (e.g. "Weight") below the matched table's header, and
 * for each one gathers this catalog's column value(s) within VALUE_Y_WINDOW points of it — wide
 * enough to catch a wrapped second value line (metric + imperial units) without reaching into a
 * neighboring, unrelated spec row. Returns the first occurrence with a non-empty value. */
function findLabeledColumnValue(meaningful: PositionedTextItem[], match: MatchedColumn, labelPattern: RegExp): string | undefined {
  const labelItems = meaningful.filter(
    (item) =>
      item.y < match.anchor.y &&
      (!match.nextAnchor || item.y > match.nextAnchor.y) &&
      Math.abs(item.x - match.anchor.x) <= LABEL_COLUMN_TOLERANCE &&
      labelPattern.test(item.text.trim())
  );

  for (const labelItem of labelItems) {
    const valueItems = meaningful
      .filter(
        (item) =>
          Math.abs(item.y - labelItem.y) <= VALUE_Y_WINDOW &&
          nearestIndex(item.x, match.columnXs, COLUMN_X_TOLERANCE) === match.ourColumnIndex &&
          Math.abs(item.x - match.ourColumnX) <= COLUMN_X_TOLERANCE
      )
      .sort((left, right) => right.y - left.y || left.x - right.x);
    const value = cleanText(valueItems.map((item) => item.text).join(" "));
    if (value) return value;
  }
  return undefined;
}

/**
 * Pure matching logic (no PDF library) — given every positioned text item on ONE page and a
 * target catalog number, returns that catalog's Weight and/or Dimensions from a matched "Catalog
 * Number" table, or undefined if this page has no table mentioning the catalog at all.
 */
export function extractPositionedWeightAndDimensions(
  items: PositionedTextItem[],
  catalogNumber: string
): { weight?: string; dimensions?: string } | undefined {
  const meaningful = items.filter((item) => item.text.trim().length > 0);
  const match = matchColumnForCatalog(meaningful, catalogNumber);
  if (!match) return undefined;

  const weight = findLabeledColumnValue(meaningful, match, /^weight$/i);
  const dimensions = findLabeledColumnValue(meaningful, match, /^w\s*x\s*h\s*x\s*d$/i);
  if (!weight && !dimensions) return undefined;
  return { weight, dimensions };
}

/**
 * Loads a PDF with `pdfjs-dist` and runs `extractPositionedWeightAndDimensions` against every page
 * until one matches. Mirrors extractComplianceMatrixAttributes's loading pattern in
 * pdf-compliance-matrix.ts.
 */
export async function extractPositionedWeightAndDimensionsFromPdf(
  data: Uint8Array,
  catalogNumber: string
): Promise<{ weight?: string; dimensions?: string } | undefined> {
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
        if (!items.some((item) => /^catalog\s*number$/i.test(item.text.trim()))) continue;
        const result = extractPositionedWeightAndDimensions(items, catalogNumber);
        if (result) return result;
      } finally {
        page.cleanup();
      }
    }
    return undefined;
  } finally {
    await doc.destroy();
  }
}
