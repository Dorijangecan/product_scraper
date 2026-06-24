import type { ManufacturerConfig, RunItemRecord } from "../../shared/types.js";
import type { PdtColumn } from "./sheet-descriptor.js";

export interface AppliedPdtRule<T> {
  name: string;
  rationale: string;
  value: T;
}

interface PdtRuleContext {
  manufacturer: ManufacturerConfig;
  item: RunItemRecord;
  deviceType?: string;
}

interface PdtUrlContext {
  manufacturerId?: string;
  catalogNumber: string;
}

const EATON_E6_CATALOG_PDF_URL =
  "https://www.eaton.com.cn/content/dam/eaton/products/electrical-circuit-protection/circuit-breakers/e6-series/eaton-e6-catalogue-en-cn.pdf";
const ROCKWELL_MICRO820_FAMILY_URL =
  "https://www.rockwellautomation.com/en-us/products/hardware/allen-bradley/programmable-controllers/micro-controllers/micro800-family/micro820-controllers.html";
const ABB_CP600_PRO_URL = "https://www.abb.com/global/en/areas/motion/plc/control-panels/cp600-pro";
const ABB_CP6610_DATASHEET_URL =
  "https://library.e.abb.com/public/0df8d53c4774407a8cfc66bd9cbd9112/CP6610_Data_Sheet_3ADR010234%2C%202%2C%20en_US_RevB.pdf";

const ABB_1SDA_ALLOWED_CONTACTOR_COLUMNS = new Set([
  "REFERENCE_FEATURE_GROUP_ID",
  "REFERENCE_FEATURE_SYSTEM_NAME",
  "AAO676",
  "BAH005",
  "AAF726",
  "AAB821",
  "AAC824",
  "AAB460",
  "AAS574",
  "AAB485",
  "BAD915",
  "AAS575"
]);

const ABB_1SDA_CONTACTOR_FUSES_DEVICE_TYPES = new Set([
  "Accessory",
  "Cover / Door Accessory",
  "Lock / Interlock",
  "Mounting Accessory",
  "Terminal Accessory"
]);

export function pdtSheetOverrideRule(ctx: PdtRuleContext): AppliedPdtRule<string[]> | undefined {
  if (isManufacturer(ctx, "abb") && /^1SDA/i.test(ctx.item.catalogNumber) && shouldRouteAbb1SdaAccessoryToContactorFuses(ctx.deviceType)) {
    return {
      name: "abb-1sda-contactor-fuses-sheet",
      rationale: "ABB 1SDA Emax accessory-like devices use the contactor/fuses PDT tab in manual PDT examples; explicit non-accessory types keep their semantic PDT tabs.",
      value: ["contactor a. fuses"]
    };
  }
  return undefined;
}

export function additionalPdtSheetsRule(ctx: PdtRuleContext): AppliedPdtRule<string[]> | undefined {
  const text = `${ctx.item.catalogNumber} ${ctx.item.result?.title ?? ""} ${ctx.item.result?.description ?? ""}`;
  if (isManufacturer(ctx, "rockwell") && /\b(?:PowerFlex|755)\b/i.test(text) && ctx.deviceType === "Variable Speed Drive") {
    return {
      name: "rockwell-powerflex-power-supply-tab",
      rationale: "Rockwell PowerFlex drive manual PDT examples include power supply devices in addition to drive tabs.",
      value: ["power supply devices"]
    };
  }
  return undefined;
}

export function pdtColumnAllowRule(ctx: PdtRuleContext & { sheetName: string; column: PdtColumn }): AppliedPdtRule<boolean> | undefined {
  if (isManufacturer(ctx, "abb") && /^1SDA/i.test(ctx.item.catalogNumber) && canonicalSheetKey(ctx.sheetName) === canonicalSheetKey("contactor a. fuses")) {
    const allowed = ABB_1SDA_ALLOWED_CONTACTOR_COLUMNS.has(ctx.column.code.trim().toUpperCase());
    return {
      name: "abb-1sda-contactor-fuses-column-allowlist",
      rationale: "ABB 1SDA Emax accessory rows on contactor/fuses may only write identity, ECLASS, and source-backed electrical fields.",
      value: allowed
    };
  }
  return undefined;
}

