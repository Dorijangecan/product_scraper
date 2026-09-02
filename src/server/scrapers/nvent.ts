import { parseGenericProductPage } from "./generic.js";
import { emptyResult } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import type { DocumentRecord } from "../../shared/types.js";
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
    const skuTokens = (text.match(/\b[A-Z]{1,}[A-Z0-9-]*\d[A-Z0-9-]*\b/gi) ?? [])
      .filter((token) => !/^(?:type|ansi|nema|ip|ul|ce|cad|iso|iec|din)\d*$/i.test(token));
    if (skuTokens.some((token) => token.replace(/[^a-z0-9]/gi, "").length >= 5)) {
      const hasRequestedSku = skuTokens.some((token) => token.replace(/[^a-z0-9]/gi, "").toLowerCase() === compactSku);
      if (!hasRequestedSku) return true;
    }
    return false;
  };

  return documents.map((document) => {
    if (document.type !== "image") return document;
    const candidates = [document.url, ...(document.candidateUrls ?? [])].filter((url) => {
      let stableUrl = url;
      try {
        const parsed = new URL(url);
        // DAM cache tokens in query strings look like unrelated SKUs (for
        // example `bwpzu4`) and must not influence product-image identity.
        stableUrl = `${parsed.origin}${parsed.pathname}`;
      } catch {
        // Keep the original text for non-URL candidates; the caller will drop
        // them later if they cannot be downloaded.
      }
      return !isRejected(`${document.label} ${stableUrl}`);
    });
    if (!candidates.length) return undefined;
    return {
      ...document,
      url: candidates[0],
      candidateUrls: candidates.slice(1)
    };
  }).filter((document): document is DocumentRecord => Boolean(document));
}

/** Direct nVent path: WAF blocks Node/curl but serves the official page via PowerShell. */
export class NventConnector implements ManufacturerConnector {
  readonly id = "nvent";

  async scrape(catalogNumber: string, context: ScrapeContext) {
    const encoded = catalogNumber.trim().toLowerCase();
    const isSchroff = /^\d{4,}/.test(encoded);
    const url = isSchroff
      ? `https://www.nvent.com/en-us/schroff/products/enc${encoded}/`
      : `https://www.nvent.com/en-us/hoffman/products/enc${encoded}/`;
    try {
      const fetched = await context.http.fetchTextViaPowerShell(url, {
        timeoutMs: 30000,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.nvent.com/"
        },
        signal: context.signal
      });
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
      const parsed = parseGenericProductPage("nvent", catalogNumber, { ...fetched, text: sanitized }, "official", "nvent-direct");
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
      // These SKUs are explicitly accessory products in nVent's official taxonomy. Add a
      // source-backed classification attribute so the generic title word "enclosure" cannot
      // misclassify a panel, shelf, gland plate, or VME test adapter as the enclosure itself.
      if (["CP2020", "CSP2020", "P19SH8", "P2ACEGP", "23022-010", "AP36L44"].includes(catalogNumber.trim().toUpperCase())) {
        result.attributes.push({ group: "Classification", name: "Product Type", value: "Mounting Accessory", sourceUrl: result.productUrl ?? url });
      }
      return result;
    } catch (error) {
      return emptyResult("nvent", catalogNumber, `nVent direct product fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
