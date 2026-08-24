import { compactCatalogNumber } from "./catalog-number.js";
import { cleanText } from "./normalizer.js";
import { isCatalogIdHeaderCell } from "./catalog-table-vocabulary.js";

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
  /** Quantized text baseline direction from PDF.js' transform matrix, when available. */
  orientation?: 0 | 90 | 180 | 270;
}

type PositionedOrientation = NonNullable<PositionedTextItem["orientation"]>;

/** Derive a stable quarter-turn from PDF.js' [a, b, c, d, e, f] text transform. */
export function positionedItemOrientationFromTransform(transform: readonly number[]): PositionedOrientation {
  const [a = 1, b = 0, c = 0, d = 1] = transform;
  // PDF text normally advances along (a,b); some fonts expose the perpendicular basis more
  // reliably, so fall back to (-c,-d) rather than treating a zero-length vector as horizontal.
  const [vx, vy] = Math.hypot(a, b) >= Math.hypot(c, d) ? [a, b] : [-c, -d];
  const angle = ((Math.round(Math.atan2(vy, vx) * 180 / Math.PI / 90) * 90) % 360 + 360) % 360;
  return angle === 90 || angle === 180 || angle === 270 ? angle : 0;
}

/**
 * Put a whole rotated page back into the reader's ordinary x-right/y-up coordinate system.
 *
 * A page whose predominant text direction is vertical is a rotated table, not a signal to mix
 * its few vertical header cells with unrelated horizontal prose. Therefore we only rotate when
 * a non-zero direction is dominant; mixed-orientation pages stay untouched and safely silent.
 */
export function normalizeDominantPageOrientation(items: PositionedTextItem[]): PositionedTextItem[] {
  const counts = new Map<PositionedOrientation, number>();
  for (const item of items) counts.set(item.orientation ?? 0, (counts.get(item.orientation ?? 0) ?? 0) + 1);
  const [orientation, count] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0] ?? [0, 0];
  if (orientation === 0 || count * 2 < items.length) return items;
  return items.map((item) => {
    const { x, y, orientation: _orientation, ...rest } = item;
    if (orientation === 90) return { ...rest, x: y, y: -x };
    if (orientation === 180) return { ...rest, x: -x, y: -y };
    return { ...rest, x: -y, y: x };
  });
}

/**
 * A landscape table may keep its body horizontal while rotating only the narrow SKU headers.
 * Project that header layer only when it contains multiple variant tokens; a lone vertical note
 * is not sufficient evidence to reinterpret page coordinates.
 */
