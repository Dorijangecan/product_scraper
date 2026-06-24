/**
 * Quantity grammar (Understanding Engine, workstream B-1).
 *
 * Turns a messy physical-quantity phrase into a STRUCTURED quantity so the rest
 * of the pipeline can "understand" what it scraped instead of regex-guessing:
 *
 *   "ambient temperature -40 to +80 °C"  -> { kind: temperature, min: -40, max: 80, unit: "°C" }
 *   "Rated current AC-1: 70 A at 40 °C"  -> { kind: current, value: 70, unit: "A", condition: "at 40 °C" }
 *   "24 V DC ±20%"                        -> { kind: voltage, value: 24, currentType: "DC", tolerance: { type:"percent", value:20 } }
 *   "230/400 V"                           -> { kind: voltage, values: [230,400] }
 *   "≤ 16 A"                              -> { kind: current, max: 16 }
 *
 * Deterministic, offline, weak-PC friendly — no model at runtime. This module is
 * intentionally side-effect free and standalone so it can be unit-tested in
 * isolation and reused by the normalizer, prose miner, and PDT resolvers.
 */

export type QuantityKind =
  | "voltage"
  | "current"
  | "power"
  | "apparentPower"
  | "reactivePower"
  | "charge"
  | "energy"
  | "temperature"
  | "mass"
  | "length"
  | "area"
  | "torque"
  | "frequency"
  | "pressure"
  | "flowRate"
  | "resistance"
  | "unknown";

export type QuantityQualifier = "min" | "max" | "nominal" | "range" | "point" | "alternatives";

export interface QuantityTolerance {
  type: "percent" | "absolute";
  value: number;
}

export interface ParsedQuantity {
  kind: QuantityKind;
  unit?: string;
  /** Single representative value (point/nominal/min/max). */
  value?: number;
  /** Range lower/upper bound. */
  min?: number;
  max?: number;
  /** Discrete alternatives, e.g. 230/400 V. */
  values?: number[];
  qualifier: QuantityQualifier;
  tolerance?: QuantityTolerance;
  currentType?: "AC" | "DC" | "AC/DC";
  /** Operating condition the value depends on, e.g. "at 40 °C" (kept, not mistaken for a reading). */
  condition?: string;
  raw: string;
}

export interface ParseQuantitiesOptions {
  /** When set, only quantities of this kind are returned. */
  kind?: QuantityKind;
}

interface UnitInfo {
  unit: string;
  kind: QuantityKind;
  currentType?: "AC" | "DC";
}

