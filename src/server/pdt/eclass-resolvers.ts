import type { ManufacturerConfig, ProductResult, RunItemRecord } from "../../shared/types.js";
import type { PdtRepair } from "./ai-cleanup.js";

export interface ResolveContext {
  result?: ProductResult;
  item: RunItemRecord;
  manufacturer: ManufacturerConfig;
  /** Classified device category (e.g. "Enclosure"), used for the ECLASS "Product type" field. */
  deviceType?: string;
  /** PDT sheet currently being written, used for sheet-specific import conventions. */
  sheetName?: string;
  /** Optional local Qwen/Ollama cleanup output for import-ready PDT values. */
  repair?: PdtRepair;
}

type Resolver = (ctx: ResolveContext) => string | undefined;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

/** First attribute whose name (or group) matches `pattern`, preferring official sources. */
function attr(ctx: ResolveContext, pattern: RegExp): string | undefined {
  const attributes = ctx.result?.attributes ?? [];
  const matches = attributes.filter((a) => pattern.test(`${a.group ?? ""} ${a.name}`) && a.value?.trim());
  if (matches.length === 0) return undefined;
  matches.sort((l, r) => sourceRank(r.sourceType) - sourceRank(l.sourceType) || (r.confidence ?? 0) - (l.confidence ?? 0));
  return clean(matches[0].value);
}

function sourceRank(sourceType: string | undefined): number {
  if (sourceType === "official") return 3;
  if (sourceType === "official-fallback") return 2;
  if (sourceType === "cache") return 1;
  if (sourceType === "distributor") return -1;
  return 0;
}

/** Extract a numeric weight from a normalized string like "2.5 kg" / "850 g". */
function weight(ctx: ResolveContext): { kg?: number; g?: number } {
  const raw = ctx.result?.normalized.weight;
  if (!raw) return {};
  const match = raw.replace(",", ".").match(/(\d+(?:\.\d+)?)\s*(kg|g|lb|lbs)?/i);
  if (!match) return {};
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return {};
  const unit = (match[2] ?? "kg").toLowerCase();
  if (unit === "g") return { g: value, kg: value / 1000 };
  if (unit === "lb" || unit === "lbs") return { kg: value * 0.453592, g: value * 453.592 };
  return { kg: value, g: value * 1000 };
}

function round(value: number | undefined, digits: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return String(Number(value.toFixed(digits)));
}

/** Best ECLASS attribute the scraper captured (name like "ECLASS" or "ECLASS 11.0"). */
function eclassAttr(ctx: ResolveContext): { name: string; value: string } | undefined {
  const matches = (ctx.result?.attributes ?? []).filter((a) => /^eclass\b/i.test(a.name.trim()) && a.value?.trim());
  if (matches.length === 0) return undefined;
  matches.sort((l, r) => sourceRank(r.sourceType) - sourceRank(l.sourceType) || eclassVersion(r.name) - eclassVersion(l.name));
  return { name: matches[0].name.trim(), value: clean(matches[0].value) ?? "" };
}

function eclassVersion(name: string): number {
  const v = name.match(/(\d+(?:\.\d+)?)/)?.[1];
  return v ? Number(v) : 0;
}

/** Numeric ECLASS class code (e.g. "27-18-01-01") extracted from the scraped ECLASS value. */
const eclassNumber: Resolver = (ctx) => {
  if (ctx.repair?.eclassCode) return ctx.repair.eclassCode;
  const found = eclassAttr(ctx);
  if (!found) return undefined;
  return found.value.match(/\d{2}(?:[-.]?\d{2}){1,3}/)?.[0] ?? clean(found.value);
};

/** Classification system name, including version when the scraper knows it (e.g. "ECLASS-11.0"). */
const eclassSystem: Resolver = (ctx) => {
  if (ctx.repair?.eclassSystemVersion) return ctx.repair.eclassSystemVersion;
  const found = eclassAttr(ctx);
  if (!found) return undefined;
  const version = found.name.match(/\d+(?:\.\d+)+|\d+/)?.[0];
  return version ? `ECLASS-${version}` : "ECLASS";
};

