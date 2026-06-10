import type { ManufacturerId } from "../../shared/types.js";

export type ElectricalAliasManufacturerId = "abb" | "schneider" | "siemens" | "eaton" | "rockwell";

export interface TechnicalAttributeAlias {
  manufacturerId: ElectricalAliasManufacturerId;
  manufacturerName: string;
  canonicalKey: string;
  originalName: string;
  evidenceUrl: string;
  evidenceLabel: string;
  note?: string;
}

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

export const TECHNICAL_ATTRIBUTE_ALIASES: TechnicalAttributeAlias[] = [
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

export function listTechnicalAttributeAliases(manufacturerId?: ManufacturerId): TechnicalAttributeAlias[] {
  if (!manufacturerId) return [...TECHNICAL_ATTRIBUTE_ALIASES];
  const normalized = manufacturerId.toLowerCase();
  return TECHNICAL_ATTRIBUTE_ALIASES.filter((alias) => alias.manufacturerId === normalized);
}

export function findTechnicalAttributeAlias(manufacturerId: ManufacturerId, originalName: string): TechnicalAttributeAlias | undefined {
  const normalizedManufacturer = manufacturerId.toLowerCase();
  const normalizedName = normalizeAliasName(originalName);
  return TECHNICAL_ATTRIBUTE_ALIASES.find(
    (alias) => alias.manufacturerId === normalizedManufacturer && normalizeAliasName(alias.originalName) === normalizedName
  );
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
  return { manufacturerId, manufacturerName, canonicalKey, originalName, evidenceUrl, evidenceLabel, note };
}

function normalizeAliasName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
