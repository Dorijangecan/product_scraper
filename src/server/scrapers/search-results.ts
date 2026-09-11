/**
 * What did the vendor's own search page actually SAY?
 *
 * Today `discoverProductLinksWithDiagnostics` returning zero candidates means four completely
 * different things, and all four take the same next step — which is why the search budget is spent in
 * the wrong place. This module reads the results page's own verdict so those four become
 * distinguishable (COLD-START-PLAN §6.1):
 *
 *   - `zero`     the site said there are no results. Sending 13 more blind URL shapes at the same host
 *                is pointless; the useful next step is a different QUERY (P4.6).
 *   - `hits`     results exist. If none of them carried the catalog number, that is
 *                `search-hits-unidentified` — the case P4.7 exists for.
 *   - `js-only`  the static HTML is a shell; the list is drawn client-side. Needs the browser path.
 *   - `blocked`  bot mitigation. Not a discovery problem at all, and must never be counted as one.
 *   - `unknown`  genuinely undecidable — say so rather than guessing.
 *
 * Deliberately a PURE function with no runtime caller yet: the auditor
 * (`scripts/audit-search-reachability.ts`) uses it to classify the corpus, and only once that
 * measurement exists does P4.5 wire it into `processSearchRequests`. Detector first, then code
 * (COLD-START-PLAN §0b, rule 1).
 */
import * as cheerio from "cheerio";
import { countProductShapedLinks } from "./link-discovery.js";

export type SearchResultVerdictKind = "zero" | "hits" | "js-only" | "blocked" | "unknown";

export interface SearchResultVerdict {
  kind: SearchResultVerdictKind;
  /** Reported number of results, when the page printed one. `0` is meaningful; `undefined` is not. */
  count?: number;
  /** Why this verdict — goes straight into diagnostics, so it must name the evidence, not the rule. */
  evidence: string;
}

/**
 * Phrases a site uses to say "nothing found". English, German, French, Italian, Spanish and Dutch,
 * matching the language set the rest of the scraper already handles.
 *
 * Every entry must be a phrase that CANNOT appear in ordinary marketing prose. `no results` qualifies;
 * a bare `Treffer` does not, which is why the count patterns below always require an adjacent number.
 */
const ZERO_RESULT_PHRASES = [
  "no results",
  "no result was found",
  "no results found",
  "no products found",
  "no matching products",
  "no matches found",
  "nothing found",
  "your search returned no",
  "did not match any",
  "keine ergebnisse",
  "keine treffer",
  "keine produkte gefunden",
  "nichts gefunden",
  "leider keine",
  "aucun resultat",
  "aucun produit",
  "pas de resultat",
  "nessun risultato",
  "nessun prodotto",
  "sin resultados",
  "no se encontraron",
  "ningun resultado",
  "geen resultaten",
  "geen producten"
];

/** `123 results` / `123 Treffer` / `123 produits`. The number must lead — see ZERO_RESULT_PHRASES. */
const RESULT_COUNT_PATTERN =
  /\b(\d[\d.,]*)\s*(?:results?|hits?|matches|items|products?|ergebnisse(?:n)?|treffer|artikel|produkte|resultats?|produits?|risultati|prodotti|resultados|productos|resultaten)\b/gi;

/** `1 – 20 of 137`, `1-20 von 137`, `1 a 20 de 137`. The LAST number is the total. */
const RESULT_RANGE_PATTERN = /\b\d[\d.,]*\s*(?:[-–—]|to|bis|a|à)\s*\d[\d.,]*\s+(?:of|von|di|sur|de|van)\s+(\d[\d.,]*)\b/gi;

/** Markers that mean "a machine refused us", never "this product does not exist". */
const BLOCKED_MARKERS = [
  "just a moment",
  "checking your browser",
  "cf-browser-verification",
  "cf_chl_opt",
  "attention required",
  "access denied",
  "request unsuccessful",
  "are you a robot",
  "enable javascript and cookies to continue",
  "px-captcha",
  "captcha"
];

