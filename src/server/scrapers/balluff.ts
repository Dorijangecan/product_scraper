import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { AttributeRecord, DocumentRecord, LocalizedUrlTemplate, ProductResult, ScrapeRecipeConfig } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { classifyDocument, cleanText, emptyResult, mergeResults, normalizeFields } from "./normalizer.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { catalogTextMatches, sameCatalogNumber } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments, dedupeSources } from "./dedupe.js";
import { enrichResultFromDownloadedDocuments } from "./document-enrichment.js";
import { findBestProductLink } from "./link-discovery.js";
import { renderProductPage, type ModalSection } from "./browser-renderer.js";

const BALLUFF_PRODUCT_LOCALES = ["en-gb", "en-us", "de-de", "en-de", "en-ca", "en-au", "en-in", "en-xi"];
const BALLUFF_ACCEPT_LANGUAGE = "en-GB,en;q=0.9,en-US;q=0.8,de;q=0.6";
const BALLUFF_REFERER = "https://www.balluff.com/en-gb/products";
const BALLUFF_BOT_USER_AGENT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BALLUFF_PARSER_VERSION = "balluff-v3";
const BALLUFF_KNOWN_PRODUCT_CODE_ALIASES: Record<string, string[]> = {
  BTL4W6A: ["BTL4E6W"]
};
const BALLUFF_EXPANDED_SECTIONS_RECIPE: ScrapeRecipeConfig = {
  interactionPolicy: {
    closeOverlaySelectors: [
      "button:has-text('Accept all')",
      "button:has-text('Accept All')",
      "button:has-text('Alle akzeptieren')",
      "button:has-text('Agree')",
      "button:has-text('I agree')",
      "button[aria-label='Close']",
      "#onetrust-accept-btn-handler",
      "[data-cy='cookie-accept']",
      ".cookie-banner button"
    ],
    waitForSelectors: [
      "text=\"Key features\"",
      "text=\"Downloads\"",
      "text=\"Classifications\"",
      "text=\"Digital Product Passport\""
    ],
    expandSelectors: [
      "button[aria-expanded='false']",
      "[role='button'][aria-expanded='false']",
      "summary",
      "details:not([open]) > summary",
      "[wire\\:click*='toggle']",
      "[x-on\\:click*='toggle']",
      "[\\@click*='toggle']",
      "[\\@click*='open']",
      "text=\"Show all main features\"",
      "text=\"Show more\"",
      "text=\"Mehr anzeigen\"",
      "text=\"Key features\"",
      "text=\"Downloads\"",
      "text=\"Classifications\"",
      "text=\"Digital Product Passport\"",
      "text=\"Hauptmerkmale\"",
      "text=\"Klassifizierungen\"",
      "text=\"Digitaler Produktpass\"",
      "button:has-text('Show all main features')",
      "button:has-text('Show more')",
      "button:has-text('Key features')",
      "button:has-text('Downloads')",
      "button:has-text('Classifications')",
      "button:has-text('Digital Product Passport')",
      "button:has-text('Hauptmerkmale')",
      "button:has-text('Klassifizierungen')",
      "button:has-text('Digitaler Produktpass')",
      "[role='button']:has-text('Key features')",
      "[role='button']:has-text('Downloads')",
      "[role='button']:has-text('Classifications')",
      "[role='button']:has-text('Digital Product Passport')",
      "h2:has-text('Key features')",
      "h2:has-text('Downloads')",
      "h2:has-text('Classifications')",
      "h2:has-text('Digital Product Passport')",
      "h3:has-text('Key features')",
      "h3:has-text('Downloads')",
      "h3:has-text('Classifications')",
      "h3:has-text('Digital Product Passport')"
    ],
    scrollPasses: 3,
    maxClicks: 36,
    networkIdleTimeoutMs: 20000
  }
};

// Sections appear on Balluff product pages as buttons with a → arrow that open MODAL dialogs
// (not inline accordions). Each modal must be opened, scraped, and closed before opening the next.
// Downloads has a second level. We only expand Product documentation: software, drawings, and
// CAD/CAE files are large non-parseable downloads and do not improve product data quality.
// IMPORTANT: Balluff renders these sections as <button class="...py-5"> wrappers containing a
// <div class="font-medium text-base">Label</div>. The `button.py-5:has(div:text-is(...))` selector
// added by the renderer's `expandSectionSelectors` helper is what actually hits the right element
// (plain `button:has-text('Key features')` also matches navigation/footer references). We keep
// generic fallbacks here for safety, but the precise wrapper match is appended automatically.
const BALLUFF_MODAL_SECTIONS: ModalSection[] = [
  {
    label: "Key features",
    openSelectors: [
      "button.py-5:has(div:text-is('Key features'))",
      "button.py-5:has(div:text-is('Hauptmerkmale'))",
      "button:has-text('Key features')",
      "[role='button']:has-text('Key features')",
      "a:has-text('Key features')",
      "button:has-text('Hauptmerkmale')",
      "[role='button']:has-text('Hauptmerkmale')"
    ],
    contentMarkerSelectors: [
      "text=Operating voltage Ub",
      "text=Housing material",
      "text=IP rating",
      "text=Ambient temperature",
      "text=Material",
      "text=Range",
      "text=Measuring range",
      "text=Interface",
      "text=Betriebsspannung"
    ]
  },
  {
    label: "Downloads",
    openSelectors: [
      "button.py-5:has(div:text-is('Downloads'))",
      "button:has-text('Downloads')",
      "[role='button']:has-text('Downloads')",
      "a:has-text('Downloads')"
    ],
    subOpenSelectors: [
      "button:has-text('Product documentation')",
      "button:has-text('Produktdokumentation')",
      "[role='button']:has-text('Product documentation')",
      "h2:has-text('Product documentation')",
      "h3:has-text('Product documentation')"
    ],
    contentMarkerSelectors: [
      "text=Product documentation",
      "text=Datasheet",
      "text=Product data sheet",
      "text=Operating manual",
      "text=Certificate",
      "text=Produktdokumentation"
    ]
  },
  {
    label: "Classifications",
    openSelectors: [
      "button.py-5:has(div:text-is('Classifications'))",
      "button.py-5:has(div:text-is('Klassifizierungen'))",
      "button:has-text('Classifications')",
      "[role='button']:has-text('Classifications')",
      "a:has-text('Classifications')",
      "button:has-text('Klassifizierungen')",
      "[role='button']:has-text('Klassifizierungen')"
    ],
    contentMarkerSelectors: ["text=ECLASS", "text=ETIM", "text=UNSPSC"]
  },
  {
    label: "Digital Product Passport",
    openSelectors: [
      "button.py-5:has(div:text-is('Digital Product Passport'))",
      "button.py-5:has(div:text-is('Digitaler Produktpass'))",
      "button:has-text('Digital Product Passport')",
      "[role='button']:has-text('Digital Product Passport')",
      "a:has-text('Digital Product Passport')",
      "button:has-text('Digitaler Produktpass')",
      "[role='button']:has-text('Digitaler Produktpass')"
    ],
    contentMarkerSelectors: [
      "text=Weight",
      "text=Tariff Code",
      "text=Country of origin",
      "text=Manufacturer",
      "text=Gewicht",
      "text=Herkunftsland"
    ]
  }
];

interface BalluffParseOptions {
  parser?: string;
  localizedUrlTemplates?: LocalizedUrlTemplate[];
}

export class BalluffConnector implements ManufacturerConnector {
  id = "balluff";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const candidates = buildBalluffProductUrls(catalogNumber);
    const partialResults: ProductResult[] = [];
    let lastError: unknown;
    const docsEnabled = context.downloadDocuments !== false;
    const imageOnly = context.imageOnly === true;

    for (const url of candidates) {
      try {
        const primary = await fetchBalluffText(url, context);
        const primaryResult = parseBalluffProductPage(catalogNumber, primary, {
          parser: "balluff-product-page",
          localizedUrlTemplates: context.manufacturer.localizedUrlTemplates
        });
        partialResults.push(primaryResult);
        // Images-only fast path: as soon as the primary page yields a product image, return.
        // Skips ~5-10s of supplemental fetches + Playwright modal sequence per item.
        if (
          imageOnly &&
          primaryResult.status !== "failed" &&
          primaryResult.documents.some((doc) => doc.type === "image")
        ) {
          return primaryResult;
        }
        if (isTerminalBalluffHttpStatus(primary.statusCode)) {
          continue;
        }
        if (
          balluffModalSectionsFor(primaryResult, primary.text, docsEnabled).length === 0 &&
          isCompleteBalluffResult(primaryResult, primary.text, { requireDatasheet: docsEnabled })
        ) {
          return primaryResult;
        }
        let current = primaryResult;
        const htmlParts = [primary.text];

        const supplementalFetches = await Promise.all([
          fetchBalluffSupplemental(catalogNumber, url, "balluff-readable-product-page", context, BALLUFF_BOT_USER_AGENT),
          fetchBalluffSupplemental(catalogNumber, balluffReaderUrl(url), "balluff-reader-product-page", context)
        ]);
        for (const supplemental of supplementalFetches) {
          if (!("fetched" in supplemental)) {
            lastError = supplemental.error;
            continue;
          }
          htmlParts.push(supplemental.fetched.text);
          current = mergeBalluffResults(current, supplemental.result);
          partialResults.push(current);
        }

        if (docsEnabled && context.saveDocuments === false) {
          const enrichedFromDatasheet = await enrichBalluffDatasheetForFastPath(current, context);
          if (enrichedFromDatasheet) {
            current = enrichedFromDatasheet;
            partialResults.push(current);
            if (isBalluffDatasheetEnrichedEnough(current)) return current;
          }
        }

        // When document downloads are disabled, the Excel only needs HTML-sourced data,
        // so we can skip the expensive browser render whenever the static HTML already
        // satisfies the (docs-off) completeness check. When docs are enabled we still
        // want the render — it surfaces lazy-loaded sections like Digital Product Passport.
        const currentHtml = htmlParts.join("\n");
        if (!docsEnabled && isCompleteBalluffResult(current, currentHtml, { requireDatasheet: false })) {
          return current;
        }

        // Skip the expensive Playwright modal sequence when this URL doesn't actually host
        // the product (404 / wrong locale / different catalog on the page).
        if (current.status === "failed" || primary.statusCode >= 400) continue;

        const modalSections = balluffModalSectionsFor(current, currentHtml, docsEnabled);
        if (modalSections.length === 0) {
          return current;
        }

        const expanded = await scrapeBalluffExpandedSections(catalogNumber, url, context, { sections: modalSections });
        if (expanded) {
          let expandedMerged = mergeBalluffResults(current, expanded);
          if (docsEnabled && context.saveDocuments === false && !hasBalluffDatasheet(expandedMerged)) {
            const downloadsOnly = await scrapeBalluffExpandedSections(catalogNumber, url, context, {
              forceDownloads: true,
              onlyDownloads: true
            });
            if (downloadsOnly) expandedMerged = mergeBalluffResults(expandedMerged, downloadsOnly);
          }
          partialResults.push(expandedMerged);
          if (isCompleteBalluffResult(expandedMerged, currentHtml, { requireDatasheet: docsEnabled })) return expandedMerged;
          if (isCompleteBalluffResult(current, currentHtml, { requireDatasheet: docsEnabled })) return expandedMerged;
          if (expandedMerged.status !== "failed" && (expandedMerged.attributes.length || expandedMerged.documents.length)) return expandedMerged;
        }

        if (isCompleteBalluffResult(current, currentHtml, { requireDatasheet: docsEnabled })) return current;
      } catch (error) {
        lastError = error;
      }
    }

    try {
      const searchResult = await scrapeBalluffSearch(catalogNumber, context);
      if (searchResult.status !== "failed") return searchResult;
      partialResults.push(searchResult);
    } catch (error) {
      lastError = error;
    }

    return (
      bestBalluffResult(partialResults) ??
      partialResults[0] ??
      emptyResult("balluff", catalogNumber, lastError instanceof Error ? lastError.message : "Balluff fetch failed.")
    );
  }
}

