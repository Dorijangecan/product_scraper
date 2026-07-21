import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { dedupeAttributes, dedupeDocuments, dedupeSources } from "./dedupe.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";
import type { FetchedText } from "./http-client.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { cleanText, emptyResult, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";

const GAN_PARSER = "gan-ganternorm";
const GAN_PARSER_VERSION = "gan-v1";
const GAN_BASE = "https://www.ganternorm.com";
// The quick-finder resolves a bare family number ("GN 449.5") straight to the family's product
// page (a redirect, no search step visible to the caller). It does NOT index full ordering codes
// with a variant suffix ("GN 449.5-61-SC") — that string comes back "No hits" — so the family
// number is always tried as a fallback candidate even when the caller passed a longer code.
const GAN_QUICKFINDER_URL = `${GAN_BASE}/en/products/quick-finder?q={query}`;
// Ganter's own standards ("GN ...") plus the DIN/ISO/EN/VDI standard parts it also distributes
// under the same catalog. Anything else is passed through unchanged as a last-ditch literal query.
const GAN_FAMILY_PATTERN = /^\s*(GN|DIN|ISO|EN|VDI)\s*[-\s]?\s*(\d+(?:[.,]\d+)?)/i;
// Same token, not anchored to the start — used to read a family code back out of a search-result
// hit's link text ("NEW GN 422 Cabinet U-Handles...").
const GAN_FAMILY_PATTERN_ANYWHERE = /(GN|DIN|ISO|EN|VDI)\s*[-\s]?\s*(\d+(?:[.,]\d+)?)/i;

export class GanterNormConnector implements ManufacturerConnector {
  readonly id = "gan";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const attemptedUrls: string[] = [];

    for (const query of ganterSearchCandidates(catalogNumber)) {
      const url = GAN_QUICKFINDER_URL.replace("{query}", encodeURIComponent(query));
      attemptedUrls.push(url);
      try {
        const fetched = await fetchGanterText(url, context);
        const $ = cheerio.load(fetched.text);
        if ($("h1 .product-name__id").first().text().trim()) return parseGanterProductPage(catalogNumber, fetched, $);

        // Some family numbers ("GN 422") are a prefix shared by more than one distinct catalog
        // family ("GN 422", "GN 422.1", ...) — quick-finder answers with a disambiguation list
        // instead of redirecting. When exactly one listed hit's own family code is an EXACT match
        // for what we searched, that's an unambiguous resolution; two or more (Ganter itself
        // sometimes lists more than one distinct family under the identical displayed code) means
        // there is no reliable way to know which one the catalog number meant, so it's left alone
        // rather than guessed.
        const resolvedHref = uniqueExactFamilyHit($, query);
        if (resolvedHref) {
          const hitUrl = new URL(resolvedHref, fetched.effectiveUrl).toString();
          attemptedUrls.push(hitUrl);
          const hitFetched = await fetchGanterText(hitUrl, context);
          const $hit = cheerio.load(hitFetched.text);
          if ($hit("h1 .product-name__id").first().text().trim()) return parseGanterProductPage(catalogNumber, hitFetched, $hit);
        }
      } catch {
        // Try the next candidate query (full code, then family-only).
      }
    }

    const { result: fallback, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: this.id });
    const result = fallback ?? emptyResult("gan", catalogNumber, `Ganter Norm quick-finder did not resolve a product page for ${catalogNumber}.`);
    return withDiscoveryFallbackDiagnostics(
      {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          attemptedUrls: [...new Set([...(result.diagnostics?.attemptedUrls ?? []), ...attemptedUrls])]
        }
      },
      discovery
    );
  }
}

/**
 * Tries the catalog number exactly as given first (harmless if it 404s the same way), then falls
 * back to the bare family number ("GN 449.5-61-SC" → "GN 449.5") since quick-finder only indexes
 * families, not full variant codes.
 */
export function ganterSearchCandidates(catalogNumber: string): string[] {
  const trimmed = catalogNumber.trim();
  const family = extractGanterFamily(trimmed);
  // The quick-finder indexes the family page, not individual ordering-code variants.  Querying
  // the full code first creates a different cache key for every row in a large BOM even though
  // Ganter redirects all of them to the same family page.  Put the family first so GN 422-…
  // batches share one official fetch; retain the literal code as a safe fallback for standards
  // whose suffix may eventually become individually searchable.
  const candidates = family && family.family.toUpperCase() !== trimmed.toUpperCase() ? [family.family, trimmed] : [trimmed];
  return [...new Set(candidates)].filter(Boolean);
}