/** Containers a site renders empty on the server and fills client-side. */
const RESULT_CONTAINER_SELECTORS = [
  "[class*='search-result' i]",
  "[class*='searchresult' i]",
  "[class*='result-list' i]",
  "[class*='resultlist' i]",
  "[class*='product-list' i]",
  "[class*='productlist' i]",
  "[class*='product-grid' i]",
  "[class*='hit' i]",
  "[id*='search-result' i]",
  "[id*='results' i]",
  "[data-results]",
  "[role='list']"
].join(",");

/** Framework fingerprints that make "the static HTML is empty" an explanation rather than a mystery. */
const CLIENT_RENDER_MARKERS = [
  "__NEXT_DATA__",
  "window.__NUXT__",
  "window.__INITIAL_STATE__",
  "ng-version",
  "data-reactroot",
  "data-react-helmet",
  "v-cloak",
  "data-vue",
  "algolia",
  "instantsearch",
  "coveo",
  "factfinder",
  "searchspring"
];

/** Three distinct product links is a list; one or two is a "related products" widget. */
const LISTING_LINK_THRESHOLD = 3;

/** Strip diacritics so `aucun résultat` matches `aucun resultat` without a second phrase list. */
function foldAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function parseCount(raw: string): number | undefined {
  // `1.234` and `1,234` are both thousands separators in this position; a search page never reports a
  // fractional number of results. Stripping both is safe HERE and nowhere else — see
  // `normalizeNumberSeparators` for the general case, which must not be used for this.
  const digits = raw.replace(/[.,\s]/g, "");
  if (!/^\d+$/.test(digits)) return undefined;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Visible text only: a phrase inside a <script> is code, not the page's verdict.
 *
 * Tags become a SPACE rather than being dropped, which `.text()` cannot do. `.text()` concatenates
 * adjacent elements with nothing between them, so a facet reading `3 products` next to a toolbar
 * reading `48 results` becomes the single token `products48` — and `\b48\b` then matches nothing at
 * all, losing the page's own result count. That is a real page shape, not a test artefact.
 */
function visibleText($: cheerio.CheerioAPI): string {
  // Mutates this document. Safe because every caller loads its own, and because the framework
  // fingerprints live in the ORIGINAL html string, which `looksClientRenderedSearchShell` reads
  // directly rather than from the stripped DOM.
  $("script,style,noscript,template,svg").remove();
  return (($("body").length ? $("body").html() : $.root().html()) ?? "")
    .replace(/<[^>]*>/g, " ")
    // A non-breaking space between the number and its noun is common in German/French toolbars and
    // survives tag stripping as a raw entity.
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SearchResultVerdictInput {
  html: string;
  statusCode?: number;
  /**
   * How many product-link candidates link discovery produced from this same page. The zero verdict is
   * only allowed to win when the page ALSO yielded nothing: a site can render an empty
   * "recently viewed" or an unmatched facet next to a perfectly good result list, and that widget's
   * "no results" must not override the list (COLD-START-PLAN §6.2, P4.5 edge case (a)).
   */
  candidateCount?: number;
}

export function searchResultVerdict(input: SearchResultVerdictInput): SearchResultVerdict {
  const { html, statusCode, candidateCount = 0 } = input;
  if (statusCode !== undefined && (statusCode === 403 || statusCode === 429 || statusCode === 503)) {
    return { kind: "blocked", evidence: `HTTP ${statusCode}` };
  }
  if (!html || !html.trim()) {
    return { kind: "unknown", evidence: "empty response body" };
  }

  const $ = cheerio.load(html);
  const text = visibleText($);
  const folded = foldAccents(text).toLowerCase();

  const blockedMarker = BLOCKED_MARKERS.find((marker) => folded.includes(marker));
  if (blockedMarker) return { kind: "blocked", evidence: `bot-mitigation marker "${blockedMarker}"` };

  // A printed total is the strongest signal the page offers, in either direction: `0 results` is a
  // zero verdict backed by the site's own counter, and `137 results` says hits exist even when not one
  // of them carried the catalog number.
  const counts: number[] = [];
  for (const match of folded.matchAll(RESULT_RANGE_PATTERN)) {
    const parsed = parseCount(match[1]);
    if (parsed !== undefined) counts.push(parsed);
  }
  for (const match of folded.matchAll(RESULT_COUNT_PATTERN)) {
    const parsed = parseCount(match[1]);
    if (parsed !== undefined) counts.push(parsed);
  }
  // Several counters can coexist (results + facet counts). The largest is the list total; a facet is
  // by definition a subset of it.
  const reported = counts.length ? Math.max(...counts) : undefined;

  if (reported !== undefined && reported > 0) {
    return { kind: "hits", count: reported, evidence: `page reports ${reported} results` };
  }

  // The shell check comes BEFORE the zero-result phrase, and the order is load-bearing.
  //
  // Client-rendered search pages routinely ship their "no results found" message in the initial HTML
  // as a hidden placeholder the framework will show only if the query really returns nothing. Reading
  // that placeholder as the page's verdict would declare every such vendor empty — and the caller uses
  // `zero` to decide NOT to escalate to the browser, which is exactly the page that needs one.
  if (looksClientRenderedSearchShell($, html, text)) {
    return { kind: "js-only", evidence: "result container is empty in static HTML and the page is client-rendered" };
  }

  // Longest first: `no results found` and `no results` both match the same sentence, and the evidence
  // string is read by a human deciding whether to trust the verdict — report the specific one.
  const zeroPhrase = [...ZERO_RESULT_PHRASES]
    .sort((left, right) => right.length - left.length)
    .find((phrase) => folded.includes(phrase));
  if ((zeroPhrase || reported === 0) && candidateCount === 0) {
    return {
      kind: "zero",
      count: reported === 0 ? 0 : undefined,
      evidence: zeroPhrase ? `page says "${zeroPhrase}"` : "page reports 0 results"
    };
  }

  if (candidateCount > 0) {
    return { kind: "hits", count: reported, evidence: `${candidateCount} product link(s) parsed from the page` };
  }

  // The page printed no counter and no zero-result sentence, but it is plainly listing products.
  //
  // Ganter's quick-finder is the measured case: eleven product-shaped links, not one of them carrying
  // the catalog number, and no result total anywhere on the page. Without this branch the verdict is
  // `unknown`, P4.7 never fires, and the one vendor the whole stage exists for is skipped — which is
  // precisely what the live probe found after the offline audit had already flagged that page. The
  // audit knowing something the runtime did not is the actual defect this branch closes.
  const resultish = countProductShapedLinks(html);
  if (resultish >= LISTING_LINK_THRESHOLD) {
    return { kind: "hits", evidence: `${resultish} product-shaped links and no result counter printed` };
  }

  return { kind: "unknown", evidence: "no result count, no zero-result phrase and no product listing" };
}

/**
 * An empty results container plus a client-rendering fingerprint. BOTH are required: a framework
 * marker alone describes most of the modern web and would classify every failure as `js-only`, which
 * is exactly the kind of answer this module exists to stop producing.
 */
export function looksClientRenderedSearchShell($: cheerio.CheerioAPI, rawHtml: string, text: string): boolean {
  const hasClientMarker = CLIENT_RENDER_MARKERS.some((marker) => rawHtml.includes(marker));
  if (!hasClientMarker) return false;
  const containers = $(RESULT_CONTAINER_SELECTORS);
  if (containers.length === 0) {
    // No container at all, and almost no visible text: a shell that has not drawn anything yet.
    return text.length < 400;
  }
  return containers.toArray().every((container) => {
    const node = $(container);
    return node.find("a[href]").length === 0 && node.text().replace(/\s+/g, " ").trim().length < 40;
  });
}
