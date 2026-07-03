import { normalizeNumberSeparators } from "../text-util.js";

const UNIT_ALIASES: Record<string, string> = {
  a: "A",
  amp: "A",
  amps: "A",
  ampere: "A",
  amperes: "A",
  ma: "mA",
  milliamp: "mA",
  milliamps: "mA",
  milliampere: "mA",
  milliamperes: "mA",
  ka: "kA",
  v: "V",
  volt: "V",
  volts: "V",
  mv: "mV",
  kv: "kV",
  w: "W",
  watt: "W",
  watts: "W",
  mw: "mW",
  kw: "kW",
  hz: "Hz",
  hertz: "Hz",
  khz: "kHz",
  mhz: "MHz",
  nm: "Nm",
  "n*m": "Nm",
  "nÂ·m": "Nm",
  newtonmeter: "Nm",
  newtonmeters: "Nm",
  c: "C",
  "°c": "C",
  "degc": "C",
  mm: "mm",
  cm: "cm",
  m: "m",
  in: "in",
  inch: "in",
  inches: "in",
  '"': "in",
  ft: "ft",
  foot: "ft",
  feet: "ft",
  yd: "yd",
  yard: "yd",
  yards: "yd",
  g: "g",
  kg: "kg",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  oz: "oz",
  ounce: "oz",
  ounces: "oz",
  "nl/min": "Nl/min",
  "l/min": "l/min",
  lpm: "l/min",
  "m3/h": "m3/h",
  "m3/min": "m3/min",
  "dm3/min": "dm3/min",
  gpm: "gpm",
  cfm: "cfm",
  pa: "Pa",
  kpa: "kPa",
  mpa: "MPa",
  mbar: "mbar",
  bar: "bar",
  psi: "psi"
};

const UNIT_FACTORS: Record<string, number> = {
  A: 1,
  mA: 0.001,
  kA: 1000,
  V: 1,
  mV: 0.001,
  kV: 1000,
  W: 1,
  mW: 0.001,
  kW: 1000,
  Hz: 1,
  kHz: 1000,
  MHz: 1000000,
  Nm: 1,
  C: 1,
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
  yd: 914.4,
  g: 1,
  kg: 1000,
  lb: 453.59237,
  oz: 28.349523125,
  "Nl/min": 1,
  "l/min": 1,
  "m3/h": 1000 / 60,
  "m3/min": 1000,
  "dm3/min": 1,
  gpm: 3.785411784,
  cfm: 28.316846592,
  Pa: 0.00001,
  kPa: 0.01,
  MPa: 10,
  mbar: 0.001,
  bar: 1,
  psi: 0.0689475729
};

const UNIT_FAMILIES: Record<string, string> = {
  A: "current",
  mA: "current",
  kA: "current",
  V: "voltage",
  mV: "voltage",
  kV: "voltage",
  W: "power",
  mW: "power",
  kW: "power",
  Hz: "frequency",
  kHz: "frequency",
  MHz: "frequency",
  Nm: "torque",
  C: "temperature",
  mm: "length",
  cm: "length",
  m: "length",
  in: "length",
  ft: "length",
  yd: "length",
  g: "mass",
  kg: "mass",
  lb: "mass",
  oz: "mass",
  "Nl/min": "flowRate",
  "l/min": "flowRate",
  "m3/h": "flowRate",
  "m3/min": "flowRate",
  "dm3/min": "flowRate",
  gpm: "flowRate",
  cfm: "flowRate",
  Pa: "pressure",
  kPa: "pressure",
  MPa: "pressure",
  mbar: "pressure",
  bar: "pressure",
  psi: "pressure"
};

export interface UnitNumber {
  value: number;
  unit?: string;
}

export function normalizePdtCellNumber(value: string, targetUnit: string | undefined): string | undefined {
  const target = normalizeUnit(targetUnit);
  if (!target) return undefined;

  const values = extractUnitNumbers(value, target);
  if (values.length === 0) return stripSingleNumber(value);

  const normalized = values
    .map((entry) => convertUnitValue(entry, target))
    .filter((entry): entry is number => entry !== undefined && Number.isFinite(entry));
  if (normalized.length === 0) return undefined;

  return formatNumber(Math.max(...normalized));
}

export function maxUnitNumber(value: string | undefined, targetUnit: string): string | undefined {
  if (!value) return undefined;
  return normalizePdtCellNumber(value, targetUnit);
}

export function splitTemperatureRange(value: string | undefined): { min?: string; max?: string } {
  if (!value || /\brated operational current\b/i.test(value)) return {};
  const normalized = normalizeForParsing(value);
  const range = normalized.match(
    /(-?\d+(?:\.\d+)?)\s*(?:\.\.\.|\.{2}|-|to|do)\s*\+?(-?\d+(?:\.\d+)?)\s*(?:°?\s*C|deg\s*C|degrees?\s*C?)?\b/i
  );
  if (range) return { min: formatNumber(Number(range[1])), max: formatNumber(Number(range[2])) };

  const celsiusValues = [...normalized.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:°\s*)?C\b/gi)].map((match) =>
    formatNumber(Number(match[1]))
  );
  if (celsiusValues.length >= 2) return { min: celsiusValues[0], max: celsiusValues[celsiusValues.length - 1] };

  const plainRange = normalized.match(/(?:temp(?:erature)?|ambient|operating).*?(-?\d+(?:\.\d+)?)\s*(?:-|to|do)\s*(-?\d+(?:\.\d+)?)/i);
  if (plainRange) return { min: formatNumber(Number(plainRange[1])), max: formatNumber(Number(plainRange[2])) };
  return {};
}