export function normalizeMixedHeaderOrientation(items: PositionedTextItem[]): PositionedTextItem[] {
  const normalized = normalizeDominantPageOrientation(items);
  if (normalized !== items) return normalized;
  const orientations: PositionedOrientation[] = [90, 180, 270];
  const headerOrientation = orientations.find((orientation) =>
    items.filter((item) => item.orientation === orientation && hasVariantToken(item.text)).length >= 2
  );
  if (!headerOrientation) return items;
  return items.map((item) => {
    if (item.orientation !== headerOrientation) return item;
    const { x, y, orientation: _orientation, ...rest } = item;
    if (headerOrientation === 90) return { ...rest, x: y, y: -x };
    if (headerOrientation === 180) return { ...rest, x: -x, y: -y };
    return { ...rest, x: -y, y: x };
  });
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

export interface PositionedTableGeometry {
  columnXTolerance: number;
  headerWrapMaxHeight: number;
  labelColumnMargin: number;
  labelColumnTolerance: number;
  valueYWindow: number;
  sameRowSlack: number;
  headerRowYTolerance: number;
  labelMergeYGap: number;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Derive tolerances from the current PDF page instead of assuming Rockwell's point scale.
 * Variant-token columns give a strong x signal; rendered line baselines give the y scale. Both
 * retain proven defaults when the page does not expose enough geometry to measure safely.
 */
export function derivePositionedTableGeometry(items: PositionedTextItem[]): PositionedTableGeometry {
  const yValues = [...new Set(items.map((item) => item.y))].sort((left, right) => left - right);
  const rowGap = median(yValues.slice(1).map((value, index) => value - yValues[index]).filter((gap) => gap >= 3));
  // Geometry needs only whole-cell SKU tokens.  Broad token splitting is reserved for matching a
  // coalesced header cell; including prose such as AC/DC here would distort every page's measured
  // column tolerance.
  const variantXs = clusterByCoordinate(items.filter((item) => isVariantToken(item.text)).map((item) => item.x), 3);
  const columnGap = median(variantXs.slice(1).map((value, index) => value - variantXs[index]).filter((gap) => gap >= 8));
  const line = rowGap ? clamp(rowGap, 4, 20) : undefined;
  return {
    columnXTolerance: columnGap ? clamp(columnGap * 0.4, 4, COLUMN_X_TOLERANCE) : COLUMN_X_TOLERANCE,
    headerWrapMaxHeight: line ? clamp(line * 12, 40, HEADER_WRAP_MAX_HEIGHT) : HEADER_WRAP_MAX_HEIGHT,
    labelColumnMargin: columnGap ? clamp(columnGap * 0.25, 8, LABEL_COLUMN_MARGIN) : LABEL_COLUMN_MARGIN,
    labelColumnTolerance: columnGap ? clamp(columnGap * 0.2, 5, LABEL_COLUMN_TOLERANCE) : LABEL_COLUMN_TOLERANCE,
    valueYWindow: line ? clamp(line * 1.25, 5, VALUE_Y_WINDOW) : VALUE_Y_WINDOW,
    sameRowSlack: line ? clamp(line * 0.25, 1, SAME_ROW_SLACK) : SAME_ROW_SLACK,
    headerRowYTolerance: line ? clamp(line * 0.375, 1.5, HEADER_ROW_Y_TOLERANCE) : HEADER_ROW_Y_TOLERANCE,
    labelMergeYGap: line ? clamp(line * 0.75, 3, LABEL_MERGE_Y_GAP) : LABEL_MERGE_Y_GAP
  };
}

function isVariantToken(text: string): boolean {
  return CATALOG_LIKE_TOKEN_PATTERN.test(text.trim());
}

/** PDF.js can coalesce a shared header cell into one string (`1769-PB4, 1769-PB4K`). */
function variantTokens(text: string): string[] {
  const trimmed = text.trim();
  if (isVariantToken(trimmed)) return [trimmed];
  // Only split an explicitly coalesced header cell. Searching arbitrary prose for catalog-shaped
  // substrings makes an incidental model mention look like a second header column.
  if (!/[,;|\n]/.test(trimmed)) return [];
  const tokens = trimmed.match(/[A-Z0-9]{2,}(?:[-:\/.][A-Z0-9]+)+|[A-Z]{2,}\d{3,}/gi) ?? [];
  return tokens.filter(isVariantToken);
}

function hasVariantToken(text: string): boolean {
  return variantTokens(text).length > 0;
}

/**
 * Some comparison matrices label their left-most, row-name column simply "Attribute" instead of
 * "Catalog Number".  It is an equally useful x/y anchor only when the same baseline also proves
 * a target variant column; keep it separate from `isCatalogIdHeaderCell`, whose stricter meaning
 * is still required for row-oriented ordering tables.
 */
function isComparisonMatrixLabelHeaderCell(text: string): boolean {
  return isCatalogIdHeaderCell(text) || /^(?:attribute|parameter|characteristic)s?\s*[:.]?$/i.test(cleanText(text));
}

/** True only for the inverse row-oriented shape: properties left, catalog identifier at far right. */
function hasTrailingCatalogHeader(items: PositionedTextItem[]): boolean {
  const geometry = derivePositionedTableGeometry(items);
  return clusterItemsByY(items, geometry.headerRowYTolerance).some((row) => {
    const idHeader = row.find((item) => isCatalogIdHeaderCell(item.text));
    return Boolean(idHeader) && idHeader!.x >= Math.max(...row.map((item) => item.x)) - geometry.labelColumnTolerance;
  });
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

interface HeaderAnchor {
  x: number;
  y: number;
}

interface MatchedColumn {
  columnXs: number[];
  ourColumnIndex: number;
  ourColumnX: number;
  /** A wide SKU header can span several certification subcolumns. When proven by the gap to
   * neighbouring SKU headers, retain the target panel rather than a single centered x. */
  valueXMin?: number;
  valueXMax?: number;
  anchor: HeaderAnchor;
  nextAnchor: HeaderAnchor | undefined;
}

/** Sibling variant tokens on one visual header row share a y within a couple of points of jitter. */
const HEADER_ROW_Y_TOLERANCE = 3;

function clusterItemsByY(items: PositionedTextItem[], tolerance: number): PositionedTextItem[][] {
  const sorted = [...items].sort((left, right) => right.y - left.y);
  const clusters: PositionedTextItem[][] = [];
  for (const item of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && last[last.length - 1].y - item.y <= tolerance) last.push(item);
    else clusters.push([item]);
  }
  return clusters;
}

/** Leftmost row-label column x within (bottomY, topY) — the column where labels like "Weight",
 * "W x H x D", "Spannung" live. Clusters candidate label x's and returns the leftmost cluster's
 * mean. Value cells can also read as label fragments (they contain unit words like "g"/"lb"), but
 * they sit further right than the real label column, so the leftmost cluster is still the labels. */
function leftmostLabelColumnX(
  meaningful: PositionedTextItem[],
  topY: number,
  bottomY: number | undefined,
  geometry: PositionedTableGeometry = derivePositionedTableGeometry(meaningful)
): number | undefined {
  const labels = meaningful.filter(
    (item) => item.y < topY && (bottomY === undefined || item.y > bottomY) && isLabelFragment(item.text)
  );
  if (!labels.length) return undefined;
  const xs = clusterByCoordinate(
    labels.map((item) => item.x),
    geometry.columnXTolerance
  );
  return xs.length ? Math.min(...xs) : undefined;
}

/**
 * Locates the header anchor(s) — {label-column x, header-row y} — for every ordering table on a
 * page. A strong, unambiguous id-column label ("Catalog Number", "Bestell-Nr.", "Référence", ...)
 * gives a precise anchor directly. Tables whose id column carries a weak/ambiguous label ("Type",
 * "Model") or none at all instead get a SYNTHESIZED anchor: the header ROW is the y-cluster of >=2
 * sibling variant tokens (a real comparison header always lists several model codes side by side),
 * and the label column is the leftmost row-label column below it. This is what lets the positioned
 * reader work for every manufacturer's family datasheet, not just those that happen to print the
 * literal words "Catalog Number" (Rockwell) — the reader keys on data we always have (our own
 * catalog number appearing as a column) rather than a vendor-specific header label.
 */
function candidateHeaderAnchors(
  meaningful: PositionedTextItem[],
  geometry: PositionedTableGeometry = derivePositionedTableGeometry(meaningful)
): HeaderAnchor[] {
  const idLabels = meaningful.filter((item) => isComparisonMatrixLabelHeaderCell(item.text)).sort((left, right) => right.y - left.y);
  // A synthesized comparison header must look like an actual ordering identifier, not merely a
  // slash-separated unit/value. In particular, repeated `AC/DC` cells on the 1492-J3 voltage row
  // previously formed a fake header below the real J3/J4/J6 header and cut off Maximum Current.
  const variantItems = meaningful.filter((item) => hasVariantToken(item.text) && /\d/.test(item.text));
  const rowYs = clusterItemsByY(variantItems, geometry.headerRowYTolerance)
    .filter((cluster) => cluster.length >= 2)
    .map((cluster) => Math.min(...cluster.map((item) => item.y)))
    .sort((left, right) => right - left);
  const highestExplicitHeaderY = idLabels.length ? Math.max(...idLabels.map((item) => item.y)) : undefined;
  const anchors: HeaderAnchor[] = idLabels.map((item) => ({ x: item.x, y: item.y }));
  for (let index = 0; index < rowYs.length; index += 1) {
    // An explicit Cat. No. table lower on the page must not make us blind to a preceding
    // headerless comparison grid. Conversely, a synthesized row inside or below that explicit
    // table is too ambiguous (often an ordering-code body row), so the named header retains
    // priority there. The 1492-J3/J4/J6 family sheet has exactly this top-grid + lower-ordering
    // shape.
    if (highestExplicitHeaderY !== undefined && rowYs[index] <= highestExplicitHeaderY + geometry.headerRowYTolerance) continue;
    const x = leftmostLabelColumnX(meaningful, rowYs[index], rowYs[index + 1], geometry);
    if (x === undefined) continue;
    anchors.push({ x, y: rowYs[index] });
  }
  return anchors.sort((left, right) => right.y - left.y);
}

/** A tolerant fallback for when a header's printed text isn't byte-for-byte identical to the
 * catalog number (e.g. a trailing footnote marker like "1606-XLE120B(1)" compacts to
 * "1606xle120b1", one digit longer than the catalog itself) — WITHOUT reopening the exact
 * sibling-prefix collision this module exists to avoid. Confirmed live: "1606-XLE240ERL" has no
 * header of its own on an EARLIER page that happens to also contain "1606-XLE240E" (a genuinely
 * different, shorter sibling catalog and a strict prefix of "1606-XLE240ERL") — the old unconditional
 * `token.includes(x) || x.includes(token)` check treated that prefix relationship as a match and
 * returned that wrong page's WRONG column (Adjustment Range "24…28V" instead of the correct
 * "Fixed", among others) before ever reaching the correct page later in the document where
 * "1606-XLE240ERL" is an exact header. A genuine Rockwell sibling suffix is always alphabetic (EC,
 * EL, EH, EN, EE, ERL, ...) — a footnote-marker remainder is always purely numeric — so only
 * tolerate a purely-digit remainder between the shorter and longer compacted strings. */
function isBoundarySafeFallbackMatch(token: string, compactCatalog: string): boolean {
  if (token.length < 3) return false;
  if (token === compactCatalog) return true;
  const [shorter, longer] = token.length < compactCatalog.length ? [token, compactCatalog] : [compactCatalog, token];
  if (!longer.startsWith(shorter)) return false;
  return /^[0-9]*$/.test(longer.slice(shorter.length));
}

/** A sparse comparison grid has one cell per SKU column even when its columns are visually far
 * apart. Treat it as a multi-cell SKU panel only when the proposed panel actually contains a row
 * of several numeric subcells, as in the certification columns beneath 1492-J3/J4/J6. */
function hasDenseNumericSubcolumns(
  meaningful: PositionedTextItem[],
  anchor: HeaderAnchor,
  nextAnchor: HeaderAnchor | undefined,
  valueXMin: number,
  valueXMax: number | undefined,
  geometry: PositionedTableGeometry
): boolean {
  const candidates = meaningful.filter(
    (item) =>
      item.y < anchor.y &&
      (!nextAnchor || item.y > nextAnchor.y) &&
      item.x >= valueXMin &&
      (valueXMax === undefined || item.x < valueXMax) &&
      /\d/.test(item.text)
  );
  return clusterItemsByY(candidates, geometry.headerRowYTolerance)
    .some((baseline) => baseline.length >= 3);
}

function matchColumnForCatalog(
  meaningful: PositionedTextItem[],
  catalogNumber: string,
  geometry: PositionedTableGeometry = derivePositionedTableGeometry(meaningful)
): MatchedColumn | undefined {
  const compactCatalog = compactCatalogNumber(catalogNumber);
  if (!compactCatalog) return undefined;

  const anchors = candidateHeaderAnchors(meaningful, geometry);

  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
    const anchor = anchors[anchorIndex];
    // A landscape page can contain two independent tables whose id headers share the SAME visual
    // line. Such an anchor is a horizontal neighbour, not this table's lower boundary; using it
    // would require every data row to be both below and above the same y coordinate. Only a
    // genuinely lower header ends this table's vertical span.
    const nextAnchor = anchors.slice(anchorIndex + 1).find((candidate) => candidate.y < anchor.y - geometry.headerRowYTolerance);

    const headerItems = meaningful.filter(
      (item) =>
        // A name sharing the anchor's own visual row can have a y a fraction of a point below it
        // (confirmed live: "1606-XLE192BDM" at y=614.756 vs the "Catalog Number" anchor's own
        // y=614.76, on the SAME printed line) — a strict >= excluded it entirely. SAME_ROW_SLACK
        // absorbs that without reaching far enough to catch a genuinely different, lower row.
        item.y >= anchor.y - geometry.sameRowSlack &&
        item.y <= anchor.y + geometry.headerWrapMaxHeight &&
        item.x > anchor.x + geometry.labelColumnMargin &&
        hasVariantToken(item.text)
    );
    if (!headerItems.length) continue;

    const columnXs = clusterByCoordinate(
      headerItems.map((item) => item.x),
      geometry.columnXTolerance
    );

    // Prefer exact header matches; only fall back to the boundary-safe fuzzy match when no header
    // is byte-for-byte our catalog. Merged siblings printed at the same x collapse to ONE column
    // index — expected. But if our catalog matches header names in TWO genuinely different columns,
    // we cannot tell which is ours: refuse to guess (skip this anchor) rather than pick one and
    // risk returning a wrong column's values. Silence beats a confidently wrong value.
    const exactItems = headerItems.filter((item) => variantTokens(item.text).some((token) => compactCatalogNumber(token) === compactCatalog));
    const candidates = exactItems.length
      ? exactItems
      : headerItems.filter((item) => variantTokens(item.text).some((token) => isBoundarySafeFallbackMatch(compactCatalogNumber(token), compactCatalog)));
    if (!candidates.length) continue;

    const columnIndices = new Set(
      candidates.map((item) => nearestIndex(item.x, columnXs, geometry.columnXTolerance)).filter((index) => index >= 0)
    );
    if (columnIndices.size !== 1) continue;
    const ourColumnIndex = [...columnIndices][0];
    const previousColumnX = columnXs[ourColumnIndex - 1];
    const nextColumnX = columnXs[ourColumnIndex + 1];
    const closestHeaderGap = Math.min(
      previousColumnX === undefined ? Infinity : columnXs[ourColumnIndex] - previousColumnX,
      nextColumnX === undefined ? Infinity : nextColumnX - columnXs[ourColumnIndex]
    );
    // A normal comparison grid has one datum near each SKU-header x. Some real pages instead
    // put several narrow certification cells below one much wider SKU panel (1492-J3/J4/J6).
    // Only widen when the nearest SKU headers are at least three normal column tolerances apart;
    // otherwise a midpoint interval would swallow an ordinary neighbouring model value.
    const proposedValueXMin = previousColumnX === undefined
      ? anchor.x + geometry.labelColumnMargin
      : (previousColumnX + columnXs[ourColumnIndex]) / 2;
    const proposedValueXMax = nextColumnX === undefined
      ? undefined
      : (columnXs[ourColumnIndex] + nextColumnX) / 2;
    const isWideHeaderPanel = Number.isFinite(closestHeaderGap) &&
      closestHeaderGap > geometry.columnXTolerance * 3 &&
      hasDenseNumericSubcolumns(meaningful, anchor, nextAnchor, proposedValueXMin, proposedValueXMax, geometry);
    const valueXMin = isWideHeaderPanel ? proposedValueXMin : undefined;
    const valueXMax = isWideHeaderPanel ? proposedValueXMax : undefined;

    return { columnXs, ourColumnIndex, ourColumnX: columnXs[ourColumnIndex], valueXMin, valueXMax, anchor, nextAnchor };
  }
  return undefined;
}

function isMatchedColumnValue(item: PositionedTextItem, match: MatchedColumn, geometry: PositionedTableGeometry): boolean {
  if (match.valueXMin !== undefined) {
    return item.x >= match.valueXMin && (match.valueXMax === undefined || item.x < match.valueXMax);
  }
  return nearestIndex(item.x, match.columnXs, geometry.columnXTolerance) === match.ourColumnIndex &&
    Math.abs(item.x - match.ourColumnX) <= geometry.columnXTolerance;
}

/** Keep the nearest visual value baseline, while retaining a closely wrapped continuation line.
 * A fixed ±10pt window is necessary for labels whose values sit a few points off-baseline, but on
 * dense tables it can otherwise collect the preceding voltage continuation and following wire row. */
function nearestValueBaseline(items: PositionedTextItem[], labelY: number, geometry: PositionedTableGeometry): PositionedTextItem[] {
  if (!items.length) return [];
  const sorted = [...items].sort((left, right) => right.y - left.y);
  const baselines: PositionedTextItem[][] = [];
  for (const item of sorted) {
    const current = baselines[baselines.length - 1];
    if (current && current.at(-1)!.y - item.y <= geometry.labelMergeYGap) current.push(item);
    else baselines.push([item]);
  }
  return baselines
    .map((baseline) => ({ baseline, distance: Math.abs((baseline[0].y + baseline.at(-1)!.y) / 2 - labelY) }))
    .sort((left, right) => left.distance - right.distance)[0].baseline;
}

/**
 * A comparison PDF occasionally draws its final value cell across the final two SKU columns. PDF.js
 * exposes that cell only at the left column's x coordinate. Treat it as the target's value solely
 * when its nearest baseline has one datum for every preceding column and none for the target: that
 * is the exact rectangular colspan shape, not a guess from a single sibling value.
 */
function trailingMergedValueItemsForRow(
  nearbyItems: PositionedTextItem[],
  labelY: number,
  match: MatchedColumn,
  geometry: PositionedTableGeometry
): PositionedTextItem[] {
  if (match.valueXMin !== undefined || match.ourColumnIndex < 1) return [];
  const candidateItems = nearbyItems.filter((item) =>
    item.x > match.anchor.x + geometry.labelColumnMargin &&
    nearestIndex(item.x, match.columnXs, geometry.columnXTolerance) >= 0
  );
  const baseline = nearestValueBaseline(candidateItems, labelY, geometry);
  const indices = new Set(
    baseline.map((item) => nearestIndex(item.x, match.columnXs, geometry.columnXTolerance)).filter((index) => index >= 0)
  );
  const fillsEveryPrecedingColumn = indices.size === match.ourColumnIndex &&
    [...indices].every((index) => index >= 0 && index < match.ourColumnIndex);
  if (!fillsEveryPrecedingColumn) return [];
  return baseline.filter((item) => nearestIndex(item.x, match.columnXs, geometry.columnXTolerance) === match.ourColumnIndex - 1);
}

/** Reuse a preceding comparison-table header only when the current page independently exposes a
 * left-hand label column. The retained header supplies the target's x column; the current page
 * supplies the y geometry, so its data rows never get compared to coordinates from another page. */
function matchColumnFromCarriedHeader(
  meaningful: PositionedTextItem[],
  catalogNumber: string,
  carriedHeaderItems: PositionedTextItem[]
): MatchedColumn | undefined {
  if (!carriedHeaderItems.length || !meaningful.length) return undefined;
  const carried = matchColumnForCatalog(carriedHeaderItems, catalogNumber);
  if (!carried) return undefined;
  const topY = Math.max(...meaningful.map((item) => item.y)) + 1;
  const labelColumnX = leftmostLabelColumnX(meaningful, topY, undefined);
  if (labelColumnX === undefined) return undefined;
  return { ...carried, anchor: { x: labelColumnX, y: topY }, nextAnchor: undefined };
}

/** Finds every occurrence of a row label (e.g. "Weight") below the matched table's header, and
 * for each one gathers this catalog's column value(s) within VALUE_Y_WINDOW points of it — wide
 * enough to catch a wrapped second value line (metric + imperial units) without reaching into a
 * neighboring, unrelated spec row. Returns the first occurrence with a non-empty value. */
function findLabeledColumnValue(
  meaningful: PositionedTextItem[],
  match: MatchedColumn,
  labelPattern: RegExp,
  geometry: PositionedTableGeometry
): string | undefined {
  const labelItems = meaningful.filter(
    (item) =>
      item.y < match.anchor.y &&
      (!match.nextAnchor || item.y > match.nextAnchor.y) &&
      Math.abs(item.x - match.anchor.x) <= geometry.labelColumnTolerance &&
      labelPattern.test(item.text.trim())
  );

  for (const labelItem of labelItems) {
    const nearbyValueItems = meaningful
      .filter(
        (item) =>
          Math.abs(item.y - labelItem.y) <= geometry.valueYWindow &&
          isMatchedColumnValue(item, match, geometry)
      );
    const valueItems = nearestValueBaseline(nearbyValueItems, labelItem.y, geometry)
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
  const meaningful = normalizeMixedHeaderOrientation(items).filter((item) => item.text.trim().length > 0);
  const geometry = derivePositionedTableGeometry(meaningful);
  const match = matchColumnForCatalog(meaningful, catalogNumber, geometry);
  if (!match) return undefined;

  const weight = findLabeledColumnValue(meaningful, match, /^weight$/i, geometry);
  const dimensions = findLabeledColumnValue(meaningful, match, /^w\s*x\s*h\s*x\s*d$/i, geometry);
  if (!weight && !dimensions) return undefined;
  return { weight, dimensions };
}

/** A label fragment is a bare, non-numeric line in the label column — excludes footnote markers
 * ("(1) Output transient current"), catalog-shaped tokens, and units-only continuations. */
function isLabelFragment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || isCatalogIdHeaderCell(trimmed)) return false;
  if (hasVariantToken(trimmed)) return false;
  if (/^\(\d+\)/.test(trimmed)) return false;
  return /[a-z]/i.test(trimmed);
}

