import type { LearnedEndpointRecord, ManufacturerConfig } from "../../shared/types.js";
import { catalogTextMatches, catalogNumberVariants, compactCatalogNumber, fillCatalogTemplate } from "./catalog-number.js";
import type { FetchedText } from "./http-client.js";

export interface LearnedEndpointStore {
  list: (manufacturerId: string, limit?: number) => LearnedEndpointRecord[];
  upsert: (endpoint: Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">) => void;
}

export function learnedEndpointUrls(
  manufacturer: ManufacturerConfig,
  catalogNumber: string,
  store: LearnedEndpointStore | undefined,
  limit = 12
): Array<{ url: string; endpoint: LearnedEndpointRecord }> {
  if (!store) return [];
  return store
    .list(manufacturer.id, limit)
    .filter((endpoint) => endpoint.method === "GET" && endpoint.urlTemplate.includes("{part"))
    .flatMap((endpoint) => {
      const url = fillCatalogTemplate(endpoint.urlTemplate, catalogNumber);
      if (!isAllowedOfficialHost(url, manufacturer)) return [];
      return [{ url, endpoint }];
    });
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