export function pdtProductUrlRule(ctx: PdtUrlContext): AppliedPdtRule<string> | undefined {
  if (ctx.manufacturerId === "abb") {
    const bare = clean(ctx.catalogNumber)?.replace(/^ABB/i, "") ?? ctx.catalogNumber.replace(/^ABB/i, "");
    if (/^CP6610$/i.test(bare)) {
      return {
        name: "abb-cp6610-pdt-product-url",
        rationale: "ABB CP6610 belongs to the CP600-Pro family page; avoid the obsolete new.abb.com/products/{catalog} fallback.",
        value: ABB_CP600_PRO_URL
      };
    }
    return {
      name: "abb-pdt-product-url",
      rationale: "ABB manual PDTs use the new.abb.com/products/{catalog} URL format with no ABB prefix.",
      value: `https://new.abb.com/products/${encodeURIComponent(bare)}`
    };
  }
  if (ctx.manufacturerId === "eaton") {
    const part = clean(ctx.catalogNumber) ?? ctx.catalogNumber;
    if (/^CBE\d+$/i.test(part)) {
      return {
        name: "eaton-cbe-e6-catalog-pdf-url",
        rationale: "Eaton CBE article numbers are identified from the E6 catalog source PDF, so the PDT product URL should point at that source document.",
        value: EATON_E6_CATALOG_PDF_URL
      };
    }
    return {
      name: "eaton-pdt-sku-page-url",
      rationale: "Eaton PDT product URLs should use the real skuPage identifier without inventing an EP- prefix.",
      value: `https://www.eaton.com/gb/en-gb/skuPage.${encodeURIComponent(part)}.html`
    };
  }
  if (ctx.manufacturerId === "sce") {
    return {
      name: "saginaw-pdt-partnumber-info-url",
      rationale: "Saginaw manual PDTs use the partnumber_info endpoint as the product URL.",
      value: `https://www.saginawcontrol.com/partnumber_info/?n=${encodeURIComponent(clean(ctx.catalogNumber) ?? ctx.catalogNumber)}`
    };
  }
  if (ctx.manufacturerId === "rockwell") {
    if (/^\s*852[CD]-/i.test(ctx.catalogNumber)) {
      const catalog = clean(ctx.catalogNumber) ?? ctx.catalogNumber;
      return {
        name: "rockwell-852-led-indicator-pdt-details-url",
        rationale: "Rockwell 852C/852D signaling manual PDTs use the official details page for each LED indicator variant.",
        value: `https://www.rockwellautomation.com/en-us/products/details.${encodeURIComponent(catalog)}.html`
      };
    }
    if (/^\s*20G21FC/i.test(ctx.catalogNumber)) {
      return {
        name: "rockwell-powerflex-755ts-pdt-installation-pdf-url",
        rationale: "Rockwell PowerFlex 755TS manual PDTs use the installation instructions PDF as the product URL.",
        value: "https://literature.rockwellautomation.com/idc/groups/literature/documents/in/750-in119_-en-p.pdf"
      };
    }
    if (/^\s*2198-DSD/i.test(ctx.catalogNumber)) {
      const catalog = clean(ctx.catalogNumber) ?? ctx.catalogNumber;
      return {
        name: "rockwell-armorkinetix-dsd-pdt-details-url",
        rationale: "Rockwell ArmorKinetix DSD manual PDTs use the official details page for each distributed-drive variant.",
        value: `https://www.rockwellautomation.com/en-us/products/details.${encodeURIComponent(catalog)}.html`
      };
    }
    if (/^\s*1783-US/i.test(ctx.catalogNumber)) {
      const catalog = clean(ctx.catalogNumber) ?? ctx.catalogNumber;
      return {
        name: "rockwell-stratix-2100-pdt-details-url",
        rationale: "Rockwell Stratix 2100 manual PDTs use the official details page for each unmanaged-switch variant.",
        value: `https://www.rockwellautomation.com/en-us/products/details.${encodeURIComponent(catalog)}.html`
      };
    }
    if (/^\s*2080-LC20-/i.test(ctx.catalogNumber)) {
      return {
        name: "rockwell-micro820-pdt-family-url",
        rationale: "Rockwell manual PDTs use the Micro820 family page for 2080-LC20 controller variants.",
        value: ROCKWELL_MICRO820_FAMILY_URL
      };
    }
    if (/^\s*5069-/i.test(ctx.catalogNumber)) {
      const catalog = clean(ctx.catalogNumber) ?? ctx.catalogNumber;
      return {
        name: "rockwell-compact-5000-io-pdt-details-url",
        rationale: "Rockwell Compact 5000 I/O PDT product web addresses must point to the exact details page, not the search-results page.",
        value: `https://www.rockwellautomation.com/en-us/products/details.${encodeURIComponent(catalog)}.html`
      };
    }
    if (/^\s*2715P-/i.test(ctx.catalogNumber)) {
      return {
        name: "rockwell-panelview-5510-pdt-search-url",
        rationale: "Rockwell manual PDTs use the PanelView 5510 family search URL for 2715P variants.",
        value: "https://www.rockwellautomation.com/en-us/search.html?keyword=2715P&tab=all"
      };
    }
    if (/^\s*1756-L9/i.test(ctx.catalogNumber)) {
      return {
        name: "rockwell-controllogix-l9-pdt-search-url",
        rationale: "Rockwell ControlLogix L9 manual PDTs use the 1756-L9 family search URL for processor variants.",
        value: "https://www.rockwellautomation.com/en-us/search.html?keyword=1756-L9&tab=all"
      };
    }
    if (/^\s*1492-PD(?:E|ME)/i.test(ctx.catalogNumber)) {
      return {
        name: "rockwell-1492-pde-pdt-search-url",
        rationale: "Rockwell 1492-PDE/PDME manual PDTs use the 1492-PDE family search URL for enclosed power distribution terminal blocks.",
        value: "https://www.rockwellautomation.com/en-us/search.html?keyword=1492-PDE&tab=all"
      };
    }
    if (/^\s*2198-DSM/i.test(ctx.catalogNumber)) {
      return {
        name: "rockwell-armorkinetix-dsm-pdt-search-url",
        rationale: "Rockwell manual PDTs use the ArmorKinetix DSM family search URL for 2198-DSM variants.",
        value: "https://www.rockwellautomation.com/en-us/search.html?keyword=armorkinetix+DSM&tab=all"
      };
    }
    {
      const catalog = clean(ctx.catalogNumber) ?? ctx.catalogNumber;
      return {
        name: "rockwell-pdt-details-url-default",
        rationale: "Unknown Rockwell families should use the exact catalog details page rather than a search-results URL.",
        value: `https://www.rockwellautomation.com/en-us/products/details.${encodeURIComponent(catalog)}.html`
      };
    }
  }
  return undefined;
}

