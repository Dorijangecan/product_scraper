export interface DeviceTypeEclassDefault {
  code: string;
  system: string;
}

export interface DeviceTypePdtProfile {
  sheets: string[];
  eclassBySheet?: Record<string, DeviceTypeEclassDefault>;
  criticalFactsBySheet?: Record<string, string[]>;
  finalCompletenessFields?: DeviceTypeFinalCompletenessField[];
  electricalFields?: DeviceTypeElectricalField[];
  semanticFacts?: {
    signalDevice?: boolean;
  };
}

export type DeviceTypeFinalCompletenessField = "color" | "operatingTemperature" | "protection" | "typeCode";
export type DeviceTypeElectricalField = "voltage" | "current";

const SIGNAL_ECLASS = { code: "27143221", system: "13" };
const ENCLOSURE_ECLASS = { code: "27180101", system: "13" };
const MATERIAL_PHYSICAL_FACTS = ["weight", "material"];
const ELECTRICAL_RATING_FACTS = ["ratedVoltage", "ratedCurrent"];
const VOLTAGE_RATING_FACTS = ["ratedVoltage"];
const SIGNAL_FACTS = ["pdtRatedVoltage", "pdtVoltageTypeText", "pdtLampColor", "pdtSignalDiameter"];
const ENCLOSURE_FINAL_FIELDS: DeviceTypeFinalCompletenessField[] = ["color", "protection", "typeCode"];
const ACTIVE_FINAL_FIELDS: DeviceTypeFinalCompletenessField[] = ["operatingTemperature", "typeCode"];
const SIGNAL_FINAL_FIELDS: DeviceTypeFinalCompletenessField[] = ["color", ...ACTIVE_FINAL_FIELDS];
const VOLTAGE_AND_CURRENT: DeviceTypeElectricalField[] = ["voltage", "current"];
const VOLTAGE_ONLY: DeviceTypeElectricalField[] = ["voltage"];
const CURRENT_ONLY: DeviceTypeElectricalField[] = ["current"];
const NO_ELECTRICAL_FIELDS: DeviceTypeElectricalField[] = [];