/** Merges label-column fragments within LABEL_MERGE_Y_GAP of each other into one logical row
 * label — some labels wrap across 2 physical lines ("Temperature Range," / "Operating",
 * "Ripple and Noise Max" / "[mVPP]"). */
const LABEL_MERGE_Y_GAP = 6;

function clusterLabelFragments(
  labelItems: PositionedTextItem[],
  geometry: PositionedTableGeometry
): { text: string; minY: number; maxY: number }[] {
  const sorted = [...labelItems].sort((left, right) => right.y - left.y);
  const clusters: PositionedTextItem[][] = [];
  for (const item of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && last[last.length - 1].y - item.y <= geometry.labelMergeYGap) last.push(item);
    else clusters.push([item]);
  }
  return clusters.map((cluster) => ({
    text: cleanText(cluster.map((item) => item.text).join(" ")),
    minY: Math.min(...cluster.map((item) => item.y)),
    maxY: Math.max(...cluster.map((item) => item.y))
  }));
}

/**
 * PDF producers sometimes split one logical row label horizontally, while keeping both fragments
 * before the first data column: Rockwell 1606-TD002H p.25 writes `Output` at x=47 and
 * `Current, Nom` at x=67, then starts the target's value at x=183. The left-label clustering
 * intentionally sees only x≈47, so retain a same-baseline text fragment only in the otherwise
 * empty gutter between that label column and the first visual data column. This is deliberately
 * not a general nearest-text join: a value, footnote, or another table's column must never become
 * part of a label merely because it shares a y coordinate.
 */
