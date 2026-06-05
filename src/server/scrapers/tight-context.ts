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
