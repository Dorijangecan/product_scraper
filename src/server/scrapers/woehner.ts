import * as cheerio from "cheerio";
import type { ProductResult } from "../../shared/types.js";
import { parseGenericProductPage } from "./generic.js";
import { catalogTextMatches, fillCatalogTemplate, findCatalogTextMatch } from "./catalog-number.js";
import type { FetchedText } from "./http-client.js";
import { emptyResult } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";

const WOEHNER_PIM_HOST = "pim.woehner.de";

export class WoehnerConnector implements ManufacturerConnector {
  id = "woehner";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const searchTemplate = context.manufacturer.scrapeRecipe?.searchUrlTemplates?.[0];
    if (!searchTemplate || !context.browserRenderer) {
      return failedLookup(catalogNumber, "Wöhner PIM search is not configured with a browser renderer.");
    }

    // Wöhner's catalog number search is client-rendered: a static request returns a blank search
    // shell, while an actual browser resolves searchPattern to the PIM's internal article URL.
    const pIMSearchNumber = catalogNumber.replace(/\s+/g, "").toUpperCase();
    const searchUrl = fillCatalogTemplate(searchTemplate, pIMSearchNumber);
    let rendered = await context.browserRenderer.renderProductPage(
      searchUrl,
      context.manufacturer.scrapeRecipe,
      context.signal
    );
    let fetched = rendered.fetched;
    let productUrl = fetched && exactWoehnerProductUrl(fetched.effectiveUrl, fetched.text, catalogNumber)
      ? fetched.effectiveUrl
      : undefined;
    const lookupTrace = [lookupSummary(rendered, productUrl)];
    // The PIM's client-side search occasionally returns its transient empty shell on first load.
    // Retry the deterministic exact lookup once in a fresh render before trying the catalogue UI.
    if (!productUrl) {
      rendered = await context.browserRenderer.renderProductPage(
        searchUrl,
        context.manufacturer.scrapeRecipe,
        context.signal
      );
      fetched = rendered.fetched;
      productUrl = fetched && exactWoehnerProductUrl(fetched.effectiveUrl, fetched.text, catalogNumber)
        ? fetched.effectiveUrl
        : undefined;
      lookupTrace.push(lookupSummary(rendered, productUrl));
    }

    // Some PIM regions do not resolve searchPattern until their catalogue session is initialized.
    // Retry through the actual catalog search field; the renderer types the SKU and records the
    // final article URL after the site's own search completes.
    if (!productUrl) {
      const catalogueRoot = context.manufacturer.officialBaseUrls[0];
      if (catalogueRoot) {
        rendered = await context.browserRenderer.renderSearchPage(
          catalogueRoot,
          catalogNumber,
          context.manufacturer.scrapeRecipe,
          context.signal
        );
        fetched = rendered.fetched;
        productUrl = fetched && exactWoehnerProductUrl(fetched.effectiveUrl, fetched.text, catalogNumber)
          ? fetched.effectiveUrl
          : undefined;
        lookupTrace.push(lookupSummary(rendered, productUrl));
      }
    }

    if (!productUrl) {
      if (process.env.DEBUG_WOEHNER_LOOKUP === "1") {
        const $ = fetched ? cheerio.load(fetched.text) : undefined;
        const bodyText = $ ? $("body").text() : "";
        const skuIndex = fetched?.text.toLowerCase().indexOf(catalogNumber.replace(/\s+/g, "").toLowerCase()) ?? -1;
        console.warn("[woehner:lookup-miss]", JSON.stringify({
          searchUrl,
          attempts: lookupTrace,
          headers: $?.("h1,h2").map((_, element) => $(element).text().trim()).get().slice(0, 5),
          articleNumberMatch: fetched?.text.match(/(?:Part\s*No\.|Art\.-Nr\.?|Artikel\-Nr\.?)\s*:?\s*([^\r\n]{1,80})/i)?.[1],
          bodyContainsCatalogNumber: catalogTextMatches(bodyText, catalogNumber, { compact: true }),
          skuSnippet: skuIndex >= 0 ? fetched?.text.slice(Math.max(0, skuIndex - 240), skuIndex + 240) : undefined,
          productApi: rendered.networkTexts.filter((entry) => /\/ajax\/produkte/i.test(entry.effectiveUrl)).map((entry) => ({ url: entry.effectiveUrl, status: entry.statusCode, sample: entry.text.slice(0, 600) }))
        }));
      }
      const result = failedLookup(
        catalogNumber,
        rendered.error ?? `Wöhner PIM did not confirm an exact article page for ${catalogNumber}.`
      );
      result.diagnostics = {
        attemptedUrls: [searchUrl],
        notes: ["Wöhner searchPattern lookup requires browser-rendered PIM results; no exact article identity was confirmed."],
        terminal: { reason: "official-product-not-found", skipNetworkFallback: true }
      };
      return result;
    }

