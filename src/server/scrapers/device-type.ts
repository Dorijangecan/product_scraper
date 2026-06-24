import type { AttributeRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { cleanText } from "./normalizer.js";
import { familyTypeFor } from "./device-type-families.js";
import { urlTypeFor } from "./device-type-urls.js";

export interface DeviceTypeAlternative {
  type: string;
  score: number;
  /** Channels (text/family/url/eclass/etim/unspsc) that voted for this type. */
  channels: string[];
}

export interface DeviceTypeClassification {
  type?: string;
  /** Confidence in [0, 1]. ≥0.78 is considered "safe to use without review". */
  confidence?: number;
  /** Short string describing the strongest evidence behind the pick. */
  evidence?: string;
  /** Up to two next-best candidate types, useful for surfacing in the audit sheet. */
  alternatives?: DeviceTypeAlternative[];
  /** Difference in score between the winner and the runner-up (0 if no alternative). */
  scoreMargin?: number;
  /** Sanity-check warnings (e.g. "Contactor classified but no pole number found"). */
  warnings?: string[];
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

// Higher rule priority = more specific device type. Specificity is the dominant signal in the
// classifier: a narrow rule (e.g. "Inductive Proximity Sensor", 875) always wins over a catch-all
// (e.g. "Sensor", 620) whenever both match the same product. Within a single tier, evidence
// quality (where the text came from + which source it came from) decides confidence.
const DEVICE_TYPE_RULES: DeviceTypeRule[] = [
  // --- Automation (very specific names — these win over generic "controller"/"module") ---
  rule("Programmable Logic Controller", /\b(?:programmable logic controller|logic controller|controller cpu|cpu module|plc\s+(?:controller|module|processor|cpu|system)|(?:controller|module|processor|cpu|system)\s+plc|simatic\s+s7|modicon\s+(?:m\d+|m340|m580)|compactlogix|controllogix|micro8\d{2,3})\b/i, 920),
  rule("Communication Gateway", /\b(?:communication gateway|fieldbus gateway|fieldbus coupler|bus coupler|protocol converter|protocol gateway|serial gateway|modbus gateway|profibus gateway|profinet gateway|ethernet gateway|rs[-\s]?232(?:\s+(?:to|converter|interface|module))?|rs[-\s]?485(?:\s+(?:to|converter|interface|module))?|rs[-\s]?422|serial[-\s]?to[-\s]?ethernet|communication module|communication interface|industrial gateway|iiot gateway|edge gateway)\b/i, 905),
  rule("I/O Module", /\b(?:i\/o|io|input\/output)\s+(?:module|expansion|system|block|card|interface)|(?:analog|digital)\s+(?:input|output)s?\s+(?:module|card|expansion)|remote\s+i\/o|io-link\s+(?:master|hub|module)\b/i, 900),
  rule("HMI", /\b(?:hmi|human[\s-]?machine[\s-]?interface|operator panel|touch panel|touchscreen panel|display terminal|graphic terminal)\b/i, 890),
  rule("Motion Controller", /\b(?:motion controller|motion control(?:ler)? module|motion module|integrated motion module|analog servo module|servo module|\d+\s*[- ]?axis servo|axis servo,\s*analog|servo,\s*analog\/enc|cnc controller|servo controller)\b/i, 930),

  // --- Sensors (specific kinds first; generic "Sensor" is a fallback) ---
  rule("Photoelectric Sensor", /\b(?:photoelectric|photo\s*electric|through-?beam|retro[-\s]?reflective|diffuse\s+(?:reflective|sensor)|fork\s+(?:sensor|light barrier)|light barrier|light grid)\b/i, 880),
  rule("Inductive Proximity Sensor", /\b(?:inductive\s+(?:proximity\s+)?sensor|inductive proximity|inductive switch|proximity switch)\b/i, 875),
  rule("Capacitive Sensor", /\bcapacitive\s+(?:(?:proximity|level)\s+)?(?:sensors?|switch(?:es)?)\b/i, 870),
  rule("Pressure Sensor", /\bpressure\s+(?:sensor|switch|transmitter|transducer)\b/i, 868),
  rule("Temperature Sensor", /\b(?:temperature\s+(?:sensor|probe|transmitter|transducer)|thermocouple|\brtd\b|pt100|pt1000)\b/i, 866),
  rule("Ultrasonic Sensor", /\bultrasonic\s+(?:sensor|distance sensor|transducer)\b/i, 864),
  rule("Magnetic Field Sensor", /\bmagnetic\s+field\s+sensor|hall[-\s]?effect\s+sensor\b/i, 862),
  rule("Vision Sensor", /\b(?:vision\s+sensor|smart\s*camera|industrial camera|machine vision)\b/i, 860),
  rule("RFID Device", /\b(?:rfid|read\/write\s+head|read[-\s]?write\s+head|(?:hf|uhf)\s+(?:reader|antenna|read\/write)|13\.56\s*mhz|rfid\s+(?:reader|antenna|transponder))\b/i, 850),
  rule("Flow Sensor", /\bflow\s+(?:sensor|meter|switch|transmitter)\b/i, 845),
  rule("Level Sensor", /\b(?:level\s+(?:sensor|switch|transmitter)|float switch)\b/i, 843),
  rule("Encoder", /\b(?:rotary encoders?|absolute encoders?|incremental encoders?|encoders?)\b/i, 840),
  rule("Safety Sensor", /\b(?:safety sensor|safety light curtain|light curtain|safety mat|safety scanner|laser scanner|safety edge|two[-\s]?hand control|safety switch|safety interlock|guard locking|guard[-\s]?lock(?:ing)? switch|safety door switch|door interlock)\b/i, 838),
  rule("Sensor", /\b(?:sensor|sensing|detector|limit switch|position switch|measuring range|measuring principle)\b/i, 620),

  // --- Protection & control (specific breakers/starters first) ---
  rule("Motor Circuit Breaker", /\bmotor\s+(?:protective\s+)?circuit[-\s]?breakers?|motor protection device|motor protection|manual motor (?:starter|protector)\b/i, 820),
  rule("Molded Case Circuit Breaker", /\b(?:molded|moulded)\s+case\s+circuit[-\s]?breakers?|\bmccbs?\b/i, 815),
  rule("Miniature Circuit Breaker", /\bminiature\s+circuit[-\s]?breakers?|\bmcbs?\b/i, 814),
  rule("Residual Current Device", /\b(?:residual current device|residual current circuit[-\s]?breakers?|\brcd\b|\brccb\b|\brcbo\b|ground[-\s]?fault circuit[-\s]?interrupter|\bgfci\b|earth leakage)\b/i, 813),
  rule("Circuit Breaker", /\b(?:air\s+circuit[-\s]?breakers?|thermal overcurrent circuit[-\s]?breakers?|overcurrent circuit[-\s]?breakers?|circuit[-\s]?breakers?|\bacbs?\b)\b/i, 805),
  rule("Safety Relay", /\b(?:safety relay|safety controller|safety module|emergency stop relay|e[-\s]?stop relay)\b/i, 803),
  rule("Contactor", /\b(?:contactor|contactor relay|kontaktor|contact kit|contact tip kit|main contact kit|replacement contacts?)\b/i, 800),
  rule("Relay", /\b(?:interface relay|coupling relay|plug-?in relay|timer relay|monitoring relay|relais|relej|\brelay\b)\b/i, 790),
  rule("Soft Starter", /\bsoft[-\s]?starter\b/i, 785),
  rule("Variable Speed Drive", /\b(?:variable speed drive|variable frequency drive|\bvfd\b|frequency (?:converter|inverter)|\bvsd\b|servo drive|ac drive|motor drive|inverter drive)\b|(?:\u53d8\u9891\u5668|\u53d8\u9891\u9a71\u52a8|\u9891\u7387\u8f6c\u6362\u5668)/i, 780),
  rule("Motor Starter", /\b(?:motor starter|starter combination|reversing starter|direct[-\s]?on[-\s]?line starter|\bdol starter\b)\b/i, 775),
  rule("Disconnect Switch", /\b(?:switch[-\s]?disconnector|disconnect(?:ing|or)?\s+switch|isolator switch|safety switch|rotary disconnect|main switch|load break switch)\b/i, 770),
  rule("Surge Protective Device", /\b(?:surge protective device|\bspd\b|surge arrester|surge protection|lightning arrester)\b/i, 765),
  rule("Fuse", /\b(?:fuse holder|fuse base|fuse disconnect(?:or)?|fuse switch|fuse link|fuse carrier|nh fuse|d fuse|\bfuse\b)\b/i, 760),
  rule("Switch", /\b(?:selector switch|cam switch|pushbutton switch|rotary switch|toggle switch|key[-\s]?operated switch|\bswitch\b)\b/i, 700),

  // --- Power / electrical ---
  rule("UPS", /\b(?:\bups\b|uninterruptible power supply)\b/i, 760),
  rule("Power Supply", /\b(?:power supply|power supply module|switched[-\s]?mode power supply|smps|regulated power supply|dc power supply|\bpsu\b)\b/i, 755),
  rule("Transformer", /\b(?:control transformer|isolation transformer|step[-\s]?down transformer|step[-\s]?up transformer|toroidal transformer|\btransformer\b)\b/i, 750),
  rule("Current Sensor", /\b(?:current sensor|current transducer|current transformer|external neutral|homopolar toroid)\b/i, 745),
  rule("Generator", /\b(?:generator set|diesel generator|gas generator|standby generator|backup generator|\bgenerator\b)\b/i, 743),
  rule("Motor", /\b(?:servo motor|stepper motor|asynchronous motor|synchronous motor|three[-\s]?phase motor|ac motor|dc motor|induction motor|gear motor|gearmotor|\bmotor\b)\b/i, 740),
  rule("Battery", /\b(?:battery pack|lithium battery|lead[-\s]?acid battery|\bnimh battery\b|\bnicd battery\b|energy storage module|traction battery|\bbattery\b)\b/i, 720),

  // --- Enclosures & mounting ---
  rule("Loadcenter", /\b(?:loadcenter|load center|panelboard|distribution board|consumer unit|switchgear assembly)\b/i, 770),
  rule(
    "Rack Cabinet",
    /\b(?:server rack|network rack|\brack cabinet\b|(?:communication\s+and\s+server|server|network)\s+cabinet|cabinet\b(?=[\s\S]{0,180}\b(?:servers?|network|rack[-\s]?mount|rack\s+(?:unit|spacing|angle)s?|\d+\s*u\b))|(?:rack[-\s]?mount|rack\s+(?:unit|spacing)s?|\d+\s*u\b)[\s\S]{0,180}\bcabinet\b)\b/i,
    765
  ),
  rule("Wireway", /\b(?:wireway|wire duct|cable duct|cable tray|cable channel|cable trunking)\b/i, 760),
  rule("Subpanel", /\b(?:subpanel|sub-panel|back[-\s]?panel|mounting panel|mounting plate)\b/i, 755),
  rule("Module Carrier", /\b(?:module carrier|carrier frame|backplane|module rack|subrack)\b/i, 753),
  rule("Enclosure", /\b(?:enc(?:losure)?\.?|wall[-\s]?mount(?:ed)? enclosure|floor[-\s]?stand(?:ing)? enclosure|junction box|control box|terminal box|\bcabinet\b)\b/i, 750),

  // --- Wiring & connectors ---
  rule("Terminal Accessory", /\b(?:terminal accessory|end bracket|end[-\s]?stop|end[-\s]?clamp|end[-\s]?plate|partition plate|terminal end\b|terminal cover|terminal\s+(?:end\s+)?bracket|separator plate|end section)\b/i, 770),
  rule("PCB Terminal Block", /\b(?:pcb terminal block|board[-\s]?mount terminal|printed[-\s]?circuit terminal|pluggable pcb terminal|pcb screw terminal)\b/i, 765),
  rule("PCB Connector", /\b(?:pin header|board[-\s]?to[-\s]?board connector|pcb connector|pcb header|board[-\s]?mount connector|edge connector|smt connector|socket strip|pcb plug|wire[-\s]?to[-\s]?board connector)\b/i, 760),
  rule("Wire Marker", /\b(?:wire marker|cable marker|wire label|cable label|cable tag|wire ferrule|terminal marker|terminal label|marking tag|marker card)\b/i, 750),
  rule("Terminal Block", /\b(?:terminal block|power terminal|terminal strip|pluggable terminal|push[-\s]?in terminal|spring[-\s]?clamp terminal|screw terminal block)\b/i, 740),
  rule("Cable Gland", /\b(?:cable gland|\bgland\b|cord grip)\b/i, 735),
  rule("Optical Connector", /\b(?:optical connector|fiber[-\s]?optic connector|fibre[-\s]?optic connector|fiber optics?|fibre optics?|glass fibers?|plastic fibers?|\blc connector\b|\bsc connector\b|\bst connector\b|\bmpo connector\b|fc connector)\b/i, 732),
  rule("Connector", /\b(?:industrial connector|circular connector|m\d+ connector|connector\b|plug-?in\s+(?:plug|socket)|cordset|patch cord|programming port|port,\s*programming)\b/i, 720),
  rule("Cable", /\b(?:cable assembly|control cable|power cable|signal cable|servo cable|motor cable|lead wire|patch cable|\bcable\b|\bcord\b)\b/i, 710),
  rule("Busbar", /\b(?:busbars?|bus[-\s]?bars?|busway|busbar system)\b/i, 720),

  // --- Signaling ---
  rule("Stack Light / Beacon", /\b(?:stack light|signal tower|signal beacon|\bbeacon\b|warning light|horn|buzzer|sounder)\b/i, 760),
  rule("Pushbutton / Operator", /\b(?:pushbutton|push[-\s]?button|emergency stop|e[-\s]?stop|selector head|pilot device|control station)\b/i, 755),
  rule("Pilot Light", /\b(?:pilot light|indicator light|signal lamp|indicator lamp|led indicator)\b/i, 750),
  rule("Luminaire", /\b(?:machine light|led light fixture|fixture,\s*led light|light fixture|luminaire|interior lamp|cabinet light)\b/i, 745),

  // --- Cooling / climate ---
  rule("Thermal Management", /\b(?:thermal management|filter fan|fan package|fan housing|filter kit|fan filter|exhaust filter|filter grille|enclosure fan|cabinet fan|cabinet heater|enclosure heater|thermostat|hygrostat|air conditioner|conditioner,\s*(?:ng\s+)?air|heat exchanger|dehumidifier|cooling unit|chiller)\b/i, 760),
  rule("Filter", /\b(?:line filter|emc filter|emi filter|mains filter|harmonic filter|sine filter|du\/dt filter|output filter|input filter|\bfilter\b)\b/i, 740),

  // --- Pneumatic / fluid (rare but available in template) ---
  rule("Hydraulic Actuator", /\b(?:hydraulic cylinder|hydraulic actuator|hydraulic ram|hydraulic power unit|hydraulic pump unit|hydraulic unit)\b/i, 738),
  rule("Pump", /\b(?:centrifugal pump|gear pump|piston pump|hydraulic pump|metering pump|vacuum pump|\bpump\b)\b/i, 730),
  rule("Directional Control Valve", /\b(?:directional control valve|\b\d\/\d-?way valve\b|solenoid valve|pneumatic valve|spool valve)\b/i, 728),
  rule("Valve", /\b(?:ball valve|check valve|gate valve|globe valve|butterfly valve|relief valve|pressure (?:relief|reducing|regulator) valve|differential pressure regulators?|diff\.?\s*press\.?\s*regulators?|pressure regulators?|needle valve|safety valve|shut[-\s]?off valve|non[-\s]?return valve|stop valve|\bvalve\b)\b/i, 724),
  rule("Pneumatic Device", /\b(?:pneumatic device|pneumatic cylinder|air cylinder|pneumatic actuator|pneumatic gripper|fitting,\s*pneumatic|pneumatic fitting)\b/i, 720),

  // --- Lower-specificity catch-alls (priority < 700 so they only win when nothing else matches) ---
  rule("Lock / Interlock", /\b(?:padlock|key[-\s]?lock|interlock|locking device|key switch)\b/i, 620),
  rule("Mounting Accessory", /\b(?:mounting accessory|mounting kit|mounting bracket|mounting foot|mounting plate|adapter plate|anti[-\s]?slip plate|level(?:ing|ling) feet?|pivot feet?|bell feet?|din rail|\brail\b|\bbracket\b)\b/i, 610),
  rule("Cover / Door Accessory", /\b(?:cover|door|hinge|latch|handle|gasket|window kit)\b/i, 600),
  rule("Accessory", /\b(?:accessory|spare part|replacement part|cleaner|\bkit\b)\b/i, 560)
];

interface DeviceTypeMatch {
  type: string;
  candidate: DeviceTypeCandidate;
  score: number;
  definitionPriority: number;
}

interface DeviceTypeSignal {
  type: string;
  /** Channel-specific score (text, family, url, …). */
  score: number;
  /** Logical channel — used for diagnostics and to require multi-channel agreement. */
  channel: "text" | "family" | "url" | "eclass" | "etim" | "unspsc";
  /** Short human-readable explanation of where this vote came from. */
  evidence: string;
}

interface AggregatedType {
  type: string;
  score: number;
  channels: Set<string>;
  /** Best evidence string seen for this type, used in the audit. */
  evidence: string;
}

/**
 * Score weights per channel. Channels with reliable, manufacturer-controlled vocabularies
 * (family / URL path) carry as much weight as the strongest text-attribute match. Text matches
 * still dominate by sheer breadth (multiple rules × multiple sources), but a strong family or
 * URL hit can stop a marginal text false-positive from winning.
 */
const CHANNEL_WEIGHTS = { text: 1.0, family: 1.2, url: 1.0, eclass: 1.25, etim: 1.1, unspsc: 0.95 } as const;
/** Score added to the winner per additional channel that agreed with it. */
const MULTI_CHANNEL_BONUS = 250;

const RACK_CABINET_COMBINED_PATTERN =
  /\b(?:server rack|network rack|rack cabinet|(?:communication\s+and\s+server|server|network)\s+cabinet|cabinet\b(?=[\s\S]{0,260}\b(?:servers?|network|rack[-\s]?mount|rack\s+(?:unit|spacing|angle)s?|\d+\s*u\b))|(?:rack[-\s]?mount|rack\s+(?:unit|spacing)s?|\d+\s*u\b)[\s\S]{0,260}\bcabinet\b)\b/i;
const BUSBAR_TYPE_NAME_PATTERN =
  /(?:^|\b)(?:busbars?\s+(?:supply|system|adapter|support|holder|terminal|connector|distribution)|(?:supply|system|adapter|support|holder|terminal|connector|distribution)\s+busbars?|busbars?)(?:\b|$)/i;

interface EclassTypeEntry {
  code: string;
  type: string;
  match: "exact" | "prefix";
  notes?: string;
}

const ECLASS_TYPE_ENTRIES: EclassTypeEntry[] = [
  { code: "27371003", type: "Contactor", match: "exact", notes: "Contactor" },
  { code: "27371307", type: "Lock / Interlock", match: "exact", notes: "Padlock barrier / locking accessory" },
  { code: "27371392", type: "Accessory", match: "exact", notes: "Switching-device accessory / spare part" },
  { code: "27142390", type: "Lock / Interlock", match: "exact", notes: "Locking or padlock accessory" },
  { code: "27242201", type: "Communication Gateway", match: "exact", notes: "PLC communication processor / gateway" },
  { code: "27242202", type: "Programmable Logic Controller", match: "exact", notes: "Programmable logic controller" },
  { code: "27242604", type: "I/O Module", match: "exact", notes: "PLC input/output module" },
  { code: "272709", type: "Photoelectric Sensor", match: "prefix", notes: "Optical/photoelectric sensors" },
  { code: "27270702", type: "Encoder", match: "exact", notes: "Linear position sensor" },
  { code: "27274304", type: "Encoder", match: "exact", notes: "Linear encoder" },
  { code: "27271101", type: "Sensor", match: "exact", notes: "Inclination sensor" },
  { code: "27274201", type: "Sensor", match: "exact", notes: "Generic sensor class" },
  { code: "27272603", type: "Safety Sensor", match: "exact", notes: "Safety switch/interlock" },
  { code: "27110350", type: "Luminaire", match: "exact", notes: "Machine light/luminaire" },
  { code: "27280402", type: "RFID Device", match: "exact", notes: "RFID read/write head or antenna" },
  { code: "272706", type: "Sensor", match: "prefix", notes: "Limit/position switch" },
  { code: "27060311", type: "Cable", match: "exact", notes: "Cordset/cable assembly" },
  { code: "27281101", type: "Wire Marker", match: "exact", notes: "Terminal or wire marker" },
  { code: "27460101", type: "PCB Terminal Block", match: "exact", notes: "PCB terminal block" },
  { code: "27460201", type: "PCB Connector", match: "exact", notes: "PCB connector / PCB header" },
  { code: "27440114", type: "Optical Connector", match: "exact", notes: "Passive fiber optic" },
  { code: "27440102", type: "Connector", match: "exact", notes: "Field attachable connector" }
];

interface EtimTypeEntry {
  code: string;
  type: string;
  notes?: string;
}

const ETIM_TYPE_ENTRIES: EtimTypeEntry[] = [
  { code: "EC000030", type: "Sensor", notes: "Mechanical position / limit switch" },
  { code: "EC000232", type: "Luminaire", notes: "Machine light / smart light" },
  { code: "EC001825", type: "Photoelectric Sensor", notes: "Photoelectric distance sensor" },
  { code: "EC001829", type: "Sensor", notes: "Mechanical position / limit switch" },
  { code: "EC001852", type: "Sensor", notes: "Inclination sensor" },
  { code: "EC002544", type: "Encoder", notes: "Linear position measuring system" },
  { code: "EC002593", type: "Safety Sensor", notes: "Safety switch / interlock" },
  { code: "EC000761", type: "Wire Marker", notes: "Terminal or wire marker" },
  { code: "EC002637", type: "PCB Connector", notes: "PCB connector / PCB header" },
  { code: "EC002643", type: "PCB Terminal Block", notes: "PCB terminal block" },
  { code: "EC002716", type: "Photoelectric Sensor", notes: "Photoelectric sensor" },
  { code: "EC002998", type: "RFID Device", notes: "RFID read/write head or antenna" },
  { code: "EC002051", type: "Lock / Interlock", notes: "Padlock barrier for switch" },
  { code: "EC002498", type: "Accessory", notes: "Low-voltage switchgear accessory / spare part" }
];

interface UnspscTypeEntry {
  code: string;
  type: string;
  notes?: string;
}

const UNSPSC_TYPE_ENTRIES: UnspscTypeEntry[] = [
  { code: "26121604", type: "Cable", notes: "Cable / cordset" },
  { code: "39100000", type: "Luminaire", notes: "Lighting products" },
  { code: "39121413", type: "Connector", notes: "Electrical connector / field attachable" },
  { code: "39121528", type: "Photoelectric Sensor", notes: "Photoelectric sensor" },
  { code: "39122205", type: "Safety Sensor", notes: "Safety switch / interlock" },
  { code: "46171501", type: "Lock / Interlock", notes: "Padlock" },
  { code: "41111938", type: "Sensor", notes: "Inclination sensor" },
  { code: "41111945", type: "Encoder", notes: "Linear encoder / position measuring" }
];

export function classifyDeviceType(result: ProductResult | undefined): DeviceTypeClassification {
  if (!result) return {};

  const signals: DeviceTypeSignal[] = [];

  // --- Channel 1: text rules (title, attributes, description) ---
  const candidates = deviceTypeCandidates(result);
  const textMatches: DeviceTypeMatch[] = candidates.flatMap((candidate) =>
    DEVICE_TYPE_RULES.filter((definition) => definition.pattern.test(candidate.text)).map((definition) => ({
      type: definition.type,
      candidate,
      score: candidate.priority + definition.priority + sourceTypeScore(candidate.sourceType),
      definitionPriority: definition.priority
    }))
  );
  // Within the text channel, group by type and keep the best evidence per type. Specificity wins
  // over generic rules (e.g. "Inductive Proximity Sensor" beats "Sensor") within this channel.
  if (textMatches.length > 0) {
    const byType = new Map<string, DeviceTypeMatch>();
    for (const match of textMatches) {
      const current = byType.get(match.type);
      if (!current || match.score > current.score) byType.set(match.type, match);
    }
    const ranked = [...byType.values()].sort((left, right) => {
      const specificityDelta = right.definitionPriority - left.definitionPriority;
      if (specificityDelta !== 0) return specificityDelta;
      return right.score - left.score;
    });
    // Emit ALL ranked types as signals — aggregating across channels will pick the winner.
    for (const match of ranked) {
      signals.push({
        type: match.type,
        score: match.score * CHANNEL_WEIGHTS.text,
        channel: "text",
        evidence: `${match.candidate.label}: ${match.candidate.value}`
      });
    }
  }

  const combinedRackCabinetText = combinedDeviceTypeText(result);
  if (RACK_CABINET_COMBINED_PATTERN.test(combinedRackCabinetText)) {
    signals.push({
      type: "Rack Cabinet",
      score: 1475 * CHANNEL_WEIGHTS.text,
      channel: "text",
      evidence: "Combined product text: cabinet with rack/server evidence"
    });
  }

  const busbarTypeNameText = combinedBusbarTypeNameText(result);
  if (BUSBAR_TYPE_NAME_PATTERN.test(busbarTypeNameText)) {
    signals.push({
      type: "Busbar",
      score: 1800 * CHANNEL_WEIGHTS.text,
      channel: "text",
      evidence: "Product type/name text: busbar"
    });
  }

  // --- Channel 2: family / series prefix (manufacturer-specific catalog patterns) ---
  const familyMatch = familyTypeFor(result.manufacturerId, [
    result.catalogNumber,
    result.title,
    typeCodeAttribute(result),
    productFamilyAttribute(result)
  ]);
  if (familyMatch) {
    signals.push({
      type: familyMatch.type,
      // Family signals are anchored at a high score so they consistently outrank a single weak
      // text candidate but still lose to multi-source text agreement.
      score: 1400 * CHANNEL_WEIGHTS.family,
      channel: "family",
      evidence: `Family ${familyMatch.pattern}${familyMatch.notes ? ` (${familyMatch.notes})` : ""}`
    });
  }

  // --- Channel 3: URL path patterns ---
  const productUrl = result.productUrl ?? result.localizedUrls?.en;
  const urlMatch = urlTypeFor(productUrl);
  if (urlMatch) {
    signals.push({
      type: urlMatch.type,
      score: 1300 * CHANNEL_WEIGHTS.url,
      channel: "url",
      evidence: urlMatch.evidence
    });
  }

  // --- Channel 4: ECLASS class code ---
  const eclassMatch = eclassTypeFor(result);
  if (eclassMatch) {
    signals.push({
      type: eclassMatch.type,
      score: (eclassMatch.match === "exact" ? 1450 : 1375) * CHANNEL_WEIGHTS.eclass,
      channel: "eclass",
      evidence: `ECLASS ${eclassMatch.code}${eclassMatch.notes ? ` (${eclassMatch.notes})` : ""}`
    });
  }

  // --- Channel 5: ETIM class code ---
  const etimMatch = etimTypeFor(result);
  if (etimMatch) {
    signals.push({
      type: etimMatch.type,
      score: 1275 * CHANNEL_WEIGHTS.etim,
      channel: "etim",
      evidence: `ETIM ${etimMatch.code}${etimMatch.notes ? ` (${etimMatch.notes})` : ""}`
    });
  }

  // --- Channel 6: UNSPSC commodity code ---
  const unspscMatch = unspscTypeFor(result);
  if (unspscMatch) {
    signals.push({
      type: unspscMatch.type,
      score: 1225 * CHANNEL_WEIGHTS.unspsc,
      channel: "unspsc",
      evidence: `UNSPSC ${unspscMatch.code}${unspscMatch.notes ? ` (${unspscMatch.notes})` : ""}`
    });
  }

  if (signals.length === 0) return {};

  // --- Aggregate across channels ---
  const byType = new Map<string, AggregatedType>();
  for (const signal of signals) {
    const current = byType.get(signal.type);
    if (current) {
      current.score += signal.score;
      current.channels.add(signal.channel);
      // Keep the highest-scoring evidence string for display.
      if (signal.score > 0 && current.evidence.length < signal.evidence.length) {
        current.evidence = signal.evidence;
      }
    } else {
      byType.set(signal.type, {
        type: signal.type,
        score: signal.score,
        channels: new Set([signal.channel]),
        evidence: signal.evidence
      });
    }
  }
  // Multi-channel agreement bonus — once per extra agreeing channel.
  for (const entry of byType.values()) {
    if (entry.channels.size > 1) entry.score += MULTI_CHANNEL_BONUS * (entry.channels.size - 1);
  }

  let ranked = [...byType.values()].sort((left, right) => right.score - left.score);
  if (shouldPreferSpecificTextTypeOverBroadAccessory(ranked[0], ranked[1])) {
    ranked = [ranked[1], ranked[0], ...ranked.slice(2)];
  }
  const best = ranked[0];
  const runnerUp = ranked[1];
  const margin = runnerUp ? best.score - runnerUp.score : best.score;
  const warnings = sanityWarnings(best.type, result);

  // Map score → confidence. Multi-channel agreement and a clean win over the runner-up boost
  // confidence; sanity warnings drag it back down.
  let confidence = deviceTypeConfidence(best.score);
  if (best.channels.size >= 2) confidence = Math.min(0.99, confidence + 0.05);
  if (runnerUp && margin < 200) confidence = Math.max(0.5, confidence - 0.12);
  if (warnings.length > 0) confidence = Math.max(0.5, confidence - 0.08 * warnings.length);

  const alternatives = ranked.slice(1, 3).map((entry) => ({
    type: entry.type,
    score: Math.round(entry.score),
    channels: [...entry.channels]
  }));

  return {
    type: best.type,
    confidence: Number(confidence.toFixed(2)),
    evidence: best.evidence,
    alternatives: alternatives.length > 0 ? alternatives : undefined,
    scoreMargin: Math.round(margin),
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

/** Pull the manufacturer's type code (a.k.a. extended product type) from product attributes. */
function typeCodeAttribute(result: ProductResult): string | undefined {
  const match = (result.attributes ?? []).find((a) =>
    /\b(type code|typecode|extended product type|type designation|product main type|main type|catalog(?:ue)? type|order type|model code|modellcode)\b/i.test(
      a.name ?? ""
    )
  );
  return match?.value;
}

/** Pull a product family / series attribute (used as a hint for the family table). */
function productFamilyAttribute(result: ProductResult): string | undefined {
  const match = (result.attributes ?? []).find((a) =>
    /\b(product family|product range|series|family)\b/i.test(`${a.group ?? ""} ${a.name ?? ""}`)
  );
  return match?.value;
}

/**
 * Per-device-type sanity checks that compare the chosen type against the scraped attributes.
 * Each function returns one warning string when the device looks suspicious for that type.
 */
function sanityWarnings(type: string, result: ProductResult): string[] {
  const attrs = result.attributes ?? [];
  const hasAttr = (regex: RegExp): boolean =>
    attrs.some((a) => regex.test(`${a.group ?? ""} ${a.name ?? ""}`) && a.value?.trim());
  const warnings: string[] = [];
  switch (type) {
    case "Contactor":
      if (!hasAttr(/\b(pole|number of poles)\b/i) && !hasAttr(/\b(rated operational current|AC-1|AC-3|coil voltage|control circuit voltage)\b/i)) {
        warnings.push("No contactor signature attributes (poles / AC current / coil voltage) found.");
      }
      break;
    case "Motor":
      if (!hasAttr(/\b(rated power|frame size|speed|rpm|stator|rotor)\b/i) && !hasAttr(/\b(kW|HP)\b/)) {
        warnings.push("No motor signature attributes (rated power / RPM / frame size) found.");
      }
      break;
    case "Variable Speed Drive":
    case "Soft Starter":
      if (!hasAttr(/\b(output power|rated power|motor power)\b/i) && !hasAttr(/\b(kW|HP)\b/)) {
        warnings.push(`No ${type} signature attributes (motor power) found.`);
      }
      break;
    case "Cable":
      if (hasAttr(/\b(pole number|number of poles)\b/i) && hasAttr(/\b(AC-3|rated operational power)\b/i)) {
        warnings.push("Classified as Cable but has switching-device signature attributes — verify.");
      }
      break;
    case "Photoelectric Sensor":
    case "Inductive Proximity Sensor":
    case "Capacitive Sensor":
    case "Ultrasonic Sensor":
    case "Magnetic Field Sensor":
    case "Vision Sensor":
    case "Sensor":
      if (!hasAttr(/\b(sensing|operating distance|switching distance|range|output type|pnp|npn)\b/i)) {
        warnings.push("No sensor signature attributes (sensing distance / output) found.");
      }
      break;
    case "Power Supply":
    case "UPS":
      if (!hasAttr(/\b(output voltage|output current|output power|nominal voltage)\b/i)) {
        warnings.push(`No ${type} signature attributes (output voltage / current) found.`);
      }
      break;
    case "Enclosure":
    case "Rack Cabinet":
    case "Subpanel":
      if (!hasAttr(/\b(width|height|depth|dimensions|material|degree of protection|ip[\s-]?\d{2})\b/i)) {
        warnings.push("No enclosure signature attributes (dimensions / IP / material) found.");
      }
      break;
    case "Programmable Logic Controller":
    case "I/O Module":
      if (!hasAttr(/\b(input|output|module|i\/o|cpu|memory)\b/i)) {
        warnings.push(`No ${type} signature attributes (I/O / CPU / memory) found.`);
      }
      break;
    default:
      break;
  }
  return warnings;
}

function rule(type: string, pattern: RegExp, priority: number): DeviceTypeRule {
  return { type, pattern, priority };
}

function shouldPreferSpecificTextTypeOverBroadAccessory(best: AggregatedType | undefined, runnerUp: AggregatedType | undefined): boolean {
  if (!best || !runnerUp) return false;
  if (best.type !== "Accessory" || runnerUp.type === "Accessory") return false;
  if (!runnerUp.channels.has("text")) return false;
  return best.score - runnerUp.score <= 650;
}

export function knownDeviceTypes(): string[] {
  return [...new Set(DEVICE_TYPE_RULES.map((entry) => entry.type))];
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

function combinedDeviceTypeText(result: ProductResult): string {
  const attributeText = (result.attributes ?? [])
    .filter((attr) => attributeDeviceTypePriority(attr) || isRackCabinetSignalAttribute(attr))
    .slice(0, 80)
    .map((attr) => `${attr.group ?? ""} ${attr.name} ${attr.value}`)
    .join(" ");
  return cleanText([result.title, result.description, attributeText].filter(Boolean).join(" "));
}

function combinedBusbarTypeNameText(result: ProductResult): string {
  const attributeText = (result.attributes ?? [])
    .filter(isBusbarTypeNameAttribute)
    .slice(0, 30)
    .map((attr) => `${attr.group ?? ""} ${attr.name} ${attr.value}`)
    .join(" ");
  return cleanText([result.title, result.description, attributeText].filter(Boolean).join(" "));
}

function isBusbarTypeNameAttribute(attr: AttributeRecord): boolean {
  const label = `${attr.group ?? ""} ${attr.name}`;
  if (/\b(?:max(?:imum)?|minimum|min\.?|width|height|depth|thickness|dimension|suitable for|used with)\b/i.test(label)) return false;
  return /\b(?:product or component type|product main type|product type|product name|item name|display name|catalog description|long description|short description|description|extended product type|product family|product group|product category|classification path)\b/i.test(
    label
  );
}

function isRackCabinetSignalAttribute(attr: AttributeRecord): boolean {
  return /\b(?:cabinet|server|network|rack[-\s]?(?:mount|unit|spacing|angle)s?|\b\d+\s*u\b)\b/i.test(
    `${attr.group ?? ""} ${attr.name} ${attr.value}`
  );
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

function eclassTypeFor(result: ProductResult): (EclassTypeEntry & { code: string }) | undefined {
  const matches = (result.attributes ?? [])
    .filter((attribute) => /^(?:eclass|ecl@ss)\b/i.test(attribute.name.trim()) && attribute.value?.trim())
    .map((attribute) => ({
      code: normalizeEclassCode(attribute.value),
      rank: sourceRankForEclass(attribute.sourceType) + eclassVersion(attribute.name)
    }))
    .filter((entry): entry is { code: string; rank: number } => Boolean(entry.code));
  matches.sort((left, right) => right.rank - left.rank);
  for (const match of matches) {
    const entry = ECLASS_TYPE_ENTRIES.find((candidate) =>
      candidate.match === "exact" ? match.code === candidate.code : match.code.startsWith(candidate.code)
    );
    if (entry) return { ...entry, code: formatEclassCode(match.code) };
  }
  return undefined;
}

function normalizeEclassCode(value: string | undefined): string | undefined {
  const raw = value?.match(/\d{2}(?:[-.]?\d{2}){1,3}|\d{6,8}/)?.[0];
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 6 ? digits : undefined;
}

function formatEclassCode(value: string): string {
  return value.length === 8 ? value.replace(/(\d{2})(\d{2})(\d{2})(\d{2})/, "$1-$2-$3-$4") : value;
}

function eclassVersion(name: string): number {
  return Number(name.match(/\d+(?:\.\d+)?/)?.[0] ?? 0) / 100;
}

function sourceRankForEclass(sourceType: SourceRecord["sourceType"] | undefined): number {
  if (sourceType === "official") return 3;
  if (sourceType === "official-fallback") return 2;
  if (sourceType === "cache") return 1;
  if (sourceType === "distributor") return -1;
  return 0;
}

function etimTypeFor(result: ProductResult): EtimTypeEntry | undefined {
  const matches = (result.attributes ?? [])
    .filter((attribute) => /^(?:etim)\b/i.test(attribute.name.trim()) && attribute.value?.trim())
    .map((attribute) => ({
      code: normalizeEtimCode(attribute.value),
      rank: sourceRankForEclass(attribute.sourceType) + eclassVersion(attribute.name)
    }))
    .filter((entry): entry is { code: string; rank: number } => Boolean(entry.code));
  matches.sort((left, right) => right.rank - left.rank);
  for (const match of matches) {
    const entry = ETIM_TYPE_ENTRIES.find((candidate) => match.code === candidate.code);
    if (entry) return entry;
  }
  return undefined;
}

function normalizeEtimCode(value: string | undefined): string | undefined {
  return value?.match(/\bEC\d{6}\b/i)?.[0]?.toUpperCase();
}

function unspscTypeFor(result: ProductResult): UnspscTypeEntry | undefined {
  const matches = (result.attributes ?? [])
    .filter((attribute) => /^(?:unspsc)\b/i.test(attribute.name.trim()) && attribute.value?.trim())
    .map((attribute) => ({
      code: normalizeUnspscCode(attribute.value),
      rank: sourceRankForEclass(attribute.sourceType) + eclassVersion(attribute.name)
    }))
    .filter((entry): entry is { code: string; rank: number } => Boolean(entry.code));
  matches.sort((left, right) => right.rank - left.rank);
  for (const match of matches) {
    const entry = UNSPSC_TYPE_ENTRIES.find((candidate) => match.code === candidate.code);
    if (entry) return entry;
  }
  return undefined;
}

function normalizeUnspscCode(value: string | undefined): string | undefined {
  return value?.match(/\b\d{8}\b/)?.[0];
}

function deviceTypeConfidence(score: number): number {
  if (score >= 1500) return 0.98;
  if (score >= 1420) return 0.94;
  if (score >= 1320) return 0.88;
  if (score >= 1200) return 0.78;
  return 0.68;
}