// Lowercased, whitespace-stripped unit token -> canonical unit + kind.
const UNIT_TABLE: Record<string, UnitInfo> = {
  vac: { unit: "V", kind: "voltage", currentType: "AC" },
  vdc: { unit: "V", kind: "voltage", currentType: "DC" },
  v: { unit: "V", kind: "voltage" },
  volt: { unit: "V", kind: "voltage" },
  volts: { unit: "V", kind: "voltage" },
  kv: { unit: "kV", kind: "voltage" },
  mv: { unit: "mV", kind: "voltage" },
  a: { unit: "A", kind: "current" },
  amp: { unit: "A", kind: "current" },
  amps: { unit: "A", kind: "current" },
  ampere: { unit: "A", kind: "current" },
  amperes: { unit: "A", kind: "current" },
  ka: { unit: "kA", kind: "current" },
  ma: { unit: "mA", kind: "current" },
  w: { unit: "W", kind: "power" },
  watt: { unit: "W", kind: "power" },
  watts: { unit: "W", kind: "power" },
  kw: { unit: "kW", kind: "power" },
  mw: { unit: "mW", kind: "power" },
  nm: { unit: "Nm", kind: "torque" },
  "°c": { unit: "°C", kind: "temperature" },
  degc: { unit: "°C", kind: "temperature" },
  hz: { unit: "Hz", kind: "frequency" },
  khz: { unit: "kHz", kind: "frequency" },
  mhz: { unit: "MHz", kind: "frequency" },
  pa: { unit: "Pa", kind: "pressure" },
  kpa: { unit: "kPa", kind: "pressure" },
  mpa: { unit: "MPa", kind: "pressure" },
  bar: { unit: "bar", kind: "pressure" },
  mbar: { unit: "mbar", kind: "pressure" },
  psi: { unit: "psi", kind: "pressure" },
  "nl/min": { unit: "Nl/min", kind: "flowRate" },
  "l/min": { unit: "l/min", kind: "flowRate" },
  lpm: { unit: "l/min", kind: "flowRate" },
  "m3/h": { unit: "m3/h", kind: "flowRate" },
  "m3/min": { unit: "m3/min", kind: "flowRate" },
  "dm3/min": { unit: "dm3/min", kind: "flowRate" },
  gpm: { unit: "gpm", kind: "flowRate" },
  cfm: { unit: "cfm", kind: "flowRate" },
  kg: { unit: "kg", kind: "mass" },
  mg: { unit: "mg", kind: "mass" },
  g: { unit: "g", kind: "mass" },
  lb: { unit: "lb", kind: "mass" },
  oz: { unit: "oz", kind: "mass" },
  mm: { unit: "mm", kind: "length" },
  cm: { unit: "cm", kind: "length" },
  "ω": { unit: "Ω", kind: "resistance" },
  ohm: { unit: "Ω", kind: "resistance" },
  "kω": { unit: "kΩ", kind: "resistance" },
  "mω": { unit: "MΩ", kind: "resistance" },
  va: { unit: "VA", kind: "apparentPower" },
  kva: { unit: "kVA", kind: "apparentPower" },
  var: { unit: "var", kind: "reactivePower" },
  kvar: { unit: "kvar", kind: "reactivePower" },
  ah: { unit: "Ah", kind: "charge" },
  mah: { unit: "mAh", kind: "charge" },
  wh: { unit: "Wh", kind: "energy" },
  kwh: { unit: "kWh", kind: "energy" },
  "mm²": { unit: "mm²", kind: "area" },
  mm2: { unit: "mm²", kind: "area" },
  "cm²": { unit: "cm²", kind: "area" },
  cm2: { unit: "cm²", kind: "area" }
};

// Order matters: most specific / longest first so e.g. "kg" wins over "g".
// Longest / most-specific tokens first within each overlap group, so e.g. "kVA" wins over "kV",
// "mAh" over "mA", "kWh" over "kW", and "mm²" over "mm".
const UNIT_PATTERN =
  "VAC|VDC|kVA|VA|kvar|var|kV|mV|V|mAh|Ah|kA|mA|A|kWh|Wh|kW|mW|W|Nm|°\\s*C|degC|kHz|MHz|Hz|mbar|kPa|MPa|Pa|bar|psi|Nl\\s*/\\s*min|l\\s*/\\s*min|lpm|m3\\s*/\\s*h|m3\\s*/\\s*min|dm3\\s*/\\s*min|gpm|cfm|kg|mg|g|lb|oz|mm²|mm2|cm²|cm2|mm|cm|MΩ|kΩ|Ω|ohm|amperes?|amps?|volts?|watts?";

const RANGE_SEP = "\\.{2,3}|…|\\bto\\b|\\bbis\\b|\\bdo\\b|~|/|-";

const QUALIFIER_TOKEN = "≤|<=|<|≥|>=|>|max\\.?|min\\.?|maximum|minimum|up\\s*to|nominal|rated";

const QUANTITY_RE = new RegExp(
  `(${QUALIFIER_TOKEN})?\\s*` +
    `([+-]?\\d+(?:\\.\\d+)?(?:\\s*(?:${RANGE_SEP})\\s*\\+?[+-]?\\d+(?:\\.\\d+)?)*)` +
    `\\s*(${UNIT_PATTERN})(?![a-zµ])`,
  "gi"
);

const CONDITION_RE = new RegExp(
  `(?:\\bat\\b|@|\\bbei\\b|\\bper\\b|\\bpri\\b)\\s*[+-]?\\d+(?:\\.\\d+)?\\s*(?:°\\s*C|VAC|VDC|kV|mV|V|kA|mA|A|kW|mW|W|kHz|MHz|Hz|%|bar|kg|g)`,
  "gi"
);

