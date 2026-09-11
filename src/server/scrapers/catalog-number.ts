import type { LocalizedProductUrls, LocalizedUrlTemplate, MatchPolicyConfig } from "../../shared/types.js";

/** Exact product identity is deliberately distinct from a printed family prefix. */
export type CatalogMatchLevel = "exact" | "family";

export interface CatalogTextMatch {
  level: CatalogMatchLevel;
  /** The printed code that established the match, not necessarily the requested SKU. */
  candidate: string;
}

export const CATALOG_PLACEHOLDER_PATTERN =
  /{part(?:Upper|Lower|Compact|Snake|Dash|SlashBraces|AfterColon|AfterColonLower|AfterColonCompact)?}/;

export function templateContainsCatalogPlaceholder(template: string): boolean {
  return CATALOG_PLACEHOLDER_PATTERN.test(template);
}

export function fillCatalogTemplate(template: string, catalogNumber: string): string {
  const variants = catalogNumberVariants(catalogNumber);
  return template
    .replaceAll("{part}", encodeURIComponent(catalogNumber))
    .replaceAll("{partUpper}", encodeURIComponent(catalogNumber.toUpperCase()))
    .replaceAll("{partLower}", encodeURIComponent(catalogNumber.toLowerCase()))
    .replaceAll("{partCompact}", encodeURIComponent(variants.compact))
    .replaceAll("{partSlashBraces}", variants.slashBraces)
    .replaceAll("{partAfterColon}", encodeURIComponent(variants.afterColon))
    .replaceAll("{partAfterColonLower}", encodeURIComponent(variants.afterColon.toLowerCase()))
    .replaceAll("{partAfterColonCompact}", encodeURIComponent(compactCatalogNumber(variants.afterColon)))
    .replaceAll("{partSnake}", encodeURIComponent(variants.snake))
    .replaceAll("{partDash}", encodeURIComponent(variants.dash));
}

export function buildConfiguredLocalizedUrls(
  templates: LocalizedUrlTemplate[] | undefined,
  catalogNumber: string
): LocalizedProductUrls {
  const urls: LocalizedProductUrls = {};
  for (const template of templates ?? []) {
    if (!templateContainsCatalogPlaceholder(template.urlTemplate)) continue;
    if (template.locale !== "en" && template.locale !== "de") continue;
    urls[template.locale] = fillCatalogTemplate(template.urlTemplate, catalogNumber);
  }
  if (urls.en && urls.de && equivalentUrl(urls.en, urls.de)) delete urls.de;
  return urls;
}

function equivalentUrl(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.origin.toLowerCase() === rightUrl.origin.toLowerCase() &&
      leftUrl.pathname.replace(/\/+$/, "").toLowerCase() === rightUrl.pathname.replace(/\/+$/, "").toLowerCase() &&
      leftUrl.searchParams.toString() === rightUrl.searchParams.toString()
    );
  } catch {
    return left.replace(/\/+$/, "").toLowerCase() === right.replace(/\/+$/, "").toLowerCase();
  }
}

export function catalogTextMatches(text: string, catalogNumber: string, policy?: MatchPolicyConfig): boolean {
  const effectivePolicy = withDefaultMatchPolicy(policy);
  const candidates = catalogMatchCandidates(catalogNumber, effectivePolicy);
  if (candidates.length === 0) return false;

  const haystack = effectivePolicy.ignoreCase === false ? text : text.toLowerCase();
  if (
    candidates.some((candidate) => {
      const needle = effectivePolicy.ignoreCase === false ? candidate : candidate.toLowerCase();
      return needle.length > 0 && haystack.includes(needle);
    })
  ) {
    return true;
  }

  if (!effectivePolicy.compact) return false;
  const compactNeedles = candidates.map(compactCatalogNumber).filter((candidate) => candidate.length >= 4);
  if (compactNeedles.length === 0) return false;
  const compactHaystack = compactCatalogNumber(text);
  return compactNeedles.some((candidate) => compactHaystack.includes(candidate));
}

