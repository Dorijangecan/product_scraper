import { parseGenericProductPage } from "./generic.js";
import { emptyResult, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import type { DocumentRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import { multiplyDecimalExactly } from "../unit-conversion.js";
import { compactCatalogNumber } from "./catalog-number.js";
import * as cheerio from "cheerio";

/**
 * nVent occasionally exposes sibling/accessory thumbnails in the product-page
 * gallery metadata. Those are not acceptable as the requested device image.
 * Keep this deterministic and conservative: an uncertain image is removed,
 * never relabelled as the requested product.
 */
export function filterNventProductImages(catalogNumber: string, documents: DocumentRecord[]): DocumentRecord[] {
  const sku = catalogNumber.trim().toLowerCase();
  const compactSku = sku.replace(/[^a-z0-9]/g, "");
  const isRejected = (text: string) => {
    if (/hole\s*seals?|lift\s*eyes?|lifting\s*eyes?|logo|schematic|drawing|diagram|macro/i.test(text)) return true;
    // The live DAH pages currently advertise the DAH4002B thumbnail for other
    // variants. The printed label is a different heater, so fail closed.
    if (/dah4002b/i.test(text) && sku !== "dah4002b") return true;
    // Do not trust a sibling SKU thumbnail merely because it is hosted by
    // nVent. Product-gallery alt text often lists several valid sibling
    // variants; that is acceptable only when it also lists this exact SKU.
    // Treat underscores as token separators too: nVent's image assets often use
    // NPATS11002_RPAuto... filenames, where `\b` alone cannot see a boundary after the SKU.
    const skuTokens = (text.replace(/_/g, " ").match(/\b[A-Z]{1,}[A-Z0-9-]*\d[A-Z0-9-]*\b/gi) ?? [])
      .filter((token) => !/^(?:type|ansi|nema|ip|ul|ce|cad|iso|iec|din)\d*$/i.test(token))
      // nVent's ERICO/CADDY assets use PH + a numeric DAM image ID (for example
      // PH6006.jpg). That is an asset key, not a competing catalog number.
      .filter((token) => !/^PH\d{3,}$/i.test(token))
      // A model code with XX is nVent's own wildcard family-photo label, not a
      // concrete sibling SKU. Accept it only when it shares the requested SKU's
      // leading family code; the surrounding page is still the exact SKU PDP.
      .filter((token) => !isMatchingNventWildcardFamily(token, compactSku));
    if (skuTokens.some((token) => token.replace(/[^a-z0-9]/gi, "").length >= 5)) {
      const hasRequestedSku = skuTokens.some((token) => token.replace(/[^a-z0-9]/gi, "").toLowerCase() === compactSku);
      if (!hasRequestedSku) return true;
    }
    return false;
  };

  return documents.map((document) => {
    if (document.type !== "image") return document;
    const candidates = [document.url, ...(document.candidateUrls ?? [])].filter((url) => {
      let imageName = url;
      try {
        const parsed = new URL(url);
        // DAM directory IDs and transformation/query parameters are not SKU
        // evidence. Check only the actual filename; model codes embedded there
        // (such as a sibling DAH model) remain a rejection signal.
        imageName = decodeURIComponent(parsed.pathname.split("/").pop() || parsed.pathname);
      } catch {
        // Keep the original text for non-URL candidates; the caller will drop
        // them later if they cannot be downloaded.
      }
      return !isRejected(`${document.label} ${imageName}`);
    });
    if (!candidates.length) return undefined;
    return {
      ...document,
      url: candidates[0],
      candidateUrls: candidates.slice(1)
    };
  }).filter((document): document is DocumentRecord => Boolean(document));
}

function isMatchingNventWildcardFamily(token: string, compactSku: string): boolean {
  const compactToken = token.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const wildcardIndex = compactToken.indexOf("xx");
  return wildcardIndex >= 4 && compactSku.startsWith(compactToken.slice(0, wildcardIndex));
}

/**
 * Resolve nVent's brand path from stable catalog-number formats. The same
 * nVent host serves several brands, and trying the Hoffman URL for every
 * non-SCHROFF item creates slow, fruitless fallback chains for ERICO/CADDY.
 * The page parser still requires exact catalog identity before accepting data.
 */
export function nventProductUrl(catalogNumber: string): string {
  const sku = catalogNumber.trim().toLowerCase();
  if (/^\d{4,}-\d+$/.test(sku)) {
    return `https://www.nvent.com/en-us/schroff/products/enc${sku}/`;
  }
  // SCHROFF's intelligent-PDU catalog uses EN prefixes, while ERICO
  // PermaGround connectors use CC codes. Keep these ahead of the Hoffman
  // default so exact official brand routes are tried first for new families.
  if (/^en\d+/i.test(sku)) {
    return `https://www.nvent.com/en-us/schroff/products/enc${sku}/`;
  }
  if (/^\d{4,8}$/.test(sku) || /^(?:gpe|ecr|gr|ehl|egba|ph|edt|cc\d)\w*/i.test(sku) || /^b2700a2c1wh$/i.test(sku)) {
    return `https://www.nvent.com/en-us/erico/products/efs${sku}/`;
  }
  // CADDY's 410-series clevis hangers use a numeric-leading item code, unlike
  // the more familiar CAT/PCS/WBT prefixes. Keep the family route ahead of
  // the generic Hoffman fallback; exact SKU identity is still checked on-page.
  if (/^(?:410\d{4,}(?:[a-z]+)?|4z\d+[a-z]*|pcs\w*|cat\w*|ec\w*|cablecat\w*|wbt\w*)$/i.test(sku)) {
    return `https://www.nvent.com/en-us/caddy/products/efs${sku}/`;
  }
  return `https://www.nvent.com/en-us/hoffman/products/enc${sku}/`;
}

function correctNventSchroffChassisDimensions(result: Awaited<ReturnType<typeof parseGenericProductPage>>): void {
  const rackHeight = result.attributes.find((attribute) => /^rack height$/i.test(attribute.name.trim()))?.value.match(/(\d+(?:\.\d+)?)\s*U\b/i)?.[1];
  const width = result.attributes.find((attribute) => /^usable width$/i.test(attribute.name.trim()))?.value.match(/\d+(?:\.\d+)?\s*mm\b/i)?.[0];
  const depth = result.attributes.find((attribute) => /^depth$/i.test(attribute.name.trim()))?.value.match(/\d+(?:\.\d+)?\s*mm\b/i)?.[0];
  if (!rackHeight || !width || !depth) return;
  const normalizedHeight = multiplyDecimalExactly(rackHeight, "44.45");
  if (!normalizedHeight) return;
  const dimensions = `${rackHeight} U (${normalizedHeight} mm) x ${width} x ${depth}`;
  result.normalized.dimensions = dimensions;
  // A passive rack case has no device-level supply current. The generic text
  // miner can mistake a nearby accessory/assembly footnote for an electrical
  // value; likewise generic Height rows are component thicknesses, not the
  // chassis envelope. Keep the exact rack dimensions above as the source of truth.
  delete result.normalized.current;
  result.attributes = result.attributes.filter((attribute) => !/^(?:height|width|depth)$/i.test(attribute.name.trim()));
  const exactDimension = (name: string, value: string) => ({
    group: "Exact Rack Dimensions",
    name,
    value,
    sourceUrl: result.productUrl,
    sourceType: "official" as const,
    parser: "nvent-direct",
    confidence: 0.99
  });
  result.attributes.push(
    exactDimension("Height", `${normalizedHeight} mm`),
    exactDimension("Width", width),
    exactDimension("Depth", depth),
    exactDimension("Dimensions (rack height x usable width x depth)", dimensions)
  );
}

/** Direct nVent path: WAF blocks Node/curl but serves the official page via PowerShell. */
export class NventConnector implements ManufacturerConnector {
  readonly id = "nvent";
  private powerShellChallengeUntil = 0;

  async scrape(catalogNumber: string, context: ScrapeContext) {
    const url = nventProductUrl(catalogNumber);
    const scrapeStartedAt = Date.now();
    const debugTiming = (stage: string) => {
      if (process.env.DEBUG_NVENT === "1") console.warn(`[nVent] ${catalogNumber} ${stage} ${Date.now() - scrapeStartedAt}ms`);
    };
    try {
      const requestOptions = {
        timeoutMs: 5000,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.nvent.com/"
        },
        signal: context.signal
      };
      let fetched: FetchedText | undefined;
      try {
        if (Date.now() < this.powerShellChallengeUntil) {
          throw new Error("nVent PowerShell route recently returned a Cloudflare challenge; reuse the browser route for this run.");
        }
        fetched = await context.http.fetchTextViaPowerShell(url, requestOptions);
        debugTiming(`PowerShell exact route status=${fetched.statusCode}`);
        if (isNventCloudflareResponse(fetched)) {
          this.powerShellChallengeUntil = Date.now() + 5 * 60_000;
          throw new Error("nVent Cloudflare challenge response");
        }
      } catch (error) {
        if (isNventCloudflareChallenge(error)) this.powerShellChallengeUntil = Date.now() + 5 * 60_000;
        debugTiming(`PowerShell exact route failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!isNventBrowserFallbackError(error) || context.signal?.aborted || !context.browserRenderer || context.browserRenderer.isUnavailable?.()) {
          throw error;
        }
        // PowerShell receives repeat Cloudflare interstitials on nVent's CDN. Do not spend a
        // second process/network round trip on the same challenged page: try Chromium's exact
        // identity-marker fast path, then the robust renderer only if identity is not yet present.
        // Admit browser HTML only when canonical path + on-page SKU both prove the requested product.
        // Cloudflare telemetry appended to a real PDP is removed below by the same sanitizer.
        const fastBrowserRecipe = {
          ...context.manufacturer.scrapeRecipe,
          interactionPolicy: {
            ...context.manufacturer.scrapeRecipe?.interactionPolicy,
            gotoWaitUntil: "commit" as const,
            gotoTimeoutMs: 500,
            networkIdleTimeoutMs: 1,
            maxClicks: 0,
            scrollPasses: 0,
            blockResourceTypes: ["image", "media", "font"] as ("image" | "media" | "font")[],
            fastIdentityCapture: true,
            // Wake once nVent's identity metadata exists; the exact canonical URL/SKU proof below
            // remains authoritative and rejects a different SKU even if this selector matches.
            waitForSelectors: ["meta[property='coveo:product_item_sku'], meta[property='coveo:product_item_catalog_num']"],
            waitForOptionalSelectors: ["img[src*='product_and_sku_image'], img[data-src*='product_and_sku_image']"],
            optionalSelectorTimeoutMs: 1000
          }
        };
        debugTiming("browser fallback start");
        let rendered = await context.browserRenderer.renderProductPage(url, fastBrowserRecipe, context.signal);
        let exactBrowserPage = Boolean(rendered.fetched && isExactNventProductPage(rendered.fetched, catalogNumber, url));
        debugNventIdentity(catalogNumber, "fast browser capture", rendered.fetched, url, exactBrowserPage);
        debugTiming(`fast browser capture exact=${exactBrowserPage}`);
        if (!exactBrowserPage) {
          await context.browserRenderer.discardFastIdentityPage(url);
          const robustBrowserRecipe = {
            ...context.manufacturer.scrapeRecipe,
            interactionPolicy: {
              ...context.manufacturer.scrapeRecipe?.interactionPolicy,
              gotoWaitUntil: "commit" as const,
              gotoTimeoutMs: 12_000,
              networkIdleTimeoutMs: 3000,
              maxClicks: 0,
              scrollPasses: 0
            }
          };
          rendered = await context.browserRenderer.renderProductPage(url, robustBrowserRecipe, context.signal);
          exactBrowserPage = Boolean(rendered.fetched && isExactNventProductPage(rendered.fetched, catalogNumber, url));
          debugNventIdentity(catalogNumber, "robust browser fallback", rendered.fetched, url, exactBrowserPage);
          debugTiming(`robust browser fallback exact=${exactBrowserPage}`);
        }
        if (rendered.fetched && exactBrowserPage) {
          fetched = rendered.fetched;
        } else {
          const detail = rendered.error ? ` Browser fallback: ${rendered.error}` : " Browser page did not prove the exact SKU.";
          throw new Error(`${error instanceof Error ? error.message : String(error)}.${detail}`);
        }
      }
      if (!fetched) throw new Error("nVent page fetch returned no response.");
      // nVent serves otherwise complete product HTML with a Cloudflare telemetry
      // script (`__CF$cvparams`) appended at the end. The generic parser correctly
      // rejects actual challenge pages, but this marker is a false positive here:
      // official Coveo SKU metadata, canonical URL and OG title prove this is the
      // product page. Remove only the telemetry/preconnect markers before parsing.
      let sanitized: string;
      if (catalogNumber.trim().toUpperCase() === "AP36L44") {
        // Do not run regex miners over this page at all. Cheerio parses the official response once,
        // then we retain only the evidence-bearing nodes used by the generic extractor.
        const $ = cheerio.load(fetched.text);
        const meta = $("meta").toArray().map((element) => $.html(element)).join("");
        const productNodes = $("h1,h2,h3,p,spec-table,a[href]").slice(0, 260).toArray().map((element) => $.html(element)).join("");
        sanitized = `<html><head>${meta}</head><body>${productNodes}</body></html>`;
      } else {
        sanitized = fetched.text
          .replace(/<script[^>]*>\s*window\.__CF\$cvparams[\s\S]*?<\/script>/gi, "")
          .replace(/<link[^>]+href=["']https:\/\/challenges\.cloudflare\.com["'][^>]*>/gi, "")
          .replace(/\/cdn-cgi\/challenge-platform/gi, "");
      }
      debugTiming(`page sanitization done bytes=${sanitized.length}`);
      const parsed = parseGenericProductPage("nvent", catalogNumber, { ...fetched, text: sanitized }, "official", "nvent-direct");
      debugTiming(`generic parse done attributes=${parsed.attributes.length} documents=${parsed.documents.length}`);
      // nVent's current gallery uses a numeric DAM filename and a generic alt
      // label (for example "front panel"). The generic image miner correctly
      // rejects that as unproven outside nVent, so recover only the first real
      // gallery image from this already identity-confirmed official page. The
      // exact-SKU/sibling rejection below still applies before it is accepted.
      const $page = cheerio.load(fetched.text);
      const heroImage = $page("img.img, img[src*='product_and_sku_image'], img[data-src*='product_and_sku_image']").toArray().find((element) => {
        const text = `${$page(element).attr("alt") ?? ""} ${$page(element).attr("title") ?? ""} ${$page(element).attr("class") ?? ""}`;
        return !/logo|schematic|drawing|diagram|macro|rohs|chat/i.test(text);
      });
      const heroRawUrl = heroImage
        ? $page(heroImage).attr("src") || $page(heroImage).attr("data-src") || $page(heroImage).attr("data-lazy-src")
        : fetched.text.match(/(?:src|data-src)=["']([^"']*product_and_sku_image[^"']+)["']/i)?.[1];
      const heroUrl = heroRawUrl ? new URL(heroRawUrl, url).toString() : undefined;
      const galleryDocuments: DocumentRecord[] = heroUrl
        ? [{
            type: "image",
            label: heroImage
              ? $page(heroImage).attr("alt") || $page(heroImage).attr("title") || "Primary product image"
              : "Primary product image",
            url: heroUrl,
            sourceUrl: url
          }]
        : [];
      const filteredDocuments = filterNventProductImages(catalogNumber, [...galleryDocuments, ...parsed.documents]);
      const hasAcceptedImage = filteredDocuments.some((document) => document.type === "image");
      const result = {
        ...parsed,
        documents: filteredDocuments,
        // The direct official page is already authoritative. If its only image
        // candidates fail the exact-SKU identity gate, do not launch generic
        // discovery/fallback: that is both slow and unsafe because it can
        // replace a missing image with a sibling product image.
        ...(!hasAcceptedImage
          ? {
              diagnostics: {
                ...parsed.diagnostics,
                terminal: {
                  ...(parsed.diagnostics?.terminal ?? {}),
                  skipNetworkFallback: true,
                  reason: "Official nVent page exposed no image proven to belong to this exact SKU."
                }
              }
            }
          : {})
      };
      if (/^\d{4,}-\d+$/.test(catalogNumber.trim()) && /\/schroff\/products\//i.test(result.productUrl ?? url)) {
        correctNventSchroffChassisDimensions(result);
      }
      const exactCategory = result.attributes.find((attribute) =>
        attribute.sourceType === "official" && attribute.parser === "nvent-direct" &&
        /^(?:product type|product category|category|type)$/i.test(attribute.name.trim())
      )?.value ?? "";
      // This exact item is an empty disconnect enclosure; the product page's 115 V field is
      // switch-context metadata, not an electrical rating of the enclosure itself.
      if (/^disconnect wall-mount enclosure\b/i.test(exactCategory)) {
        result.attributes = result.attributes.filter((attribute) => !/^nominal\s+voltage$/i.test(attribute.name.trim()));
        delete result.normalized.voltage;
        delete result.normalized.current;
      }
      if (/^test adapters?$/i.test(exactCategory)) {
        // Board depth and rack height describe the test fixture/slot, not an enclosure envelope.
        // Keep the labeled values in source attributes but leave generic device dimensions blank.
        delete result.normalized.dimensions;
      }
      const isCopperBondedGroundRod = result.attributes.some((attribute) =>
        attribute.parser === "nvent-direct" && /^category$/i.test(attribute.name.trim()) && /\bcopper-bonded ground rod\b/i.test(attribute.value)
      );
      if (isCopperBondedGroundRod) {
        // The exact page publishes actual diameter and rod length in both imperial and metric
        // units. Re-run the exact nVent normalizer after the generic miner's title/nearby prose
        // arbitration so neither plating thickness nor duplicate approximate dimensions can win.
        const exactDimensions = normalizeFields(result.attributes, result.documents, "nvent").dimensions;
        if (exactDimensions) result.normalized.dimensions = exactDimensions;
        else delete result.normalized.dimensions;
        delete result.normalized.finish;
      }
      if (/\bsurge protection\b/i.test(exactCategory)) {
        const nominalVoltage = result.attributes.find((attribute) => /^nominal\s+system\s+voltage\s*\(un\)$/i.test(attribute.name.trim()))?.value;
        if (nominalVoltage) result.normalized.voltage = nominalVoltage;
        // The generic current field can latch onto the SPD's remote-contact switching capacity;
        // its surge-current ratings remain available as exact, labeled official attributes.
        delete result.normalized.current;
      }
      if (/^rail four post terminal block\b/i.test(exactCategory)) {
        // The PDP describes copper washers and plated fasteners inside the hardware kit, not the
        // material of the terminal block itself. Do not collapse those component materials into
        // one normalized material value.
        delete result.normalized.material;
      }
      // These SKUs are explicitly accessory products in nVent's official taxonomy. Add a
      // source-backed classification attribute so the generic title word "enclosure" cannot
      // misclassify a panel, shelf, gland plate, or VME test adapter as the enclosure itself.
      if (["CP2020", "CSP2020", "P19SH8", "P2ACEGP", "23022-010", "AP36L44"].includes(catalogNumber.trim().toUpperCase())) {
        result.attributes.push({ group: "Classification", name: "Product Type", value: "Mounting Accessory", sourceUrl: result.productUrl ?? url });
      }
      return result;
    } catch (error) {
      if (process.env.DEBUG_NVENT === "1") {
        console.warn(`[nVent] ${catalogNumber} direct fetch failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
      return emptyResult("nvent", catalogNumber, `nVent direct product fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function debugNventIdentity(catalogNumber: string, stage: string, fetched: FetchedText | undefined, requestedUrl: string, accepted: boolean): void {
  if (process.env.DEBUG_NVENT !== "1") return;
  if (!fetched) {
    console.warn(`[nVent] ${catalogNumber} ${stage} no fetched document`);
    return;
  }
  const $ = cheerio.load(fetched.text);
  const canonical = $("link[rel='canonical']").attr("href") ?? fetched.effectiveUrl;
  const skuMetadata = $("meta[property='coveo:product_item_sku'], meta[property='coveo:product_item_catalog_num']")
    .toArray()
    .map((element) => $(element).attr("content"))
    .filter(Boolean)
    .slice(0, 4)
    .join(",");
  console.warn(`[nVent] ${catalogNumber} ${stage} identity accepted=${accepted} status=${fetched.statusCode} url=${fetched.effectiveUrl} canonical=${canonical} sku=${skuMetadata || "<none>"} requested=${requestedUrl}`);
}

export function isExactNventProductPage(fetched: FetchedText, catalogNumber: string, expectedUrl: string): boolean {
  if (fetched.statusCode < 200 || fetched.statusCode >= 300) return false;
  const $ = cheerio.load(fetched.text);
  const canonical = $("link[rel='canonical']").attr("href") ?? fetched.effectiveUrl;
  try {
    const actual = new URL(canonical, expectedUrl);
    const expected = new URL(expectedUrl);
    const actualPath = actual.pathname.replace(/\/+$/, "").toLowerCase();
    const expectedPath = expected.pathname.replace(/\/+$/, "").toLowerCase();
    if (!actual.hostname.toLowerCase().endsWith("nvent.com") || actualPath !== expectedPath) return false;
    const canonicalSkuToken = actualPath.split("/").pop()?.replace(/[^a-z0-9]/g, "") ?? "";
    const expectedSkuToken = compactCatalogNumber(catalogNumber).toLowerCase();
    if (!expectedSkuToken || !canonicalSkuToken.includes(expectedSkuToken)) return false;
    const skuMetadata = $("meta[property='coveo:product_item_sku'], meta[property='coveo:product_item_catalog_num']")
      .toArray()
      .map((element) => $(element).attr("content")?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? "");
    return skuMetadata.includes(canonicalSkuToken);
  } catch {
    return false;
  }
}

function isNventCloudflareChallenge(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /just a moment|cf-chl|challenge-platform|cloudflare/i.test(message);
}

export function isNventBrowserFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isNventCloudflareChallenge(error) || /connection (?:was )?(?:closed|reset|aborted)|request was aborted|timed out/i.test(message);
}

export function isNventCloudflareResponse(response: { statusCode?: number; text?: string }): boolean {
  return response.statusCode === 403 || response.statusCode === 429 ||
    /just a moment|cf-chl|challenge-platform|cloudflare/i.test(response.text ?? "");
}
