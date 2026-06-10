import identifiers from "./iec-identifiers.generated.json";

interface IecIdentifierRow {
  trade: string;
  category: string;
  group: string;
  functionDefinition: string;
  identifier: string;
}

const rows = identifiers as IecIdentifierRow[];

const DEVICE_TYPE_CATEGORY_CANDIDATES: Record<string, string[]> = {
  Busbar: ["Busbar definition", "Busbar"],
  Cable: ["Cable"],
  "Circuit Breaker": ["Circuit breaker"],
  "Molded Case Circuit Breaker": ["Circuit breaker"],
  "Miniature Circuit Breaker": ["Circuit breaker"],
  "Residual Current Device": ["Ground fault current circuit-breaker", "Circuit breaker"],
  Enclosure: ["Enclosure"],
  "Rack Cabinet": ["19'' design", "Enclosure"],
  Subpanel: ["Mounting panel"],
  Motor: ["Motor"],
  Transformer: ["Transformer"],
  "Current Sensor": ["Transformer", "Sensor"],
  "Power Supply": ["Voltage source"],
  "Terminal Block": ["Terminal"],
  "Terminal Accessory": ["Terminal accessories"],
  Connector: ["Plug-in connector", "Plug definition"],
  "PCB Connector": ["Plug-in connector"],
  "PCB Terminal Block": ["Terminal"],
  "Photoelectric Sensor": ["Light barrier", "Sensor"],
  "Inductive Proximity Sensor": ["Proximity switch", "Sensor"],
  "Capacitive Sensor": ["Proximity switch", "Sensor"],
  "Pressure Sensor": ["Sensor", "Analog sensor"],
  "Temperature Sensor": ["Sensor", "Analog sensor"],
  "Flow Sensor": ["Sensor", "Analog sensor"],
  "Level Sensor": ["Sensor", "Analog sensor"],
  Sensor: ["Sensor"],
  "Safety Sensor": ["Safety switch", "Sensor"],
  "Pushbutton / Operator": ["Switch / pushbutton", "Operating element"],
  "Pilot Light": ["Light", "Signal lamp"],
  "Stack Light / Beacon": ["Signal device, optical", "Signal device, acoustic"],
  Luminaire: ["Light"],
  Pump: ["Pump"],
  Valve: ["Valve"],
  "Directional Control Valve": ["Directional control valve"],
  "Hydraulic Actuator": ["Cylinder"],
  "Pneumatic Device": ["Actuators, general"],
  "Variable Speed Drive": ["Converter"],
  "Soft Starter": ["Motor overload switch"],
  "Motor Circuit Breaker": ["Motor overload switch", "Circuit breaker"],
  "Surge Protective Device": ["Protective circuit"],
  Fuse: ["Safety fuse"],
  Battery: ["Accumulator"],
  Generator: ["Generator"]
};

export function iec81346IdentifierForDeviceType(deviceType: string | undefined): string | undefined {
  const cleaned = clean(deviceType);
  if (!cleaned) return undefined;
  const candidates = DEVICE_TYPE_CATEGORY_CANDIDATES[cleaned] ?? [cleaned];
  for (const candidate of candidates) {
    const identifier = identifierForCategory(candidate);
    if (identifier) return identifier;
  }
  return undefined;
}

function identifierForCategory(category: string): string | undefined {
  const normalized = comparable(category);
  const matches = rows.filter((row) => comparable(row.category) === normalized);
  const identifiers = [...new Set(matches.map((row) => clean(row.identifier)).filter((value): value is string => Boolean(value)))];
  return identifiers.length === 1 ? identifiers[0] : undefined;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

function comparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