export interface GanterFamily {
  prefix: string;
  number: string;
  family: string;
  matchedLength: number;
}

export function extractGanterFamily(catalogNumber: string): GanterFamily | undefined {
  const match = catalogNumber.match(GAN_FAMILY_PATTERN);
  if (!match) return undefined;
  const prefix = match[1].toUpperCase();
  const number = match[2].replace(",", ".");
  return { prefix, number, family: `${prefix} ${number}`, matchedLength: match[0].length };
}

/**
 * Scans a quick-finder disambiguation page's result links for ones whose OWN family code (read
 * back out of the link text) exactly matches the family we searched for, and returns its href only
 * when that match is unique. Two hits can legitimately share the identical displayed family code
 * (Ganter itself lists two distinct "GN 422" catalog entries side by side) — that case must return
 * undefined so the caller falls back rather than picking one arbitrarily.
 */
function uniqueExactFamilyHit($: cheerio.CheerioAPI, query: string): string | undefined {
  const targetFamily = extractGanterFamily(query)?.family.toUpperCase() ?? query.trim().toUpperCase();
  const hrefs = new Set<string>();
  $("a[href*='/en/products/']").each((_, a) => {
    const $a = $(a);
    const text = cleanText($a.text());
    const href = $a.attr("href");
    if (!text || !href) return;
    const match = text.match(GAN_FAMILY_PATTERN_ANYWHERE);
    if (!match) return;
    const family = `${match[1].toUpperCase()} ${match[2].replace(",", ".")}`;
    if (family === targetFamily) hrefs.add(href);
  });
  return hrefs.size === 1 ? [...hrefs][0] : undefined;
}

