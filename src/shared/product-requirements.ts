import type { ProductResult } from "./types.js";

export interface ElectricalRequirementContext {
  deviceType?: string;
  deviceTypeConfidence?: number;
  deviceTypeElectricalFields?: ElectricalField[];
}

export type ElectricalField = "voltage" | "current";

const NON_ELECTRICAL_ACCESSORY_PATTERN =
  /\b(cable\s+(?:gland|entry|fitting|duct|tray|tie|clamp|mount)|(?:base|mounting|support)\s+frame|mount(?:ing)?\s+(?:kit|foot|bracket|plate|hardware)|sub\s*panel|subpanel|(?:rear|back)\s*(?:panel|wall)|dead\s*front|terminal\s+covers?|terminal\s+shrouds?|shrouds?|trip\s+unit\s+cover|key\s+locks?|padlocks?|interlocks?|lifting\s+plate|mounting\s+flange|support\s+(?:plate|bracket)|cover\s+(?:kit|plate|accessor(?:y|ies))|hinge|latch|gasket|window\s+kit|adapter\s+plate|shelf|rail|duct|wireway|enclosure\s+accessor(?:y|ies)|busbars?|busbar\s+supply|ekip\s+(?:busbars?|temperature|signaling|measuring|signalling|test|com|connect|hi-touch|touch|supply|com\s+r|com\s+actuator|com\s+ip|control)|temperature\s+(?:module|sensor\s+module|probe)|light\s+detectors?|hi-touch|signalling\s+module|signaling\s+module|measuring\s+module|test\s+(?:module|unit|connector)|backpanel|sub\s+frame|frame\s+(?:size|extension)|operating\s+handle\s+kit|handle\s+kit|extended\s+rotary\s+handle|sliding\s+bars?|sliding\s+contacts?|terminal\s+kit|connection\s+kit|battery\s+holder|holder\s+for\s+lithium|coin\s+cell\s+holder|memory\s+card\s+holder|sd\s+card\s+holder)\b/i;

// Eaton xEnergy model codes beginning with XLB are base frames. Some localized SKU pages only
// publish the generic "LV switchgear" product name, so the description is unavailable when the
// electrical-requirement decision is made. The model code remains a reliable product identity.
const EATON_XENERGY_BASE_FRAME_MODEL_PATTERN = /\bxlb[0-9a-z-]*\b/i;

const CURRENT_ONLY_DEVICE_PATTERN =
  /\b(current\s+sensor|homopolar\s+toroid|toroid\s+transformer|external\s+neutral|current\s+transformer)\b/i;

const MECHANICAL_LIMIT_SWITCH_PATTERN =
  /\bmechanical\s+(?:single|multiple)\s+position\s+limit\s+switch(?:es)?\b/i;

const SWITCH_DISCONNECTOR_CURRENT_ONLY_PATTERN =
  /\b(?:rotary\s+disconnect|main\s+switch|switch[-\s]?disconnectors?)\b/i;

// Eaton sells many non-electrical product lines (aerospace, vehicle, filtration, golf grips, …).
// These have no voltage/current data on their catalog pages and never will, so the quality gate
// must not flag them as "missing electrical fields". The pattern lists product-type tokens that
// only ever appear in Eaton's mechanical / hydraulic / aerospace / consumer catalogs.
const NON_ELECTRICAL_INDUSTRIAL_PRODUCT_PATTERN =
  /\b(?:golf\s+grip|grip,\s+(?:putter|swing|wrap)|putter\s+grip|swing\s+grip|engine\s+valve|valvetrain|valve\s+actuation|differential|differentials|aftermarket\s+differential|original\s+equipment\s+differential|transmission\s+(?:parts?|fluid|service)?|clutch(?:\s+disc)?|brake(?:\s+disc|\s+pad)?|filter\s+(?:media|element|cartridge|bag|disc|housing|strainer)|strainer|coupling|quick\s+disconnect\s+(?:coupling|fitting|hose)|hose\s+(?:assembly|assemblies)|hydraulic\s+(?:hose|cylinder|valve|cartridge|pump|motor|fitting|tube)|aerospace\s+(?:tube|hose|fitting|seal|valve|pump|coupling|connector|fuel|hydraulic|nozzle)|fuel\s+(?:nozzle|connector|coupling|inerting|pump)|emissions\s+control|ducting|plastic\s+extrusion|extrusion|zipmate|fastener|fixing\s+system|pipe\s+hanger|strut\s+system|seismic\s+brac|cable\s+tray|ladder\s+system|ground[ie]ng\s+(?:clamp|electrode|conductor|kit)|grommet|seal\s+(?:ring|kit)|o-ring|fitting|gland(?:\s+kit)?|adaptor|adapter\s+(?:plate|kit)|conduit\s+bod(?:y|ies)|conduit\s+fitting|outlet\s+box|junction\s+box|wireway\s+(?:fitting|cover|tee|elbow))\b/i;