export function normalizeForParsing(value: string): string {
  const dashNormalized = value
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u00e2[\u20ac\u0088][\u201c\u201d\u0092\u0093\u0094]/g, "-");
  return dashNormalized
    .replace(/[?\ufffd]\s*C\b/gi, " C")
    .replace(/Â°/g, "°")
    .replace(/℃/g, "°C")
    .replace(/\u00b3/g, "3")
    .replace(/ /g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalUnit(raw: string): UnitInfo | undefined {
  const key = raw.replace(/\s+/g, "").toLowerCase();
  return UNIT_TABLE[key];
}

interface NumericExpr {
  value?: number;
  min?: number;
  max?: number;
  values?: number[];
  shape: "single" | "range" | "alternatives";
}

function parseNumericExpr(raw: string): NumericExpr | undefined {
  const cleaned = raw.trim();
  const hasRangeWord = /(\.{2,3}|…|\bto\b|\bbis\b|\bdo\b|~)/i.test(cleaned);
  // Alternatives: slash-separated and NOT a worded range (e.g. 230/400, 50/60).
  if (cleaned.includes("/") && !hasRangeWord) {
    const values = cleaned
      .split("/")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value));
    if (values.length >= 2) return { values, shape: "alternatives" };
  }
  const range = cleaned.match(
    /^([+-]?\d+(?:\.\d+)?)\s*(?:\.{2,3}|…|\bto\b|\bbis\b|\bdo\b|~|-)\s*\+?([+-]?\d+(?:\.\d+)?)$/i
  );
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return { min: Math.min(a, b), max: Math.max(a, b), shape: "range" };
    }
  }
  const single = cleaned.match(/[+-]?\d+(?:\.\d+)?/);
  if (single) {
    const value = Number(single[0]);
    if (Number.isFinite(value)) return { value, shape: "single" };
  }
  return undefined;
}

function detectCurrentType(window: string, unitInfo: UnitInfo): "AC" | "DC" | "AC/DC" | undefined {
  if (/\bAC\s*\/\s*DC\b|\bAC-DC\b|\bACDC\b/i.test(window)) return "AC/DC";
  const hasAc = /\bAC\b/i.test(window) || unitInfo.currentType === "AC";
  const hasDc = /\bDC\b/i.test(window) || unitInfo.currentType === "DC";
  if (hasAc && hasDc) return "AC/DC";
  if (hasAc) return "AC";
  if (hasDc) return "DC";
  return undefined;
}

function detectTolerance(window: string): QuantityTolerance | undefined {
  const percent = window.match(/(?:±|\+\/-|\+-)\s*(\d+(?:\.\d+)?)\s*%/);
  if (percent) return { type: "percent", value: Number(percent[1]) };
  const absolute = window.match(/(?:±|\+\/-|\+-)\s*(\d+(?:\.\d+)?)/);
  if (absolute) return { type: "absolute", value: Number(absolute[1]) };
  return undefined;
}

function qualifierFromToken(token: string | undefined): "min" | "max" | undefined {
  if (!token) return undefined;
  const normalized = token.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^(≤|<=|<|max\.?|maximum|up to)$/.test(normalized)) return "max";
  if (/^(≥|>=|>|min\.?|minimum)$/.test(normalized)) return "min";
  return undefined;
}

function stripConditions(text: string): { cleaned: string; conditions: string[] } {
  const conditions: string[] = [];
  const cleaned = text.replace(CONDITION_RE, (match) => {
    conditions.push(match.trim());
    return " ";
  });
  return { cleaned: cleaned.replace(/\s+/g, " ").trim(), conditions };
}

/**
 * Parse every physical quantity in a phrase. Conditions ("at 40 °C") are detached
 * so they are never mistaken for a standalone reading.
 */
