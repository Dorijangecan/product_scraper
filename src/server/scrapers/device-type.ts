import type { AttributeRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { cleanText } from "./normalizer.js";

export interface DeviceTypeClassification {
  type?: string;
  confidence?: number;
  evidence?: string;
}

interface DeviceTypeRule {
  type: string;
  pattern: RegExp;
  priority: number;
}

interface DeviceTypeCandidate {
  text: string;
  label: string;
  value: string;
  priority: number;
  sourceType?: SourceRecord["sourceType"];
  parser?: string;
}

const DEVICE_TYPE_RULES: DeviceTypeRule[] = [
  rule("Programmable Logic Controller", /\b(?:plc|programmable logic controller|logic controller|controller cpu|cpu module|simatic\s+s7|modicon\s+(?:m\d+|m340|m580)|compactlogix|controllogix)\b/i, 720),
  rule("I/O Module", /\b(?:i\/o|io|input\/output)\s+(?:module|expansion|system|block)|(?:analog|digital)\s+(?:input|output)s?\s+(?:module|expansion)|remote\s+i\/o|io-link\s+(?:master|hub|module)\b/i, 700),
  rule("HMI", /\b(?:hmi|human machine interface|operator panel|touch panel|display terminal|graphic terminal)\b/i, 690),
  rule("Photoelectric Sensor", /\b(?:photoelectric|photo\s*electric|through-?beam|retroreflective|diffuse\s+(?:reflective|sensor)|fork\s+(?:sensor|light barrier)|light barrier)\b/i, 680),
  rule("Inductive Proximity Sensor", /\b(?:inductive\s+(?:proximity\s+)?sensor|inductive proximity|proximity switch)\b/i, 675),
  rule("Capacitive Sensor", /\bcapacitive\s+(?:proximity\s+)?sensor\b/i, 670),
  rule("Pressure Sensor", /\bpressure\s+(?:sensor|switch|transmitter)\b/i, 668),
  rule("Temperature Sensor", /\b(?:temperature|thermocouple|rtd)\s+(?:sensor|probe|transmitter)\b/i, 666),
  rule("Ultrasonic Sensor", /\bultrasonic\s+(?:sensor|distance sensor)\b/i, 664),
  rule("Magnetic Field Sensor", /\bmagnetic\s+field\s+sensor\b/i, 662),
  rule("Vision Sensor", /\b(?:vision\s+sensor|smartcamera|smart camera|industrial camera|machine vision)\b/i, 660),
  rule("RFID Device", /\b(?:rfid|read\/write\s+head|antenna)\b/i, 650),
  rule("Sensor", /\b(?:sensor|sensing|detector|limit switch|position switch|measuring range|measuring principle)\b/i, 620),

  rule("Motor Circuit Breaker", /\bmotor\s+(?:protective\s+)?circuit breaker\b/i, 710),
  rule("Molded Case Circuit Breaker", /\b(?:molded|moulded)\s+case\s+circuit breaker|\bmccb\b/i, 705),
  rule("Miniature Circuit Breaker", /\bminiature\s+circuit breaker|\bmcb\b/i, 704),
  rule("Circuit Breaker", /\b(?:circuit breaker|breaker)\b/i, 690),
  rule("Contactor", /\b(?:contactor|kontaktor)\b/i, 690),
  rule("Relay", /\b(?:relay|relais|relej|safety relay|interface relay)\b/i, 670),
  rule("Motor Starter", /\bmotor starter|starter combination|manual starter\b/i, 670),
  rule("Soft Starter", /\bsoft starter\b/i, 665),
  rule("Variable Speed Drive", /\b(?:variable speed drive|variable frequency drive|\bvfd\b|drive|inverter|servo drive)\b/i, 660),
  rule("Disconnect Switch", /\b(?:switch[-\s]?disconnector|disconnect(?:or)? switch|safety switch|rotary disconnect|main switch)\b/i, 655),
  rule("Switch", /\b(?:switch|selector switch|pushbutton switch|cam switch)\b/i, 600),
  rule("Surge Protective Device", /\b(?:surge protective device|\bspd\b|surge arrester|surge protection)\b/i, 650),
  rule("Fuse", /\b(?:fuse holder|fuse disconnect|fuse switch|fuse)\b/i, 630),
  rule("Power Supply", /\b(?:power supply|psu|switched mode power supply|regulated power supply)\b/i, 650),
  rule("Transformer", /\b(?:transformer|current transformer|control transformer|toroid)\b/i, 640),
  rule("Current Sensor", /\b(?:current sensor|current transducer|external neutral|homopolar toroid)\b/i, 635),

  rule("Enclosure", /\b(?:enclosure|cabinet|junction box|control box|wall mounted steel enclosure|floor standing enclosure|terminal box)\b/i, 700),
  rule("Loadcenter", /\b(?:loadcenter|load center|panelboard|distribution board|consumer unit)\b/i, 690),
  rule("Wireway", /\b(?:wireway|wire duct|cable duct)\b/i, 640),
  rule("Subpanel", /\b(?:subpanel|sub-panel|back panel|mounting panel)\b/i, 630),

  rule("Terminal Block", /\b(?:terminal block|power terminal|terminal strip|terminal)\b/i, 620),
  rule("Connector", /\b(?:connector|plug|socket|receptacle|cordset)\b/i, 610),
  rule("Cable", /\b(?:cable assembly|cable|cord|patch cord|lead wire)\b/i, 600),
  rule("Cable Gland", /\b(?:cable gland|gland|cord grip)\b/i, 630),
  rule("Busbar", /\b(?:busbar|bus bar)\b/i, 620),

  rule("Pushbutton / Operator", /\b(?:pushbutton|push-button|operator|emergency stop|selector head|pilot device)\b/i, 650),
  rule("Pilot Light", /\b(?:pilot light|indicator light|signal lamp)\b/i, 640),
  rule("Stack Light / Beacon", /\b(?:stack light|signal tower|beacon|horn|buzzer)\b/i, 640),
  rule("Machine Light", /\b(?:machine light|led light fixture|fixture,\s*led light|light fixture)\b/i, 625),

  rule("UPS", /\b(?:ups|uninterruptible power supply)\b/i, 660),
  rule("Battery", /\b(?:battery|battery pack)\b/i, 620),
  rule("Thermal Management", /\b(?:filter fan|fan package|blower|heater|thermostat|air conditioner|heat exchanger|dehumidifier|cooling unit)\b/i, 650),

  rule("Lock / Interlock", /\b(?:padlock|key lock|interlock|locking device|lock)\b/i, 620),
  rule("Mounting Accessory", /\b(?:mounting kit|mounting bracket|mounting foot|mounting plate|adapter plate|rail|bracket)\b/i, 610),
  rule("Cover / Door Accessory", /\b(?:cover|door|hinge|latch|handle|gasket|window kit)\b/i, 600),
  rule("Accessory", /\b(?:accessory|spare part|kit|replacement part)\b/i, 560)
];

export function classifyDeviceType(result: ProductResult | undefined): DeviceTypeClassification {
  if (!result) return {};
  const candidates = deviceTypeCandidates(result);
  const matches = candidates.flatMap((candidate) => {
    return DEVICE_TYPE_RULES.filter((definition) => definition.pattern.test(candidate.text)).map((definition) => ({
      type: definition.type,
      candidate,
      score: candidate.priority + definition.priority + sourceTypeScore(candidate.sourceType),
      definitionPriority: definition.priority
    }));
  });
  const best = matches.sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) return scoreDelta;
    return right.definitionPriority - left.definitionPriority;
  })[0];
  if (!best) return {};
  return {
    type: best.type,
    confidence: deviceTypeConfidence(best.score),
    evidence: `${best.candidate.label}: ${best.candidate.value}`
  };
}

