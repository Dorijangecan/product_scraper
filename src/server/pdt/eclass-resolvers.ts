import type { ManufacturerConfig, ProductResult, RunItemRecord } from "../../shared/types.js";
import type { PdtRepair } from "./ai-cleanup.js";
import { maxUnitNumber, splitTemperatureRange } from "./unit-cleanup.js";

export interface ResolveContext {
  result?: ProductResult;
  item: RunItemRecord;
  manufacturer: ManufacturerConfig;
  /** Classified device category (e.g. "Enclosure"), used for the ECLASS "Product type" field. */
  deviceType?: string;
  /** PDT sheet currently being written, used for sheet-specific import conventions. */
  sheetName?: string;
  /** Optional deterministic cleanup output for import-ready PDT values. */
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
  const values = [
    attr(ctx, /\b(operating|ambient|service|surrounding)\b.*\btemperature\b/i),
    attr(ctx, /\btemperature\b.*\b(operating|ambient|service|surrounding)\b/i),
    attr(ctx, /\bamb(?:ient)?\s+air\s+tem(?:p(?:erature)?)?\b/i),
    attr(ctx, /\btemperature range\b/i),
    attr(ctx, /\bstorage temperature\b/i)
  ];
  for (const value of values) {
    const range = splitTemperatureRange(preferOperatingTemperatureSegment(value));
    if (range.min !== undefined || range.max !== undefined) return range;
  }
  return {};
}

function preferOperatingTemperatureSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const segments = value.split(";").map((segment) => segment.trim()).filter(Boolean);
  return (
    segments.find((segment) => /-?\d/.test(segment) && /\b(?:operat|ambient|amb\s+air|close to contactor|without thermal|fitted with thermal)\b/i.test(segment) && !/\bstorage\b/i.test(segment)) ??
    segments.find((segment) => /-?\d/.test(segment) && !/\bstorage\b/i.test(segment)) ??
    value
  );
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

function productFamily(ctx: ResolveContext): string | undefined {
  return (
    attr(ctx, /\b(product family|product range|series|family)\b/i) ??
    inferCatalogFamily(typeCode(ctx) ?? ctx.result?.title ?? ctx.item.catalogNumber)
  );
}

function productBase(ctx: ResolveContext): string | undefined {
  return (
    attr(ctx, /\b(product base|base product|base type|model)\b/i) ??
    attr(ctx, /\b(product family|product range|series|family)\b/i) ??
    inferCatalogBase(typeCode(ctx) ?? ctx.result?.title ?? ctx.item.catalogNumber)
  );
}

function productOrderSuffix(ctx: ResolveContext): string | undefined {
  return attr(ctx, /\b(order suffix|product order suffix|suffix)\b/i) ?? inferCatalogSuffix(typeCode(ctx) ?? ctx.item.catalogNumber);
}

function inferCatalogFamily(value: string | undefined): string | undefined {
  const text = clean(value);
  if (!text) return undefined;
  const first = text.match(/[A-Z]+[A-Z0-9]*/i)?.[0];
  return first ? clean(first) : undefined;
}

function inferCatalogBase(value: string | undefined): string | undefined {
  const text = clean(value);
  if (!text) return undefined;
  const base = text.match(/[A-Z]+[A-Z0-9]*(?:-[A-Z0-9]+)?/i)?.[0];
  return base ? clean(base) : undefined;
}

function inferCatalogSuffix(value: string | undefined): string | undefined {
  const text = clean(value);
  if (!text || !text.includes("-")) return undefined;
  const suffix = text.split("-").slice(1).join("-");
  return clean(suffix);
}

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
  if (/\bAC\s*(?:\/|-|\s)\s*DC\b/i.test(value)) return "AC/DC";
  const hasAc = /\b(?:50|60)\s*hz\b|\bAC\b/i.test(value);
  const hasDc = /\bDC\b/i.test(value);
  if (hasAc && hasDc) return undefined;
  if (hasAc) return "AC";
  if (hasDc) return "DC";
  return undefined;
}

function firstAmpereValue(value: string | undefined): string | undefined {
  return maxUnitNumber(value, "A");
}

function ratedOperationalCurrent(ctx: ResolveContext): string | undefined {
  return firstAmpereValue(attr(ctx, /\brated operational current AC-1\b/i)) ?? firstAmpereValue(attr(ctx, /\brated operational current\b/i));
}