export function parseQuantities(text: string, options: ParseQuantitiesOptions = {}): ParsedQuantity[] {
  if (!text) return [];
  const normalized = normalizeForParsing(text);
  const { cleaned, conditions } = stripConditions(normalized);
  const condition = conditions.length ? conditions.join("; ") : undefined;

  const quantities: ParsedQuantity[] = [];
  for (const match of cleaned.matchAll(QUANTITY_RE)) {
    const [, qualToken, numRaw, unitRaw] = match;
    const unitInfo = canonicalUnit(unitRaw);
    if (!unitInfo) continue;
    const numeric = parseNumericExpr(numRaw);
    if (!numeric) continue;

    const matchEnd = (match.index ?? 0) + match[0].length;
    const window = cleaned.slice(matchEnd, matchEnd + 14);
    const tolerance = detectTolerance(window);
    const tokenQualifier = qualifierFromToken(qualToken);

    let qualifier: QuantityQualifier;
    if (numeric.shape === "alternatives") qualifier = "alternatives";
    else if (numeric.shape === "range") qualifier = "range";
    else if (tokenQualifier) qualifier = tokenQualifier;
    else if (tolerance) qualifier = "nominal";
    else qualifier = "point";

    const quantity: ParsedQuantity = {
      kind: unitInfo.kind,
      unit: unitInfo.unit,
      qualifier,
      raw: match[0].trim()
    };
    if (numeric.shape === "alternatives") {
      quantity.values = numeric.values;
    } else if (numeric.shape === "range") {
      quantity.min = numeric.min;
      quantity.max = numeric.max;
    } else if (qualifier === "max") {
      quantity.value = numeric.value;
      quantity.max = numeric.value;
    } else if (qualifier === "min") {
      quantity.value = numeric.value;
      quantity.min = numeric.value;
    } else {
      quantity.value = numeric.value;
    }

    if (tolerance) quantity.tolerance = tolerance;
    if (unitInfo.kind === "voltage" || unitInfo.kind === "current") {
      const currentType = detectCurrentType(window, unitInfo);
      if (currentType) quantity.currentType = currentType;
    }
    if (condition) quantity.condition = condition;
    quantities.push(quantity);
  }

  return options.kind ? quantities.filter((quantity) => quantity.kind === options.kind) : quantities;
}

const STORAGE_RE = /\b(storage|lager|transport)\b/i;
const OPERATING_RE = /\b(operating|operational|ambient|working|surrounding|service|umgebung|betrieb)\b/i;
const TEMP_KEYWORD_RE = /\b(temp|temperature|temperatur|operating|operational|ambient|working|surrounding|service|storage|lager|transport|umgebung|betrieb)\b/i;
const DERATING_KINDS: QuantityKind[] = ["voltage", "current", "power", "frequency"];