/** Parse a temperature range string ("-25...+60 °C") into min/max strings. */
function tempRange(ctx: ResolveContext): { min?: string; max?: string } {
  const value = attr(ctx, /\b(operating|ambient|service|storage) temperature\b/i) ?? attr(ctx, /\btemperature range\b/i);
  const nums = value?.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return {};
  return { min: nums[0], max: nums[nums.length - 1] };
}

const manufacturerName: Resolver = (ctx) => clean(ctx.manufacturer.canonicalName);
const manufacturerUrl: Resolver = (ctx) => {
  if (ctx.manufacturer.homepageUrl) return clean(ctx.manufacturer.homepageUrl);
  const base = ctx.manufacturer.officialBaseUrls?.[0];
  if (!base) return undefined;
  try {
    return new URL(base).origin;
  } catch {
    return clean(base);
  }
};
const productUrl: Resolver = (ctx) => clean(pdtProductUrl(ctx));
const articleNumber: Resolver = (ctx) => clean(ctx.item.catalogNumber);
const longDescription: Resolver = (ctx) =>
  clean(ctx.repair?.longDescription) ?? clean(ctx.result?.description) ?? attr(ctx, /\b(long description|catalog description|invoice description)\b/i);
const shortDescription: Resolver = (ctx) =>
  clean(ctx.repair?.shortDescription) ?? clean(ctx.result?.title) ?? attr(ctx, /\b(catalog description|display name|short description|product name)\b/i);

/**
 * Numeric millimetre value for a product dimension. Prefers "net"/product attributes and excludes
 * packaging/gross/shipping dimensions so e.g. "Package Level1 Width" never wins over "Net Width".
 */
function dimensionMm(ctx: ResolveContext, dims: string[]): string | undefined {
  const rx = new RegExp(`\\b(?:${dims.join("|")})\\b`, "i");
  const candidates = (ctx.result?.attributes ?? []).filter(
    (a) => rx.test(a.name) && a.value?.trim() && !/\b(package|packaging|gross|shipping|carton|pallet|level\s*\d)\b/i.test(a.name)
  );
  if (candidates.length === 0) return undefined;
  candidates.sort(
    (l, r) =>
      (/\bnet\b/i.test(r.name) ? 1 : 0) - (/\bnet\b/i.test(l.name) ? 1 : 0) ||
      sourceRank(r.sourceType) - sourceRank(l.sourceType)
  );
  return clean(candidates[0].value)?.match(/-?\d+(?:\.\d+)?/)?.[0];
}
// Type code = manufacturer's type designation. We deliberately do NOT match a generic
// "product type" attribute here — that holds the device category (e.g. "Enclosure"), which
// belongs in the ECLASS product-type field, not the typecode. Fall back to the catalog number.
const typeCode: Resolver = (ctx) =>
  attr(ctx, /\b(type code|typecode|extended product type|type designation|product main type|main type|catalog(?:ue)? type|order type)\b/i) ??
  clean(ctx.item.catalogNumber);

// Customs tariff / commodity code. Manufacturers label this differently — ABB uses "Cn8".
const customsTariff = (ctx: ResolveContext) =>
  attr(ctx, /\b(customs tariff|tariff code|tariff|hs code|commodity code|cn ?8|cn code|combined nomenclature)\b/i);

const eanOrGtin = (ctx: ResolveContext) => attr(ctx, /\b(ean|gtin)\b/i);

function pdtProductUrl(ctx: ResolveContext): string | undefined {
  if (ctx.result?.manufacturerId === "abb" || ctx.manufacturer.id === "abb") return abbPdtProductUrl(ctx.item.catalogNumber);
  return ctx.result?.productUrl ?? ctx.item.productUrl;
}

function abbPdtProductUrl(catalogNumber: string): string {
  const abbProductId = /^ABB/i.test(catalogNumber) ? catalogNumber : `ABB${catalogNumber}`;
  return `https://new.abb.com/products/${encodeURIComponent(abbProductId)}`;
}

function isContactorSheet(ctx: ResolveContext): boolean {
  return ctx.sheetName?.toLowerCase() === "contactor a. fuses";
}

