import type { ManufacturerId } from "../../shared/types.js";

export type ElectricalAliasManufacturerId = "abb" | "schneider" | "siemens" | "eaton" | "rockwell";
export type TechnicalAliasManufacturerId = ElectricalAliasManufacturerId | "global";
export type TechnicalAttributeAliasScope = "global" | "manufacturer";
export type TechnicalAttributeAliasMatchType =
  | "manufacturer_alias"
  | "global_alias"
  | "fuzzy_manufacturer_alias"
  | "fuzzy_global_alias"
  | "fuzzy_cross_manufacturer_alias";

export interface TechnicalAttributeAlias {
  scope: TechnicalAttributeAliasScope;
  manufacturerId: TechnicalAliasManufacturerId;
  manufacturerName: string;
  canonicalKey: string;
  originalName: string;
  evidenceUrl: string;
  evidenceLabel: string;
  note?: string;
}

export interface TechnicalAttributeAliasMatch {
  alias: TechnicalAttributeAlias;
  matchType: TechnicalAttributeAliasMatchType;
  score: number;
}

interface AliasMatchOptions {
  includeFuzzy?: boolean;
  includeCrossManufacturer?: boolean;
}

const GLOBAL_ALIAS_EVIDENCE = "docs/technical-attribute-normalization.md";
const ABB_EMPOWER =
  "https://empower.abb.com/ecatalog/ec/EN_NA/p/1SAZ721201R1025/pdf";
const ABB_S800HV =
  "https://search.abb.com/library/Download.aspx?Action=Launch&DocumentID=2CCC457096D0201&DocumentPartId=&LanguageCode=en";
const SCHNEIDER_GV7 =
  "https://www.se.com/us/en/product/GV7RS25/tesys-gv7-manual-starter-and-protector-thermal-magnetic-circuit-protector-rocker-lever-3-p-ac3-15-25-a-high-interrupt/";
const EATON_095132 = "https://www.eaton.com/us/en-us/skuPage.095132.html";
const EATON_140062 = "https://www.eaton.com/gb/en-gb/skuPage.140062.html";
const EATON_172852 = "https://www.eaton.com/us/en-us/skuPage.172852.html";
const SIEMENS_3VM =
  "https://mall.industry.siemens.com/goos/catalog/Pages/mmpdata.ashx?MLFB1=3VM1463-4EE32-0AA0&lang=en";
const SIEMENS_3WA =
  "https://mall.industry.siemens.com/goos/catalog/Pages/mmpdata.ashx?MLFB1=3WA1112-3AE02-0AA0-Z+D85+T40&lang=en";
const ROCKWELL_SCCR =
  "https://literature.rockwellautomation.com/idc/groups/literature/documents/at/sccr-at002_-en-p.pdf";
const ROCKWELL_1494 =
  "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/1494-td002_-en-p.pdf";
const ROCKWELL_1492 =
  "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/1492-td013_-en-p.pdf";

