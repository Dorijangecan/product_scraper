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

function sensorConnectionType(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(connection type|connection)\b/i);
  if (!value) return undefined;
  if (/\bpipe\b/i.test(value)) return "pipe in-lead";
  if (/\b(open|free)\s+(?:cable|wire)\s+end\b/i.test(value)) return "open cable end";
  if (/\bcable\b/i.test(value) && /\bplug|connector|m\d+/i.test(value)) return "Cable with plug connection";
  if (/\bplug|connector|coupler|m\d+/i.test(value)) return "Plug-in connection";
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
  const value = attr(ctx, /\bmounting orientation\b/i) ?? attr(ctx, /\bmounting position\b/i);
  if (!value) return undefined;
  if (/\bvertical\b.*\bdown\b|\bdown\b.*\bvertical\b/i.test(value)) return "vertical down";
  if (/\bvertical\b.*\bup\b|\bup\b.*\bvertical\b/i.test(value)) return "vertical up";
  if (/\bhorizontal\b/i.test(value)) return "horizontal";
  if (/\bvertical\b/i.test(value)) return "vertical";
  return undefined;
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

function certificateApprovalEnum(ctx: ResolveContext): string | undefined {
  const value = certificateApproval(ctx);
  if (!value) return undefined;
  if (/\bV-Label\s+VEGETARIAN\b/i.test(value)) return "V-Label VEGETARIAN";
  if (/\bV-Label\s+VEGAN\b/i.test(value)) return "V-Label VEGAN";
  if (/\bBG[-\s]?PR(?:Ü|U)FZERT\b/i.test(value)) return "BG-PRÜFZERT";
  const blueAngel = value.match(/\bBlue Angel\b(?:\s*\((?:DE|RAL)-UZ\s*\d+[a-z]?\))?/i);
  if (blueAngel) return blueAngel[0].replace(/\s+/g, " ");
  return undefined;
}

function limitedApproval(ctx: ResolveContext): string | undefined {
  const value = certificateApproval(ctx);
  if (!value) return undefined;
  const labels = ["measuring instruments directive", "domestic", "DIN EN 1373", "OSA", "SUVA", "VBG 49"];
  return labels.find((label) => new RegExp(String.raw`\b${escapeRegex(label)}\b`, "i").test(value));
}

function qualityCharacteristicRecord(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(quality characteristic record|test certificate|certificate)\b/i);
  if (!value) return undefined;
  if (/\bcertificate of conformity\b|\b2\.1\b/i.test(value)) return "2.1, Certificate of conformity";
  if (/\bwork'?s test certificate\b|\b2\.3\b/i.test(value)) return "2.3, Work's test certificate";
  if (/\btest certificate\b|\b2\.2\b/i.test(value)) return "2.2, Test certificate";
  const inspection = value.match(/\b3\.1\.?([ABC])\b/i);
  if (inspection) return `3.1.${inspection[1].toUpperCase()}, Inspection certificate 3.1.${inspection[1].toUpperCase()}`;
  return undefined;
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
  return knownProtocolLabel(value);
}

function knownProtocolLabel(value: string): string | undefined {
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
  if (/\baxial\s+screw\b/i.test(value)) return "axial screw connection";
  if (isSensorSheet(ctx) && /\bscrew|terminal screw\b/i.test(value)) return undefined;
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

function isSensorSheet(ctx: ResolveContext): boolean {
  return ["electronic sensor", "optical sensor", "safety sensor", "sensor - fluid"].includes(ctx.sheetName ?? "");
}

function singleNemaProtection(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(NEMA|degree of protection.*front)\b/i) ?? clean(ctx.result?.normalized.protection);
  const tokens = nemaTokens(value);
  return tokens.length === 1 ? `NEMA ${tokens[0]}` : undefined;
}

function nemaTokens(value: string | undefined): string[] {
  if (!value) return [];
  const tokens = [...value.matchAll(/\b(?:NEMA\s*)?(?:TYPE\s*)?([0-9][0-9A-Z]*)\b/gi)].map((match) => match[1].toUpperCase());
  return [...new Set(tokens)];
}

function constructionForm(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(construction form|construction)\b/i);
  if (!value) return undefined;
  if (/\bfront panel\b.*\bwall\b|\bwall\b.*\bfront panel\b/i.test(value)) return "Wall assembly+front panel installation (72*72)";
  if (/\bfront panel\b/i.test(value)) return "Front panel installation (72*72)";
  if (/\bserial installation\b/i.test(value)) return "Serial installation";
  if (/\bwall (?:assembly|mount|mounted|installation)\b/i.test(value)) return "Wall assembly";
  if (/\bindividual part\b/i.test(value)) return "Individual part";
  if (/\bassembly kit\b/i.test(value)) return "Assembly kit";
  return undefined;
}

function surfaceTreatment(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(surface|finish|surface treatment)\b/i);
  if (!value || /^finish$/i.test(value.trim())) return undefined;
  if (/\bhot[-\s]?dip galvan/i.test(value)) return "Hot-dip galvanized";
  if (/\bgalvan/i.test(value)) return "Galvanized";
  if (/\bbrushed\b/i.test(value)) return "brushed";
  if (/\banodized\b/i.test(value)) return "Anodized";
  if (/\bcopper[-\s]?plated\b/i.test(value)) return "copper-plated";
  if (/\bnickel[-\s]?plated\b/i.test(value)) return "nickel-plated";
  if (/\bchromalized\b/i.test(value)) return "Chromalized";
  if (/\blacquered\b/i.test(value)) return "lacquered";
  return undefined;
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

function attrValue(pattern: RegExp): Resolver {
  return (ctx) => attr(ctx, pattern);
}

function attrExcept(ctx: ResolveContext, pattern: RegExp, reject: RegExp): string | undefined {
  const attributes = ctx.result?.attributes ?? [];
  const matches = attributes.filter((a) => {
    const key = `${a.group ?? ""} ${a.name}`;
    return pattern.test(key) && !reject.test(key) && a.value?.trim();
  });
  if (matches.length === 0) return undefined;
  matches.sort((l, r) => sourceRank(r.sourceType) - sourceRank(l.sourceType) || (r.confidence ?? 0) - (l.confidence ?? 0));
  return clean(matches[0].value);
}

function attrNumber(pattern: RegExp): Resolver {
  return (ctx) => numberOf(attr(ctx, pattern));
}

function attrUnitNumber(pattern: RegExp, unit: string): Resolver {
  return (ctx) => numberWithUnit(attr(ctx, pattern), unit);
}

function attrYesNo(pattern: RegExp): Resolver {
  return (ctx) => yesNoAttr(ctx, pattern);
}

function attrFlag(pattern: RegExp): Resolver {
  return (ctx) => {
    const value = attr(ctx, pattern);
    if (!value) return undefined;
    return yesNoFromValue(value) ?? "Yes";
  };
}

function yesNoFromValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/\b(no|false|not possible|without|none|not available|absent)\b/i.test(value)) return "No";
  if (/\b(yes|true|possible|present|with|suitable|available|included|integrated)\b/i.test(value)) return "Yes";
  return undefined;
}

function complianceReference(ctx: ResolveContext, topic: RegExp): string | undefined {
  const valueUrl = firstUrl(attr(ctx, topic));
  if (valueUrl) return valueUrl;
  return ctx.result?.documents?.find((doc) => topic.test(`${doc.label} ${doc.url}`))?.url;
}

function firstUrl(value: string | undefined): string | undefined {
  return value?.match(/https?:\/\/\S+/i)?.[0];
}

function compliancePresent(ctx: ResolveContext, topic: RegExp): string | undefined {
  return yesNoAttr(ctx, topic) ?? (complianceReference(ctx, topic) ? "Yes" : undefined);
}

function voltageType(ctx: ResolveContext): string | undefined {
  return controlVoltageType(ctx) ?? attr(ctx, /\b(voltage type|current type|operating voltage type)\b/i);
}

function interfaceDesign(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\binterface design\b/i);
  return (value ? knownProtocolLabel(value) : undefined) ?? protocol(ctx);
}

function threadSize(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(thread size|connection thread|thread)\b/i);
  return value?.match(/\bM\d+(?=\D|$)/i)?.[0].toUpperCase() ?? value;
}

function connectorType(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(type of connector|connector type|connection type|connection)\b/i);
  if (!value) return undefined;
  if (/\bRJ45\b/i.test(value)) return "RJ45";
  if (/\bMicro[-\s]?USB\b/i.test(value)) return "Micro-USB";
  if (/\bUSB\b/i.test(value)) return "USB";
  if (/\bD[-\s]?Sub\s*9\b/i.test(value)) return "D-Sub 9-pole";
  if (/\bD[-\s]?Sub\s*15\b/i.test(value)) return "D-Sub 15-pole";
  if (/\bD[-\s]?Sub\s*25\b/i.test(value)) return "D-Sub 25-pole";
  if (/\bD[-\s]?Sub\s*37\b/i.test(value)) return "D-Sub 37-pole";
  if (/\bD[-\s]?Sub\s*50\b/i.test(value)) return "D-Sub 50-pole";
  if (/\bSCRJ\b/i.test(value)) return "SCRJ";
  if (/\bconnector\b|\bM\d+\b/i.test(value)) return "Circular connector";
  return undefined;
}

function connectorCoding(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(coding|connector coding)\b/i);
  if (!value) return undefined;
  const match = value.match(/\b([A-Z])[-\s]?coded\b/i);
  return match ? `${match[1].toUpperCase()}-coded` : undefined;
}

function genericMaterial(ctx: ResolveContext): string | undefined {
  return normalizedMaterial(ctx) ?? materialAttribute(ctx, /\bmaterial\b/i);
}

function housingMaterial(ctx: ResolveContext): string | undefined {
  return materialAttribute(ctx, /\b(material of (?:the )?housing|housing material)\b/i) ?? normalizedMaterial(ctx);
}

function structuredHousingMaterial(ctx: ResolveContext): string | undefined {
  const value = housingMaterial(ctx);
  if (!value) return undefined;
  if (/\bpbtp?\b|\bpolybutylene terephthalate\b/i.test(value)) return "Plastic (PBT)";
  if (/\bABS\b/i.test(value)) return "Plastic (ABS)";
  if (/\bAlMgSi\b/i.test(value)) return "AlMgSi";
  if (/\bstainless steel\b|\bV2A\b/i.test(value)) return "Stainless steel V2A";
  if (/\baluminium die[-\s]?cast|aluminum die[-\s]?cast|die[-\s]?cast aluminum/i.test(value)) return "aluminium die-cast";
  if (/\baluminium\b|\baluminum\b/i.test(value)) return "aluminum";
  if (/\bbrass\b/i.test(value) && /\bnickel[-\s]?plated\b/i.test(value)) return "brass nickel-plated";
  if (/\bbrass\b/i.test(value)) return "Brass";
  if (/\bceramic\b/i.test(value)) return "Ceramic";
  return undefined;
}

function housingSurfaceDesign(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(design of housing surface|housing surface|surface)\b/i);
  if (!value) return undefined;
  if (/\bnickel[-\s]?plated\b/i.test(value)) return "nickel-plated";
  if (/\banodized\b/i.test(value)) return "Anodized";
  if (/\bchromalized\b/i.test(value)) return "Chromalized";
  if (/\bchromium[-\s]?plated\b/i.test(value)) return "Chromium-plated";
  if (/\blacquered\b/i.test(value)) return "lacquered";
  if (/\bnot applicable\b|\bN\/A\b/i.test(value)) return "Not applicable";
  if (/\bplastic[-\s]?coated\b/i.test(value)) return "Plastic-coated";
  if (/\bpowder[-\s]?coated\b/i.test(value)) return "powder-coated";
  if (/\brubberized\b/i.test(value)) return "Rubberized";
  if (/\btin[-\s]?plated\b/i.test(value)) return "Tin-plated";
  if (/\buncoated\b/i.test(value)) return "Uncoated";
  return undefined;
}

function materialAttribute(ctx: ResolveContext, pattern: RegExp): string | undefined {
  return safeMaterialValue(
    attrExcept(
      ctx,
      pattern,
      /\b(compliance|declaration|conflict minerals|CMRT|RoHS|REACH|information|document|certificate|template|regulation)\b/i
    )
  );
}

function normalizedMaterial(ctx: ResolveContext): string | undefined {
  return safeMaterialValue(clean(ctx.result?.normalized.material));
}

function safeMaterialValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d[A-Z0-9]{7,}$/i.test(value.trim())) return undefined;
  if (/\b(directive|declaration|regulation|certificate|template|compliance)\b/i.test(value)) return undefined;
  return value;
}

function colorValue(ctx: ResolveContext, pattern: RegExp = /\bcolou?r\b/i): string | undefined {
  return safeColorValue(clean(ctx.result?.normalized.color)) ?? safeColorValue(attr(ctx, pattern));
}

function safeColorValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (looksLikeSourceFragment(value)) return undefined;
  return value;
}

function ralColorNumber(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(RAL|colou?r(?: number)?)\b/i) ?? colorValue(ctx);
  return value?.match(/\b\d{3,4}\b/)?.[0];
}

function countryOfOrigin(ctx: ResolveContext): string | undefined {
  return safeCountryValue(attr(ctx, /\b(country of customs tariff number|country of origin|customs country|origin country|country of manufacture)\b/i));
}

function safeCountryValue(value: string | undefined): string | undefined {
  if (!value || looksLikeSourceFragment(value)) return undefined;
  if (!/^[A-Z]{2}$|^[A-Za-z][A-Za-z .'-]+$/i.test(value)) return undefined;
  return value;
}

function outputCategory(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(output)\b/i);
  if (!value) return undefined;
  if (/\banalog\b/i.test(value) && /\bcurrent\b/i.test(value)) return "Analog current output (s3)";
  if (/\banalog\b/i.test(value) && /\bvoltage\b/i.test(value)) return "Analog voltage output (s3)";
  if (/\bNAMUR\b/i.test(value)) return "Binary output (NAMUR)";
  if (/\b(PNP|NPN|semiconductor|electronic|switch(?:ing)? output|normally open|normally closed)\b/i.test(value)) return "Binary electronic output";
  if (/\bbinary\b/i.test(value) && /\bisolat/i.test(value)) return "Binary isolated output";
  if (/\bbinary\b/i.test(value) && /\bcurrent\b/i.test(value)) return "Binary current output";
  return undefined;
}

function protectionClass(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\bprotection class\b/i);
  if (!value || /\bIP\s*\d/i.test(value)) return undefined;
  if (/\bclass\s*0\b|\b0\b/i.test(value)) return "Protection class 0";
  if (/\bclass\s*1\b|\bI\b/.test(value)) return "Protection class 1";
  if (/\bclass\s*2\b|\bII\b/.test(value)) return "Protection class 2";
  if (/\bclass\s*3\b|\bIII\b/.test(value)) return "Protection class 3";
  if (/\bwithout|none\b/i.test(value)) return "without";
  return undefined;
}

function switchingElementFunction(ctx: ResolveContext): string | undefined {
  const value = attrExcept(ctx, /\b(switching element function|switch element function|switching function)\b/i, /\boptical\b/i);
  if (!value) return undefined;
  if (/\bnormally\s+open\b/i.test(value) || /\bNO\b/.test(value)) return "Normally open contact";
  if (/\bnormally\s+clos(?:e|ed)\b/i.test(value) || /\bNC\b/.test(value)) return "Normally close contact";
  if (/\bchange[-\s]?over\b/i.test(value)) return "Changeover contact (NO/NC)";
  return value;
}

function functionPrinciple(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(function principle|principle of operation)\b/i);
  if (!value) return undefined;
  const labels = [
    "adjustable",
    "detent",
    "inductive",
    "magnetostrictional",
    "potentiometric",
    "quiescent current",
    "working current",
    "hall",
    "energetically",
    "Background fadeout",
    "Foreground fadeout",
    "running time",
    "geometric"
  ];
  return labels.find((label) => new RegExp(String.raw`\b${escapeRegex(label)}\b`, "i").test(value));
}

function measurementPrinciple(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(measurement principle|measuring principle)\b/i);
  if (!value) return undefined;
  const labels = [
    "FMCW HF",
    "conductivity measurement",
    "delay time measuring",
    "mechanic measuring",
    "optical",
    "photoelectric",
    "Ultrasound",
    "coriolis (mass)",
    "magnetic-inductive",
    "thermal"
  ];
  return labels.find((label) => new RegExp(String.raw`\b${escapeRegex(label)}\b`, "i").test(value));
}

function settingOption(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(setting option|setting)\b/i);
  if (!value) return undefined;
  if (/\bauto(?:matic)?\b/i.test(value)) return "Automatic";
  if (/\bmanual\b/i.test(value)) return "manual setting";
  if (/\bparameter/i.test(value)) return "Parameterization";
  if (/\bteach[-\s]?in\b/i.test(value)) return "Teach-In";
  return undefined;
}

function lightType(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(type of light|light type)\b/i);
  if (!value) return undefined;
  if (/\blaser\b/i.test(value) && /\binfrared\b/i.test(value)) return "Laser diode, infrared light";
  if (/\blaser\b/i.test(value) && /\bred\b/i.test(value)) return "Laser diode, red light";
  if (/\binfrared\b/i.test(value)) return "Infrared light";
  if (/\bblue\b/i.test(value)) return "Blue light";
  if (/\bgreen\b/i.test(value)) return "Green light";
  if (/\bwhite\b/i.test(value)) return "White light";
  if (/\bUV\b/i.test(value)) return "UV light";
  if (/\bmulticolou?r|multi[-\s]?colou?r/i.test(value)) return "multicolor light";
  if (/\bred\b/i.test(value) && /\bnon[-\s]?polarized\b/i.test(value)) return "Red light, non-polarized";
  if (/\bred\b/i.test(value) && /\bpolarized\b/i.test(value)) return "Red light, polarized";
  return undefined;
}

function suitabilityForApplication(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(suitability for application|application suitability|suitable application|suitable for)\b/i);
  if (!value) return undefined;
  if (/\bdistributed control system\b|\bDCS\b/i.test(value)) return "Distributed Control System";
  if (/\bmanufacturing industry\b/i.test(value)) return "manufacturing industry";
  if (/\bprocess industry\b/i.test(value)) return "process industry";
  if (/\bcontrol\b/i.test(value)) return "Control";
  return undefined;
}

function screenOverStrandingElement(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(screen over stranding element|screen|shield)\b/i);
  if (!value) return undefined;
  const hasFilm = /\b(film|foil|aluminum foil|aluminium foil)\b/i.test(value);
  const hasBraid = /\b(braid|braided|plaited|fabric)\b/i.test(value);
  if (hasFilm && hasBraid) return "Film + fabric";
  if (hasFilm) return "Film";
  if (hasBraid) return "Plaited";
  if (/\b(without|none|unshielded)\b/i.test(value)) return "Without";
  return undefined;
}

function mediumValue(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(medium)\b/i);
  if (!value || looksLikeSourceFragment(value)) return undefined;
  if (/\b(passed to|entering|transition-colors|text-accent)\b/i.test(value)) return undefined;
  return value;
}