// M22 / RMQ-Titan pushbutton ACTUATORS (front-panel button heads) are sold separately from the
// contact blocks that carry the actual switching voltage/current. The actuator itself has no
// electrical rating on Eaton's catalog page — voltage/current come from the paired contact block.
// Same for non-illuminated selector heads, mushroom heads, knurled buttons, etc.
const PASSIVE_PILOT_DEVICE_ACTUATOR_PATTERN =
  /\b(?:modular\s+pushbutton|m22(?:[-\s]d)?|rmq[-\s]?titan|non[-\s]?illuminated\s+(?:pushbutton|push\s+button|actuator|selector|button\s+head)|pushbutton\s+(?:head|actuator)|selector\s+(?:switch\s+head|head)|mushroom\s+(?:head|button)|knurled\s+button|enclosure\s+lens|button\s+lens|legend\s+plate|nameplate\s+holder|contact\s+block\s+holder|fixing\s+adapter)\b/i;

const ACTIVE_PUSHBUTTON_CONTACT_PATTERN =
  /\b(?:push[-\s]?button|selector|pilot\s+device|control\s+station)\b[\s\S]{0,160}\b(?:contact\s+block|contacts?\s+(?:type|composition)|\d+\s*(?:NO|NC)\b|switching\s+(?:current|voltage|capacity))\b/i;

const SAFETY_SWITCH_RATED_PATTERN =
  /\bsafety\s+switch(?:es)?\b/i;

const CURRENT_RATING_PRESENT_PATTERN =
  /\b(?:continuous current|rated current|switching current|rated operating current|rated operating voltage|operating voltage)\b/i;

const PASSIVE_RFID_DEVICE_PATTERN =
  /\b(?:read\/write\s+heads?|antennas?)\b/i;

const PASSIVE_SENSOR_ACCESSORY_PATTERN =
  /\b(?:cylindrical\s+glass\s+fibers?|glass\s+fibers?|field\s+attachables?)\b/i;

const PASSIVE_FLUID_DEVICE_PATTERN =
  /\b(?:differential\s+pressure\s+regulators?|pressure\s+regulators?|pressure\s+regulator\s+valves?|ball\s+valves?|check\s+valves?|gate\s+valves?|globe\s+valves?|butterfly\s+valves?|valve\s+body)\b/i;

const ACTIVE_FLUID_DEVICE_PATTERN =
  /\b(?:solenoid|actuator|actuated|motorized?|motorised?|electric(?:al)?|coil)\b/i;

const VOLTAGE_ONLY_DEVICE_PATTERN =
  /\b(rrd\s+motor|remote\s+racking|geared\s+motor|motor\s+operator|motorized?|closing\s+coil|shunt\s+(?:opening|trip)|undervoltage|under\s+voltage|supply\s+module|power\s+supply\s+module|communication\s+module|hmi|human[\s-]?machine[\s-]?interface|operator\s+panel|touch\s+panel|touchscreen\s+panel|display\s+terminal|graphic\s+terminal)\b/i;

const SENSOR_AND_INDICATOR_VOLTAGE_ONLY_PATTERN =
  /\b(condition\s+monitoring|inclination|capacitive|level\s+sensors?|smart\s+level|smartlight|machine\s+lights?|led\s+stack\s+lights?|indicator\s+lights?|signal\s+towers?|stack\s+lights?|inductive|proximity|photoelectric|fork\s+(?:sensors?|light\s+barriers?)|light\s+barriers?|analog\s+(?:distance\s+)?sensors?|pressure(?:-rated)?|ultrasonic|magnetic\s+field|linear\s+position|position\s+sensors?|distance\s+sensors?|rfid|evaluation\s+units?|smartcamera|machine\s+vision|industrial\s+cameras?|vision\s+sensors?|io-link\s+(?:sensor\/actuator\s+)?hubs?)\b/i;

const ELECTRICAL_DEVICE_PATTERN =
  /\b(contactor|kontaktor|relay|relais|relej|breaker|circuit\s+breaker|miniature\s+circuit\s+breaker|mccb|mcb|rcd|fuse(?:\s+holder)?|safety\s+switch|switch(?:es)?|push-?buttons?|pilot\s+lights?|selector\s+switch|contact\s+blocks?|switch-?disconnectors?|disconnect(?:or)?|surge\s+protective|surge\s+arrester|\bspd\b|sensor|proximity|photoelectric|limit\s+switch|power\s+supply|psu|transformer|motor\s+starter|starter|overload|drive|vfd|inverter|soft\s+starter|plc|controller|timer|counter|terminal\s+block|connectors?|cordsets?|cables?|cable\s+assembly|lamp|light|led|beacon|horn|buzzer|fan|heater|thermostat|solenoid|actuator)\b/i;

