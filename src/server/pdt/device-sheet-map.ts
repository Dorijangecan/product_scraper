/**
 * Tabs that are filled for every product, regardless of device type. "Connection Point
 * Information" is intentionally excluded for now — it stays untouched in the template and will be
 * implemented in a later phase.
 */
export const CONSTANT_SHEETS = ["Material Master Data", "Additional Documents"] as const;

/**
 * Device type (as produced by `classifyDeviceType`) → device-specific PDT tab name(s). Tabs are
 * the exact sheet names in the Master PDT workbook (case-insensitive lookup on the exporter
 * side, so casing here matches the template for readability).
 *
 * Mapping rationale:
 * - Each entry targets the most semantically precise tab that the Master PDT actually exposes.
 * - When the template has no exact tab, lower-confidence catch-all types target the closest
 *   available mechanical/accessory tab so the final PDT still has a device-specific review row.
 */
const DEVICE_SHEET_MAP: Record<string, string[]> = {
  // --- Enclosures & mounting ---
  Enclosure: ["cabinet", "cabinet.mechanical"],
  Subpanel: ["cabinet.mechanical"],
  "Rack Cabinet": ["cabinet.rack"],
  "Module Carrier": ["module carrier frame"],
  Loadcenter: ["energy distribution system"],
  Wireway: ["cable ducts mounting rails"],
  "Mounting Accessory": ["cable ducts mounting rails"],
  "Cover / Door Accessory": ["cabinet.mechanical"],
  "Lock / Interlock": ["Switch"],
  Accessory: ["cabinet.mechanical"],

  // --- Protection & control ---
  // Contactors, fuses, and the various breaker types share the "contactor a. fuses" tab in the
  // Master PDT — it covers all switching/protective devices in the contactor family.
  Contactor: ["contactor a. fuses"],
  Fuse: ["contactor a. fuses"],
  Relay: ["contactor a. fuses"],
  "Safety Relay": ["safety sensor"],
  "Circuit Breaker": ["contactor a. fuses"],
  "Molded Case Circuit Breaker": ["contactor a. fuses"],
  "Miniature Circuit Breaker": ["contactor a. fuses"],
  "Residual Current Device": ["contactor a. fuses"],
  "Motor Circuit Breaker": ["motor protection"],
  "Motor Starter": ["motor protection"],
  "Disconnect Switch": ["contactor a. fuses", "Switch"],
  Switch: ["Switch"],
  "Surge Protective Device": ["int. ext. lightning protection"],

  // --- Power / electrical ---
  "Power Supply": ["power supply devices"],
  UPS: ["power supply devices"],
  Transformer: ["power supply devices"],
  Battery: ["power supply devices"],
  Generator: ["generator"],
  Motor: ["motors"],
  "Variable Speed Drive": ["power supply devices", "servo controller", "motors"],
  "Soft Starter": ["servo controller"],
  "Motion Controller": ["Motion Controller"],
  "Current Sensor": ["el. mesurement devices"],
  Filter: ["filters"],

  // --- Wiring & connectors ---
  Cable: ["cable"],
  "Cable Gland": ["cable gland"],
  Connector: ["connector"],
  // The template contains an empty "connector.optical" placeholder tab, so optical connectors
  // route to the fillable connector tab until a real optical connector layout exists.
  "Optical Connector": ["connector"],
  "PCB Connector": ["PCB connection system"],
  "PCB Terminal Block": ["PCB connection technology"],
  Busbar: ["Busbar"],
  "Terminal Block": ["terminal"],
  "Terminal Accessory": ["terminal endbracket"],
  "Wire Marker": ["Wire ID Information"],

  // --- Sensors ---
  "Photoelectric Sensor": ["optical sensor"],
  "Vision Sensor": ["optical sensor"],
  "Inductive Proximity Sensor": ["electronic sensor"],
  "Capacitive Sensor": ["electronic sensor"],
  "Ultrasonic Sensor": ["electronic sensor"],
  "Magnetic Field Sensor": ["electronic sensor"],
  "RFID Device": ["electronic sensor"],
  Encoder: ["electronic sensor"],
  "Safety Sensor": ["safety sensor"],
  Sensor: ["electronic sensor"],
  "Pressure Sensor": ["sensor - fluid"],
  "Temperature Sensor": ["sensor - fluid"],
  "Flow Sensor": ["sensor - fluid"],
  "Level Sensor": ["sensor - fluid"],

  // --- Automation ---
  "Programmable Logic Controller": ["PLC"],
  "I/O Module": ["PLC"],
  HMI: ["PLC", "panel (HMI)"],
  "Communication Gateway": ["PLC", "RS232 interfaces"],

  // --- Signaling ---
  "Pushbutton / Operator": ["command and alarm device"],
  "Pilot Light": ["command and alarm device"],
  "Stack Light / Beacon": ["command and alarm device"],
  Luminaire: ["Luminaire"],

  // --- Cooling / climate ---
  "Thermal Management": ["cabinet.airconditioning"],

  // --- Pneumatic / fluid power ---
  Pump: ["pump"],
  "Directional Control Valve": ["directional control valve"],
  Valve: ["ventil"],
  "Hydraulic Actuator": ["fluid power"],
  "Pneumatic Device": ["pneumatic handling"]
};

/** Device-specific tab(s) for a device type, or [] when the type has no clear tab. */
export function deviceSheetsFor(deviceType: string | undefined): string[] {
  if (!deviceType) return [];
  return DEVICE_SHEET_MAP[deviceType] ?? [];
}

/** Full set of tabs to fill for a product: constant tabs first, then any device-specific tabs. */
export function targetSheets(deviceType: string | undefined): string[] {
  return [...CONSTANT_SHEETS, ...deviceSheetsFor(deviceType)];
}
