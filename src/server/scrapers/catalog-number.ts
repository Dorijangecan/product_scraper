import type { LocalizedProductUrls, LocalizedUrlTemplate, MatchPolicyConfig } from "../../shared/types.js";

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
