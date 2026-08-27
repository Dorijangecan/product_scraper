import { uniqueStrings } from "../text-util.js";
import * as cheerio from "cheerio";
import type { DocumentRecord, ManufacturerConfig, ScrapeDiagnostics, SourceRecord } from "../../shared/types.js";
import { catalogTextMatches, compactCatalogNumber, fillCatalogTemplate, findCatalogTextMatch, templateContainsCatalogPlaceholder } from "./catalog-number.js";
import type { FetchedText } from "./http-client.js";
import type { ScrapeContext } from "./types.js";
import { discoverProductLinksWithDiagnostics } from "./link-discovery.js";
import { endpointTemplateFromUrl, learnEndpointFromNetworkFetch, learnSearchTemplate, learnedEndpointUrls, learnedSearchTemplateUrls } from "./learned-endpoints.js";
import { discoverSourceDocumentsWithDiagnostics } from "./source-document-discovery.js";
import { urlLooksCompressed } from "./gzip-text.js";

/** Score penalty for a learned endpoint that hasn't succeeded recently. `lastSuccessAt` only
 * advances on a real success, so a broken endpoint's timestamp freezes and ages out. Mild before
 * 30 days, larger past 90, so a stale endpoint sinks below fresh direct templates over time.
 * `now` is injectable for tests. */
export function learnedEndpointRecencyPenalty(lastSuccessAt: string | undefined, now = Date.now()): number {
  const at = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
  if (!Number.isFinite(at)) return 0;
  const ageDays = (now - at) / 86_400_000;
  if (ageDays > 90) return 20;
  if (ageDays > 30) return 8;
  return 0;
}

export interface ProductDiscoveryCandidate {
  url: string;
  score: number;
  reason: string;
  stage: "direct-template" | "localized-template" | "learned-endpoint" | "search-result" | "sitemap" | "url-variant";
  sourceType: SourceRecord["sourceType"];
}

export interface ProductDiscoveryResult {
  candidates: ProductDiscoveryCandidate[];
  documentCandidates: DocumentRecord[];
  diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "rejectedLinks" | "notes">;
}

interface SearchDiscoveryRequest {
  url: string;
  method: "GET" | "POST";
  body?: URLSearchParams;
}

export async function discoverOfficialProductCandidates(catalogNumber: string, context: ScrapeContext): Promise<ProductDiscoveryResult> {
  const memoKey = `${context.manufacturer.id}\u0000${compactCatalogNumber(catalogNumber) || catalogNumber.trim().toUpperCase()}`;
  const existing = context.discoveryMemo?.get(memoKey);
  if (existing) return existing;

  const discovery = discoverOfficialProductCandidatesUncached(catalogNumber, context);
  context.discoveryMemo?.set(memoKey, discovery);
  try {
    return await discovery;
  } catch (error) {
    // A transient network failure is not a learned negative result. Leave a later retry free to
    // make a fresh attempt instead of replaying a rejected promise for the rest of the item.
    if (context.discoveryMemo?.get(memoKey) === discovery) context.discoveryMemo.delete(memoKey);
    throw error;
  }
}

