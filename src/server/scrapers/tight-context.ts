import { catalogTextMatches } from "./catalog-number.js";

/**
 * Narrow a block of PDF text down to the lines that belong to ONE catalog number.
 *
 * Many manufacturer PDFs (Rockwell 1783-tdNNN, Eaton multi-model catalogs, customer-
 * supplied datasheets) place specs for several products on the same page — usually as
 * a comparison table with one column per model. Per-page extraction without this
 * scoping returns whichever value appears first on a shared row ("Power input ... 7.991
 * 8.5 6.2 ..."), so every catalog inherits the same number from the leftmost product.
 *
 * Strategy: walk the text line-by-line, keep lines that mention OUR catalog plus a
 * small window around them, and stop expanding at any line that names a different
 * catalog-shaped token. That preserves "label rows" (Power input, Weight, ...) which
 * don't name any catalog and live just above the value rows, while cutting at the
 * sibling product's row.
 *
 * Returns the original text when no catalog mention is found (caller falls back to the
 * wider window so we don't accidentally throw away ALL extraction).
 */
const LINE_WINDOW_BEFORE_DEFAULT = 6;
const LINE_WINDOW_AFTER_DEFAULT = 18;
const CATALOG_LIKE_TOKEN_PATTERN = /\b[A-Z0-9]{2,}(?:[-:\/.][A-Z0-9]+)+\b|\b[A-Z]{2,}[0-9]{3,}\b/i;