function ratedOperationalVoltage(ctx: ResolveContext): string | undefined {
  return numberWithUnit(attr(ctx, /\brated operational voltage\b/i), "V");
}

function valueAtVoltage(value: string | undefined, voltage: number, unit: string): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/,/g, ".");
  const segment = text.split(";").find((part) => new RegExp(String.raw`\b${voltage}\b`).test(part) && /\bV\b/i.test(part));
  const segmentValue = segment ? maxUnitNumber(segment, unit) : undefined;
  if (segmentValue) return segmentValue;
  const escapedUnit = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(String.raw`(?:\(|\b)${voltage}\s*V(?:\)|\b)[^;]*?(-?\d+(?:\.\d+)?)\s*${escapedUnit}\b`, "i"),
    new RegExp(String.raw`(-?\d+(?:\.\d+)?)\s*${escapedUnit}\b[^;]*?(?:\(|\b)${voltage}\s*V(?:\)|\b)`, "i")
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return String(Number(match[1]));
  }
  return undefined;
}

function horsepowerAtVoltageAsKw(ctx: ResolveContext, voltage: number): string | undefined {
  const value = attr(ctx, /\b(horse ?power rating|horse power rating)\b/i);
  if (!value) return undefined;
  const segment = value.split(";").find((part) => new RegExp(String.raw`\b${voltage}\s*V\b`, "i").test(part) && /\bthree phase\b/i.test(part));
  const hp = segment?.replace(/,/g, ".").match(/(\d+(?:\.\d+)?)(?:\s*-\s*1\/2)?\s*hp\b/i);
  if (!hp) return undefined;
  const fraction = /-1\/2\s*hp\b/i.test(segment ?? "") ? 0.5 : 0;
  const kw = (Number(hp[1]) + fraction) * 0.745699872;
  return Number.isFinite(kw) ? round(kw, 2) : undefined;
}

function minControlVoltage(ctx: ResolveContext, frequency: 50 | 60): string | undefined {
  const value = attr(ctx, /\brated control circuit voltage\b/i) ?? attr(ctx, /\bcontrol voltage\b/i);
  const segment = value?.split(";").find((part) => new RegExp(String.raw`\b${frequency}\s*Hz\b`, "i").test(part));
  return segment?.replace(/,/g, ".").match(/(-?\d+(?:\.\d+)?)\s*(?:\.\.\.|\.{2}|-|to|do)\s*\+?-?\d+(?:\.\d+)?/i)?.[1];
}

/**
 * Find a "max voltage" value scoped to a given polarity (AC / DC). Used for ECLASS codes like
 * AAB909 (max supply voltage with DC) that need the DC-segment of a multi-mode voltage attribute.
 */
function maxVoltageOnPolarity(ctx: ResolveContext, polarity: "ac" | "dc"): string | undefined {
  const sources = [
    attr(ctx, /\brated control circuit voltage\b/i),
    attr(ctx, /\bcontrol voltage\b/i),
    attr(ctx, /\brated operational voltage\b/i),
    attr(ctx, /\bsupply voltage\b/i),
    attr(ctx, /\bnominal voltage\b/i)
  ];
  const polarityPattern = polarity === "dc" ? /\bDC\b/i : /\bAC\b|\b(?:50|60)\s*hz\b/i;
  const candidates: string[] = [];
  for (const value of sources) {
    if (!value) continue;
    for (const segment of value.split(";").map((part) => part.trim()).filter(Boolean)) {
      if (polarityPattern.test(segment)) {
        const max = maxUnitNumber(segment, "V");
        if (max) candidates.push(max);
      }
    }
  }
  if (candidates.length === 0) return undefined;
  return String(Math.max(...candidates.map(Number).filter(Number.isFinite)));
}

/**
 * Extract the lowest numeric voltage from any attribute matching `pattern`, considering both
 * single values and ranges (e.g. "24-60 V" → 24).
 */
