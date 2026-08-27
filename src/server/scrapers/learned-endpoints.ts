import type { LearnedEndpointRecord, ManufacturerConfig } from "../../shared/types.js";
import { catalogTextMatches, catalogNumberVariants, compactCatalogNumber, fillCatalogTemplate } from "./catalog-number.js";
import type { FetchedText } from "./http-client.js";

export interface LearnedEndpointStore {
  list: (manufacturerId: string, limit?: number) => LearnedEndpointRecord[];
  upsert: (endpoint: Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">) => void;
}

/**
 * A search endpoint that demonstrably answers this vendor's catalog numbers.
 *
 * Kept as its own `parserKind` because a search URL is NOT a product URL: it must reorder the search
 * stage without ever becoming a product candidate. Measured reason it exists at all: the generic
 * search stage fires up to 18 query-key shapes per catalog number, of which at most one is the
 * vendor's real endpoint — and the other ~17 were re-paid on every catalog number, in every run,
 * forever (`gan`: 29 requests x 3000 ms per-host interval = 87 s of pure waiting).
 */
export const SEARCH_TEMPLATE_PARSER_KIND = "official-search-template";

export function learnedEndpointUrls(
  manufacturer: ManufacturerConfig,
  catalogNumber: string,
  store: LearnedEndpointStore | undefined,
  limit = 12
): Array<{ url: string; endpoint: LearnedEndpointRecord }> {
  if (!store) return [];
  return store
    .list(manufacturer.id, limit)
    .filter((endpoint) => !learnedEndpointSuppressed(endpoint))
    // A learned SEARCH endpoint is a route to the product, not the product. Letting it in here would
    // put a search URL on the product-candidate list, which is exactly the class of wrong answer
    // that ranked #1 for Siemens.
    .filter((endpoint) => endpoint.parserKind !== SEARCH_TEMPLATE_PARSER_KIND)
    .filter((endpoint) => endpoint.method === "GET" && endpoint.urlTemplate.includes("{part"))
    .flatMap((endpoint) => {
      const url = fillCatalogTemplate(endpoint.urlTemplate, catalogNumber);
      if (!isAllowedOfficialHost(url, manufacturer)) return [];
      return [{ url, endpoint }];
    });
}

/** The search endpoints this vendor has already been observed answering, best-first. */
export function learnedSearchTemplateUrls(
  manufacturer: ManufacturerConfig,
  catalogNumber: string,
  store: LearnedEndpointStore | undefined,
  limit = 20
): Array<{ url: string; endpoint: LearnedEndpointRecord }> {
  if (!store) return [];
  return store
    .list(manufacturer.id, limit)
    .filter((endpoint) => endpoint.parserKind === SEARCH_TEMPLATE_PARSER_KIND)
    .filter((endpoint) => !learnedEndpointSuppressed(endpoint))
    .filter((endpoint) => endpoint.method === "GET" && endpoint.urlTemplate.includes("{part"))
    .flatMap((endpoint) => {
      const url = fillCatalogTemplate(endpoint.urlTemplate, catalogNumber);
      if (!isAllowedOfficialHost(url, manufacturer)) return [];
      return [{ url, endpoint }];
    });
}

/**
 * Remember a search URL shape that actually produced a product link for this catalog number.
 *
 * "Worked" is deliberately defined as *the vendor's own search answered with a link that carries the
 * requested catalog number* — `discoverProductLinksWithDiagnostics` filters by the catalog, so a
 * results page full of unrelated products yields nothing and teaches nothing. The template is keyed
 * by host as well as manufacturer, because one vendor can use a different key per locale/shop.
 */
export function learnSearchTemplate(input: {
  manufacturer: ManufacturerConfig;
  catalogNumber: string;
  searchUrl: string;
  store?: LearnedEndpointStore;
}): string | undefined {
  if (!input.store) return undefined;
  if (!isAllowedOfficialHost(input.searchUrl, input.manufacturer)) return undefined;
  const urlTemplate = endpointTemplateFromUrl(input.searchUrl, input.catalogNumber);
  if (!urlTemplate || urlTemplate === input.searchUrl) return undefined;
  let host: string;
  try {
    host = new URL(input.searchUrl).hostname;
  } catch {
    return undefined;
  }
  input.store.upsert({
    manufacturerId: input.manufacturer.id,
    host,
    method: "GET",
    urlTemplate,
    discoveredFromUrl: input.searchUrl,
    parserKind: SEARCH_TEMPLATE_PARSER_KIND
  });
  return urlTemplate;
}

export function learnedEndpointSuppressed(endpoint: LearnedEndpointRecord, now = Date.now()): boolean {
  if ((endpoint.failureCount ?? 0) < 3 || !endpoint.lastFailureAt) return false;
  const ageDays = (now - Date.parse(endpoint.lastFailureAt)) / 86_400_000;
  return Number.isFinite(ageDays) && ageDays >= 0 && ageDays < 7;
}

export function learnEndpointFromNetworkFetch(input: {
  manufacturer: ManufacturerConfig;
  catalogNumber: string;
  fetched: FetchedText;
  discoveredFromUrl: string;
  parserKind: string;
  store?: LearnedEndpointStore;
}): boolean {
  if (!input.store) return false;
  if (!looksLikeUsefulEndpoint(input.fetched)) return false;
  if (!catalogTextMatches(input.fetched.text, input.catalogNumber, input.manufacturer.match)) return false;
  if (!isAllowedOfficialHost(input.fetched.effectiveUrl, input.manufacturer)) return false;
  const urlTemplate = endpointTemplateFromUrl(input.fetched.effectiveUrl, input.catalogNumber);
  if (!urlTemplate || urlTemplate === input.fetched.effectiveUrl) return false;
  const parsed = new URL(input.fetched.effectiveUrl);
  input.store.upsert({
    manufacturerId: input.manufacturer.id,
    host: parsed.hostname,
    method: "GET",
    urlTemplate,
    discoveredFromUrl: input.discoveredFromUrl,
    parserKind: input.parserKind,
    headers: acceptHeadersForContentType(input.fetched.contentType)
  });
  return true;
}

export function endpointTemplateFromUrl(url: string, catalogNumber: string): string | undefined {
  let template = url;
  const variants = catalogNumberVariants(catalogNumber);
  const replacements = [
    [catalogNumber, "{part}"],
    [catalogNumber.toUpperCase(), "{partUpper}"],
    [catalogNumber.toLowerCase(), "{partLower}"],
    [variants.afterColon, "{partAfterColon}"],
    [variants.afterColon.toLowerCase(), "{partAfterColonLower}"],
    [compactCatalogNumber(catalogNumber), "{partCompact}"],
    [compactCatalogNumber(variants.afterColon), "{partAfterColonCompact}"],
    [variants.snake, "{partSnake}"],
    [variants.dash, "{partDash}"]
  ] as const;

  for (const [value, placeholder] of [...replacements].sort((left, right) => right[0].length - left[0].length)) {
    if (!value || value.length < 3) continue;
    template = replaceInsensitive(template, encodeURIComponent(value), placeholder);
    template = replaceInsensitive(template, value, placeholder);
  }

  if (!template.includes("{part")) return undefined;
  try {
    const parsed = new URL(template);
    parsed.hash = "";
    return restoreTemplatePlaceholders(parsed.toString());
  } catch {
    return undefined;
  }
}

function looksLikeUsefulEndpoint(fetched: FetchedText): boolean {
  if (fetched.statusCode && (fetched.statusCode < 200 || fetched.statusCode >= 300)) return false;
  const combined = `${fetched.effectiveUrl} ${fetched.contentType ?? ""}`.toLowerCase();
  if (!/(json|api|graphql|product|sku|catalog|article|pim)/.test(combined)) return false;
  if (/\.(?:png|jpe?g|webp|gif|svg|css|woff2?)(?:[?#]|$)/i.test(fetched.effectiveUrl)) return false;
  return fetched.text.trim().length >= 40 && fetched.text.length <= 750_000;
}

function isAllowedOfficialHost(url: string, manufacturer: ManufacturerConfig): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return manufacturer.officialBaseUrls.some((baseUrl) => {
      try {
        const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "").toLowerCase();
        return host === baseHost || host.endsWith(`.${baseHost}`);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function acceptHeadersForContentType(contentType: string | undefined): Record<string, string> | undefined {
  if (!contentType) return undefined;
  if (/json/i.test(contentType)) return { accept: "application/json,text/plain;q=0.8,*/*;q=0.5" };
  return undefined;
}

function replaceInsensitive(input: string, needle: string, replacement: string): string {
  if (!needle) return input;
  return input.replace(new RegExp(escapeRegExp(needle), "gi"), replacement);
}

function restoreTemplatePlaceholders(input: string): string {
  return input.replace(/%7B(part(?:Upper|Lower|Compact|Snake|Dash|AfterColon|AfterColonLower|AfterColonCompact)?)%7D/gi, "{$1}");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