export function buildTightContextForCatalog(
  text: string,
  catalogNumber: string,
  options: { maxChars?: number; before?: number; after?: number } = {}
): string | undefined {
  const allLines = text.split(/\r?\n/);
  if (allLines.length === 0) return undefined;
  const compactCatalog = compactKey(catalogNumber);
  if (!compactCatalog) return undefined;

  const before = options.before ?? LINE_WINDOW_BEFORE_DEFAULT;
  const after = options.after ?? LINE_WINDOW_AFTER_DEFAULT;

  const lineMatchesCatalog = (line: string) =>
    compactKey(line).includes(compactCatalog) || catalogTextMatches(line, catalogNumber);

  const isDifferentCatalogLine = (line: string): boolean => {
    if (lineMatchesCatalog(line)) return false;
    const tokens = line.match(new RegExp(CATALOG_LIKE_TOKEN_PATTERN, "gi"));
    if (!tokens) return false;
    return tokens.some((token) => {
      const compactToken = compactKey(token);
      // A real catalog/type code always carries at least one digit (e.g. "EIS-40/1",
      // "CBE04417", "DFS4-125"). Without this check, plain hyphenated English compound words
      // that happen to fit the letters-plus-separator shape ("cross-section", "back-of-hand")
      // false-positived as "a different product's model number," breaking the forward/backward
      // window expansion early and orphaning the real value 1-2 lines further down a single-model
      // datasheet (confirmed on Doepke's "max. Connection C1 Number of conductors per terminal" —
      // the window broke on "cross-section" right before reaching the real value line, so a
      // later, unrelated fact filled the gap once the window was re-sorted by line index).
      return compactToken.length >= 4 && compactToken !== compactCatalog && /\d/.test(compactToken);
    });
  };

  const kept = new Set<number>();
  for (let index = 0; index < allLines.length; index += 1) {
    if (!lineMatchesCatalog(allLines[index])) continue;
    kept.add(index);
    for (let offset = 1; offset <= before; offset += 1) {
      const target = index - offset;
      if (target < 0) break;
      if (isDifferentCatalogLine(allLines[target]) && !isOrderingTableCompanionLine(allLines[target], allLines[index], offset)) break;
      kept.add(target);
    }
    for (let offset = 1; offset <= after; offset += 1) {
      const target = index + offset;
      if (target >= allLines.length) break;
      if (isDifferentCatalogLine(allLines[target])) break;
      kept.add(target);
    }
    keepOrderingParentRatingRow(allLines, index, kept);
  }

  if (kept.size === 0) return undefined;
  const out = [...kept]
    .sort((left, right) => left - right)
    .map((index) => allLines[index])
    .join("\n");
  return options.maxChars ? out.slice(0, options.maxChars) : out;
}

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function splitTableCells(line: string): string[] {
  return line
    .split(/\t+|\s{2,}/)
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function isVariantToken(cell: string): boolean {
  // A catalog/type-code-shaped token (e.g. "EIS-40/1", "CBE04417") — but not a bare number or unit.
  return new RegExp(`^(?:${CATALOG_LIKE_TOKEN_PATTERN.source})$`, "i").test(cell);
}

/** A decimal value with a unit suffix ("22.5V", "0.32 kWs") — CATALOG_LIKE_TOKEN_PATTERN's "digits,
 * separator, alnum" shape also matches these (the decimal point counts as the separator), but they
 * are spec data, not a model/catalog code. */
function isMeasurementWithUnit(cell: string): boolean {
  return /^-?\d+(?:\.\d+)?\s*(?:V|A|W|VA|Hz|kh|kWs|Wh|Ah|mm|cm|in|min|ms|°?[CF]|lb|kg|g)\b/i.test(cell.trim());
}

function variantCellPositions(cells: string[]): number[] {
  return cells.map((cell, index) => (isVariantToken(cell) ? index : -1)).filter((index) => index >= 0);
}

function keepOrderingParentRatingRow(lines: string[], catalogIndex: number, kept: Set<number>) {
  const previous = lines[catalogIndex - 1];
  if (!previous || !isOrderingModelRow(previous) || orderingRowHasRatingPrefix(previous)) return;
  for (let index = catalogIndex - 2; index >= Math.max(0, catalogIndex - 12); index -= 1) {
    if (!isOrderingModelRow(lines[index])) continue;
    if (!orderingRowHasRatingPrefix(lines[index])) continue;
    kept.add(index);
    return;
  }
}

function isOrderingModelRow(line: string): boolean {
  return variantCellPositions(splitTableCells(line)).length >= 2;
}

function orderingRowHasRatingPrefix(line: string): boolean {
  const cells = splitTableCells(line);
  const positions = variantCellPositions(cells);
  if (positions.length < 2) return false;
  const prefix = cells.slice(0, positions[0]).join(" ");
  const numbers = prefix.split(/\s+/).filter((token) => /^-?\d+(?:[.,]\d+)?$/.test(token));
  return numbers.length >= 2;
}

function isOrderingTableCompanionLine(candidate: string, catalogLine: string, offset: number): boolean {
  if (offset > 1) return false;
  const catalogCells = splitTableCells(catalogLine);
  const candidateCells = splitTableCells(candidate);
  const catalogVariants = variantCellPositions(catalogCells);
  const candidateVariants = variantCellPositions(candidateCells);
  if (catalogVariants.length < 2 || candidateVariants.length < 2) return false;
  if (candidateVariants.length < catalogVariants.length) return false;
  const prefix = candidateCells.slice(0, candidateVariants[0]).join(" ");
  return /\d/.test(prefix) || /\b(?:AC|DC)\s*\d|\d+\s*V\b/i.test(prefix);
}

/**
 * Select the correct COLUMN for one catalog number from a multi-variant comparison table
 * (workstream C). Many datasheets list several type codes across a header row and one value
 * per column on each spec row ("Weight  0.08  0.16  0.24"). Plain per-line extraction takes the
 * leftmost value for every variant; this finds the header column whose token matches our catalog
 * and rewrites each aligned spec row to "Label: <our column's value>".
 *
 * Intentionally conservative: only fires when a header row lists >=2 variant tokens including
 * ours, and only rewrites rows whose cell count matches the header. Returns undefined otherwise,
 * so the caller falls back to line-window scoping and nothing changes for non-tabular PDFs.
 */
export function buildVariantColumnContext(
  text: string,
  catalogNumber: string,
  options: { maxChars?: number } = {}
): string | undefined {
  const compactCatalog = compactKey(catalogNumber);
  if (!compactCatalog) return undefined;
  const lines = text.split(/\r?\n/);

  let headerIndex = -1;
  let headerCellCount = 0;
  let firstVariant = 0;
  let ourOrdinal = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitTableCells(lines[index]);
    if (cells.length < 3) continue;
    const positions = variantCellPositions(cells);
    if (positions.length < 2) continue;
    // Prefer an EXACT compact match over a loose substring one, and check every position instead
    // of stopping at the first candidate — "1606-XLE480FP" is a strict prefix of the (different,
    // real) sibling "1606-XLE480FP-D", so a plain first-match substring scan for "-D" always
    // stopped one column early at "480FP" and silently reused its whole column for "-D" too.
    const exactPosition = positions.find((position) => compactKey(cells[position]) === compactCatalog);
    const matchedPosition =
      exactPosition ??
      positions.find((position) => {
        const token = compactKey(cells[position]);
        return token.length >= 3 && (token.includes(compactCatalog) || compactCatalog.includes(token));
      });
    if (matchedPosition === undefined) continue;
    headerIndex = index;
    headerCellCount = cells.length;
    firstVariant = positions[0];
    ourOrdinal = positions.indexOf(matchedPosition);
    break;
  }
  if (headerIndex < 0) return undefined;

  const targetIndex = firstVariant + ourOrdinal;
  // Number of variant (data) columns in this table — normally headerCellCount - firstVariant, but
  // pdf-parse's own tab-insertion for the HEADER row specifically can under-count columns compared
  // to the data rows below it (confirmed on Rockwell's 1606-td002: a 4-model header row extracts
  // with only 2 of the 4 catalog numbers as separate cells, while every data row below correctly
  // has all 4 values tab-separated). Track the widest cell count actually seen on a row that
  // reached our own column and use THAT for the column count instead, since it reflects the real
  // table shape; only fall back to the header's own count until a data row has been seen.
  let maxObservedCellCount = headerCellCount;

  const out: string[] = [catalogNumber];
  // A label whose own row has NO value cells at all (e.g. "Dimensions" / "W x H x D" above
  // per-model "39 x 124 x 124 mm" / "(1.54 x 4.88 x 4.88 in.)" pairs) prints its per-column values
  // as a flat run of bare continuation lines instead, one evenly-sized chunk per variant column, in
  // column order. Track that run so we can slice out our own chunk once it ends.
  let pendingLabel: string[] = [];
  let pendingBlock: string[] = [];
  let collectingBlock = false;

  const flushPendingBlock = () => {
    const columnCount = maxObservedCellCount - firstVariant;
    if (pendingLabel.length && pendingBlock.length && columnCount > 0 && pendingBlock.length % columnCount === 0) {
      const chunkSize = pendingBlock.length / columnCount;
      const chunk = pendingBlock.slice(ourOrdinal * chunkSize, ourOrdinal * chunkSize + chunkSize);
      if (chunk.length) out.push(`${pendingLabel.join(" ")}: ${chunk.join(" ")}`);
    }
    pendingLabel = [];
    pendingBlock = [];
    collectingBlock = false;
  };

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const cells = splitTableCells(lines[index]);
    if (cells.length === 0) {
      flushPendingBlock();
      continue;
    }

    // A brand-new comparison table starting (>=2 variant-shaped tokens, each with a digit — a real
    // catalog/model code always has one, unlike an ordinary hyphenated word such as "Push-in" that
    // CATALOG_LIKE_TOKEN_PATTERN's shape alone would also match) ends this one. Checked BEFORE
    // "does this row reach our column" below: a different table's own header row usually has the
    // same or more cells as ours, so it would otherwise satisfy that check by coincidence and get
    // absorbed as more of THIS table's data forever — e.g. Rockwell's 1606-td002 has half a dozen
    // back-to-back comparison tables on the same page range, and without this ordering the scan for
    // one model would run straight through every later table, the certifications matrix, and the
    // document's own back-cover resource list, mislabeling all of it as this catalog's own spec rows.
    // A decimal measurement-with-unit ("22.5V") also matches the pattern's shape (digits, a "."
    // separator, then an alnum suffix) and has a digit too, so it's excluded explicitly — it's
    // spec DATA repeated across columns (e.g. "Voltage in Buffer-mode"), not a model code.
    if (
      variantCellPositions(cells)
        .filter((position) => /\d/.test(cells[position]) && !isMeasurementWithUnit(cells[position]))
        .length >= 2
    ) {
      flushPendingBlock();
      break;
    }

    // Row still carries a usable value at our column's position — the common case. Accepted even
    // when the row's total cell count falls short of the header's, since that just means some
    // OTHER column's value overflowed onto extra lines; it doesn't affect our own cell here. (A
    // stricter "cell count must match the header exactly" rule used to drop these rows outright.)
    if (cells.length > targetIndex) {
      flushPendingBlock();
      maxObservedCellCount = Math.max(maxObservedCellCount, cells.length);
      const label = cells.slice(0, firstVariant).join(" ").trim();
      const value = cells[targetIndex];
      if (label && value) out.push(`${label}: ${value}`);
      continue;
    }

    // A genuine data row that reaches some OTHER column(s) but not ours (our column's value
    // wrapped further down than theirs did) — still ends any pending value-block from the
    // previous label; nothing to record here since our own cell isn't on this row.
    if (cells.length > firstVariant) {
      flushPendingBlock();
      continue;
    }

    // A bare, single-cell line that doesn't reach any column at all: either more label text (no
    // digits yet — "Dimensions", "W x H x D") or the start/continuation of the per-column value
    // run (first line with a digit flips into collecting mode; every bare line after that belongs
    // to the run, digits or not, so trailing non-numeric tokens like "auto-select" stay attached).
    const line = cells.join(" ").trim();
    if (!line) continue;
    const knownColumnCount = maxObservedCellCount - firstVariant;
    if (
      collectingBlock &&
      !/\d/.test(line) &&
      knownColumnCount > 0 &&
      pendingBlock.length > 0 &&
      pendingBlock.length % knownColumnCount === 0
    ) {
      // A no-digit bare line arriving exactly when the current block already divides evenly into
      // the known column count is a NEW label starting (e.g. bare "Weight" immediately after a
      // completed 2-line-per-column "Dimensions" block, with no tab-separated row in between to
      // signal the switch) — not a trailing continuation of the value we just finished. Flush what
      // we have under the OLD label first, then start fresh under this one.
      flushPendingBlock();
      pendingLabel.push(line);
    } else if (!collectingBlock && !/\d/.test(line)) {
      pendingLabel.push(line);
    } else if (pendingLabel.length > 0) {
      // Only collect into a block when there's an actual label to attach it to — a bare digit
      // line with no pending label is an orphaned continuation fragment for an already-flushed
      // row (e.g. a per-model footnote like "Screw (-XLB60E)" wrapping below "Connection
      // Terminals \tPush-in \tPush-in \t..." after that row was already accepted on its own tab-
      // separated line). Treating it as the start of a NEW block would wrongly glue it — and
      // "collecting" mode itself — onto whatever label comes next, discarding that label's own
      // real values when the block's line count no longer divides evenly by the column count.
      collectingBlock = true;
      pendingBlock.push(line);
    }
  }
  flushPendingBlock();

  if (out.length <= 1) return undefined;
  const joined = out.join("\n");
  return options.maxChars ? joined.slice(0, options.maxChars) : joined;
}
