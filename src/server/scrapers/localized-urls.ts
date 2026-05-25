import type { LocalizedProductUrls, LocalizedUrlTemplate, ManufacturerId } from "../../shared/types.js";
import { buildConfiguredLocalizedUrls, encodeSlashBraceCatalogPart } from "./catalog-number.js";

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
    case "nvent":
      return {
        en: productUrl || `https://www.nvent.com/en-us/hoffman/products/enc${encodeURIComponent(catalogNumber.toLowerCase())}`,
        de: productUrl?.replace("/en-us/", "/de-de/")
      };
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