function withHorizontalLabelFragments(
  cluster: { text: string; minY: number; maxY: number },
  meaningful: PositionedTextItem[],
  match: MatchedColumn,
  geometry: PositionedTableGeometry
): string {
  const firstDataColumnX = match.valueXMin ?? Math.min(...match.columnXs);
  const fragments = meaningful
    .filter(
      (item) =>
        item.x > match.anchor.x + geometry.labelColumnTolerance &&
        item.x < firstDataColumnX - geometry.columnXTolerance &&
        item.y >= cluster.minY - geometry.sameRowSlack &&
        item.y <= cluster.maxY + geometry.sameRowSlack &&
        isLabelFragment(item.text)
    )
    .sort((left, right) => left.x - right.x)
    .map((item) => item.text);
  return cleanText([cluster.text, ...fragments].join(" "));
}

/**
 * General-purpose version of extractPositionedWeightAndDimensions: returns every row label found
 * in the label column paired with this catalog's own column value, for whichever rows have one.
 * Each label is looked up independently (not via sequential row reconstruction) specifically
 * because label-vs-value vertical ordering is inconsistent in this document (a row's label sits
 * ~4pt ABOVE its value in some rows, ~8pt BELOW it in others) — a per-row state machine can't
 * reliably track that, but an independent per-label window search doesn't need to.
 */