export function localizedPdtDocumentUrlRules(ctx: PdtUrlContext): Array<AppliedPdtRule<{ url: string; language: "english" | "german"; description: string; documentType?: string }>> {
  if (ctx.manufacturerId === "abb") {
    const bare = clean(ctx.catalogNumber)?.replace(/^ABB/i, "") ?? ctx.catalogNumber.replace(/^ABB/i, "");
    if (/^CP6610$/i.test(bare)) {
      return [
        {
          name: "abb-cp6610-datasheet-document-url-en",
          rationale: "ABB CP6610 PDT Additional Documents should use the official ABB Library datasheet instead of the obsolete new.abb.com/products fallback.",
          value: { url: ABB_CP6610_DATASHEET_URL, language: "english", description: "Datasheet(EN)", documentType: "pdf" }
        },
        {
          name: "abb-cp6610-family-document-url-en",
          rationale: "ABB CP6610 is published on the CP600-Pro family page on abb.com/global.",
          value: { url: ABB_CP600_PRO_URL, language: "english", description: "Product page" }
        }
      ];
    }
    const encoded = encodeURIComponent(bare);
    return [
      {
        name: "abb-pdt-document-url-en",
        rationale: "ABB manual PDT Additional Documents include deterministic English product link.",
        value: { url: `https://new.abb.com/products/${encoded}`, language: "english", description: "Datasheet(EN)" }
      },
      {
        name: "abb-pdt-document-url-de",
        rationale: "ABB manual PDT Additional Documents include deterministic German product link.",
        value: { url: `https://new.abb.com/products/de/${encoded}`, language: "german", description: "Datenblatt" }
      }
    ];
  }
  if (ctx.manufacturerId === "eaton") {
    const part = clean(ctx.catalogNumber) ?? ctx.catalogNumber;
    if (/^CBE\d+$/i.test(part)) {
      return [
        {
          name: "eaton-cbe-pdt-document-url-en",
          rationale: "Eaton CBE article numbers come from the E6 catalog PDF; use the source PDF as the English datasheet document.",
          value: { url: EATON_E6_CATALOG_PDF_URL, language: "english", description: "Datasheet(EN)" }
        },
        {
          name: "eaton-cbe-pdt-document-url-de",
          rationale: "Eaton CBE article numbers come from the E6 catalog PDF; use the source PDF as the German datasheet document pending a localized PDF.",
          value: { url: EATON_E6_CATALOG_PDF_URL, language: "german", description: "Datenblatt" }
        }
      ];
    }
    const encoded = encodeURIComponent(part);
    return [
      {
        name: "eaton-pdt-document-url-en",
        rationale: "Eaton PDT Additional Documents should point at the downloadable localized specification PDF for the real skuPage identifier.",
        value: { url: `https://www.eaton.com/gb/en-gb/skuPage.${encoded}.pdf`, language: "english", description: "Datasheet(EN)" }
      },
      {
        name: "eaton-pdt-document-url-de",
        rationale: "Eaton PDT Additional Documents should point at the downloadable localized specification PDF for the real skuPage identifier.",
        value: { url: `https://www.eaton.com/de/de-de/skuPage.${encoded}.pdf`, language: "german", description: "Datenblatt" }
      }
    ];
  }
  if (ctx.manufacturerId === "sce") {
    return [
      {
        name: "saginaw-pdt-document-url-en",
        rationale: "Saginaw manual PDT Additional Documents include one English partnumber_info link.",
        value: {
          url: `https://www.saginawcontrol.com/partnumber_info/?n=${encodeURIComponent(clean(ctx.catalogNumber) ?? ctx.catalogNumber)}`,
          language: "english",
          description: "Datasheet(EN)"
        }
      }
    ];
  }
  if (ctx.manufacturerId === "rockwell" && /^\s*2080-LC20-/i.test(ctx.catalogNumber)) {
    return [
      {
        name: "rockwell-micro820-pdt-document-url-en",
        rationale: "Rockwell Micro820 manual PDT Additional Documents include one English technical datasheet link to the family page.",
        value: { url: ROCKWELL_MICRO820_FAMILY_URL, language: "english", description: "Technical Datasheet (EN)", documentType: "pdf" }
      }
    ];
  }
  if (ctx.manufacturerId === "rockwell" && /^\s*5069-[IO]/i.test(ctx.catalogNumber)) {
    return [
      {
        name: "rockwell-compact-5000-io-pdt-document-url-en",
        rationale: "Rockwell Compact 5000 I/O Additional Documents should use the direct Technical Data PDF, not the product-page documentation tab.",
        value: {
          url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/5069-td001_-en-p.pdf",
          language: "english",
          description: "Technical Datasheet (EN)",
          documentType: "pdf"
        }
      }
    ];
  }
  return [];
}

function isManufacturer(ctx: PdtRuleContext, manufacturerId: string): boolean {
  return ctx.manufacturer.id === manufacturerId || ctx.item.result?.manufacturerId === manufacturerId;
}

function shouldRouteAbb1SdaAccessoryToContactorFuses(deviceType: string | undefined): boolean {
  return !deviceType || ABB_1SDA_CONTACTOR_FUSES_DEVICE_TYPES.has(deviceType);
}

function canonicalSheetKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}