    if (!fetched || fetched.effectiveUrl !== productUrl) {
      return failedLookup(catalogNumber, `Wöhner PIM resolved ${productUrl}, but the fetched article could not be parsed with exact identity.`);
    }
    // The PIM article HTML comes from the browser-rendered session that proved the exact SKU.
    // Re-fetching its internal article URL over plain HTTP loses that session and often gets a
    // blocked/empty response, so parse the proven page directly.
    const articleFetched = exactArticleFragment(fetched, catalogNumber);
    if (!articleFetched) {
      return failedLookup(catalogNumber, `Wöhner PIM resolved ${productUrl}, but its exact article section could not be isolated.`);
    }
    const result = parseGenericProductPage(
      "woehner",
      catalogNumber,
      articleFetched,
      "official-fallback",
      "Wöhner exact PIM article",
      { match: { requireCatalogNumber: true, compact: true }, confidence: 0.96 }
    );
    if (result.status === "failed") {
      return {
        ...result,
        productUrl,
        error: `Wöhner PIM resolved ${productUrl}, but the fetched article could not be parsed with exact identity.`,
        diagnostics: {
          ...result.diagnostics,
          attemptedUrls: [searchUrl, productUrl],
          notes: [...(result.diagnostics?.notes ?? []), `Browser-confirmed PIM article parsed as ${result.status}; title=${result.title || "(empty)"}; attributes=${result.attributes.length}; documents=${result.documents.length}.`]
        }
      };
    }

    const articleDescription = exactWoehnerDescription(fetched.text, catalogNumber);
    const parsedAttributes = articleDescription
      ? [...result.attributes, {
          group: "Description",
          name: "Product description",
          value: articleDescription,
          sourceUrl: productUrl,
          sourceType: "official-fallback" as const,
          parser: "Wöhner exact PIM article",
          stage: "Wöhner exact PIM article",
          confidence: 0.96
        }]
      : result.attributes;
    const attributes = parsedAttributes.filter((attribute) =>
      !(attribute.sourceUrl === productUrl && hasForeignWoehnerArticleNumber(attribute.name, catalogNumber))
    );
    const similarImageWarning = /picture may show a similar product|photo may show a similar product/i.test(fetched?.text ?? "");
    const verifiedDocuments = similarImageWarning
      ? result.documents.filter((document) => document.type !== "image")
      : result.documents;
    const finalDocuments = verifiedDocuments.filter(isRelevantWoehnerDocument);
    const removedImages = similarImageWarning && finalDocuments.length !== result.documents.length;
    const normalized = completeWoehnerMechanicalAndElectricalFields(result.normalized, attributes, productUrl);
    return {
      ...result,
      productUrl,
      description: articleDescription ?? result.description,
      attributes,
      documents: finalDocuments,
      normalized,
      diagnostics: {
        ...result.diagnostics,
        terminal: {
          reason: "Exact Wöhner PIM article was isolated; broader fallback pages contain sibling products and can contaminate SKU-specific data.",
          skipNetworkFallback: true
        },
      ...(removedImages ? {
        notes: [...(result.diagnostics?.notes ?? []), "Removed the PIM image because this article page warns it may show a similar product."]
      } : {})
      }
    };
  }
}