/**
 * Boundary-safe identity matching with an explicit family fallback.  The legacy
 * `catalogTextMatches` remains tolerant for callers that intentionally need it;
 * new extraction code should use this function before trusting a product row.
 */
export function findCatalogTextMatch(text: string, catalogNumber: string, policy?: MatchPolicyConfig): CatalogTextMatch | undefined {
  const effectivePolicy = withDefaultMatchPolicy(policy);
  const exactCandidates = catalogMatchCandidates(catalogNumber, effectivePolicy);
  for (const candidate of exactCandidates) {
    if (containsCatalogCandidate(text, candidate, effectivePolicy.ignoreCase)) return { level: "exact", candidate };
  }
  for (const candidate of exactCandidates.flatMap(catalogFamilyMatchCandidates)) {
    if (containsCatalogCandidate(text, candidate, effectivePolicy.ignoreCase)) return { level: "family", candidate };
  }
  return undefined;
}

export function catalogMatchLevel(text: string, catalogNumber: string, policy?: MatchPolicyConfig): CatalogMatchLevel | undefined {
  return findCatalogTextMatch(text, catalogNumber, policy)?.level;
}

/** Progressive separator-bound prefixes, from most specific family to broadest. */
export function catalogFamilyMatchCandidates(catalogNumber: string): string[] {
  const cleaned = catalogNumber.trim();
  const separators = [...cleaned.matchAll(/[\s:/.-]+/g)];
  const candidates: string[] = [];
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const candidate = cleaned.slice(0, separators[index].index).replace(/[\s:/.-]+$/, "").trim();
    const compact = compactCatalogNumber(candidate);
    if (compact.length >= 5 && /\d/.test(compact)) candidates.push(candidate);
  }
  return [...new Set(candidates)];
}