export const GLOBAL_TECHNICAL_ATTRIBUTE_ALIASES: TechnicalAttributeAlias[] = [
  globalAlias("ratedVoltage", "Rated voltage"),
  globalAlias("ratedVoltage", "Rated operational voltage"),
  globalAlias("ratedVoltage", "Operating voltage"),
  globalAlias("ratedVoltage", "Operational voltage"),
  globalAlias("ratedVoltage", "Nominal voltage"),
  globalAlias("ratedVoltage", "Supply voltage"),
  globalAlias("ratedVoltage", "Voltage rating max"),
  globalAlias("ratedVoltage", "Voltage rating - max"),
  globalAlias("ratedVoltage", "Maximum operating voltage"),
  globalAlias("ratedVoltage", "Nennspannung"),
  globalAlias("ratedVoltage", "Bemessungsspannung"),
  globalAlias("ratedVoltage", "Ue"),
  globalAlias("ratedVoltage", "Us"),
  globalAlias("ratedVoltage", "Ub"),
  globalAlias("ratedVoltage", "Un"),

  globalAlias("ratedCurrent", "Rated current"),
  globalAlias("ratedCurrent", "Rated operational current"),
  globalAlias("ratedCurrent", "Operational current"),
  globalAlias("ratedCurrent", "Continuous current"),
  globalAlias("ratedCurrent", "Continuous operating current"),
  globalAlias("ratedCurrent", "Nominal current"),
  globalAlias("ratedCurrent", "Thermal current"),
  globalAlias("ratedCurrent", "Conventional free air thermal current"),
  globalAlias("ratedCurrent", "Amperage rating"),
  globalAlias("ratedCurrent", "Current rating"),
  globalAlias("ratedCurrent", "Nennstrom"),
  globalAlias("ratedCurrent", "Bemessungsbetriebsstrom"),
  globalAlias("ratedCurrent", "Ie"),
  globalAlias("ratedCurrent", "Ith"),
  globalAlias("ratedCurrent", "Iu"),

  globalAlias("breakingCapacity", "Breaking capacity"),
  globalAlias("breakingCapacity", "Short-circuit breaking capacity"),
  globalAlias("breakingCapacity", "Short circuit current rating"),
  globalAlias("breakingCapacity", "Short-circuit current rating"),
  globalAlias("breakingCapacity", "Interrupt rating"),
  globalAlias("breakingCapacity", "Interrupting rating"),
  globalAlias("breakingCapacity", "SCCR"),
  globalAlias("breakingCapacity", "Icu"),
  globalAlias("breakingCapacity", "Ics"),
  globalAlias("breakingCapacity", "Icw"),
  globalAlias("breakingCapacity", "AIC"),

  globalAlias("powerLoss", "Power loss"),
  globalAlias("powerLoss", "Power losses"),
  globalAlias("powerLoss", "Power dissipation"),
  globalAlias("powerLoss", "Dissipation power"),
  globalAlias("powerLoss", "Dissipated power"),
  globalAlias("powerLoss", "Thermal dissipation"),
  globalAlias("powerLoss", "Heat dissipation"),
  globalAlias("powerLoss", "Static heat dissipation"),
  globalAlias("powerLoss", "Static heat dissipation non current dependent Pvs"),
  globalAlias("powerLoss", "Watt loss"),
  globalAlias("powerLoss", "Verlustleistung"),
  globalAlias("powerLoss", "Pv"),
  globalAlias("powerLoss", "Pvs"),
  globalAlias("powerLoss", "Pls"),
  globalAlias("powerLoss", "Ple"),

  globalAlias("insulationVoltage", "Rated insulation voltage"),
  globalAlias("impulseVoltage", "Rated impulse withstand voltage"),
  globalAlias("poles", "Number of poles"),
  globalAlias("poles", "Poles"),
  globalAlias("protection", "Degree of protection"),
  globalAlias("protection", "IP rating"),
  globalAlias("protection", "NEMA rating"),
  globalAlias("mountingType", "Mounting type"),
  globalAlias("mountingType", "Mounting method"),
  globalAlias("mountingType", "Mounting support"),
  globalAlias("mountingType", "Mounting on standard rails"),
  globalAlias("operatingTemperature", "Operating temperature"),
  globalAlias("operatingTemperature", "Ambient air temperature for operation"),
  globalAlias("material", "Material"),
  globalAlias("weight", "Weight"),
  globalAlias("weight", "Product net weight")
];

