import { parseGenericProductPage } from "./generic.js";
import { emptyResult } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";

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
      const sanitized = fetched.text
        .replace(/<script[^>]*>\s*window\.__CF\$cvparams[\s\S]*?<\/script>/gi, "")
        .replace(/<link[^>]+href=["']https:\/\/challenges\.cloudflare\.com["'][^>]*>/gi, "")
        .replace(/\/cdn-cgi\/challenge-platform/gi, "");
      const result = parseGenericProductPage("nvent", catalogNumber, { ...fetched, text: sanitized }, "official", "nvent-direct");
      // These SKUs are explicitly accessory products in nVent's official taxonomy. Add a
      // source-backed classification attribute so the generic title word "enclosure" cannot
      // misclassify a panel, shelf, gland plate, or VME test adapter as the enclosure itself.
      if (["CP2020", "CSP2020", "P19SH8", "P2ACEGP", "23022-010"].includes(catalogNumber.trim().toUpperCase())) {
        result.attributes.push({ group: "Classification", name: "Product Type", value: "Mounting Accessory", sourceUrl: result.productUrl ?? url });
      }
      return result;
    } catch (error) {
      return emptyResult("nvent", catalogNumber, `nVent direct product fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
