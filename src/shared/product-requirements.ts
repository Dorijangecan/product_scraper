import type { ProductResult } from "./types.js";

const NON_ELECTRICAL_ACCESSORY_PATTERN =
  /\b(cable\s+(?:gland|entry|fitting|duct|tray|tie|clamp|mount)|mount(?:ing)?\s+(?:kit|foot|bracket|plate|hardware)|sub\s*panel|subpanel|back\s*panel|dead\s*front|terminal\s+covers?|terminal\s+shrouds?|shrouds?|trip\s+unit\s+cover|key\s+locks?|padlocks?|interlocks?|lifting\s+plate|mounting\s+flange|support\s+(?:plate|bracket)|cover\s+(?:kit|plate|accessor(?:y|ies))|hinge|latch|gasket|window\s+kit|adapter\s+plate|shelf|rail|duct|wireway|enclosure\s+accessor(?:y|ies)|busbars?|busbar\s+supply|ekip\s+(?:busbars?|temperature|signaling|measuring|signalling|test|com|connect|hi-touch|touch|supply|com\s+r|com\s+actuator|com\s+ip|control)|temperature\s+(?:module|sensor\s+module|probe)|light\s+detectors?|hi-touch|signalling\s+module|signaling\s+module|measuring\s+module|test\s+(?:module|unit|connector)|backpanel|sub\s+frame|frame\s+(?:size|extension)|operating\s+handle\s+kit|handle\s+kit|extended\s+rotary\s+handle|sliding\s+bars?|sliding\s+contacts?|terminal\s+kit|connection\s+kit|battery\s+holder|holder\s+for\s+lithium|coin\s+cell\s+holder|memory\s+card\s+holder|sd\s+card\s+holder)\b/i;

const CURRENT_ONLY_DEVICE_PATTERN =
  /\b(current\s+sensor|homopolar\s+toroid|toroid\s+transformer|external\s+neutral|current\s+transformer)\b/i;

const BALLUFF_CURRENT_ONLY_DEVICE_PATTERN =
  /\bmechanical\s+(?:single|multiple)\s+position\s+limit\s+switch(?:es)?\b/i;

const EATON_CURRENT_ONLY_DEVICE_PATTERN =
  /\b(?:rotary\s+disconnect|main\s+switch|switch[-\s]?disconnectors?)\b/i;

const BALLUFF_CURRENT_RATING_PRESENT_PATTERN =
  /\b(?:continuous current|rated current|switching current|rated operating current|rated operating voltage|operating voltage)\b/i;

const BALLUFF_PASSIVE_RFID_DEVICE_PATTERN =
  /\b(?:read\/write\s+heads?|antennas?)\b/i;

const VOLTAGE_ONLY_DEVICE_PATTERN =
  /\b(rrd\s+motor|remote\s+racking|geared\s+motor|motor\s+operator|motorized?|closing\s+coil|shunt\s+(?:opening|trip)|undervoltage|under\s+voltage|supply\s+module|power\s+supply\s+module|communication\s+module)\b/i;

const BALLUFF_VOLTAGE_ONLY_DEVICE_PATTERN =
  /\b(condition\s+monitoring|inclination|capacitive|level\s+sensors?|smart\s+level|smartlight|machine\s+lights?|led\s+stack\s+lights?|indicator\s+lights?|signal\s+towers?|stack\s+lights?|inductive|proximity|photoelectric|fork\s+(?:sensors?|light\s+barriers?)|light\s+barriers?|analog\s+(?:distance\s+)?sensors?|pressure(?:-rated)?|ultrasonic|magnetic\s+field|linear\s+position|position\s+sensors?|distance\s+sensors?|rfid|evaluation\s+units?|smartcamera|machine\s+vision|industrial\s+cameras?|vision\s+sensors?|io-link\s+(?:sensor\/actuator\s+)?hubs?)\b/i;

const ELECTRICAL_DEVICE_PATTERN =
  /\b(contactor|kontaktor|relay|relais|relej|breaker|circuit\s+breaker|miniature\s+circuit\s+breaker|mccb|mcb|rcd|fuse(?:\s+holder)?|safety\s+switch|switch(?:es)?|push-?buttons?|pilot\s+lights?|selector\s+switch|contact\s+blocks?|switch-?disconnectors?|disconnect(?:or)?|surge\s+protective|surge\s+arrester|\bspd\b|sensor|proximity|photoelectric|limit\s+switch|power\s+supply|psu|transformer|motor\s+starter|starter|overload|drive|vfd|inverter|soft\s+starter|plc|controller|timer|counter|terminal\s+block|connectors?|cordsets?|cables?|cable\s+assembly|lamp|light|led|beacon|horn|buzzer|fan|heater|thermostat|solenoid|actuator)\b/i;