export const MANUFACTURER_TECHNICAL_ATTRIBUTE_ALIASES: TechnicalAttributeAlias[] = [
  alias("abb", "ABB", "ratedVoltage", "Rated Operational Voltage", ABB_EMPOWER, "ABB Empower product data"),
  alias("abb", "ABB", "ratedVoltage", "Maximum Operating Voltage UL/CSA", ABB_EMPOWER, "ABB Empower product data"),
  alias("abb", "ABB", "ratedCurrent", "Conventional Free-air Thermal Current", ABB_EMPOWER, "ABB Empower product data"),
  alias("abb", "ABB", "ratedCurrent", "Rated Operational Current AC-3", ABB_EMPOWER, "ABB Empower product data"),
  alias("abb", "ABB", "breakingCapacity", "Rated Ultimate Short-Circuit Breaking Capacity", ABB_EMPOWER, "ABB Empower product data"),
  alias("abb", "ABB", "breakingCapacity", "Rated Service Short-Circuit Breaking Capacity", ABB_EMPOWER, "ABB Empower product data"),
  alias("abb", "ABB", "powerLoss", "Power Loss at Rated Operating Conditions per Pole", ABB_EMPOWER, "ABB Empower product data"),
  alias("abb", "ABB", "powerLoss", "Power loss Pv", ABB_S800HV, "ABB S800HV technical data"),
  alias("abb", "ABB", "poles", "Number of Protected Poles", ABB_EMPOWER, "ABB Empower product data"),
  alias("abb", "ABB", "insulationVoltage", "Rated Insulation Voltage", ABB_S800HV, "ABB circuit-breaker technical data"),
  alias("abb", "ABB", "impulseVoltage", "Rated Impulse Withstand Voltage", ABB_S800HV, "ABB circuit-breaker technical data"),
  alias("abb", "ABB", "mountingType", "Mounting on standard rails", ABB_EMPOWER, "ABB product data"),
  alias("abb", "ABB", "operatingTemperature", "Ambient Air Temperature Operation", ABB_EMPOWER, "ABB product data"),

  alias("schneider", "Schneider Electric", "ratedVoltage", "[Ue] rated operational voltage", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "ratedVoltage", "[Us] rated supply voltage", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "ratedCurrent", "[Ie] rated operational current", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "ratedCurrent", "[Ith] conventional free air thermal current", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "breakingCapacity", "[Icu] rated ultimate short-circuit breaking capacity", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "breakingCapacity", "[Ics] rated service short-circuit breaking capacity", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "powerLoss", "Power dissipation per pole", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "powerLoss", "Power dissipation in W", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "poles", "Poles description", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "insulationVoltage", "[Ui] rated insulation voltage", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "impulseVoltage", "[Uimp] rated impulse withstand voltage", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "mountingType", "Mounting support", SCHNEIDER_GV7, "Schneider product page"),
  alias("schneider", "Schneider Electric", "operatingTemperature", "Ambient air temperature for operation", SCHNEIDER_GV7, "Schneider product page"),

  alias("siemens", "Siemens", "ratedVoltage", "operating voltage / at AC / at 50/60 Hz / rated value", SIEMENS_3WA, "Siemens SiePortal mmpdata"),
  alias("siemens", "Siemens", "ratedCurrent", "continuous current / rated value", SIEMENS_3WA, "Siemens SiePortal mmpdata"),
  alias("siemens", "Siemens", "ratedCurrent", "operational current / at 40 °C / rated value", SIEMENS_3WA, "Siemens SiePortal mmpdata"),
  alias("siemens", "Siemens", "ratedCurrent", "Bemessungsbetriebsstrom", SIEMENS_3WA, "Siemens support document"),
  alias("siemens", "Siemens", "breakingCapacity", "maximum short-circuit current breaking capacity (Icu)", SIEMENS_3VM, "Siemens SiePortal mmpdata"),
  alias("siemens", "Siemens", "breakingCapacity", "operating short-circuit current breaking capacity (Ics)", SIEMENS_3VM, "Siemens SiePortal mmpdata"),
  alias("siemens", "Siemens", "powerLoss", "power loss [W] / maximum", SIEMENS_3VM, "Siemens SiePortal mmpdata"),
  alias("siemens", "Siemens", "powerLoss", "power loss [W] / for rated value of the current / at AC / in hot operating state / per pole", SIEMENS_3VM, "Siemens SiePortal mmpdata"),
  alias("siemens", "Siemens", "poles", "number of poles", SIEMENS_3VM, "Siemens SiePortal mmpdata"),
  alias("siemens", "Siemens", "insulationVoltage", "insulation voltage / rated value", SIEMENS_3VM, "Siemens SiePortal mmpdata"),
  alias("siemens", "Siemens", "impulseVoltage", "Rated impulse withstand voltage", SIEMENS_3VM, "Siemens technical data"),
  alias("siemens", "Siemens", "protection", "degree of protection", SIEMENS_3VM, "Siemens technical data"),

  alias("eaton", "Eaton", "ratedVoltage", "Voltage rating - max", EATON_140062, "Eaton skuPage"),
  alias("eaton", "Eaton", "ratedVoltage", "Rated operational voltage", EATON_140062, "Eaton skuPage"),
  alias("eaton", "Eaton", "ratedCurrent", "Amperage Rating", EATON_172852, "Eaton skuPage"),
  alias("eaton", "Eaton", "ratedCurrent", "Rated uninterrupted current (Iu)", EATON_172852, "Eaton skuPage"),
  alias("eaton", "Eaton", "breakingCapacity", "Interrupt rating", EATON_172852, "Eaton skuPage"),
  alias("eaton", "Eaton", "breakingCapacity", "Rated short-time withstand current (Icw)", EATON_172852, "Eaton skuPage"),
  alias("eaton", "Eaton", "powerLoss", "Static heat dissipation, non-current-dependent Pvs", EATON_095132, "Eaton skuPage"),
  alias("eaton", "Eaton", "powerLoss", "Power loss", EATON_140062, "Eaton skuPage"),
  alias("eaton", "Eaton", "poles", "Number of poles", EATON_172852, "Eaton skuPage"),
  alias("eaton", "Eaton", "impulseVoltage", "Rated impulse withstand voltage (Uimp)", EATON_172852, "Eaton skuPage"),
  alias("eaton", "Eaton", "mountingType", "Mounting method", EATON_172852, "Eaton skuPage"),
  alias("eaton", "Eaton", "tripCharacteristic", "Trip Type", EATON_172852, "Eaton skuPage"),
  alias("eaton", "Eaton", "frameSize", "Frame size", EATON_172852, "Eaton skuPage"),
  alias("eaton", "Eaton", "protection", "NEMA rating", EATON_172852, "Eaton skuPage"),

  alias("rockwell", "Rockwell Automation", "ratedVoltage", "Rated Operational Voltage", ROCKWELL_1494, "Rockwell technical data"),
  alias("rockwell", "Rockwell Automation", "ratedCurrent", "Continuous Operating Current", ROCKWELL_1494, "Rockwell technical data"),
  alias("rockwell", "Rockwell Automation", "ratedCurrent", "Continuous Current Rating [A]", ROCKWELL_1494, "Rockwell technical data"),
  alias("rockwell", "Rockwell Automation", "breakingCapacity", "SCCR", ROCKWELL_SCCR, "Rockwell SCCR publication"),
  alias("rockwell", "Rockwell Automation", "breakingCapacity", "Short Circuit Current Rating (SCCR)", ROCKWELL_1492, "Rockwell terminal block technical data"),
  alias("rockwell", "Rockwell Automation", "breakingCapacity", "Interrupting Rating", ROCKWELL_SCCR, "Rockwell SCCR publication"),
  alias("rockwell", "Rockwell Automation", "poles", "Number of poles", ROCKWELL_1494, "Rockwell technical data"),
  alias("rockwell", "Rockwell Automation", "protection", "Enclosure Type", ROCKWELL_1494, "Rockwell technical data"),
  alias("rockwell", "Rockwell Automation", "mountingType", "Mounting", ROCKWELL_1494, "Rockwell technical data"),
  alias("rockwell", "Rockwell Automation", "frameSize", "Frame Size", ROCKWELL_1494, "Rockwell technical data"),
  alias("rockwell", "Rockwell Automation", "tripCharacteristic", "Trip Curve", ROCKWELL_1494, "Rockwell technical data"),
  alias("rockwell", "Rockwell Automation", "operatingTemperature", "Temperature, Operating", ROCKWELL_1494, "Rockwell technical data")
];

