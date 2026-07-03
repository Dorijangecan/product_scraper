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

/**
 * Rewrite every number in `text` so it uses "." as the ONLY decimal separator and drops
 * thousands grouping — resolving the comma-vs-dot ambiguity WITHOUT destroying a US-style
 * thousands separator. This is the single source of truth for numeric grouping; do NOT
 * reintroduce a blanket `,`→`.` replacement (that turns "1,050.00 lbs" into 1.05).
 *
 *   "1,050.00 lbs" -> "1050.00 lbs"   (comma = thousands, dot = decimal — US)
 *   "1.050,00 kg"  -> "1050.00 kg"    (dot = thousands, comma = decimal — EU)
 *   "1,234,567"    -> "1234567"       (grouped thousands)
 *   "12,345 A"     -> "12345 A"       (3-digit group = thousands)
 *   "1,5 kg"       -> "1.5 kg"        (comma = decimal — EU)
 *   "1.05"         -> "1.05"          (native decimal, untouched)
 */
export function normalizeNumberSeparators(text: string): string {
  return text.replace(/\d[\d.,]*\d|\d/g, (token) => normalizeNumberToken(token));
}

function normalizeNumberToken(token: string): string {
  const hasComma = token.includes(",");
  const hasDot = token.includes(".");
  if (!hasComma && !hasDot) return token;

  // Both separators present: the right-most one is the decimal point, the other groups thousands.
  if (hasComma && hasDot) {
    const decimalIsComma = token.lastIndexOf(",") > token.lastIndexOf(".");
    const decimal = decimalIsComma ? "," : ".";
    const grouping = decimalIsComma ? "." : ",";
    const [intPart, fracPart = ""] = token.split(decimal);
    return `${intPart.split(grouping).join("")}.${fracPart}`;
  }

  // Only one kind of separator — decide grouping vs. decimal from the group shapes.
  const sep = hasComma ? "," : ".";
  const parts = token.split(sep);
  const looksLikeThousands =
    parts.length >= 2 &&
    parts[0].length >= 1 &&
    parts[0].length <= 3 &&
    // A thousands group never has a leading-zero integer part ("0,112" is a decimal, not 112).
    !parts[0].startsWith("0") &&
    parts.slice(1).every((group) => group.length === 3);

  if (parts.length > 2) {
    // Multiple separators of one kind: "1,234,567" / "1.234.567" — thousands if well-formed,
    // otherwise leave alone (a comma-only chain falls back to the historical decimal reading).
    if (looksLikeThousands) return parts.join("");
    return sep === "," ? parts.join(".") : token;
  }

  // Single separator. A comma with a full 3-digit trailing group ("1,050") is thousands; every
  // other comma ("1,5", "1,05") is a decimal. A lone dot is already a native decimal point.
  if (sep === "," && looksLikeThousands) return parts.join("");
  return `${parts[0]}.${parts[1]}`;
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
