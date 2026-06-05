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
      rationale: "ABB 1SDA Emax accessory-like devices use the contactor/fuses PDT tab in manual examples; explicit non-accessory types keep their semantic PDT tabs.",
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
    return {
      name: "abb-pdt-product-url",
      rationale: "ABB manual PDTs use the new.abb.com/products/{catalog} URL format with no ABB prefix.",
      value: `https://new.abb.com/products/${encodeURIComponent(bare)}`
    };
  }
  if (ctx.manufacturerId === "eaton") {
    const part = clean(ctx.catalogNumber) ?? ctx.catalogNumber;
    const withPrefix = /^EP-/i.test(part) ? part : `EP-${part}`;
    return {
      name: "eaton-pdt-sku-page-url",
      rationale: "Eaton manual PDTs use gb/en-gb skuPage URLs and require an EP- prefix.",
      value: `https://www.eaton.com/gb/en-gb/skuPage.${encodeURIComponent(withPrefix)}.html`
    };
  }
  if (ctx.manufacturerId === "sce") {
    return {
      name: "saginaw-pdt-partnumber-info-url",
      rationale: "Saginaw manual PDTs use the partnumber_info endpoint as the product URL.",
      value: `https://www.saginawcontrol.com/partnumber_info/?n=${encodeURIComponent(clean(ctx.catalogNumber) ?? ctx.catalogNumber)}`
    };
  }
  return undefined;
}

export function localizedPdtDocumentUrlRules(ctx: PdtUrlContext): Array<AppliedPdtRule<{ url: string; language: "english" | "german"; description: string }>> {
  if (ctx.manufacturerId === "abb") {
    const bare = clean(ctx.catalogNumber)?.replace(/^ABB/i, "") ?? ctx.catalogNumber.replace(/^ABB/i, "");
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
    const withPrefix = /^EP-/i.test(part) ? part : `EP-${part}`;
    const encoded = encodeURIComponent(withPrefix);
    return [
      {
        name: "eaton-pdt-document-url-en",
        rationale: "Eaton manual PDT Additional Documents include gb/en-gb skuPage link.",
        value: { url: `https://www.eaton.com/gb/en-gb/skuPage.${encoded}.html`, language: "english", description: "Datasheet(EN)" }
      },
      {
        name: "eaton-pdt-document-url-de",
        rationale: "Eaton manual PDT Additional Documents include de/de-de skuPage link.",
        value: { url: `https://www.eaton.com/de/de-de/skuPage.${encoded}.html`, language: "german", description: "Datenblatt" }
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