export const TECHNICAL_ATTRIBUTE_ALIASES: TechnicalAttributeAlias[] = [
  ...GLOBAL_TECHNICAL_ATTRIBUTE_ALIASES,
  ...MANUFACTURER_TECHNICAL_ATTRIBUTE_ALIASES
];

export function listTechnicalAttributeAliases(manufacturerId?: ManufacturerId): TechnicalAttributeAlias[] {
  if (!manufacturerId) return [...TECHNICAL_ATTRIBUTE_ALIASES];
  const normalized = manufacturerId.toLowerCase();
  return TECHNICAL_ATTRIBUTE_ALIASES.filter((alias) => alias.scope === "global" || alias.manufacturerId === normalized);
}

export function findTechnicalAttributeAlias(manufacturerId: ManufacturerId, originalName: string): TechnicalAttributeAlias | undefined {
  return matchTechnicalAttributeAlias(manufacturerId, originalName, { includeFuzzy: false })?.alias;
}

export function matchTechnicalAttributeAlias(
  manufacturerId: ManufacturerId,
  originalName: string,
  options: AliasMatchOptions = {}
): TechnicalAttributeAliasMatch | undefined {
  const normalizedManufacturer = manufacturerId.toLowerCase();
  const normalizedName = normalizeAliasName(originalName);

  const manufacturerExact = MANUFACTURER_TECHNICAL_ATTRIBUTE_ALIASES.find(
    (alias) => alias.manufacturerId === normalizedManufacturer && normalizeAliasName(alias.originalName) === normalizedName
  );
  if (manufacturerExact) return { alias: manufacturerExact, matchType: "manufacturer_alias", score: 1 };

  const globalExact = GLOBAL_TECHNICAL_ATTRIBUTE_ALIASES.find((alias) => normalizeAliasName(alias.originalName) === normalizedName);
  if (globalExact) return { alias: globalExact, matchType: "global_alias", score: 1 };

  if (options.includeFuzzy === false) return undefined;

  const candidatePools: Array<{ aliases: TechnicalAttributeAlias[]; matchType: TechnicalAttributeAliasMatchType; threshold: number }> = [
    {
      aliases: MANUFACTURER_TECHNICAL_ATTRIBUTE_ALIASES.filter((alias) => alias.manufacturerId === normalizedManufacturer),
      matchType: "fuzzy_manufacturer_alias",
      threshold: 0.86
    },
    {
      aliases: GLOBAL_TECHNICAL_ATTRIBUTE_ALIASES,
      matchType: "fuzzy_global_alias",
      threshold: 0.84
    }
  ];

  if (options.includeCrossManufacturer !== false) {
    candidatePools.push({
      aliases: MANUFACTURER_TECHNICAL_ATTRIBUTE_ALIASES.filter((alias) => alias.manufacturerId !== normalizedManufacturer),
      matchType: "fuzzy_cross_manufacturer_alias",
      threshold: 0.92
    });
  }

  let best: TechnicalAttributeAliasMatch | undefined;
  for (const pool of candidatePools) {
    for (const alias of pool.aliases) {
      const score = aliasSimilarity(normalizedName, normalizeAliasName(alias.originalName));
      if (score < pool.threshold) continue;
      if (!isSafeFuzzyAlias(alias, score)) continue;
      if (!best || score > best.score || (score === best.score && matchTypeRank(pool.matchType) < matchTypeRank(best.matchType))) {
        best = { alias, matchType: pool.matchType, score: Number(score.toFixed(3)) };
      }
    }
  }
  return best;
}

