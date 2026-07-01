// Leaf text utilities shared across `server/`, `scrapers/`, and `pdt/`.
//
// IMPORTANT: this module must not import anything from the server subtree — it is a
// dependency sink so that both `normalizer.ts` and `field-registry.ts` (which import each
// other) can share `cleanText` without creating an import cycle.
//
// Non-ASCII bytes are written as \uXXXX escapes on purpose so the source stays pure ASCII
// and byte-stable regardless of editor encoding.

/**
 * Canonical text cleaner: decodes HTML entities, repairs common UTF-8-as-CP1252 mojibake
 * (ellipsis, en/em dash, degree, superscript-two), collapses whitespace, and trims. Every
 * module should use this rather than a local copy — historically several files carried weaker
 * variants that skipped entity/mojibake repair.
 */
export function cleanText(value: string | undefined | null): string {
  return decodeHtmlEntities(String(value ?? ""))
    .replace(/ /g, " ")
    .replace(/â€¦/g, "...")
    .replace(/â€“|â€”/g, "-")
    .replace(/Â°/g, "°")
    .replace(/Â²/g, "²")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (entity: string, code: string) => decodeEntityCodePoint(Number.parseInt(code, 16), entity))
    .replace(/&#(\d+);/g, (entity: string, code: string) => decodeEntityCodePoint(Number.parseInt(code, 10), entity))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&deg;/gi, "°")
    .replace(/&sup2;/gi, "²")
    .replace(/&micro;/gi, "µ");
}

function decodeEntityCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  return String.fromCodePoint(codePoint);
}

/**
 * Whitespace-collapse + trim, always returning a string. Replaces the several private
 * `clean()` helpers that returned a plain string (config, wizard). For the variant that
 * returns `undefined` on empty (used across `pdt/`), use {@link collapseWhitespaceOrUndefined}.
 */
export function collapseWhitespace(value: string | undefined | null): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** Like {@link collapseWhitespace} but returns `undefined` when the result is empty. */
export function collapseWhitespaceOrUndefined(value: string | undefined | null): string | undefined {
  const collapsed = collapseWhitespace(value);
  return collapsed || undefined;
}

export interface UniqueStringsOptions {
  /** Per-value normalization before dedupe: `"trim"` trims, `"clean"` runs {@link cleanText}. */
  normalize?: "none" | "trim" | "clean";
  /** Drop empty strings (after normalization). Defaults to `true`. */
  filterEmpty?: boolean;
  /** Dedupe case-insensitively while preserving the first-seen original casing. */
  caseInsensitive?: boolean;
}

/**
 * Order-preserving string dedupe. Consolidates the many private `uniqueStrings` variants that
 * differed only in whether they trimmed, cleaned, filtered empties, or ignored case.
 */
export function uniqueStrings(
  values: Array<string | undefined | null>,
  options: UniqueStringsOptions = {}
): string[] {
  const { normalize = "none", filterEmpty = true, caseInsensitive = false } = options;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    let value = raw == null ? "" : String(raw);
    if (normalize === "trim") value = value.trim();
    else if (normalize === "clean") value = cleanText(value);
    if (filterEmpty && !value) continue;
    const key = caseInsensitive ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** Lowercase slug (a-z0-9 separated by `-`), capped at 48 chars. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