export function extractPositionedTableRows(
  items: PositionedTextItem[],
  catalogNumber: string,
  carriedHeaderItems: PositionedTextItem[] = []
): Record<string, string> | undefined {
  const meaningful = normalizeMixedHeaderOrientation(items).filter((item) => item.text.trim().length > 0);
  const geometry = derivePositionedTableGeometry(meaningful);
  const match = matchColumnForCatalog(meaningful, catalogNumber, geometry) ?? matchColumnFromCarriedHeader(meaningful, catalogNumber, carriedHeaderItems);
  if (!match) return extractPositionedOrderingRow(meaningful, catalogNumber);

  const labelItems = meaningful.filter(
    (item) =>
      item.y < match.anchor.y &&
      (!match.nextAnchor || item.y > match.nextAnchor.y) &&
      Math.abs(item.x - match.anchor.x) <= geometry.labelColumnTolerance &&
      isLabelFragment(item.text)
  );

  const rows: Record<string, string> = {};
  for (const cluster of clusterLabelFragments(labelItems, geometry)) {
    const label = withHorizontalLabelFragments(cluster, meaningful, match, geometry);
    if (!label || rows[label]) continue;
    const nearbyValueItems = meaningful
      .filter(
        (item) =>
          item.y >= cluster.minY - geometry.valueYWindow &&
          item.y <= cluster.maxY + geometry.valueYWindow &&
          isMatchedColumnValue(item, match, geometry)
      );
    const labelY = (cluster.minY + cluster.maxY) / 2;
    const valueItems = (nearbyValueItems.length
      ? nearestValueBaseline(nearbyValueItems, labelY, geometry)
      : trailingMergedValueItemsForRow(
          meaningful.filter((item) => item.y >= cluster.minY - geometry.valueYWindow && item.y <= cluster.maxY + geometry.valueYWindow),
          labelY,
          match,
          geometry
        ))
      .sort((left, right) => right.y - left.y || left.x - right.x);
    const value = cleanText(valueItems.map((item) => item.text).join(" "));
    if (value) rows[label] = value;
  }
  return Object.keys(rows).length ? rows : undefined;
}

