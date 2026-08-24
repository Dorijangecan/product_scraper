import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { compactCatalogNumber } from "./catalog-number.js";
import { cleanText } from "./normalizer.js";

export type HtmlPageLevel = "product" | "family";

export interface HtmlPageLevelResult {
  pageLevel: HtmlPageLevel;
  /** Distinct catalog codes that prove the page describes more than one selectable model. */
  siblingCatalogNumbers: string[];
}

// Unlike PDF text, HTML often keeps an ordering number in a hidden option list. Preserve a decimal
// option suffix (`...,5`) as part of the code rather than splitting it into a false sibling.
const HTML_CATALOG_LIKE = /\b[A-Z]{2,}[A-Z0-9]*(?:\s+\d{2,})?(?:[-:/.][A-Z0-9]+)+(?:,[A-Z0-9]+)?\b/gi;

/**
 * Distinguishes a real single-product HTML page from a selectable family page.
 *
 * A product detail page may still contain a product selector. It is therefore intentionally a
 * `family` page even when it also exposes one selected SKU: broad DOM/text sweeps are not allowed
 * to treat a family-wide value as a property of that SKU. A table or product microdata reader can
 * opt back in by proving a value belongs to the requested variant.
 */
export function classifyHtmlPageLevel($: cheerio.CheerioAPI, catalogNumber: string): HtmlPageLevelResult {
  const compactTarget = compactCatalogNumber(catalogNumber);
  if (!compactTarget) return { pageLevel: "product", siblingCatalogNumbers: [] };

  const siblingCatalogNumbers = new Map<string, string>();
  const productRoots = $("main,[role='main'],article")
    .filter((_, element) => !isPeripheral($, element))
    .toArray();

  for (const root of productRoots) {
    const clone = $(root).clone();
    clone.find("nav,aside,footer,[role='navigation'],[class*='related'],[class*='recommend'],[class*='cross-sell']").remove();
    for (const token of textWithBoundaries($, clone).match(HTML_CATALOG_LIKE) ?? []) {
      const compact = compactCatalogNumber(token);
      if (!compact || compact === compactTarget || compact.length < 4 || !/\d/.test(compact)) continue;
      siblingCatalogNumbers.set(compact, cleanText(token));
    }
  }

  // The requested code must occur in product content too: a sibling-only recommendation block is
  // never evidence that THIS URL is a family page.
  const targetPresent = productRoots.some((root) => catalogTokens(textWithBoundaries($, $(root))).has(compactTarget));
  const siblings = [...siblingCatalogNumbers.values()].slice(0, 25);
  return targetPresent && siblings.length > 0
    ? { pageLevel: "family", siblingCatalogNumbers: siblings }
    : { pageLevel: "product", siblingCatalogNumbers: [] };
}

function catalogTokens(text: string): Set<string> {
  return new Set((text.match(HTML_CATALOG_LIKE) ?? []).map(compactCatalogNumber).filter(Boolean));
}

/** Cheerio's `.text()` concatenates adjacent elements; catalog codes in `<h1>…</h1><div>…</div>`
 * would become one invented token. DOM text nodes retain the visible boundary. */
function textWithBoundaries($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>): string {
  return cleanText(
    root
      .add(root.find("*"))
      .contents()
      .toArray()
      .filter((node) => node.type === "text")
      .map((node) => node.data ?? "")
      .join(" ")
  );
}

function isPeripheral($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): boolean {
  return $(element).is("nav,aside,footer,[role='navigation']") || /\b(?:related|recommend|cross-sell)\b/i.test(`${$(element).attr("class") ?? ""} ${$(element).attr("id") ?? ""}`);
}