async function discoverOfficialProductCandidatesUncached(catalogNumber: string, context: ScrapeContext): Promise<ProductDiscoveryResult> {
  const candidates = new Map<string, ProductDiscoveryCandidate>();
  const attemptedUrls: string[] = [];
  const rejectedLinks: NonNullable<ScrapeDiagnostics["rejectedLinks"]> = [];
  const documentCandidates = new Map<string, DocumentRecord>();
  const notes: string[] = [];
  const manufacturer = context.manufacturer;
  const policy = manufacturer.scrapeRecipe?.discoveryPolicy;
  const maxCandidates = policy?.maxCandidates ?? 12;

  const add = (candidate: ProductDiscoveryCandidate) => {
    if (!isAllowedOfficialUrl(candidate.url, manufacturer)) {
      rejectedLinks.push({
        url: candidate.url,
        score: candidate.score,
        reason: `Rejected ${candidate.stage} candidate outside allowed official domains: ${candidate.reason}`
      });
      return;
    }
    // A search page is never the product page.
    //
    // It reaches here as a "result link" that points back at the search itself. Siemens is the
    // measured case: `…/Catalog/Search?searchTerm=S55180-A179&tab=Product` carries the exact catalog
    // number in a query parameter, so every URL-shape signal reads as a perfect match and it ranked
    // #1 for 6/6 measured catalog numbers — while link-discovery's search penalty never fired,
    // because its pattern matches `search=` and not `searchTerm=`.
    //
    // Learned endpoints are exempt: those were observed returning product identity (a vendor's JSON
    // search API answering one SKU is a legitimate product source), which is evidence, not shape.
    if (candidate.stage !== "learned-endpoint" && isSearchLikeUrl(candidate.url)) {
      rejectedLinks.push({
        url: candidate.url,
        score: candidate.score,
        reason: `Rejected ${candidate.stage} candidate: the URL is a search page, not a product page`
      });
      return;
    }
    // Neither is an image asset or a login wall. Both were only ever PENALISED
    // (`scoreDiscoveryCandidate`: -45 / -35), which loses to a URL that otherwise looks perfect —
    // and both surfaced at rank #1 the moment the search-page rejection above stopped masking them:
    // a Turck product photo (`…/79181_v0_azurecdn_640x640_72dpi.png/` — the asset penalty never even
    // fired, because its pattern requires the extension to end the URL and this one has a trailing
    // slash) and Siemens' Shibboleth SSO login carrying the catalog number in its `target` parameter.
    // A penalty is the right tool for "probably worse"; these are categorically not product pages.
    // Nor is the homepage. `https://www.nvent.com/` was ranked #1 for 8/8 measured nVent catalog
    // numbers while the real PDP sat at #2 — so the pipeline spent its first fetch on a page that
    // cannot, even in principle, identify one catalog number.
    if (isBareOriginUrl(candidate.url)) {
      rejectedLinks.push({
        url: candidate.url,
        score: candidate.score,
        reason: `Rejected ${candidate.stage} candidate: bare site origin carries no product identity`
      });
      return;
    }
    if (isNonProductAssetUrl(candidate.url) || isAuthWallUrl(candidate.url)) {
      rejectedLinks.push({
        url: candidate.url,
        score: candidate.score,
        reason: `Rejected ${candidate.stage} candidate: ${isAuthWallUrl(candidate.url) ? "login/SSO wall" : "binary asset"}, not a product page`
      });
      return;
    }
    const key = canonicalCandidateKey(candidate.url);
    const existing = candidates.get(key);
    if (!existing || candidate.score > existing.score) {
      if (existing) {
        rejectedLinks.push({
          url: existing.url,
          score: existing.score,
          reason: `Replaced duplicate ${existing.stage} candidate with higher-scoring ${candidate.stage} candidate for the same canonical URL`
        });
      }
      candidates.set(key, candidate);
      return;
    }
    rejectedLinks.push({
      url: candidate.url,
      score: candidate.score,
      reason: `Rejected duplicate ${candidate.stage} candidate because an equal or higher-scoring canonical URL was already found`
    });
  };

  const addDocuments = (documents: DocumentRecord[]) => {
    for (const document of documents) {
      if (!isAllowedOfficialUrl(document.url, manufacturer)) {
        rejectedLinks.push({
          url: document.url,
          score: Math.round((document.confidence ?? 0.4) * 100),
          reason: "Rejected discovered document outside allowed official domains"
        });
        continue;
      }
      const key = canonicalCandidateKey(document.url);
      if (!documentCandidates.has(key)) documentCandidates.set(key, document);
    }
  };

  for (const template of officialDirectTemplates(manufacturer)) {
    add({
      url: fillCatalogTemplate(template.urlTemplate, catalogNumber),
      score: template.score,
      reason: template.reason,
      stage: template.stage,
      sourceType: "official-fallback"
    });
  }

  for (const learned of learnedEndpointUrls(manufacturer, catalogNumber, context.learnedEndpoints, Math.min(maxCandidates, 12))) {
    const stalePenalty = learnedEndpointRecencyPenalty(learned.endpoint.lastSuccessAt);
    add({
      url: learned.url,
      // Success-recency decay: lastSuccessAt only advances on a real success, so a renamed/404'd
      // endpoint's timestamp freezes and its score decays over time — it stops out-ranking fresh
      // direct templates instead of sitting at the top forever.
      score: Math.min(96, 86 + Math.min(8, learned.endpoint.successCount)) - stalePenalty,
      reason: `learned official ${learned.endpoint.parserKind} endpoint (${learned.endpoint.successCount} previous success${learned.endpoint.successCount === 1 ? "" : "es"}${stalePenalty ? `, stale -${stalePenalty}` : ""})`,
      stage: "learned-endpoint",
      sourceType: "official-fallback"
    });
  }

  const configuredSearchUrls = configuredSearchTemplates(manufacturer).map((template) => fillCatalogTemplate(template, catalogNumber));
  const renderedSearchCandidates: string[] = [];
  const processedSearchUrls = new Set<string>();
  let searchedUrlCount = 0;

  // Search endpoints this vendor has already been observed answering. They go FIRST, and a hit on one
  // ends the search stage immediately — that is the whole point: the vendor's real key is tried once
  // instead of being rediscovered behind ~17 misses on every catalog number, in every run, forever.
  const learnedSearchUrls = learnedSearchTemplateUrls(manufacturer, catalogNumber, context.learnedEndpoints);
  const learnedSearchUrlSet = new Set(learnedSearchUrls.map((learned) => learned.url));

  // The blind-search cap is a TIME budget, not a request count.
  //
  // A flat cap of 28 requests means something completely different per vendor, because every request
  // is serialised behind `max(100, rateLimitMs / concurrency)` ms on that host: 28 requests cost
  // `eaton` 8,4 s and `gan` 84 s. The count was identical; the price was 10x. So derive the cap from
  // the price — the discovery share of the per-item budget (DISCOVERY-SPEED-PLAN §2) divided by what
  // one request costs this vendor. `gan` gets 2 shapes instead of 18, and after D6 those two are the
  // two the corpus says actually answer (`?q=` is the shape ganternorm.com answered on).
  //
  // Configured templates are exempt: they are curated per vendor and few, and a vendor whose own
  // configured endpoint is never tried is a coverage loss, not a saving.
  const perRequestThrottleMs = Math.max(100, Math.floor((manufacturer.rateLimitMs ?? 1500) / Math.max(1, manufacturer.concurrency ?? 3)));
  const searchRequestCap = Math.max(
    configuredSearchUrls.length,
    Math.min(28, Math.max(2, Math.floor(DISCOVERY_SEARCH_BUDGET_MS / perRequestThrottleMs)))
  );

  const processSearchRequests = async (requests: SearchDiscoveryRequest[], options: { budgetBoost?: number } = {}): Promise<void> => {
    const requestCap = searchRequestCap + (options.budgetBoost ?? 0);
    const uniqueRequests = new Map<string, SearchDiscoveryRequest>();
    for (const request of requests) {
      const key = `${request.method}\n${request.url}\n${request.body?.toString() ?? ""}`;
      if (!uniqueRequests.has(key)) uniqueRequests.set(key, request);
    }
    for (const request of uniqueRequests.values()) {
      if (searchedUrlCount >= requestCap) {
        // Say WHY it stopped. "No data" and "we ran out of budget" must never be indistinguishable.
        notes.push(
          `budget-exhausted:search — stopped after ${searchedUrlCount} search requests (cap ${requestCap} at ${perRequestThrottleMs} ms per request on this host)`
        );
        break;
      }
      const requestKey = `${request.method}\n${request.url}\n${request.body?.toString() ?? ""}`;
      if (processedSearchUrls.has(requestKey)) continue;
      processedSearchUrls.add(requestKey);
      searchedUrlCount += 1;
      attemptedUrls.push(request.method === "GET" ? request.url : `${request.method} ${request.url}`);
      let discoveredCount = 0;
      try {
        const fetched = await fetchDiscoveryText(request.url, context, request);
        const redirectedProductUrl = exactOfficialProductRedirectUrl(fetched, request.url, catalogNumber, manufacturer);
        if (redirectedProductUrl) {
          // Some official catalogue searches (Fath is a real example) answer the exact SKU with a
          // 30x straight to its PDP and no result anchors at all. The final URL is browser-observed
          // evidence, not a constructed URL guess. Keep it so the deterministic pipeline fetches
          // the PDP directly on the next step rather than treating the search endpoint as a product.
          discoveredCount += 1;
          add({
            url: redirectedProductUrl,
            score: scoreDiscoveryCandidate(redirectedProductUrl, catalogNumber, "search-result", manufacturer) + 12,
            reason: "official catalog search redirected to exact product URL",
            stage: "search-result",
            sourceType: "official-fallback"
          });
        }
        const discovered = discoverProductLinksWithDiagnostics(fetched.text, fetched.effectiveUrl, catalogNumber);
        rejectedLinks.push(...discovered.rejected);
        const sourceDocuments = discoverSourceDocumentsWithDiagnostics(fetched.text, fetched.effectiveUrl, catalogNumber, {
          sourceType: "official-fallback",
          parser: "official-discovery",
          stage: "search-document"
        });
        addDocuments(sourceDocuments.documents);
        rejectedLinks.push(...sourceDocuments.rejected);
        for (const link of discovered.candidates) {
          discoveredCount += 1;
          add({
            url: link.url,
            score: scoreDiscoveryCandidate(link.url, catalogNumber, "search-result", manufacturer) + Math.min(20, Math.round(link.score / 5)),
            reason: `official search result: ${link.reason}`,
            stage: "search-result",
            sourceType: "official-fallback"
          });
        }
        if (discoveredCount > 0 && request.method === "GET") {
          // This URL shape answered with a link carrying the requested catalog number. Remember the
          // shape so the next catalog number tries it first instead of rediscovering it.
          const learnedTemplate = learnSearchTemplate({ manufacturer, catalogNumber, searchUrl: request.url, store: context.learnedEndpoints });
          if (learnedTemplate) notes.push(`Learned working official search template: ${learnedTemplate}`);
        }
      } catch (error) {
        notes.push(`Search discovery failed for ${request.method} ${request.url}: ${formatError(error)}`);
      }
      if (discoveredCount === 0 && request.method === "GET") renderedSearchCandidates.push(request.url);
      if (learnedSearchUrlSet.has(request.url)) {
        // A learned endpoint that still works ends the stage now — no reason to re-walk the generic
        // key list. One that has stopped working takes a failure, and three of those suppress it for
        // a week (`learnedEndpointSuppressed`), so a renamed endpoint does not become a permanent tax.
        if (discoveredCount > 0) break;
        context.learnedEndpoints?.recordFailure?.(manufacturer.id, "GET", endpointTemplateFromUrl(request.url, catalogNumber) ?? request.url);
      }
      if (configuredSearchUrls.length && searchedUrlCount >= configuredSearchUrls.length && hasSearchResultCandidate(candidates)) break;
    }
  };

  // Confirm the cheapest high-confidence candidate BEFORE escalating to search.
  //
  // Measured with `npm run audit:discovery` over 160 known-good catalog numbers: 79 % of all hits
  // are produced by direct/localized templates and learned endpoints — stages that cost zero
  // requests — and yet the search stage ran first, unconditionally, at a median of 22 requests per
  // catalog number (`gan`: 29 requests x 3000 ms per-host interval = 87 s of pure waiting, before a
  // single byte is parsed). One fetch that confirms the template is strictly cheaper than 18 blind
  // search probes that confirm nothing.
  //
  // This does not trade coverage for speed. Search is skipped ONLY when a fetched page identifies
  // the exact catalog number in its own PDP identity surface (`scoreFetchedDiscoveryEvidence`) —
  // the same evidence the deterministic pipeline demands later. A candidate that is merely
  // URL-shaped (stage `url-variant`) is never probed and never gates search: a guess is not
  // evidence (P2.4n). And the probe is largely work MOVED, not added — the pipeline was going to
  // fetch the top candidate next anyway, and that fetch is now a cache hit, which pays no throttle.
  let confirmedTemplateUrl: string | undefined;
  if (policy?.verifyTemplatesBeforeSearch !== false) {
    const probeTargets = [...candidates.values()]
      .filter((candidate) => CONFIRMATION_PROBE_STAGES.has(candidate.stage))
      .sort((left, right) => right.score - left.score || left.url.length - right.url.length)
      .slice(0, MAX_CONFIRMATION_PROBES);
    for (const candidate of probeTargets) {
      attemptedUrls.push(candidate.url);
      try {
        const fetched = await fetchDiscoveryText(candidate.url, context);
        const evidence = scoreFetchedDiscoveryEvidence(fetched, catalogNumber);
        if (evidence.catalogConfirmed) {
          confirmedTemplateUrl = fetched.effectiveUrl || candidate.url;
          add({
            url: confirmedTemplateUrl,
            // Above every guess and every search result: this URL is not predicted to be the
            // product, it has been observed to be it.
            score: Math.max(candidate.score, 97),
            reason: `${candidate.reason} confirmed by fetch (${evidence.reasons.join(", ")})`,
            stage: candidate.stage,
            sourceType: "official-fallback"
          });
          notes.push(`Skipped search discovery: ${confirmedTemplateUrl} already identifies ${catalogNumber}.`);
          break;
        }
        if (fetched.statusCode === 404 || fetched.statusCode === 410) {
          // A template the vendor answers with "not here" should not keep ranking first and being
          // fetched first. Demote it in place — `add()` deliberately only ever raises a score, so
          // this cannot go through `add()`.
          //
          // The demotion is deliberately SMALL, and only for 404/410. Two reasons, both measured:
          // a 403/429/503 is bot mitigation or a rate limit, never evidence that the URL is wrong;
          // and a single hard drop pushes a correct template below the URL guesses and out of the
          // `maxCandidates` slice entirely (`rockwell/1606-XLB60E` was lost exactly that way at -40).
          // Re-ordering against sibling templates is the goal; discarding the candidate is not.
          const existing = candidates.get(canonicalCandidateKey(candidate.url));
          if (existing) {
            existing.score = Math.max(1, existing.score - 12);
            existing.reason = `${existing.reason} (probe returned HTTP ${fetched.statusCode})`;
          }
        }
      } catch (error) {
        notes.push(`Template confirmation probe failed for ${candidate.url}: ${formatError(error)}`);
      }
    }
  }

  // Learned-working endpoint first, then configured + generic search-URL templates (cheap: no extra
  // page fetch to find a form).
  if (!confirmedTemplateUrl) {
    await processSearchRequests([
      ...learnedSearchUrls.map((learned) => ({ url: learned.url, method: "GET" as const })),
      ...searchTemplates(manufacturer).map((template) => ({
        url: fillCatalogTemplate(template, catalogNumber),
        method: "GET" as const
      }))
    ]);
  }
  // Fallback for EVERY connector: if templates surfaced no product, auto-discover the site’s real
  // search FORM from the homepage and submit the catalog number to it — i.e. "type it into their
  // search box". Previously this ran only when no search templates were configured, so a broken or
  // renamed configured endpoint disabled on-site search entirely; now it is a universal safety net.
  if (!confirmedTemplateUrl && !hasSearchResultCandidate(candidates)) {
    const formRequests = await discoverSearchFormRequests(catalogNumber, context, attemptedUrls, notes);
    const allowedFormRequests = formRequests.filter((request) => {
      if (isAllowedOfficialUrl(request.url, manufacturer)) return true;
      rejectedLinks.push({
        url: request.url,
        reason: `Rejected ${request.method} search-form action outside allowed official domains`
      });
      return false;
    });
    await processSearchRequests(allowedFormRequests, { budgetBoost: FORM_REQUEST_BUDGET_BOOST });
  }

  if (!confirmedTemplateUrl && !hasSearchResultCandidate(candidates) && shouldUseRenderedSearchDiscovery(context)) {
    for (const searchUrl of renderedSearchCandidates.slice(0, 4)) {
      attemptedUrls.push(`browser:${searchUrl}`);
      try {
        // Older/injected renderers may only implement the original page method; production sessions
        // use renderSearchPage to fill the actual site search box before collecting its XHR/results.
        const rendered = await context.browserRenderer!.renderSearchPage?.(searchUrl, catalogNumber, manufacturer.scrapeRecipe, context.signal)
          ?? await context.browserRenderer!.renderProductPage(searchUrl, manufacturer.scrapeRecipe, context.signal);
        const renderedTexts = [
          ...(rendered.fetched ? [rendered.fetched] : []),
          ...rendered.networkTexts.filter((fetched) => /search|suggest|product|catalog|sku|api|json/i.test(`${fetched.effectiveUrl} ${fetched.contentType}`)).slice(0, 8)
        ];
        for (const fetched of renderedTexts) {
          const discovered = discoverProductLinksWithDiagnostics(fetched.text, fetched.effectiveUrl || searchUrl, catalogNumber);
          rejectedLinks.push(...discovered.rejected);
          const isNetworkText = fetched !== rendered.fetched;
          const sourceDocuments = discoverSourceDocumentsWithDiagnostics(fetched.text, fetched.effectiveUrl || searchUrl, catalogNumber, {
            sourceType: "official-fallback",
            parser: "official-discovery",
            stage: isNetworkText ? "rendered-search-network-document" : "rendered-search-document"
          });
          addDocuments(sourceDocuments.documents);
          rejectedLinks.push(...sourceDocuments.rejected);
          if (isNetworkText && discovered.candidates.length) {
            const learned = learnEndpointFromNetworkFetch({
              manufacturer,
              catalogNumber,
              fetched,
              discoveredFromUrl: searchUrl,
              parserKind: "browser-search-network",
              store: context.learnedEndpoints
            });
            if (learned) notes.push(`Learned search/product API endpoint from rendered search: ${fetched.effectiveUrl}`);
          }
          for (const link of discovered.candidates) {
            add({
              url: link.url,
              score: scoreDiscoveryCandidate(link.url, catalogNumber, "search-result", manufacturer) + Math.min(24, 6 + Math.round(link.score / 5)),
              reason: `rendered official search result: ${link.reason}`,
              stage: "search-result",
              sourceType: "official-fallback"
            });
          }
        }
        if (rendered.error) notes.push(`Rendered search discovery failed for ${searchUrl}: ${rendered.error}`);
        if (hasSearchResultCandidate(candidates)) break;
      } catch (error) {
        notes.push(`Rendered search discovery failed for ${searchUrl}: ${formatError(error)}`);
      }
    }
  }

  // Sitemaps run BEFORE URL guessing, and are gated on evidence rather than on a candidate count.
  //
  // Previously this block sat after `officialVariantUrls` and was gated on
  // `candidates.size < max(4, maxCandidates / 2)`. Variant guessing inserts roughly 15 candidates
  // (5 catalog-number variants x 3-4 URL shapes per base), so with the default maxCandidates of 12 the
  // threshold of 6 was always already exceeded — meaning sitemap discovery effectively never ran, and
  // never ran for exactly the site it helps most: a brand-new vendor with no templates, no learned
  // endpoints and an unusable site search. A sitemap hit is also strictly better evidence than a
  // guess, because the URL comes from the vendor's own index and therefore exists.
  if ((policy?.enableRobotsSitemaps ?? true) && !hasEvidenceBackedCandidate(candidates)) {
    for (const url of await discoverFromSitemaps(catalogNumber, context, attemptedUrls, notes)) {
      add({
        url,
        score: scoreDiscoveryCandidate(url, catalogNumber, "sitemap", manufacturer),
        reason: "official sitemap catalog match",
        stage: "sitemap",
        sourceType: "official-fallback"
      });
      if (candidates.size >= maxCandidates) break;
    }
  }

  for (const url of officialVariantUrls(manufacturer, catalogNumber)) {
    add({
      url,
      score: scoreDiscoveryCandidate(url, catalogNumber, "url-variant", manufacturer),
      reason: "official URL variant",
      stage: "url-variant",
      sourceType: "official-fallback"
    });
  }

  const sorted = [...candidates.values()]
    .sort((left, right) => right.score - left.score || left.url.length - right.url.length)
    .slice(0, maxCandidates);

  return {
    candidates: sorted,
    documentCandidates: [...documentCandidates.values()].slice(0, 20),
    diagnostics: {
      attemptedUrls,
      discoveredCandidates: sorted.map((candidate) => ({
        url: candidate.url,
        score: candidate.score,
        reason: candidate.reason,
        stage: candidate.stage,
        sourceType: candidate.sourceType
      })),
      rejectedLinks: rejectedLinks.slice(0, 30),
      notes
    }
  };
}