export function parseBalluffProductPage(catalogNumber: string, fetched: FetchedText, options: BalluffParseOptions = {}): ProductResult {
  const $ = cheerio.load(fetched.text);
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const products = readJsonLdProducts($);
  const product = products.find((item) => sameCatalogNumber(String(item.sku ?? item.mpn ?? ""), catalogNumber)) ?? products[0];
  const sourceUrl = canonicalBalluffProductUrl($("link[rel='canonical']").attr("href"), fetched.effectiveUrl) ?? fetched.effectiveUrl;
  const canonicalCatalogNumber = canonicalBalluffCatalogNumber(product, sourceUrl) ?? cleanBalluffCode(catalogNumber);
  if (fetched.statusCode >= 400) {
    return {
      ...emptyResult("balluff", catalogNumber, `Balluff product page returned HTTP ${fetched.statusCode}.`),
      productUrl: sourceUrl,
      sources: [
        {
          url: fetched.effectiveUrl,
          sourceType: "official",
          parser: options.parser ?? "balluff-product-page",
          parserVersion: BALLUFF_PARSER_VERSION,
          fetchedAt: fetched.fetchedAt,
          statusCode: fetched.statusCode
        }
      ]
    };
  }

  if (product) {
    for (const [name, value] of Object.entries(product)) {
      if (value === undefined || value === null || typeof value === "object") continue;
      attributes.push({
        group: "Structured Data",
        name,
        value: cleanText(String(value)),
        sourceUrl
      });
    }
    const offer = product.offers;
    if (offer && typeof offer === "object" && !Array.isArray(offer)) {
      const offerRecord = offer as Record<string, unknown>;
      for (const name of ["availability", "price", "priceCurrency"]) {
        const value = offerRecord[name];
        if (value === undefined || value === null) continue;
        attributes.push({
          group: "Offer",
          name,
          value: cleanText(String(value)),
          sourceUrl
        });
      }
    }
  }

  $("meta").each((_, element) => {
    const name = $(element).attr("name") || $(element).attr("property");
    const value = $(element).attr("content");
    if (!name || !value) return;
    if (/description|brand|manufacturer|image|product|og:/i.test(name)) {
      attributes.push({
        group: "Meta",
        name,
        value: cleanText(value),
        sourceUrl
      });
    }
  });

  const imageUrl = firstImageUrl(product?.image) ?? $("meta[property='og:image']").attr("content");
  if (imageUrl) {
    const candidates = balluffImageCandidateUrls(imageUrl, fetched.effectiveUrl);
    documents.push({
      type: "image",
      label: "Product image",
      url: candidates[0] ?? new URL(imageUrl, fetched.effectiveUrl).toString(),
      candidateUrls: candidates,
      sourceUrl
    });
  }
  for (const assetUrl of extractBalluffAssetUrls(fetched.text, fetched.effectiveUrl)) {
    const candidates = balluffImageCandidateUrls(assetUrl, fetched.effectiveUrl);
    if (!candidates.length) continue;
    documents.push({
      type: "image",
      label: "Product image",
      url: candidates[0],
      candidateUrls: candidates,
      sourceUrl
    });
  }

  parseMetaDescriptionSpecs($("meta[name='description']").attr("content"), sourceUrl).forEach((attr) => attributes.push(attr));
  attributes.push(...extractBalluffDomAttributes($, sourceUrl));
  attributes.push(...extractBalluffSectionAttributes(fetched.text, sourceUrl));
  attributes.push(...extractBalluffLifecycleAttributes(fetched.text, catalogNumber, sourceUrl));
  attributes.push(...extractBalluffDigitalProductPassportFallback(fetched.text, sourceUrl));
  const livewireData = extractBalluffLivewireData(fetched.text, sourceUrl);
  attributes.push(...livewireData.attributes);
  documents.push(...livewireData.documents);

  $("tr").each((_, element) => {
    const name = cleanText($(element).find("th").first().text());
    const value = cleanText($(element).find("td").first().text());
    if (!name || !value) return;
    if (/further alternative/i.test(name)) return;
    attributes.push({
      group: "Table",
      name,
      value,
      sourceUrl
    });
  });

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const absolute = new URL(href, fetched.effectiveUrl).toString();
    if (!isBalluffDocumentUrl(absolute)) return;
    documents.push(documentFromUrl(absolute, cleanText($(element).text()), sourceUrl));
  });

  for (const absolute of extractEmbeddedDocumentUrls(fetched.text, fetched.effectiveUrl)) {
    documents.push(documentFromUrl(absolute, "", sourceUrl));
  }
  documents.push(...extractBalluffEprelDocuments(fetched.text, sourceUrl));
  documents.push(...extractBalluffVideoDocuments($, sourceUrl));
  documents.push(...extractBalluffKnowledgeBaseDocuments($, sourceUrl));

  const title = cleanText(
    [
      catalogNumber,
      product?.alternateName ? `(${String(product.alternateName)})` : "",
      $("h2").last().text() || $("meta[property='product:plural_title']").attr("content") || $("title").text()
    ]
      .filter(Boolean)
      .join(" ")
  );
  const description = cleanText($("meta[name='description']").attr("content") ?? $("meta[property='og:description']").attr("content") ?? "");
  const productUrl = sourceUrl;
  const matched =
    catalogTextMatches(fetched.text, catalogNumber) ||
    balluffCatalogAliases(catalogNumber).some((alias) => catalogTextMatches(fetched.text, alias)) ||
    sameCatalogNumber(String(product?.sku ?? product?.mpn ?? ""), catalogNumber) ||
    balluffCatalogAliases(catalogNumber).some((alias) => sameCatalogNumber(String(product?.sku ?? product?.mpn ?? ""), alias)) ||
    sameCatalogNumber(String(product?.alternateName ?? ""), catalogNumber, { compact: true });

  if (!matched) {
    return {
      ...emptyResult("balluff", catalogNumber, "Balluff product page did not contain the catalog number."),
      sources: [
        {
          url: fetched.effectiveUrl,
          sourceType: "official",
          parser: options.parser ?? "balluff-product-page",
          parserVersion: BALLUFF_PARSER_VERSION,
          fetchedAt: fetched.fetchedAt,
          statusCode: fetched.statusCode
        }
      ]
    };
  }

  const cleanAttributes = dedupeAttributes(attributes.filter(isUsefulBalluffAttribute));
  const cleanDocuments = dedupeBalluffDocuments(documents);

  return {
    manufacturerId: "balluff",
    catalogNumber,
    status: cleanAttributes.length || cleanDocuments.length ? "found" : "partial",
    confidence: product ? 0.92 : 0.75,
    productUrl,
    localizedUrls: buildLocalizedProductUrls("balluff", canonicalCatalogNumber, productUrl, options.localizedUrlTemplates),
    title,
    description,
    normalized: normalizeFields(cleanAttributes, cleanDocuments),
    attributes: cleanAttributes,
    documents: cleanDocuments,
    sources: [
      {
        url: fetched.effectiveUrl,
        sourceType: "official",
        parser: options.parser ?? "balluff-product-page",
        parserVersion: BALLUFF_PARSER_VERSION,
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode
      }
    ]
  };
}

function buildBalluffProductUrls(catalogNumber: string): string[] {
  return balluffDirectProductCodes(catalogNumber).flatMap((code) => {
    const encoded = encodeURIComponent(code);
    return [
      ...BALLUFF_PRODUCT_LOCALES.map((locale) => `https://www.balluff.com/${locale}/products/${encoded}`),
      `https://www.balluff.com.cn/en-cn/products/${encoded}`,
      `https://www.balluff.com.cn/zh-cn/products/${encoded}`
    ];
  });
}

function balluffReaderUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  return `https://r.jina.ai/http://${parsed.host}${parsed.pathname}`;
}

async function fetchBalluffText(url: string, context: ScrapeContext, userAgent?: string): Promise<FetchedText> {
  const policy = context.manufacturer.fetchPolicy ?? {};
  const headers = {
    "accept-language": policy.acceptLanguage ?? BALLUFF_ACCEPT_LANGUAGE,
    referer: policy.referer ?? BALLUFF_REFERER,
    ...(userAgent ? { "user-agent": userAgent } : policy.userAgent ? { "user-agent": policy.userAgent } : {})
  };
  try {
    const fetched = await context.http.fetchText(url, {
      timeoutMs: policy.timeoutMs ?? 20000,
      cacheTtlMs: policy.cacheTtlMs,
      maxAttempts: policy.maxAttempts ?? 2,
      retryBackoffMs: policy.retryBackoffMs,
      headers,
      signal: context.signal
    });
    if (isTerminalBalluffHttpStatus(fetched.statusCode)) return fetched;
    if (fetched.text.trim().length >= (policy.minContentLength ?? 1000)) return fetched;
  } catch {
    // Fall through to PowerShell, which handles a few Windows-only TLS/proxy cases better.
  }
  return context.http.fetchTextViaPowerShell(url, {
    timeoutMs: Math.max(policy.timeoutMs ?? 20000, 30000),
    cacheTtlMs: policy.cacheTtlMs,
    headers,
    signal: context.signal
  });
}

async function fetchBalluffSupplemental(
  catalogNumber: string,
  url: string,
  parser: string,
  context: ScrapeContext,
  userAgent?: string
): Promise<{ fetched: FetchedText; result: ProductResult; error?: undefined } | { error: unknown }> {
  try {
    const fetched = await fetchBalluffText(url, context, userAgent);
    return {
      fetched,
      result: parseBalluffProductPage(catalogNumber, fetched, {
        parser,
        localizedUrlTemplates: context.manufacturer.localizedUrlTemplates
      })
    };
  } catch (error) {
    return { error };
  }
}

async function scrapeBalluffSearch(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
  const params = ["query", "q", "search", "searchTerm", "term"];
  let lastError: unknown;
  for (const term of balluffSearchTerms(catalogNumber)) {
    for (const param of params) {
      const searchUrl = `https://www.balluff.com/en-gb/search?${param}=${encodeURIComponent(term)}`;
      try {
        const search = await fetchBalluffText(searchUrl, context);
        const detailUrl = findBestProductLink(search.text, search.effectiveUrl, catalogNumber);
        if (!detailUrl) continue;
        const detail = await fetchBalluffText(detailUrl, context);
        const primary = parseBalluffProductPage(catalogNumber, detail, {
          parser: "balluff-search-product-page",
          localizedUrlTemplates: context.manufacturer.localizedUrlTemplates
        });
        if (primary.status === "failed") continue;
        try {
          const readable = await fetchBalluffText(detailUrl, context, BALLUFF_BOT_USER_AGENT);
          const fallback = parseBalluffProductPage(catalogNumber, readable, {
            parser: "balluff-search-readable-product-page",
            localizedUrlTemplates: context.manufacturer.localizedUrlTemplates
          });
          return mergeBalluffResults(primary, fallback);
        } catch {
          return primary;
        }
      } catch (error) {
        lastError = error;
      }
    }
  }
  return emptyResult("balluff", catalogNumber, lastError instanceof Error ? lastError.message : "Balluff search fallback failed.");
}

