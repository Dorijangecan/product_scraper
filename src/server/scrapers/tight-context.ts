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
      return compactToken.length >= 4 && compactToken !== compactCatalog;
    });
  };

  const kept = new Set<number>();
  for (let index = 0; index < allLines.length; index += 1) {
    if (!lineMatchesCatalog(allLines[index])) continue;
    kept.add(index);
    for (let offset = 1; offset <= before; offset += 1) {
      const target = index - offset;
      if (target < 0) break;
      if (isDifferentCatalogLine(allLines[target])) break;
      kept.add(target);
    }
    for (let offset = 1; offset <= after; offset += 1) {
      const target = index + offset;
      if (target >= allLines.length) break;
      if (isDifferentCatalogLine(allLines[target])) break;
      kept.add(target);
    }
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

function variantCellPositions(cells: string[]): number[] {
  return cells.map((cell, index) => (isVariantToken(cell) ? index : -1)).filter((index) => index >= 0);
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
    const matchedPosition = positions.find((position) => {
      const token = compactKey(cells[position]);
      return token.length >= 3 && (token === compactCatalog || token.includes(compactCatalog) || compactCatalog.includes(token));
    });
    if (matchedPosition === undefined) continue;
    headerIndex = index;
    headerCellCount = cells.length;
    firstVariant = positions[0];
    ourOrdinal = positions.indexOf(matchedPosition);
    break;
  }
  if (headerIndex < 0) return undefined;

  const out: string[] = [catalogNumber];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const cells = splitTableCells(lines[index]);
    if (cells.length === 0) continue;
    if (cells.length !== headerCellCount) {
      // A second comparison table (>=2 variant tokens) ends this one; anything else is just skipped.
      if (variantCellPositions(cells).length >= 2) break;
      continue;
    }
    const label = cells.slice(0, firstVariant).join(" ").trim();
    const value = cells[firstVariant + ourOrdinal];
    if (!label || value === undefined || value === "") continue;
    out.push(`${label}: ${value}`);
  }

  if (out.length <= 1) return undefined;
  const joined = out.join("\n");
  return options.maxChars ? joined.slice(0, options.maxChars) : joined;
}