/**
 * Row-oriented counterpart to the comparison-matrix reader. In ordering
 * tables the catalog is the first cell of one row and every following column
 * is a different property. This reader requires an exact catalog cell and
 * maps only its visual row to the immediately preceding id-header row.
 */
export function extractPositionedOrderingRow(items: PositionedTextItem[], catalogNumber: string): Record<string, string> | undefined {
  const meaningful = normalizeDominantPageOrientation(items).filter((item) => item.text.trim().length > 0);
  const geometry = derivePositionedTableGeometry(meaningful);
  const compactCatalog = compactCatalogNumber(catalogNumber);
  if (!compactCatalog) return undefined;

  // Keep the same measured baseline tolerance as comparison-header clustering. A fixed 5pt
  // window merges the first data row into the header on dense PDFs, while a page with larger
  // type still retains its own safe jitter allowance.
  const rows = clusterItemsByY(meaningful, geometry.headerRowYTolerance);
  const headerIndexes = rows
    .map((row, index) => (row.some((item) => isCatalogIdHeaderCell(item.text)) ? index : -1))
    .filter((index) => index >= 0);

  for (let headerPosition = 0; headerPosition < headerIndexes.length; headerPosition += 1) {
    const headerIndex = headerIndexes[headerPosition];
    const headerRow = rows[headerIndex];
    const idHeader = headerRow.find((item) => isCatalogIdHeaderCell(item.text));
    if (!idHeader) continue;
    // Most ordering tables put the identity column first, but accessory tables often put
    // `Cat. No.` last after the physical properties. Both shapes are safe once the same visual
    // data row contains an exact catalog cell: map only the property headers on the other side.
    const idIsTrailing = idHeader.x >= Math.max(...headerRow.map((item) => item.x)) - geometry.labelColumnTolerance;
    // A PDF often puts the first half of a wrapped column title one baseline above the line with
    // `Cat. No.` ("Tightening" / "Torque", "Dimensions" / "Width x Length x Height"). Keep
    // that local header band, but do not reach as far as a section title above the table.
    const headerBand = idIsTrailing
      ? meaningful.filter((item) => item.y >= idHeader.y - geometry.sameRowSlack && item.y <= idHeader.y + Math.min(16, geometry.headerWrapMaxHeight))
      : headerRow;
    const headers = headerBand
      .filter((item) =>
        // Reject stray punctuation/separator glyphs a dense PDF can render as their own text item
        // ("|", "-", "."), but keep a genuine single-letter column header ("A"/"B" — real Saginaw/
        // SCE floor-stand-kit footprint-dimension columns) that a plain length check used to drop.
        /[\p{L}\p{N}]/u.test(cleanText(item.text)) &&
        (idIsTrailing
          ? item.x < idHeader.x - geometry.labelColumnMargin
          : item.x > idHeader.x + geometry.labelColumnMargin)
      )
      .sort((left, right) => left.x - right.x);
    if (!headers.length) continue;

    const nextHeaderIndex = headerIndexes[headerPosition + 1] ?? rows.length;
    const dataRows = rows.slice(headerIndex + 1, nextHeaderIndex);
    for (const dataRow of dataRows) {
      // Exact compact equality is intentional: an order code often has suffix
      // siblings that share all but their last character.
      if (!dataRow.some((item) => compactCatalogNumber(item.text) === compactCatalog)) continue;
      // One visual product record can wrap its dimensions, torque or compatible-marker cells over
      // several baselines while Color/Pkg/Cat. No. stay on the middle one. Join only this narrow
      // local band around the proven target cell; only trailing-catalog tables need it. Normal
      // first-column tables can be densely typeset and must retain their individual row boundary.
      const targetCatalogItems = dataRow.filter((item) => compactCatalogNumber(item.text) === compactCatalog);
      const targetY = targetCatalogItems.reduce((sum, item) => sum + item.y, 0) / targetCatalogItems.length;
      const recordItems = idIsTrailing
        ? dataRows.flat().filter((item) => Math.abs(item.y - targetY) <= Math.max(16, geometry.valueYWindow * 1.5))
        : dataRow;
      const mapped: Record<string, string> = {};
      const headerXs = headers.map((header) => header.x);
      for (const [headerIndex, header] of headers.entries()) {
        const values = recordItems
          .filter((item) =>
            idIsTrailing
              ? nearestIndex(item.x, headerXs, Infinity) === headerIndex && item.x < idHeader.x - geometry.labelColumnMargin
              // Nearest-header-wins (capped at columnXTolerance), not a symmetric distance window:
              // a plain `Math.abs(...) <= tolerance` check double-counts a value cell into BOTH
              // neighboring headers whenever two data columns sit closer together than
              // 2x columnXTolerance (confirmed on the real Saginaw/SCE floor-stand-kit "A"/"B"
              // footprint-dimension columns, ~35pt apart with a 30pt default tolerance).
              : nearestIndex(item.x, headerXs, geometry.columnXTolerance) === headerIndex
          )
          .sort((left, right) => left.x - right.x)
          .map((item) => cleanText(item.text))
          .filter((value) => value && compactCatalogNumber(value) !== compactCatalog);
        const value = cleanText(values.join(" "));
        if (value) mapped[cleanText(header.text)] = value;
      }
      if (Object.keys(mapped).length) return mapped;
    }
  }
  return undefined;
}