function ioLinkRevision(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(IO[- ]Link revisions?[- ]ID|IO[- ]Link revision)\b/i);
  const match = value?.match(/\bV?\s*(1\.[01])\b/i);
  return match ? `V${match[1]}` : undefined;
}

function mechanicalInstallationCondition(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(mechanical installation conditions|installation condition|flush)\b/i);
  if (!value) return undefined;
  if (/\bnot[-\s]?flush\b/i.test(value)) return "not flush";
  if (/\bquasi[-\s]?flush\b/i.test(value)) return "quasi-flush";
  if (/\bflush\b/i.test(value)) return "flush";
  return undefined;
}

function performanceLevel(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(performance level|EN ISO 13849|PL\b)\b/i);
  if (!value) return undefined;
  const pl = value.match(/\bPL\s*([A-E])\b/i);
  if (pl) return `PL ${pl[1].toLowerCase()}`;
  const single = value.trim().match(/^[A-E]$/i);
  if (single) return single[0].toUpperCase();
  if (/\bwithout\b/i.test(value)) return "without";
  return undefined;
}

function powerSupplyDesign(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\bdesign\b/i);
  if (!value) return undefined;
  if (/\bbuilt[-\s]?in[-\s]?device\b/i.test(value)) return "built-in-device";
  if (/\bcabinet device\b/i.test(value)) return "cabinet device";
  return undefined;
}

function safetyIntegrityLevel(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(safety integrity level|SIL)\b/i);
  if (!value) return undefined;
  if (/\bwithout|none\b/i.test(value)) return "without";
  const match = value.match(/\bSIL\s*([1-4])\b/i);
  return match ? `SIL ${match[1]}` : undefined;
}

function lightSource(ctx: ResolveContext): string | undefined {
  const value = attr(ctx, /\b(light source)\b/i);
  if (!value) return undefined;
  if (/\blaser\b/i.test(value)) return "laser diode";
  if (/\bLED\b/i.test(value)) return "LED";
  return undefined;
}

function looksLikeSourceFragment(value: string): boolean {
  return /[<>]|'\s*\+|\+\s*'|;\s*["']?\s*>|\b(var|const|function|selected|originalText)\b/i.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pressureValue(ctx: ResolveContext, pattern: RegExp): string | undefined {
  return pressureBound(ctx, "max", pattern);
}

function pressureBound(ctx: ResolveContext, bound: "min" | "max", pattern: RegExp): string | undefined {
  const value = attr(ctx, pattern);
  if (!value) return undefined;
  const text = value.replace(/,/g, ".");
  const units = [
    { rx: /(-?\d+(?:\.\d+)?)\s*bar\b/gi, factor: 1 },
    { rx: /(-?\d+(?:\.\d+)?)\s*mbar\b/gi, factor: 0.001 },
    { rx: /(-?\d+(?:\.\d+)?)\s*MPa\b/gi, factor: 10 },
    { rx: /(-?\d+(?:\.\d+)?)\s*kPa\b/gi, factor: 0.01 }
  ];
  const values = units.flatMap(({ rx, factor }) => [...text.matchAll(rx)].map((match) => Number(match[1]) * factor));
  const finite = values.filter(Number.isFinite);
  if (finite.length > 0) return round(bound === "min" ? Math.min(...finite) : Math.max(...finite), 3);
  return numberOf(text);
}

function temperatureBound(ctx: ResolveContext, side: "min" | "max", pattern: RegExp): string | undefined {
  const split = splitTemperatureRange(attr(ctx, pattern));
  return side === "min" ? split.min : split.max;
}

function lengthValue(ctx: ResolveContext, pattern: RegExp): string | undefined {
  const value = attr(ctx, pattern);
  return numberWithUnit(value, "mm") ?? numberOf(value);
}

function dimensionValue(ctx: ResolveContext, dims: string[], pattern: RegExp): string | undefined {
  return dimensionMm(ctx, dims) ?? lengthValue(ctx, pattern);
}

function voltageValue(ctx: ResolveContext, pattern: RegExp): string | undefined {
  const value = attr(ctx, pattern);
  return numberWithUnit(value, "V") ?? numberOf(value);
}

function minVoltageValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/,/g, ".");
  const range = text.match(/(-?\d+(?:\.\d+)?)\s*(?:\.\.\.|\.{2}|-|to|do)\s*\+?(-?\d+(?:\.\d+)?)/i);
  if (range) return String(Math.min(Number(range[1]), Number(range[2])));
  const numbers = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*V\b/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (numbers.length > 0) return String(Math.min(...numbers));
  return numberOf(value);
}

function minSupplyVoltage(ctx: ResolveContext): string | undefined {
  return (
    minVoltageOf(ctx, /\b(min(?:imum)? supply voltage|min(?:imum)? input voltage)\b/i) ??
    minVoltageValue(attrExcept(ctx, /\b(supply voltage|input voltage)\b/i, /\bmax(?:imum)?|rated supply voltage with AC\b/i))
  );
}

function currentValue(ctx: ResolveContext, pattern: RegExp): string | undefined {
  const value = attr(ctx, pattern);
  return numberWithUnit(value, "A") ?? numberOf(value);
}

function powerValue(ctx: ResolveContext, pattern: RegExp): string | undefined {
  const value = attr(ctx, pattern);
  return numberWithUnit(value, "W") ?? numberWithUnit(value, "kW") ?? numberOf(value);
}