function exactWoehnerDescription(html: string, catalogNumber: string): string | undefined {
  const text = cheerio.load(html).text().replace(/\s+/g, " ").trim();
  const sku = catalogNumber.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const match = text.match(new RegExp(`Part\\s*No\\.?\\s*:?\\s*${sku}\\s+(.{1,700}?)\\s+System\\b`, "i"));
  const description = match?.[1]?.trim();
  return description && !/^(?:System|Product group|Subgroup)\b/i.test(description) ? description : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasForeignWoehnerArticleNumber(text: string, catalogNumber: string): boolean {
  const exact = catalogNumber.replace(/[^\dA-Z]/gi, "").toUpperCase();
  const base = exact.replace(/000[A-Z]*$/, "");
  const matches = [...text.matchAll(/\b(\d{4,6})(?:\s*(\d{3}[A-Z]{0,2}))?\b/g)];
  return matches.some((match) => {
    const found = `${match[1]}${match[2] ?? ""}`.toUpperCase();
    return found !== exact && found !== base;
  });
}

function isRelevantWoehnerDocument(document: ProductResult["documents"][number]): boolean {
  if (/^(?:general technical information|product description\s*\(pdf\))$/i.test(document.label.trim())) return false;
  try {
    return new URL(document.url).pathname.split("/").includes("download");
  } catch {
    return false;
  }
}

function completeWoehnerMechanicalAndElectricalFields(
  normalized: ProductResult["normalized"],
  attributes: ProductResult["attributes"],
  productUrl: string
): ProductResult["normalized"] {
  const isExactArticleEvidence = (attribute: ProductResult["attributes"][number]) =>
    attribute.sourceUrl === productUrl &&
    (attribute.sourceType === "official" || attribute.sourceType === "official-fallback");
  const minInput = attributes.find((attribute) =>
    isExactArticleEvidence(attribute) && /^(?:min\.?\s*)?operating voltage AC:?$/i.test(attribute.name.trim())
  )?.value.trim();
  const ratedInput = attributes.find((attribute) =>
    isExactArticleEvidence(attribute) && /^rated voltage \(IEC\) AC:?$/i.test(attribute.name.trim())
  )?.value.trim();
  const output = attributes.find((attribute) =>
    isExactArticleEvidence(attribute) && /^output voltage DC:?$/i.test(attribute.name.trim())
  )?.value.trim();
  const low = minInput?.match(/[\d.,]+\s*V/i)?.[0];
  const high = ratedInput?.match(/[\d.,]+\s*V/i)?.[0];
  const dc = output?.match(/[\d.,]+\s*V/i)?.[0];
  const updated = { ...normalized };
  if (low && high && dc) updated.voltage = `${low}–${high} AC input / ${dc} DC output`;

  const hasProductMaterial = attributes.some((attribute) =>
    isExactArticleEvidence(attribute) &&
    /^material:?$/i.test(attribute.name.trim()) &&
    /^(?:table|mechanical data|material properties)$/i.test(attribute.group?.trim() ?? "") &&
    !hasForeignWoehnerArticleNumber(attribute.name, "")
  );
  if (!hasProductMaterial) delete updated.material;
  const hasRatedOperatingCurrent = attributes.some((attribute) =>
    isExactArticleEvidence(attribute) && /^(?:rated current(?: \((?:IEC|UL)\))?|output current|prim\.?\s*rated current Ipr):?$/i.test(attribute.name.trim())
  );
  if (!hasRatedOperatingCurrent) delete updated.current;

  const primaryCurrent = attributes.find((attribute) =>
    isExactArticleEvidence(attribute) && /^prim\.?\s*rated current Ipr:?$/i.test(attribute.name.trim())
  )?.value.trim();
  const secondaryCurrent = attributes.find((attribute) =>
    isExactArticleEvidence(attribute) && /^sec\.?\s*rated current:?$/i.test(attribute.name.trim())
  )?.value.trim();
  if (primaryCurrent && secondaryCurrent) {
    updated.current = `${primaryCurrent} primary / ${secondaryCurrent} secondary`;
  }

  // Wöhner's busbar descriptions can mention copper lamella and busbar thicknesses in the same
  // article. They are not enclosure wall thicknesses, so only keep that normalized field when the
  // exact article labels a value as wall/sheet/body thickness.
  const hasActualWallThickness = attributes.some((attribute) =>
    isExactArticleEvidence(attribute) && /\b(?:wall|sheet|body)\s+thickness\b/i.test(attribute.name)
  );
  if (!hasActualWallThickness) delete updated.wallThickness;

  // PIM's ambient-temperature note may say installation is permitted only above a threshold.
  // That threshold is not the device's maximum operating temperature.
  const installationThreshold = attributes.find((attribute) =>
    isExactArticleEvidence(attribute) &&
    /^(?:min\.\s*)?permitted ambient temperature:?$/i.test(attribute.name.trim())
  )?.value;
  if (installationThreshold && /installation only at temperatures\s*>\s*[-+\d.,]+\s*°?C/i.test(installationThreshold)) {
    delete updated.operatingTemperatureMax;
  }

  const dimensions = attributes.find((attribute) =>
    isExactArticleEvidence(attribute) && /^W\s*x\s*H\s*x\s*D:?$/i.test(attribute.name.trim())
  )?.value;
  const match = dimensions?.match(/^\s*([\d.,]+)\s*x\s*([\d.,]+)\s*x\s*([\d.,]+)\s*$/i);
  if (match) updated.dimensions = `${match[1]} × ${match[2]} × ${match[3]} mm (W × H × D)`;
  return updated;
}

function exactWoehnerProductUrl(url: string, html: string, catalogNumber: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== WOEHNER_PIM_HOST || /suchergebnis/i.test(parsed.pathname)) return false;
    const $ = cheerio.load(html);
    const title = [$("h1").first().text(), $("title").text()].join(" ");
    const articleNumber = $("body").text().match(/(?:Part\s*No\.|Art\.-Nr\.?|Artikel\-Nr\.?)\s*:?\s*([^\r\n]{1,80})/i)?.[1] ?? "";
    const headingMatches = findCatalogTextMatch(title, catalogNumber, { compact: true })?.level === "exact";
    const bodyMatches = findCatalogTextMatch($("body").text(), catalogNumber, { compact: true })?.level === "exact";
    if (process.env.DEBUG_WOEHNER_LOOKUP === "1") {
      console.warn("[woehner:identity-check]", JSON.stringify({ url, title: title.trim(), articleNumber, headingMatches, bodyMatches }));
    }
    return headingMatches || bodyMatches;
  } catch {
    return false;
  }
}

function exactArticleFragment(fetched: FetchedText, catalogNumber: string): FetchedText | undefined {
  const $ = cheerio.load(fetched.text);
  const heading = $("h1").first();
  if (!heading.length || findCatalogTextMatch(heading.text(), catalogNumber, { compact: true })?.level !== "exact") {
    return undefined;
  }
  // Wöhner's PIM puts a product's description, approvals, technical data, links, image gallery, and
  // downloads in the level-2 article wrapper. Sibling wrappers hold related products, navigation,
  // broad family manuals and regional links; passing the whole page to the generic parser polluted
  // exact-device fields and documents with those siblings.
  const article = heading.closest(".boxgroup-wrapper.linearize-level-2");
  if (!article.length) return undefined;
  return { ...fetched, text: $.html(article) };
}

function failedLookup(catalogNumber: string, message: string): ProductResult {
  return emptyResult("woehner", catalogNumber, message);
}

function lookupSummary(rendered: { fetched?: { effectiveUrl: string }; error?: string }, productUrl?: string): Record<string, string | undefined> {
  return { effectiveUrl: rendered.fetched?.effectiveUrl, error: rendered.error, confirmedUrl: productUrl };
}