function isDeviceSheet(ctx: ResolveContext): boolean {
  return Boolean(ctx.sheetName && ctx.sheetName !== "Material Master Data");
}

function controlVoltageRange(ctx: ResolveContext): string | undefined {
  if (ctx.repair?.controlVoltage) return ctx.repair.controlVoltage;
  const value = attr(ctx, /\brated control circuit voltage\b/i) ?? attr(ctx, /\bcontrol voltage\b/i);
  const acPart = value?.split(";").find((part) => /\b(?:50|60)\s*hz\b/i.test(part)) ?? value;
  const match = acPart?.replace(/,/g, ".").match(/(\d+(?:\.\d+)?)\s*(?:\.\.\.|\.{2}|-|to)\s*(\d+(?:\.\d+)?)/i);
  if (!match) return undefined;
  return `${Number(match[1])}-${Number(match[2])}`;
}

function controlVoltageType(ctx: ResolveContext): string | undefined {
  if (ctx.repair?.voltageType) return ctx.repair.voltageType;
  const value = attr(ctx, /\brated control circuit voltage\b/i) ?? attr(ctx, /\bcontrol voltage\b/i);
  if (!value) return undefined;
  const hasAc = /\b(?:50|60)\s*hz\b|\bAC\b/i.test(value);
  const hasDc = /\bDC\b/i.test(value);
  if (hasAc && hasDc) return "AC/DC";
  if (hasAc) return "AC";
  if (hasDc) return "DC";
  return undefined;
}

function firstAmpereValue(value: string | undefined): string | undefined {
  return value?.match(/(\d+(?:\.\d+)?)\s*A\b/i)?.[1];
}

/**
 * Global registry keyed by PDT PropertyId (ECLASS code) or CNS variable name. Lookups try both
 * the column's `code` and `propName`, so a known property is filled wherever it appears across
 * tabs. Material Master Data is covered fully; device-tab properties are best-effort.
 */