async function scrapeBalluffExpandedSections(
  catalogNumber: string,
  url: string,
  context: ScrapeContext,
  options: { forceDownloads?: boolean; onlyDownloads?: boolean; sections?: ModalSection[] } = {}
): Promise<ProductResult | undefined> {
  try {
    // The "Downloads" modal is purely a vehicle for discovering datasheet/manual/CAD URLs.
    // When the user disabled document downloads we never fetch those files, so opening this
    // modal (which also drills into a sub-section "Product documentation") is pure overhead.
    const shouldDiscoverFullDocuments = options.forceDownloads || (context.saveDocuments !== false && context.downloadDocuments !== false);
    const modalSections = options.sections ?? (options.onlyDownloads
      ? BALLUFF_MODAL_SECTIONS.filter((section) => section.label === "Downloads")
      : shouldDiscoverFullDocuments
        ? BALLUFF_MODAL_SECTIONS
        : BALLUFF_MODAL_SECTIONS.filter((section) => section.label !== "Downloads"));

    // Prefer the modal-sequence renderer (opens each Balluff section in turn, captures HTML).
    // Falls back to the generic renderProductPage if the renderer doesn't expose the new method.
    const renderOnce = async () => {
      if (context.browserRenderer?.renderProductPageWithModalSequence) {
        return context.browserRenderer.renderProductPageWithModalSequence(
          url,
          BALLUFF_EXPANDED_SECTIONS_RECIPE,
          modalSections,
          context.signal
        );
      }
      return context.browserRenderer
        ? await context.browserRenderer.renderProductPage(url, BALLUFF_EXPANDED_SECTIONS_RECIPE, context.signal)
        : await renderProductPage(url, BALLUFF_EXPANDED_SECTIONS_RECIPE, context.signal);
    };
    let rendered = await renderOnce();
    if (rendered.error) {
      console.error(`[balluff] browser render failed for ${catalogNumber} @ ${url}: ${rendered.error}`);
    } else if (rendered.fetched) {
      const firstCount = balluffExpandedSectionCount(rendered.fetched.text);
      const hasAnyNetworkPayload = rendered.networkTexts.some((networkText) => isLikelyBalluffExpandedPayload(networkText.text));
      if (firstCount === 0 && !hasAnyNetworkPayload) {
        console.warn(`[balluff] first render produced no expanded sections for ${catalogNumber}, retrying once...`);
        const retry = await renderOnce();
        if (retry.fetched && balluffExpandedSectionCount(retry.fetched.text) > firstCount) {
          rendered = retry;
        }
      }
    }
    const results: ProductResult[] = [];

    if (rendered.fetched) {
      results.push(
        parseBalluffProductPage(catalogNumber, rendered.fetched, {
          parser: "balluff-browser-expanded-product-page",
          localizedUrlTemplates: context.manufacturer.localizedUrlTemplates
        })
      );
    }

    for (const fetched of rendered.networkTexts) {
      for (const networkFetched of balluffNetworkPayloadsForParsing(fetched, url)) {
        const parsed = parseBalluffProductPage(catalogNumber, networkFetched, {
          parser: "balluff-browser-expanded-network",
          localizedUrlTemplates: context.manufacturer.localizedUrlTemplates
        });
        if (parsed.status !== "failed") results.push(parsed);
      }
    }

    const usable = results.filter((result) => result.status !== "failed" && (result.attributes.length || result.documents.length));
    if (!usable.length) return undefined;
    const merged = usable.slice(1).reduce((current, next) => mergeBalluffResults(current, next), usable[0]);
    return {
      ...merged,
      diagnostics: {
        ...merged.diagnostics,
        browserNetwork: rendered.networkDiagnostics,
        fallbackStages: [...(merged.diagnostics?.fallbackStages ?? []), rendered.error ? "balluff-expanded-browser-failed" : "balluff-expanded-browser"]
      },
      sources: dedupeSources([
        ...merged.sources,
        {
          url,
          sourceType: "official-fallback",
          parser: "balluff-browser-expanded-sections",
          parserVersion: BALLUFF_PARSER_VERSION,
          fetchedAt: new Date().toISOString(),
          reason: rendered.error
        }
      ])
    };
  } catch (error) {
    console.error(`[balluff] expanded-sections exception for ${catalogNumber} @ ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function balluffNetworkPayloadsForParsing(fetched: FetchedText, productUrl: string): FetchedText[] {
  const output: FetchedText[] = [];
  if (isLikelyBalluffExpandedPayload(fetched.text)) {
    output.push({ ...fetched, effectiveUrl: productUrl });
  }
  for (const fragment of extractBalluffNetworkHtmlFragments(fetched.text)) {
    output.push({
      ...fetched,
      effectiveUrl: productUrl,
      text: fragment
    });
  }
  return output;
}

function isLikelyBalluffExpandedPayload(text: string): boolean {
  return /\b(?:product::downloads|product::digital-product-pass|pia::product\.documents|Key features|Downloads|Classifications|Digital Product Passport)\b/i.test(
    text
  );
}

function extractBalluffNetworkHtmlFragments(text: string): string[] {
  const fragments = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      const decoded = decodeHtmlAttribute(value)
        .replace(/\\u003C/gi, "<")
        .replace(/\\u003E/gi, ">")
        .replace(/\\u002F/gi, "/")
        .replace(/\\u0026/gi, "&")
        .replace(/\\\//g, "/");
      if (/<[a-z][\s\S]*>/i.test(decoded) && isLikelyBalluffExpandedPayload(decoded)) {
        fragments.add(decoded);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    Object.values(value).forEach(visit);
  };

  try {
    visit(JSON.parse(text) as unknown);
  } catch {
    // Non-JSON network bodies are parsed by the caller directly when useful.
  }
  return [...fragments].map((fragment) => `<html><body>${fragment}</body></html>`);
}

function mergeBalluffResults(primary: ProductResult, fallback: ProductResult): ProductResult {
  const merged = mergeResults(primary, fallback);
  const documents = dedupeBalluffDocuments(merged.documents);
  return {
    ...merged,
    documents,
    normalized: normalizeFields(merged.attributes, documents),
    sources: dedupeSources(merged.sources),
    status: merged.attributes.length || merged.documents.length
      ? primary.status === "found" || fallback.status === "found"
        ? "found"
        : "partial"
      : "failed"
  };
}

function bestBalluffResult(results: ProductResult[]): ProductResult | undefined {
  return results
    .filter((result) => result.status !== "failed")
    .sort((left, right) => balluffResultScore(right) - balluffResultScore(left))[0];
}

function balluffResultScore(result: ProductResult): number {
  const names = new Set(result.attributes.map((attr) => balluffLabelKey(attr.name)));
  let score = result.attributes.length + result.documents.length * 3;
  for (const required of [
    "dimension",
    "interface",
    "connection",
    "connection 1",
    "connection 2",
    "cable",
    "housing material",
    "material",
    "range",
    "measuring range",
    "operating voltage ub",
    "rated current",
    "current sum us sensor",
    "ip rating",
    "approval conformity"
  ]) {
    if (hasBalluffAttributeName(names, required)) score += 10;
  }
  score += Math.min(50, result.attributes.filter((attr) => /balluff (?:summary features|key features)/i.test(attr.group ?? "")).length * 4);
  if (result.documents.some((doc) => doc.type === "datasheet")) score += 20;
  if (result.documents.some((doc) => doc.type === "cad")) score += 12;
  if (result.attributes.some((attr) => /eclass/i.test(attr.name))) score += 12;
  if (result.attributes.some((attr) => /etim/i.test(attr.name))) score += 12;
  if (result.attributes.some((attr) => /unspsc/i.test(attr.name))) score += 12;
  return score;
}

function cleanBalluffCode(value: string): string {
  const trimmed = value.trim().replace(/["']/g, "");
  try {
    const parsed = new URL(trimmed);
    const productCode = parsed.pathname.match(/\/products\/([^/?#]+)/i)?.[1];
    if (productCode) return decodeURIComponent(productCode).trim().toUpperCase();
  } catch {
    const productCode = trimmed.match(/\/products\/([^/?#\s]+)/i)?.[1];
    if (productCode) return decodeURIComponent(productCode).trim().toUpperCase();
  }
  return trimmed.split(/[\s,;\t]/)[0]?.toUpperCase() ?? trimmed.toUpperCase();
}

function balluffDirectProductCodes(catalogNumber: string): string[] {
  const fromUrl = balluffProductCodeFromUrl(catalogNumber);
  const cleaned = cleanBalluffCode(catalogNumber);
  const aliases = balluffCatalogAliases(catalogNumber);
  return [
    ...new Set(
      [fromUrl, ...aliases, cleaned].filter((code): code is string =>
        Boolean(code && isBalluffProductPageCode(code))
      )
    )
  ];
}

function balluffSearchTerms(catalogNumber: string): string[] {
  const trimmed = cleanText(catalogNumber.replace(/["']/g, ""));
  const compact = trimmed.replace(/[^a-z0-9]/gi, "");
  const directCodes = balluffDirectProductCodes(catalogNumber);
  return [
    trimmed,
    ...directCodes,
    compact.length >= 6 ? compact : undefined
  ]
    .filter((term): term is string => Boolean(term && term.length >= 3))
    .filter((term, index, terms) => terms.findIndex((candidate) => candidate.toLowerCase() === term.toLowerCase()) === index);
}

function balluffCatalogAliases(catalogNumber: string): string[] {
  const cleaned = cleanText(catalogNumber).toUpperCase();
  const aliases = [...(BALLUFF_KNOWN_PRODUCT_CODE_ALIASES[cleaned] ?? [])];
  if (/^BDG\s+FB058-[A-Z0-9]+-DSR[BG]\d-/i.test(catalogNumber)) aliases.push("MP11418306");
  return [...new Set(aliases)];
}

function isBalluffProductPageCode(value: string): boolean {
  return /^[A-Z]{2,4}[0-9][0-9A-Z]{3,8}$/i.test(cleanText(value));
}

function balluffProductCodeFromUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    const productCode = parsed.pathname.match(/\/products\/([^/?#]+)/i)?.[1];
    return productCode ? decodeURIComponent(productCode).trim().toUpperCase() : undefined;
  } catch {
    const productCode = value.trim().match(/\/products\/([^/?#\s]+)/i)?.[1];
    return productCode ? decodeURIComponent(productCode).trim().toUpperCase() : undefined;
  }
}

function canonicalBalluffCatalogNumber(product: Record<string, unknown> | undefined, productUrl: string): string | undefined {
  const structuredCode = cleanText(String(product?.sku ?? product?.mpn ?? ""));
  if (isBalluffProductPageCode(structuredCode)) return structuredCode.toUpperCase();
  return balluffProductCodeFromUrl(productUrl);
}

function canonicalBalluffProductUrl(rawUrl: string | undefined, baseUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl || baseUrl, baseUrl);
    parsed.hash = "";
    if (/balluff\.com(?:\.cn)?$/i.test(parsed.hostname) && /\/products\/[^/]+\/?$/i.test(parsed.pathname)) {
      parsed.search = "";
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function hasExpandedBalluffSections(html: string): boolean {
  const text = cleanText(html).toLowerCase();
  return (
    /\b(key features|hauptmerkmale|principales caracteristiques|caracteristicas clave)\b/i.test(text) &&
    /\b(classifications|klassifizierungen|classificazioni|clasificaciones)\b/i.test(text) &&
    /\b(eclass|etim|unspsc)\b/i.test(text)
  );
}

const BALLUFF_EXPANDED_SECTION_MARKERS: Array<{ name: string; pattern: RegExp }> = [
  { name: "key-features", pattern: /\b(?:operating voltage ub|housing material|ip rating|range|measuring range|connection 1|cable|interface)\b/i },
  { name: "downloads", pattern: /\b(?:datasheet|product data sheet|operating manual|certificate|user manual|user's guide)\b/i },
  { name: "classifications", pattern: /\beclass\s*\d|\betim\s*\d|\bunspsc\b/i },
  { name: "digital-product-passport", pattern: /\b(?:weight|tariff code|country of origin|product carbon footprint|battery regulation|substances of concern)\b/i }
];

function balluffExpandedSectionCount(html: string): number {
  const text = cleanText(html);
  return BALLUFF_EXPANDED_SECTION_MARKERS.reduce((count, marker) => (marker.pattern.test(text) ? count + 1 : count), 0);
}

function hasBalluffDatasheet(result: ProductResult): boolean {
  return result.documents.some((doc) => doc.type === "datasheet");
}

async function enrichBalluffDatasheetForFastPath(
  result: ProductResult,
  context: ScrapeContext
): Promise<ProductResult | undefined> {
  if (result.status === "failed" || context.signal?.aborted) return undefined;
  const datasheet = result.documents.find((doc) => doc.type === "datasheet");
  if (!datasheet) return undefined;

  try {
    const downloaded = datasheet.localPath ? datasheet : await context.downloadDocument(datasheet);
    const documents = result.documents.map((doc) => (doc === datasheet || doc.url === datasheet.url ? downloaded : doc));
    return await enrichResultFromDownloadedDocuments({ ...result, documents });
  } catch (error) {
    if (context.signal?.aborted) throw new Error("Cancelled by user.");
    return {
      ...result,
      diagnostics: {
        ...result.diagnostics,
        fallbackStages: [...(result.diagnostics?.fallbackStages ?? []), `balluff-fast-datasheet-failed:${error instanceof Error ? error.message : String(error)}`]
      }
    };
  }
}

function isBalluffDatasheetEnrichedEnough(result: ProductResult): boolean {
  if (result.status === "failed") return false;
  const parsedDatasheet = result.documents.some((doc) => doc.type === "datasheet" && doc.parseStatus === "parsed");
  if (!parsedDatasheet) return false;
  const normalizedPresent = [
    result.normalized.weight,
    result.normalized.dimensions,
    result.normalized.material,
    result.normalized.voltage,
    result.normalized.current,
    result.normalized.protection,
    result.normalized.certificates
  ].filter((value) => Boolean(value)).length;
  const hasIdentity = result.documents.some((doc) => doc.type === "image") && hasBalluffDatasheet(result);
  const hasPdfDepth = result.attributes.filter((attr) => /^PDF /i.test(attr.group ?? "")).length >= 25;
  return hasIdentity && hasPdfDepth && normalizedPresent >= 3;
}

function hasAllBalluffExpandedSections(html: string): boolean {
  return balluffExpandedSectionCount(html) === BALLUFF_EXPANDED_SECTION_MARKERS.length;
}

interface BalluffCompletenessSignals {
  hasUsefulDetail: boolean;
  hasClassifications: boolean;
  hasDatasheet: boolean;
  hasDigitalProductPassport: boolean;
}

function balluffCompletenessSignals(result: ProductResult): BalluffCompletenessSignals {
  const names = new Set(result.attributes.map((attr) => balluffLabelKey(attr.name)));
  const detailAttributeCount = result.attributes.filter((attr) => /balluff (?:summary features|key features)/i.test(attr.group ?? "")).length;
  const hasUsefulDetail =
    detailAttributeCount >= 5 ||
    [
      "operating voltage ub",
      "interface",
      "dimension",
      "housing material",
      "connection",
      "connection 1",
      "cable",
      "range",
      "measuring range"
    ].filter((label) => hasBalluffAttributeName(names, label)).length >= 3;
  const hasClassifications =
    result.attributes.some((attr) => /^eclass/i.test(attr.name)) &&
    result.attributes.some((attr) => /^etim/i.test(attr.name)) &&
    result.attributes.some((attr) => /^unspsc/i.test(attr.name));
  const hasDigitalProductPassport = result.attributes.some(
    (attr) => /digital product passport/i.test(attr.group ?? "") && Boolean(cleanText(attr.value))
  );

  return {
    hasUsefulDetail,
    hasClassifications,
    hasDatasheet: result.documents.some((doc) => doc.type === "datasheet"),
    hasDigitalProductPassport
  };
}

function balluffModalSectionsFor(result: ProductResult, html: string, docsEnabled: boolean): ModalSection[] {
  const availableSections = docsEnabled
    ? BALLUFF_MODAL_SECTIONS
    : BALLUFF_MODAL_SECTIONS.filter((section) => section.label !== "Downloads");
  if (result.status === "failed") return availableSections;

  const signals = balluffCompletenessSignals(result);
  const labels = new Set<string>();
  if (!signals.hasUsefulDetail) labels.add("Key features");
  if (docsEnabled && !signals.hasDatasheet) labels.add("Downloads");
  if (!signals.hasClassifications) labels.add("Classifications");
  const pageMentionsPassport = /\b(?:digital product passport|digitaler produktpass)\b/i.test(cleanText(html));
  if (!signals.hasDigitalProductPassport && pageMentionsPassport) {
    labels.add("Digital Product Passport");
  }

  if (!labels.size) {
    return isCompleteBalluffResult(result, html, { requireDatasheet: docsEnabled }) ? [] : availableSections;
  }
  return availableSections.filter((section) => labels.has(section.label));
}

function isTerminalBalluffHttpStatus(statusCode: number): boolean {
  return statusCode === 404 || statusCode === 410;
}

function isCompleteBalluffResult(
  result: ProductResult,
  html: string,
  options: { requireDatasheet?: boolean } = {}
): boolean {
  if (result.status !== "found") return false;
  if (!hasExpandedBalluffSections(html)) return false;
  const signals = balluffCompletenessSignals(result);
  const requireDatasheet = options.requireDatasheet !== false;
  return signals.hasUsefulDetail && signals.hasClassifications && (!requireDatasheet || signals.hasDatasheet);
}

function readJsonLdProducts($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = [];
  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).text();
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | Record<string, unknown>[];
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (entry["@type"] === "Product") products.push(entry);
      }
    } catch {
      // Ignore malformed structured data.
    }
  });
  return products;
}

function firstImageUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string");
  return undefined;
}

function balluffImageCandidateUrls(value: string, baseUrl: string): string[] {
  let absolute: string;
  try {
    absolute = new URL(value, baseUrl).toString();
  } catch {
    return [];
  }
  if (!/assets\.balluff\.com/i.test(absolute)) return [absolute];

  const candidates = [
    balluffAssetSibling(absolute, "product_view_cropped", ".png"),
    balluffAssetSibling(absolute, "png_1000x1000", ".png"),
    balluffAssetSibling(absolute, "webp_1000x1000", ".webp"),
    balluffAssetSibling(absolute, "jpg_1000x1000", ".jpg"),
    absolute,
    balluffAssetSibling(absolute, "thumbnails", ".png")
  ].filter((candidate): candidate is string => Boolean(candidate));
  return [...new Set(candidates)];
}

function balluffAssetSibling(url: string, folder: string, extension: string): string | undefined {
  try {
    const parsed = new URL(url);
    const filename = parsed.pathname.split("/").pop();
    if (!filename) return undefined;
    const stem = filename.replace(/\.(?:png|jpe?g|webp)$/i, "");
    return `https://assets.balluff.com/${folder}/${stem}${extension}`;
  } catch {
    return undefined;
  }
}

function extractBalluffAssetUrls(html: string, baseUrl: string): string[] {
  const decoded = html.replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/gi, "&");
  const urls = new Set<string>();
  const inlineUrls = decoded.match(/https?:\/\/assets\.balluff\.com[^"'<>\s)]+/gi) ?? [];
  for (const rawUrl of inlineUrls) {
    if (!/\.(?:png|jpe?g|webp)(?:[?#]|$)/i.test(rawUrl)) continue;
    try {
      urls.add(new URL(rawUrl, baseUrl).toString());
    } catch {
      // Ignore malformed asset references.
    }
  }
  return [...urls].sort((left, right) => balluffAssetPriority(right) - balluffAssetPriority(left)).slice(0, 6);
}

function balluffAssetPriority(url: string): number {
  // Dimensional drawings (VIU_… prefix or _DRW_/_SHG_/dimension/sketch markers in the filename)
  // are line-art with measurement annotations — push them to the bottom regardless of folder.
  const filename = (() => {
    try {
      return new URL(url).pathname.split("/").pop() ?? "";
    } catch {
      return url;
    }
  })();
  if (/^viu[_-]/i.test(filename)) return 1;
  if (/[_-](?:drw|shg|dim|tech|drawing|schematic|sketch)[_.-]/i.test(filename)) return 2;
  let priority = 10;
  if (/\/thumbnails\//i.test(url)) priority = 50;
  else if (/\/product_view_cropped\//i.test(url)) priority = 40;
  else if (/\/png_1000x1000\//i.test(url)) priority = 30;
  else if (/\/webp_1000x1000\//i.test(url)) priority = 20;
  // Boost the actual product-photo marker ("_P_" channel in Balluff filenames).
  if (/_p_\d/i.test(filename)) priority += 5;
  return priority;
}

function dedupeBalluffDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const merged = new Map<string, DocumentRecord>();
  for (const doc of dedupeDocuments(documents)) {
    const key = doc.type === "image" ? `image:${balluffImageIdentity(doc.url)}` : `${doc.type}:${doc.url.toLowerCase()}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...doc,
        candidateUrls: doc.type === "image" ? uniqueUrls([doc.url, ...(doc.candidateUrls ?? [])]) : doc.candidateUrls
      });
      continue;
    }
    if (doc.type === "image") {
      merged.set(key, {
        ...existing,
        candidateUrls: uniqueUrls([existing.url, ...(existing.candidateUrls ?? []), doc.url, ...(doc.candidateUrls ?? [])])
      });
    }
  }
  return coalesceBalluffImageDocuments([...merged.values()]);
}

function balluffImageIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const filename = parsed.pathname.split("/").pop() ?? parsed.pathname;
    return filename.replace(/\.(?:png|jpe?g|webp|gif|avif|svg)$/i, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function coalesceBalluffImageDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const productImages = documents.filter(isBalluffProductImageDocument);
  if (productImages.length <= 1) return documents;

  const ranked = [...productImages].sort((left, right) => balluffImageDocumentRank(left) - balluffImageDocumentRank(right));
  const primary = ranked[0];
  const candidateUrls = uniqueUrls([
    ...(primary.candidateUrls ?? []),
    ...ranked.flatMap((doc) => [doc.url, ...(doc.candidateUrls ?? [])])
  ]).filter((url) => url !== primary.url);

  return [
    {
      ...primary,
      label: primary.label || "Product image",
      candidateUrls: candidateUrls.length ? candidateUrls : primary.candidateUrls
    },
    ...documents.filter((doc) => !isBalluffProductImageDocument(doc))
  ];
}

function isBalluffProductImageDocument(doc: DocumentRecord): boolean {
  if (doc.type !== "image") return false;
  return [doc.url, ...(doc.candidateUrls ?? [])].some((url) => /assets\.balluff\.com/i.test(url));
}

function balluffImageDocumentRank(doc: DocumentRecord): number {
  const text = `${doc.label} ${doc.url} ${(doc.candidateUrls ?? []).join(" ")}`.toLowerCase();
  // Look at just the primary URL filename for the "is this a drawing?" heuristic; the candidate
  // list often mixes photo + drawing variants and would mask the signal otherwise.
  const primaryFilename = (() => {
    try {
      return new URL(doc.url).pathname.split("/").pop()?.toLowerCase() ?? "";
    } catch {
      return doc.url.toLowerCase();
    }
  })();
  let rank = 100;
  if (/product image/.test(text)) rank -= 10;
  if (/\/product_view_cropped\//.test(text)) rank -= 60;
  if (/\/png_1000x1000\//.test(text)) rank -= 50;
  if (/\/webp_1000x1000\//.test(text)) rank -= 45;
  if (/\/jpg_1000x1000\//.test(text)) rank -= 40;
  if (/\/thumbnails\//.test(text)) rank += 30;
  // Strong penalty for Balluff "dimensional view" / drawing assets. Filenames that start with
  // VIU_ (visualisation), or contain _DRW_/_SHG_/dimension/drawing/schematic markers, are
  // line-art with measurement annotations — never what a buyer expects to see in Excel.
  if (/^viu[_-]/i.test(primaryFilename)) rank += 80;
  if (/[_-](?:drw|shg|dim|tech|drawing|schematic|sketch)[_.-]/i.test(primaryFilename)) rank += 70;
  // Boost Balluff "real product photo" marker: filenames like 56281_00_P_00_00_00.png use
  // "_P_" as the photo channel. Prefer those over alternate views.
  if (/_p_\d/i.test(primaryFilename)) rank -= 12;
  return rank;
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
}

function parseMetaDescriptionSpecs(description: string | undefined, sourceUrl: string): AttributeRecord[] {
  if (!description) return [];
  const attributes: AttributeRecord[] = [];
  const cleanedDescription = cleanText(description);
  const price = cleanedDescription.match(/List price [^:]+:\s*([^-]+)/i)?.[1];
  if (price) attributes.push({ group: "Meta Specs", name: "List price", value: cleanText(price), sourceUrl });

  for (const { label, value } of splitBalluffMetaSpecs(cleanedDescription)) {
    const canonical = balluffCanonicalLabel(label) ?? cleanText(label);
    const cleanedValue = cleanBalluffSpecValue(canonical, value);
    if (!canonical || !cleanedValue) continue;
    attributes.push({ group: "Meta Specs", name: canonical, value: cleanedValue, sourceUrl });
    if (canonical === "Cable") {
      const length = cleanedValue.match(/(?:^|,\s*)(\d+(?:[.,]\d+)?\s*m)\b/i)?.[1];
      if (length) attributes.push({ group: "Meta Specs", name: "Cable length", value: cleanText(length), sourceUrl });
    }
  }
  return attributes;
}

function splitBalluffMetaSpecs(description: string): Array<{ label: string; value: string }> {
  const matches = [...description.matchAll(new RegExp(`(?:^|[,;-]\\s*)(${BALLUFF_META_LABEL_PATTERN})\\s*:\\s*`, "gi"))];
  const specs: Array<{ label: string; value: string }> = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const label = cleanText(match[1]);
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? description.length;
    const value = cleanText(
      description
        .slice(start, end)
        .replace(/\s+-\s+BALLUFF.*$/i, "")
        .replace(/\s+-\s+(?:Contact request|This product page contains).*$/i, "")
        .replace(/^[,;]\s*/, "")
        .replace(/^-\s+(?=\D)/, "")
        .replace(/[,;-]\s*$/, "")
    );
    if (label && value) specs.push({ label, value });
  }
  return specs;
}

const BALLUFF_SPEC_LABELS = [
  "Weight",
  "Tariff Code",
  "Country of origin",
  "Product carbon footprint",
  "Battery regulation",
  "Substances of concern",
  "Disposal instructions",
  "Energy consumption labeling",
  "Product status",
  "Availability",
  "Recommended alternative",
  "Manufacturer",
  "Series",
  "Style",
  "Style Housing",
  "Installation",
  "Application",
  "Additional features",
  "Additional text",
  "Product group",
  "Product Area",
  "Product family",
  "Product name",
  "Order code",
  "Supported RFID technologies",
  "Supported IO-Link Profiles",
  "Number of connectable R/W heads / antennas",
  "Antenna type",
  "Performance Level",
  "Safety category (EN ISO 13849-1)",
  "SIL (IEC 61508)",
  "SIL CL (EN 62061)",
  "Coding level (EN ISO 14119)",
  "B10d (EN ISO 13849-1)",
  "Response time max.",
  "Number of safe inputs",
  "Number of safe outputs",
  "No of contacts",
  "Utilization category",
  "Guard locking, principle",
  "Holding force FZH",
  "Auxiliary release",
  "Axillary release",
  "Escape release",
  "Life expectancy mechanical",
  "Ex category",
  "Connection 1",
  "Connection 2",
  "Cable",
  "Cable, note",
  "Number of conductors",
  "Cable temperature, fixed routing",
  "Cable temperature, flexible routing",
  "Operating voltage Ub",
  "Rated current",
  "Rated current (40 °C)",
  "Continuous current",
  "IP rating",
  "Approval/Conformity",
  "Material sensing surface",
  "Principle of operation",
  "Principle of optical operation",
  "Light type",
  "Scope of delivery",
  "Cable diameter D",
  "Conductor cross-section",
  "Power indicator",
  "Function indicator",
  "Function indicator (Pin 2)",
  "Function indicator (Pin 4)",
  "Switching function display",
  "Predefined colors",
  "Segments, number max.",
  "Volume max.",
  "Setting",
  "Additional function",
  "Switching output",
  "Special characteristics",
  "Cable shielding",
  "Cable shield",
  "Suppressor",
  "Interface",
  "Auxiliary interfaces",
  "Port-class",
  "Connection (COM 1)",
  "Connection (COM 2)",
  "Connection for sensor",
  "Connection slots",
  "Analog inputs",
  "Analog outputs",
  "Resolution",
  "Digital inputs",
  "Digital outputs",
  "Configurable inputs/outputs",
  "Current sum US, sensor",
  "Current sum UA, actuator",
  "Total current max.",
  "Housing material",
  "Dimension",
  "Ambient temperature",
  "Transfer rate",
  "IO-Link version",
  "Extension port",
  "Single-channel monitoring",
  "Safety Hub Support",
  "Process data cycle min.",
  "Process data IN",
  "Process data OUT",
  "Switching current",
  "Connection (supply voltage IN)",
  "Connection (supply voltage OUT)",
  "Function",
  "Signal type",
  "Transmission distance",
  "Component",
  "Connection",
  "Rated operating voltage Ue",
  "Output voltage",
  "Rated output voltage DC",
  "Rated output current",
  "Output capacity max.",
  "Output current max.",
  "Input voltage",
  "Additive cycle time",
  "SIO mode",
  "Version",
  "Use",
  "Reference base unit",
  "Measuring principle",
  "Measuring axes",
  "Fiber type material",
  "Cable length L",
  "Material jacket",
  "Sensitivity",
  "Range",
  "Active surface/fibers",
  "Active surface, fibers",
  "Active surface/fiber arrangement",
  "Active surface, fiber arrangement",
  "Switching function, optical",
  "Input current max.",
  "Current consumption max.",
  "No-load current Io max.",
  "Rated operating current Ie",
  "Rated insulation voltage Ui",
  "Rated impulse withstand voltage Uimp",
  "Basic standard",
  "Operating principle",
  "Operating mode",
  "Input function",
  "Switching frequency",
  "Sampling frequency max.",
  "Measuring range",
  "Measuring length",
  "Range Sn",
  "Sensing surface",
  "Housing style",
  "Material",
  "Material housing",
  "Display",
  "Adjuster",
  "Switching function",
  "Output function",
  "Number of switching outputs",
  "Number of switching positions",
  "Switch position spacing",
  "Short-circuit protection",
  "Reverse polarity protection",
  "Mechanical connection",
  "Process connection",
  "Process connection material",
  "Pressure rating max.",
  "Overload pressure",
  "Burst pressure",
  "Accuracy",
  "Repeat accuracy",
  "Gasket, material",
  "Media temperature",
  "Connection type",
  "Connector type",
  "Connector configuration",
  "Mounting part",
  "Approach direction",
  "Approach speed",
  "Magnets, number max.",
  "Flange material",
  "Rod material",
  "Nominal stroke",
  "Linearity deviation",
  "Non-linearity max.",
  "Repeat accuracy",
  "Analog output",
  "Output characteristic",
  "Limit frequency -3 dB",
  "Sampling frequency",
  "Beam characteristic",
  "Beam angle",
  "Light spot size",
  "Light intensity",
  "Color temperature",
  "Illumination area",
  "Image resolution",
  "Sensor type Vision",
  "Vibration, frequency range",
  "Vibration, number of measuring axes",
  "Vibration, measuring range",
  "Contact temperature, measuring range",
  "Relative humidity, measuring range",
  "Ambient pressure, measuring range",
  "Rated operating voltage Ue DC",
  "Read distance",
  "Reference signal",
  "Procedure direction",
  "Fork opening",
  "Trademark",
  "Communication",
  "Keypad",
  "Filter",
  "Focal length",
  "Back focal length",
  "Aperture",
  "Distortion",
  "Minimum object distance (MOD)",
  "Angle of view, horizontal",
  "Angle of view, vertical",
  "Max. Sensor size",
  "Lens mount",
  "Storage temperature",
  "Connector design",
  "Volume (at a distance of 1m)",
  "ECLASS 4.1",
  "ECLASS 5.1.4",
  "ECLASS 6.2",
  "ECLASS 8.1",
  "ECLASS 9.0",
  "ECLASS 9.1",
  "ECLASS 10.1",
  "ECLASS 11.0",
  "ECLASS 12.0",
  "ECLASS 13.0",
  "ECLASS 14.0",
  "ETIM 4.0",
  "ETIM 5.0",
  "ETIM 6.0",
  "ETIM 7.0",
  "ETIM 8.0",
  "ETIM 9.0",
  "UNSPSC 11",
  "UNSPSC 7.0901",
  "UNSPSC"
];

const BALLUFF_RAW_LABEL_ALIASES: Record<string, string> = {
  "operating voltage": "Operating voltage Ub",
  "betriebsspannung": "Operating voltage Ub",
  "betriebsspannung ub": "Operating voltage Ub",
  "rated current (40 c)": "Rated current",
  "nennstrom (40 c)": "Rated current",
  "degree of protection": "IP rating",
  "protection type": "IP rating",
  schutzart: "IP rating",
  conformity: "Approval/Conformity",
  "approvals / conformity": "Approval/Conformity",
  "approvals/conformity": "Approval/Conformity",
  "zulassung/konformitaet": "Approval/Conformity",
  "zulassung/konformitat": "Approval/Conformity",
  "conductor cross section": "Conductor cross-section",
  aderquerschnitt: "Conductor cross-section",
  "connection com 1": "Connection (COM 1)",
  "connection sensor": "Connection for sensor",
  "configurable i/o": "Configurable inputs/outputs",
  "current sum us sensor": "Current sum US, sensor",
  "current sum ua actuator": "Current sum UA, actuator",
  "rated operating voltage": "Rated operating voltage Ue",
  "output current max": "Output current max.",
  "max. output current": "Output current max.",
  "io-link revision": "IO-Link version",
  "process data cycle min": "Process data cycle min.",
  "taric code": "Tariff Code",
  "taric-code": "Tariff Code",
  gewicht: "Weight",
  anschluss: "Connection",
  "anschluss 1": "Connection 1",
  "anschluss 2": "Connection 2",
  kabel: "Cable",
  "anzahl der leiter": "Number of conductors",
  betriebsanzeige: "Power indicator",
  funktionsanzeige: "Function indicator",
  schaltausgang: "Switching output",
  "besondere eigenschaften": "Special characteristics",
  schirmung: "Cable shielding",
  schnittstelle: "Interface",
  "analoge eingaenge": "Analog inputs",
  "analoge ausgaenge": "Analog outputs",
  aufloesung: "Resolution",
  "digitale eingaenge": "Digital inputs",
  "digitale ausgaenge": "Digital outputs",
  gehaeusematerial: "Housing material",
  "material housing": "Housing material",
  "limit frequency -3 db": "Limit frequency -3 dB",
  "limit frequency - 3 db": "Limit frequency -3 dB",
  dimensions: "Dimension",
  abmessung: "Dimension",
  abmessungen: "Dimension",
  umgebungstemperatur: "Ambient temperature",
  uebertragungsrate: "Transfer rate",
  ausfuehrung: "Version",
  verwendung: "Use",
  ausgangsspannung: "Output voltage",
  nennausgangsstrom: "Rated output current",
  "cable note": "Cable, note",
  kabelhinweis: "Cable, note",
  "country of origin": "Country of origin",
  herkunftsland: "Country of origin",
  "product carbon footprint": "Product carbon footprint",
  "co2 fussabdruck": "Product carbon footprint",
  "battery regulation": "Battery regulation",
  batterieverordnung: "Battery regulation",
  "substances of concern": "Substances of concern",
  "besorgniserregende stoffe": "Substances of concern",
  "disposal instructions": "Disposal instructions",
  entsorgungshinweise: "Disposal instructions"
};

const BALLUFF_LABEL_ALIASES = Object.fromEntries(
  Object.entries(BALLUFF_RAW_LABEL_ALIASES).map(([label, canonical]) => [balluffLabelKey(label), canonical])
) as Record<string, string>;

const BALLUFF_CANONICAL_LABELS = new Map(
  BALLUFF_SPEC_LABELS.map((label) => [balluffLabelKey(label), label] as const)
);

const BALLUFF_META_LABEL_PATTERN = [...BALLUFF_SPEC_LABELS]
  .sort((left, right) => right.length - left.length)
  .map(escapeRegExp)
  .join("|");

const BALLUFF_SECTION_TOKENS = new Set([
  "key features",
  "hauptmerkmale",
  "downloads",
  "classifications",
  "klassifizierungen",
  "digital product passport",
  "digitaler produktpass",
  "knowledge base",
  "knowledge base articles",
  "videos"
]);

function extractBalluffDomAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];

  $("div").each((_, element) => {
    const node = $(element);
    const directChildren = node.children("div").toArray();
    if (directChildren.length < 2) return;

    if (isBalluffSummaryGrid($, element)) {
      for (let index = 0; index < directChildren.length - 1; index += 2) {
        addBalluffDomAttribute($, attributes, "Balluff Summary Features", directChildren[index], directChildren[index + 1], sourceUrl);
      }
      return;
    }

    if (isBalluffPairRow($, element)) {
      addBalluffDomAttribute($, attributes, balluffPairRowGroup($, element, directChildren[0]), directChildren[0], directChildren[1], sourceUrl);
      return;
    }

    if (isBalluffClassificationRow($, element)) {
      addBalluffDomAttribute($, attributes, "Balluff Classifications", directChildren[0], directChildren[1], sourceUrl);
    }
  });

  return dedupeAttributes(attributes);
}

function isBalluffSummaryGrid($: cheerio.CheerioAPI, element: AnyNode): boolean {
  const className = balluffClassName($, element);
  if (!/\bgrid\b/.test(className) || !/\bgrid-cols-2\b/.test(className) || !/\bmd:grid-cols-3\b/.test(className)) return false;
  const children = $(element).children("div").toArray();
  if (children.length < 2 || children.length % 2 !== 0) return false;
  return children.every((child, index) => {
    const childClass = balluffClassName($, child);
    return index % 2 === 0 ? /\bhyphens-auto\b/.test(childClass) : /\bfont-medium\b/.test(childClass);
  });
}

function isBalluffPairRow($: cheerio.CheerioAPI, element: AnyNode): boolean {
  const children = $(element).children("div").toArray();
  if (children.length !== 2) return false;
  const firstClass = balluffClassName($, children[0]);
  const secondClass = balluffClassName($, children[1]);
  return /\bcol-span-2\b/.test(firstClass) && /\bcol-span-3\b/.test(secondClass);
}

function balluffPairRowGroup($: cheerio.CheerioAPI, element: AnyNode, labelElement: AnyNode): string {
  const rawLabel = cleanBalluffNodeText($, labelElement);
  if (isBalluffDigitalProductPassportLabel(rawLabel)) return "Digital Product Passport";
  return balluffDomSectionGroup($, element) ?? "Balluff Key features";
}

function balluffDomSectionGroup($: cheerio.CheerioAPI, element: AnyNode): string | undefined {
  let current = $(element).parent();
  for (let depth = 0; current.length && depth < 7; depth += 1, current = current.parent()) {
    const text = cleanText(current.text());
    if (!text || text.length > 12000) continue;
    if (/\b(?:digital product passport|digitaler produktpass)\b/i.test(text)) return "Digital Product Passport";
    if (/\b(?:classifications|klassifizierungen)\b/i.test(text)) return "Balluff Classifications";
    if (/\b(?:key features|hauptmerkmale|main features)\b/i.test(text)) return "Balluff Key features";
  }
  return undefined;
}

function isBalluffDigitalProductPassportLabel(label: string): boolean {
  return /^(?:manufacturer|country of origin|product carbon footprint|carbon footprint|battery regulation|product passport|digital product passport|article number|product identifier|weee|reach|rohs|scip)\b/i.test(
    cleanText(label)
  );
}

function isBalluffClassificationRow($: cheerio.CheerioAPI, element: AnyNode): boolean {
  const className = balluffClassName($, element);
  const children = $(element).children("div").toArray();
  if (children.length !== 2 || !/\bflex\b/.test(className)) return false;
  const firstClass = balluffClassName($, children[0]);
  const secondClass = balluffClassName($, children[1]);
  return /\bw-1\/3\b/.test(firstClass) && /\bw-2\/3\b/.test(secondClass);
}

function addBalluffDomAttribute(
  $: cheerio.CheerioAPI,
  attributes: AttributeRecord[],
  group: string,
  labelElement: AnyNode,
  valueElement: AnyNode,
  sourceUrl: string
) {
  const rawLabel = cleanBalluffNodeText($, labelElement);
  const rawValue = cleanBalluffNodeText($, valueElement);
  const label = balluffCanonicalLabel(rawLabel) ?? rawLabel;
  const value = cleanBalluffSpecValue(label, rawValue);
  if (!isLikelyBalluffDomLabel(label) || !value) return;
  attributes.push({ group, name: label, value, sourceUrl });
}

function cleanBalluffNodeText($: cheerio.CheerioAPI, element: AnyNode): string {
  const html = $(element).html() ?? "";
  // Strip <script>/<style> blocks first to keep inline JS / CSS out of attribute values.
  return cleanText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\s*br\s*\/?>/gi, "; ")
      .replace(/<\/(?:div|p|li|span)>/gi, "; ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#(?:039|x27);/gi, "'")
  ).replace(/;\s*$/g, "");
}

function balluffClassName($: cheerio.CheerioAPI, element: AnyNode): string {
  return String($(element).attr("class") ?? "");
}

function isLikelyBalluffDomLabel(label: string): boolean {
  const cleaned = cleanText(label);
  if (!cleaned || cleaned.length > 140) return false;
  if (!/[A-Za-z]/.test(cleaned)) return false;
  if (cleaned.includes(";")) return false;
  if (/^(?:show all|show more|show less|add to|image|contact request|quantity scale|availability|retrieve data|downloads?|product documentation|classifications?|key features|digital product passport|knowledge base articles?|videos?)$/i.test(cleaned)) {
    return false;
  }
  if (/[{}]|var\(--|@media|display\s*:|calc\(/i.test(cleaned)) return false;
  if (looksLikeBalluffScriptContent(cleaned)) return false;
  return true;
}

function extractBalluffSectionAttributes(html: string, sourceUrl: string): AttributeRecord[] {
  const tokens = balluffTextTokens(html);
  const attributes: AttributeRecord[] = [];
  const sections = balluffDetailSections(tokens);

  for (const section of sections) {
    if (section.name !== "Key features" && section.name !== "Classifications" && section.name !== "Digital Product Passport") continue;
    const sectionAttributes = extractBalluffAttributesFromTokens(section.tokens, sourceUrl, `Balluff ${section.name}`).filter((attr) => {
      if (section.name === "Classifications") return isBalluffClassificationAttribute(attr.name);
      if (section.name === "Digital Product Passport") return !isBalluffClassificationAttribute(attr.name);
      return !isBalluffClassificationAttribute(attr.name);
    });
    attributes.push(...sectionAttributes);
  }

  if (attributes.length === 0) {
    attributes.push(...extractBalluffAttributesFromTokens(tokens, sourceUrl, "Balluff Detail Sections"));
  }

  return dedupeAttributes(attributes);
}

const BALLUFF_DPP_LABEL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "Weight", pattern: /(?:^|[>\s;, ])(?:Weight|Gewicht|Peso|Te[zž]ina)[\s:>]*([\d.,]+\s*(?:kg|g|lb|lbs|oz))(?=$|[<\s;,])/i },
  { label: "Tariff Code", pattern: /(?:^|[>\s;, ])(?:Tariff Code|Taric Code|Taric-Code|HS Code|Zolltarifnummer)[\s:>]*([\d. ]{6,15})(?=$|[<\s;,])/i },
  { label: "Country of origin", pattern: /(?:^|[>\s;, ])(?:Country of origin|Herkunftsland)[\s:>]*([A-Za-z][A-Za-z .]{1,40})(?=$|[<;,])/i },
  { label: "Manufacturer", pattern: /(?:^|[>\s;, ])(?:Manufacturer|Hersteller)[\s:>]*(Balluff[^<;]{0,80})(?=$|[<;,])/i },
  { label: "Product carbon footprint", pattern: /(?:^|[>\s;, ])(?:Product carbon footprint|PCF|CO2[- ]Fu[ßs]abdruck)[\s:>]*([^<;]{2,80})(?=$|[<;,])/i },
  { label: "Battery regulation", pattern: /(?:^|[>\s;, ])(?:Battery regulation|Batterieverordnung)[\s:>]*([^<;]{2,80})(?=$|[<;,])/i },
  { label: "Substances of concern", pattern: /(?:^|[>\s;, ])(?:Substances of concern|Besorgniserregende Stoffe)[\s:>]*([^<;]{2,200})(?=$|[<;,])/i },
  { label: "Disposal instructions", pattern: /(?:^|[>\s;, ])(?:Disposal instructions|Entsorgungshinweise)[\s:>]*([^<;]{2,200})(?=$|[<;,])/i }
];

function extractBalluffDigitalProductPassportFallback(html: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:039|x27);/gi, "'")
    .replace(/\s+/g, " ");
  for (const { label, pattern } of BALLUFF_DPP_LABEL_PATTERNS) {
    const match = stripped.match(pattern);
    if (!match) continue;
    const value = cleanText(match[1]);
    if (!value) continue;
    attributes.push({
      group: "Balluff Digital Product Passport",
      name: label,
      value,
      sourceUrl
    });
  }
  return dedupeAttributes(attributes);
}

function extractBalluffLifecycleAttributes(html: string, catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  const tokens = balluffTextTokens(html);
  const attributes: AttributeRecord[] = [];
  const status = tokens.find((token) => /^(?:canceled|cancelled|discontinued)$/i.test(token));
  if (status) {
    attributes.push({
      group: "Balluff Lifecycle",
      name: "Product status",
      value: cleanText(status),
      sourceUrl
    });
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (!/^recommended alternative$/i.test(tokens[index])) continue;
    const codeIndex = tokens
      .slice(index + 1, index + 8)
      .findIndex((token) => isBalluffCatalogCodeToken(token) && !sameCatalogNumber(token, catalogNumber));
    if (codeIndex < 0) continue;
    const absoluteCodeIndex = index + 1 + codeIndex;
    const valueParts = [tokens[absoluteCodeIndex]];
    for (let cursor = absoluteCodeIndex + 1; cursor < tokens.length && valueParts.length < 3; cursor += 1) {
      const token = tokens[cursor];
      if (isBalluffLifecycleBoundaryToken(token) || isBalluffCatalogCodeToken(token)) break;
      if (!isBadBalluffValue("Recommended alternative", token)) valueParts.push(token);
    }
    const value = cleanText(valueParts.join(" - "));
    if (value) {
      attributes.push({
        group: "Balluff Lifecycle",
        name: "Recommended alternative",
        value,
        sourceUrl
      });
      break;
    }
  }

  return dedupeAttributes(attributes);
}

function isBalluffCatalogCodeToken(token: string): boolean {
  return /^[A-Z]{2,4}[0-9][0-9A-Z]{3,8}$/i.test(cleanText(token));
}

function isBalluffLifecycleBoundaryToken(token: string): boolean {
  return /^(?:availability|retrieve data|how does\b.*|compare products\b.*|do you have\b.*|key features|downloads|classifications|digital product passport|knowledge base\b.*|alternative products|discontinued|canceled|cancelled)$/i.test(
    cleanText(token)
  );
}

function extractBalluffAttributesFromTokens(tokens: string[], sourceUrl: string, group: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const split = splitBalluffLabelToken(tokens[index]);
    if (!split) continue;
    const valueParts: string[] = [];
    if (split.value) valueParts.push(split.value);

    let cursor = index + 1;
    while (cursor < tokens.length && valueParts.length < 8) {
      const token = tokens[cursor];
      if (isBalluffBoundaryToken(token, tokens[cursor + 1])) break;
      if (!isBadBalluffValue(split.label, token)) valueParts.push(token);
      cursor += 1;
    }

    const value = cleanBalluffSpecValue(split.label, valueParts.join("; "));
    if (value) {
      attributes.push({
        group,
        name: split.label,
        value,
        sourceUrl
      });
    }
    if (cursor > index + 1) index = cursor - 1;
  }

  return dedupeAttributes(attributes);
}

function balluffDetailSections(tokens: string[]): Array<{ name: "Key features" | "Classifications" | "Downloads" | "Digital Product Passport"; tokens: string[] }> {
  const sections: Array<{ name: "Key features" | "Classifications" | "Downloads" | "Digital Product Passport"; tokens: string[] }> = [];
  let current: { name: "Key features" | "Classifications" | "Downloads" | "Digital Product Passport"; tokens: string[] } | undefined;

  for (const token of tokens) {
    const sectionName = balluffSectionName(token);
    if (sectionName) {
      if (current?.tokens.length) sections.push(current);
      current = { name: sectionName, tokens: [] };
      continue;
    }
    current?.tokens.push(token);
  }
  if (current?.tokens.length) sections.push(current);
  return sections;
}

function balluffSectionName(token: string): "Key features" | "Classifications" | "Downloads" | "Digital Product Passport" | undefined {
  const key = balluffLabelKey(token);
  if (/^(key features|hauptmerkmale|main features|ana ozellikler)$/.test(key)) return "Key features";
  if (/^(classifications|klassifizierungen|classificazioni|clasificaciones|classificacoes|classificaties)$/.test(key)) return "Classifications";
  if (/^(downloads|download|descargas|telechargements|indirilenler)$/.test(key)) return "Downloads";
  if (/^(digital product passport|digitaler produktpass|pasaporte digital de productos)$/.test(key)) return "Digital Product Passport";
  return undefined;
}

function isBalluffClassificationAttribute(name: string): boolean {
  return /^(?:eclass|etim|unspsc)\b|^energy consumption labeling$/i.test(name);
}

function balluffTextTokens(html: string): string[] {
  // Strip <script> and <style> blocks first — otherwise inline JS leaks into the token stream
  // and the spec extractor picks up garbage like "Function: dispatchEvent(...)" as DPP fields.
  const decoded = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\\u002f/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:039|x27);/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, " | ")
    .replace(/<\/(?:span|button|a|h1|h2|h3|dt|dd|li|p|tr|td|th|div|section)>/gi, " | ")
    .replace(/<[^>]+>/g, " | ")
    .replace(/\r?\n+/g, " | ");
  return decoded
    .split("|")
    .map((token) => cleanText(token))
    .filter((token) => token && token.length < 500)
    .filter((token) => !/^(show more|show less|download|add to cart|login|search|home|play)$/i.test(token))
    .filter((token) => !looksLikeBalluffScriptContent(token));
}

function looksLikeBalluffScriptContent(token: string): boolean {
  if (token.length < 12) return false;
  // Common signatures of inline JS / Alpine handlers / tracker snippets that occasionally
  // survive token splitting (anonymous functions, Alpine.js x-data init, Matomo/HubSpot, etc).
  return (
    /\b(?:function|var|const|let|return|new (?:Event|UET|CustomEvent)|dispatchEvent|document\.|window\.|setTimeout|setInterval|addEventListener|parentNode|getElementsByTagName|createElement|readyState)\b/.test(token) ||
    /[{};]\s*(?:var|function|const|let)\b/.test(token) ||
    /=>\s*[{(]/.test(token) ||
    /\bx-(?:on|bind|data|show|transition|init|model):/.test(token) ||
    /\$dispatch\(/.test(token)
  );
}

function splitBalluffLabelToken(token: string): { label: string; value?: string } | undefined {
  const colon = token.match(/^(.{2,90}?):\s*(.+)$/);
  if (colon) {
    const label = balluffCanonicalLabel(colon[1]);
    if (label) return { label, value: cleanText(colon[2]) };
  }

  const sortedLabels = [...BALLUFF_SPEC_LABELS].sort((left, right) => right.length - left.length);
  for (const knownLabel of sortedLabels) {
    const label = balluffCanonicalLabel(knownLabel);
    if (!label) continue;
    const key = balluffLabelKey(knownLabel);
    const tokenKey = balluffLabelKey(token);
    if (tokenKey === key) return { label };
    if (tokenKey.startsWith(`${key} `)) {
      const rest = token.slice(knownLabel.length).trim().replace(/^[:=-]\s*/, "");
      if (rest && rest.length < 320) return { label, value: rest };
    }
  }

  const aliasLabel = balluffCanonicalLabel(token);
  return aliasLabel ? { label: aliasLabel } : undefined;
}

function isBalluffBoundaryToken(token: string, nextToken?: string): boolean {
  const key = balluffLabelKey(token);
  return Boolean(BALLUFF_SECTION_TOKENS.has(key) || balluffCanonicalLabel(token) || isLikelyUnknownBalluffLabel(token, nextToken));
}

function isLikelyUnknownBalluffLabel(token: string, nextToken?: string): boolean {
  const cleaned = cleanText(token);
  if (!nextToken || !cleaned || cleaned.length > 120) return false;
  if (balluffCanonicalLabel(nextToken) || BALLUFF_SECTION_TOKENS.has(balluffLabelKey(nextToken))) return false;
  if (/^(?:[-+\u00b1\u2264\u2265]|\d|\u00d8)|\b(?:VDC|VAC|V AC|V DC|mA|kA|Hz|kHz|mm|cm|m|IP\d|PNP|NPN|PUR|PVC|PBT|CE|UKCA|WEEE|cULus)\b/i.test(cleaned)) {
    return false;
  }
  if (cleaned.split(/\s+/).length < 2) return false;
  return /\b(?:application|category|delivery|frequency|group|heads|input|installation|interface|length|light|linearity|max|number|operation|output|performance|principle|product|response|safety|scope|series|sil|style|surface|technolog|time)\b/i.test(cleaned);
}

function balluffCanonicalLabel(rawLabel: string): string | undefined {
  const key = balluffLabelKey(rawLabel);
  if (!key) return undefined;
  if (/^(eclass|etim)\s+\d+(?:\.\d+)*$/.test(key) || /^unspsc(?:\s+\d+(?:\.\d+)*)?$/.test(key)) return cleanText(rawLabel).toUpperCase();
  return BALLUFF_LABEL_ALIASES[key] ?? BALLUFF_CANONICAL_LABELS.get(key);
}

function balluffLabelKey(value: string): string {
  return cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/Â°/g, "")
    .replace(/°/g, "")
    .replace(/º/g, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[()]/g, " ")
    .replace(/[_,/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hasBalluffAttributeName(names: Set<string>, label: string): boolean {
  const key = balluffLabelKey(label);
  return names.has(key) || [...names].some((name) => name.startsWith(`${key} `));
}

function cleanBalluffSpecValue(label: string, value: string): string {
  let cleaned = cleanText(value)
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\b(Kilogramm|Kilogram)\b/gi, "kg")
    .replace(/\b(Gramm|gram)\b/gi, "g")
    .replace(/;\s*;/g, ";")
    .replace(/^(yes|ja)\s*;\s*/i, "Yes; ")
    .replace(/^(no|nein)\s*;\s*/i, "No; ");
  cleaned = stripBalluffInlineNestedLabels(label, cleaned);
  const meaningfulParts: string[] = [];
  for (const part of cleaned.split(/\s*;\s*/).map(cleanText)) {
    if (!part) continue;
    if (isBalluffNestedLabelValue(label, part)) break;
    if (!isBadBalluffValue(label, part)) meaningfulParts.push(part);
  }
  if (meaningfulParts.length && meaningfulParts.join("; ") !== cleaned) cleaned = meaningfulParts.join("; ");
  if (/^weight$/i.test(label)) cleaned = cleaned.match(/([0-9]+(?:[.,][0-9]+)?\s*(?:kg|g))\b/i)?.[1]?.replace(",", ".") ?? cleaned;
  if (/tariff code/i.test(label)) cleaned = cleaned.match(/\b([0-9]{6,10})\b/)?.[1] ?? cleaned;
  if (/^(yes|ja)$/i.test(cleaned)) cleaned = "Yes";
  if (/^(no|nein)$/i.test(cleaned)) cleaned = "No";
  if (/^use$/i.test(label) && /^additional$/i.test(cleaned)) return "";
  return isBadBalluffValue(label, cleaned) ? "" : cleaned;
}

function stripBalluffInlineNestedLabels(label: string, value: string): string {
  const labelKey = balluffLabelKey(label);
  let earliestNestedLabel = -1;
  for (const knownLabel of [...BALLUFF_SPEC_LABELS].sort((left, right) => right.length - left.length)) {
    if (balluffLabelKey(knownLabel) === labelKey) continue;
    // Match either "; Label:" (colon-delimited inline value) or "; Label;" (concatenated rows
    // from a parent grid being read as one DOM node). Both patterns mean the value has crossed
    // into a different row's territory and should be truncated.
    const matchColon = new RegExp(`(?:[,;]\\s*)${escapeRegExp(knownLabel)}\\s*:`, "i").exec(value);
    const matchSemi = new RegExp(`(?:[,;]\\s*)${escapeRegExp(knownLabel)}\\s*[;,]`, "i").exec(value);
    const matches = [matchColon, matchSemi].filter((m): m is RegExpExecArray => Boolean(m && m.index > 0));
    for (const match of matches) {
      earliestNestedLabel = earliestNestedLabel < 0 ? match.index : Math.min(earliestNestedLabel, match.index);
    }
  }
  return earliestNestedLabel > 0 ? cleanText(value.slice(0, earliestNestedLabel).replace(/[;,]\s*$/g, "")) : value;
}

function isBalluffNestedLabelValue(label: string, value: string): boolean {
  const nestedLabel = balluffCanonicalLabel(value);
  return Boolean(nestedLabel && balluffLabelKey(nestedLabel) !== balluffLabelKey(label));
}

function isBadBalluffValue(label: string, value: string): boolean {
  const cleaned = cleanText(value);
  if (!cleaned) return true;
  if (balluffLabelKey(cleaned) === balluffLabelKey(label)) return true;
  if (/^(show more|show less|downloads?|product documentation|classifications?|key features|digital product passport|knowledge base articles?|videos?|play|contact request|retrieve data|compare products?|alternative products?)$/i.test(cleaned)) {
    return true;
  }
  if (/^(?:cad\/cae data|software|drawings?|product view|product image|recommended accessories)$/i.test(cleaned)) return true;
  if (/\b(?:contact request|do you have any questions|how does|compare products|retrieve data|login to|add to cart|product configurator)\b/i.test(cleaned)) {
    return true;
  }
  if (/[{}]|var\(--|@media|display\s*:|calc\(/i.test(cleaned)) return true;
  // Reject obvious JavaScript / Alpine.js / tracker snippets that occasionally survive token splits.
  if (looksLikeBalluffScriptContent(cleaned)) return true;
  return false;
}

function isUsefulBalluffAttribute(attr: AttributeRecord): boolean {
  const name = cleanText(attr.name);
  const value = cleanText(attr.value);
  if (!name || !value) return false;
  if (isBadBalluffValue(name, value)) return false;
  const key = balluffLabelKey(name);
  if (BALLUFF_SECTION_TOKENS.has(key)) return false;
  if (/^(?:@context|@type|url|image|images)$/i.test(name)) return false;
  if (/^(?:og:|twitter:)/i.test(name) && /\b(?:image|url|site_name|locale)\b/i.test(name)) return false;
  if (/^meta$/i.test(cleanText(attr.group)) && /\b(?:image|url|site_name|locale)\b/i.test(name)) return false;
  if (/^https?:\/\/\S+$/i.test(value) && /\b(?:image|url|href|link)\b/i.test(name)) return false;
  return true;
}

function extractBalluffLivewireData(html: string, sourceUrl: string): { attributes: AttributeRecord[]; documents: DocumentRecord[] } {
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];

  for (const snapshot of readBalluffLivewireSnapshots(html)) {
    const memo = isRecord(snapshot.memo) ? snapshot.memo : {};
    const name = stringValue(memo.name) ?? "";
    const data = isRecord(snapshot.data) ? snapshot.data : {};
    if (!/^product::|^pia::product\./i.test(name)) continue;

    const productVariant = stringValue(data.productVariant) || stringValue(data.orderCode);
    const productLabel = stringValue(data.productLabel);
    if (productVariant) attributes.push({ group: "Balluff Component Data", name: "Product variant", value: productVariant, sourceUrl });
    if (productLabel) attributes.push({ group: "Balluff Component Data", name: "Product label", value: productLabel, sourceUrl });

    for (const [key, label] of Object.entries(BALLUFF_LIVEWIRE_DOCUMENT_KEYS)) {
      const url = absoluteBalluffUrl(stringValue(data[key]), sourceUrl);
      if (url && isBalluffDocumentUrl(url)) documents.push(documentFromUrl(url, label, sourceUrl));
    }

    const digitalProductData = data.data;
    if (/digital-product-pass/i.test(name) && digitalProductData && isRecord(digitalProductData)) {
      flattenBalluffLivewireAttributes(digitalProductData, ["Digital Product Passport"], sourceUrl, attributes);
    }

    for (const url of collectBalluffDocumentUrls(data, sourceUrl)) {
      documents.push(documentFromUrl(url, livewireDocumentLabel(url), sourceUrl));
    }
  }

  return {
    attributes: dedupeAttributes(attributes),
    documents: dedupeDocuments(documents)
  };
}

const BALLUFF_LIVEWIRE_DOCUMENT_KEYS: Record<string, string> = {
  datasheet: "Datasheet",
  measurementUrl: "Measurement data",
  eolaUrl: "End of life announcement",
  mttfCertificateUrl: "MTTF certificate",
  materialComplianceDeclarationUrl: "Material compliance declaration",
  weeePdfUrl: "WEEE certificate",
  cadLink: "CAD model",
  caeLink: "CAE model",
  multiCaeLink: "CAE model",
  onlineManualUrl: "Online manual",
  bupUrl: "BUP file",
  multidownloadUrl: "Multi-download"
};

function readBalluffLivewireSnapshots(html: string): Array<Record<string, unknown>> {
  const snapshots: Array<Record<string, unknown>> = [];
  for (const match of html.matchAll(/wire:snapshot=(["'])([\s\S]*?)\1/gi)) {
    const raw = decodeHtmlAttribute(match[2]);
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) snapshots.push(parsed);
    } catch {
      // Ignore malformed component snapshots.
    }
  }
  collectBalluffLivewireSnapshotsFromJson(html, snapshots);
  return snapshots;
}

function collectBalluffLivewireSnapshotsFromJson(text: string, snapshots: Array<Record<string, unknown>>) {
  if (!/^\s*[[{]/.test(text) || !/\b(?:snapshot|memo|effects|components)\b/i.test(text)) return;
  const seen = new Set(snapshots.map((snapshot) => JSON.stringify(snapshot).slice(0, 500)));
  const addSnapshot = (candidate: unknown) => {
    if (!isRecord(candidate) || !isRecord(candidate.memo) || !isRecord(candidate.data)) return;
    const key = JSON.stringify(candidate).slice(0, 500);
    if (seen.has(key)) return;
    seen.add(key);
    snapshots.push(candidate);
  };
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (!/^\s*[[{]/.test(value) || !/\b(?:memo|data|snapshot)\b/i.test(value)) return;
      try {
        visit(JSON.parse(value) as unknown);
      } catch {
        // Ignore non-JSON strings.
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    addSnapshot(value);
    if (typeof value.snapshot === "string") visit(value.snapshot);
    Object.values(value).forEach(visit);
  };

  try {
    visit(JSON.parse(text) as unknown);
  } catch {
    // Ignore non-JSON payloads.
  }
}

function flattenBalluffLivewireAttributes(value: unknown, path: string[], sourceUrl: string, attributes: AttributeRecord[]) {
  if (value === undefined || value === null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const name = cleanText(path[path.length - 1] ?? "");
    const attrValue = cleanText(String(value));
    if (name && attrValue && attrValue.length <= 500) {
      attributes.push({
        group: path.slice(0, -1).join(" - ") || "Balluff Component Data",
        name,
        value: attrValue,
        sourceUrl
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenBalluffLivewireAttributes(item, [...path, String(index + 1)], sourceUrl, attributes));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    flattenBalluffLivewireAttributes(child, [...path, humanizeBalluffKey(key)], sourceUrl, attributes);
  }
}

function collectBalluffDocumentUrls(value: unknown, baseUrl: string): string[] {
  const urls = new Set<string>();
  const visit = (candidate: unknown) => {
    if (typeof candidate === "string") {
      const url = absoluteBalluffUrl(candidate, baseUrl);
      if (url && isBalluffDocumentUrl(url)) urls.add(url);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) return;
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  return [...urls];
}

function absoluteBalluffUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  const cleaned = decodeHtmlAttribute(value)
    .replace(/\\u002f/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .trim();
  if (!cleaned || /^(?:null|undefined)$/i.test(cleaned)) return undefined;
  // Reject JS template literal markers and pipes. Spaces are valid in some Balluff CAD
  // part query values, so encode them instead of dropping the document.
  if (/[|{}$`]|Unknown/.test(cleaned)) return undefined;
  const encodedWhitespace = cleaned.replace(/\s+/g, "%20");
  try {
    return new URL(encodedWhitespace, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function livewireDocumentLabel(url: string): string {
  if (/type=pdb/i.test(url)) return "Datasheet";
  if (/type=weee/i.test(url)) return "WEEE certificate";
  if (/type=mcd|material/i.test(url)) return "Material compliance declaration";
  if (/partcommunity/i.test(url) && /cae/i.test(url)) return "CAE model";
  if (/partcommunity/i.test(url)) return "CAD model";
  return "Balluff document";
}

function humanizeBalluffKey(value: string): string {
  return cleanText(value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")).replace(/\b[a-z]/g, (letter) =>
    letter.toUpperCase()
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:039|x27);/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function isBalluffDocumentUrl(url: string): boolean {
  return (
    /publications\.balluff\.com/i.test(url) ||
    /partcommunity\.com/i.test(url) ||
    /eprel\.ec\.europa\.eu/i.test(url) ||
    /assets\.balluff\.com.*\.(?:pdf|zip|stp|step|dwg|dxf|igs|iges)\b/i.test(url) ||
    /balluff\.com.*\/(?:download|documents?|media)\//i.test(url)
  );
}

function documentFromUrl(url: string, label: string, sourceUrl: string): DocumentRecord {
  const parsed = new URL(url);
  const typeParam = parsed.searchParams.get("type")?.toLowerCase();
  const cleanLabel =
    label ||
    balluffDocumentLabelFromUrl(url, typeParam);
  return {
    type: /partcommunity\.com/i.test(url)
      ? "cad"
      : /eprel\.ec\.europa\.eu\/screen\/product/i.test(url)
        ? "other"
        : /eprel\.ec\.europa\.eu\/(?:labels|assets\/images\/label)\//i.test(url)
          ? "image"
          : classifyDocument(cleanLabel, url),
    label: cleanLabel,
    url,
    sourceUrl
  };
}

function balluffDocumentLabelFromUrl(url: string, typeParam: string | undefined): string {
  if (/eprel\.ec\.europa\.eu\/screen\/product/i.test(url)) return "EPREL product data sheet";
  if (/eprel\.ec\.europa\.eu\/labels\//i.test(url)) return "EPREL energy label";
  if (/eprel\.ec\.europa\.eu\/assets\/images\/label/i.test(url)) return "EPREL efficiency label";
  if (typeParam === "pdb") return "Datasheet";
  if (typeParam === "mcd") return "Material compliance declaration";
  if (typeParam === "weee") return "WEEE certificate";
  if (/partcommunity\.com/i.test(url)) return "CAD model";
  return "Balluff document";
}

function extractBalluffVideoDocuments($: cheerio.CheerioAPI, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  const addVideo = (url: string | undefined, label: string | undefined) => {
    const absolute = absoluteBalluffUrl(url, sourceUrl);
    if (!absolute || !/youtube\.com\/(?:embed|user)\//i.test(absolute)) return;
    documents.push({
      type: "other",
      label: cleanText(label) || "Balluff video",
      url: absolute,
      sourceUrl
    });
  };

  $("button").each((_, element) => {
    const clickHandler = Object.entries(element.attribs ?? {}).find(([name]) => /^x-on:click/i.test(name))?.[1];
    const url = clickHandler?.match(/['"]src['"]\s*:\s*['"]([^'"]+)['"]/i)?.[1];
    const label = cleanText($(element).siblings("img").attr("alt") || $(element).parent().find("img[alt]").first().attr("alt"));
    addVideo(url, label);
  });

  $("iframe[src*='youtube.com/embed/']").each((_, element) => {
    const node = $(element);
    addVideo(node.attr("src"), node.attr("title") || node.text());
  });

  return dedupeDocuments(documents);
}

function extractBalluffKnowledgeBaseDocuments($: cheerio.CheerioAPI, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const absolute = absoluteBalluffUrl(href, sourceUrl);
    if (!absolute || !isBalluffKnowledgeBaseUrl(absolute)) return;
    const label = cleanText($(element).text() || $(element).attr("title") || $(element).attr("aria-label")) || "Knowledge Base article";
    documents.push({
      type: "other",
      label,
      url: absolute,
      sourceUrl
    });
  });
  return dedupeDocuments(documents);
}

function isBalluffKnowledgeBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/balluff\.com(?:\.cn)?$/i.test(parsed.hostname)) return false;
    // Match specific article-like paths (FAQ/document IDs, /news/, /stories/, etc.) — NOT generic
    // marketing landing pages (e.g. /application-examples-and-solutions, /company-profile).
    return (
      /\/document\/(?:faq|kb|article)-?\d+/i.test(parsed.pathname) ||
      /\/(?:knowledge-base|knowledge|stories|blog|service\/knowledge|support\/knowledge|insights)\/[^/]+/i.test(parsed.pathname) ||
      /\/news\/[^/]+/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function extractBalluffEprelDocuments(html: string, sourceUrl: string): DocumentRecord[] {
  const decoded = html
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/gi, "&")
    .replace(/&#(?:039|x27);/gi, "'")
    .replace(/&quot;/gi, '"');
  const documents: DocumentRecord[] = [];
  const urls = decoded.match(
    /https?:\/\/eprel\.ec\.europa\.eu\/(?:screen\/product|labels|assets\/images\/label)\/[^"'<>\s)]+/gi
  ) ?? [];
  for (const rawUrl of urls) {
    try {
      const url = new URL(rawUrl, sourceUrl).toString();
      documents.push(documentFromUrl(url, "", sourceUrl));
    } catch {
      // Ignore malformed EPREL fragments.
    }
  }
  return dedupeDocuments(documents);
}

function extractEmbeddedDocumentUrls(html: string, baseUrl: string): string[] {
  const decoded = html
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"');
  const urls = new Set<string>();
  const keyedUrls = decoded.matchAll(
    /"(?:datasheet|measurementUrl|eolaUrl|mttfCertificateUrl|materialComplianceDeclarationUrl|weeePdfUrl|cadLink|caeLink|multiCaeLink|onlineManualUrl|bupUrl|multidownloadUrl)"\s*:\s*"([^"]+)"/gi
  );
  for (const match of keyedUrls) {
    // Drop anything that contains JS template literal junk, pipes, or whitespace —
    // Reject template junk in absoluteBalluffUrl, but encode spaces in Balluff CAD part query values.
    const url = absoluteBalluffUrl(match[1], baseUrl);
    if (url && isBalluffDocumentUrl(url)) urls.add(url);
  }
  const inlineUrls = decoded.match(/https?:\/\/(?:publications\.balluff\.com\/pdfengine\/pdf)[^"'<>\s|{}$`]+/gi) ?? [];
  for (const url of inlineUrls) urls.add(url);
  // Also pick up partcommunity CAD viewer URLs and any direct PDF/CAD asset hosted on Balluff's own CDN.
  const cadUrls = decoded.match(/https?:\/\/(?:webapi\.partcommunity\.com|b2b\.partcommunity\.com|www\.partcommunity\.com)[^"'<>\s|{}$`]+/gi) ?? [];
  for (const url of cadUrls) urls.add(url);
  const assetUrls = decoded.match(/https?:\/\/assets\.balluff\.com[^"'<>\s|{}$`]+\.(?:pdf|zip|stp|step|dwg|dxf|igs|iges)/gi) ?? [];
  for (const url of assetUrls) urls.add(url);
  // Sanitize: strip trailing punctuation that doesn't belong in a URL.
  return [...urls]
    .map((url) => url.replace(/[)\]}>,;:.!?]+$/, ""))
    .map((url) => new URL(url, baseUrl).toString());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
