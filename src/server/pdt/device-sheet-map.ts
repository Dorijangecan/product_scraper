/**
 * Tabs that are filled for every product, regardless of device type. "Connection Point
 * Information" is intentionally excluded for now — it stays untouched in the template and will be
 * implemented in a later phase.
 */
export const CONSTANT_SHEETS = ["Material Master Data", "Additional Documents"] as const;

/**
 * Device type (as produced by `classifyDeviceType`) → device-specific PDT tab name(s). Tabs are
 * the exact sheet names in the Master PDT workbook. Entries marked best-effort are reasonable
 * matches that may need confirmation against the real catalog taxonomy.
 */
const DEVICE_SHEET_MAP: Record<string, string[]> = {
  // Enclosures & mounting
  Enclosure: ["cabinet", "cabinet.mechanical"],
  Subpanel: ["cabinet.mechanical"],
  Loadcenter: ["energy distribution system"],
  Wireway: ["cable ducts mounting rails"],
  "Mounting Accessory": ["cable ducts mounting rails"],

  // Protection & control
  Contactor: ["contactor a. fuses"],
  Fuse: ["contactor a. fuses"],
  Relay: ["contactor a. fuses"], // best-effort
  "Circuit Breaker": ["contactor a. fuses"], // best-effort
  "Molded Case Circuit Breaker": ["contactor a. fuses"], // best-effort
  "Miniature Circuit Breaker": ["contactor a. fuses"], // best-effort
  "Motor Circuit Breaker": ["motor protection"],
  "Motor Starter": ["motor protection"],
  "Disconnect Switch": ["Switch"],
  Switch: ["Switch"],
  "Surge Protective Device": ["int. ext. lightning protection"],

  // Power / electrical
  "Power Supply": ["power supply devices"],
  UPS: ["power supply devices"],
  Transformer: ["power supply devices"], // best-effort
  "Variable Speed Drive": ["servo controller"], // best-effort
  "Soft Starter": ["servo controller"], // best-effort
  "Current Sensor": ["el. mesurement devices"],

  // Wiring & connectors
  Cable: ["cable"],
  "Cable Gland": ["cable gland"],
  Connector: ["connector"],
  Busbar: ["Busbar"],
  "Terminal Block": ["terminal"],

  // Sensors
  "Photoelectric Sensor": ["optical sensor"],
  "Vision Sensor": ["optical sensor"],
  "Inductive Proximity Sensor": ["electronic sensor"],
  "Capacitive Sensor": ["electronic sensor"],
  "Ultrasonic Sensor": ["electronic sensor"],
  "Magnetic Field Sensor": ["electronic sensor"],
  "RFID Device": ["electronic sensor"],
  Sensor: ["electronic sensor"],
  "Pressure Sensor": ["sensor - fluid"], // best-effort
  "Temperature Sensor": ["sensor - fluid"], // best-effort

  // Automation
  "Programmable Logic Controller": ["PLC"],
  "I/O Module": ["PLC"],
  HMI: ["panel (HMI)"],

  // Signaling
  "Pushbutton / Operator": ["command and alarm device"],
  "Pilot Light": ["command and alarm device"],
  "Stack Light / Beacon": ["command and alarm device"],
  "Machine Light": ["command and alarm device"],

  // Cooling
  "Thermal Management": ["cabinet.airconditioning"]
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