const RESOLVERS: Record<string, Resolver> = {
  // --- Material Master Data ---
  AAO677: manufacturerName,
  MANUFACTURER_URL: manufacturerUrl,
  AAQ326: productUrl,
  AAO676: articleNumber,
  CNSORDERNO: articleNumber,
  CNSTYPECODE: typeCode,
  AAV774: typeCode,
  // ECLASS "Product type (string)" — the classified device category. Note the combined cell
  // "AAV774/AAO057" still resolves to the typecode because AAV774 is tried first.
  AAO057: (ctx) => clean(ctx.deviceType),
  CERTIFICATION: (ctx) => clean(ctx.result?.normalized.certificates),
  AAO663: eanOrGtin,
  CNS_EAN: eanOrGtin,
  AAN743: eanOrGtin,
  CNS_CTN: customsTariff,
  AAD931: customsTariff,
  CNS_ELECTRO_MATERIAL: (ctx) => clean(ctx.result?.normalized.material),
  CNS_MASSEXACT: (ctx) => round(weight(ctx).kg, 3),
  AAF040: (ctx) => round(weight(ctx).kg, 3),
  BAD875: (ctx) => round(weight(ctx).g, 0),
  AAY811: productUrl, // URI of the product
  AAW338: typeCode, // Manufacturer product designation
  ABA671: articleNumber, // product identifier
  AAU734: longDescription, // Manufacturer product description
  CNS_DESCRIPTION_LONG: longDescription,
  CNS_DESCRIPTION_SHORT: shortDescription,
  BAB577: (ctx) => dimensionMm(ctx, ["depth", "length"]),
  BAF016: (ctx) => dimensionMm(ctx, ["width"]),
  BAA020: (ctx) => dimensionMm(ctx, ["height"]),

  // --- Device-tab common (best-effort) ---
  REFERENCE_FEATURE_GROUP_ID: eclassNumber,
  REFERENCE_FEATURE_SYSTEM_NAME: (ctx) => (isDeviceSheet(ctx) ? ctx.repair?.eclassSystemVersion ?? "14" : eclassSystem(ctx)),
  AAN521: (ctx) => clean(ctx.result?.normalized.color),
  BAH005: (ctx) =>
    (isContactorSheet(ctx) ? controlVoltageRange(ctx) : undefined) ??
    clean(ctx.result?.normalized.voltage) ??
    attr(ctx, /\b(rated voltage|operating voltage)\b/i),
  AAF726: (ctx) =>
    (isContactorSheet(ctx) ? ctx.repair?.ratedCurrent ?? firstAmpereValue(attr(ctx, /\brated operational current AC-1\b/i)) : undefined) ??
    clean(ctx.result?.normalized.current) ??
    attr(ctx, /\b(rated current|operating current)\b/i),
  AAC820: (ctx) => ctx.repair?.operatingTemperatureMin ?? attr(ctx, /\bmin(?:imum)?\b.*\btemperature\b/i) ?? tempRange(ctx).min,
  AAC821: (ctx) => ctx.repair?.operatingTemperatureMax ?? attr(ctx, /\bmax(?:imum)?\b.*\btemperature\b/i) ?? tempRange(ctx).max,
  // Numeric / integer / free-text device fields that are SAFE to fill (the enum-coded device
  // columns like "Voltage type 1-AC 2-DC" or IP/NEMA are deliberately left blank — they need a
  // value-to-code mapping, and writing the raw scraped string there would be wrong).
  AAS575: (ctx) => ctx.repair?.powerLossPerPole ?? numberWithUnit(attr(ctx, /\bpower loss\b/i), "W"), // Power loss per pole [W]
  AAT080: (ctx) =>
    isContactorSheet(ctx) ? undefined : numberOf(attr(ctx, /\b(number of poles|pole number|no\.? of poles|poles)\b/i)), // Pole number
  AAP798: (ctx) => attr(ctx, /\b(application standards|standards?)\b/i), // Application standards
  AAB491: (ctx) => numberWithUnit(attr(ctx, /\b(insulation voltage|isolation voltage)\b/i), "V"), // rated isolation voltage [V]
  AAB492: (ctx) => numberWithUnit(attr(ctx, /\b(short.?time.*withstand current|withstand current.*icw|\bicw\b)\b/i), "kA"), // Icw [kA]
  AAB815: (ctx) => numberWithUnit(attr(ctx, /\b(rated operational voltage|max\.?\s*rated operating voltage)\b/i), "V"), // max operating voltage Ue [V]
  // Enum column (raw value -> encoded to a code by the exporter via the column legend).
  BAD915: (ctx) => (isContactorSheet(ctx) ? controlVoltageType(ctx) : undefined) ?? attr(ctx, /\b(current type|voltage type)\b/i)
};

/** Extract the first numeric token from a value (e.g. "3P" -> "3"). */
function numberOf(value: string | undefined): string | undefined {
  return value?.match(/-?\d+(?:\.\d+)?/)?.[0];
}

/**
 * Extract the number that sits directly in front of a given unit, e.g. for unit "kA"
 * "for 1 s 50 kA" -> "50", and for "V" "acc. to IEC/EN 60664-1 1000 V" -> "1000". This avoids
 * grabbing qualifier numbers (seconds, standard numbers) that precede the real value.
 */
function numberWithUnit(value: string | undefined, unit: string): string | undefined {
  return value?.match(new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*${unit}\\b`, "i"))?.[1];
}

/** Resolve a body value for a PDT column, trying both its ECLASS code and CNS variable name. */
export function resolveProperty(code: string, propName: string, ctx: ResolveContext): string | undefined {
  for (const key of propertyKeys(code, propName)) {
    const resolver = RESOLVERS[key];
    if (resolver) {
      const value = resolver(ctx);
      if (value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}

function propertyKeys(code: string, propName: string): string[] {
  const keys = new Set<string>();
  for (const raw of [code, propName]) {
    const normalized = raw?.trim().toUpperCase();
    if (!normalized) continue;
    keys.add(normalized);
    // Codes such as "AAV774/AAO057" hold two ECLASS ids; try each independently.
    for (const part of normalized.split("/")) {
      const trimmed = part.trim();
      if (trimmed) keys.add(trimmed);
    }
  }
  return [...keys];
}