/**
 * Merge continuation pages conservatively. A repeated row with the same value is
 * harmless; two different values under the same label are ambiguous without a
 * stronger page/variant signal, so the label is omitted rather than letting the
 * first matching page win by traversal order.
 */
export function mergePositionedTableRowSets(rowSets: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  const conflicted = new Set<string>();
  for (const rows of rowSets) {
    for (const [label, value] of Object.entries(rows ?? {})) {
      if (conflicted.has(label)) continue;
      if (merged[label] === undefined) {
        merged[label] = value;
      } else if (merged[label] !== value) {
        delete merged[label];
        conflicted.add(label);
      }
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

/** Cheap page pre-filter: does this page mention our catalog as a table token at all? Replaces the
 * old "does the page contain the literal words 'Catalog Number'" gate, which was Rockwell-specific
 * and skipped every other manufacturer's comparison tables. Keying on our own catalog token is both
 * cheaper and more precise — we only pay the full page reconstruction for pages that can match. */
function pageMentionsCatalog(items: PositionedTextItem[], catalogNumber: string): boolean {
  const compactCatalog = compactCatalogNumber(catalogNumber);
  if (!compactCatalog) return false;
  return items.some(
    (item) =>
      hasVariantToken(item.text) &&
      variantTokens(item.text).some((token) =>
        compactCatalogNumber(token) === compactCatalog || isBoundarySafeFallbackMatch(compactCatalogNumber(token), compactCatalog)
      )
  );
}

/**
 * Loads a PDF with `pdfjs-dist` and runs `extractPositionedTableRows` against every matching page,
 * merging continuation-page fields conservatively — the general-purpose counterpart to extractPositionedWeightAndDimensionsFromPdf below,
 * returning every row label found for this catalog's column (Voltage, Current, Power, Efficiency,
 * MTBF, Temperature Range, Connection Terminals, ... in addition to Weight/Dimensions).
 */
export async function extractPositionedTableRowsFromPdf(data: Uint8Array, catalogNumber: string): Promise<Record<string, string> | undefined> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  try {
    const rowSets: Array<Record<string, string> | undefined> = [];
    // A comparison table commonly prints its multi-model header only on the first page. Keep it
    // only for a page without a new catalog header; a non-matching page drops it immediately so
    // an unrelated later table cannot inherit an old column assignment. In particular, a fresh
    // `Catalog Number` header is structural evidence of a new table even when its page happens to
    // have plausible data at the old x coordinates (Rockwell 1606-TD002H p.26+ follows the target
    // table on p.25 with different product families and otherwise leaks their currents into it).
    let carriedHeaderItems: PositionedTextItem[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const items: PositionedTextItem[] = [];
        for (const item of content.items) {
          if (typeof (item as { str?: unknown }).str !== "string") continue;
          const textItem = item as { str: string; transform: number[] };
          items.push({ text: textItem.str, x: textItem.transform[4], y: textItem.transform[5], orientation: positionedItemOrientationFromTransform(textItem.transform) });
        }
        const orientedItems = normalizeDominantPageOrientation(items);
        const hasOwnTargetHeader = Boolean(matchColumnForCatalog(orientedItems, catalogNumber));
        const hasNewCatalogHeader = orientedItems.some((item) => isComparisonMatrixLabelHeaderCell(item.text));
        let result: Record<string, string> | undefined;
        if (hasOwnTargetHeader) {
          carriedHeaderItems = orientedItems;
          result = extractPositionedTableRows(orientedItems, catalogNumber);
        } else if (carriedHeaderItems.length && !hasNewCatalogHeader) {
          result = extractPositionedTableRows(orientedItems, catalogNumber, carriedHeaderItems);
          if (!result) carriedHeaderItems = [];
        } else if (hasNewCatalogHeader) {
          carriedHeaderItems = [];
          // A row-oriented table may put its id column at either edge. The trailing shape needs
          // extractPositionedOrderingRow directly; a leading id column (e.g. "PART #" / "Catalog
          // Number" as the first column, one row per catalog) is the shape extractPositionedTableRows
          // itself falls back to internally once matchColumnForCatalog's comparison-matrix search
          // comes up empty, so route it there instead of silently producing nothing. Confirmed live
          // on Saginaw/SCE's "PART # / A / B" floor-stand-kit ordering table: recognizing "PART #"
          // as an id-header cell (needed for the trailing/"Cat. No." shape elsewhere) previously
          // made this branch fire for the leading-id shape too, and it had no path for that case.
          result = hasTrailingCatalogHeader(orientedItems)
            ? extractPositionedOrderingRow(orientedItems, catalogNumber)
            : extractPositionedTableRows(orientedItems, catalogNumber);
        } else if (pageMentionsCatalog(items, catalogNumber)) {
          result = extractPositionedTableRows(orientedItems, catalogNumber);
        }
        if (result) rowSets.push(result);
      } finally {
        page.cleanup();
      }
    }
    return mergePositionedTableRowSets(rowSets);
  } finally {
    await doc.destroy();
  }
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
    const results: Array<{ weight?: string; dimensions?: string } | undefined> = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const items: PositionedTextItem[] = [];
        for (const item of content.items) {
          if (typeof (item as { str?: unknown }).str !== "string") continue;
          const textItem = item as { str: string; transform: number[] };
          items.push({ text: textItem.str, x: textItem.transform[4], y: textItem.transform[5], orientation: positionedItemOrientationFromTransform(textItem.transform) });
        }
        if (!pageMentionsCatalog(items, catalogNumber)) continue;
        const result = extractPositionedWeightAndDimensions(items, catalogNumber);
        if (result) results.push(result);
      } finally {
        page.cleanup();
      }
    }
    const rows = mergePositionedTableRowSets(
      results.map((result) => result ? {
        ...(result.weight ? { weight: result.weight } : {}),
        ...(result.dimensions ? { dimensions: result.dimensions } : {})
      } : undefined)
    );
    return rows ? { ...(rows.weight ? { weight: rows.weight } : {}), ...(rows.dimensions ? { dimensions: rows.dimensions } : {}) } : undefined;
  } finally {
    await doc.destroy();
  }
}