export function scoreDiscoveryCandidate(
  url: string,
  catalogNumber: string,
  stage: ProductDiscoveryCandidate["stage"],
  manufacturer?: ManufacturerConfig
): number {
  let score = stage === "learned-endpoint"
    ? 74
    : stage === "direct-template" || stage === "localized-template"
      ? 70
      : stage === "search-result"
        ? 58
        : stage === "sitemap"
          ? 52
          : 40;
  if (catalogTextMatches(url, catalogNumber, { compact: true, afterColon: true })) score += 30;
  if (pathContainsCatalogSegment(url, catalogNumber)) score += 35;
  if (/\b(product|products|sku|catalog|details?|partnumber|skupage)\b|\/p\//i.test(url)) score += 15;
  if (manufacturer && isAllowedOfficialUrl(url, manufacturer)) score += 10;
  if (/[?&](?:q|query|search|term)=/i.test(url)) score -= 12;
  if (/\.(?:pdf|zip|dwg|dxf|stp|step|png|jpe?g|webp)(?:[?#]|$)/i.test(url)) score -= 45;
  // A url-variant is SYNTHESISED — "{origin}/products/{part}" and friends — and is never checked for
  // existence before being scored. The bonuses above are all about URL SHAPE, and a guess is built to
  // have the ideal shape: catalog in the URL (+30), catalog as its own path segment (+35), a
  // product-ish path token (+15), official host (+10). That took a pure guess to 130, clamped to 100 —
  // above every evidence-backed stage, so guesses took rank #1 and pushed real hits out of the
  // candidate budget the deterministic pipeline actually fetches.
  //
  // Measured by scripts/audit-discovery.ts replaying real cached pages: before this cap, the known-good
  // PDP was ranked #1 for only 7.5% of catalog numbers, and in nearly every miss the #1 candidate was a
  // synthesised "{origin}/product/{compactCatalog}" that does not exist.
  //
  // Guesses are still worth trying — they are cheap and sometimes right — but they must sort BELOW
  // anything backed by evidence, so the cap sits under the search-result base of 58.
  if (stage === "url-variant") return Math.max(0, Math.min(URL_VARIANT_MAX_SCORE, score));
  return Math.max(0, Math.min(100, score));
}

/**
 * A search redirect is useful evidence only when it ends at an official, non-search URL that
 * itself contains the exact requested catalog number. A redirected login, category, or another
 * search route must remain just a discovery request, never become a PDP candidate.
 */
function exactOfficialProductRedirectUrl(
  fetched: Pick<FetchedText, "effectiveUrl" | "statusCode" | "contentType" | "text">,
  requestedUrl: string,
  catalogNumber: string,
  manufacturer: ManufacturerConfig
): string | undefined {
  if (fetched.statusCode < 200 || fetched.statusCode >= 300) return undefined;
  const effectiveUrl = fetched.effectiveUrl?.trim();
  if (!effectiveUrl || canonicalCandidateKey(effectiveUrl) === canonicalCandidateKey(requestedUrl)) return undefined;
  if (!isAllowedOfficialUrl(effectiveUrl, manufacturer) || isSearchLikeUrl(effectiveUrl)) return undefined;
  // An opaque/sluggified official PDP URL need not contain its SKU. A redirect is nevertheless
  // evidence-backed when the returned non-search page identifies the exact requested catalog on a
  // product identity surface (title/H1/OG/Product JSON-LD). Ganter's quick finder is the real
  // case: its selected variant is in the page body while the destination slug names only GN 3310.
  return findCatalogTextMatch(effectiveUrl, catalogNumber)?.level === "exact" || scoreFetchedDiscoveryEvidence(fetched, catalogNumber).catalogConfirmed
    ? effectiveUrl
    : undefined;
}

/** The site root, with nothing identifying a product: no path, no query. */
function isBareOriginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.pathname === "/" || parsed.pathname === "") && !parsed.search;
  } catch {
    return false;
  }
}

/** An image/style/script asset. Note the optional trailing slash: real vendor CDN URLs have one. */
function isNonProductAssetUrl(url: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|svg|ico|css|js)(?:\/)?(?:[?#]|$)/i.test(url);
}

/** A sign-in page. It can carry the catalog number in its `target`/`redirect` parameter and so look
 * like a perfect URL-shape match, but no product is ever extractable from it. */
function isAuthWallUrl(url: string): boolean {
  return /\/(?:login|signin|sign-in|logon|auth)(?:[/?#]|$)|\.sso\/|\/sso\/|auth0\.com/i.test(url);
}

function isSearchLikeUrl(url: string): boolean {
  return /\/(?:site-)?search(?:\/|$)|[?&](?:s|q|query|search|term|text|keyword|searchterm)=/i.test(url);
}

/** Evidence collected only AFTER a candidate URL has been fetched. URL shape is useful for deciding
 * what to try, but it is not proof that a guessed / redirected address is the requested product.
 * A page must identify the exact catalog in its own PDP identity surface (title, H1, OG title, or
 * Product JSON-LD) before deterministic discovery merges its extracted fields. */
export function scoreFetchedDiscoveryEvidence(
  fetched: Pick<FetchedText, "effectiveUrl" | "statusCode" | "contentType" | "text">,
  catalogNumber: string
): { score: number; catalogConfirmed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (fetched.statusCode >= 200 && fetched.statusCode < 300) {
    score += 15;
    reasons.push(`HTTP ${fetched.statusCode}`);
  } else {
    reasons.push(`HTTP ${fetched.statusCode}`);
  }

  const effectiveUrlIsSearch = isSearchLikeUrl(fetched.effectiveUrl);
  if (effectiveUrlIsSearch) {
    score -= 45;
    reasons.push("effective URL is a search page");
  } else if (catalogTextMatches(fetched.effectiveUrl, catalogNumber, { compact: true, afterColon: true })) {
    score += 12;
    reasons.push("effective URL contains catalog");
  }

  const $ = cheerio.load(fetched.text);
  const exact = (value: string | undefined) => Boolean(value && findCatalogTextMatch(value, catalogNumber)?.level === "exact");
  const title = $("title").first().text();
  const h1 = $("h1").first().text();
  const ogTitle = $("meta[property='og:title']").attr("content");
  const productJsonLd = $("script[type='application/ld+json']")
    .toArray()
    .some((element) => {
      const json = $(element).text();
      return /"@type"\s*:\s*"Product"/i.test(json) && exact(json);
    });
  const productJsonResponse = jsonResponseHasProductIdentity(fetched.text, fetched.contentType, catalogNumber);
  const titleMatch = exact(title);
  const h1Match = exact(h1);
  const ogTitleMatch = exact(ogTitle);
  if (titleMatch) {
    score += 30;
    reasons.push("catalog in document title");
  }
  if (h1Match) {
    score += 38;
    reasons.push("catalog in H1");
  }
  if (ogTitleMatch) {
    score += 25;
    reasons.push("catalog in OG title");
  }
  if (productJsonLd) {
    score += 45;
    reasons.push("catalog in Product JSON-LD");
  }
  if (productJsonResponse) {
    score += 45;
    reasons.push("catalog in Product JSON response");
  }

  // A search-results title commonly repeats the requested catalog, so it is deliberately not
  // enough by itself. One product identity marker on a non-search effective URL is required.
  const catalogConfirmed = !effectiveUrlIsSearch && (titleMatch || h1Match || ogTitleMatch || productJsonLd || productJsonResponse);
  if (!catalogConfirmed) reasons.push("no exact catalog evidence on a product identity surface");
  return { score: Math.max(0, Math.min(100, score)), catalogConfirmed, reasons };
}

/** A learned browser/network endpoint frequently returns JSON rather than an HTML PDP. The generic
 * parser already accepts that payload, so evidence must accept it too — but only when an exact SKU
 * occurs in an identity key and the same object looks product-shaped, never merely because a search
 * response happens to echo the query. */
function jsonResponseHasProductIdentity(text: string, contentType: string | undefined, catalogNumber: string): boolean {
  if (!/json/i.test(contentType ?? "") && !/^\s*[\[{]/.test(text)) return false;
  try {
    return jsonValueHasProductIdentity(JSON.parse(text) as unknown, catalogNumber, 0);
  } catch {
    return false;
  }
}

function jsonValueHasProductIdentity(value: unknown, catalogNumber: string, depth: number): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => jsonValueHasProductIdentity(entry, catalogNumber, depth + 1));
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  const exactIdentity = entries.some(([key, entry]) =>
    /^(?:sku|mpn|product(?:id|number|code)?|catalog(?:number|no|id)?|article(?:number|no|id)?|model(?:number|code)?|part(?:number|no|id)?)$/i.test(key) &&
    typeof entry === "string" && findCatalogTextMatch(entry, catalogNumber)?.level === "exact"
  );
  const productShape = entries.some(([key, entry]) =>
    /^(?:@type|name|title|description|material|specifications?|attributes?|properties|weight|dimensions?)$/i.test(key) &&
    (typeof entry === "string" || (entry && typeof entry === "object"))
  );
  if (exactIdentity && productShape) return true;
  return entries.some(([, entry]) => jsonValueHasProductIdentity(entry, catalogNumber, depth + 1));
}

/** Ceiling for synthesised URL guesses — deliberately below the `search-result` base score (58). */
const URL_VARIANT_MAX_SCORE = 55;

function officialDirectTemplates(manufacturer: ManufacturerConfig): Array<{
  urlTemplate: string;
  score: number;
  reason: string;
  stage: ProductDiscoveryCandidate["stage"];
}> {
  return [
    ...(manufacturer.localizedUrlTemplates ?? []).map((template) => ({
      urlTemplate: template.urlTemplate,
      // Below the vendor's own primary route. A localized template is an ALTERNATE — one of several
      // language editions of the same page — and nothing about it says it is the right edition for
      // this catalog number. Eaton is the measured case: its canonical
      // `www.eaton.com/us/en-us/skuPage.{part}.html` sat at rank 4 behind the GB, DE and CN
      // alternates, so the confirmation probe fetched three wrong locales, never reached the right
      // page, and the full 20-request search stage ran for a catalog number already in hand.
      score: 78 - cadPortalPenalty(template.urlTemplate),
      reason: `${template.locale.toUpperCase()} localized official template`,
      stage: "localized-template" as const
    })),
    ...manufacturer.officialBaseUrls.filter(templateContainsCatalogPlaceholder).map((urlTemplate) => ({
      urlTemplate,
      score: 82 - cadPortalPenalty(urlTemplate),
      reason: "official URL template",
      stage: "direct-template" as const
    })),
    ...manufacturer.fallbackSources
      .filter((source) => source.enabled && source.sourceType === "official-fallback")
      .flatMap((source) =>
        source.directUrlTemplates.map((urlTemplate) => ({
          urlTemplate,
          score: (source.confidence ? Math.round(source.confidence * 100) : 68) - cadPortalPenalty(urlTemplate),
          reason: `official configured source: ${source.label}`,
          stage: "direct-template" as const
        }))
      )
  ].filter((template) => templateContainsCatalogPlaceholder(template.urlTemplate) && !isSearchLikeUrl(template.urlTemplate));
}

function searchTemplates(manufacturer: ManufacturerConfig): string[] {
  const configured = configuredSearchTemplates(manufacturer);
  return [...new Set([...configured, ...genericOfficialSearchTemplates(manufacturer)])];
}

function configuredSearchTemplates(manufacturer: ManufacturerConfig): string[] {
  return [
    ...(manufacturer.scrapeRecipe?.discoveryPolicy?.searchUrlTemplates ?? []),
    ...(manufacturer.scrapeRecipe?.searchUrlTemplates ?? []),
    // A localized URL template often records a vendor's best *entry point*, not necessarily an
    // already-resolved PDP. Fath's /en/search?search={part} is the real example: treating it as a
    // direct template skipped the one request whose HTTP redirect supplied the canonical product
    // slug. Route any explicitly search-shaped localized/fallback template through the search path.
    ...(manufacturer.localizedUrlTemplates ?? []).map((template) => template.urlTemplate),
    ...manufacturer.fallbackSources
      .filter((source) => source.enabled && source.sourceType === "official-fallback")
      .flatMap((source) => source.directUrlTemplates)
  ].filter((template) => templateContainsCatalogPlaceholder(template) && isSearchLikeUrl(template));
}

/**
 * Generic search shapes, ordered by EVIDENCE from the cached corpus — nothing removed, only reordered.
 *
 * Measured over every search-shaped URL in `page_cache` (`tmp/analyze-query-keys.ts`), counting how
 * often the cached body actually came back carrying a link to the requested catalog number:
 *
 * | shape            | answered / tried | vendors that answered            |
 * | ---------------- | ---------------: | -------------------------------- |
 * | `?q=`            |         71 / 459 | schmersal, turck, ganternorm     |
 * | `/search/{part}` |       182 / 184  | abb, saginaw                     |
 * | `?s=`            |         62 / 62  | abb (legacy), saginaw            |
 * | `?query=`        |       546 / 969  | schmersal                        |
 * | `?searchTerm=`   |         28 / 56  | siemens                          |
 * | `?search=`       |          1 / 76  | fath                             |
 * | `?text=`         |          0 / 23  | —                                |
 * | `?keyword=`      |          0 / 29  | —                                |
 * | `Ntt`,`k`,`article`,`partNumber`,`/site-search` | never even tried | — |
 *
 * Ordered by distinct answering vendors first, then by volume: a generic list's job is breadth, and
 * the volume column is biased by how often our own code happened to request each shape.
 *
 * Two findings worth naming, both from that table:
 * 1. `/search/{part}` answers 182 out of 184 times and was **unreachable** for any vendor with two or
 *    more URL bases — it sat after all 11 query keys and `.slice(0, 18)` cut it off. Which shapes a
 *    vendor got to try depended on how many bases it happened to have configured, not on evidence.
 * 2. The last four keys have never been requested once in the whole corpus, for the same reason. They
 *    are kept (removing an untried shape would be a silent coverage loss) but ranked last.
 */
const GENERIC_SEARCH_SHAPES = [
  "/search?q={part}",
  "/search/{part}",
  "/search?s={part}",
  "/search?query={part}",
  "/search?searchTerm={part}",
  "/search?search={part}",
  "/search?text={part}",
  "/search?keyword={part}",
  "/search?Ntt={part}",
  "/search?k={part}",
  "/search?article={part}",
  "/search?partNumber={part}",
  "/site-search?q={part}"
] as const;

function genericOfficialSearchTemplates(manufacturer: ManufacturerConfig): string[] {
  const bases = new Set<string>();
  for (const base of officialUrlBases(manufacturer)) {
    bases.add(base.origin);
    const localePrefix = localePathPrefix(base.segments);
    if (localePrefix) bases.add(`${base.origin}/${localePrefix}`);
  }

  const templates: string[] = [];
  // Interleave bases by shape so a locale-specific base gets the common shapes too; the bounded
  // discovery budget used to spend every slot on the bare origin before reaching /en-us/.
  const cleanBases = [...bases].map((base) => base.replace(/\/+$/g, ""));
  for (const shape of GENERIC_SEARCH_SHAPES) {
    for (const cleanBase of cleanBases) {
      templates.push(`${cleanBase}${shape}`);
    }
  }
  return templates.slice(0, 18);
}

function localePathPrefix(segments: string[]): string | undefined {
  const first = segments[0];
  const second = segments[1];
  if (!first) return undefined;
  if (/^[a-z]{2}(?:-[a-z]{2})?$/i.test(first)) return first;
  if (/^[a-z]{2}$/i.test(first) && /^[a-z]{2}$/i.test(second ?? "")) return `${first}/${second}`;
  return undefined;
}

/**
 * Discovery's share of the per-item budget (DISCOVERY-SPEED-PLAN §2), spent on blind search.
 *
 * It bounds the throttle WAIT, not the request count, so it means the same thing for a vendor at
 * 300 ms per request as for one at 3000 ms. Response latency sits on top of this — the figure is a
 * floor, which is why it is generous relative to the 6 s the plan allocates to discovery overall.
 */
const DISCOVERY_SEARCH_BUDGET_MS = 6000;

/** The same idea for the homepage probes that look for the vendor's real search form. */
const FORM_PROBE_BUDGET_MS = 3000;

/**
 * Extra requests the form-derived pass may spend beyond the blind-search cap.
 *
 * Without it the priority is inverted: `gan` spent its whole search budget on two blind generic
 * shapes, then found the vendor's declared form action and had nothing left to submit it with. A form
 * action read off the vendor's own page is evidence; a generic query key is a guess. Evidence gets its
 * own allowance rather than the guesses' leftovers.
 */
const FORM_REQUEST_BUDGET_BOOST = 3;

/**
 * A 3D/CAD viewer portal is not a product data sheet, so it must not be fetched ahead of one.
 *
 * ABB's `abb-control-products.partcommunity.com/3d-cad-models/?part={part}` sits in its
 * `officialBaseUrls` next to `new.abb.com`, so it outranked the smartlink that IS the product page and
 * took the first confirmation probe. It stays a candidate (the portal is a real ABB route and P1.1q
 * already documents that its cookie wall is not a PDP) — it just stops going first.
 *
 * This is deliberately a narrow pattern rather than the "penalise every off-host template" rule I
 * tried first: that generic version measured as a REGRESSION (nVent's confirming template lives on a
 * second legitimate host, so nVent's hit@1 fell 100% -> 0% and its cost went 3 -> 10 requests).
 * Plenty of vendors serve products from more than one host; almost none serve them from a CAD viewer.
 */
function cadPortalPenalty(urlTemplate: string): number {
  return /partcommunity|cadenas|\b3d-cad|\/cad-models|ecadmodel/i.test(urlTemplate) ? 20 : 0;
}

/** Stages worth spending one confirmation fetch on: configured or learned, never a bare guess. */
const CONFIRMATION_PROBE_STAGES: ReadonlySet<ProductDiscoveryCandidate["stage"]> = new Set([
  "learned-endpoint",
  "direct-template",
  "localized-template"
]);

/**
 * Three probes at most. Beyond that the blind search stage is the cheaper bet again.
 *
 * Measured, not guessed: at 2 probes nVent paid 9 requests per catalog number because its confirming
 * template sits third in its own candidate list, so the probe missed it and the full search stage ran.
 * At 3 probes that fell to 3 requests (4,5 s -> 1,5 s of modelled throttle) and the corpus total went
 * 2010 -> 1890 requests. One extra probe risks 1 request; a confirmed probe saves up to 18.
 */
const MAX_CONFIRMATION_PROBES = 3;

function hasSearchResultCandidate(candidates: Map<string, ProductDiscoveryCandidate>): boolean {
  return [...candidates.values()].some((candidate) => candidate.stage === "search-result");
}

/**
 * Does any candidate rest on actual evidence rather than a guess?
 *
 * `url-variant` candidates are synthesised by pattern ({origin}/products/{part} and friends) and are
 * never checked for existence before being scored, so their presence says nothing about whether we
 * have found anything. Every other stage does rest on evidence: a configured or localized template, a
 * learned endpoint that previously worked, or a link found on a fetched search-results page.
 */
function hasEvidenceBackedCandidate(candidates: Map<string, ProductDiscoveryCandidate>): boolean {
  return [...candidates.values()].some((candidate) => candidate.stage !== "url-variant");
}

function shouldUseRenderedSearchDiscovery(context: ScrapeContext): boolean {
  if (!context.browserRenderer) return false;
  if (context.browserRenderer.isUnavailable?.()) return false;
  if (context.manufacturer.scrapeRecipe?.fallbackPolicy?.browserOnQualityFailure === false) return false;
  if (context.manufacturer.scrapeRecipe?.fallbackPolicy?.maxBrowserAttempts === 0) return false;
  return true;
}

async function discoverSearchFormRequests(
  catalogNumber: string,
  context: ScrapeContext,
  attemptedUrls: string[],
  notes: string[]
): Promise<SearchDiscoveryRequest[]> {
  const requests: SearchDiscoveryRequest[] = [];
  // The configured homepage is a locale entry point, not necessarily the locale that exposes a
  // product lookup form. A homepage's hreflang alternates are vendor-declared equivalent entry
  // points, so probe a small official-only extension of the initial set before falling back to
  // URL-shaped guesses. This deliberately follows only alternates of probe pages (not arbitrary
  // page links) and limits the total to six to keep discovery bounded for a new vendor.
  //
  // Both bounds below are budgeted the same way the search stage is, because this loop was measured
  // spending more than the search stage it exists to rescue: for `gan` it fetched SIX homepage
  // variants (`/`, `/en`, `/en/home`, `/de/home`, `/fr/home`, `/es/home`) at 3000 ms each — 18 s of a
  // 30 s item — and kept going after the first page had already produced the form.
  const perRequestThrottleMs = Math.max(
    100,
    Math.floor((context.manufacturer.rateLimitMs ?? 1500) / Math.max(1, context.manufacturer.concurrency ?? 3))
  );
  const maxProbePages = Math.max(1, Math.min(6, Math.floor(FORM_PROBE_BUDGET_MS / perRequestThrottleMs)));
  const probeQueue = searchFormProbePages(context.manufacturer).slice(0, 4);
  const queued = new Set(probeQueue.map(canonicalCandidateKey));
  for (let index = 0; index < probeQueue.length && index < maxProbePages; index += 1) {
    const pageUrl = probeQueue[index];
    attemptedUrls.push(pageUrl);
    try {
      const fetched = await fetchDiscoveryText(pageUrl, context);
      requests.push(...searchRequestsFromForms(fetched.text, fetched.effectiveUrl, catalogNumber));
      // The vendor's search form is in hand. Another locale's copy of the same form teaches nothing.
      if (requests.length) break;
      for (const alternateUrl of hreflangProbeUrls(fetched.text, fetched.effectiveUrl)) {
        if (!isAllowedOfficialUrl(alternateUrl, context.manufacturer)) continue;
        const key = canonicalCandidateKey(alternateUrl);
        if (queued.has(key) || probeQueue.length >= 6) continue;
        queued.add(key);
        probeQueue.push(alternateUrl);
      }
    } catch (error) {
      notes.push(`Search form discovery failed for ${pageUrl}: ${formatError(error)}`);
    }
  }
  const uniqueRequests = new Map<string, SearchDiscoveryRequest>();
  for (const request of requests) {
    const key = `${request.method}\n${request.url}\n${request.body?.toString() ?? ""}`;
    if (!uniqueRequests.has(key)) uniqueRequests.set(key, request);
  }
  return [...uniqueRequests.values()].slice(0, 10);
}

/** Vendor-declared locale entries only. Product-page alternates remain link-discovery's job. */
function hreflangProbeUrls(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  $("link[rel='alternate'][hreflang][href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    try {
      const url = new URL(href, baseUrl);
      if (/^https?:$/i.test(url.protocol)) urls.add(url.toString());
    } catch {
      // Broken alternate markup is no more trustworthy than a broken configured URL.
    }
  });
  return [...urls];
}

function searchFormProbePages(manufacturer: ManufacturerConfig): string[] {
  const pages = new Set<string>();
  for (const base of officialUrlBases(manufacturer)) {
    pages.add(base.origin);
    const localePrefix = localePathPrefix(base.segments);
    if (localePrefix) pages.add(`${base.origin}/${localePrefix}`);
    if (!base.hasCatalogPlaceholder && base.pathname) {
      pages.add(`${base.origin}${base.pathname}`);
    }
  }
  return [...pages].filter((url) => /^https?:\/\//i.test(url));
}

function searchRequestsFromForms(html: string, baseUrl: string, catalogNumber: string): SearchDiscoveryRequest[] {
  const $ = cheerio.load(html);
  const requests: SearchDiscoveryRequest[] = [];
  $("form").each((_, form) => {
    const method = ($(form).attr("method") || "get").toLowerCase();
    if (method && method !== "get" && method !== "post") return;
    const formContext = cleanFormContext($, form);
    const queryName = searchQueryInputName($, form, formContext);
    if (!queryName) return;
    const action = $(form).attr("action") || baseUrl;
    let target: URL;
    try {
      target = new URL(action, baseUrl);
    } catch {
      return;
    }
    const fields = successfulFormFields($, form, queryName, catalogNumber);
    if (method === "post") {
      requests.push({ url: target.toString(), method: "POST", body: fields });
      return;
    }
    for (const [name, value] of fields) target.searchParams.append(name, value);
    requests.push({ url: target.toString(), method: "GET" });
  });
  return requests;
}

/** Return browser-like successful form controls without submitting credentials, file inputs, or
 * unselected checkboxes. This lets discovery preserve CSRF/scope/locale values for POST product
 * lookup forms while keeping the submitted catalog number as the only user-provided value. */
function successfulFormFields(
  $: cheerio.CheerioAPI,
  form: Parameters<cheerio.CheerioAPI>[0],
  queryName: string,
  catalogNumber: string
): URLSearchParams {
  const fields = new URLSearchParams();
  $(form).find("input[name],select[name],textarea[name]").each((_, control) => {
    const element = $(control);
    const name = element.attr("name");
    if (!name || element.is(":disabled") || name === queryName) return;
    const tagName = control.tagName.toLowerCase();
    const inputType = (element.attr("type") || "").toLowerCase();
    if (tagName === "input" && /^(?:button|submit|reset|image|file)$/i.test(inputType)) return;
    if (tagName === "input" && /^(?:checkbox|radio)$/i.test(inputType) && !element.is(":checked")) return;
    if (tagName === "select") {
      const selected = element.find("option:selected");
      const options = selected.length ? selected : element.find("option").first();
      options.each((__, option) => fields.append(name, $(option).attr("value") ?? $(option).text()));
      return;
    }
    fields.append(name, element.attr("value") ?? "");
  });
  fields.set(queryName, catalogNumber);
  return fields;
}

function cleanFormContext($: cheerio.CheerioAPI, form: Parameters<cheerio.CheerioAPI>[0]): string {
  return [
    $(form).attr("role"),
    $(form).attr("class"),
    $(form).attr("id"),
    $(form).attr("action"),
    $(form).text(),
    $(form).find("input,button").map((_, input) => [$(input).attr("type"), $(input).attr("name"), $(input).attr("id"), $(input).attr("placeholder"), $(input).attr("aria-label"), $(input).attr("value")].filter(Boolean).join(" ")).get().join(" ")
  ]
    .map((value) => String(value ?? ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchQueryInputName($: cheerio.CheerioAPI, form: Parameters<cheerio.CheerioAPI>[0], context: string): string | undefined {
  const hasSearchContext = /\b(search|suche|find|keyword|query|site-search|site search|product search|catalog search|product finder|part finder)\b/i.test(context);
  const inputs = $(form).find("input[name],select[name],textarea[name]").toArray();
  const ranked = inputs
    .map((input) => {
      const name = $(input).attr("name") ?? "";
      const haystack = [name, $(input).attr("type"), $(input).attr("id"), $(input).attr("class"), $(input).attr("placeholder"), $(input).attr("aria-label")].filter(Boolean).join(" ");
      let score = 0;
      if (/^(?:q|s|query|search|text|keyword|searchTerm|term)$/i.test(name)) score += 50;
      if (/\b(?:catalog|catalogue|cat|part|partnumber|part-number|part_number|mpn|sku|article|article-no|articleno|article_number|item|item-no|itemno|product(?:code|id|number)?|model|mlfb)\b/i.test(haystack)) score += 45;
      if (/search/i.test($(input).attr("type") ?? "")) score += 30;
      if (/\b(search|suche|find|keyword|query|term|text)\b/i.test(haystack)) score += 20;
      if (/email|mail|zip|postal|country|language|csrf|token|session|password|login/i.test(haystack)) score -= 80;
      // The surrounding form text is context for the FORM, never evidence about this FIELD.
      return { name, ownScore: score, score: score + (hasSearchContext ? 10 : 0) };
    })
    // A field must earn its place on its own name/type/placeholder. Ganter is the measured case: its
    // sales-partner flyout says "find", which set hasSearchContext, which both handed every field a
    // +10 and waived the 40-point bar below — so `salespartner[__referrer][@extension]`, a hidden
    // TYPO3 plumbing field, was picked as the search box and the catalog number was submitted into a
    // contact form. Twice per catalog number, ahead of the real quick-finder form.
    .filter((item) => item.name && item.ownScore > 0)
    .sort((left, right) => right.score - left.score);
  if (!ranked[0]) return undefined;
  if (!hasSearchContext && ranked[0].score < 40) return undefined;
  return ranked[0].name;
}

function officialVariantUrls(manufacturer: ManufacturerConfig, catalogNumber: string): string[] {
  const urls: string[] = [];
  const variants = urlVariantValues(catalogNumber, manufacturer.scrapeRecipe?.discoveryPolicy?.urlVariants);
  // Guessing a direct product URL must stay confined to origins the manufacturer actually declared
  // as the catalog base (`officialBaseUrls`) — never `homepageUrl`'s origin on its own.
  // `officialUrlBases` deliberately ALSO returns homepageUrl-derived bases, because ITS callers use
  // them as a locale SEARCH entry point (see its own docstring) — but appending a slugified catalog
  // number onto a bare homepage origin guesses a URL on a domain nobody declared hosts product
  // pages at all. Confirmed live: FATH's `homepageUrl` is a DIFFERENT apex domain (fath.com; the real
  // catalog is fath24.com), so this guessed `https://www.fath.com/en/{variant}` outranked the real
  // fath24.com product URL in a real `npm run audit:discovery` replay.
  const officialOrigins = new Set(
    manufacturer.officialBaseUrls.flatMap((baseUrl) => {
      try {
        return [new URL(baseUrl).origin];
      } catch {
        return [];
      }
    })
  );
  for (const parsed of officialUrlBases(manufacturer).filter((base) => officialOrigins.has(base.origin))) {
    const base = `${parsed.origin}${parsed.pathname}`;
    for (const variant of variants.slice(0, 5)) {
      if (parsed.pathname) urls.push(`${base}/${encodeURIComponent(variant)}`);
      urls.push(`${parsed.origin}/products/${encodeURIComponent(variant)}`);
      urls.push(`${parsed.origin}/product/${encodeURIComponent(variant)}`);
      urls.push(`${parsed.origin}/search?q=${encodeURIComponent(variant)}`);
    }
  }
  return [...new Set(urls)];
}

function officialUrlBases(manufacturer: ManufacturerConfig): Array<{
  origin: string;
  pathname: string;
  segments: string[];
  hasCatalogPlaceholder: boolean;
}> {
  const bases: Array<{ origin: string; pathname: string; segments: string[]; hasCatalogPlaceholder: boolean }> = [];
  const seen = new Set<string>();
  // `homepageUrl` is often the only configured locale entry point (for example `/en-us/`), while
  // officialBaseUrls may deliberately stay at the bare origin for direct-product templates. It is
  // equally official discovery evidence and must participate in search/form probing.
  for (const baseUrl of uniqueStrings([...manufacturer.officialBaseUrls, manufacturer.homepageUrl])) {
    try {
      const parsed = new URL(baseUrl);
      const rawSegments = parsed.pathname.split("/").filter(Boolean).map((segment) => safeDecode(segment));
      const placeholderIndex = rawSegments.findIndex((segment) => templateContainsCatalogPlaceholder(segment));
      const segments = placeholderIndex >= 0 ? rawSegments.slice(0, placeholderIndex) : rawSegments;
      const pathname = segments.length ? `/${segments.map(encodeURIComponent).join("/")}`.replace(/\/+$/g, "") : "";
      const key = `${parsed.origin}${pathname}|${templateContainsCatalogPlaceholder(baseUrl) ? "template" : "base"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bases.push({
        origin: parsed.origin,
        pathname,
        segments,
        hasCatalogPlaceholder: templateContainsCatalogPlaceholder(baseUrl)
      });
    } catch {
      // Invalid configured URLs are ignored; direct templates already validate elsewhere.
    }
  }
  return bases;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function urlVariantValues(catalogNumber: string, requested: Array<string> | undefined): string[] {
  const afterColon = catalogNumber.includes(":") ? catalogNumber.split(":").pop() ?? catalogNumber : catalogNumber;
  const all: Record<string, string> = {
    part: catalogNumber,
    partUpper: catalogNumber.toUpperCase(),
    partLower: catalogNumber.toLowerCase(),
    partCompact: compactCatalogNumber(catalogNumber),
    partSnake: catalogNumber.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase(),
    partDash: catalogNumber.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase(),
    partAfterColon: afterColon,
    partAfterColonCompact: compactCatalogNumber(afterColon)
  };
  const keys = requested ? requested : ["part", "partUpper", "partLower", "partCompact", "partAfterColon", "partAfterColonCompact"];
  return [...new Set(keys.map((key) => all[key]).filter(Boolean))];
}

/**
 * Fetch a sitemap, transparently handling `sitemap.xml.gz`.
 *
 * The `.gz` in a sitemap URL is the FILE format, not a transport encoding, so `fetch` hands back raw
 * deflate bytes and the plain text fetch yields mojibake — `extractSitemapLocs` then finds no `<loc>`
 * and reports zero URLs with no error at all. Sitemap indexes are commonly gzipped, so this was a
 * silent hole in the one discovery channel a brand-new vendor reliably offers.
 *
 * The binary path is used only when the URL looks compressed, and only when the client supports it —
 * discovery is also driven by test stubs and by the offline replay audit, which implement `fetchText`
 * alone. Falls back to the plain fetch on any failure: a sitemap is best-effort.
 */
async function fetchSitemapText(sitemapUrl: string, context: ScrapeContext): Promise<{ text: string }> {
  if (urlLooksCompressed(sitemapUrl) && typeof context.http.fetchMaybeCompressedText === "function") {
    try {
      return await context.http.fetchMaybeCompressedText(sitemapUrl, { signal: context.signal });
    } catch {
      // fall through to the plain text fetch below
    }
  }
  return fetchDiscoveryText(sitemapUrl, context);
}

async function discoverFromSitemaps(
  catalogNumber: string,
  context: ScrapeContext,
  attemptedUrls: string[],
  notes: string[]
): Promise<string[]> {
  const manufacturer = context.manufacturer;
  const sitemapUrls = [
    ...(manufacturer.scrapeRecipe?.discoveryPolicy?.sitemapUrls ?? []),
    ...(await robotsSitemapUrls(context, attemptedUrls, notes))
  ];
  const found = new Set<string>();
  const queue = [...new Set(sitemapUrls)].slice(0, 8);
  const compactPart = compactCatalogNumber(catalogNumber);

  while (queue.length && found.size < 12) {
    const sitemapUrl = queue.shift()!;
    attemptedUrls.push(sitemapUrl);
    try {
      const fetched = await fetchSitemapText(sitemapUrl, context);
      const locs = extractSitemapLocs(fetched.text);
      for (const loc of locs) {
        if (catalogTextMatches(loc, catalogNumber, { compact: true, afterColon: true }) || compactCatalogNumber(loc).includes(compactPart)) {
          found.add(loc);
          continue;
        }
        if (queue.length < 8 && /sitemap/i.test(loc) && /\b(product|catalog|sku|pim|en|de)\b/i.test(loc)) queue.push(loc);
      }
    } catch (error) {
      notes.push(`Sitemap discovery failed for ${sitemapUrl}: ${formatError(error)}`);
    }
  }
  return [...found].filter((url) => isAllowedOfficialUrl(url, manufacturer));
}

async function robotsSitemapUrls(context: ScrapeContext, attemptedUrls: string[], notes: string[]): Promise<string[]> {
  const urls = new Set<string>();
  for (const origin of officialOrigins(context.manufacturer).slice(0, 3)) {
    const robotsUrl = `${origin}/robots.txt`;
    attemptedUrls.push(robotsUrl);
    try {
      const fetched = await fetchDiscoveryText(robotsUrl, context);
      for (const match of fetched.text.matchAll(/^sitemap:\s*(.+)$/gim)) urls.add(match[1].trim());
    } catch (error) {
      notes.push(`Robots discovery failed for ${robotsUrl}: ${formatError(error)}`);
    }
    urls.add(`${origin}/sitemap.xml`);
  }
  return [...urls];
}

// 24h TTL for discovery indexes (sitemaps, robots.txt, search-result pages). These change
// far more often than individual product pages, so the default 7-day product-page TTL is
// inappropriate — a stale sitemap can hide newly published catalog numbers for days.
const DISCOVERY_INDEX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isDiscoveryIndexUrl(url: string): boolean {
  return /\/sitemap[^/]*\.xml\b|\/robots\.txt\b|[?&](?:q|query|search|text|keyword|searchTerm)=|\/(?:site-)?search(?:\b|[/?])/i.test(url);
}

async function fetchDiscoveryText(url: string, context: ScrapeContext, request: Pick<SearchDiscoveryRequest, "method" | "body"> = { method: "GET" }): Promise<FetchedText> {
  const policy = context.manufacturer.fetchPolicy ?? {};
  const indexOverride = isDiscoveryIndexUrl(url) || request.method === "POST" ? DISCOVERY_INDEX_CACHE_TTL_MS : undefined;
  return context.http.fetchText(url, {
    method: request.method,
    body: request.body,
    timeoutMs: Math.min(policy.timeoutMs ?? 15000, 30000),
    cacheTtlMs: indexOverride ?? policy.cacheTtlMs,
    maxAttempts: 1,
    headers: {
      ...(policy.userAgent ? { "user-agent": policy.userAgent } : {}),
      ...(policy.acceptLanguage ? { "accept-language": policy.acceptLanguage } : {}),
      ...(policy.referer ? { referer: policy.referer } : {}),
      ...(request.method === "POST" ? { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" } : {})
    },
    signal: context.signal
  });
}

function extractSitemapLocs(text: string): string[] {
  return [...text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)]
    .map((match) => decodeXml(match[1].trim()))
    .filter((url) => /^https?:\/\//i.test(url));
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function isAllowedOfficialUrl(url: string, manufacturer: ManufacturerConfig): boolean {
  const allowed = [
    ...(manufacturer.scrapeRecipe?.discoveryPolicy?.allowedOfficialDomains ?? []),
    ...officialOrigins(manufacturer).map((origin) => {
      try {
        return new URL(origin).hostname;
      } catch {
        return origin;
      }
    })
  ].map((host) => host.replace(/^https?:\/\//i, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase());

  if (!allowed.length) return true;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return allowed.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`));
  } catch {
    return false;
  }
}

function officialOrigins(manufacturer: ManufacturerConfig): string[] {
  return [...new Set(uniqueStrings([...manufacturer.officialBaseUrls, manufacturer.homepageUrl]).flatMap((baseUrl) => {
    try {
      return [new URL(baseUrl).origin];
    } catch {
      return [];
    }
  }))];
}

function canonicalCandidateKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)$/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function pathContainsCatalogSegment(url: string, catalogNumber: string): boolean {
  try {
    const compactPart = compactCatalogNumber(catalogNumber);
    return new URL(url).pathname
      .split("/")
      .map((segment) => compactCatalogNumber(decodeURIComponent(segment)))
      .some((segment) => segment === compactPart);
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