function bareNumericRange(text: string): { min: number; max: number } | undefined {
  const asciiMatch = text.match(
    /([+-]?\d+(?:\.\d+)?)\s*(?:\u00b0?\s*C)?\s*(?:\.{2,3}|\u2026|\bto\b|\bbis\b|\bdo\b|~|-)\s*\+?([+-]?\d+(?:\.\d+)?)\s*(?:\u00b0?\s*C)?/i
  );
  if (asciiMatch) {
    const a = Number(asciiMatch[1]);
    const b = Number(asciiMatch[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const match = text.match(
    /([+-]?\d+(?:\.\d+)?)\s*(?:°\s*C)?\s*(?:\.{2,3}|…|\bto\b|\bbis\b|\bdo\b|~|-)\s*\+?([+-]?\d+(?:\.\d+)?)\s*(?:°\s*C)?/i
  );
  if (!match) return undefined;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/**
 * Understand an operating/ambient temperature range, ignoring conditions
 * ("70 A at 40 °C") and current/power de-rating temperatures, preferring
 * operating/ambient over storage. Returns {} when only de-rating temps exist.
 */
export function parseTemperatureRange(text: string): { min?: number; max?: number } {
  if (!text) return {};
  const normalized = normalizeForParsing(text);
  const { cleaned } = stripConditions(normalized);
  // Split on ; newline, and a comma that begins a new labelled clause (", storage ...") — but
  // NOT a comma inside a value ("-40, +85"), so a real range is never torn apart.
  const clauses = cleaned
    .split(/[;\n]+|,(?=\s*[A-Za-zÄÖÜäöüß])/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const candidates = clauses.length ? clauses : [cleaned];

  // Never report a storage/transport range as the operating temperature: storage-only clauses
  // are excluded from both lists, so a string that has only storage temps returns {}.
  const operating = candidates.filter((clause) => OPERATING_RE.test(clause) && !STORAGE_RE.test(clause));
  const nonStorage = candidates.filter((clause) => !STORAGE_RE.test(clause));
  const ordered = uniqueStrings([...operating, ...nonStorage]);

  for (const clause of ordered) {
    const hasTempKeyword = TEMP_KEYWORD_RE.test(clause);
    const hasDeratingContext = parseQuantities(clause).some((quantity) => DERATING_KINDS.includes(quantity.kind));
    // A bare °C reading next to a current/power value with no temperature label is
    // a de-rating condition, not an operating temperature — never read it as one.
    const trustTemps = hasTempKeyword || !hasDeratingContext;

    const temps = parseQuantities(clause, { kind: "temperature" });
    const range = temps.find((temp) => temp.min !== undefined && temp.max !== undefined);
    if (range && trustTemps) return { min: range.min, max: range.max };

    const values = temps
      .flatMap((temp) => temp.values ?? (temp.value !== undefined ? [temp.value] : []))
      .filter((value) => Number.isFinite(value));
    if (values.length >= 2 && trustTemps) return { min: Math.min(...values), max: Math.max(...values) };

    // Temperature labelled but no explicit °C unit ("Temperature range -40 do 70").
    if (hasTempKeyword && !hasDeratingContext) {
      const bare = bareNumericRange(clause);
      if (bare) return bare;
    }
  }
  return {};
}

export function quantityMax(quantity: ParsedQuantity): number | undefined {
  if (quantity.max !== undefined) return quantity.max;
  if (quantity.values?.length) return Math.max(...quantity.values);
  return quantity.value;
}

export function quantityMin(quantity: ParsedQuantity): number | undefined {
  if (quantity.min !== undefined) return quantity.min;
  if (quantity.values?.length) return Math.min(...quantity.values);
  return quantity.value;
}

/**
 * Sanity bounds (workstream B-6). Deliberately GENEROUS — they only reject values
 * that are physically impossible for industrial products, so a garbage parse never
 * reaches the PDT (second pillar of "never hallucinate"), without dropping real
 * extremes (1000 V, 6300 A busbars, MV gear). Bounds are in the value's stated unit.
 */
export const SANITY_BOUNDS: Partial<Record<QuantityKind, { min: number; max: number }>> = {
  temperature: { min: -120, max: 400 },
  voltage: { min: 0, max: 2_000_000 },
  current: { min: 0, max: 500_000 },
  power: { min: 0, max: 100_000_000 },
  mass: { min: 0, max: 200_000 },
  frequency: { min: 0, max: 5_000_000 },
  pressure: { min: 0, max: 5_000_000 },
  flowRate: { min: 0, max: 10_000_000 },
  apparentPower: { min: 0, max: 100_000_000 },
  reactivePower: { min: 0, max: 100_000_000 },
  charge: { min: 0, max: 1_000_000 },
  energy: { min: 0, max: 1_000_000_000 },
  area: { min: 0, max: 1_000_000 }
};

function quantityNumbers(quantity: ParsedQuantity): number[] {
  return [quantity.value, quantity.min, quantity.max, ...(quantity.values ?? [])].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );
}

export function isQuantityPlausible(quantity: ParsedQuantity): boolean {
  const bounds = SANITY_BOUNDS[quantity.kind];
  if (!bounds) return true;
  const numbers = quantityNumbers(quantity);
  if (!numbers.length) return true;
  return numbers.every((value) => value >= bounds.min && value <= bounds.max);
}

export function isPlausibleTemperatureCelsius(value: number): boolean {
  const bounds = SANITY_BOUNDS.temperature;
  return !bounds || (value >= bounds.min && value <= bounds.max);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