function containsCatalogCandidate(text: string, candidate: string, ignoreCase: boolean): boolean {
  const compact = compactCatalogNumber(candidate);
  if (compact.length < 4) return false;
  // Punctuation can vary within a code, but adjacent alphanumerics would make it a sibling SKU.
  const body = compact.split("").map(escapeRegExp).join("[^a-z0-9]*");
  return new RegExp(`(^|[^a-z0-9])${body}(?=$|[^a-z0-9])`, ignoreCase ? "i" : "").test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sameCatalogNumber(left: unknown, right: string, policy?: MatchPolicyConfig): boolean {
  if (typeof left !== "string") return false;
  const effectivePolicy = withDefaultMatchPolicy(policy);
  const leftValue = effectivePolicy.ignoreCase === false ? left : left.toLowerCase();
  return catalogMatchCandidates(right, effectivePolicy).some((candidate) => {
    const candidateValue = effectivePolicy.ignoreCase === false ? candidate : candidate.toLowerCase();
    return leftValue === candidateValue || (effectivePolicy.compact && compactCatalogNumber(leftValue) === compactCatalogNumber(candidateValue));
  });
}

export function catalogMatchCandidates(catalogNumber: string, policy?: MatchPolicyConfig): string[] {
  const effectivePolicy = withDefaultMatchPolicy(policy);
  const variants = catalogNumberVariants(catalogNumber);
  const candidates = [
    catalogNumber,
    ...(effectivePolicy.afterColon ? [variants.afterColon] : []),
    ...(effectivePolicy.aliases ?? [])
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(candidates)];
}

export function catalogNumberVariants(catalogNumber: string): {
  compact: string;
  afterColon: string;
  snake: string;
  dash: string;
  slashBraces: string;
} {
  const afterColon = catalogNumber.includes(":") ? catalogNumber.split(":").pop() ?? catalogNumber : catalogNumber;
  return {
    compact: compactCatalogNumber(catalogNumber),
    afterColon,
    snake: catalogNumber
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase(),
    dash: catalogNumber
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase(),
    slashBraces: encodeSlashBraceCatalogPart(catalogNumber)
  };
}

/** A query string to type into a vendor's search box, and how much it narrows the answer. */
export interface SearchQueryVariant {
  term: string;
  /** `exact` still identifies one product; `family` can only ever reach the family page. */
  level: CatalogMatchLevel;
  reason: string;
}

/**
 * What a human types next when the vendor's search returns nothing (COLD-START-PLAN §6.2, P4.6).
 *
 * Every generic search shape is filled with the literal catalog number and nothing else, so a vendor
 * whose index stores `1SVR405611R1000` without separators, or who only indexes the family, is simply
 * unreachable. A person does not stop there — they drop the separators, then the suffix.
 *
 * The `family` entry is deliberately last and deliberately labelled. It cannot identify a variant,
 * and the caller must score it below an exact term; publishing is unaffected either way, because
 * `scoreFetchedDiscoveryEvidence` demands an EXACT catalog match on a product identity surface before
 * any fetched page becomes a candidate, and `html-page-level` independently gates family pages.
 */
export function searchQueryVariants(catalogNumber: string): SearchQueryVariant[] {
  const raw = catalogNumber.trim();
  if (!raw) return [];
  const variants = catalogNumberVariants(raw);
  const seen = new Set<string>();
  const out: SearchQueryVariant[] = [];
  const push = (term: string, level: CatalogMatchLevel, reason: string) => {
    const cleaned = term.trim();
    // A variant that differs from the original only by case is the same query to every search engine
    // we have ever measured, and costs a full request to prove it.
    const key = cleaned.toLowerCase();
    if (!cleaned || cleaned.length < 3 || seen.has(key)) return;
    seen.add(key);
    out.push({ term: cleaned, level, reason });
  };
  push(raw, "exact", "catalog number as printed");
  push(variants.compact, "exact", "separators removed");
  push(variants.dash, "exact", "separators normalised to dashes");
  if (variants.afterColon !== raw) push(variants.afterColon, "exact", "part after the prefix separator");
  // Most specific family first — `catalogFamilyMatchCandidates` already returns them that way.
  //
  // That function requires a digit in the prefix, which is right for IDENTITY (a letters-only prefix
  // would match half the catalogue) and wrong for a QUERY: `CT-MFD.21` has the family `CT-MFD`, which
  // is exactly what a person types, and the digit rule rejects it. So fall back to the prefix before
  // the last separator — a query, not a claim. It is still labelled `family`, so the caller scores it
  // below every exact term, and `scoreFetchedDiscoveryEvidence` still demands an exact identity match
  // before anything it finds can become a result.
  const family = catalogFamilyMatchCandidates(raw)[0] ?? queryOnlyFamilyPrefix(raw);
  if (family) push(family, "family", "family prefix");
  return out;
}

/**
 * The prefix before the last separator, used ONLY as a search query (see `searchQueryVariants`).
 *
 * Deliberately not exported and deliberately not part of `catalogFamilyMatchCandidates`: that one
 * answers "may this printed code stand for the requested product", and loosening it would let a
 * letters-only prefix authorise a value. Four compact characters is the floor — below that the query
 * returns the whole catalogue and the request is wasted.
 */
function queryOnlyFamilyPrefix(catalogNumber: string): string | undefined {
  const separators = [...catalogNumber.matchAll(/[\s:/.-]+/g)];
  const last = separators.at(-1);
  if (!last || last.index === undefined) return undefined;
  const prefix = catalogNumber.slice(0, last.index).replace(/[\s:/.-]+$/, "").trim();
  return compactCatalogNumber(prefix).length >= 4 ? prefix : undefined;
}

export function encodeSlashBraceCatalogPart(catalogNumber: string): string {
  return catalogNumber.split("/").map(encodeURIComponent).join("%7B%7D");
}

export function compactCatalogNumber(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function withDefaultMatchPolicy(policy?: MatchPolicyConfig): Required<Omit<MatchPolicyConfig, "aliases">> & {
  aliases?: string[];
} {
  return {
    ignoreCase: policy?.ignoreCase ?? true,
    compact: policy?.compact ?? true,
    afterColon: policy?.afterColon ?? true,
    requireCatalogNumber: policy?.requireCatalogNumber ?? true,
    aliases: policy?.aliases
  };
}