const PASSIVE_PRODUCT_PATTERN =
  /\b(enclosure|cabinet|box|junction\s+box|control\s+box|panel|sub\s*panel|subpanel|back\s*panel|dead\s*front|accessor(?:y|ies)|mount(?:ing)?\s+(?:kit|foot|bracket|plate)|bracket|hinge|latch|clamp|gasket|cover|window|flange|adapter|plate|rail|wireway|duct|shelf)\b/i;

const SCE_VOLTAGE_RATED_DEVICE_PATTERN =
  /\b(fan\s*\/\s*heater|heater(?:\s+w\/?\s*thermostat)?|touch\s+safe\s+heater|fan\s+heater|filter\s+fan|fan\s+package|blower|blower\s+package|air\s+conditioner|conditioner,\s*ng\s+air|heat\s+exchanger|exchanger,\s*heat|dehumidifier|light\s+fixture|fixture,\s*led\s+light|led\s+light\s+fixture|thermostat|ethernet\s+converter|converter\s+kit|remote\s+display)\b/i;

const SCE_PASSIVE_OR_ACCESSORY_PATTERN =
  /\b(enclosure|cabinet|box|junction\s+box|panel|sub\s*panel|subpanel|back\s*panel|dead\s*front|accessor(?:y|ies)|mount(?:ing)?|kit|door|cover|bar|strap|shield|shelf|port|programming\s+port|connection\s+cord|cord|connector|cable|vortex\s+cooler|grounding|latch|hinge|adapter|plate)\b/i;

export function requiredElectricalFields(result: ProductResult): Array<"voltage" | "current"> {
  const primaryText = productPrimaryRequirementText(result);
  const text = productRequirementText(result);
  if (!text) return [];
  if (NON_ELECTRICAL_ACCESSORY_PATTERN.test(primaryText)) return [];
  if (result.manufacturerId === "sce") return requiredSceElectricalFields(primaryText);
  if (CURRENT_ONLY_DEVICE_PATTERN.test(text)) return ["current"];
  if (result.manufacturerId === "eaton" && EATON_CURRENT_ONLY_DEVICE_PATTERN.test(text)) return ["current"];
  if (result.manufacturerId === "balluff" && BALLUFF_CURRENT_ONLY_DEVICE_PATTERN.test(text)) {
    return BALLUFF_CURRENT_RATING_PRESENT_PATTERN.test(text) ? ["current"] : [];
  }
  if (VOLTAGE_ONLY_DEVICE_PATTERN.test(text)) return ["voltage"];
  if (result.manufacturerId === "balluff" && BALLUFF_PASSIVE_RFID_DEVICE_PATTERN.test(primaryText) && !BALLUFF_CURRENT_RATING_PRESENT_PATTERN.test(text)) return [];
  if (result.manufacturerId === "balluff" && BALLUFF_VOLTAGE_ONLY_DEVICE_PATTERN.test(text)) {
    return ["voltage"];
  }
  if (ELECTRICAL_DEVICE_PATTERN.test(text)) return ["voltage", "current"];
  if (PASSIVE_PRODUCT_PATTERN.test(primaryText)) return [];
  return [];
}

export function requiresElectricalRatings(result: ProductResult): boolean {
  return requiredElectricalFields(result).length > 0;
}

function productRequirementText(result: ProductResult): string {
  const primaryText = productPrimaryRequirementText(result);
  const attributeText = result.attributes
    .slice(0, 80)
    .map((attr) => `${attr.group ?? ""} ${attr.name} ${attr.value}`)
    .join(" ");
  return [primaryText, attributeText].filter(Boolean).join(" ").toLowerCase();
}

function productPrimaryRequirementText(result: ProductResult): string {
  const primaryAttributeText = result.attributes
    .filter((attr) => /\b(product\s+(?:type|name|main type|id)|extended product type|catalog description|long description)\b/i.test(`${attr.group ?? ""} ${attr.name}`))
    .slice(0, 20)
    .map((attr) => `${attr.name} ${attr.value}`)
    .join(" ");
  return [
    result.catalogNumber,
    result.title,
    result.description,
    result.normalized.material,
    result.normalized.protection,
    primaryAttributeText
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function requiredSceElectricalFields(primaryText: string): Array<"voltage" | "current"> {
  if (SCE_VOLTAGE_RATED_DEVICE_PATTERN.test(primaryText)) return ["voltage"];
  if (SCE_PASSIVE_OR_ACCESSORY_PATTERN.test(primaryText)) return [];
  if (/\b(?:vac|vdc|\d+(?:[.,]\d+)?\s*(?:v(?:ac|dc)?|volts?))\b/i.test(primaryText)) return ["voltage"];
  return [];
}