function minVoltageOf(ctx: ResolveContext, pattern: RegExp): string | undefined {
  const value = attr(ctx, pattern);
  if (!value) return undefined;
  const numbers = [...value.replace(/,/g, ".").matchAll(/(-?\d+(?:\.\d+)?)\s*V\b/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (numbers.length === 0) return undefined;
  return String(Math.min(...numbers));
}

function degreeOfProtection(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\bdegree of protection\b/i) ?? clean(ctx.result?.normalized.protection);
  const matches = [...(value ?? "").matchAll(/\bIP(?:X\d|\d{2}K?|\d{2})\b/gi)].map((match) => match[0].toUpperCase());
  if (matches.length === 0) return undefined;
  matches.sort((left, right) => ipRank(right) - ipRank(left));
  return matches[0];
}

function ipRank(value: string): number {
  const numeric = Number(value.match(/\d+/)?.[0] ?? 0);
  const suffix = /K$/i.test(value) ? 0.5 : 0;
  const xPenalty = /IPX/i.test(value) ? -100 : 0;
  return numeric + suffix + xPenalty;
}

function dinRailSuitable(ctx: ResolveContext): string | undefined {
  return attr(ctx, /\bmounting on DIN rail\b/i) || attr(ctx, /\bmounting rail\b/i) ? "Yes" : undefined;
}

function materialDeclarationPresent(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(REACH declaration|RoHS declaration|material declaration|conflict minerals reporting template|CMRT)\b/i);
  return value ? "Yes" : undefined;
}

function connectionType(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\bterminal type\b/i) ?? attr(ctx, /\bconnection type\b/i);
  if (!value) return undefined;
  if (/\bring[-\s]?tongue|ring cable|ring terminal/i.test(value)) return "Ring cable connection";
  if (/\bscrew\b/i.test(value)) return "Screw connection";
  if (/\bspring\b/i.test(value)) return "Spring pulley connection";
  if (/\bplug|coupler\b/i.test(value)) return "Plug/coupler";
  return undefined;
}

function actuationType(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\brated control circuit voltage\b/i) ?? attr(ctx, /\bcontrol voltage\b/i);
  if (!value) return undefined;
  if (/\bAC\s*(?:\/|-|\s)\s*DC\b/i.test(value)) return "AC/DC";
  const hasAc = /\b(?:50|60)\s*hz\b|\bAC\b/i.test(value);
  const hasDc = /\bDC\b/i.test(value);
  if (hasAc && hasDc) return "AC/DC";
  if (hasAc) return "AC";
  if (hasDc) return "DC";
  return undefined;
}

function staticPowerLoss(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\bcoil consumption\b/i);
  if (!value) return undefined;
  const dcHolding = value
    .split(";")
    .find((part) => /\b(?:average\s+)?holding\b/i.test(part) && /\bDC\b/i.test(part) && /\bW\b/i.test(part));
  return numberWithUnit(dcHolding ?? value, "W");
}

function gln(ctx: ResolveContext): string | undefined {
  return attr(ctx, /\b(GLN|global location number)\b/i);
}

function iec81346ClassLevel(ctx: ResolveContext, level: 1 | 2 | 3): string | undefined {
  return (
    attr(ctx, new RegExp(String.raw`\b(?:IEC\s*81346|81346).*?(?:class|subclass).*?(?:level\s*)?${level}\b`, "i")) ??
    attr(ctx, new RegExp(String.raw`\b(?:class|subclass).*?(?:level\s*)?${level}.*?(?:IEC\s*81346|81346)\b`, "i"))
  );
}

function mountingOrientation(ctx: ResolveContext): string | undefined {
  return attr(ctx, /\bmounting orientation\b/i) ?? attr(ctx, /\bmounting position\b/i);
}