function extractUnitNumbers(raw: string, targetUnit: string): UnitNumber[] {
  const text = normalizeForParsing(raw);
  const exact = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*(mA|kA|A|mV|kV|V|mW|kW|W|MHz|kHz|Hz|kg|g|lb|lbs|mm|cm|m|°C|C)\b/gi)]
    .map((match) => ({ value: Number(match[1]), unit: normalizeUnit(match[2]) }))
    .filter((entry) => Number.isFinite(entry.value) && Boolean(entry.unit)) as UnitNumber[];

  const flowExact = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*(Nl\s*\/\s*min|l\s*\/\s*min|lpm|m3\s*\/\s*h|m3\s*\/\s*min|dm3\s*\/\s*min|gpm|cfm)\b/gi)]
    .map((match) => ({ value: Number(match[1]), unit: normalizeUnit(match[2]) }))
    .filter((entry) => Number.isFinite(entry.value) && Boolean(entry.unit)) as UnitNumber[];
  const pressureExact = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*(mbar|kPa|MPa|Pa|bar|psi)\b/gi)]
    .map((match) => ({ value: Number(match[1]), unit: normalizeUnit(match[2]) }))
    .filter((entry) => Number.isFinite(entry.value) && Boolean(entry.unit)) as UnitNumber[];

  // Imperial length/mass — US manufacturers publish inches/feet/pounds/ounces. Word forms are
  // matched before their abbreviations (longest-first) and inch double-prime (6") is handled too.
  const imperialExact: UnitNumber[] = [
    ...text.matchAll(/(-?\d+(?:\.\d+)?)\s*(inches|inch|feet|foot|yards|yard|ounces|ounce|pounds|pound|in|ft|yd|oz)\b/gi)
  ]
    .map((match) => ({ value: Number(match[1]), unit: normalizeUnit(match[2]) }))
    .filter((entry) => Number.isFinite(entry.value) && Boolean(entry.unit)) as UnitNumber[];
  for (const match of text.matchAll(/(-?\d+(?:\.\d+)?)\s*"/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) imperialExact.push({ value, unit: "in" });
  }

  const sameFamily = [...exact, ...flowExact, ...pressureExact, ...imperialExact].filter((entry) => entry.unit && UNIT_FAMILIES[entry.unit] === UNIT_FAMILIES[targetUnit]);
  if (sameFamily.length > 0) return sameFamily;

  const range = text.match(/(-?\d+(?:\.\d+)?)\s*(?:\.\.\.|\.{2}|-|to|do)\s*\+?(-?\d+(?:\.\d+)?)/i);
  if (range) return [{ value: Number(range[1]) }, { value: Number(range[2]) }];

  const single = text.match(/-?\d+(?:\.\d+)?/);
  return single ? [{ value: Number(single[0]) }] : [];
}

function convertUnitValue(entry: UnitNumber, targetUnit: string): number | undefined {
  if (!entry.unit) return entry.value;
  if (entry.unit === targetUnit) return entry.value;
  if (UNIT_FAMILIES[entry.unit] !== UNIT_FAMILIES[targetUnit]) return undefined;
  return (entry.value * UNIT_FACTORS[entry.unit]) / UNIT_FACTORS[targetUnit];
}

function stripSingleNumber(value: string): string | undefined {
  const text = normalizeForParsing(value);
  const range = text.match(/(-?\d+(?:\.\d+)?)\s*(?:\.\.\.|\.{2}|-|to|do)\s*\+?(-?\d+(?:\.\d+)?)/i);
  if (range) return formatNumber(Math.max(Number(range[1]), Number(range[2])));
  const single = text.match(/-?\d+(?:\.\d+)?/);
  return single ? formatNumber(Number(single[0])) : undefined;
}

function normalizeUnit(value: string | undefined): string | undefined {
  const compact = value
    ?.replace(/\s+/g, "")
    .replace(/\u00b0/g, "°")
    .replace(/^℃$/, "°C")
    .trim()
    .toLowerCase();
  if (!compact) return undefined;
  return UNIT_ALIASES[compact];
}

function normalizeForParsing(value: string): string {
  const dashNormalized = value
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u00e2[\u20ac\u0088][\u201c\u201d\u0092\u0093\u0094]/g, "-");
  const collapsed = dashNormalized
    .replace(/[?\ufffd]\s*C\b/gi, " C")
    .replace(/\u00b3/g, "3")
    .replace(/Â°/g, "°")
    .replace(/℃/g, "°C")
    .replace(/−/g, "-")
    .replace(/(\d)\s*-\s*(\d)/g, "$1 to $2")
    .replace(/\s+/g, " ")
    .trim();
  // Resolve decimal vs. thousands separators per-number so "1,050.00 lbs" stays 1050, not 1.05.
  return normalizeNumberSeparators(collapsed);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  return String(Number(value.toFixed(6)));
}