function percentageValue(ctx: ResolveContext, pattern: RegExp): string | undefined {
  const value = attr(ctx, pattern);
  return numberOf(value);
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
  CNS_ELECTRO_MATERIAL: genericMaterial,
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
  AAN521: (ctx) => colorValue(ctx),
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
  BAB392: certificateApprovalEnum, // certificate/approval
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
  // PDT "Device type" is a physical installation enum (e.g. "Built-in unit"), not our product
  // classification label ("PLC", "Switch", ...). Only fill it from an explicit matching source
  // attribute; otherwise leave it blank rather than writing a wrong enum value.
  AAB711: attrValue(/\b(?:PDT\s+)?device type\b/i),
  // Connection type for auxiliary circuit (separate from main connection type)
  BAC379: connectionType,
  // Design of electrical connection (alternative ECLASS code)
  BAD831: electricalConnectionDesign,
  // Rated breaking capacity at AC-3 / similar — reuse rated operational current for now
  AAB400: interfaceDesign,
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
  BAA351: (ctx) => colorValue(ctx),
  BAB664: genericMaterial,
  BAC461: structuredHousingMaterial,
  // Surface / finish description
  BAF785: surfaceTreatment,
  // Conductor connection method (Phoenix / Weidmüller-style) — reuse connection-type heuristics
  AAS458: connectionType,

  // Compliance / sustainability fields that recur on many device tabs.
  AAF507: (ctx) => compliancePresent(ctx, /\b(REACH registration|REACH registered|REACH)\b/i),
  AAF508: attrYesNo(/\b(SVHC|substance of very high concern|contains substance)\b/i),
  AAO187: attrValue(/\b(SVHC substance|Name of SVHC|substance name)\b/i),
  AAO188: attrNumber(/\b(SVHC|weight percentage|percentage)\b/i),
  AAO189: (ctx) => complianceReference(ctx, /\bREACH\b/i),
  AAO190: (ctx) => complianceReference(ctx, /\b(security data sheet|safety data sheet|SDS)\b/i),
  AAO191: (ctx) => compliancePresent(ctx, /\b(RoHS|restriction of hazardous)\b/i),
  AAO221: attrValue(/\b(?:RoHS.*date|date.*RoHS)\b/i),
  AAO222: attrValue(/\b(?:(?:SVHC|REACH).*date|date.*(?:SVHC|REACH))\b/i),
  AAO192: attrValue(/\b(battery designation|designation of battery|battery model)\b/i),
  AAO193: attrValue(/\b(battery category|category of device batteries|device batteries)\b/i),
  AAO223: attrValue(/\b(type of battery|battery type)\b/i),

  // Cross-tab electrical ratings and operating conditions.
  AAB459: (ctx) => maxVoltageOnPolarity(ctx, "ac"),
  AAB840: (ctx) => maxVoltageOnPolarity(ctx, "dc"),
  AAB973: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*voltage.*DC|min(?:imum)? operating voltage.*DC|operating voltage.*DC|supply voltage.*DC)\b/i),
  AAB960: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*control voltage.*DC|control voltage.*DC)\b/i),
  ABC268: (ctx) => maxVoltageOnPolarity(ctx, "dc"),
  BAC064: voltageType,
  AAF954: attrUnitNumber(/\b(max(?:imum)? electricity consumption|power consumption|power dissipation)\b/i, "W"),
  AAS577: attrUnitNumber(/\b(power loss output capacity|power loss|power dissipation)\b/i, "W"),
  BAC640: attrUnitNumber(/\b(max(?:imum)? output current|output current)\b/i, "A"),
  BAD858: attrUnitNumber(/\b(open circuit current|no-load current)\b/i, "A"),
  AAB951: attrNumber(/\b(min(?:imum)? .*frequency|rated operating frequency)\b/i),

  // Temperatures, protection, mounting, and mechanical properties.
  AAZ952: (ctx) => temperatureBound(ctx, "min", /\b(min(?:imum)? ambient temperature|ambient temperature|operating temperature)\b/i),
  AAQ341: (ctx) => temperatureBound(ctx, "max", /\b(storage temperature|max(?:imum)? storage)\b/i),
  AAQ342: (ctx) => temperatureBound(ctx, "min", /\b(storage temperature|min(?:imum)? storage)\b/i),
  AAZ842: (ctx) => attr(ctx, /\b(operating ambient temperature|ambient temperature|operating temperature)\b/i),
  AAC108: degreeOfProtection,
  BAA205: protectionClass,
  AAZ994: certificateApproval,
  AAT099: ralColorNumber,
  BAC295: (ctx) => colorValue(ctx),
  BAD947: housingMaterial,
  BAB888: attrValue(/\b(design|construction form|construction type)\b/i),
  BAB894: attrValue(/\b(design|construction form|construction type)\b/i),
  AAO263: countryOfOrigin,
  AAZ088: attrValue(/\b(reference[-/\s]?test standard|test standard|standard)\b/i),
  AAZ135: attrValue(/\b(test severity level|severity level|severity)\b/i),
  AAC218: attrYesNo(/\bEMC\b/i),
  BAD715: attrYesNo(/\b(series installation|row installation)\b/i),
  BAD722: attrYesNo(/\b(safety function|suitable for safety)\b/i),
  BAD816: attrValue(/\b(special characteristics|special characteristic|special feature)\b/i),
  BAD833: attrYesNo(/\b(explosion protection.*gas(?:es)?|ATEX.*gas(?:es)?|gas explosion)\b/i),
  BAD834: attrYesNo(/\b(explosion protection.*dust|ATEX.*dust|dust explosion)\b/i),
  AAB451: attrValue(/\b(type of mounting|mounting type|mounting method)\b/i),
  BAB431: attrValue(/\b(mounting type|type of mounting)\b/i),
  BAG640: attrValue(/\b(assembly type|mounting type|installation type)\b/i),
  AAQ211: mountingOrientation,
  AAP636: attrNumber(/\b(number of poles|poles|pole number)\b/i),
  AAP428: attrNumber(/\b(number of doors back|doors back|back doors)\b/i),
  AAP429: attrNumber(/\b(number of doors front|doors front|front doors)\b/i),
  AAC895: attrUnitNumber(/\b(diameter|outer diameter|outside diameter)\b/i, "mm"),
  BAC818: attrValue(/\b(assembly|mounting|installation)\b/i),

  // Connectors, terminals, interfaces, and accessories.
  ABC265: threadSize,
  AAS460: threadSize,
  ABC266: connectorType,
  ABC264: sensorConnectionType,
  ABC338: connectorCoding,
  AAB373: attrValue(/\b(type of interlock|interlock type)\b/i),
  BAC676: attrUnitNumber(/\b(cross section.*multi|multi wire cross section|conductor cross[-\s]?section)\b/i, "mm"),
  AAQ328: attrValue(/\b(AWG|AWG-number)\b/i),
  BAD975: attrValue(/\b(AWG|AWG-number)\b/i),
  AAM476: protocol,
  ABG899: attrNumber(/\b(number of communications|number of communication interfaces|communications)\b/i),
  AAS461: attrValue(/\b(size|nominal size)\b/i),
  AAB369: attrValue(/\b(type of documentation|documentation type)\b/i),
  AAB374: attrValue(/\b(type of electrical accessories|electrical accessories)\b/i),
  AAB376: attrValue(/\b(type of mechanical accessory|mechanical accessory)\b/i),
  AAG457: attrValue(/\b(release characteristic|tripping characteristic|characteristic)\b/i),
  BAD792: attrValue(/\b(analog(?:ue)? output|analogue output)\b/i),
  BAD898: attrValue(/\b(design of control output|control output design|control output)\b/i),
  BAD899: switchingElementFunction,

  // Fluid / pneumatic fields shared by valve, pump, and sensor-fluid tabs.
  AAZ943: (ctx) => pressureValue(ctx, /\b(max(?:imum)? operating pressure|operating pressure)\b/i),
  AAZ944: (ctx) => pressureValue(ctx, /\b(max(?:imum)? pilot pressure|pilot pressure)\b/i),
  AAZ954: (ctx) => pressureValue(ctx, /\b(min(?:imum)? operating pressure|operating pressure)\b/i),
  AAZ425: attrValue(/\b(pressure medium|fluid medium|medium)\b/i),
  AAZ904: attrValue(/\b(type of pneumatic connections|pneumatic connection|connection type)\b/i),
  AAZ418: attrValue(/\b(graphic symbol|symbol)\b/i),

  // Deeper electrical supply / sensor / power-supply properties.
  AAB818: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated operating voltage.*AC|rated operating voltage.*AC|operating voltage.*AC)\b/i),
  AAB819: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated operating voltage.*AC|rated operating voltage.*AC|operating voltage.*AC)\b/i),
  AAB820: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated operating voltage.*DC|rated operating voltage.*DC|operating voltage.*DC)\b/i),
  AAB824: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated control voltage.*AC|rated control voltage.*AC|control voltage.*AC)\b/i),
  AAB825: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated control voltage.*AC|rated control voltage.*AC|control voltage.*AC)\b/i),
  AAB826: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated control voltage.*DC|rated control voltage.*DC|control voltage.*DC)\b/i),
  AAB827: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated control voltage.*AC|rated control voltage.*AC|control voltage.*AC)\b/i),
  AAB832: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated supply voltage.*AC|rated supply voltage.*AC|supply voltage.*AC|input voltage.*AC)\b/i),
  AAB833: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated supply voltage.*AC|rated supply voltage.*AC|supply voltage.*AC|input voltage.*AC)\b/i),
  AAB834: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated supply voltage.*DC|rated supply voltage.*DC|supply voltage.*DC|input voltage.*DC)\b/i),
  AAB952: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? rated operating voltage.*AC|min(?:imum)? operating voltage.*AC|operating voltage.*AC)\b/i),
  AAB953: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? rated operating voltage.*AC|min(?:imum)? operating voltage.*AC|operating voltage.*AC)\b/i),
  AAB954: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? rated operating voltage.*DC|min(?:imum)? operating voltage.*DC|operating voltage.*DC)\b/i),
  AAB955: (ctx) => currentValue(ctx, /\b(min(?:imum)? rated operating current|min(?:imum)? operating current)\b/i),
  AAB966: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? rated supply voltage.*AC|min(?:imum)? supply voltage.*AC|supply voltage.*AC|input voltage.*AC)\b/i),
  AAB967: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? rated supply voltage.*AC|min(?:imum)? supply voltage.*AC|supply voltage.*AC|input voltage.*AC)\b/i),
  AAB968: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? rated supply voltage.*DC|min(?:imum)? supply voltage.*DC|supply voltage.*DC|input voltage.*DC)\b/i),
  AAC962: minSupplyVoltage,
  AAC965: (ctx) => voltageValue(ctx, /\b(max(?:imum)? supply voltage|supply voltage|input voltage)\b/i),
  AAF727: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated operating voltage|max(?:imum)? operating voltage|rated operating voltage)\b/i),
  AAF728: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? rated operating voltage|min(?:imum)? operating voltage|rated operating voltage)\b/i),
  AAC823: (ctx) => currentValue(ctx, /\b(rated value of current|rated current|nominal current)\b/i),
  AAF829: (ctx) => currentValue(ctx, /\b(nominal current|rated current)\b/i),
  AAC967: (ctx) => powerValue(ctx, /\b(rated performance|rated power|nominal power|power rating)\b/i),
  AAJ701: (ctx) => powerValue(ctx, /\b(power consumption|electricity consumption)\b/i),

  // Power-supply output/input channels.
  AAB429: attrYesNo(/\b(output voltage adjustable|adjustable output)\b/i),
  AAB621: attrYesNo(/\b(galvanic separation|input.*output.*separation)\b/i),
  AAB685: attrYesNo(/\b(circuit[- ]board mounting|PCB mounting|board mounting)\b/i),
  AAC127: attrYesNo(/\b(stabili[sz]ed|regulated)\b/i),
  AAF680: attrYesNo(/\b(over voltage protection|overvoltage protection)\b/i),
  AAL377: attrYesNo(/\b(built[- ]in battery|integrated battery)\b/i),
  AAM119: attrFlag(/\bSNMP\b/i),
  AAF703: (ctx) => voltageValue(ctx, /\b(max(?:imum)? input voltage|input voltage)\b/i),
  AAF704: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? primary voltage|primary voltage|input voltage)\b/i),
  AAC079: (ctx) => voltageValue(ctx, /\b(primary voltage|input voltage)\b/i),
  AAC115: (ctx) => voltageValue(ctx, /\b(secondary voltage|output voltage)\b/i),
  AAC113: (ctx) => currentValue(ctx, /\b(secondary rated current|secondary current|output current)\b/i),
  BAA220: (ctx) => currentValue(ctx, /\b(secondary current|output current)\b/i),
  BAA221: (ctx) => voltageValue(ctx, /\b(nominal value voltage|nominal voltage|rated voltage)\b/i),
  BAA223: (ctx) => voltageValue(ctx, /\b(initial output voltage|output voltage)\b/i),
  AAF691: (ctx) => voltageValue(ctx, /\b(max(?:imum)? output voltage|output voltage)\b/i),
  AAF692: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? output voltage|output voltage)\b/i),
  AAB773: (ctx) => voltageValue(ctx, /\b(max(?:imum)? .*1\.? output voltage|max(?:imum)? first output voltage|output voltage 1)\b/i),
  AAB774: (ctx) => voltageValue(ctx, /\b(max(?:imum)? .*1\.? output voltage.*AC|output voltage 1.*AC)\b/i),
  AAB775: (ctx) => voltageValue(ctx, /\b(max(?:imum)? .*1\.? output voltage.*DC|output voltage 1.*DC)\b/i),
  AAB776: (ctx) => voltageValue(ctx, /\b(max(?:imum)? .*2\.? output voltage|max(?:imum)? second output voltage|output voltage 2)\b/i),
  AAB777: (ctx) => voltageValue(ctx, /\b(max(?:imum)? .*2\.? output voltage.*AC|output voltage 2.*AC)\b/i),
  AAB778: (ctx) => voltageValue(ctx, /\b(max(?:imum)? .*2\.? output voltage.*DC|output voltage 2.*DC)\b/i),
  AAB779: (ctx) => voltageValue(ctx, /\b(max(?:imum)? .*3\.? output voltage|max(?:imum)? third output voltage|output voltage 3)\b/i),
  AAB780: (ctx) => voltageValue(ctx, /\b(max(?:imum)? .*3\.? output voltage.*AC|output voltage 3.*AC)\b/i),
  AAB781: (ctx) => voltageValue(ctx, /\b(max(?:imum)? .*3\.? output voltage.*DC|output voltage 3.*DC)\b/i),
  AAB925: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*1\.? output voltage|min(?:imum)? first output voltage|output voltage 1)\b/i),
  AAB926: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*1\.? output voltage.*AC|output voltage 1.*AC)\b/i),
  AAB927: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*1\.? output voltage.*DC|output voltage 1.*DC)\b/i),
  AAB928: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*2\.? output voltage.*AC|output voltage 2.*AC)\b/i),
  AAB929: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*2\.? output voltage.*AC|output voltage 2.*AC)\b/i),
  AAB930: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*2\.? output voltage.*DC|output voltage 2.*DC)\b/i),
  AAB931: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*3\.? output voltage|min(?:imum)? third output voltage|output voltage 3)\b/i),
  AAB932: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*3\.? output voltage.*AC|output voltage 3.*AC)\b/i),
  AAB933: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*3\.? output voltage.*DC|output voltage 3.*DC)\b/i),
  AAS340: (ctx) => voltageValue(ctx, /\b(nominal value .*1\.? output voltage|nominal first output voltage|output voltage 1)\b/i),
  AAS341: (ctx) => voltageValue(ctx, /\b(nominal value .*2\.? output voltage|nominal second output voltage|output voltage 2)\b/i),
  AAS342: (ctx) => voltageValue(ctx, /\b(nominal value .*3\.? output voltage|nominal third output voltage|output voltage 3)\b/i),
  AAS343: (ctx) => currentValue(ctx, /\b(nominal value output current 1|output current 1)\b/i),
  AAS344: (ctx) => currentValue(ctx, /\b(nominal value output current 2|output current 2)\b/i),
  AAS345: (ctx) => currentValue(ctx, /\b(nominal value output current 3|output current 3)\b/i),
  AAI720: (ctx) => currentValue(ctx, /\b(max(?:imum)? output current 1|output current 1)\b/i),
  AAB807: (ctx) => currentValue(ctx, /\b(max(?:imum)? output current 2|output current 2)\b/i),
  AAB808: (ctx) => currentValue(ctx, /\b(max(?:imum)? output current 3|output current 3)\b/i),
  AAW284: (ctx) => currentValue(ctx, /\b(max(?:imum)? output current 4|output current 4)\b/i),
  AAW285: (ctx) => voltageValue(ctx, /\b(max(?:imum)? .*4\.? output voltage|output voltage 4)\b/i),
  AAW286: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? .*4\.? output voltage|output voltage 4)\b/i),
  AAW287: (ctx) => currentValue(ctx, /\b(nominal value output current 4|output current 4)\b/i),
  AAW288: (ctx) => voltageValue(ctx, /\b(nominal value .*4\.? output voltage|output voltage 4)\b/i),
  BAA077: attrValue(/\b(cooling type|type of cooling)\b/i),
  BAA222: attrValue(/\b(type of construction|construction type|construction)\b/i),
  AAF147: attrValue(/\b(construction type|type of construction)\b/i),
  AAF607: powerSupplyDesign,
  AAO823: attrValue(/\b(network form at output|output network form)\b/i),
  AAO824: attrValue(/\b(network form at input|input network form)\b/i),
  AAO825: attrValue(/\b(network form EUE|EUE network form)\b/i),
  AAO726: attrValue(/\b(short circuit performance.*battery|battery operation)\b/i),
  AAO382: safetyIntegrityLevel,
  BAA379: attrValue(/\b(nominal capacity|capacity)\b/i),

  // Sensor, optical sensor, and IO-Link properties.
  AAB208: attrYesNo(/\banalog output.*0\s*mA.*20\s*mA\b/i),
  AAB209: attrYesNo(/\banalog output.*0\s*V.*10\s*V\b/i),
  AAB210: attrYesNo(/\banalog output.*-10\s*V.*10\s*V\b/i),
  AAB211: attrYesNo(/\banalog output.*4\s*mA.*20\s*mA\b/i),
  AAC053: attrFlag(/\b(other analog output|analogue output)\b/i),
  AAC071: attrYesNo(/\b(parameteri[sz]ed|parameterizable|parameterized)\b/i),
  AAC085: attrYesNo(/\b(reflector included|reflector.*delivery)\b/i),
  AAB741: attrFlag(/\banalog communication interface\b/i),
  AAB742: attrFlag(/\bAS[- ]?Interface|AS communication interface\b/i),
  AAB743: attrFlag(/\bCANopen\b/i),
  AAB744: attrFlag(/\bDeviceNet\b/i),
  AAB745: attrFlag(/\bEthernet|EtherNet\/IP|PROFINET\b/i),
  AAB746: attrFlag(/\bINTERBUS\b/i),
  AAB747: attrFlag(/\bPROFIBUS\b/i),
  AAB748: attrFlag(/\bRS\s*232\b/i),
  AAB749: attrFlag(/\bRS\s*422\b/i),
  AAB750: attrFlag(/\bRS\s*485\b/i),
  AAB751: attrFlag(/\bSSD communication interface\b/i),
  AAB752: attrFlag(/\bSSI communication interface\b/i),
  AAB384: (ctx) => lengthValue(ctx, /\b(resolution.*light curtain|light curtain resolution|resolution)\b/i),
  AAB497: (ctx) => lengthValue(ctx, /\b(rated switching distance.*one[- ]way|one[- ]way light barrier|through[- ]beam)\b/i),
  AAB498: (ctx) => lengthValue(ctx, /\b(rated switching distance.*reflection|reflection light barrier|retroreflective)\b/i),
  AAB884: (ctx) => lengthValue(ctx, /\b(max(?:imum)? switching distance|switching distance)\b/i),
  AAM384: (ctx) => lengthValue(ctx, /\b(rated switching distance|switching distance)\b/i),
  AAB866: (ctx) => lengthValue(ctx, /\b(max(?:imum)? measuring range.*length|max(?:imum)? measuring range|measuring range)\b/i),
  AAB990: (ctx) => lengthValue(ctx, /\b(min(?:imum)? measuring range.*length|min(?:imum)? measuring range|measuring range)\b/i),
  AAC004: (ctx) => lengthValue(ctx, /\b(min(?:imum)? reflector distance|reflector distance)\b/i),
  AAC905: (ctx) => lengthValue(ctx, /\b(min(?:imum)? range.*light scanner|light scanner range)\b/i),
  AAC906: (ctx) => lengthValue(ctx, /\b(max(?:imum)? range.*light scanner|light scanner range)\b/i),
  AAC907: (ctx) => lengthValue(ctx, /\b(min(?:imum)? object size|object size)\b/i),
  AAM496: (ctx) => lengthValue(ctx, /\b(range of the measurement range|measurement range)\b/i),
  AAM497: (ctx) => lengthValue(ctx, /\b(range of the protection field|protection field)\b/i),
  AAM498: (ctx) => lengthValue(ctx, /\b(range of the warning field|warning field)\b/i),
  AAB510: (ctx) => dimensionValue(ctx, ["width"], /\b(width of amplifier|amplifier width)\b/i),
  AAB720: (ctx) => dimensionValue(ctx, ["height"], /\b(height of amplifier|amplifier height)\b/i),
  AAB764: (ctx) => dimensionValue(ctx, ["length"], /\b(length of amplifier|amplifier length)\b/i),
  BAD823: (ctx) => dimensionValue(ctx, ["width"], /\b(width of sensor|sensor width)\b/i),
  BAD826: (ctx) => lengthValue(ctx, /\b(diameter of sensor|sensor diameter|diameter)\b/i),
  BAD849: (ctx) => dimensionValue(ctx, ["height"], /\b(height of sensor|sensor height)\b/i),
  BAD856: (ctx) => dimensionValue(ctx, ["length"], /\b(length of sensor|sensor length)\b/i),
  AAC088: (ctx) => percentageValue(ctx, /\b(relative linear deviation|linear deviation)\b/i),
  AAC089: (ctx) => percentageValue(ctx, /\b(relative measuring accuracy|measuring accuracy|accuracy)\b/i),
  AAC819: attrNumber(/\b(aperture angle|angle)\b/i),
  AAC844: attrNumber(/\b(sampling rate|sample rate)\b/i),
  AAH938: attrValue(/\b(laser class)\b/i),
  AAG112: attrValue(/\b(type of indication|indication type|display type)\b/i),
  AAD221: attrValue(/\b(design of the display|display design|display)\b/i),
  AAK286: functionPrinciple,
  AAK359: measurementPrinciple,
  AAD250: attrValue(/\b(coating of housing|housing coating)\b/i),
  AAD251: attrValue(/\b(material of the cable mantle|cable mantle material|cable jacket material)\b/i),
  BAD946: attrValue(/\b(material of the active surface|active surface material)\b/i),
  BAD840: attrValue(/\b(housing construction form|housing construction|construction form)\b/i),
  BAD866: mechanicalInstallationCondition,
  BAD900: attrNumber(/\b(switch frequency|switching frequency)\b/i),
  AAZ285: attrNumber(/\brepeatability\b/i),
  AAQ331: attrNumber(/\b(repeat precision|repeatability)\b/i),
  AAI339: attrNumber(/\b(number of switch outputs|switch outputs)\b/i),
  AAC941: attrNumber(/\b(number of semi[- ]conductor outputs.*signaling|semi[- ]conductor outputs)\b/i),
  AAC942: attrNumber(/\b(number of secure outputs.*contact|secure outputs)\b/i),
  AAG545: attrNumber(/\b(number of analog(?:ue)? outputs|analog(?:ue)? outputs)\b/i),
  AAN317: attrNumber(/\b(number of signal channels|signal channels)\b/i),
  AAN599: attrNumber(/\b(number of outputs|outputs)\b/i),
  AAP264: attrNumber(/\b(beam number|number of beams)\b/i),
  AAP609: attrNumber(/\b(number of outputs with signaling function|outputs with signaling)\b/i),
  AAP643: attrNumber(/\b(number of detection fields|detection fields)\b/i),
  AAP670: attrNumber(/\b(number of secure outputs with contact|secure outputs with contact)\b/i),
  AAP671: attrNumber(/\b(number of secure semi[- ]conductor outputs|secure semi[- ]conductor outputs)\b/i),
  AAP679: attrNumber(/\b(number of semi[- ]conductor outputs with signaling|semi[- ]conductor outputs)\b/i),
  AAM471: attrValue(/\b(analog output,? voltage|voltage analog output)\b/i),
  AAM473: attrValue(/\b(analog output,? current|current analog output)\b/i),
  AAM261: attrYesNo(/\b(external evaluation unit required|evaluation unit required)\b/i),
  AAM551: typeCode,
  AAM812: certificateApproval,
  AAQ323: limitedApproval,
  BAD959: certificateApproval,
  AAP805: (ctx) => clean(ctx.result?.title) ?? attr(ctx, /\b(product name|name)\b/i),
  AAO847: (ctx) => attr(ctx, /\b(description of product type|product type description)\b/i) ?? clean(ctx.deviceType),
  AAO264: attrValue(/\b(region of customs tariff number|customs region|region)\b/i),
  AAY813: gln,
  AAW974: attrYesNo(/\b(reverse polarity protection)\b/i),
  ABD895: attrYesNo(/\b(short[- ]circuit strength|short[- ]circuit resistant)\b/i),
  ABD896: attrYesNo(/\b(overload resistance|overload resistant)\b/i),
  ABD897: attrYesNo(/\b(cross[- ]circuit detection)\b/i),
  ABD898: attrYesNo(/\b(output can be inverted|inverted output)\b/i),
  ABD912: attrValue(/\b(IO[- ]Link transmission rate|transmission rate)\b/i),
  ABD913: attrNumber(/\b(IO[- ]Link min cycle time|min cycle time)\b/i),
  ABD914: ioLinkRevision,
  ABD915: attrYesNo(/\b(IO[- ]Link SIO mode|SIO mode)\b/i),
  ABD916: attrValue(/\b(IO[- ]Link port type|port type)\b/i),
  ABD917: attrValue(/\b(IO[- ]Link device profiles?|device profile)\b/i),
  ABD918: attrNumber(/\b(IO[- ]Link process data input length|process data input)\b/i),
  ABD919: attrNumber(/\b(IO[- ]Link process data output length|process data output)\b/i),

  // Surge protection / lightning-protection fields.
  AAA915: attrNumber(/\b(max(?:imum)? relative humidity|relative humidity)\b/i),
  AAA942: attrNumber(/\b(min(?:imum)? relative humidity|relative humidity)\b/i),
  AAB202: (ctx) => lengthValue(ctx, /\b(insulation stripped length|stripping length)\b/i),
  AAF862: (ctx) => currentValue(ctx, /\b(short[- ]circuit breaking capacity|breaking capacity|short[- ]circuit current)\b/i),
  AAG339: (ctx) => lengthValue(ctx, /\b(min(?:imum)? pipe diameter|pipe diameter)\b/i),
  AAG825: (ctx) => lengthValue(ctx, /\b(max(?:imum)? length|length)\b/i),
  AAG826: (ctx) => lengthValue(ctx, /\b(min(?:imum)? length|length)\b/i),
  AAH217: connectionType,
  AAI539: (ctx) => currentValue(ctx, /\b(follow current extinguishing capability|follow current)\b/i),
  AAI734: (ctx) => voltageValue(ctx, /\b(max(?:imum)? continuous operating voltage.*AC|continuous operating voltage.*AC|MCOV.*AC)\b/i),
  AAI910: (ctx) => voltageValue(ctx, /\b(voltage protection level.*L[- ]N|protection level.*L[- ]N)\b/i),
  AAI911: (ctx) => voltageValue(ctx, /\b(voltage protection level.*(?:L[- ]PE|N[- ]PE)|protection level.*(?:L[- ]PE|N[- ]PE))\b/i),
  AAK366: attrValue(/\b(system configuration|network system)\b/i),
  AAK406: attrValue(/\b(fault indication|fault indicator)\b/i),
  AAL578: attrYesNo(/\b(outdoor use|suitable for outdoor)\b/i),
  AAM734: electricalConnectionDesign,
  AAN528: attrUnitNumber(/\b(conductor cross[- ]section|cross[- ]section)\b/i, "mm"),
  AAP184: attrValue(/\b(material number)\b/i),
  AAQ850: (ctx) => lengthValue(ctx, /\b(length of packing|package length)\b/i),
  AAQ852: (ctx) => lengthValue(ctx, /\b(depth of packing|package depth)\b/i),
  AAS445: certificateApproval,
  AAS659: attrNumber(/\b(contents per packing unit|packing unit)\b/i),
  AAT083: attrNumber(/\b(width in units of measurement|width units)\b/i),
  AAW301: (ctx) => temperatureBound(ctx, "min", /\b(min(?:imum)? ambient temperature|ambient temperature|operating temperature)\b/i),
  AAW302: (ctx) => temperatureBound(ctx, "max", /\b(max(?:imum)? ambient temperature|ambient temperature|operating temperature)\b/i),
  AAZ438: (ctx) => voltageValue(ctx, /\b(voltage protection level.*N[- ]PE|protection level.*N[- ]PE)\b/i),
  AAZ439: attrYesNo(/\b(integrated overcurrent protective device|overcurrent protective device)\b/i),
  ABD298: attrYesNo(/\b(no leakage current|leakage current)\b/i),
  ABD299: attrYesNo(/\b(protective element pluggable|pluggable protective element)\b/i),
  ABD305: attrYesNo(/\b(high voltage insulated down conductor|insulated down conductor)\b/i),
  ABD309: attrYesNo(/\b(water barrier)\b/i),
  ABD319: attrUnitNumber(/\b(max(?:imum)? cross[- ]section.*remote indication.*flexible|remote indication.*flexible.*cross[- ]section)\b/i, "mm"),
  ABD321: attrUnitNumber(/\b(min(?:imum)? cross[- ]section.*remote indication.*flexible|remote indication.*flexible.*cross[- ]section)\b/i, "mm"),
  ABD322: attrUnitNumber(/\b(max(?:imum)? cross[- ]section.*remote indication.*rigid|remote indication.*rigid.*cross[- ]section)\b/i, "mm"),
  ABD323: attrUnitNumber(/\b(min(?:imum)? cross[- ]section.*remote indication.*rigid|remote indication.*rigid.*cross[- ]section)\b/i, "mm"),
  ABD339: (ctx) => lengthValue(ctx, /\b(distance to grounded|distance to conductive parts)\b/i),
  ABD340: (ctx) => voltageValue(ctx, /\b(max(?:imum)? voltage.*remote indication.*AC|remote indication.*voltage.*AC)\b/i),
  ABD341: (ctx) => currentValue(ctx, /\b(max(?:imum)? current.*remote indication.*AC|remote indication.*current.*AC)\b/i),
  ABD342: (ctx) => voltageValue(ctx, /\b(max(?:imum)? voltage.*remote indication.*DC|remote indication.*voltage.*DC)\b/i),
  ABD343: (ctx) => currentValue(ctx, /\b(max(?:imum)? current.*remote indication.*DC|remote indication.*current.*DC)\b/i),
  ABD348: (ctx) => currentValue(ctx, /\b(residual current.*AC|leakage current)\b/i),
  ABD359: (ctx) => currentValue(ctx, /\b(total discharge current|discharge current)\b/i),
  ABD360: (ctx) => currentValue(ctx, /\b(impulse discharge current.*L[- ]N|discharge current.*L[- ]N)\b/i),
  ABD361: (ctx) => currentValue(ctx, /\b(impulse discharge current.*N[- ]PE|discharge current.*N[- ]PE)\b/i),
  ABD362: (ctx) => currentValue(ctx, /\b(impulse discharge current.*L[- ]PE|discharge current.*L[- ]PE)\b/i),
  ABD381: (ctx) => currentValue(ctx, /\b(max(?:imum)? overcurrent protective device.*branch|overcurrent protective device.*branch)\b/i),
  ABD382: (ctx) => currentValue(ctx, /\b(max(?:imum)? overcurrent protective device.*V[- ]type|overcurrent protective device.*V[- ]type)\b/i),
  ABD383: attrYesNo(/\bovercurrent protective device selective to fuse\b/i),
  ABD384: (ctx) => currentValue(ctx, /\b(transition surge current rating|surge current rating)\b/i),
  ABD480: attrNumber(/\b(max(?:imum)? allowed elevation|elevation above mean sea level|altitude)\b/i),
  ABD482: attrNumber(/\b(max(?:imum)? torque.*UL|torque)\b/i),
  ABD484: attrNumber(/\b(min(?:imum)? torque.*UL|torque)\b/i),
  ABD489: attrNumber(/\b(AC power frequency|power frequency|frequency)\b/i),
  ABD533: (ctx) => voltageValue(ctx, /\b(max(?:imum)? continuous operating voltage.*L[- ]N|MCOV.*L[- ]N|continuous operating voltage.*AC)\b/i),
  ABD603: (ctx) => voltageValue(ctx, /\b(max(?:imum)? continuous operating voltage.*L[- ]L|MCOV.*L[- ]L|continuous operating voltage.*AC)\b/i),
  ABD730: (ctx) => voltageValue(ctx, /\b(measured limiting voltage.*L[- ]L|limiting voltage.*L[- ]L)\b/i),
  ABD744: (ctx) => voltageValue(ctx, /\b(measured limiting voltage.*N[- ]G|limiting voltage.*N[- ]G)\b/i),
  ABD785: attrValue(/\b(Cu layer|copper layer)\b/i),
  ABD814: (ctx) => currentValue(ctx, /\b(short[- ]circuit current.*50Hz|short[- ]circuit current)\b/i),
  ABD820: (ctx) => currentValue(ctx, /\b(short[- ]circuit current.*16|short[- ]circuit current)\b/i),
  ABD822: electricalConnectionDesign,
  ABD823: attrYesNo(/\b(remote indication integrated|integrated remote indication)\b/i),

  // PCB connector / terminal-detail fields.
  AAB227: attrValue(/\b(connectible cable type|connectable cable type|cable type)\b/i),
  AAB230: attrValue(/\b(type of connection conductor|connection conductor type)\b/i),
  AAB231: attrValue(/\b(type of connection printed[- ]circuit board|PCB connection type)\b/i),
  AAB334: attrNumber(/\b(number of electrical connections|electrical connections)\b/i),
  AAB354: attrNumber(/\b(number of plug[- ]in contacts|plug[- ]in contacts)\b/i),
  AAB356: attrNumber(/\b(number of plug contact rows|plug contact rows)\b/i),
  AAB368: attrValue(/\b(type of revenue sealing|packaging type|type of packaging)\b/i),
  AAB370: attrValue(/\b(type of printed[- ]circuit fastening|PCB fastening|fastening type)\b/i),
  AAB372: attrValue(/\b(type of connection|connection type)\b/i),
  AAB396: housingSurfaceDesign,
  AAB499: (ctx) => voltageValue(ctx, /\b(rated surge voltage|surge voltage)\b/i),
  AAB500: (ctx) => currentValue(ctx, /\b(rated current In|rated current|nominal current)\b/i),
  AAB528: (ctx) => lengthValue(ctx, /\b(diameter of the connecting pin|connecting pin diameter|pin diameter)\b/i),
  AAB674: (ctx) => lengthValue(ctx, /\b(printed[- ]circuit board thickness|PCB thickness)\b/i),
  AAB754: attrValue(/\b(contact design|design of contact)\b/i),
  AAB763: (ctx) => lengthValue(ctx, /\b(length of the pin|pin length)\b/i),
  AAB787: attrUnitNumber(/\b(max(?:imum)? connectable conductor cross[- ]section.*fine|fine wire.*cross[- ]section)\b/i, "mm"),
  AAB789: attrUnitNumber(/\b(max(?:imum)? connectable conductor cross[- ]section.*multi|multiple wire.*cross[- ]section)\b/i, "mm"),
  AAB937: attrUnitNumber(/\b(min(?:imum)? connectable conductor cross[- ]section.*fine|fine wire.*cross[- ]section)\b/i, "mm"),
  AAB940: attrUnitNumber(/\b(min(?:imum)? connectable conductor cross[- ]section.*multi|multiple wire.*cross[- ]section)\b/i, "mm"),
  AAC082: (ctx) => lengthValue(ctx, /\b(grid dimension of the connections|connection grid|pitch)\b/i),
  AAC083: (ctx) => lengthValue(ctx, /\b(grid dimension of the contacts|contact grid|pitch)\b/i),
  AAC128: attrValue(/\b(design of plug connection|plug connection design)\b/i),
  AAC194: attrValue(/\b(type of packaging|packaging type)\b/i),
  AAC201: attrValue(/\b(material of the connection surface|connection surface material)\b/i),
  AAC202: attrValue(/\b(material of the contact coat|contact coating material)\b/i),
  AAC207: attrValue(/\b(material of the contact|contact material)\b/i),
  AAC209: attrNumber(/\b(angle contact.*printed[- ]circuit board|contact PCB angle)\b/i),
  AAC210: attrNumber(/\b(angle printed[- ]circuit board.*contact|PCB contact angle)\b/i),
  AAC211: attrNumber(/\b(angle printed[- ]circuit board.*conductor|PCB conductor angle)\b/i),
  AAD246: attrValue(/\b(overvoltage category)\b/i),
  AAH185: (ctx) => lengthValue(ctx, /\b(assembly height|mounting height)\b/i),
  AAP438: attrNumber(/\b(number of electrical connections|electrical connections)\b/i),
  AAP530: attrNumber(/\b(number of levels|levels)\b/i),
  AAP633: attrNumber(/\b(number of plug contact rows|plug contact rows)\b/i),
  AAP635: attrNumber(/\b(Int_count|number of contacts|contacts)\b/i),
  AAP662: attrNumber(/\b(number of rows|rows)\b/i),
  AAZ315: (ctx) => voltageValue(ctx, /\b(rated voltage.*II\/2|rated voltage)\b/i),
  AAZ316: (ctx) => voltageValue(ctx, /\b(rated voltage.*III\/2|rated voltage)\b/i),
  AAZ317: (ctx) => voltageValue(ctx, /\b(rated voltage.*III\/3|rated voltage)\b/i),
  AAZ318: (ctx) => voltageValue(ctx, /\b(rated voltage signal.*II\/2|rated voltage signal)\b/i),
  AAZ319: (ctx) => voltageValue(ctx, /\b(rated voltage signal.*III\/2|rated voltage signal)\b/i),
  AAZ320: (ctx) => voltageValue(ctx, /\b(rated voltage signal.*III\/3|rated voltage signal)\b/i),
  AAZ321: (ctx) => voltageValue(ctx, /\b(rated surge voltage.*II\/2|rated surge voltage)\b/i),
  AAZ322: (ctx) => voltageValue(ctx, /\b(rated surge voltage.*III\/2|rated surge voltage)\b/i),
  AAZ323: (ctx) => voltageValue(ctx, /\b(rated surge voltage.*III\/3|rated surge voltage)\b/i),
  AAZ324: (ctx) => voltageValue(ctx, /\b(rated surge voltage signal.*II\/2|rated surge voltage signal)\b/i),
  AAZ325: (ctx) => voltageValue(ctx, /\b(rated surge voltage signal.*III\/2|rated surge voltage signal)\b/i),
  AAZ326: (ctx) => voltageValue(ctx, /\b(rated surge voltage signal.*III\/3|rated surge voltage signal)\b/i),
  AAZ327: (ctx) => lengthValue(ctx, /\b(grid dimensions? 1|grid 1|pitch 1)\b/i),
  AAZ328: (ctx) => lengthValue(ctx, /\b(grid dimensions? 2|grid 2|pitch 2)\b/i),
  AAZ329: (ctx) => lengthValue(ctx, /\b(grid dimensions? signal|signal grid|signal pitch)\b/i),
  AAZ333: (ctx) => dimensionValue(ctx, ["functional depth", "depth"], /\b(functional depth|depth)\b/i),
  AAZ334: attrValue(/\b(type of PCB contacting|PCB contacting)\b/i),
  AAZ335: attrValue(/\b(locking system|lock system)\b/i),
  AAZ336: attrValue(/\b(index of protection class|protection class index)\b/i),
  AAZ351: attrValue(/\b(layout of solder pins|solder pin layout)\b/i),
  AAZ352: attrNumber(/\b(number of solder pins per pole|solder pins per pole)\b/i),
  AAZ353: (ctx) => lengthValue(ctx, /\b(recommended drill hole diameter|drill hole diameter)\b/i),
  AAZ354: (ctx) => lengthValue(ctx, /\b(recommended drill hole diameter pin|drill hole diameter pin)\b/i),
  AAZ355: attrValue(/\b(recommended SMD solder pad geometry|solder pad geometry)\b/i),
  AAZ360: (ctx) => temperatureBound(ctx, "min", /\b(lower limit temperature|temperature limit|operating temperature)\b/i),
  AAZ361: (ctx) => temperatureBound(ctx, "max", /\b(upper limit temperature|temperature limit|operating temperature)\b/i),
  AAZ362: attrValue(/\b(MSL|moisture sensitivity level)\b/i),
  AAZ363: attrValue(/\b(coating plug contact area|plug contact coating)\b/i),
  AAZ364: attrValue(/\b(coating PCB contact area|PCB contact coating)\b/i),
  AAZ365: attrValue(/\b(coating conductor contact area|conductor contact coating)\b/i),
  AAZ366: (ctx) => currentValue(ctx, /\b(rated current signal|signal current)\b/i),
  AAZ367: attrValue(/\b(type of connection conductor signal|signal conductor connection)\b/i),
  BAA663: (ctx) => dimensionValue(ctx, ["functional width", "width"], /\b(functional width|width)\b/i),
  BAA675: (ctx) => dimensionValue(ctx, ["functional height", "height"], /\b(functional height|height)\b/i),
  BAC487: attrValue(/\b(material of insulation|insulation material)\b/i),
  BAD991: attrYesNo(/\b(earthed conductor present|earthed conductor)\b/i),

  // Fluid, pump, and pneumatic handling detail fields.
  AAG868: (ctx) => attr(ctx, /\b(operating pressure min.*max|operating pressure)\b/i),
  AAO325: attrValue(/\b(flow direction)\b/i),
  AAZ404: attrValue(/\b(mounting pattern)\b/i),
  AAZ408: attrValue(/\b(actuation type|type of actuation)\b/i),
  AAZ411: attrValue(/\b(type of shaft end|shaft end)\b/i),
  AAZ415: attrValue(/\b(grade of filtration|filtration grade)\b/i),
  AAZ416: attrNumber(/\b(mean time to a dangerous failure|MTTF|MTTFD)\b/i),
  AAZ423: attrValue(/\b(degree of contamination|cleanliness class)\b/i),
  AAZ424: attrValue(/\b(position sensing)\b/i),
  AAZ803: (ctx) => pressureBound(ctx, "min", /\b(initial value.*pressure|initial pressure|pressure measuring range)\b/i),
  AAZ804: (ctx) => temperatureBound(ctx, "min", /\b(initial value.*temperature|temperature measuring range)\b/i),
  AAZ805: attrNumber(/\b(initial value.*flow rate|initial flow rate|flow measuring range)\b/i),
  AAZ807: attrNumber(/\b(drive torque)\b/i),
  AAZ808: attrNumber(/\b(assembly torque)\b/i),
  AAZ809: (ctx) => pressureValue(ctx, /\b(outlet pressure)\b/i),
  AAZ810: (ctx) => pressureValue(ctx, /\b(burst pressure)\b/i),
  AAZ811: attrNumber(/\b(working time.*mileage|working mileage)\b/i),
  AAZ812: attrNumber(/\b(working time.*cycles|cycles)\b/i),
  AAZ813: attrNumber(/\b(working time.*time|working time)\b/i),
  AAZ814: (ctx) => pressureValue(ctx, /\b(differential pressure|differntial pressure)\b/i),
  AAZ816: attrNumber(/\b(through drive torque)\b/i),
  AAZ817: (ctx) => pressureValue(ctx, /\b(inlet pressure)\b/i),
  AAZ818: (ctx) => attr(ctx, /\b(inlet flow rate|storage temperature|storage tempretaur)\b/i),
  AAZ819: (ctx) => pressureValue(ctx, /\b(set pressure)\b/i),
  AAZ820: (ctx) => powerValue(ctx, /\b(electrical power consumption|power consumption)\b/i),
  AAZ821: (ctx) => pressureValue(ctx, /\b(end value.*pressure|end pressure|pressure measuring range)\b/i),
  AAZ824: (ctx) => attr(ctx, /\b(fluid temperature|fluid medium temperature)\b/i),
  AAZ825: attrNumber(/\b(operating time)\b/i),
  AAZ826: attrNumber(/\b(total flow rate|flow rate)\b/i),
  AAZ830: (ctx) => attr(ctx, /\b(storage temperature|storage tempretaur)\b/i),
  AAZ831: (ctx) => powerValue(ctx, /\b(mechanical power)\b/i),
  AAZ840: attrNumber(/\b(control flow rate)\b/i),
  AAZ841: (ctx) => pressureValue(ctx, /\b(overload pressure)\b/i),
  AAZ844: attrNumber(/\b(product life.*time|product life)\b/i),
  AAZ845: attrNumber(/\b(flow rate)\b/i),
  AAZ847: attrNumber(/\b(flow ripple|flow fluctuation)\b/i),
  AAZ895: attrNumber(/\b(shifting on[- ]time|switching on time)\b/i),
  AAZ898: attrNumber(/\b(number of pneumatic output connections|pneumatic output connections)\b/i),
  AAZ899: attrNumber(/\b(number of pneumatic input connections|pneumatic input connections)\b/i),
  AAZ900: attrNumber(/\b(number of pneumatic exhaust connections|pneumatic exhaust connections)\b/i),
  AAZ901: attrNumber(/\b(number of pneumatic pilot ports|pneumatic pilot ports)\b/i),
  AAZ905: attrNumber(/\b(shifting off[- ]time|switching off time)\b/i),
  AAZ910: attrNumber(/\b(critical back[- ]pressure ratio)\b/i),
  AAZ911: attrNumber(/\b(sonic conductance)\b/i),
  AAZ915: attrValue(/\b(sealing principle)\b/i),
  AAZ919: attrValue(/\b(compressed air quality class|air quality)\b/i),
  AAZ920: attrValue(/\b(suitability for both directions of flow|both directions of flow)\b/i),
  AAZ923: attrValue(/\b(function in normal position|normal position)\b/i),
  AAZ937: attrNumber(/\b(max(?:imum)? piston speed|piston speed)\b/i),
  AAZ941: (ctx) => temperatureBound(ctx, "max", /\b(max(?:imum)? temperature of pressure medium|pressure medium temperature)\b/i),
  AAZ951: (ctx) => temperatureBound(ctx, "min", /\b(min(?:imum)? temperature of pressure medium|pressure medium temperature)\b/i),
  AAZ955: (ctx) => pressureBound(ctx, "min", /\b(min(?:imum)? pilot pressure|pilot pressure)\b/i),
  AAZ958: attrValue(/\b(nominal size)\b/i),
  AAZ961: attrValue(/\b(pneumatic output port)\b/i),
  AAZ962: attrValue(/\b(pneumatic input port)\b/i),
  AAZ963: attrValue(/\b(pneumatic exhaust port)\b/i),
  AAZ965: attrValue(/\b(pneumatic pilot port)\b/i),
  AAZ968: attrValue(/\b(grid dimension)\b/i),
  AAZ970: (ctx) => compliancePresent(ctx, /\b(RoHS|RoHs conformity)\b/i),
  AAZ971: degreeOfProtection,
  AAZ972: degreeOfProtection,
  AAZ977: attrValue(/\b(control characteristics)\b/i),
  AAZ978: attrValue(/\b(type of control|control type)\b/i),
  AAZ982: attrNumber(/\b(shifting time)\b/i),
  AAZ983: attrNumber(/\b(shifting[- ]on time.*dominant|dominant side)\b/i),
  AAZ984: attrValue(/\b(valve return)\b/i),
  AAZ986: attrNumber(/\b(volumetric flow rate.*secondary venting|secondary venting)\b/i),
  AAZ989: attrValue(/\b(directional control valve function|valve function)\b/i),
  ABC418: attrValue(/\b(nominal size|flow cross section)\b/i),
  ABC420: attrValue(/\b(grid dimension)\b/i),
  ABC459: attrValue(/\b(exhaust[- ]air function|exhaust function)\b/i),
  ABC463: attrValue(/\b(cleanroom class)\b/i),
  ABC464: attrNumber(/\b(sound pressure level|sound pressure)\b/i),
  ABC465: attrValue(/\b(signal status display|status display)\b/i),
  ABC468: attrValue(/\b(pilot medium)\b/i),
  ABC469: attrValue(/\blap\b/i),
  ABC474: (ctx) => round(weight(ctx).kg, 3),
  ABC475: attrValue(/\b(unit of measure)\b/i),
  ABC476: attrNumber(/\b(relative duty cycle|duty cycle)\b/i),
  ABC477: (ctx) => powerValue(ctx, /\b(max(?:imum)? electrical power consumption|electrical power consumption)\b/i),
  ABC480: attrNumber(/\b(B10 in cycles|B10)\b/i),
  ABC481: attrNumber(/\b(B10D)\b/i),
  ABC484: attrNumber(/\b(intended operating time.*cycles|operating time.*cycles)\b/i),
  ABC485: attrNumber(/\b(intended operating time.*time|intended operating time)\b/i),
  ABC487: attrNumber(/\b(min(?:imum)? set working time.*cycles|set working time.*cycles)\b/i),
  ABC488: attrNumber(/\b(min(?:imum)? set working time.*time|set working time)\b/i),
  ABC489: attrValue(/\b(design of the actuating device|actuating device)\b/i),
  BAC687: (ctx) => powerValue(ctx, /\b(max(?:imum)? switching power|switching power)\b/i),
  BAE156: attrValue(/\b(dimensions|string dimensions)\b/i),
  BAD371: attrYesNo(/\b(integrated protective circuitry|protective circuitry)\b/i),

  // Second-pass shared device fields (3+ tabs) and focused high-volume tabs.
  AAB906: (ctx) => temperatureBound(ctx, "max", /\b(max(?:imum)? ambient temperature|ambient temperature|operating temperature)\b/i),
  AAC022: (ctx) => temperatureBound(ctx, "min", /\b(min(?:imum)? ambient temperature|ambient temperature|operating temperature)\b/i),
  AAG011: (ctx) => lengthValue(ctx, /\b(thickness of material|material thickness|thickness)\b/i),
  AAZ485: suitabilityForApplication,
  BAA097: (ctx) => colorValue(ctx, /\b(colou?r of housing|housing colou?r|colou?r)\b/i),
  BAC078: voltageType,
  AAZ960: attrValue(/\b(pneumatic port|pneumatic connection|port)\b/i),
  AAJ003: attrUnitNumber(/\b(max(?:imum)? core cross[- ]section|core cross[- ]section)\b/i, "mm"),
  AAJ004: attrUnitNumber(/\b(min(?:imum)? core cross[- ]section|core cross[- ]section)\b/i, "mm"),
  AAM076: attrYesNo(/\b(cable guide chain|drag chain)\b/i),
  BAD803: attrValue(/\b(type of actuation|actuation type)\b/i),
  BAD804: attrValue(/\b(security oriented communications|safety communication|safe communication|PROFIsafe|SafetyBUS|DeviceNet Safety|AS interface safety)\b/i),
  BAD810: (ctx) => currentValue(ctx, /\b(max(?:imum)? output current.*secured output|secured output current|output current)\b/i),
  BAD853: attrYesNo(/\b(cascadable|cascade)\b/i),

  // HMI / panel fields.
  AAB728: attrYesNo(/\b(IO[- ]Link master|IO[- ]Link)\b/i),
  AAB907: (ctx) => voltageValue(ctx, /\b(max(?:imum)? supply voltage.*AC.*50|supply voltage.*AC)\b/i),
  AAB908: (ctx) => voltageValue(ctx, /\b(max(?:imum)? supply voltage.*AC.*60|supply voltage.*AC)\b/i),
  AAC023: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? supply voltage.*AC.*50|supply voltage.*AC)\b/i),
  AAC024: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? supply voltage.*AC.*60|supply voltage.*AC)\b/i),
  AAC025: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? supply voltage.*DC|supply voltage.*DC)\b/i),
  AAC706: attrNumber(/\b(number of buttons with LED|buttons with LED)\b/i),
  AAC716: attrNumber(/\b(number of system buttons|system buttons)\b/i),
  AAC849: attrNumber(/\b(monitor diagonal|screen diagonal|display diagonal)\b/i),
  AAC857: attrNumber(/\b(project memory|user memory|usable memory)\b/i),
  AAG522: attrNumber(/\b(number of grey scales|gray scales|grey scales)\b/i),
  AAM480: attrValue(/\b(transmission standard|communication standard)\b/i),
  AAM494: attrNumber(/\b(max(?:imum)? number of pixels.*horizontal|horizontal pixels)\b/i),
  AAM495: attrNumber(/\b(max(?:imum)? number of pixels.*vertical|vertical pixels)\b/i),
  AAO495: attrNumber(/\b(number of HW interfaces parallel|parallel interfaces)\b/i),
  AAO496: attrNumber(/\b(number of HW interfaces PROFINET|PROFINET interfaces)\b/i),
  AAO500: attrNumber(/\b(number of HW interfaces.*RS232|RS232 interfaces)\b/i),
  AAO501: attrNumber(/\b(number of HW interfaces.*RS422|RS422 interfaces)\b/i),
  AAO503: attrNumber(/\b(number of HW interfaces.*TTY|TTY interfaces)\b/i),
  AAO504: attrNumber(/\b(number of HW interfaces USB|USB interfaces)\b/i),
  AAO505: attrNumber(/\b(number of HW interfaces Wireless|wireless interfaces)\b/i),
  AAO507: attrNumber(/\b(number of HW interfaces.*other|other interfaces)\b/i),
  AAO533: attrNumber(/\b(number of online languages|online languages|languages)\b/i),
  AAP386: attrNumber(/\b(number of colors|number of colours|shades of gray|shades of grey)\b/i),
  AAP466: attrNumber(/\b(number of programmable function keys|function keys)\b/i),
  AAP531: attrNumber(/\b(number of levels.*password|password protection levels)\b/i),
  BAC163: attrValue(/\b(display type|type of display)\b/i),
  BAC657: (ctx) => lengthValue(ctx, /\b(max(?:imum)? fall height|fall height)\b/i),
  BAD085: attrYesNo(/\b(formulations present|formulations)\b/i),
  BAD092: attrYesNo(/\b(connection,? pluggable|pluggable connection)\b/i),
  BAD315: attrYesNo(/\b(alpha keyboard|keyboard)\b/i),
  BAD336: attrYesNo(/\b(display,? colou?r|colou?r display)\b/i),
  BAD395: attrYesNo(/\b(messaging system|message buffer)\b/i),
  BAD443: attrYesNo(/\b(touch screen|touchscreen)\b/i),
  BAD452: attrYesNo(/\b(permission key|dead man key)\b/i),
  BAD579: attrYesNo(/\b(process value display|value display)\b/i),
  BAD580: attrYesNo(/\b(process value provision|value provision)\b/i),
  BAG395: attrYesNo(/\b(pressure output)\b/i),

  // Electrical measurement device fields.
  AAB604: attrYesNo(/\b(frequency measurement)\b/i),
  AAB898: (ctx) => voltageValue(ctx, /\b(max(?:imum)? voltage measuring range|voltage measuring range)\b/i),
  AAC918: attrNumber(/\b(accuracy class)\b/i),
  AAG114: attrYesNo(/\b(measured value memory)\b/i),
  AAG130: attrValue(/\b(type of indication|indication type)\b/i),
  AAG131: attrValue(/\b(type of measuring range selection|range selection)\b/i),
  AAG133: attrYesNo(/\b(analogue bargraph display|analog bargraph display|bargraph)\b/i),
  AAG135: attrYesNo(/\b(true RMS)\b/i),
  AAG139: attrYesNo(/\b(top arbor measurement)\b/i),
  AAG140: attrYesNo(/\b(interface present|interface)\b/i),
  AAG145: (ctx) => currentValue(ctx, /\b(max(?:imum)? current measurement value.*DC|current measurement.*DC)\b/i),
  AAG147: (ctx) => currentValue(ctx, /\b(min(?:imum)? current measurement range.*DC|current measurement.*DC)\b/i),
  AAG211: attrNumber(/\b(max(?:imum)? resistance test range|resistance test range)\b/i),
  AAG212: attrNumber(/\b(min(?:imum)? resistance test range|resistance test range)\b/i),
  AAG349: attrYesNo(/\b(resistance test|diode test)\b/i),
  AAG350: attrYesNo(/\b(capacitance measurement)\b/i),
  AAG352: attrYesNo(/\b(temperature measurement)\b/i),
  AAG356: (ctx) => voltageValue(ctx, /\b(max(?:imum)? voltage measuring range.*AC|voltage measuring range.*AC)\b/i),
  AAG357: (ctx) => voltageValue(ctx, /\b(max(?:imum)? voltage measuring range.*DC|voltage measuring range.*DC)\b/i),
  AAG358: (ctx) => currentValue(ctx, /\b(max(?:imum)? current measuring range.*AC|current measuring range.*AC)\b/i),
  AAG359: (ctx) => currentValue(ctx, /\b(max(?:imum)? current measuring range.*DC|current measuring range.*DC)\b/i),
  AAG615: attrYesNo(/\b(VDE tested|VDE)\b/i),
  AAH659: attrValue(/\b(type of measurement system|measurement system)\b/i),
  AAH660: attrYesNo(/\b(scales lighting|scale lighting)\b/i),
  AAH661: attrYesNo(/\b(over current scale|overcurrent scale)\b/i),
  AAH662: attrYesNo(/\b(transformer connection)\b/i),
  AAH663: (ctx) => currentValue(ctx, /\b(max(?:imum)? measured value.*current|measured current)\b/i),
  AAH664: attrNumber(/\b(max(?:imum)? needle deflection|needle deflection)\b/i),
  AAH665: (ctx) => currentValue(ctx, /\b(min(?:imum)? measured value.*current|measured current)\b/i),
  AAH666: attrNumber(/\b(nominal end value of the scale|scale end value)\b/i),
  AAH667: attrValue(/\b(load type)\b/i),
  AAH694: (ctx) => voltageValue(ctx, /\b(max(?:imum)? measured value.*voltage|measured voltage)\b/i),
  AAH695: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? measured value.*voltage|measured voltage)\b/i),
  AAI345: attrNumber(/\b(number of voltage input channels|voltage input channels)\b/i),
  AAI358: attrNumber(/\b(number of current input channels|current input channels)\b/i),
  AAI804: attrNumber(/\b(max(?:imum)? measuring measurement range|measuring range)\b/i),
  AAI978: attrNumber(/\b(resistance measurement)\b/i),
  AAJ161: (ctx) => voltageValue(ctx, /\b(max(?:imum)? voltage measuring range.*AC direct|AC direct)\b/i),
  AAJ162: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? voltage measuring range.*AC direct|AC direct)\b/i),
  AAK328: attrValue(/\b(min(?:imum)? resolution.*direct voltage|direct voltage resolution)\b/i),
  AAK330: attrValue(/\b(min(?:imum)? resolution.*alternating voltage|alternating voltage resolution)\b/i),
  AAK331: attrValue(/\b(min(?:imum)? resolution.*alternating current|alternating current resolution)\b/i),
  AAK410: attrValue(/\b(type of voltage indication|voltage indication)\b/i),
  AAK432: attrValue(/\b(type of current measurement|current measurement type)\b/i),
  AAL712: attrYesNo(/\b(inductance measurement)\b/i),
  AAL797: attrYesNo(/\b(power\/work measurement|work measurement|power measurement)\b/i),
  AAL798: attrYesNo(/\b(power factor measurement)\b/i),
  AAL803: attrYesNo(/\b(conductivity measurement)\b/i),
  AAL961: attrYesNo(/\b(data hold)\b/i),
  AAM003: attrYesNo(/\b(decibel measurement|dB measurement)\b/i),
  AAM004: attrYesNo(/\b(step angle|cos phi)\b/i),
  AAM069: attrYesNo(/\b(apparent power)\b/i),
  AAM169: attrYesNo(/\b(duty cycle measurement)\b/i),
  AAM290: attrYesNo(/\b(effective power)\b/i),
  AAP801: attrValue(/\b(type of current supply|current supply|power supply)\b/i),
  ABF089: (ctx) => temperatureBound(ctx, "max", /\b(largest measuring range.*temperature|temperature measuring range)\b/i),
  ABF090: attrNumber(/\b(largest measuring range.*frequency|frequency measuring range)\b/i),
  ABF094: attrYesNo(/\b(automatic circuit breaker)\b/i),
  ABF095: (ctx) => powerValue(ctx, /\b(power loss)\b/i),
  BAB337: attrValue(/\b(user interface|interface)\b/i),
  BAB348: attrYesNo(/\b(drag pointer)\b/i),
  BAC065: voltageType,
  BAD080: attrYesNo(/\b(idle power)\b/i),
  BAD634: attrYesNo(/\b(certification)\b/i),
  BAE108: (ctx) => currentValue(ctx, /\b(rated output current|output current)\b/i),

  // Cabinet air-conditioning and mechanical profile fields.
  AAB433: attrYesNo(/\b(built[- ]in fan|designed as built[- ]in fan)\b/i),
  AAB513: attrYesNo(/\b(roof ventilator)\b/i),
  AAB527: (ctx) => lengthValue(ctx, /\b(diameter of the outflow|outflow diameter)\b/i),
  AAB623: attrYesNo(/\b(blower)\b/i),
  AAC042: attrYesNo(/\b(filter present|filter)\b/i),
  AAC066: (ctx) => powerValue(ctx, /\b(useful cooling capacity|cooling capacity)\b/i),
  AAC153: attrYesNo(/\b(circulation fan)\b/i),
  AAC199: attrNumber(/\b(volume flow|air flow)\b/i),
  AAC219: attrYesNo(/\b(master[- ]slave)\b/i),
  AAC747: attrYesNo(/\b(filter mat)\b/i),
  AAC970: (ctx) => powerValue(ctx, /\b(rated power)\b/i),
  AAK279: attrValue(/\b(filter class)\b/i),
  AAL689: attrYesNo(/\b(heating function)\b/i),
  AAM272: attrYesNo(/\b(wall build in|wall built[- ]in|wall mounting)\b/i),
  AAP766: attrNumber(/\b(number of ventilators|ventilators|fans)\b/i),
  AAW362: (ctx) => powerValue(ctx, /\b(continuous heat performance.*10|heat performance)\b/i),
  AAW364: (ctx) => powerValue(ctx, /\b(total cooling capacity|cooling capacity)\b/i),
  AAW365: attrYesNo(/\b(speed control)\b/i),
  BAB128: attrYesNo(/\b(heater)\b/i),
  BAB394: attrValue(/\b(design of temperature regulation|temperature regulation)\b/i),
  BAB928: attrValue(/\b(design of ventilation|ventilation design)\b/i),
  BAC393: attrNumber(/\b(transport volume|volume flow)\b/i),
  BAD172: attrYesNo(/\b(room thermostat)\b/i),
  BAD615: attrYesNo(/\b(temperature control)\b/i),
  BAD674: attrYesNo(/\b(19 inch installation|19-inch installation)\b/i),
  BAE687: attrValue(/\b(type of mounting|mounting type)\b/i),
  BAF072: (ctx) => powerValue(ctx, /\b(continuous heat performance.*20|heat performance)\b/i),
  BAF541: attrValue(/\b(cooling medium)\b/i),
  BAF766: (ctx) => powerValue(ctx, /\b(cooling capacity.*35|cooling capacity)\b/i),
  BAF767: (ctx) => powerValue(ctx, /\b(nominal cooling performance.*L32W18|cooling performance)\b/i),
  BAF768: (ctx) => powerValue(ctx, /\b(nominal cooling performance.*L35W10.*200|cooling performance)\b/i),
  BAF769: (ctx) => powerValue(ctx, /\b(nominal cooling performance.*L35W10.*400|cooling performance)\b/i),
  BAH385: (ctx) => powerValue(ctx, /\b(heat output specific|specific heat output)\b/i),
  BAH412: attrNumber(/\b(number of ventilators|ventilators|fans)\b/i),
  BAJ043: attrYesNo(/\b(wall fixing|wall mounting)\b/i),

  // Cable duct / rail / energy distribution mechanical fields.
  AAB440: (ctx) => dimensionValue(ctx, ["overall width", "width"], /\b(overall width|width)\b/i),
  AAB445: (ctx) => dimensionValue(ctx, ["overall depth", "depth"], /\b(overall depth|depth)\b/i),
  AAB509: (ctx) => dimensionValue(ctx, ["width"], /\b(width of adaptor|adaptor width)\b/i),
  AAB597: attrYesNo(/\b(flexible)\b/i),
  AAB902: (ctx) => lengthValue(ctx, /\b(max(?:imum)? conductor bar thickness|conductor bar thickness)\b/i),
  AAC019: (ctx) => lengthValue(ctx, /\b(min(?:imum)? conductor bar thickness|conductor bar thickness)\b/i),
  AAC099: (ctx) => lengthValue(ctx, /\b(rail spacing)\b/i),
  AAC100: (ctx) => lengthValue(ctx, /\b(busbar width)\b/i),
  AAC144: attrValue(/\b(supporting rail assembly|rail assembly)\b/i),
  AAC198: attrYesNo(/\b(tinned)\b/i),
  AAC397: attrValue(/\b(rail version according to standard|rail version|DIN EN 60715)\b/i),
  AAC899: (ctx) => lengthValue(ctx, /\b(bore holes distance|hole distance)\b/i),
  AAD247: attrNumber(/\b(number of poles|poles)\b/i),
  AAF567: attrValue(/\b(type of surface treatment|surface treatment)\b/i),
  AAF986: attrYesNo(/\b(circuit integrity)\b/i),
  AAF987: attrYesNo(/\b(stainless steel,? pickled|pickled stainless)\b/i),
  AAF992: attrNumber(/\b(load bearing capacity|bearing capacity)\b/i),
  AAG007: attrYesNo(/\b(mounting perforation in bottom|bottom perforation)\b/i),
  AAG009: attrYesNo(/\b(side wall perforation)\b/i),
  AAG010: attrYesNo(/\b(wide span model)\b/i),
  AAG013: attrYesNo(/\b(delivery on roll|on roll)\b/i),
  AAG015: attrYesNo(/\b(duct connector)\b/i),
  AAG016: attrYesNo(/\b(protection film)\b/i),
  AAG076: attrYesNo(/\b(punching present|punched|punching)\b/i),
  AAG077: (ctx) => lengthValue(ctx, /\b(base height|height)\b/i),
  AAG078: attrValue(/\b(type of cover|cover type)\b/i),
  AAG079: attrYesNo(/\b(extension possible|extendable)\b/i),
  AAG119: attrYesNo(/\b(19 inch mounting|19-inch mounting)\b/i),
  AAG149: attrValue(/\b(type of perforation|perforation type)\b/i),
  AAG151: attrYesNo(/\b(snap[- ]off|snap off)\b/i),
  AAG152: attrYesNo(/\b(toothing)\b/i),
  AAG153: attrNumber(/\b(moment of resistance ly|resistance ly)\b/i),
  AAG154: attrNumber(/\b(moment of resistance lz|resistance lz)\b/i),
  AAG249: attrValue(/\b(type of side joist|side joist)\b/i),
  AAG341: (ctx) => lengthValue(ctx, /\b(width of the tray|tray width)\b/i),
  AAG344: (ctx) => colorValue(ctx, /\b(color code|colour code|color|colour)\b/i),
  AAG364: (ctx) => lengthValue(ctx, /\b(busbar height|bus bar height)\b/i),
  AAG365: (ctx) => lengthValue(ctx, /\b(thickness of busbar|busbar thickness)\b/i),
  AAG376: attrYesNo(/\b(laminated)\b/i),
  AAG377: (ctx) => lengthValue(ctx, /\b(thickness of lamella|lamella thickness)\b/i),
  AAH464: attrYesNo(/\b(pre[- ]stamping|prestamping)\b/i),
  AAH648: attrYesNo(/\b(equipped busbar|busbar present)\b/i),
  AAH649: (ctx) => currentValue(ctx, /\b(rated current of the rail system|rail system current)\b/i),
  AAO333: connectionType,
  AAO740: attrValue(/\b(hole form|form of hole|hole)\b/i),
  AAO741: attrValue(/\b(perforation)\b/i),
  AAP479: attrNumber(/\b(number of height units|height units)\b/i),
  AAP743: attrNumber(/\b(number of the lamella|lamella)\b/i),
  AAS454: attrValue(/\b(busbar function)\b/i),
  AAS455: attrValue(/\b(busbar section)\b/i),
  AAS456: attrValue(/\b(surface finish|finish)\b/i),
  ABF000: attrNumber(/\b(moment of resistance Wy|resistance Wy)\b/i),
  ABF001: attrNumber(/\b(moment of resistance Wz|resistance Wz)\b/i),
  BAC673: attrUnitNumber(/\b(max(?:imum)? cross section of line|line cross section)\b/i, "mm"),
  BAD022: connectorType,
  BAD445: attrYesNo(/\b(transparent ceiling)\b/i),
  BAD656: attrYesNo(/\b(halogenfree|without halogens|halogen free)\b/i),
  BAE028: attrValue(/\b(material of the conductor|conductor material)\b/i),
  BAE496: (ctx) => lengthValue(ctx, /\b(min(?:imum)? thickness|thickness)\b/i),
  BAF634: genericMaterial,
  BAG626: attrYesNo(/\b(transparent)\b/i),
  BAA931: (ctx) => lengthValue(ctx, /\b(width of slit|slit width)\b/i),
  BAB027: (ctx) => lengthValue(ctx, /\b(width of hole|hole width)\b/i),

  // Optical / safety sensor detail fields.
  AAB411: attrValue(/\b(design of the process connection|process connection design|process connection)\b/i),
  AAD888: attrValue(/\b(delivery scope of disposable system|delivery scope)\b/i),
  AAH792: (ctx) => pressureBound(ctx, "min", /\b(min(?:imum)? operational pressure|operational pressure)\b/i),
  AAM985: attrValue(/\b(firmware version|firmware)\b/i),
  AAO737: attrValue(/\b(delivery scope of disposable system|delivery scope)\b/i),
  AAQ824: outputCategory,
  AAR412: (ctx) => materialAttribute(ctx, /\b(material in contact with the medium|medium contact material)\b/i) ?? normalizedMaterial(ctx),
  AAT832: attrValue(/\b(signal channel)\b/i),
  AAV535: attrNumber(/\b(response time|reaction time)\b/i),
  AAV538: attrValue(/\b(field of application|application field)\b/i),
  AAV540: (ctx) => lengthValue(ctx, /\b(operating range,? maximum|maximum operating range|operating range)\b/i),
  AAV547: (ctx) => lengthValue(ctx, /\b(operating range,? minimum|minimum operating range|operating range)\b/i),
  AAV557: (ctx) => lengthValue(ctx, /\b(transmission range,? maximum|maximum transmission range|transmission range)\b/i),
  AAV560: (ctx) => lengthValue(ctx, /\b(transmission range,? minimum|minimum transmission range|transmission range)\b/i),
  ABA335: attrValue(/\b(set display language|display language|language)\b/i),
  ABD888: lightSource,
  ABD889: (ctx) => lengthValue(ctx, /\b(min(?:imum)? range of the protective field|protective field)\b/i),
  ABD890: (ctx) => lengthValue(ctx, /\b(max(?:imum)? range of the protective field|protective field)\b/i),
  ABD891: (ctx) => lengthValue(ctx, /\b(min(?:imum)? range of the warning field|warning field)\b/i),
  ABD892: (ctx) => lengthValue(ctx, /\b(max(?:imum)? range of the warning field|warning field)\b/i),
  ABD900: attrValue(/\b(optical arrangement)\b/i),
  BAA021: attrValue(/\b(type of process connection|process connection)\b/i),
  BAA136: mediumValue,
  BAB942: attrValue(/\b(design of sensor|sensor design)\b/i),
  BAD093: attrYesNo(/\b(analog output,? voltage|voltage analog output)\b/i),
  BAD094: attrYesNo(/\b(analog output,? current|current analog output)\b/i),
  BAD600: attrYesNo(/\b(other function possible|other function)\b/i),
  BAD791: attrValue(/\b(type of scanning system|scanning system)\b/i),
  BAD794: attrNumber(/\b(number of outputs with signaling function|outputs with signaling)\b/i),
  BAD795: attrNumber(/\b(number of secure semi[- ]conductor outputs|secure semi[- ]conductor outputs)\b/i),
  BAD805: attrValue(/\b(design of output switching element|OSSD|output switching element)\b/i),
  BAD806: attrYesNo(/\b(fade[- ]out)\b/i),
  BAD807: attrNumber(/\b(output rate)\b/i),
  BAD812: attrYesNo(/\b(disable function)\b/i),
  BAD813: attrValue(/\b(prerequisite evaluation unit|evaluation unit)\b/i),
  BAD821: (ctx) => lengthValue(ctx, /\b(min(?:imum)? bending radius|bending radius)\b/i),
  BAD824: attrValue(/\b(detection ability|test bodies)\b/i),
  BAD830: settingOption,
  BAD832: attrValue(/\b(reception spectrum|spectrum)\b/i),
  BAD835: attrValue(/\b(color detection procedure|colour detection procedure|color detection)\b/i),
  BAD837: (ctx) => lengthValue(ctx, /\b(fork depth)\b/i),
  BAD838: (ctx) => lengthValue(ctx, /\b(fork width)\b/i),
  BAD842: (ctx) => lengthValue(ctx, /\b(geometric resolution|resolution)\b/i),
  BAD848: attrValue(/\b(triangulation)\b/i),
  BAD855: attrYesNo(/\b(configurable signaling function|signaling function)\b/i),
  BAD857: attrValue(/\b(laser protection class|laser class)\b/i),
  BAD859: lightType,
  BAD860: attrValue(/\b(light spot)\b/i),
  BAD861: attrYesNo(/\b(light conductor.*connection|light conductor)\b/i),
  BAD873: attrYesNo(/\b(override)\b/i),
  BAD879: attrValue(/\b(optical distance measurement principle|distance measurement principle)\b/i),
  BAD882: attrValue(/\b(physical measurement principle|measurement principle)\b/i),
  BAD889: attrNumber(/\b(reaction time|response time)\b/i),
  BAD891: attrYesNo(/\b(reduced resolution)\b/i),
  BAD893: (ctx) => lengthValue(ctx, /\b(range of the measurement range|measurement range)\b/i),
  BAD894: (ctx) => lengthValue(ctx, /\b(range of the protection field|protection field)\b/i),
  BAD895: (ctx) => lengthValue(ctx, /\b(range of the warning field|warning field)\b/i),
  BAD897: attrNumber(/\b(scan angle)\b/i),
  BAD902: (ctx) => voltageValue(ctx, /\b(switching voltage.*OSSD|OSSD.*voltage)\b/i),
  BAD903: protocol,
  BAD912: (ctx) => dimensionValue(ctx, ["height"], /\b(height of the detection field|detection field height)\b/i),
  BAD914: attrValue(/\b(safety type.*IEC 61496|safety type)\b/i),
  BAD922: (ctx) => lengthValue(ctx, /\b(beam distance)\b/i),
  BAD923: attrNumber(/\b(beam number|number of beams)\b/i),
  BAD924: attrYesNo(/\b(beam coding)\b/i),
  BAD925: attrValue(/\b(design of radiation source|radiation source)\b/i),
  BAD927: attrValue(/\b(design of multi[- ]ray photoelectric barrier|multi[- ]ray barrier)\b/i),
  BAD929: attrValue(/\b(push button function|button function)\b/i),
  BAD931: (ctx) => dimensionValue(ctx, ["width"], /\b(nominal sensor width|sensor width)\b/i),
  BAD934: attrYesNo(/\b(muting)\b/i),
  BAD936: attrYesNo(/\b(monitoring function of downstream devices|downstream devices)\b/i),
  BAD939: attrYesNo(/\b(preliminary failure signal)\b/i),
  BAD940: attrYesNo(/\b(warning field output)\b/i),
  BAD941: attrYesNo(/\b(removable lens)\b/i),
  BAD945: attrNumber(/\b(wave length|wavelength)\b/i),
  BAD949: attrValue(/\b(material of the optical waveguide|optical waveguide material)\b/i),
  BAD950: attrValue(/\b(material of the optical surface|optical surface material)\b/i),
  BAD954: attrYesNo(/\b(restart block)\b/i),
  BAD955: attrNumber(/\b(rel\.? repeat precision|repeat precision|repeatability)\b/i),
  BAD957: attrYesNo(/\b(time function)\b/i),
  BAH432: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated AC voltage.*50|AC voltage.*50)\b/i),
  BAH434: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated AC voltage.*60|AC voltage.*60)\b/i),
  BAH436: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated DC voltage|DC voltage)\b/i),

  // Fluid-power actuator detail fields.
  AAZ417: attrValue(/\b(mode of operation of drive|mode of operation)\b/i),
  AAZ420: (ctx) => lengthValue(ctx, /\b(piston diameter)\b/i),
  AAZ421: attrValue(/\b(type of piston rod|piston rod type)\b/i),
  AAZ422: attrValue(/\b(type of piston rod end|piston rod end)\b/i),
  AAZ834: attrNumber(/\b(remaining working time.*mileage|remaining mileage)\b/i),
  AAZ836: attrNumber(/\b(remaining working time.*time|remaining working time)\b/i),
  AAZ837: attrNumber(/\b(remaining operating time)\b/i),
  AAZ851: customsTariff,
  AAZ897: attrNumber(/\b(number of pneumatic connections|pneumatic connections)\b/i),
  AAZ902: attrValue(/\b(type of cushioning|cushioning type)\b/i),
  AAZ903: attrValue(/\b(type of stroke reduction|stroke reduction)\b/i),
  AAZ907: attrNumber(/\b(moving mass)\b/i),
  AAZ908: attrNumber(/\b(moving mass with 0 mm stroke)\b/i),
  AAZ909: attrNumber(/\b(moving mass per 10 mm stroke)\b/i),
  AAZ912: (ctx) => lengthValue(ctx, /\b(cushioning length)\b/i),
  AAZ913: attrNumber(/\b(cushioning angle)\b/i),
  AAZ917: attrNumber(/\b(torque at 6 bar)\b/i),
  AAZ930: (ctx) => lengthValue(ctx, /\bstroke\b/i),
  AAZ932: threadSize,
  AAZ935: attrNumber(/\b(max(?:imum)? impact energy|impact energy)\b/i),
  AAZ936: (ctx) => lengthValue(ctx, /\b(max(?:imum)? stroke reduction per side|stroke reduction)\b/i),
  AAZ939: attrNumber(/\b(max(?:imum)? swivel angle extension|swivel angle extension)\b/i),
  AAZ940: attrNumber(/\b(max(?:imum)? swivel angle reduction|swivel angle reduction)\b/i),
  AAZ947: attrNumber(/\b(max(?:imum)? torque in direction of X|torque.*X-axis)\b/i),
  AAZ948: attrNumber(/\b(max(?:imum)? torque in direction of Y|torque.*Y-axis)\b/i),
  AAZ949: attrNumber(/\b(max(?:imum)? torque in direction of Z|torque.*Z-axis)\b/i),
  AAZ956: attrValue(/\b(driver coupling|coupling)\b/i),
  AAZ964: attrValue(/\b(pneumatic clamping port|clamping port)\b/i),
  AAZ967: attrNumber(/\b(shear force)\b/i),
  AAZ973: attrValue(/\b(swivel direction)\b/i),
  AAZ974: attrNumber(/\b(swivel angle)\b/i),
  AAZ975: attrNumber(/\b(clamping area)\b/i),
  AAZ980: attrNumber(/\b(theoretical cylinder force.*advancing|cylinder force.*advancing)\b/i),
  AAZ981: attrNumber(/\b(theoretical cylinder force.*retracting|cylinder force.*retracting)\b/i),
  AAZ985: attrNumber(/\b(torsional tolerance)\b/i),
  AAZ991: attrNumber(/\b(effective torque)\b/i),
  AAZ992: attrNumber(/\b(limit of the axial force|axial force)\b/i),
  AAZ993: attrNumber(/\b(permissible lateral force|lateral force)\b/i),
  AAZ995: attrValue(/\b(ISO standard conformity of cylinder|cylinder standard)\b/i),
  AAZ996: attrValue(/\b(accessory type)\b/i),
  ABC412: (ctx) => lengthValue(ctx, /\b(cushioning length)\b/i),
  ABC413: (ctx) => lengthValue(ctx, /\bstroke\b/i),
  ABC415: (ctx) => lengthValue(ctx, /\b(max(?:imum)? stroke reduction per side|stroke reduction)\b/i),
  ABC460: (ctx) => pressureValue(ctx, /\b(unlocking pressure)\b/i),
  ABC461: (ctx) => pressureValue(ctx, /\b(clamping unit release pressure|release pressure)\b/i),
  ABC462: attrNumber(/\b(max(?:imum)? torque for protection against torsion|torsion torque)\b/i),
  ABC466: attrNumber(/\b(static holding force of end-position locking|end-position locking force)\b/i),
  ABC467: attrNumber(/\b(static holding force of clamping unit|clamping unit force)\b/i),
  ABC470: (ctx) => pressureValue(ctx, /\b(locking pressure)\b/i),
  ABC471: attrValue(/\b(mode of operation end-position locking|end-position locking)\b/i),
  ABC472: attrValue(/\b(mode of operation clamping unit|clamping unit)\b/i),
  ABC473: attrValue(/\b(mode of operation holding brake|holding brake)\b/i),
  ABC479: attrValue(/\b(Labs-conformity|VDMA 24364)\b/i),
  ABC482: attrNumber(/\b(B10 in km|B10)\b/i),
  ABC483: attrNumber(/\b(intended operating time.*mileage|operating mileage)\b/i),
  ABC486: attrNumber(/\b(min(?:imum)? set working time.*mileage|set working mileage)\b/i),
  ABF441: attrNumber(/\b(effective torque)\b/i),
  ABF442: attrNumber(/\b(torque at 6 bar)\b/i),
  ABF445: attrNumber(/\b(max(?:imum)? torque in direction of X|torque.*X-axis)\b/i),
  ABF446: attrNumber(/\b(max(?:imum)? torque in direction of Y|torque.*Y-axis)\b/i),
  ABF447: attrNumber(/\b(max(?:imum)? torque in direction of Z|torque.*Z-axis)\b/i),

  // Power supply / UPS extras.
  AAC073: performanceLevel,
  AAC803: attrNumber(/\b(non-linear distortion factor|distortion factor)\b/i),
  AAC804: attrNumber(/\b(crest factor)\b/i),
  AAE783: (ctx) => dimensionValue(ctx, ["width"], /\b(min(?:imum)? width of the niche|niche width)\b/i),
  BAA279: attrValue(/\b(cable\/conduit entry|conduit entry|cable entry)\b/i),
  BAA451: attrNumber(/\b(volume capacity|capacity)\b/i),
  BAA558: qualityCharacteristicRecord,
  BAA564: attrNumber(/\b(battery capacity|capacity)\b/i),
  BAB271: attrNumber(/\b(transit time)\b/i),
  BAB272: attrNumber(/\b(bridging time|backup time)\b/i),
  BAB304: connectionType,
  BAB353: attrValue(/\b(network form at input|input network form)\b/i),
  BAB354: attrNumber(/\b(phase angle)\b/i),
  BAB357: attrNumber(/\b(humidity without condensation|humidity)\b/i),
  BAB358: connectionType,
  BAB359: attrValue(/\b(design of interface 1|interface 1)\b/i),
  BAB360: attrValue(/\b(design of interface 2|interface 2)\b/i),
  BAB361: attrNumber(/\b(min(?:imum)? network voltage tolerance|voltage tolerance)\b/i),
  BAB362: attrValue(/\b(isolating transformer design at input|input transformer design)\b/i),
  BAB363: attrValue(/\b(network form at output|output network form)\b/i),
  BAB364: attrYesNo(/\b(output isolating transformer)\b/i),
  BAB367: attrValue(/\b(design of network bypass|network bypass)\b/i),
  BAB369: attrYesNo(/\b(hand bypass)\b/i),
  BAB370: attrNumber(/\b(efficiency)\b/i),
  BAB371: attrNumber(/\b(max(?:imum)? internal noise|internal noise|noise)\b/i),
  BAB372: (ctx) => dimensionValue(ctx, ["height"], /\b(max(?:imum)? height when set up|height when set up)\b/i),
  BAB373: attrValue(/\b(construction type of battery|battery construction|battery type)\b/i),
  BAB485: attrValue(/\b(interference resistance to bursts|burst immunity)\b/i),
  BAB492: attrValue(/\b(EMC radiation|radiation)\b/i),
  BAB500: (ctx) => round(weight(ctx).kg, 3) ?? attrNumber(/\b(mass of the battery|battery mass)\b/i)(ctx),
  BAB975: (ctx) => currentValue(ctx, /\b(output current)\b/i),
  BAC178: (ctx) => dimensionValue(ctx, ["installation width", "width"], /\b(installation width|width)\b/i),
  BAC180: (ctx) => dimensionValue(ctx, ["installation height", "height"], /\b(installation height|height)\b/i),
  BAC200: (ctx) => voltageValue(ctx, /\b(input voltage)\b/i),
  BAC545: (ctx) => powerValue(ctx, /\b(power output|output power)\b/i),
  BAD291: attrYesNo(/\b(direct assembly|direct mounting)\b/i),
  BAD308: attrYesNo(/\b(wall assembly|wall mounting)\b/i),
  BAD485: attrYesNo(/\b(output voltage.*regulated|regulated output voltage)\b/i),
  BAE190: attrYesNo(/\b(short[- ]circuit[- ]proof|short circuit proof)\b/i),
  BAE378: attrValue(/\b(short circuit performance.*battery|battery operation)\b/i),
  BAE417: attrValue(/\b(output cut[- ]out with battery|battery cut-out)\b/i),
  BAE447: attrValue(/\b(network form EUE|EUE network form)\b/i),
  BAE450: attrValue(/\b(non-linear load|nonlinear load)\b/i),
  BAE487: attrValue(/\b(voltage curve form|voltage curve)\b/i),
  BAE534: attrValue(/\b(overload behavior|overload behaviour)\b/i),
  BAE535: attrValue(/\b(overload behavior for 60 seconds|overload behaviour for 60 seconds)\b/i),
  BAF281: attrValue(/\b(use for product|product use)\b/i),
  BAG948: attrNumber(/\b(supply voltage tolerance|voltage tolerance)\b/i),

  // Motor and switch details.
  BAE082: (ctx) => voltageValue(ctx, /\b(rated voltage at 50 Hz|50 Hz voltage)\b/i),
  BAE083: (ctx) => voltageValue(ctx, /\b(rated voltage at 60 Hz|60 Hz voltage)\b/i),
  AAW318: housingMaterial,
  AAW317: connectionType,
  AAW316: (ctx) => powerValue(ctx, /\b(rated performance.*60|rated performance|rated power)\b/i),
  BAE072: attrValue(/\b(construction size DC[- ]Motor|DC motor size)\b/i),
  BAE085: attrYesNo(/\b(brake present|brake)\b/i),
  BAE073: attrValue(/\b(construction size without length|construction size)\b/i),
  BAE077: (ctx) => powerValue(ctx, /\b(rated performance at 60 Hz|60 Hz power)\b/i),
  BAE076: (ctx) => powerValue(ctx, /\b(rated performance at 50 Hz|50 Hz power)\b/i),
  AAV072: attrValue(/\b(efficiency class|IEC 60034-30)\b/i),
  AAC136: attrNumber(/\b(synchronal revolution at 50 Hz|synchronous speed)\b/i),
  BAG342: degreeOfProtection,
  AAD222: attrNumber(/\b(rotation speed|speed)\b/i),
  BAA072: attrValue(/\b(type of operation|duty type)\b/i),
  BAE122: attrValue(/\b(cooling type|type of cooling)\b/i),
  BAE070: attrValue(/\b(basic construction form|construction form)\b/i),
  BAE101: attrValue(/\b(impact load)\b/i),
  BAA580: attrNumber(/\b(nominal speed|rated speed)\b/i),
  BAA121: attrNumber(/\b(min(?:imum)? rotation speed|rotation speed)\b/i),
  BAE081: (ctx) => voltageValue(ctx, /\b(rated voltage.*reduced|rated voltage)\b/i),
  BAE069: attrValue(/\b(construction form of DC motor|DC motor construction)\b/i),
  BAE089: attrValue(/\b(type of exciter|exciter type)\b/i),
  AAB387: attrYesNo(/\b(main switch)\b/i),
  AAB388: attrYesNo(/\b(load[- ]break switch)\b/i),
  AAB391: attrYesNo(/\b(safety switch)\b/i),
  AAB454: (ctx) => powerValue(ctx, /\b(rated operating power.*AC-23|AC-23.*power)\b/i),
  AAB486: ratedOperationalCurrent,
  AAB487: ratedOperationalCurrent,
  AAB817: (ctx) => voltageValue(ctx, /\b(max(?:imum)? rated operating voltage.*AC|operating voltage.*AC)\b/i),
  AAP333: attrNumber(/\b(number of actuation directions|actuation directions)\b/i),
  AAP349: attrNumber(/\b(number of auxiliary contacts as changer|changer contacts)\b/i),
  AAP351: attrNumber(/\b(number of auxiliary contacts as opener|opener contacts)\b/i),
  AAP352: attrNumber(/\b(number of auxiliary contacts as shutter|shutter contacts)\b/i),
  AAP366: attrNumber(/\b(number of breaking contacts per actuation direction|breaking contacts)\b/i),
  AAP695: attrNumber(/\b(number of shutters per direction|shutters per direction)\b/i),
  AAP713: attrNumber(/\b(number of switch positions|switch positions)\b/i),
  AAW361: singleNemaProtection,
  AAZ486: nemaProtection,
  ABI270: attrNumber(/\b(min(?:imum)? resolution|resolution)\b/i),
  ABI720: nemaProtection,
  BAB788: attrNumber(/\b(number of switch positions|switch positions)\b/i),
  BAB789: attrNumber(/\b(number of switching stages|switching stages)\b/i),
  BAB944: attrValue(/\b(design of switch|switch design)\b/i),
  BAD169: attrYesNo(/\b(zero position)\b/i),

  // Cabinet and SPD leftovers.
  AAB401: attrValue(/\b(design of the 19 inch cabinet|19 inch cabinet design|cabinet design)\b/i),
  AAB644: attrYesNo(/\b(frame|shelf|outside installation)\b/i),
  AAB681: attrYesNo(/\b(metric installation)\b/i),
  AAB770: attrYesNo(/\b(lighting installation)\b/i),
  AAC054: attrYesNo(/\b(mounting plate adjustable|adjustable mounting plate)\b/i),
  AAC265: attrYesNo(/\b(back door)\b/i),
  AAC929: attrNumber(/\b(number of doors|doors)\b/i),
  AAE670: attrValue(/\b(additional link address|link address)\b/i),
  AAG021: attrValue(/\b(impact strength|IK)\b/i),
  AAM117: attrYesNo(/\b(glazed door)\b/i),
  AAM354: attrYesNo(/\b(tackable)\b/i),
  AAP542: attrNumber(/\b(number of locks|locks)\b/i),
  BAA105: attrNumber(/\b(number of locks|locks)\b/i),
  BAD288: attrYesNo(/\b(on plaster)\b/i),
  BAD290: attrYesNo(/\b(assembly on floor|floor assembly)\b/i),
  BAD307: attrYesNo(/\b(flush installation)\b/i),
  BAE765: attrNumber(/\b(number of height units|height units)\b/i),
  BAF728: attrYesNo(/\b(mounting plate present|mounting plate)\b/i),
  BAH439: ralColorNumber,
  BAH443: attrYesNo(/\b(inspection door)\b/i),
  AAB392: attrYesNo(/\b(door.*disconnecting switch interlock|disconnecting switch interlock)\b/i),
  AAB633: attrYesNo(/\b(suitable as rear wall|rear wall)\b/i),
  AAB634: attrYesNo(/\b(suitable as side wall|side wall)\b/i),
  AAB670: attrYesNo(/\b(cable routing)\b/i),
  AAB732: attrYesNo(/\b(cable leadthrough)\b/i),
  AAC900: attrValue(/\b(grid dimensions?|grid)\b/i),
  AAG239: attrYesNo(/\b(hinging|hinged)\b/i),
  AAU729: productBase,
  AAW352: (ctx) => dimensionValue(ctx, ["width"], /\b(enclosure building width|building width)\b/i),
  BAB901: attrValue(/\b(design)\b/i),
  BAC000: constructionForm,
  BAF343: attrYesNo(/\b(air intake and exhaust|air intake|air exhaust)\b/i),
  BAF727: attrYesNo(/\b(cable inlet)\b/i),
  BAG533: attrYesNo(/\b(lock present|lock)\b/i),
  BAH464: attrYesNo(/\b(ventilation)\b/i),
  AAF020: certificateApproval,
  ABD826: attrValue(/\b(configuration of SPD|SPD configuration)\b/i),
  ABD827: attrNumber(/\b(number of ports|ports)\b/i),
  ABD829: attrValue(/\b(min(?:imum)? wire cross[- ]section|wire cross[- ]section)\b/i),
  ABD830: attrValue(/\b(max(?:imum)? wire cross[- ]section.*alarm|alarm circuit.*cross[- ]section)\b/i),
  ABD849: attrValue(/\b(preferred area of application|area of application)\b/i),
  ABD850: attrValue(/\b(suitable for)\b/i),
  ABD852: attrValue(/\b(version of the earth rod|earth rod)\b/i),
  ABD853: attrValue(/\b(design of the coupling|coupling)\b/i),
  ABD855: attrValue(/\bfitting\b/i),
  ABD858: (ctx) => voltageValue(ctx, /\b(nominal voltage.*AC|nominal voltage)\b/i),
  ABD860: attrValue(/\b(test standard|standard)\b/i),
  ABD862: attrValue(/\b(SPD type|IEC 61643)\b/i),
  ABD864: attrValue(/\b(characteristic of backup fuse|backup fuse)\b/i),
  ABD874: attrValue(/\b(type of remote indication contact|remote indication contact)\b/i),
  ABD875: attrValue(/\b(SPD failure mode|failure mode)\b/i),
  ABD876: attrValue(/\b(TOV.*120|min|TOV)\b/i),
  ABD878: attrValue(/\b(TOV.*200|TOV)\b/i),
  BAB934: connectionType,
  BAC678: attrNumber(/\b(max(?:imum)? nominal frequency|nominal frequency)\b/i),
  BAC741: attrNumber(/\b(min(?:imum)? nominal frequency|nominal frequency)\b/i),
  BAD979: (ctx) => lengthValue(ctx, /\b(diameter of conductor|conductor diameter|diameter)\b/i),

  // Cable, connector, busbar, command-device, safety/fluid sensor, and drive details.
  BAD974: (ctx) => lengthValue(ctx, /\b(cable outer diameter|outer diameter|outside diameter|diameter)\b/i),
  AAP775: attrNumber(/\b(number of wires|number of cores|number of conductors|wires|cores|conductors)\b/i),
  BAI969: attrUnitNumber(/\b(cable length|length)\b/i, "m"),
  AAL135: attrYesNo(/\boil[- ]resistant|oil resistance\b/i),
  BAD999: attrYesNo(/\boil[- ]resistant|oil resistance\b/i),
  AAK280: attrValue(/\b(flame retardant|flame resistance|IEC\s*60332|EN\s*60332)\b/i),
  BAE013: (ctx) => lengthValue(ctx, /\b(nominal diameter of cable|nominal diameter|diameter)\b/i),
  BAE015: (ctx) => voltageValue(ctx, /\b(nominal voltage U0|voltage U0|rated voltage|nominal voltage)\b/i),
  AAI407: (ctx) => lengthValue(ctx, /\b(cable outer diameter|outer diameter|outside diameter|diameter)\b/i),
  BAD995: attrYesNo(/\b(cold resistant|cold resistance|EN\s*60811-1-4)\b/i),
  AAK395: screenOverStrandingElement,
  AAI690: (ctx) => dimensionValue(ctx, ["height"], /\b(height of cable|cable height|height)\b/i),
  AAC028: (ctx) => temperatureBound(ctx, "min", /\b(cable outside temperature|fixed laid|permissible cable temperature|ambient temperature|operating temperature)\b/i),
  AAL680: attrYesNo(/\b(halogen free|halogen-free|EN\s*50267)\b/i),
  BAE021: attrValue(/\b(material of wire insulation|wire insulation material|insulation material)\b/i),
  AAF526: (ctx) => temperatureBound(ctx, "min", /\b(ambient temperature.*operating|operating temperature|ambient temperature)\b/i),
  AAF525: (ctx) => temperatureBound(ctx, "max", /\b(ambient temperature.*operating|operating temperature|ambient temperature)\b/i),
  BAD971: attrValue(/\b(construction of cabled element|cabled element construction|cable construction)\b/i),
  BAE005: attrValue(/\b(class of conductor|conductor class)\b/i),
  BAH000: attrYesNo(/\b(waterproof transversally|transversal water|water blocking|water-blocking)\b/i),
  BAE035: attrValue(/\b(EN\s*50200|EN\s*50362|FE\s*180|fire resistant|insulation conforms)\b/i),
  AAF516: attrValue(/\b(design of shield|shield design|screen design)\b/i),
  BAE039: attrValue(/\b(design of shield over cabling|shield over cabling|screen over cabling|shield design)\b/i),
  BAB378: (ctx) => colorValue(ctx, /\b(colou?r of coat|coat colou?r|jacket colou?r|mantle colou?r)\b/i),
  AAK402: attrValue(/\b(protective sheath|protective jacket|protective mantle)\b/i),
  AAK718: attrValue(/\b(material of the sheath|sheath material|jacket material|cable jacket material)\b/i),
  AAK528: attrValue(/\b(material of the core insulation|core insulation material|wire insulation material)\b/i),
  BAE029: attrValue(/\b(material of the mantle|mantle material|jacket material|cable jacket material)\b/i),
  BAE040: attrValue(/\b(material of the protective mantle|protective mantle material|protective sheath material)\b/i),
  AAD244: attrValue(/\b(cable category|category)\b/i),
  BAD983: attrValue(/\b(function retention|circuit integrity|E30|E60|E90)\b/i),
  BAB267: attrUnitNumber(/\b(conductor cross[- ]section|cross[- ]section|wire size)\b/i, "mm"),
  BAE020: attrNumber(/\b(surge impedance|impedance)\b/i),
  AAF515: attrNumber(/\binductance\b/i),
  AAF511: attrNumber(/\b(max(?:imum)? traction stress|traction stress|tensile strength|pulling force)\b/i),

  CNSELEK: attrValue(/\b(connector symbol|symbol number|symbol)\b/i),
  "CNSELEK|4": attrValue(/\b(connector symbol|symbol number|symbol)\b/i),
  CODING: connectorCoding,
  CNS_CONNECTOR_CODING: connectorCoding,
  "CONNECTOR POLARIZATION": attrValue(/\b(polarization|polarisation)\b/i),
  CNS_CONNECTOR_POLARIZATION: attrValue(/\b(polarization|polarisation)\b/i),
  AAB515: attrYesNo(/\b(seal present|seal|sealing)\b/i),
  BAC677: attrUnitNumber(/\b(max(?:imum)? line cross[- ]section.*rigid|rigid line cross[- ]section|line cross[- ]section)\b/i, "mm"),
  AAS459: attrValue(/\b(corrosion resistance|corrosion resistant)\b/i),
  BAD449: attrYesNo(/\b(locking present|lock present|locking)\b/i),
  AAP372: attrNumber(/\b(number of cable inlets|cable inlets|entries)\b/i),
  BAC739: attrUnitNumber(/\b(min(?:imum)? line cross[- ]section.*flexible|flexible line cross[- ]section)\b/i, "mm"),
  BAC740: attrUnitNumber(/\b(min(?:imum)? line cross[- ]section.*rigid|rigid line cross[- ]section)\b/i, "mm"),
  AAB224: attrValue(/\b(arrangement of the cable lead[- ]in|cable lead[- ]in arrangement|cable entry arrangement)\b/i),

  AAJ095: (ctx) => lengthValue(ctx, /\b(min(?:imum)? clamping range|clamping range)\b/i),
  AAJ094: (ctx) => lengthValue(ctx, /\b(max(?:imum)? clamping range|clamping range)\b/i),
  BAA997: (ctx) => lengthValue(ctx, /\b(thread length)\b/i),
  AAS481: attrValue(/\b(thread type|type of thread|thread)\b/i),
  AAH509: (ctx) => lengthValue(ctx, /\b(min(?:imum)? sealing range|sealing range)\b/i),
  AAH508: (ctx) => lengthValue(ctx, /\b(max(?:imum)? sealing range|sealing range)\b/i),
  AAS484: attrYesNo(/\b(bend protection)\b/i),
  AAS485: attrYesNo(/\b(counter nut|locknut|lock nut)\b/i),
  AAZ374: attrValue(/\b(type of cable anchorage|cable anchorage|anchorage)\b/i),
  AAQ204: attrValue(/\b(sealing type|type of sealing|seal type)\b/i),
  AAS487: attrNumber(/\b(number of cable feed[- ]throughs|feed[- ]throughs|cable entries)\b/i),

  AAC134: (ctx) => currentValue(ctx, /\b(current input|input current)\b/i),
  AAG331: (ctx) => colorValue(ctx, /\b(colou?r of lamp hood|lamp hood colou?r|lens colou?r|light colou?r)\b/i),
  AAI308: attrNumber(/\b(number of modes|modes)\b/i),
  AAI365: attrNumber(/\b(number of tones|tones)\b/i),
  AAI677: attrNumber(/\b(loudness|sound pressure|sound level|dB)\b/i),
  AAO509: attrNumber(/\b(number of illumination devices|illumination devices|number of lamps|lamps)\b/i),
  AAO608: attrValue(/\b(device group.*explosion|explosion device group|ATEX group)\b/i),
  AAO609: attrValue(/\b(category.*explosion|explosion category|ATEX category)\b/i),
  AAO619: attrValue(/\b(explosion protection zone|ATEX zone|hazardous zone|zone)\b/i),
  AAO620: (ctx) => colorValue(ctx, /\b(colou?r of covering|covering colou?r|cover colou?r)\b/i),
  AAO853: attrValue(/\b(Federal Physical[- ]Technical Institute|PTB|Braunschweig)\b/i),
  AAO893: attrValue(/\b(fitting design|fitting|lamp base|socket)\b/i),
  AAQ325: attrValue(/\b(type of protection.*explosion|explosion protection type|ATEX protection type|EEx)\b/i),
  BAA017: attrValue(/\b(design|construction form|construction type)\b/i),
  BAA208: (ctx) => powerValue(ctx, /\b(max(?:imum)? permitted power|max(?:imum)? permissible power|max(?:imum)? power)\b/i),
  BAA209: attrValue(/\b(design of illuminant|illuminant design|lamp type|light source)\b/i),
  BAA469: voltageType,
  BAB235: attrValue(/\b(explosion protection marking|ATEX marking|Ex marking)\b/i),
  BAB381: attrYesNo(/\b(central lock|central switch|lock\/switch)\b/i),
  BAB574: (ctx) => powerValue(ctx, /\b(power|wattage)\b/i),
  BAD006: (ctx) => attr(ctx, /\bcurrent type\b/i) ?? voltageType(ctx),
  BAE540: (ctx) => attr(ctx, /\bambient temperature\b/i) ?? tempRange(ctx).max,
  BAG981: electricalConnectionDesign,

  AAB218: (ctx) => overloadSetting(ctx, "min") ?? currentValue(ctx, /\b(lowest value adjustable current range|adjustable current range|current setting range)\b/i),
  AAB367: connectionType,
  AAB534: attrYesNo(/\banalog temperature sensor\b/i),
  AAB535: attrYesNo(/\bearth[- ]fault detection\b/i),
  AAB536: attrYesNo(/\bthermistor connection\b/i),
  AAB548: (ctx) => overloadSetting(ctx, "max") ?? currentValue(ctx, /\b(greatest value adjustable current range|adjustable current range|current setting range)\b/i),
  AAB726: attrYesNo(/\bintegrated earth[- ]fault protection\b/i),
  AAC124: attrYesNo(/\bvoltage acquisition module\b/i),
  AAC135: attrYesNo(/\bcurrent acquisition module\b/i),
  AAF697: attrNumber(/\b(number of binary inputs|binary inputs)\b/i),
  AAN359: attrYesNo(/\b(HMI port)\b/i),
  AAN363: attrYesNo(/\bbuilt[- ]in current sensor\b/i),
  AAN366: attrYesNo(/\bstall detection\b/i),
  AAN367: attrYesNo(/\bjam detection\b/i),
  AAN370: attrYesNo(/\bpower variation detection\b/i),
  AAN371: attrYesNo(/\bload shedding\b/i),
  AAN372: attrYesNo(/\bcos\(?(?:phi|φ)\)?.*variation\b/i),
  AAN373: attrYesNo(/\bphase reversal detection\b/i),
  AAN374: attrYesNo(/\bphase imbalance detection\b/i),
  AAP442: attrNumber(/\b(number of electronic outputs|electronic outputs)\b/i),
  AAP614: attrNumber(/\b(number of outputs.*contacts|outputs with contacts|contact outputs)\b/i),

  AAB352: attrNumber(/\b(number of safety[- ]related auxiliary contacts|safety auxiliary contacts|auxiliary contacts)\b/i),
  AAB412: attrValue(/\b(design of the switching element|switching element design|switching element)\b/i),
  AAB462: (ctx) => valueAtVoltage(attr(ctx, /\brated operating current.*AC-15\b/i), 125, "A"),
  AAB465: (ctx) => valueAtVoltage(attr(ctx, /\brated operating current.*AC-15\b/i), 230, "A"),
  AAB466: (ctx) => valueAtVoltage(attr(ctx, /\brated operating current.*AC-15\b/i), 24, "A"),
  AAB478: (ctx) => valueAtVoltage(attr(ctx, /\brated operating current.*DC-13\b/i), 125, "A"),
  AAB480: (ctx) => valueAtVoltage(attr(ctx, /\brated operating current.*DC-13\b/i), 230, "A"),
  AAB481: (ctx) => valueAtVoltage(attr(ctx, /\brated operating current.*DC-13\b/i), 24, "A"),
  AAB961: (ctx) => minControlVoltage(ctx, 50),
  AAB962: (ctx) => minControlVoltage(ctx, 60),
  AAB963: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? rated control voltage.*DC|control voltage.*DC)\b/i),
  AAC121: attrValue(/\b(signal outputs? of the shaft encoder|encoder output|signal output)\b/i),
  AAC805: attrNumber(/\bhysteresis\b/i),
  AAC826: (ctx) => valueAtVoltage(attr(ctx, /\b(operating current.*DC-13|rated operating current.*DC-13)\b/i), 230, "A"),
  AAC925: attrNumber(/\b(number of breaking contacts|breaking contacts)\b/i),
  AAF284: eanOrGtin,
  AAF309: (ctx) => lengthValue(ctx, /\b(cable length|length of the cable)\b/i),
  AAF715: (ctx) => voltageValue(ctx, /\b(max(?:imum)? switching voltage|switching voltage)\b/i),
  AAF716: (ctx) => minVoltageOf(ctx, /\b(min(?:imum)? switching voltage|switching voltage)\b/i),
  AAH842: attrNumber(/\b(max(?:imum)? rotation speed|rotation speed|speed)\b/i),
  AAW359: attrValue(/\b(type of guard locking|guard locking)\b/i),
  AAZ273: attrValue(/\b(PFHD|probability of dangerous failure)\b/i),
  AAZ279: attrValue(/\b(safety integrity level|SILcl|SIL)\b/i),
  AAZ300: attrValue(/\b(service life.*standard|service life standard|EN ISO 13849)\b/i),
  AAZ302: (ctx) => protocol(ctx) ?? attr(ctx, /\b(interface standard|interface)\b/i),
  AAZ303: electricalConnectionDesign,
  ABD922: (ctx) => dimensionValue(ctx, ["height"], /\b(height of the protective field|protective field height)\b/i),
  ABD923: (ctx) => dimensionValue(ctx, ["width"], /\b(width of the protective field|protective field width)\b/i),
  ABD924: (ctx) => lengthValue(ctx, /\b(resolution of the protective field|protective field resolution|resolution)\b/i),
  BAC514: attrValue(/\b(contact,? type of|contact type|type of contact)\b/i),
  BAD808: attrValue(/\b(design of output signal switching device|output signal switching device|output type|switching output)\b/i),
  BAD811: attrUnitNumber(/\b(min(?:imum)? output current|output current)\b/i, "mA"),
  BAD836: attrYesNo(/\bemergency unlocking device\b/i),
  BAD854: attrValue(/\b(category safety|safety category|EN\s*954)\b/i),
  BAG281: attrValue(/\b(class of fire resistance|fire resistance)\b/i),

  AAA900: (ctx) => pressureValue(ctx, /\b(max(?:imum)? operating pressure|operating pressure)\b/i),
  AAB217: attrNumber(/\b(lowest value.*response value.*flow.*gas|response value.*flow.*gas|flow response)\b/i),
  AAB504: attrValue(/\b(housing coating|coating of housing)\b/i),
  AAB521: attrYesNo(/\b(wire[- ]break|measuring shunt circuit monitor|shunt monitor)\b/i),
  AAB523: (ctx) => pressureValue(ctx, /\b(pressure resistance of measuring head|measuring head pressure resistance|pressure resistance)\b/i),
  AAB547: attrNumber(/\b(greatest value.*response value.*flow.*gas|response value.*flow.*gas|flow response)\b/i),
  AAB656: attrYesNo(/\bsuitable for liquids?\b/i),
  AAB864: (ctx) => temperatureBound(ctx, "max", /\b(max(?:imum)? medium temperature|medium temperature|fluid temperature)\b/i),
  AAB905: (ctx) => temperatureBound(ctx, "max", /\b(max(?:imum)? ambient temperature.*evaluating electronics|ambient temperature.*electronics|ambient temperature)\b/i),
  AAB988: (ctx) => temperatureBound(ctx, "min", /\b(min(?:imum)? medium temperature|medium temperature|fluid temperature)\b/i),
  AAC021: (ctx) => temperatureBound(ctx, "min", /\b(min(?:imum)? ambient temperature.*evaluating electronics|ambient temperature.*electronics|ambient temperature)\b/i),
  AAF358: attrValue(/\b(flow direction)\b/i),
  AAK401: attrValue(/\b(protection class|class of protection)\b/i),
  AAR853: attrUnitNumber(/\b(max(?:imum)? cable length|cable length)\b/i, "m"),
  AAR854: (ctx) => pressureValue(ctx, /\b(pressure rated to|rated pressure|pressure rating)\b/i),
  AAR855: (ctx) => temperatureBound(ctx, "min", /\b(min(?:imum)? temperature of liquid medium|liquid medium temperature|liquid temperature)\b/i),
  AAR856: (ctx) => temperatureBound(ctx, "max", /\b(max(?:imum)? temperature of liquid medium|liquid medium temperature|liquid temperature)\b/i),
  AAR857: (ctx) => temperatureBound(ctx, "min", /\b(min(?:imum)? temperature of gaseous medium|gaseous medium temperature|gas temperature)\b/i),
  AAR860: attrNumber(/\b(max(?:imum)? response time|response time)\b/i),
  AAR861: attrNumber(/\b(MTTF|mean time to failure)\b/i),
  AAR863: attrYesNo(/\bflow monitoring\b/i),
  AAR864: attrValue(/\b(type of adjustment|adjustment type|adjustment)\b/i),
  AAR865: attrYesNo(/\b(ATEX II.*gas|ATEX.*gas|gas approval)\b/i),
  AAR866: attrYesNo(/\b(ATEX II.*dust|ATEX.*dust|dust approval)\b/i),
  AAR868: attrYesNo(/\bcULus\b/i),
  AAR869: attrNumber(/\binternal capacitance\b/i),
  AAT066: attrValue(/\b(SILcl|SIL.*EN\s*62061)\b/i),
  AAZ262: attrValue(/\b(measured values?|measured variable|measuring variable)\b/i),
  AAZ270: (ctx) => pressureValue(ctx, /\b(nominal operating pressure|PN|nominal pressure)\b/i),
  ABD905: attrValue(/\b(operating medium|medium)\b/i),
  ABD906: attrNumber(/\b(nominal temperature|rated temperature)\b/i),
  ABF794: attrValue(/\b(hydraulic port|port)\b/i),
  BAB349: attrYesNo(/\b(adjustability of trip point|trip point adjustable|adjustable trip)\b/i),
  BAD815: (ctx) => lengthValue(ctx, /\b(switching distance|sensing distance)\b/i),
  BAG982: attrValue(/\b(nominal size|DN)\b/i),

  AAB641: attrNumber(/\b(suitable for number of units|number of units|modular units)\b/i),
  AAB662: attrYesNo(/\b(auxiliary switch)\b/i),
  AAB663: attrYesNo(/\b(N[- ]conductor|neutral conductor)\b/i),
  AAC139: (ctx) => lengthValue(ctx, /\b(module width|width)\b/i),
  AAC923: attrNumber(/\b(number of phases|phases)\b/i),
  AAG049: attrYesNo(/\b(version cover|cover present|cover)\b/i),
  AAL483: attrYesNo(/\b(ex[- ]applications|explosion application|ATEX)\b/i),
  AAL739: attrYesNo(/\binsulator\b/i),
  AAP397: attrNumber(/\b(number of connections|connections)\b/i),
  AAP550: attrNumber(/\b(number of modular spacings|modular spacings)\b/i),
  AAP621: attrNumber(/\b(number of phases|phases)\b/i),
  AAZ391: attrValue(/\b(surface coating conductor|surface coating|contact coating|coating)\b/i),
  AAZ396: attrValue(/\b(connection form|form of connection)\b/i),
  AAZ431: attrValue(/\b(phase rail design|busbar design|rail design)\b/i),
  AAZ432: attrNumber(/\b(number of connection lugs|connection lugs)\b/i),
  AAZ433: attrYesNo(/\b(connection lugs breakable|breakable lugs)\b/i),
  AAZ434: (ctx) => powerValue(ctx, /\b(power loss per meter|power loss)\b/i),
  BAC892: (ctx) =>
    numberWithUnit(
      attr(ctx, /\bbusbar cross[- ]section\b/i) ?? attrExcept(ctx, /\bcross[- ]section\b/i, /\b(line|wire|conductor|terminal)\b/i),
      "mm"
    ),
  BAD383: attrYesNo(/\binsulation present|insulated\b/i),

  AAG644: attrValue(/\b(down force size|socket size|screw head size)\b/i),
  AAT149: (ctx) => colorValue(ctx, /\b(colou?r actuating element|actuating element colou?r)\b/i),
  AAZ330: attrNumber(/\b(pole number signal|signal pole number)\b/i),
  AAZ331: attrNumber(/\b(number of rows signal|signal rows)\b/i),
  AAZ332: (ctx) => lengthValue(ctx, /\b(pin length|length of pin)\b/i),
  AAZ337: attrNumber(/\b(number of conductor connections per pole|conductor connections per pole)\b/i),
  AAZ338: attrNumber(/\b(number of signal conductor connections per pole|signal conductor connections per pole)\b/i),
  AAZ339: attrValue(/\b(actuation of the conductor connection|conductor connection actuation|actuation)\b/i),
  AAZ340: attrValue(/\b(screw head form|screw head size|drive size)\b/i),
  AAZ341: attrNumber(/\b(actuation direction|actuation angle)\b/i),
  AAZ342: attrNumber(/\b(conductor connection direction|connection direction)\b/i),
  AAZ356: attrValue(/\b(pin dimensions?|pin size)\b/i),
  AAZ357: attrValue(/\b(pin dimensions? signal|signal pin dimensions?|pin size signal)\b/i),
  AAZ358: attrNumber(/\b(plug[- ]in direction|plug direction)\b/i),
  AAZ359: attrValue(/\b(direction mating face|mating face direction)\b/i),
  AAZ541: attrValue(/\b(min(?:imum)? connectable conductor size.*AWG|AWG.*min(?:imum)?|min(?:imum)? AWG)\b/i),
  AAZ542: attrValue(/\b(max(?:imum)? connectable conductor size.*AWG|AWG.*max(?:imum)?|max(?:imum)? AWG)\b/i),
  AAZ543: attrValue(/\b(min(?:imum)? connectable conductor size signal.*AWG|signal.*AWG.*min(?:imum)?)\b/i),
  AAZ544: attrValue(/\b(max(?:imum)? connectable conductor size signal.*AWG|signal.*AWG.*max(?:imum)?)\b/i),
  BAE750: attrNumber(/\b(number of levels|levels)\b/i),

  AAB639: attrYesNo(/\banalog signals?\b/i),
  AAB643: attrYesNo(/\bPLC output card\b/i),
  AAB651: attrYesNo(/\bdigital signals?\b/i),
  AAB654: attrYesNo(/\bPLC input card\b/i),
  BAB968: voltageType,
  BAC063: (ctx) => currentValue(ctx, /\b(rated error current|error current|residual current)\b/i),
  BAC384: attrValue(/\b(residual current type|RCD type)\b/i),
  BAC403: attrNumber(/\b(frequency|nominal frequency)\b/i),
  BAD347: attrYesNo(/\b(field bus connection.*bus coupler|bus coupler|fieldbus connection)\b/i),
  BAH319: attrValue(/\b(design of digital output|digital output design|output type)\b/i),

  AAB403: attrValue(/\b(design of the connectable sensor|connectable sensor|sensor design)\b/i),
  AAC149: (ctx) => currentValue(ctx, /\b(overloading ability of excess current|excess current|overload current)\b/i),
  AAC216: (ctx) => voltageValue(ctx, /\b(link voltage|DC link voltage)\b/i),
  AAC801: attrNumber(/\b(relative symmetric mains frequency tolerance|frequency tolerance)\b/i),
  AAD239: (ctx) => attr(ctx, /\b(supply voltage)\b/i) ?? clean(ctx.result?.normalized.voltage),
  BAC671: (ctx) => powerValue(ctx, /\b(max(?:imum)? power|max(?:imum)? output power|power)\b/i),
  BAE100: attrValue(/\b(design of feedback system|feedback system)\b/i),
  BAE107: (ctx) => voltageValue(ctx, /\b(rated output voltage|output voltage)\b/i),
  BAE111: attrNumber(/\b(output phases|number of output phases|phases)\b/i),
  BAE120: attrValue(/\b(installation environment.*EMC|EMC environment|installation environment)\b/i),
  BAE125: attrNumber(/\b(max(?:imum)? output frequency|output frequency)\b/i),
  BAE130: attrValue(/\b(power frequency|mains frequency|frequency)\b/i),

  "CABLE ELEMENT IDENTIFIER": attrValue(/\b(cable element identifier|wire id|wire identifier|core id|conductor id)\b/i),
  AAN529: attrValue(/\b(cross[- ]section AWG|AWG|wire gauge)\b/i),
  CNS_CROSSECTION_AWG: attrValue(/\b(cross[- ]section AWG|AWG|wire gauge)\b/i),
  AAN524: attrValue(/\b(design of wire|wire design)\b/i),
  CNS_DESIGN_OF_WIRE: attrValue(/\b(design of wire|wire design)\b/i),
  AAN525: attrValue(/\b(function of wire|wire function)\b/i),
  CNS_FUNCTION_OF_WIRE: attrValue(/\b(function of wire|wire function)\b/i),
  AAN526: attrValue(/\b(construction of wire|wire construction)\b/i),
  CNS_CONSTRUCTION_OF_WIRE: attrValue(/\b(construction of wire|wire construction)\b/i),
  AAN530: (ctx) => materialAttribute(ctx, /\b(material of wire|wire material|core material|conductor material)\b/i) ?? normalizedMaterial(ctx),
  CNS_CORE_MATERIAL: (ctx) => materialAttribute(ctx, /\b(material of wire|wire material|core material|conductor material)\b/i) ?? normalizedMaterial(ctx),
  AAN523: attrValue(/\b(connection description|connection)\b/i),
  CNS_CONNECTION_DESCRIPTION: attrValue(/\b(connection description|connection)\b/i),
  AAN506: (ctx) => attr(ctx, /\b(type of connection|connection type)\b/i) ?? "electrical connection",
  CNS_TYPE_OF_CONNECTION: (ctx) => attr(ctx, /\b(type of connection|connection type)\b/i) ?? "electrical connection",
  AAN527: (ctx) => lengthValue(ctx, /\b(outer diameter of wire|wire outer diameter|outer diameter|diameter)\b/i),
  BAC469: (ctx) => colorValue(ctx, /\b(colou?r of wire|wire colou?r|core colou?r|conductor colou?r)\b/i),
  "CABLE ELEMENT IDENTIFIER A": attrValue(/\b(potential type|wire potential|conductor potential)\b/i),
  "CABLE ELEMENT IDENTIFIER B": attrValue(/\b(shielded by|shield|screen)\b/i),
  "CABLE ELEMENT IDENTIFIER C": attrValue(/\b(twisted pair|differential pair|pair index)\b/i),

  CNS_PROJECT_PATH: attrValue(/\b(CNS project path|project path)\b/i),
  CNS_CONDITION: attrValue(/\b(CNS condition|condition)\b/i),
  CNS_COMPONENT_FUNCTION_3D: attrValue(/\b(component function 3D|component function|3D function)\b/i),
  CNS_COMPONENT_GROUP: attrValue(/\b(component group|component grouping|grouping)\b/i),
  "000038001": attrValue(/\b(explicit component type|component type)\b/i),
  CNS_PROFILE_2D: attrValue(/\b(profile 2D|2D profile|DXF profile|profile dxf)\b/i),

  AAB421: attrYesNo(/\b(extended temperature range|wide temperature range)\b/i),
  AAB589: attrYesNo(/\bETSI\b/i),
  AAC262: attrYesNo(/\b(dismantleable|dismantlable|demountable)\b/i),
  AAC266: attrYesNo(/\b(grounding|earthing)\b/i),
  AAC267: attrYesNo(/\b(sidewalls? viable|sidewalls? present|side wall)\b/i),
  AAC268: attrYesNo(/\b(front door present|front door)\b/i),
  AAC269: attrYesNo(/\b(roof plate viable|roof plate|top plate)\b/i),
  AAC270: attrYesNo(/\b(socket viable|socket present|base socket)\b/i),
  AAM477: attrValue(/\b(delivered component|included component|delivery contents)\b/i),
  AAM490: attrValue(/\b(grid dimensions?|rack dimension|19 inch|10 inch|21 inch)\b/i),
  BAE668: attrValue(/\b(19 inch level|rack level|mounting level)\b/i),
  BAE669: attrValue(/\b(19 inch profile tracks|profile tracks|rack rails)\b/i),
  BAF148: attrValue(/\b(place of use|indoor|outdoor|installation location)\b/i),

  AAC193: attrNumber(/\b(choking factor|choke factor)\b/i),
  AAI871: attrNumber(/\b(number of poles.*primary|poles.*primary|primary side poles)\b/i),
  AAB596: attrNumber(/\b(filterbank capacity|filter bank capacity|capacity)\b/i),

  "000025001": attrValue(/\b(connector symbol|symbol number|symbol)\b/i),
  AAS469: (ctx) => materialAttribute(ctx, /\b(material of the contact carrier frame|contact carrier material|carrier frame material)\b/i) ?? normalizedMaterial(ctx),
  AAZ506: attrNumber(/\b(number of module positions|module positions|positions)\b/i),
  AAS465: attrNumber(/\b(insertion cycles?.*min|min(?:imum)? insertion cycles|insertion cycles)\b/i),

  AAZ925: attrNumber(/\b(number of gripper fingers|gripper fingers|fingers)\b/i),
  AAZ927: attrNumber(/\b(gripping force.*internal|internal gripping force|gripping force)\b/i),
  AAZ931: (ctx) => lengthValue(ctx, /\b(stroke per gripper jaw|gripper jaw stroke|jaw stroke)\b/i),
  AAZ945: (ctx) => lengthValue(ctx, /\b(max(?:imum)? X[- ]stroke|X[- ]stroke)\b/i),
  AAZ946: (ctx) => lengthValue(ctx, /\b(max(?:imum)? Y[- ]stroke|Y[- ]stroke)\b/i),
  AAZ990: attrValue(/\b(active direction of gripping force backup|gripping force backup|backup direction)\b/i),

  BAD296: attrYesNo(/\b(rack[- ]assembly possible|rack assembly|rack mounting)\b/i),
  BAD917: attrValue(/\b(interference resistance to magnetic fields|magnetic field resistance|magnetic immunity)\b/i),

  AAB507: (ctx) => dimensionValue(ctx, ["width"], /\b(width of the terminal|terminal width|width)\b/i),
  AAB638: attrValue(/\b(suitable for|application suitability)\b/i),
  AAB882: (ctx) => lengthValue(ctx, /\b(max(?:imum)? busbar width|busbar width)\b/i),
  AAB883: (ctx) => lengthValue(ctx, /\b(max(?:imum)? busbar thickness|busbar thickness)\b/i),
  AAP403: attrNumber(/\b(number of contact points per level|contact points per level)\b/i),
  BAD774: attrYesNo(/\b(closing plate required|closing plate reqquired|end plate required)\b/i),
  BAB838: attrValue(/\b(type of locking|locking type|locking)\b/i),
  BAC476: (ctx) => dimensionValue(ctx, ["height"], /\b(height at lowest possible mounting|lowest mounting height|height)\b/i),

  AAN328: attrNumber(/\b(max(?:imum)? switching frequency|switching frequency)\b/i),
  AAZ419: attrValue(/\b(manual override|override)\b/i),
  AAZ835: attrNumber(/\b(remaining working time.*cycles|remaining cycles|working time.*cycles)\b/i),
  ABA669: manufacturerUrl,

  // Last shared two-tab fields with clear semantics.
  AAQ340: attrValue(/\b(temperature class|explosion-protected temperature class)\b/i),
  BAA295: attrNumber(/\b(degree of soiling|degree of contamination)\b/i),
  AAC049: attrYesNo(/\b(PE connection|protective earth connection)\b/i),
  BAC027: attrValue(/\b(manner of using|actuator manner|using)\b/i),
  BAD817: attrValue(/\b(design of actuating element|actuating element)\b/i),
  AAC097: switchFunction,
  BAD825: attrYesNo(/\b(pressure resistant|pressure resistance)\b/i),
  BAC137: (ctx) => lengthValue(ctx, /\b(width of spacing|spacing width|spacing)\b/i)
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
    for (const variant of propertyKeyVariants(normalized)) keys.add(variant);
    // Codes such as "AAV774/AAO057" hold two ECLASS ids; try each independently.
    for (const part of normalized.split("/")) {
      const trimmed = part.trim();
      for (const variant of propertyKeyVariants(trimmed)) keys.add(variant);
    }
  }
  return [...keys];
}

function propertyKeyVariants(key: string): string[] {
  const variants = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) variants.add(trimmed);
  };
  add(key);
  add(key.replace(/^"+|"+$/g, ""));
  add(key.replace(/\s*\([^)]*\)\s*$/g, ""));
  add(key.replace(/\*+$/g, ""));
  return [...variants];
}