function rule(type: string, pattern: RegExp, priority: number): DeviceTypeRule {
  return { type, pattern, priority };
}

function deviceTypeCandidates(result: ProductResult): DeviceTypeCandidate[] {
  const attributes = result.attributes ?? [];
  const candidates: DeviceTypeCandidate[] = [];
  for (const attr of attributes) {
    const priority = attributeDeviceTypePriority(attr);
    if (!priority) continue;
    addCandidate(candidates, {
      label: attr.name,
      value: attr.value,
      text: `${attr.name} ${attr.value}`,
      priority,
      sourceType: attr.sourceType,
      parser: attr.parser
    });
  }

  addCandidate(candidates, { label: "Title", value: result.title, text: result.title, priority: 610 });
  addCandidate(candidates, { label: "Description", value: result.description, text: result.description, priority: 590 });
  return candidates;
}

function attributeDeviceTypePriority(attr: AttributeRecord): number | undefined {
  const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
  if (/\b(?:recommended alternative|similar part|related part|accessory|used with|spare part)\b/.test(label)) return undefined;
  if (/\b(?:product or component type|product main type|product type|sensor type|type description)\b/.test(label)) return 760;
  if (/\b(?:principle of operation|principle of optical operation|operating principle|product category|category|product group|product family|product class|classification path|products path|range of product|range)\b/.test(label)) return 720;
  if (/\b(?:product name|item name|display name|catalog description|long description|short description|description)\b/.test(label)) return 650;
  if (/\b(?:alternateName|product label|device short name|model code|model number|extended product type)\b/i.test(attr.name)) return 500;
  return undefined;
}

function addCandidate(candidates: DeviceTypeCandidate[], candidate: Omit<DeviceTypeCandidate, "value" | "text"> & { value?: string; text?: string }) {
  const value = cleanText(candidate.value);
  const text = cleanText(candidate.text ?? value);
  if (!value || !text || !isUsefulDeviceTypeText(text)) return;
  candidates.push({ ...candidate, value, text });
}

function isUsefulDeviceTypeText(value: string): boolean {
  if (value.length < 3) return false;
  if (/^[-_\w./]+$/.test(value) && !/[a-z]{4,}/i.test(value)) return false;
  if (/^(?:active|obsolete|yes|no|n\/a|not applicable)$/i.test(value)) return false;
  return true;
}

function sourceTypeScore(sourceType?: SourceRecord["sourceType"]): number {
  if (sourceType === "official") return 90;
  if (sourceType === "official-fallback") return 70;
  if (sourceType === "cache") return 30;
  if (sourceType === "distributor") return -40;
  return 0;
}

function deviceTypeConfidence(score: number): number {
  if (score >= 1500) return 0.98;
  if (score >= 1420) return 0.94;
  if (score >= 1320) return 0.88;
  if (score >= 1200) return 0.78;
  return 0.68;
}