const PASSIVE_PRODUCT_PATTERN =
  /\b(enc(?:losure)?\.?|cabinet|box|junction\s+box|control\s+box|panel|sub\s*panel|subpanel|back\s*panel|dead\s*front|accessor(?:y|ies)|mount(?:ing)?\s+(?:kit|foot|bracket|plate)|bracket|hinge|latch|clamp|gasket|cover|window|flange|adapter|plate|rail|wireway|duct|shelf)\b/i;

const PASSIVE_RACK_CABINET_PATTERN =
  /\b(?:server rack|network rack|rack cabinet|(?:communication\s+and\s+server|server|network)\s+cabinet|cabinet\b(?=[\s\S]{0,180}\b(?:servers?|network|rack[-\s]?mount|rack\s+(?:unit|spacing|angle)s?|\d+\s*u\b))|(?:rack[-\s]?mount|rack\s+(?:unit|spacing)s?|\d+\s*u\b)[\s\S]{0,180}\bcabinet\b)\b/i;

const PASSIVE_MODULE_CARRIER_PATTERN =
  /\b(?:module carrier|carrier frame|module rack|subrack|base\s*unit|baseunit|terminal base|backplane)\b/i;

const ENCLOSURE_THERMAL_VOLTAGE_DEVICE_PATTERN =
  /\b(fan\s*\/\s*heater|heater(?:\s+w\/?\s*thermostat)?|touch\s+safe\s+heater|fan\s+heater|filter\s+fan|fan\s+package|blower|blower\s+package|air\s+conditioner|conditioner,\s*ng\s+air|heat\s+exchanger|exchanger,\s*heat|dehumidifier|light\s+fixture|fixture,\s*led\s+light|led\s+light\s+fixture|thermostat|ethernet\s+converter|converter\s+kit|remote\s+display)\b/i;

const PASSIVE_ENCLOSURE_ACCESSORY_PATTERN =
  /\b(enc(?:losure)?\.?|cabinet|box|junction\s+box|panel|sub\s*panel|subpanel|back\s*panel|dead\s*front|accessor(?:y|ies)|mount(?:ing)?|kit|door|cover|bar|strap|shield|shelf|port|programming\s+port|connection\s+cord|cord|connector|cable|vortex\s+cooler|grounding|latch|hinge|adapter|plate)\b/i;

export function requiredElectricalFields(result: ProductResult, context: ElectricalRequirementContext = {}): ElectricalField[] {
  const primaryText = productPrimaryRequirementText(result);
  const text = productRequirementText(result);
  if (!text) return [];
  // Ganter Norm is a mechanical standard-parts catalog (handles, knobs, clamps, hinges, levers).
  // Even its "with electrical switching function" handle families are mechanical products with an
  // electrical accessory, and Ganter never publishes structured rated voltage/current on its web
  // pages or in machine-readable form — the values only ever appear as prose in the family PDF.
  // Requiring those normalized fields makes every such row fail the quality gate, triggering a
  // fruitless (and slow) discovery/fallback pass that can never fill them. Treat electrical fields
  // as not-applicable for this vendor so an authoritative web-page result stays "found".
  if (result.manufacturerId === "gan") return [];
  if (result.manufacturerId === "eaton" && EATON_XENERGY_BASE_FRAME_MODEL_PATTERN.test(text)) return [];
  if (NON_ELECTRICAL_ACCESSORY_PATTERN.test(primaryText)) return [];
  if (NON_ELECTRICAL_INDUSTRIAL_PRODUCT_PATTERN.test(primaryText)) return [];
  if (PASSIVE_PILOT_DEVICE_ACTUATOR_PATTERN.test(primaryText)) return [];
  if (PASSIVE_MODULE_CARRIER_PATTERN.test(primaryText)) return [];
  if (isFamilyOverviewWithoutPublishedElectricalRatings(result, text)) return [];
  if (PASSIVE_FLUID_DEVICE_PATTERN.test(primaryText) && !ACTIVE_FLUID_DEVICE_PATTERN.test(primaryText)) return [];
  if (CURRENT_ONLY_DEVICE_PATTERN.test(text)) return ["current"];
  if (SWITCH_DISCONNECTOR_CURRENT_ONLY_PATTERN.test(text)) return ["current"];
  if (MECHANICAL_LIMIT_SWITCH_PATTERN.test(text)) {
    return CURRENT_RATING_PRESENT_PATTERN.test(text) ? ["current"] : [];
  }
  if (PASSIVE_SENSOR_ACCESSORY_PATTERN.test(primaryText)) return [];
  if (VOLTAGE_ONLY_DEVICE_PATTERN.test(text)) return ["voltage"];
  if (PASSIVE_RFID_DEVICE_PATTERN.test(primaryText) && !CURRENT_RATING_PRESENT_PATTERN.test(text)) return [];
  if (SENSOR_AND_INDICATOR_VOLTAGE_ONLY_PATTERN.test(text)) {
    return ["voltage"];
  }
  if (ENCLOSURE_THERMAL_VOLTAGE_DEVICE_PATTERN.test(primaryText)) return ["voltage"];
  if (SAFETY_SWITCH_RATED_PATTERN.test(text)) return ["voltage", "current"];
  if (ACTIVE_PUSHBUTTON_CONTACT_PATTERN.test(text)) return ["voltage", "current"];
  if (PASSIVE_ENCLOSURE_ACCESSORY_PATTERN.test(primaryText)) return [];
  const deviceFields = requiredElectricalFieldsForDeviceType(context.deviceType, context.deviceTypeConfidence, context.deviceTypeElectricalFields);
  if (deviceFields) return deviceFields;
  if (PASSIVE_RACK_CABINET_PATTERN.test(primaryText)) return [];
  if (ELECTRICAL_DEVICE_PATTERN.test(text)) return ["voltage", "current"];
  if (PASSIVE_PRODUCT_PATTERN.test(primaryText)) return [];
  return [];
}