function rotationValue(ctx: ResolveContext, axis: "horizontal" | "vertical" | "platform", bound: "min" | "max"): string | undefined {
  const axisPattern =
    axis === "horizontal"
      ? /\bhorizontal\b/i
      : axis === "vertical"
        ? /\bvertical\b/i
        : /\b(mounting platform|platform)\b/i;
  const candidates = (ctx.result?.attributes ?? []).filter(
    (a) => axisPattern.test(`${a.group ?? ""} ${a.name}`) && /\b(rotation|angle|tilt)\b/i.test(`${a.group ?? ""} ${a.name}`) && a.value?.trim()
  );
  const value = candidates.length > 0 ? clean(candidates[0].value) : undefined;
  if (!value) return undefined;
  const numbers = [...value.replace(/,/g, ".").matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter(Number.isFinite);
  if (numbers.length === 0) return undefined;
  return String(bound === "min" ? Math.min(...numbers) : Math.max(...numbers));
}

function yesNoAttr(ctx: ResolveContext, pattern: RegExp): string | undefined {
  const value = attr(ctx, pattern);
  if (!value) return undefined;
  if (/\b(no|false|not possible|without|none)\b/i.test(value)) return "No";
  if (/\b(yes|true|possible|present|with|suitable|available)\b/i.test(value)) return "Yes";
  return undefined;
}

function combustibilityClass(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(combustibility|flammability|flame retard|UL\s*94|fire class)\b/i);
  if (!value) return undefined;
  const match = value.toUpperCase().match(/\b(5V|HB|HBF1?|HBF2|V-?0|V-?1|V-?2|VTM-?0|VTM-?1|VTM-?2)\b/);
  return match?.[1].replace(/-/g, "");
}

function certificateApproval(ctx: ResolveContext): string | undefined {
  return clean(ctx.result?.normalized.certificates) ?? attr(ctx, /\b(certificate|approval|approbation|certification)\b/i);
}

function overloadSetting(ctx: ResolveContext, bound: "min" | "max"): string | undefined {
  const value =
    attr(ctx, /\b(overload tripper|overload release|overload protector|setting range|adjustment range)\b/i) ??
    attr(ctx, /\bthermal overload\b/i);
  if (!value) return undefined;
  const text = value.replace(/,/g, ".");
  const numbers = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*(mA|kA|A)\b/gi)]
    .map((match) => Number(maxUnitNumber(`${match[1]} ${match[2]}`, "A")))
    .filter(Number.isFinite);
  if (numbers.length === 0) return undefined;
  return String(bound === "min" ? Math.min(...numbers) : Math.max(...numbers));
}

function conditionalShortCircuitCurrent(ctx: ResolveContext, voltage?: number, targetUnit: "A" | "kA" = "A"): string | undefined {
  const value = attr(ctx, /\b(conditional rated short.?circuit current|rated conditional short.?circuit current|short.?circuit current|Iq\b|SCCR)\b/i);
  if (!value) return undefined;
  const segment =
    voltage === undefined
      ? value
      : value.split(";").find((part) => new RegExp(String.raw`\b${voltage}\b`).test(part) && /\bV\b/i.test(part));
  return numberWithUnit(segment ?? value, targetUnit);
}

function functionType(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\bfunction\b/i) ?? attr(ctx, /\bcontactor type\b/i);
  if (!value) return undefined;
  if (/\bstar[-\s]?delta\b/i.test(value)) return "Star-delta contactor";
  if (/\btwo[-\s]?way\b/i.test(value)) return "Two-way contactor";
  if (/\bmechanical\b/i.test(value)) return "mechanical switch";
  if (/\belectronic\b/i.test(value)) return "electronic switch";
  return undefined;
}

function protocol(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(protocol|fieldbus|bus system|network interface|communication)\b/i);
  if (!value) return undefined;
  const known = [
    "PROFIBUS DP",
    "PROFIBUS PA",
    "PROFIBUS",
    "PROFINET",
    "PROFINET IO",
    "PROFIsafe",
    "EtherCAT",
    "EtherNet/IP",
    "DeviceNet",
    "CANopen",
    "CAN",
    "MODBUS",
    "IO-Link",
    "HART",
    "USB",
    "Foundation Fieldbus"
  ];
  return known.find((name) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(value));
}

function releaseClass(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(release class|trip class|tripping class)\b/i);
  const match = value?.match(/\bCLASS\s*(10|20)\b/i);
  if (match) return `CLASS ${match[1]}`;
  if (/\badjustable\b/i.test(value ?? "")) return "adjustable";
  if (/\bother\b/i.test(value ?? "")) return "Other";
  return undefined;
}

function kindOfMotorStarter(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(kind of motor starter|starter type|motor starter)\b/i);
  if (!value) return undefined;
  if (/\bstar[-\s]?delta\b/i.test(value)) return "Star-delta starter";
  if (/\btwo[-\s]?way\b/i.test(value)) return "Two-way starter";
  if (/\bdirect\b/i.test(value)) return "Direct starter";
  if (/\brepair\b/i.test(value)) return "repair switch";
  if (/\bother\b/i.test(value)) return "Other";
  return undefined;
}

