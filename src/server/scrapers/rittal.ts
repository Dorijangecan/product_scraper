import type { ProductResult } from "../../shared/types.js";
import { catalogTextMatches } from "./catalog-number.js";
import { parseGenericProductPage } from "./generic.js";
import { emptyResult } from "./normalizer.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";

/** Rittal's public order-number resolver lands on the exact localized variant PDP. */
export class RittalConnector implements ManufacturerConnector {
  readonly id = "rittal";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const orderNumber = encodeURIComponent(catalogNumber.trim());
    const resolverUrl = `https://www.rittal.com/com-en/products/show/${orderNumber}`;
    let directFailure: string | undefined;

    try {
      const fetched = await context.http.fetchText(resolverUrl, {
        timeoutMs: context.manufacturer.fetchPolicy?.timeoutMs ?? 30000,
        signal: context.signal,
        headers: {
          ...(context.manufacturer.fetchPolicy?.acceptLanguage
            ? { "accept-language": context.manufacturer.fetchPolicy.acceptLanguage }
            : {}),
          ...(context.manufacturer.fetchPolicy?.referer ? { referer: context.manufacturer.fetchPolicy.referer } : {})
        }
      });
      const effectiveUrl = new URL(fetched.effectiveUrl);
      const exactVariantUrl =
        effectiveUrl.hostname === "www.rittal.com" &&
        /\/products\/.+\/PRO[^/]+$/i.test(effectiveUrl.pathname) &&
        effectiveUrl.searchParams.get("variantId") === catalogNumber;
      const exactPageIdentity = catalogTextMatches(fetched.text, catalogNumber, context.manufacturer.match);
      if (fetched.statusCode < 400 && exactVariantUrl && exactPageIdentity) {
        const parsed = parseGenericProductPage("rittal", catalogNumber, fetched, "official", "rittal-order-resolver", {
          match: context.manufacturer.match,
          localizedUrlTemplates: context.manufacturer.localizedUrlTemplates,
          confidence: 0.88,
          markerRules: context.manufacturer.markerRules,
          extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy
        });
        if (parsed.status !== "failed" && parsed.productUrl === fetched.effectiveUrl) {
          const localizedDescriptions: NonNullable<ProductResult["localizedDescriptions"]> = {
            ...(parsed.title || parsed.description
              ? { en: { title: parsed.title, description: parsed.description } }
              : {})
          };
          const germanUrl = parsed.localizedUrls?.de;
          let germanSource: ProductResult["sources"][number] | undefined;
          if (germanUrl) {
            try {
              const german = await context.http.fetchText(germanUrl, {
                timeoutMs: context.manufacturer.fetchPolicy?.timeoutMs ?? 30000,
                maxAttempts: 1,
                signal: context.signal,
                headers: {
                  "accept-language": "de-DE,de;q=0.9,en;q=0.5",
                  ...(context.manufacturer.fetchPolicy?.referer ? { referer: context.manufacturer.fetchPolicy.referer } : {})
                }
              });
              const germanUrlIdentity = new URL(german.effectiveUrl);
              const exactGermanVariant =
                germanUrlIdentity.hostname === "www.rittal.com" &&
                /\/products\/.+\/PRO[^/]+$/i.test(germanUrlIdentity.pathname) &&
                germanUrlIdentity.searchParams.get("variantId") === catalogNumber;
              const exactGermanPageIdentity = catalogTextMatches(german.text, catalogNumber, context.manufacturer.match);
              if (german.statusCode < 400 && exactGermanVariant && exactGermanPageIdentity) {
                const parsedGerman = parseGenericProductPage("rittal", catalogNumber, german, "official", "rittal-order-resolver-de", {
                  match: context.manufacturer.match,
                  confidence: 0.88,
                  markerRules: context.manufacturer.markerRules,
                  extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy
                });
                if (parsedGerman.status !== "failed" && parsedGerman.productUrl === german.effectiveUrl) {
                  if (parsedGerman.title || parsedGerman.description) {
                    localizedDescriptions.de = { title: parsedGerman.title, description: parsedGerman.description };
                  }
                  germanSource = parsedGerman.sources.find((source) => source.url === german.effectiveUrl);
                }
              }
            } catch (error) {
              if (context.signal?.aborted) throw error;
              // The primary English PDP remains usable when the optional locale endpoint is unavailable.
            }
          }
          return {
            ...parsed,
            localizedDescriptions: Object.keys(localizedDescriptions).length ? localizedDescriptions : undefined,
            sources: germanSource ? [...parsed.sources, germanSource] : parsed.sources,
            diagnostics: {
              ...parsed.diagnostics,
              attemptedUrls: [...new Set([...(parsed.diagnostics?.attemptedUrls ?? []), resolverUrl, ...(germanUrl ? [germanUrl] : [])])],
              chosenUrl: fetched.effectiveUrl,
              notes: [
                ...(parsed.diagnostics?.notes ?? []),
                "Resolved through Rittal's exact-order-number PDP resolver.",
                ...(germanSource ? ["German description parsed from a separately fetched exact-variant Rittal PDP."] : [])
              ]
            }
          };
        }
        directFailure = parsed.error ?? "The official resolver did not yield a usable product page.";
      } else {
        directFailure = `The official resolver did not confirm exact order number ${catalogNumber}.`;
      }
    } catch (error) {
      if (context.signal?.aborted) throw error;
      directFailure = error instanceof Error ? error.message : "Official order-number resolver request failed.";
    }

    const fallback = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: "rittal" });
    if (fallback.result) {
      return {
        ...withDiscoveryFallbackDiagnostics(fallback.result, fallback.discovery),
        diagnostics: {
          ...fallback.result.diagnostics,
          attemptedUrls: [...new Set([...(fallback.result.diagnostics?.attemptedUrls ?? []), resolverUrl])],
          notes: [...(fallback.result.diagnostics?.notes ?? []), `Direct Rittal resolver fell back to discovery: ${directFailure ?? "no exact PDP"}`]
        }
      };
    }
    return withDiscoveryFallbackDiagnostics(emptyResult("rittal", catalogNumber, directFailure ?? "Rittal product page was not found."), fallback.discovery);
  }
}
