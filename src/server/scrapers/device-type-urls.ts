/**
 * Map URL path segments to device types. Manufacturers organise their catalog websites by
 * category, so a URL like https://new.abb.com/products/contactors/AF40B is a near-certain
 * signal that the product is a contactor — even when the title text is ambiguous.
 *
 * Each entry has:
 * - `host`     — optional hostname regex (matched against `URL.hostname`). When omitted the
 *                pattern applies to any host.
 * - `pattern`  — case-insensitive regex run against the URL's lowercased pathname.
 * - `type`     — device type label (must match a classifier rule label).
 *
 * Ordering matters: more specific entries (longer URL path) should appear before broader ones.
 */
export interface UrlPatternEntry {
  host?: RegExp;
  pattern: RegExp;
  type: string;
}

export const DEVICE_TYPE_URL_PATTERNS: UrlPatternEntry[] = [
  // --- ABB ---
  { host: /abb\.com$/i, pattern: /\/contactors?\//i, type: "Contactor" },
  { host: /abb\.com$/i, pattern: /\/motor[-\s]?protection|\/manual[-\s]?motor[-\s]?starter/i, type: "Motor Circuit Breaker" },
  { host: /abb\.com$/i, pattern: /\/(miniature[-\s]?circuit[-\s]?breaker|mcb)\b/i, type: "Miniature Circuit Breaker" },
  { host: /abb\.com$/i, pattern: /\/(molded[-\s]?case|moulded[-\s]?case|mccb)\b/i, type: "Molded Case Circuit Breaker" },
  { host: /abb\.com$/i, pattern: /\/(residual[-\s]?current|rcd|rcbo)\b/i, type: "Residual Current Device" },
  { host: /abb\.com$/i, pattern: /\/(disconnect|switch[-\s]?disconnector|isolator)\b/i, type: "Disconnect Switch" },
  { host: /abb\.com$/i, pattern: /\/(soft[-\s]?starter)\b/i, type: "Soft Starter" },
  { host: /abb\.com$/i, pattern: /\/(drive|inverter|vfd|acs[a-z]?\d)\b/i, type: "Variable Speed Drive" },
  { host: /abb\.com$/i, pattern: /\/(power[-\s]?supply|psu)\b/i, type: "Power Supply" },
  { host: /abb\.com$/i, pattern: /\/(motor)s?\b/i, type: "Motor" },
  { host: /abb\.com$/i, pattern: /\/(surge[-\s]?protection|spd|lightning)\b/i, type: "Surge Protective Device" },
  { host: /abb\.com$/i, pattern: /\/(fuse)\b/i, type: "Fuse" },

  // --- Schneider Electric ---
  { host: /schneider-electric\.|se\.com$/i, pattern: /\/contactor/i, type: "Contactor" },
  { host: /schneider-electric\.|se\.com$/i, pattern: /\/(circuit-breaker|breaker)\//i, type: "Circuit Breaker" },
  { host: /schneider-electric\.|se\.com$/i, pattern: /\/altivar|\/drive|\/variable-speed/i, type: "Variable Speed Drive" },
  { host: /schneider-electric\.|se\.com$/i, pattern: /\/altistart|\/soft-starter/i, type: "Soft Starter" },
  { host: /schneider-electric\.|se\.com$/i, pattern: /\/modicon|\/programmable-controller|\/plc\b/i, type: "Programmable Logic Controller" },
  { host: /schneider-electric\.|se\.com$/i, pattern: /\/harmony|\/pushbutton|\/operator/i, type: "Pushbutton / Operator" },
  { host: /schneider-electric\.|se\.com$/i, pattern: /\/osisense|\/photoelectric/i, type: "Photoelectric Sensor" },
  { host: /schneider-electric\.|se\.com$/i, pattern: /\/proximity|\/inductive/i, type: "Inductive Proximity Sensor" },
  { host: /schneider-electric\.|se\.com$/i, pattern: /\/transformer/i, type: "Transformer" },
  { host: /schneider-electric\.|se\.com$/i, pattern: /\/disconnect|\/isolator/i, type: "Disconnect Switch" },

  // --- Eaton ---
  { host: /eaton\.com$/i, pattern: /\/contactor/i, type: "Contactor" },
  { host: /eaton\.com$/i, pattern: /\/circuit-breaker|\/breaker/i, type: "Circuit Breaker" },
  { host: /eaton\.com$/i, pattern: /\/(motor-protector|manual-motor-starter|pkz)/i, type: "Motor Circuit Breaker" },
  { host: /eaton\.com$/i, pattern: /\/(soft-starter)/i, type: "Soft Starter" },
  { host: /eaton\.com$/i, pattern: /\/(drive|powerxl|vfd)/i, type: "Variable Speed Drive" },
  { host: /eaton\.com$/i, pattern: /\/(disconnect|safety-switch|safety[-\s]?disconnect)/i, type: "Disconnect Switch" },
  { host: /eaton\.com$/i, pattern: /\/(pushbutton|m22|operator-station)/i, type: "Pushbutton / Operator" },
  { host: /eaton\.com$/i, pattern: /\/(loadcenter|panelboard)/i, type: "Loadcenter" },
  { host: /eaton\.com$/i, pattern: /\/(ups|uninterruptible-power)/i, type: "UPS" },
  { host: /eaton\.com$/i, pattern: /\/(cable[-\s]?gland|gland)/i, type: "Cable Gland" },

  // --- Siemens ---
  { host: /siemens\.com$/i, pattern: /\/contactor|\/3rt/i, type: "Contactor" },
  { host: /siemens\.com$/i, pattern: /\/(circuit-breaker|3rv|3va|mccb|mcb)/i, type: "Circuit Breaker" },
  { host: /siemens\.com$/i, pattern: /\/(soft-starter|3rw)/i, type: "Soft Starter" },
  { host: /siemens\.com$/i, pattern: /\/(sinamics|drive|inverter)/i, type: "Variable Speed Drive" },
  { host: /siemens\.com$/i, pattern: /\/(sitop|power-supply)/i, type: "Power Supply" },
  { host: /siemens\.com$/i, pattern: /\/(simatic|s7-)/i, type: "Programmable Logic Controller" },

  // --- Balluff ---
  { host: /balluff\.com$/i, pattern: /\/(photoelectric|through-?beam|retroreflective|diffuse)/i, type: "Photoelectric Sensor" },
  { host: /balluff\.com$/i, pattern: /\/(inductive|proximity)/i, type: "Inductive Proximity Sensor" },
  { host: /balluff\.com$/i, pattern: /\/capacitive/i, type: "Capacitive Sensor" },
  { host: /balluff\.com$/i, pattern: /\/ultrasonic/i, type: "Ultrasonic Sensor" },
  { host: /balluff\.com$/i, pattern: /\/(vision|smartcamera)/i, type: "Vision Sensor" },
  { host: /balluff\.com$/i, pattern: /\/(io-link|distributed-systems)/i, type: "I/O Module" },
  { host: /balluff\.com$/i, pattern: /\/(magnetic|magnetostrictive)/i, type: "Magnetic Field Sensor" },
  { host: /balluff\.com$/i, pattern: /\/(encoder)/i, type: "Encoder" },

  // --- Phoenix Contact ---
  { host: /phoenixcontact\./i, pattern: /\/(power[-\s]?supplies|quint|trio|step|uno-ps)/i, type: "Power Supply" },
  { host: /phoenixcontact\./i, pattern: /\/(terminal[-\s]?blocks?)/i, type: "Terminal Block" },
  { host: /phoenixcontact\./i, pattern: /\/(surge[-\s]?protection|plugtrab|valvetrab|val-)/i, type: "Surge Protective Device" },
  { host: /phoenixcontact\./i, pattern: /\/(io-link|axiocontrol|inline)/i, type: "I/O Module" },
  { host: /phoenixcontact\./i, pattern: /\/(network[-\s]?technology|managed[-\s]?switch|gateway)/i, type: "Communication Gateway" },
  { host: /phoenixcontact\./i, pattern: /\/(safety[-\s]?(relay|controller)|psr)/i, type: "Safety Relay" },
  { host: /phoenixcontact\./i, pattern: /\/(connector|circular)/i, type: "Connector" },

  // --- Weidmüller ---
  { host: /weidmueller\.|weidmuller\./i, pattern: /\/(power[-\s]?supply)/i, type: "Power Supply" },
  { host: /weidmueller\.|weidmuller\./i, pattern: /\/(terminal[-\s]?block)/i, type: "Terminal Block" },
  { host: /weidmueller\.|weidmuller\./i, pattern: /\/(end[-\s]?bracket|end[-\s]?stop)/i, type: "Terminal Accessory" },

  // --- Rittal ---
  { host: /rittal\.com$/i, pattern: /\/(enclosure|cabinet|ts8|vx25|ae|kx|eb|bg)/i, type: "Enclosure" },
  { host: /rittal\.com$/i, pattern: /\/(rack|dk)/i, type: "Rack Cabinet" },
  { host: /rittal\.com$/i, pattern: /\/(climate|cooling|filter[-\s]?fan|heat[-\s]?exchanger|chiller)/i, type: "Thermal Management" },

  // --- Pilz ---
  { host: /pilz\.com$/i, pattern: /\/(pnoz|safety[-\s]?relay)/i, type: "Safety Relay" },
  { host: /pilz\.com$/i, pattern: /\/(psen|safety[-\s]?(sensor|switch|gate))/i, type: "Safety Sensor" },

  // --- SICK ---
  { host: /sick\.com$/i, pattern: /\/photoelectric/i, type: "Photoelectric Sensor" },
  { host: /sick\.com$/i, pattern: /\/inductive/i, type: "Inductive Proximity Sensor" },
  { host: /sick\.com$/i, pattern: /\/ultrasonic/i, type: "Ultrasonic Sensor" },
  { host: /sick\.com$/i, pattern: /\/(safety[-\s]?(light[-\s]?curtain|scanner)|detec|microscan)/i, type: "Safety Sensor" },
  { host: /sick\.com$/i, pattern: /\/encoder/i, type: "Encoder" },

  // --- ifm ---
  { host: /ifm\.com$/i, pattern: /\/(inductive)/i, type: "Inductive Proximity Sensor" },
  { host: /ifm\.com$/i, pattern: /\/(photoelectric|through-?beam)/i, type: "Photoelectric Sensor" },
  { host: /ifm\.com$/i, pattern: /\/(io-link)/i, type: "I/O Module" },
  { host: /ifm\.com$/i, pattern: /\/(pressure[-\s]?sensor)/i, type: "Pressure Sensor" },
  { host: /ifm\.com$/i, pattern: /\/(temperature[-\s]?sensor)/i, type: "Temperature Sensor" },

  // --- Host-neutral catch-alls (used when no manufacturer host pattern matches) ---
  { pattern: /\/contactors?\b/i, type: "Contactor" },
  { pattern: /\/(soft[-\s]?starter)\b/i, type: "Soft Starter" },
  { pattern: /\/(motor[-\s]?circuit[-\s]?breaker|manual[-\s]?motor[-\s]?starter|motor[-\s]?protection|motor[-\s]?protector)\b/i, type: "Motor Circuit Breaker" },
  { pattern: /\/(miniature[-\s]?circuit[-\s]?breaker|mcb)\b/i, type: "Miniature Circuit Breaker" },
  { pattern: /\/(molded[-\s]?case|moulded[-\s]?case|mccb)\b/i, type: "Molded Case Circuit Breaker" },
  { pattern: /\/(residual[-\s]?current|rcd|rcbo)\b/i, type: "Residual Current Device" },
  { pattern: /\/(circuit[-\s]?breaker|breakers?)\b/i, type: "Circuit Breaker" },
  { pattern: /\/(disconnect|switch[-\s]?disconnector|isolator)\b/i, type: "Disconnect Switch" },
  { pattern: /\/(drive|inverter|vfd|variable[-\s]?speed)\b/i, type: "Variable Speed Drive" },
  { pattern: /\/(power[-\s]?supply|psu)\b/i, type: "Power Supply" },
  { pattern: /\/(ups|uninterruptible[-\s]?power)\b/i, type: "UPS" },
  { pattern: /\/(transformer)\b/i, type: "Transformer" },
  { pattern: /\/(motors?)\b/i, type: "Motor" },
  { pattern: /\/(plc|programmable[-\s]?logic[-\s]?controller)\b/i, type: "Programmable Logic Controller" },
  { pattern: /\/(hmi|operator[-\s]?panel|touch[-\s]?panel)\b/i, type: "HMI" },
  { pattern: /\/(io[-\s]?module|i\/o[-\s]?module|io-link)\b/i, type: "I/O Module" },
  { pattern: /\/(safety[-\s]?relay|safety[-\s]?controller)\b/i, type: "Safety Relay" },
  { pattern: /\/(safety[-\s]?(sensor|light[-\s]?curtain|scanner|switch))\b/i, type: "Safety Sensor" },
  { pattern: /\/(photoelectric|through-?beam|retroreflective)\b/i, type: "Photoelectric Sensor" },
  { pattern: /\/(inductive[-\s]?proximity|proximity[-\s]?sensor)\b/i, type: "Inductive Proximity Sensor" },
  { pattern: /\/(capacitive[-\s]?sensor)\b/i, type: "Capacitive Sensor" },
  { pattern: /\/(ultrasonic[-\s]?sensor)\b/i, type: "Ultrasonic Sensor" },
  { pattern: /\/(magnetic[-\s]?field[-\s]?sensor)\b/i, type: "Magnetic Field Sensor" },
  { pattern: /\/(pressure[-\s]?sensor)\b/i, type: "Pressure Sensor" },
  { pattern: /\/(temperature[-\s]?sensor)\b/i, type: "Temperature Sensor" },
  { pattern: /\/(encoder)\b/i, type: "Encoder" },
  { pattern: /\/(vision[-\s]?sensor)\b/i, type: "Vision Sensor" },
  { pattern: /\/(rfid)\b/i, type: "RFID Device" },
  { pattern: /\/(luminaire|light[-\s]?fixture|machine[-\s]?light)\b/i, type: "Luminaire" },
  { pattern: /\/(surge[-\s]?protect|spd|lightning[-\s]?arrester)\b/i, type: "Surge Protective Device" },
  { pattern: /\/(fuse)\b/i, type: "Fuse" },
  { pattern: /\/(terminal[-\s]?block)\b/i, type: "Terminal Block" },
  { pattern: /\/(end[-\s]?bracket|end[-\s]?stop|end[-\s]?clamp)\b/i, type: "Terminal Accessory" },
  { pattern: /\/(cable[-\s]?gland)\b/i, type: "Cable Gland" },
  { pattern: /\/(busbar|bus[-\s]?bar)\b/i, type: "Busbar" },
  { pattern: /\/(cables?)\b/i, type: "Cable" },
  { pattern: /\/(connectors?)\b/i, type: "Connector" },
  { pattern: /\/(optical[-\s]?connector|fiber[-\s]?optic[-\s]?connector)\b/i, type: "Optical Connector" },
  { pattern: /\/(enclosures?|cabinets?|control[-\s]?box|junction[-\s]?box)\b/i, type: "Enclosure" },
  { pattern: /\/(rack|server[-\s]?rack)\b/i, type: "Rack Cabinet" },
  { pattern: /\/(wireway|wire[-\s]?duct|cable[-\s]?duct|cable[-\s]?tray)\b/i, type: "Wireway" },
  { pattern: /\/(loadcenter|load[-\s]?center|panelboard|distribution[-\s]?board)\b/i, type: "Loadcenter" },
  { pattern: /\/(filter[-\s]?fan|climate|air[-\s]?conditioner|heat[-\s]?exchanger)\b/i, type: "Thermal Management" },
  { pattern: /\/(emc[-\s]?filter|line[-\s]?filter|emi[-\s]?filter|mains[-\s]?filter|harmonic[-\s]?filter)\b/i, type: "Filter" },
  { pattern: /\/(pump)\b/i, type: "Pump" },
  { pattern: /\/(directional[-\s]?control[-\s]?valve|solenoid[-\s]?valve|spool[-\s]?valve)\b/i, type: "Directional Control Valve" },
  { pattern: /\/(valve)\b/i, type: "Valve" },
  { pattern: /\/(pneumatic[-\s]?(cylinder|actuator|gripper))\b/i, type: "Pneumatic Device" },
  { pattern: /\/(hydraulic[-\s]?(cylinder|actuator|power[-\s]?unit))\b/i, type: "Hydraulic Actuator" },
  { pattern: /\/(motor[-\s]?starter)\b/i, type: "Motor Starter" },
  { pattern: /\/(pushbutton|push[-\s]?button|operator[-\s]?station)\b/i, type: "Pushbutton / Operator" },
  { pattern: /\/(pilot[-\s]?light|indicator[-\s]?light|signal[-\s]?lamp)\b/i, type: "Pilot Light" },
  { pattern: /\/(stack[-\s]?light|signal[-\s]?tower|beacon)\b/i, type: "Stack Light / Beacon" }
];

/** Resolve a device type from a product URL, if a known pattern matches. */
export function urlTypeFor(productUrl: string | undefined): { type: string; evidence: string } | undefined {
  if (!productUrl) return undefined;
  let host = "";
  let pathname = "";
  try {
    const url = new URL(productUrl);
    host = url.hostname.toLowerCase();
    pathname = url.pathname.toLowerCase();
  } catch {
    // Not a valid URL; treat the whole string as a path-like hint.
    pathname = productUrl.toLowerCase();
  }
  // Try host-specific entries first; fall back to host-neutral ones.
  const hostSpecific = DEVICE_TYPE_URL_PATTERNS.filter((entry) => entry.host && entry.host.test(host));
  const hostNeutral = DEVICE_TYPE_URL_PATTERNS.filter((entry) => !entry.host);
  for (const entry of [...hostSpecific, ...hostNeutral]) {
    const match = pathname.match(entry.pattern);
    if (match) return { type: entry.type, evidence: `URL path "${match[0]}"` };
  }
  return undefined;
}
