/**
 * The vendor's own search URL, declared by the vendor — not guessed by us.
 *
 * `GENERIC_SEARCH_SHAPES` fires up to 14 blind URL shapes per catalog number because we do not know
 * which key this site answers on. A large share of sites simply publish the answer: a
 * `<link rel="search" type="application/opensearchdescription+xml">` in the head, pointing at an XML
 * document whose `<Url template="...{searchTerms}...">` IS the site search URL, and which frequently
 * also declares a `application/x-suggestions+json` typeahead endpoint — the one datasource that is
 * normally only reachable through a browser, here fetchable with a plain GET.
 *
 * This is the only item in COLD-START-PLAN §6 that guesses nothing at all (P4.4). It costs no extra
 * request: the templates are read out of the homepage HTML that search-form discovery already fetches,
 * and a template that answers is written to `learned_endpoints`, so from the second catalog number of
 * a run onwards the vendor's real key is tried first instead of being rediscovered behind 14 misses.
 */
import * as cheerio from "cheerio";

/** OpenSearch parameters we can legitimately supply a value for. */
const TEMPLATE_DEFAULTS: Record<string, string> = {
  count: "10",
  startIndex: "1",
  startPage: "1",
  // The spec's wildcard is "*", but a vendor catalogue that bothers to template the language almost
  // always means a real locale, and "*" 404s there. English matches the rest of our discovery entry
  // points; a wrong guess here costs one request, not a wrong value.
  language: "en",
  inputEncoding: "UTF-8",
  outputEncoding: "UTF-8"
};

export interface OpenSearchTemplates {
  /** `type="text/html"` templates — the human search results page. */
  html: string[];
  /** `type="application/x-suggestions+json"` templates — the typeahead endpoint. */
  suggestions: string[];
}

/**
 * Autodiscovery links in a page head. `rel` is a space-separated token list, so match the token.
 */
export function openSearchDescriptionUrls(html: string, baseUrl: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  $("link[href]").each((_, element) => {
    const rel = ($(element).attr("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("search")) return;
    const type = ($(element).attr("type") ?? "").toLowerCase();
    if (!type.includes("opensearchdescription")) return;
    const href = $(element).attr("href")?.trim();
    if (!href) return;
    // `new URL(junk, base)` does NOT throw — it happily resolves `::::` to `https://vendor.test/::::`,
    // and we would spend a request fetching it. A real document reference starts with a path, a dot
    // segment, an alphanumeric, or a scheme; nothing else is worth a fetch.
    if (!/^[A-Za-z0-9/._~-]/.test(href)) return;
    try {
      const resolved = new URL(href, baseUrl);
      if (/^https?:$/i.test(resolved.protocol)) urls.add(resolved.toString());
    } catch {
      // A malformed href is not a description document.
    }
  });
  return [...urls];
}

/**
 * Templates from an OpenSearch description document.
 *
 * Relative templates are resolved against the description document's own URL, which is what the spec
 * requires and what a CDN-hosted description needs to point back at the catalogue.
 */
export function openSearchTemplates(xml: string, descriptionUrl: string): OpenSearchTemplates {
  const result: OpenSearchTemplates = { html: [], suggestions: [] };
  if (!xml || !/opensearchdescription/i.test(xml)) return result;
  const $ = cheerio.load(xml, { xmlMode: true });
  $("Url, url").each((_, element) => {
    const template = $(element).attr("template");
    if (!template) return;
    const type = ($(element).attr("type") ?? "").toLowerCase();
    let absolute: string;
    try {
      // The template carries `{...}` placeholders, which are legal in a URL path/query and survive
      // resolution untouched.
      absolute = new URL(template, descriptionUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:/i.test(absolute)) return;
    if (type.includes("x-suggestions+json")) {
      if (!result.suggestions.includes(absolute)) result.suggestions.push(absolute);
      return;
    }
    // Default to the HTML results page: `type` is required by the spec but real documents omit it,
    // and an untyped `<Url>` in a catalogue's description is its search page.
    if (!type || type.includes("text/html") || type.includes("application/xhtml")) {
      if (!result.html.includes(absolute)) result.html.push(absolute);
    }
  });
  return result;
}

/**
 * Put the catalog number into a template and resolve every other parameter.
 *
 * Returns `undefined` rather than a half-filled URL when a REQUIRED parameter is one we have no
 * honest value for. A template still carrying `{...}` is not a URL, and sending it would spend a
 * request to learn nothing — the same reason discovery refuses to treat a guess as evidence.
 * Optional parameters (`{name?}`) are simply dropped, as the spec intends.
 */
export function fillOpenSearchTemplate(template: string, searchTerms: string): string | undefined {
  let filled = template.replace(/\{(?:[A-Za-z][\w.-]*:)?searchTerms\??\}/g, encodeURIComponent(searchTerms));
  // Optional parameters may be omitted entirely.
  filled = filled.replace(/\{(?:[A-Za-z][\w.-]*:)?[\w.-]+\?\}/g, "");
  filled = filled.replace(/\{([A-Za-z][\w.-]*)\}/g, (match, name: string) => TEMPLATE_DEFAULTS[name] ?? match);
  if (/\{[^}]*\}/.test(filled)) return undefined;
  if (!/^https?:\/\//i.test(filled)) return undefined;
  // A template that never named `{searchTerms}` is a canned link, not a search.
  if (filled === template) return undefined;
  try {
    // Strip parameters the optional-drop left dangling (`&foo=` / a trailing `?`), so the vendor sees
    // a request it would recognise rather than one we mangled.
    const url = new URL(filled);
    for (const [key, value] of [...url.searchParams.entries()]) {
      if (value === "") url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
