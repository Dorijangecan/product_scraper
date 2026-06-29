import type { LocalizedProductUrls, LocalizedUrlTemplate, ManufacturerId } from "../../shared/types.js";
import { buildConfiguredLocalizedUrls, encodeSlashBraceCatalogPart } from "./catalog-number.js";

// nVent serves the same English product page under a geo-detected locale segment
// (e.g. /en-bs/ for the Bahamas, /en-gb/, …). The deterministic catalog/PDT layer expects a
// single canonical English URL, so collapse any English locale variant to /en-us/. This is a
// host fact (nvent.com / chemelex.com), not a per-vendor branch, so it is safe to apply to any
// URL — non-matching hosts are returned untouched.
const NVENT_LOCALE_HOSTS = /(?:^|\.)(?:nvent\.com|chemelex\.com)$/i;

export function canonicalizeNventLocaleUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!NVENT_LOCALE_HOSTS.test(parsed.hostname)) return url;
    const canonicalPath = parsed.pathname.replace(/^\/en-[a-z]{2}\//i, "/en-us/");
    if (canonicalPath === parsed.pathname) return url;
    parsed.pathname = canonicalPath;
    return parsed.toString();
  } catch {
    return url;
  }
}

// Collapse geo-detected locale variants in the surfaced product URLs to a single canonical English
// URL so the PDT/Excel link columns and localized URLs stay stable across runs. Host-gated, so it
// is a no-op for results that don't carry an nVent/Chemelex URL.
export function canonicalizeProductLocaleUrls<T extends { productUrl?: string; localizedUrls?: LocalizedProductUrls }>(
  result: T
): T {
  const productUrl = canonicalizeNventLocaleUrl(result.productUrl);
  const en = canonicalizeNventLocaleUrl(result.localizedUrls?.en);
  if (productUrl === result.productUrl && en === result.localizedUrls?.en) return result;
  return {
    ...result,
    productUrl,
    localizedUrls: result.localizedUrls ? { ...result.localizedUrls, en } : result.localizedUrls
  };
}

export function buildLocalizedProductUrls(
  manufacturerId: ManufacturerId,
  catalogNumber: string,
  productUrl?: string,
  localizedUrlTemplates?: LocalizedUrlTemplate[]
): LocalizedProductUrls {
  const configured = buildConfiguredLocalizedUrls(localizedUrlTemplates, catalogNumber);
  if (configured.en || configured.de) return configured;

  switch (manufacturerId) {
    case "abb":
      return {
        en: abbSmartLink(catalogNumber, "en"),
        de: abbSmartLink(catalogNumber, "de")
      };
    case "balluff":
      return {
        en: balluffProductUrl(catalogNumber, productUrl, "en-us"),
        de: balluffProductUrl(catalogNumber, productUrl, "de-de")
      };
    case "sce":
      return {
        en: productUrl || `https://www.saginawcontrol.com/partnumber_info?n=${encodeURIComponent(catalogNumber)}`
      };
    case "schneider":
      return {
        en: productUrl || `https://www.se.com/ww/en/product/${encodeURIComponent(catalogNumber)}/`,
        de: `https://www.se.com/de/de/product/${encodeURIComponent(catalogNumber)}/`
      };
    case "siemens": {
      return {
        en: `https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb=${encodeURIComponent(catalogNumber)}`,
        de: `https://mall.industry.siemens.com/mall/de/WW/Catalog/Product?mlfb=${encodeURIComponent(catalogNumber)}`
      };
    }
    case "eaton":
      return {
        en: `https://www.eaton.com/us/en-us/skuPage.${encodeSlashBraceCatalogPart(catalogNumber)}.html`,
        de: `https://www.eaton.com/de/de-de/skuPage.${encodeSlashBraceCatalogPart(catalogNumber)}.html`
      };
    case "rockwell":
      return {
        en: `https://www.rockwellautomation.com/en-us/products/details.${encodeURIComponent(catalogNumber)}.html`,
        de: `https://www.rockwellautomation.com/de-de/products/details.${encodeURIComponent(catalogNumber)}.html`
      };
    case "nvent": {
      const base =
        canonicalizeNventLocaleUrl(productUrl) ||
        `https://www.nvent.com/en-us/hoffman/products/enc${encodeURIComponent(catalogNumber.toLowerCase())}`;
      return {
        en: base,
        de: base.replace("/en-us/", "/de-de/")
      };
    }
    case "eta":
      return {
        en: productUrl,
        de: productUrl?.replace("https://www.e-t-a.com/", "https://www.e-t-a.com/")
      };
    default:
      return {
        en: productUrl
      };
  }
}

function abbSmartLink(catalogNumber: string, language: "en" | "de"): string {
  const params = new URLSearchParams({
    ProductId: catalogNumber,
    Language: language,
    PrintPreview: "False",
    pid: catalogNumber
  });
  return `https://new.abb.com/smartlinks/${language}?${params.toString()}`;
}

function balluffProductUrl(catalogNumber: string, productUrl: string | undefined, locale: "en-us" | "de-de"): string {
  if (productUrl && /balluff\.com\/(?:en-us|de-de)\/products\//i.test(productUrl)) {
    return productUrl.replace(/\/(?:en-us|de-de)\/products\//i, `/${locale}/products/`);
  }
  return `https://www.balluff.com/${locale}/products/${encodeURIComponent(catalogNumber)}`;
}