function alias(
  manufacturerId: ElectricalAliasManufacturerId,
  manufacturerName: string,
  canonicalKey: string,
  originalName: string,
  evidenceUrl: string,
  evidenceLabel: string,
  note?: string
): TechnicalAttributeAlias {
  return { scope: "manufacturer", manufacturerId, manufacturerName, canonicalKey, originalName, evidenceUrl, evidenceLabel, note };
}

function globalAlias(canonicalKey: string, originalName: string): TechnicalAttributeAlias {
  return {
    scope: "global",
    manufacturerId: "global",
    manufacturerName: "Global",
    canonicalKey,
    originalName,
    evidenceUrl: GLOBAL_ALIAS_EVIDENCE,
    evidenceLabel: "Global technical attribute alias"
  };
}

function normalizeAliasName(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function aliasSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftCompact = compactAliasName(left);
  const rightCompact = compactAliasName(right);
  if (leftCompact === rightCompact) return 1;

  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  const tokenScore = tokenSetSimilarity(leftTokens, rightTokens);
  const diceScore = bigramDice(leftCompact, rightCompact);
  let score = Math.max((tokenScore * 0.62) + (diceScore * 0.38), diceScore);

  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  if (shorter.length >= 8 && longer.includes(shorter)) {
    const lengthPenalty = Math.min(0.12, (longer.length - shorter.length) / 160);
    score = Math.max(score, 0.92 - lengthPenalty);
  }

  if (tokenScore === 1 && leftTokens.length >= 2 && rightTokens.length >= 2) {
    score = Math.max(score, 0.95);
  }

  return Math.max(0, Math.min(1, score));
}

function isSafeFuzzyAlias(alias: TechnicalAttributeAlias, score: number): boolean {
  const tokens = significantTokens(alias.originalName);
  const compact = compactAliasName(alias.originalName);
  if (tokens.length >= 2) return true;
  if (/^[a-z]{1,4}\d*$/i.test(alias.originalName.trim())) return false;
  return compact.length >= 6 && score >= 0.96;
}

function matchTypeRank(matchType: TechnicalAttributeAliasMatchType): number {
  if (matchType === "fuzzy_manufacturer_alias") return 1;
  if (matchType === "fuzzy_global_alias") return 2;
  return 3;
}

function compactAliasName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "");
}

function significantTokens(value: string): string[] {
  const stopwords = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "per", "the", "to", "with"]);
  return value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !stopwords.has(token));
}

function tokenSetSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  return (2 * intersection) / (leftSet.size + rightSet.size);
}

function bigramDice(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const leftBigrams = bigramCounts(left);
  const rightBigrams = bigramCounts(right);
  let overlap = 0;
  for (const [bigram, count] of leftBigrams) {
    overlap += Math.min(count, rightBigrams.get(bigram) ?? 0);
  }
  return (2 * overlap) / (Math.max(0, left.length - 1) + Math.max(0, right.length - 1));
}

function bigramCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < value.length - 1; index += 1) {
    const bigram = value.slice(index, index + 2);
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  return counts;
}