export function isFamilyOverviewResult(result: ProductResult): boolean {
  const compactCatalog = compactRequirementKey(result.catalogNumber);
  const evidence = [
    result.productUrl,
    result.title,
    result.description,
    ...result.sources.map((source) => `${source.url} ${source.parser ?? ""} ${source.stage ?? ""}`),
    ...result.documents.map((doc) => `${doc.url} ${doc.label ?? ""} ${doc.sourceUrl ?? ""}`),
    ...result.attributes
      .filter((attr) => /\b(?:product\s+family|family|series|range|catalogs?\s+planned|planned\s+for\s+release)\b/i.test(`${attr.group ?? ""} ${attr.name} ${attr.value}`))
      .map((attr) => `${attr.sourceUrl ?? ""} ${attr.parser ?? ""} ${attr.name} ${attr.value}`)
  ].join(" ");
  const lowerEvidence = evidence.toLowerCase();
  if (/\bfamily-page\b|\bfamily page\b|\boverview\b|\bselection guide\b|\bcatalogs?\s+planned\s+for\s+release\b/i.test(evidence)) return true;
  if (/\/[^\s"'<>?#]*(?:family|families|series|range|overview)[^\s"'<>?#]*/i.test(evidence)) return true;
  if (/\b(?:controllers|processors|drives|switches|sensors|modules|terminals|blocks)\b/i.test(evidence) && /\b(?:family|series|range|overview)\b/i.test(evidence)) {
    return true;
  }
  const productUrlCompact = compactRequirementKey(result.productUrl ?? "");
  const exactProductUrl = Boolean(compactCatalog && productUrlCompact.includes(compactCatalog));
  const familyishTitle = /\b(?:family|series|range|overview)\b/i.test(`${result.title ?? ""} ${result.description ?? ""}`);
  return familyishTitle && !exactProductUrl && !lowerEvidence.includes("product page");
}

function isFamilyOverviewWithoutPublishedElectricalRatings(result: ProductResult, text: string): boolean {
  if (!isFamilyOverviewResult(result)) return false;
  if (result.normalized.voltage || result.normalized.current) return false;
  return !/\b(?:rated|nominal|operating|supply|input|output|control\s+circuit|main\s+circuit)\s+(?:voltage|current)\b|\b\d+(?:[.,]\d+)?\s*(?:v(?:ac|dc)?|a|ma|ka)\b/i.test(text);
}

export function requiredElectricalFieldsForDeviceType(
  deviceType: string | undefined,
  deviceTypeConfidence: number | undefined,
  deviceTypeElectricalFields: ElectricalField[] | undefined
): ElectricalField[] | undefined {
  if (!deviceType) return undefined;
  if (deviceTypeConfidence !== undefined && deviceTypeConfidence < 0.78) return undefined;
  return deviceTypeElectricalFields ? [...new Set(deviceTypeElectricalFields)] : undefined;
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
    .filter((attr) => /\b(product\s+(?:type|name|main type|id|description|short text|family)|extended product type|catalog description|long description)\b/i.test(`${attr.group ?? ""} ${attr.name}`))
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

function compactRequirementKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