export const DEVICE_TYPE_PROFILES: Record<string, DeviceTypePdtProfile> = {
  Enclosure: {
    sheets: ["cabinet", "cabinet.mechanical"],
    eclassBySheet: { "material master data": ENCLOSURE_ECLASS, cabinet: ENCLOSURE_ECLASS, "cabinet.mechanical": ENCLOSURE_ECLASS },
    criticalFactsBySheet: { "Material Master Data": ["weight", "material", "protection"], cabinet: ["protection"] },
    finalCompletenessFields: ENCLOSURE_FINAL_FIELDS,
    electricalFields: NO_ELECTRICAL_FIELDS
  },
  Subpanel: { sheets: ["cabinet.mechanical"], finalCompletenessFields: ENCLOSURE_FINAL_FIELDS, electricalFields: NO_ELECTRICAL_FIELDS },
  "Rack Cabinet": { sheets: ["cabinet.rack"], eclassBySheet: { "material master data": ENCLOSURE_ECLASS, "cabinet.rack": ENCLOSURE_ECLASS }, finalCompletenessFields: ENCLOSURE_FINAL_FIELDS, electricalFields: NO_ELECTRICAL_FIELDS },
  "Module Carrier": { sheets: ["module carrier frame"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: NO_ELECTRICAL_FIELDS },
  Loadcenter: { sheets: ["energy distribution system"], electricalFields: NO_ELECTRICAL_FIELDS },
  Wireway: { sheets: ["cable ducts mounting rails"], finalCompletenessFields: ENCLOSURE_FINAL_FIELDS, electricalFields: NO_ELECTRICAL_FIELDS },
  "Mounting Accessory": { sheets: ["cable ducts mounting rails"], electricalFields: NO_ELECTRICAL_FIELDS },
  "Cover / Door Accessory": { sheets: ["cabinet.mechanical"], finalCompletenessFields: ENCLOSURE_FINAL_FIELDS, electricalFields: NO_ELECTRICAL_FIELDS },
  "Lock / Interlock": { sheets: ["Switch"], electricalFields: NO_ELECTRICAL_FIELDS },
  Accessory: { sheets: ["cabinet.mechanical"], electricalFields: NO_ELECTRICAL_FIELDS },

  Contactor: { sheets: ["contactor a. fuses"], criticalFactsBySheet: { "contactor a. fuses": [...ELECTRICAL_RATING_FACTS, "voltageType"] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  Fuse: { sheets: ["contactor a. fuses"], criticalFactsBySheet: { "contactor a. fuses": [...ELECTRICAL_RATING_FACTS] }, electricalFields: VOLTAGE_AND_CURRENT },
  Relay: { sheets: ["contactor a. fuses"], criticalFactsBySheet: { "contactor a. fuses": [...ELECTRICAL_RATING_FACTS, "voltageType"] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  "Safety Relay": { sheets: ["safety sensor"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  "Circuit Breaker": { sheets: ["contactor a. fuses"], criticalFactsBySheet: { "contactor a. fuses": [...ELECTRICAL_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  "Molded Case Circuit Breaker": { sheets: ["contactor a. fuses"], criticalFactsBySheet: { "contactor a. fuses": [...ELECTRICAL_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  "Miniature Circuit Breaker": { sheets: ["contactor a. fuses"], criticalFactsBySheet: { "contactor a. fuses": [...ELECTRICAL_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  "Residual Current Device": { sheets: ["contactor a. fuses"], criticalFactsBySheet: { "contactor a. fuses": [...ELECTRICAL_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  "Motor Circuit Breaker": { sheets: ["motor protection"], criticalFactsBySheet: { "motor protection": [...ELECTRICAL_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  "Motor Starter": { sheets: ["motor protection"], criticalFactsBySheet: { "motor protection": [...ELECTRICAL_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  "Disconnect Switch": { sheets: ["contactor a. fuses"], criticalFactsBySheet: { "contactor a. fuses": [...ELECTRICAL_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  Switch: { sheets: ["Switch"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: NO_ELECTRICAL_FIELDS },
  "Surge Protective Device": { sheets: ["int. ext. lightning protection"], electricalFields: VOLTAGE_AND_CURRENT },

  "Power Supply": { sheets: ["power supply devices"], criticalFactsBySheet: { "power supply devices": [...ELECTRICAL_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  UPS: { sheets: ["power supply devices"], criticalFactsBySheet: { "power supply devices": [...ELECTRICAL_RATING_FACTS] }, electricalFields: VOLTAGE_AND_CURRENT },
  Transformer: { sheets: ["power supply devices"], criticalFactsBySheet: { "power supply devices": [...ELECTRICAL_RATING_FACTS] }, electricalFields: VOLTAGE_AND_CURRENT },
  Battery: { sheets: ["power supply devices"], electricalFields: NO_ELECTRICAL_FIELDS },
  Generator: { sheets: ["generator"], electricalFields: NO_ELECTRICAL_FIELDS },
  Motor: { sheets: ["motors"], criticalFactsBySheet: { "Material Master Data": ["weight"], motors: [...ELECTRICAL_RATING_FACTS, "weight"] }, electricalFields: VOLTAGE_AND_CURRENT },
  "Variable Speed Drive": {
    sheets: ["servo controller", "motors"],
    eclassBySheet: { motors: { code: "27023101", system: "14" } },
    criticalFactsBySheet: { "Material Master Data": ["weight"], motors: [...ELECTRICAL_RATING_FACTS, "weight"], "servo controller": [...ELECTRICAL_RATING_FACTS] },
    finalCompletenessFields: ACTIVE_FINAL_FIELDS,
    electricalFields: VOLTAGE_AND_CURRENT
  },
  "Soft Starter": { sheets: ["servo controller"], criticalFactsBySheet: { "servo controller": [...ELECTRICAL_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_AND_CURRENT },
  "Motion Controller": { sheets: ["Motion Controller"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: NO_ELECTRICAL_FIELDS },
  "Current Sensor": { sheets: ["el. mesurement devices"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: CURRENT_ONLY },
  Filter: { sheets: ["filters"], electricalFields: NO_ELECTRICAL_FIELDS },

  Cable: { sheets: ["cable"], criticalFactsBySheet: { cable: ["ratedVoltage", "ratedCurrent", "material"] }, electricalFields: VOLTAGE_AND_CURRENT },
  "Cable Gland": { sheets: ["cable gland"], electricalFields: NO_ELECTRICAL_FIELDS },
  Connector: { sheets: ["connector"], electricalFields: NO_ELECTRICAL_FIELDS },
  "Optical Connector": { sheets: ["connector"], electricalFields: NO_ELECTRICAL_FIELDS },
  "PCB Connector": { sheets: ["PCB connection system"], electricalFields: NO_ELECTRICAL_FIELDS },
  "PCB Terminal Block": { sheets: ["PCB connection technology"], electricalFields: NO_ELECTRICAL_FIELDS },
  Busbar: { sheets: ["Busbar"], electricalFields: NO_ELECTRICAL_FIELDS },
  "Terminal Block": { sheets: ["terminal"], eclassBySheet: { terminal: { code: "27250101", system: "14" } }, criticalFactsBySheet: { terminal: [...ELECTRICAL_RATING_FACTS, "material", "color"] }, finalCompletenessFields: ["color"], electricalFields: VOLTAGE_AND_CURRENT },
  "Terminal Accessory": { sheets: ["terminal endbracket"], electricalFields: NO_ELECTRICAL_FIELDS },
  "Wire Marker": { sheets: ["Wire ID Information"], electricalFields: NO_ELECTRICAL_FIELDS },

  "Photoelectric Sensor": { sheets: ["optical sensor"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "Vision Sensor": { sheets: ["optical sensor"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "Inductive Proximity Sensor": { sheets: ["electronic sensor"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "Capacitive Sensor": { sheets: ["electronic sensor"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "Ultrasonic Sensor": { sheets: ["electronic sensor"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "Magnetic Field Sensor": { sheets: ["electronic sensor"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "RFID Device": { sheets: ["electronic sensor"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  Encoder: { sheets: ["electronic sensor"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "Safety Sensor": { sheets: ["safety sensor"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  Sensor: { sheets: ["electronic sensor"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "Pressure Sensor": { sheets: ["sensor - fluid"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "Temperature Sensor": { sheets: ["sensor - fluid"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "Flow Sensor": { sheets: ["sensor - fluid"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "Level Sensor": { sheets: ["sensor - fluid"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },

  "Programmable Logic Controller": { sheets: ["PLC"], eclassBySheet: { plc: { code: "27242202", system: "14" } }, criticalFactsBySheet: { PLC: [...VOLTAGE_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "I/O Module": { sheets: ["PLC"], eclassBySheet: { plc: { code: "27242604", system: "14" } }, criticalFactsBySheet: { PLC: [...VOLTAGE_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  HMI: { sheets: ["PLC", "panel (HMI)"], criticalFactsBySheet: { PLC: [...VOLTAGE_RATING_FACTS], "panel (HMI)": [...VOLTAGE_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },
  "Communication Gateway": { sheets: ["PLC", "RS232 interfaces"], eclassBySheet: { plc: { code: "27242201", system: "13" } }, criticalFactsBySheet: { PLC: [...VOLTAGE_RATING_FACTS] }, finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },

  "Pushbutton / Operator": {
    sheets: ["command and alarm device"],
    eclassBySheet: { "command and alarm device": SIGNAL_ECLASS },
    criticalFactsBySheet: { "Material Master Data": MATERIAL_PHYSICAL_FACTS, "command and alarm device": SIGNAL_FACTS },
    finalCompletenessFields: SIGNAL_FINAL_FIELDS,
    electricalFields: VOLTAGE_ONLY,
    semanticFacts: { signalDevice: true }
  },
  "Pilot Light": {
    sheets: ["command and alarm device"],
    eclassBySheet: { "command and alarm device": SIGNAL_ECLASS },
    criticalFactsBySheet: { "Material Master Data": MATERIAL_PHYSICAL_FACTS, "command and alarm device": SIGNAL_FACTS },
    finalCompletenessFields: SIGNAL_FINAL_FIELDS,
    electricalFields: VOLTAGE_ONLY,
    semanticFacts: { signalDevice: true }
  },
  "Stack Light / Beacon": {
    sheets: ["command and alarm device"],
    eclassBySheet: { "command and alarm device": SIGNAL_ECLASS },
    criticalFactsBySheet: { "Material Master Data": MATERIAL_PHYSICAL_FACTS, "command and alarm device": SIGNAL_FACTS },
    finalCompletenessFields: SIGNAL_FINAL_FIELDS,
    electricalFields: VOLTAGE_ONLY,
    semanticFacts: { signalDevice: true }
  },
  Luminaire: { sheets: ["Luminaire"], electricalFields: VOLTAGE_ONLY },

  "Thermal Management": { sheets: ["cabinet.airconditioning"], finalCompletenessFields: ACTIVE_FINAL_FIELDS, electricalFields: VOLTAGE_ONLY },

  Pump: { sheets: ["pump"], electricalFields: NO_ELECTRICAL_FIELDS },
  "Directional Control Valve": { sheets: ["directional control valve"], electricalFields: VOLTAGE_ONLY },
  Valve: { sheets: ["ventil"], electricalFields: NO_ELECTRICAL_FIELDS },
  "Hydraulic Actuator": { sheets: ["fluid power"], electricalFields: NO_ELECTRICAL_FIELDS },
  "Pneumatic Device": { sheets: ["pneumatic handling"], electricalFields: NO_ELECTRICAL_FIELDS }
};

export function deviceTypeProfile(deviceType: string | undefined): DeviceTypePdtProfile | undefined {
  return deviceType ? DEVICE_TYPE_PROFILES[deviceType] : undefined;
}

export function deviceSheetsFromProfile(deviceType: string | undefined): string[] {
  return deviceTypeProfile(deviceType)?.sheets ?? [];
}

export function eclassDefaultForDeviceType(deviceType: string | undefined, sheetName: string | undefined): DeviceTypeEclassDefault | undefined {
  const sheetKey = sheetName?.trim().toLowerCase();
  if (!sheetKey) return undefined;
  return deviceTypeProfile(deviceType)?.eclassBySheet?.[sheetKey];
}

export function soleEclassDefaultForDeviceType(deviceType: string | undefined): DeviceTypeEclassDefault | undefined {
  const defaults = Object.values(deviceTypeProfile(deviceType)?.eclassBySheet ?? {});
  if (defaults.length === 0) return undefined;
  const first = defaults[0];
  return defaults.every((candidate) => candidate.code === first.code && candidate.system === first.system) ? first : undefined;
}

export function criticalFactsForDeviceType(deviceType: string | undefined, sheetName: string | undefined): string[] {
  const sheetKey = sheetName?.trim().toLowerCase();
  if (!sheetKey) return [];
  const profile = deviceTypeProfile(deviceType);
  if (!profile) return [];
  const facts = new Set<string>();
  for (const fact of criticalFactsFromElectricalFields(profile.electricalFields)) facts.add(fact);
  const critical = profile.criticalFactsBySheet;
  if (critical) {
    for (const fact of critical["*"] ?? []) facts.add(fact);
    for (const [sheet, sheetFacts] of Object.entries(critical)) {
      if (sheet.trim().toLowerCase() === sheetKey) for (const fact of sheetFacts) facts.add(fact);
    }
  }
  return [...facts];
}

function criticalFactsFromElectricalFields(fields: DeviceTypeElectricalField[] | undefined): string[] {
  if (!fields) return [];
  const facts: string[] = [];
  if (fields.includes("voltage")) facts.push("ratedVoltage");
  if (fields.includes("current")) facts.push("ratedCurrent");
  return facts;
}

export function finalCompletenessFieldsForDeviceType(deviceType: string | undefined): DeviceTypeFinalCompletenessField[] {
  return [...new Set(deviceTypeProfile(deviceType)?.finalCompletenessFields ?? [])];
}

export function electricalFieldsForDeviceType(deviceType: string | undefined): DeviceTypeElectricalField[] | undefined {
  const fields = deviceTypeProfile(deviceType)?.electricalFields;
  return fields ? [...new Set(fields)] : undefined;
}

export function isSignalDeviceType(deviceType: string | undefined): boolean {
  return deviceTypeProfile(deviceType)?.semanticFacts?.signalDevice === true;
}