function electricalConnectionDesign(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(design of .*electrical connection|electrical connection|terminal type|connection type)\b/i);
  if (!value) return undefined;
  if (/\bspring\b/i.test(value)) return "Spring pulley connection";
  if (/\bscrew|ring[-\s]?tongue|terminal screw\b/i.test(value)) return "Screw connection";
  if (/\bplug|coupler\b/i.test(value)) return "Plug/coupler";
  if (/\bsolder\b/i.test(value)) return "Soldering lug connection";
  if (/\bwithout\b/i.test(value)) return "Without";
  return undefined;
}

function nemaProtection(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(NEMA|degree of protection.*front)\b/i) ?? clean(ctx.result?.normalized.protection);
  const match = value?.match(/\bNEMA\s*([0-9A-Z, /-]+)/i);
  return match ? `NEMA ${match[1].replace(/\s+/g, " ").trim()}` : undefined;
}

function switchFunction(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\bswitch function\b/i) ?? attr(ctx, /\bfunction\b/i);
  if (!value) return undefined;
  if (/\bon\s*\/\s*off|on off\b/i.test(value)) return "On/Off";
  if (/\bmain switch\b/i.test(value)) return "Main switch";
  if (/\bcontrol switch\b/i.test(value)) return "Control switch";
  if (/\bswitch[-\s]?off\b/i.test(value)) return "Switch-off";
  if (/\bselective\b/i.test(value)) return "Selective switch";
  if (/\blouver\b/i.test(value)) return "Louver switch";
  return undefined;
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
  // ECLASS "Product type (string)" — the classified device category. The combined template cell
  // "AAV774/AAO057" uses CNSTYPECODE, so it still resolves to the typecode.
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
  AAY812: gln, // GLN of manufacturer
  AAU731: productFamily, // Manufacturer product family
  AAU732: productBase, // Manufacturer product base
  AAU733: productOrderSuffix, // Manufacturer product order suffix
  ABA671: articleNumber, // product identifier
  AAU734: longDescription, // Manufacturer product description
  CNS_DESCRIPTION_LONG: longDescription,
  CNS_DESCRIPTION_SHORT: shortDescription,
  BAB577: (ctx) => dimensionMm(ctx, ["depth", "length"]),
  BAF016: (ctx) => dimensionMm(ctx, ["width"]),
  BAA020: (ctx) => dimensionMm(ctx, ["height"]),
  "ENTER GENERAL TABLE NAME": (ctx) => attr(ctx, /\b(general table|custom table)\b/i),
  AAC314: (ctx) => iec81346ClassLevel(ctx, 1) ?? clean(ctx.deviceType),
  "00001C001": (ctx) => iec81346ClassLevel(ctx, 1) ?? clean(ctx.deviceType),
  AAC341: (ctx) => iec81346ClassLevel(ctx, 2),
  IEC_81346_2_SUBCLASS_CODE: (ctx) => iec81346ClassLevel(ctx, 2),
  ABC244: (ctx) => iec81346ClassLevel(ctx, 3),
  IEC_81346_2_SUBCLASS_CODE_3: (ctx) => iec81346ClassLevel(ctx, 3),
  AAO336: mountingOrientation,
  CNS_MOUNTING_ORIENTATION: mountingOrientation,
  CNS_ROTATION_ON_THE_HORIZONTAL_AXIS_MIN: (ctx) => rotationValue(ctx, "horizontal", "min"),
  CNS_ROTATION_ON_THE_HORIZONTAL_AXIS_MAX: (ctx) => rotationValue(ctx, "horizontal", "max"),
  CNS_ROTATION_ON_THE_VERTICAL_AXIS_MIN: (ctx) => rotationValue(ctx, "vertical", "min"),
  CNS_ROTATION_ON_THE_VERTICAL_AXIS_MAX: (ctx) => rotationValue(ctx, "vertical", "max"),
  CNS_ROTATION_OF_THE_MOUNTING_PLATFORM_MIN: (ctx) => rotationValue(ctx, "platform", "min"),
  CNS_ROTATION_OF_THE_MOUNTING_PLATFORM_MAX: (ctx) => rotationValue(ctx, "platform", "max"),

  // --- Device-tab common (best-effort) ---
  REFERENCE_FEATURE_GROUP_ID: eclassNumber,
  REFERENCE_FEATURE_SYSTEM_NAME: (ctx) => (isDeviceSheet(ctx) ? ctx.repair?.eclassSystemVersion ?? "14" : eclassSystem(ctx)),
  AAN521: (ctx) => clean(ctx.result?.normalized.color),
  BAH005: (ctx) =>
    (isContactorSheet(ctx) ? controlVoltageRange(ctx) : undefined) ??
    clean(ctx.result?.normalized.voltage) ??
    attr(ctx, /\b(rated voltage|operating voltage)\b/i),
  AAF726: (ctx) =>
    (isContactorSheet(ctx) ? ctx.repair?.ratedCurrent ?? ratedOperationalCurrent(ctx) : undefined) ??
    maxUnitNumber(ctx.result?.normalized.current, "A") ??
    maxUnitNumber(attr(ctx, /\b(rated current|operating current)\b/i), "A"),
  AAC820: (ctx) => ctx.repair?.operatingTemperatureMin ?? attr(ctx, /\bmin(?:imum)?\b.*\btemperature\b/i) ?? tempRange(ctx).min,
  AAC821: (ctx) => ctx.repair?.operatingTemperatureMax ?? attr(ctx, /\bmax(?:imum)?\b.*\btemperature\b/i) ?? tempRange(ctx).max,
  // Numeric / integer / free-text device fields that are SAFE to fill (the enum-coded device
  // columns like "Voltage type 1-AC 2-DC" or IP/NEMA are deliberately left blank — they need a
  // value-to-code mapping, and writing the raw scraped string there would be wrong).
  AAS575: (ctx) => ctx.repair?.powerLossPerPole ?? numberWithUnit(attr(ctx, /\bpower loss\b/i), "W"), // Power loss per pole [W]
  AAT080: (ctx) => numberOf(attr(ctx, /\b(number of poles|pole number|no\.? of poles|poles)\b/i)), // Pole number
  AAP798: (ctx) => attr(ctx, /\b(application standards|standards?)\b/i), // Application standards
  AAB821: ratedOperationalCurrent, // Max. rated operating current [A]
  AAC824: ratedOperationalCurrent, // Nominal current
  AAF583: ratedOperationalVoltage, // Nominal voltage
  BAG975: degreeOfProtection, // degree of protection
  BAC140: combustibilityClass, // Combustibility class
  BAB392: certificateApproval, // certificate/approval
  AAB456: (ctx) => valueAtVoltage(attr(ctx, /\brated operational power AC-3\b/i), 400, "kW"), // AC-3 power at 400 V
  AAC828: (ctx) => overloadSetting(ctx, "min"), // Lowest value of setting range for overload tripper
  AAB447: (ctx) => conditionalShortCircuitCurrent(ctx, undefined, "kA"), // Conditional rated short-circuit current Iq
  AAB460: ratedOperationalCurrent, // Rated operating current Ie
  AAB542: (ctx) => overloadSetting(ctx, "max"), // Greatest value of overload release adjustment range
  AAB667: dinRailSuitable, // suitable for mounting onto standard rails
  BAC426: functionType, // Function
  BAC378: connectionType, // Connection type
  AAS568: (ctx) => conditionalShortCircuitCurrent(ctx, 480, "A"), // SCC type 1, 480 Y/277 V
  BAA303: staticPowerLoss, // Power loss, static, current-independent [Pls]
  AAB958: (ctx) => minControlVoltage(ctx, 50), // min. rated control voltage Us with AC 50 Hz
  AAB959: (ctx) => minControlVoltage(ctx, 60), // min. rated control voltage Us with AC 60 Hz
  AAC148: (ctx) => yesNoAttr(ctx, /\bisolating function\b/i), // isolating function present
  BAA297: protocol, // Type of protocol
  BAC050: actuationType, // Type of actuation
  AAN354: materialDeclarationPresent, // material declaration
  AAH656: (ctx) => overloadSetting(ctx, "min"), // min. overload protector
  AAS573: (ctx) => yesNoAttr(ctx, /\btemperature compensated overload protection\b/i), // Temperature compensated overload protection
  BAD304: (ctx) => yesNoAttr(ctx, /\bbearing track assembly\b/i), // Bearing track assembly possible
  AAS574: ratedOperationalCurrent, // Rated current for power loss specification
  AAB438: releaseClass, // Release class
  AAB476: (ctx) => valueAtVoltage(attr(ctx, /\brated operational current AC-3\b/i), 400, "A"), // Ie AC-3, 400 V
  AAS566: (ctx) => horsepowerAtVoltageAsKw(ctx, 460), // Rated power, 460 V, 60 Hz, 3-phase
  AAS569: (ctx) => conditionalShortCircuitCurrent(ctx, 600, "A"), // SCC type 1, 600 Y/347 V
  AAM479: protocol, // supported protocol
  AAH655: (ctx) => overloadSetting(ctx, "max"), // max. overload protector
  AAS565: kindOfMotorStarter, // Kind of motor starter
  AAB416: electricalConnectionDesign, // Aux/control electrical connection
  AAS567: (ctx) => horsepowerAtVoltageAsKw(ctx, 575), // Rated power, 575 V, 60 Hz, 3-phase
  AAB455: (ctx) => valueAtVoltage(attr(ctx, /\brated operational power AC-3\b/i), 230, "kW"), // AC-3 power at 230 V
  AAS570: (ctx) => conditionalShortCircuitCurrent(ctx, 230, "A"), // SCC type 2, 230 V
  AAP406: (ctx) => numberOf(attr(ctx, /\bnumber of control centers\b/i)), // Number of control centers
  BAD346: (ctx) => yesNoAttr(ctx, /\bexternal reset\b/i), // External reset possible
  BAD706: (ctx) => yesNoAttr(ctx, /\b(emergency[-\s]?off|emergency stop)\b/i), // suitable for EMERGENCY-OFF
  AAZ487: nemaProtection, // Degree of protection (NEMA), front side
  AAP697: (ctx) => numberOf(attr(ctx, /\bnumber of signal lamps\b/i)), // Number of signal lamps
  AAB414: electricalConnectionDesign, // Design of the electrical connection
  AAN384: (ctx) => yesNoAttr(ctx, /\bover.*under voltage detection\b|\bvoltage detection\b/i), // over/under voltage detection
  AAN375: (ctx) => yesNoAttr(ctx, /\bover.*under current detection\b|\bcurrent detection\b/i), // over/under current detection
  BAC915: switchFunction, // Switch function
  AAB491: (ctx) => numberWithUnit(attr(ctx, /\b(insulation voltage|isolation voltage)\b/i), "V"), // rated isolation voltage [V]
  AAB492: (ctx) => numberWithUnit(attr(ctx, /\b(short.?time.*withstand current|withstand current.*icw|\bicw\b)/i), "kA"), // Icw [kA]
  AAB815: (ctx) => numberWithUnit(attr(ctx, /\b(rated operational voltage|max\.?\s*rated operating voltage)\b/i), "V"), // max operating voltage Ue [V]
  // Enum column (raw value -> encoded to a code by the exporter via the column legend).
  BAD915: (ctx) => (isContactorSheet(ctx) ? controlVoltageType(ctx) : undefined) ?? attr(ctx, /\b(current type|voltage type)\b/i),

  // --- Cross-tab common properties ---
  // AAB485 "rated permanent current Iu" is in practice the same continuous-current rating that
  // AAB821 / AAC824 / AAB460 expose under different ECLASS codes. Sharing the resolver fills it
  // on every tab where Iu appears (Motion Controller, Luminaire, Switch, motor protection, …).
  AAB485: ratedOperationalCurrent,
  // Rated impulse withstand voltage Uimp [kV]
  AAB814: (ctx) => numberWithUnit(attr(ctx, /\b(impulse withstand voltage|rated impulse voltage|\buimp\b)\b/i), "kV"),
  // Max. supply voltage with DC — pick the highest DC volt number from any DC-tagged voltage attr.
  AAB909: (ctx) => maxVoltageOnPolarity(ctx, "dc"),
  // min. permissible voltage at input / output
  AAC031: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)?\s+(?:permissible\s+)?voltage|voltage\s+(?:min(?:imum)?)|input\s+voltage range)\b/i),
  AAC030: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)?\s+(?:permissible\s+)?(?:output\s+)?voltage|output\s+voltage\s+(?:range|min(?:imum)?))\b/i),
  // I/O counts — common on PLC / Motion Controller / Luminaire / Generator tabs
  AAP341: (ctx) => numberOf(attr(ctx, /\b(?:number of\s+)?analog(?:ue)?\s+(?:input(?:s)?|in\b)\b/i)),
  AAP342: (ctx) => numberOf(attr(ctx, /\b(?:number of\s+)?analog(?:ue)?\s+(?:output(?:s)?|out\b)\b/i)),
  AAP508: (ctx) => numberOf(attr(ctx, /\b(?:number of\s+)?digital\s+(?:input(?:s)?|in\b)\b/i)),
  AAP610: (ctx) => numberOf(attr(ctx, /\b(?:number of\s+)?digital\s+(?:output(?:s)?|out\b)\b/i)),
  // Configurable I/O flags (yes/no enum)
  AAM485: (ctx) => yesNoAttr(ctx, /\bdigital outputs?,?\s+configurable\b/i),
  AAM486: (ctx) => yesNoAttr(ctx, /\banalog(?:ue)?\s+(?:input|output)s?,?\s+configurable\b/i),
  // Installation depth (mm)
  BAA211: (ctx) => dimensionMm(ctx, ["installation depth", "mounting depth", "built[-\\s]?in depth"]),
  // Device type enum — fall through to the classified deviceType so it lands as the human label
  // (the exporter will encode it to a code only when the legend has an exact match).
  AAB711: (ctx) => clean(ctx.deviceType),
  // Connection type for auxiliary circuit (separate from main connection type)
  BAC379: connectionType,
  // Design of electrical connection (alternative ECLASS code)
  BAD831: electricalConnectionDesign,
  // Rated breaking capacity at AC-3 / similar — reuse rated operational current for now
  AAB400: ratedOperationalCurrent,
  // Application standards (cross-tab variants)
  AAB838: (ctx) => attr(ctx, /\b(application standards|standards?)\b/i),
  AAB839: (ctx) => attr(ctx, /\b(application standards|standards?)\b/i),
  // Connection cross-section (mm²)
  AAB733: (ctx) => numberWithUnit(attr(ctx, /\b(connectable conductor cross[-\s]?section|conductor cross[-\s]?section|connection cross[-\s]?section)\b/i), "mm"),
  // min. operating voltage with AC 50/60 Hz — alternate ECLASS codes for the same property family.
  AAB971: (ctx) => minControlVoltage(ctx, 50),
  AAB972: (ctx) => minControlVoltage(ctx, 60),
  // Min / Max ambient temperature — alias to the existing operating-temperature resolvers so
  // every tab that uses BAA038/BAA039 instead of AAC820/AAC821 still gets filled.
  BAA038: (ctx) => ctx.repair?.operatingTemperatureMin ?? attr(ctx, /\bmin(?:imum)?\b.*\b(?:ambient|operating)\b.*\btemp/i) ?? tempRange(ctx).min,
  BAA039: (ctx) => ctx.repair?.operatingTemperatureMax ?? attr(ctx, /\bmax(?:imum)?\b.*\b(?:ambient|operating)\b.*\btemp/i) ?? tempRange(ctx).max,
  // Generic color / material codes used across many device tabs (parallel to AAN521 etc).
  BAA351: (ctx) => clean(ctx.result?.normalized.color) ?? attr(ctx, /\bcolou?r\b/i),
  BAB664: (ctx) => clean(ctx.result?.normalized.material) ?? attr(ctx, /\bmaterial\b/i),
  BAC461: (ctx) => attr(ctx, /\bmaterial of housing|housing material\b/i) ?? clean(ctx.result?.normalized.material),
  // Surface / finish description
  BAF785: (ctx) => attr(ctx, /\b(surface|finish|surface treatment)\b/i),
  // Conductor connection method (Phoenix / Weidmüller-style) — reuse connection-type heuristics
  AAS458: connectionType
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
  return maxUnitNumber(value, unit);
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

export function hasPropertyResolver(code: string, propName: string): boolean {
  return propertyKeys(code, propName).some((key) => Boolean(RESOLVERS[key]));
}

function propertyKeys(code: string, propName: string): string[] {
  const keys = new Set<string>();
  for (const raw of [propName, code]) {
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