/** Tokens after the family portion of the catalog number — e.g. "61", "SC" for "GN 449.5-61-SC". */
export function ganterVariantTokens(catalogNumber: string, family: GanterFamily | undefined): string[] {
  if (!family) return [];
  return catalogNumber
    .slice(family.matchedLength)
    .split(/[^a-z0-9.]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function parseGanterProductPage(catalogNumber: string, fetched: FetchedText, $: cheerio.CheerioAPI): ProductResult {
  const sourceUrl = fetched.effectiveUrl;
  const familyCode = cleanText($("h1 .product-name__id").first().text());
  const productLabel = cleanText($("h1 .product-name__label").first().text());
  const title = [familyCode, productLabel].filter(Boolean).join(" ") || familyCode || catalogNumber;

  const family = extractGanterFamily(catalogNumber);
  const variantTokens = ganterVariantTokens(catalogNumber, family).map((token) => token.toLowerCase());

  const descriptionContainer = $(".product-description__content[itemprop='description']").first();
  const { description, specAttributes } = parseGanterDescriptionBlock($, descriptionContainer, sourceUrl, variantTokens);
  const quickFactAttributes = parseGanterQuickFacts($, sourceUrl);
  const category = ganterBreadcrumbCategory($);
  const typeAttribute = ganterTypeAttribute($, sourceUrl, variantTokens);
  const { attributes: dimensionAttributes, resolved: dimensionResolved, ambiguous: dimensionAmbiguous } =
    parseGanterDimensionTable($, sourceUrl, variantTokens);

  // A multi-row dimension table we couldn't confidently resolve to one variant means the
  // family-level Weight fact (rendered for whichever variant the page defaults to) cannot be
  // trusted for the specific catalog number requested — dropping it beats attaching another
  // variant's weight (the exact cross-model contamination this codebase has repeatedly had to
  // fix for other manufacturers' variant tables).
  const suppressWeight = dimensionAmbiguous;
  const filteredQuickFacts = suppressWeight
    ? quickFactAttributes.filter((attribute) => !/weight/i.test(attribute.name))
    : quickFactAttributes;

  const attributes = dedupeAttributes([
    // The page's own text never contains the customer's full ordering code verbatim (only the
    // bare family, e.g. "GN 6336" for a request of "GN 6336-32") — without this self-referential
    // fact, the shared quality-gate identity check (product-identity.ts) has no "Catalog Number"
    // evidence to match against and rejects an otherwise correctly-resolved row as unidentified,
    // exactly the gap Doepke's connector fixes the same way for its own article numbers.
    ganterAttribute("Ganter Norm", "Catalog Number", catalogNumber, sourceUrl, 0.9),
    ...specAttributes,
    ...filteredQuickFacts,
    ...(typeAttribute ? [typeAttribute] : []),
    ...dimensionAttributes,
    ...(category
      ? [
          {
            group: "Ganter Norm",
            name: "Product Category",
            value: category,
            sourceUrl,
            sourceType: "official" as const,
            parser: GAN_PARSER,
            stage: GAN_PARSER,
            confidence: 0.7
          }
        ]
      : [])
  ]);
  const documents = dedupeDocuments(ganterDocuments($, sourceUrl));
  const normalized = normalizeFields(attributes, documents);

  const identityResolved = !family || variantTokens.length === 0 || dimensionResolved;
  const confidence = identityResolved ? 0.85 : 0.65;

  return {
    manufacturerId: "gan",
    catalogNumber,
    status: attributes.length || documents.length ? "found" : "partial",
    confidence,
    productUrl: sourceUrl,
    localizedUrls: buildLocalizedProductUrls("gan", catalogNumber, sourceUrl),
    title,
    description,
    normalized,
    attributes,
    documents,
    sources: dedupeSources([ganterSource(fetched)]),
    diagnostics: {
      chosenUrl: sourceUrl,
      ...(dimensionAmbiguous
        ? {
            notes: [
              `Ganter Norm family "${familyCode}" has multiple dimension variants; could not resolve the exact row for "${catalogNumber}", so per-variant dimensions and weight were left blank instead of guessing.`
            ]
          }
        : {})
    }
  };
}

/**
 * `.product-description__content` holds free-text description paragraphs, then an
 * `<h3>Specification</h3>` heading, then the material breakdown. Two distinct `<p>` shapes exist:
 * a plain-text component name ("Latch / Catch") followed by its material as trailing text, and a
 * bare material declaration where the `<strong>` itself wraps an `<span class="auspraegung">name
 * </span><span class="kuerzel">CODE</span>` pair with no separate label (confirmed on GN 422.1:
 * `<p><strong><span auspraegung>Aluminum die casting</span><span kuerzel>AL</span></strong><br>
 * Powder coated</p>` — no "component name" precedes it, so it's read as the product's own Material).
 * `<ul><li>` runs are handled by {@link parseGanterOptionsList}. Everything is one flat sibling
 * run (no wrapping section per component), so a single pass over child nodes tracking which side
 * of the heading we're on is simpler and more reliable than nested selectors.
 */
function parseGanterDescriptionBlock(
  $: cheerio.CheerioAPI,
  container: cheerio.Cheerio<any>,
  sourceUrl: string,
  variantTokens: string[]
): { description?: string; specAttributes: AttributeRecord[] } {
  if (!container.length) return { specAttributes: [] };

  const descriptionParts: string[] = [];
  const specAttributes: AttributeRecord[] = [];
  let inSpec = false;

  for (const node of container.contents().toArray()) {
    if (node.type === "text") {
      if (!inSpec) {
        const text = cleanText(node.data ?? "");
        if (text) descriptionParts.push(text);
      }
      continue;
    }
    if (node.type !== "tag") continue;
    const $node = $(node);
    const tag = node.name.toLowerCase();

    if (tag === "h3") {
      // Any OTHER heading after "Specification" (GN 7440 has a trailing "On request" section with
      // optional-order-alternative prose, e.g. "Seal of NBR or EPDM") ends the spec block — without
      // this, its plain, br-less paragraph reads as a second "Material" fact and silently overwrites
      // the real one.
      inSpec = /specification/i.test($node.text());
      continue;
    }
    if (!inSpec) {
      if (tag === "p") {
        const text = cleanText($node.text());
        if (text) descriptionParts.push(text);
      }
      continue;
    }

    if (tag === "p") {
      const strong = $node.find("strong").first();
      const hasKeyOption = strong.find(".auspraegung, .kuerzel").length > 0;
      if (hasKeyOption) {
        // The material NAME can carry a stray unstyled span alongside `.auspraegung` (confirmed on
        // GN 6336: "<span auspraegung>Stainless steel precision casting</span><span style=\"font-
        // weight:normal\"> AISI 316</span><span kuerzel>A4</span>") — reading everything in
        // `strong` except `.kuerzel` (rather than `.auspraegung` alone) keeps that qualifier text
        // instead of silently dropping it.
        const kuerzel = cleanText(strong.find(".kuerzel").text());
        const materialName = cleanText(strong.clone().find(".kuerzel").remove().end().text());
        const materialValue = optionValue(materialName, kuerzel);

        // The content after `<br>` is either plain text (GN 422.1: "Powder coated" — a processing
        // note, appended to the Material fact) or its OWN auspraegung/kuerzel pair (GN 6336:
        // "Polished (PL)" — an unambiguous single Finish fact, not a `<ul>` list of alternatives).
        const trailing = $node.clone();
        trailing.find("strong").first().remove();
        const trailingKuerzel = cleanText(trailing.find(".kuerzel").first().text());
        const trailingAuspraegung = cleanText(trailing.clone().find(".kuerzel").remove().end().text());
        const trailingOption = trailingKuerzel ? optionValue(trailingAuspraegung, trailingKuerzel) : undefined;
        const trailingPlainText = trailingOption ? undefined : trailingAuspraegung;

        const materialText = [materialValue, trailingPlainText].filter(Boolean).join(", ");
        if (materialText) specAttributes.push(ganterAttribute("Ganter Specification", "Material", materialText, sourceUrl, 0.85));
        if (trailingOption) specAttributes.push(ganterAttribute("Ganter Specification", "Finish", trailingOption, sourceUrl, 0.85));
        continue;
      }
      const hasBreak = $node.find("br").length > 0;
      if (!hasBreak) {
        const whole = cleanText($node.text());
        if (!whole || /^rohs$/i.test(whole)) continue;
        // Some br-less spec paragraphs are self-labeled non-material facts sharing the same flat
        // shape, most commonly the operating-temperature line ("Operating temperature -20 °C to
        // +50 °C" on GN 6284 and siblings). Treating those as "Material" both mislabels them and
        // masks the real material; record them under their own label so the ontology maps them to
        // the correct normalized field instead.
        const tempMatch = whole.match(/^operating\s+temperature\b[:\s]*(.+)$/i);
        if (tempMatch) {
          const value = cleanText(tempMatch[1]) || whole;
          specAttributes.push(ganterAttribute("Ganter Specification", "Operating temperature", value, sourceUrl, 0.85));
          continue;
        }
        // Otherwise the whole paragraph is one continuous phrase describing the base material, not a
        // label:value pair (confirmed on GN 719: "<p><strong>Plastic</strong>, phenolic resin
        // (PF)</p>" reads as "Plastic, phenolic resin (PF)"; splitting on </strong> previously
        // produced a garbled name="Plastic" / value=", phenolic resin (PF)").
        specAttributes.push(ganterAttribute("Ganter Specification", "Material", whole, sourceUrl, 0.85));
        continue;
      }
      const trailingText = cleanText($node.clone().find("strong").remove().end().text());
      const label = cleanText(strong.text());
      if (!label || /^rohs$/i.test(label)) continue;
      if (trailingText) specAttributes.push(ganterAttribute("Ganter Specification", label, trailingText, sourceUrl, 0.85));
    } else if (tag === "ul") {
      specAttributes.push(...parseGanterOptionsList($, $node, sourceUrl, variantTokens));
    }
  }

  return { description: cleanText(descriptionParts.join(" ")) || undefined, specAttributes };
}

/**
 * A `<ul><li>` run under "Specification" mixes two shapes: labeled sub-component rows (each `<li>`
 * has its own plain-text name before the auspraegung/kuerzel pair, e.g. "Housing collar / Mounting
 * ring..." on GN 449.5 — unambiguous, attached directly) and unlabeled options rows — alternative
 * finish choices for the SAME field with no name at all (e.g. GN 422.1's "Black, RAL 9005 (SW)" vs
 * "Silver, RAL 9006 (SR)", confirmed live). Unlabeled rows are only surfaced as the
 * normalizer-visible "Finish" fact when there's exactly one (no ambiguity) or a variant token from
 * the catalog number picks exactly one of several — otherwise every option is real evidence but
 * which one the requested catalog number actually is remains unknown, so they're recorded under a
 * name that avoids the standalone word "finish" (so normalizeFields' finish matcher can't pick one
 * at random from an unresolved list).
 */
function parseGanterOptionsList(
  $: cheerio.CheerioAPI,
  $ul: cheerio.Cheerio<any>,
  sourceUrl: string,
  variantTokens: string[]
): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const unlabeled: Array<{ auspraegung: string; kuerzel: string }> = [];

  // Only direct <li> children — a nested <ul> (GN 7440's "Sight glass"/"Seals" sub-option lists)
  // is handled explicitly below, not flattened in here as if it were a sibling row.
  $ul.children("li").each((_, li) => {
    const $li = $(li);
    const auspraegung = cleanText($li.find(".auspraegung").first().text());
    const kuerzel = cleanText($li.find(".kuerzel").first().text());
    const label = cleanText($li.clone().find(".auspraegung, .kuerzel, ul").remove().end().text());
    if (auspraegung || kuerzel) {
      if (label) {
        const value = [auspraegung, kuerzel].filter(Boolean).join(" ");
        if (value) attributes.push(ganterAttribute("Ganter Specification", label, value, sourceUrl, 0.85));
      } else {
        unlabeled.push({ auspraegung, kuerzel });
      }
      return;
    }

    // No auspraegung/kuerzel spans at all: a plain "Label<br>Value" row (GN 7440's "Body" shape),
    // optionally followed by a nested <ul> of sub-facts ("Sight glass" → Metal-fused/Shrink-fit,
    // "Seals" → two alternative sealing materials) instead of a flat value.
    const ownText = ganterListItemOwnText($li);
    const [ownLabel, ...ownRest] = ownText.split(" | ");
    const directValue = ownRest.join(" | ");
    const nestedItems = $li.children("ul").children("li");
    if (nestedItems.length) {
      const subTexts = nestedItems.toArray().map((sub) => ganterListItemOwnText($(sub)).replace(" | ", ": "));
      const combined = [directValue, ...subTexts].filter(Boolean).join("; ");
      if (ownLabel && combined) attributes.push(ganterAttribute("Ganter Specification", ownLabel, combined, sourceUrl, 0.8));
      return;
    }
    if (ownLabel && directValue) attributes.push(ganterAttribute("Ganter Specification", ownLabel, directValue, sourceUrl, 0.85));
  });

  if (!unlabeled.length) return attributes;
  if (unlabeled.length === 1) {
    const value = optionValue(unlabeled[0].auspraegung, unlabeled[0].kuerzel);
    if (value) attributes.push(ganterAttribute("Ganter Specification", "Finish", value, sourceUrl, 0.85));
    return attributes;
  }

  const resolved = unlabeled.find((option) => option.kuerzel && variantTokens.includes(option.kuerzel.toLowerCase()));
  if (resolved) {
    const value = optionValue(resolved.auspraegung, resolved.kuerzel);
    if (value) attributes.push(ganterAttribute("Ganter Specification", "Finish", value, sourceUrl, 0.9));
    return attributes;
  }

  // Name deliberately avoids "finish"/"finishes" and every other word normalizeFields' finish
  // matcher (FIELD_LABEL_PATTERNS.finish, plus deriveFinishFromAttributes' broader label gate:
  // application/construction/finish/feature/detail/material/housing/body/enclosure) keys off —
  // an unresolved multi-option list must not read as a confident single Finish fact.
  const combined = unlabeled.map((option) => optionValue(option.auspraegung, option.kuerzel)).filter(Boolean).join("; ");
  if (combined) attributes.push(ganterAttribute("Ganter Specification", "Unresolved Selectable Variants", combined, sourceUrl, 0.6));
  return attributes;
}

/** A `<li>`'s own text, excluding any nested `<ul>`, with `<br>` line breaks turned into " | ". */
function ganterListItemOwnText($li: cheerio.Cheerio<any>): string {
  const clone = $li.clone();
  clone.find("ul").remove();
  clone.find("br").replaceWith(" | ");
  return cleanText(clone.text());
}

function optionValue(auspraegung: string, kuerzel: string): string {
  if (auspraegung && kuerzel) return `${auspraegung} (${kuerzel})`;
  return auspraegung || kuerzel;
}

/**
 * `#zusatz-info` holds a fixed set of `<details><summary>Label: Value</summary>...</details>`
 * rows (Weight, RoHS) plus at least one row whose value sits in the sibling `.toggle__unit` div
 * instead of the summary text (Customs tariff number). Both shapes are handled generically so any
 * future row Ganter adds here is still captured.
 */
function parseGanterQuickFacts($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $("#zusatz-info > details").each((_, details) => {
    const $details = $(details);
    const summaryText = cleanText($details.find("> summary").first().text());
    if (!summaryText) return;
    const colonMatch = summaryText.match(/^([^:]{2,60}):\s*(.+)$/);
    const name = colonMatch ? cleanText(colonMatch[1]) : summaryText;
    const value = colonMatch ? cleanText(colonMatch[2]) : cleanText($details.find("> .toggle__unit").first().text());
    if (!name || !value) return;
    attributes.push(ganterAttribute("Ganter Norm", name, value, sourceUrl, 0.88));
  });
  return attributes;
}

/**
 * The small legend table just above the dimension table (`<h3>Type</h3><table>` with rows like
 * `OS | Without lock`, `SC | With lock (same lock)`) maps a type code that may appear as a suffix
 * token on the catalog number to its plain-language meaning.
 */
function ganterTypeAttribute($: cheerio.CheerioAPI, sourceUrl: string, variantTokens: string[]): AttributeRecord | undefined {
  const heading = $("#product-table h3").filter((_, h) => /^type$/i.test(cleanText($(h).text()))).first();
  if (!heading.length) return undefined;
  const table = heading.next("table");
  if (!table.length) return undefined;

  const legend = new Map<string, string>();
  table.find("tr").each((_, tr) => {
    const cells = $(tr).find("td");
    const code = cleanText(cells.first().text());
    const meaning = cleanText(cells.eq(1).text());
    if (code && meaning) legend.set(code.toLowerCase(), meaning);
  });

  const matchedToken = variantTokens.find((token) => legend.has(token));
  if (!matchedToken) return undefined;
  const code = [...legend.keys()].find((key) => key === matchedToken)!;
  return ganterAttribute("Ganter Norm", "Type", `${code.toUpperCase()} - ${legend.get(code)}`, sourceUrl, 0.85);
}

/**
 * `#product-table table.priority-table` is the "Article options / Table" dimension grid: one
 * header row (symbolic column ids like d1, s, b, l1...) and one data row per nominal-size variant.
 * A hidden `.priority-table__filters` row full of per-column `<select>` filters shares the same
 * `<tbody>` and must be excluded. When more than one data row exists, a variant token from the
 * catalog number (typically the nominal size) must uniquely match the first column before any row
 * is attached — otherwise we cannot tell which row the requested catalog number actually is.
 */
function parseGanterDimensionTable(
  $: cheerio.CheerioAPI,
  sourceUrl: string,
  variantTokens: string[]
): { attributes: AttributeRecord[]; resolved: boolean; ambiguous: boolean } {
  const table = $("#product-table table.priority-table").first();
  if (!table.length) return { attributes: [], resolved: true, ambiguous: false };

  const headers = table
    .find("thead th")
    .toArray()
    .map((th) => {
      const $th = $(th).clone();
      $th.find("br").replaceWith(" ");
      $th.find("sub, sup").each((_, sub) => {
        $(sub).replaceWith($(sub).text());
      });
      return cleanText($th.text());
    });

  const dataRows = table
    .find("tbody > tr")
    .toArray()
    .filter((tr) => !$(tr).hasClass("priority-table__filters") && $(tr).find("select").length === 0);

  if (!dataRows.length) return { attributes: [], resolved: true, ambiguous: false };

  let chosenRow = dataRows[0];
  if (dataRows.length > 1) {
    const matches = dataRows.filter((tr) => {
      const firstCell = cleanText($(tr).find("td").first().text()).toLowerCase();
      return firstCell !== "" && variantTokens.includes(firstCell);
    });
    if (matches.length !== 1) return { attributes: [], resolved: false, ambiguous: true };
    chosenRow = matches[0];
  }

  const attributes: AttributeRecord[] = [];
  $(chosenRow)
    .find("td")
    .each((columnIndex, cell) => {
      const header = headers[columnIndex];
      const value = cleanText($(cell).text());
      if (!header || !value) return;
      // Group name deliberately avoids the word "dimensions": normalizeFields' combined-dimensions
      // matcher keys off that word appearing anywhere in group+name, and would otherwise treat a
      // single symbolic column like "d1: 61" as a candidate overall product dimensions string.
      attributes.push(ganterAttribute("Ganter Geometry", header, value, sourceUrl, 0.8));
    });

  return { attributes, resolved: true, ambiguous: false };
}

function ganterBreadcrumbCategory($: cheerio.CheerioAPI): string | undefined {
  const items = $("nav.breadcrumbs [itemprop='name']").toArray();
  if (items.length < 2) return undefined;
  return cleanText($(items[items.length - 2]).text()) || undefined;
}

/**
 * The primary per-family PDF ("Standard sheet GN ...") is the per-article datasheet; the
 * "... Characteristics" material-properties PDF (e.g. "Stainless Steel Characteristics") is a
 * shared boilerplate sheet reused across every stainless-steel product family, so it is kept as
 * "other" rather than "datasheet" to avoid document-enrichment mixing generic material trivia into
 * per-article facts (the same reasoning Doepke's shared derating-curve bulletins use).
 *
 * Every Ganter PDF is marked `enrichable: false` — the link is kept, downloaded and offered to the
 * user, but no attributes are mined from it. Ganter's PDFs are multi-variant, multi-language print
 * catalogs (a single "standard sheet" tables every nominal size AND cross-references sibling
 * families, with EN/DE/FR/IT columns side by side). Extracting them yields hundreds of cross-variant,
 * cross-language garbage attributes ("current: Cavo 4 A", "protection: IP67, voir tableau",
 * "voltage: 24 V / 24 V / 120 V / 12 V") that overwrite the clean, variant-resolved facts the
 * structured web product page already provides. For Ganter the web page — not the PDF — is the
 * source of truth (deterministic principle: a corrupted guess is worse than a blank field).
 */
export function ganterDocuments($: cheerio.CheerioAPI, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  const seen = new Set<string>();

  $("a.cta--pdf").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    const url = absoluteGanterUrl(href, sourceUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    // Each link's inline SVG icon carries its own <style> tag; cheerio's .text() walks into it and
    // prepends the raw CSS rule text ("Standard sheet GN 449.5" became ".cls-1, .cls-2 { fill:
    // #4e4e4d; } ... Standard sheet GN 449.5"), which silently defeated the "^standard sheet"
    // datasheet-type check below on every single fixture.
    const label = cleanText($a.clone().find("style").remove().end().text()) || "Ganter document";
    const type = /^standard sheet\b/i.test(label)
      ? "datasheet"
      : /^operat(?:ing|ion) instruction\b/i.test(label)
        ? "manual"
        : "other";
    documents.push({ type, label, url, sourceUrl, enrichable: false });
  });

  $("img.product-technical-drawing__image").each((_, img) => {
    const src = $(img).attr("src");
    const url = absoluteGanterUrl(src, sourceUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const isPhoto = /\.jpe?g(?:[?#]|$)/i.test(url);
    documents.push({ type: isPhoto ? "image" : "other", label: isPhoto ? "Product image" : "Technical drawing (sketch)", url, sourceUrl });
  });

  return documents;
}

function ganterAttribute(group: string, name: string, value: string, sourceUrl: string, confidence: number): AttributeRecord {
  return { group, name, value, sourceUrl, sourceType: "official", parser: GAN_PARSER, stage: GAN_PARSER, confidence };
}

function absoluteGanterUrl(rawUrl: string | undefined, baseUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl, baseUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function ganterSource(fetched: FetchedText): SourceRecord {
  return {
    url: fetched.effectiveUrl,
    sourceType: "official",
    parser: GAN_PARSER,
    parserVersion: GAN_PARSER_VERSION,
    stage: GAN_PARSER,
    reason: "Ganter Norm quick-finder resolved a product family page.",
    fetchedAt: fetched.fetchedAt,
    statusCode: fetched.statusCode
  };
}

async function fetchGanterText(url: string, context: ScrapeContext): Promise<FetchedText> {
  const policy = context.manufacturer.fetchPolicy ?? {};
  return context.http.fetchText(url, {
    timeoutMs: policy.timeoutMs ?? 15000,
    maxAttempts: policy.maxAttempts ?? 1,
    retryBackoffMs: policy.retryBackoffMs,
    cacheTtlMs: policy.cacheTtlMs,
    headers: {
      ...(policy.acceptLanguage ? { "accept-language": policy.acceptLanguage } : {}),
      ...(policy.referer ? { referer: policy.referer } : {}),
      ...(policy.userAgent ? { "user-agent": policy.userAgent } : {})
    },
    signal: context.signal
  });
}
