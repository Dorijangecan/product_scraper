/**
 * Known manufacturer family / series prefixes that deterministically identify the device type.
 *
 * A family signal is the most reliable evidence we can get short of an authoritative ECLASS
 * lookup: when a catalog number starts with "AF" on an ABB product, it is a contactor, period.
 * These entries should always be sourced from the manufacturer's own taxonomy (catalog pages,
 * product family overviews) — never guessed.
 *
 * Match rule: the entry matches when the catalog number, type code, title, or product family
 * attribute *starts with* (or contains as a whole word) one of the prefixes for the given
 * manufacturer id. Manufacturer id is the canonical `ManufacturerConfig.id`.
 */
export interface FamilyEntry {
  /** Patterns that identify the family. Each is matched as a whole-word prefix on the candidate text. */
  patterns: readonly string[];
  /** Resulting device type — must match a known classifier rule label. */
  type: string;
  /** Optional human note shown in audit logs. */
  notes?: string;
}

export const DEVICE_TYPE_FAMILIES: Record<string, readonly FamilyEntry[]> = {
  abb: [
    { patterns: ["AF", "A", "AL", "AX"], type: "Contactor", notes: "AF / A / AL / AX series IEC contactors" },
    { patterns: ["NF", "NFB"], type: "Contactor", notes: "Auxiliary contactor relays" },
    { patterns: ["TA", "TF", "T7", "T6", "T5", "T4"], type: "Molded Case Circuit Breaker", notes: "Tmax MCCB" },
    { patterns: ["S20", "S200", "S201", "S202", "S203"], type: "Miniature Circuit Breaker", notes: "System pro M MCB" },
    { patterns: ["F20", "F200", "F201", "F202", "F203", "F204", "DS20"], type: "Residual Current Device" },
    { patterns: ["MS", "MO", "MS116", "MS132", "MS165", "MS325", "MS495"], type: "Motor Circuit Breaker", notes: "Manual motor starter" },
    { patterns: ["PSE", "PSTX", "PSR", "PST"], type: "Soft Starter" },
    { patterns: ["ACS", "ACQ", "ACH"], type: "Variable Speed Drive", notes: "ACS / ACQ / ACH drives" },
    { patterns: ["OT", "OS", "OSM"], type: "Disconnect Switch", notes: "Switch-disconnectors" },
    { patterns: ["OVR"], type: "Surge Protective Device" },
    { patterns: ["TM", "M2A", "M3", "M3BP", "M3GP"], type: "Motor" },
    { patterns: ["CP-T", "CP-E", "CP-D", "CP-S", "DR-Q"], type: "Power Supply", notes: "CP-T / CP-E DIN-rail PSUs" },
    { patterns: ["CM-"], type: "Relay", notes: "CM monitoring relays" },
    { patterns: ["PLUTO"], type: "Safety Relay", notes: "Pluto safety controller" },
    { patterns: ["AC500"], type: "Programmable Logic Controller" },
    { patterns: ["CP6"], type: "HMI", notes: "CP6xx HMI panel" }
  ],
  schneider: [
    { patterns: ["LC1", "LC2", "LC7", "LP1"], type: "Contactor", notes: "TeSys contactor" },
    { patterns: ["LRD", "LR2", "LR3", "LRE", "LRF"], type: "Motor Starter", notes: "TeSys overload relay" },
    { patterns: ["GV2", "GV3", "GV4", "GV7"], type: "Motor Circuit Breaker", notes: "GV manual motor starter" },
    { patterns: ["NSX", "NSXM", "NSXC", "MGN", "NS"], type: "Molded Case Circuit Breaker" },
    { patterns: ["C60", "C60H", "C60N", "C120", "IC60"], type: "Miniature Circuit Breaker", notes: "Acti9 MCB" },
    { patterns: ["A9", "ID", "IDB"], type: "Residual Current Device", notes: "Acti9 RCD/RCBO" },
    { patterns: ["ATV"], type: "Variable Speed Drive", notes: "Altivar" },
    { patterns: ["ATS"], type: "Soft Starter", notes: "Altistart" },
    { patterns: ["ABL", "PSU"], type: "Power Supply" },
    { patterns: ["XB4", "XB5", "XB6", "XB7", "ZBE"], type: "Pushbutton / Operator", notes: "Harmony" },
    { patterns: ["XALD", "XALK"], type: "Pushbutton / Operator", notes: "Harmony control station" },
    { patterns: ["XVB", "XVR"], type: "Stack Light / Beacon" },
    { patterns: ["XS1", "XS2", "XS4", "XS5", "XS6", "XS7", "XS8"], type: "Inductive Proximity Sensor", notes: "OsiSense XS" },
    { patterns: ["XU"], type: "Photoelectric Sensor", notes: "OsiSense XU" },
    { patterns: ["XCK", "ZCK", "XCS"], type: "Sensor", notes: "Limit switches" },
    { patterns: ["M221", "M241", "M251", "M258", "M262"], type: "Programmable Logic Controller", notes: "Modicon M" },
    { patterns: ["TM3"], type: "I/O Module", notes: "Modicon TM3" },
    { patterns: ["HMI", "HMIST", "HMIGTO", "HMIGXO"], type: "HMI", notes: "Harmony HMI" },
    { patterns: ["BMX"], type: "I/O Module", notes: "Modicon M340" }
  ],
  eaton: [
    { patterns: ["DIL", "XTC"], type: "Contactor", notes: "xStart / DIL contactor" },
    { patterns: ["PKZM", "PKE", "MSP"], type: "Motor Circuit Breaker" },
    { patterns: ["DS7"], type: "Soft Starter" },
    { patterns: ["DG1", "DC1", "DA1", "DM1", "DE1"], type: "Variable Speed Drive", notes: "PowerXL" },
    { patterns: ["FAZ", "WMZ"], type: "Miniature Circuit Breaker" },
    { patterns: ["NZM"], type: "Molded Case Circuit Breaker" },
    // Rotary switch-disconnectors use Eaton's P1-/P3-/T0-/T3-/T5-/T6- pattern (always followed by
    // a hyphen). Short alphanumeric prefixes like "P5" without a hyphen would clash with Tripp
    // Lite cables (e.g. P569-…) that share the eaton.com domain, so require the hyphen here.
    { patterns: ["P1-", "P3-", "T0-", "T3-", "T5-", "T6-"], type: "Disconnect Switch", notes: "Rotary switch-disconnector" },
    { patterns: ["EASY"], type: "Programmable Logic Controller", notes: "easyE" },
    { patterns: ["XV"], type: "HMI" },
    { patterns: ["M22"], type: "Pushbutton / Operator", notes: "M22 control station" }
  ],
  siemens: [
    { patterns: ["3RT", "3TF"], type: "Contactor", notes: "SIRIUS contactor" },
    { patterns: ["3RH"], type: "Contactor", notes: "Auxiliary contactor" },
    { patterns: ["3RV", "3VA"], type: "Motor Circuit Breaker", notes: "SIRIUS MMSB / MCCB" },
    { patterns: ["3RU", "3RB"], type: "Motor Starter", notes: "Overload relay" },
    { patterns: ["3RW"], type: "Soft Starter", notes: "SIRIUS soft starter" },
    { patterns: ["5SY", "5SL"], type: "Miniature Circuit Breaker" },
    { patterns: ["5SU", "5SV"], type: "Residual Current Device" },
    { patterns: ["6SE", "6SL", "6SN", "G120", "S120", "V20"], type: "Variable Speed Drive", notes: "Sinamics" },
    { patterns: ["6EP"], type: "Power Supply", notes: "SITOP" },
    { patterns: ["3SK", "3SF"], type: "Safety Relay" },
    { patterns: ["6ES7", "S7-1200", "S7-1500", "S7-300", "S7-400"], type: "Programmable Logic Controller", notes: "SIMATIC S7" },
    { patterns: ["6AV"], type: "HMI", notes: "SIMATIC HMI" },
    { patterns: ["3SE", "3SU"], type: "Pushbutton / Operator" }
  ],
  balluff: [
    { patterns: ["BOS", "BOH", "BLE", "BLS"], type: "Photoelectric Sensor" },
    { patterns: ["BES", "BIS"], type: "Inductive Proximity Sensor" },
    { patterns: ["BCS"], type: "Capacitive Sensor" },
    { patterns: ["BUS"], type: "Ultrasonic Sensor" },
    { patterns: ["BMF", "BMP"], type: "Magnetic Field Sensor" },
    { patterns: ["BVS"], type: "Vision Sensor" },
    { patterns: ["BNI"], type: "I/O Module", notes: "BNI IO-Link" },
    { patterns: ["BTL"], type: "Encoder", notes: "Magnetostrictive linear encoder" },
    { patterns: ["BDG"], type: "Encoder", notes: "Absolute encoder" }
  ],
  sce: [
    { patterns: ["SCE-FK"], type: "Thermal Management", notes: "SCE filter kits" }
  ],
  phoenix: [
    { patterns: ["QUINT", "TRIO", "STEP", "MINI-PS", "MINI-DC", "UNO-PS"], type: "Power Supply" },
    { patterns: ["UT", "UK", "ST", "PT", "STTB", "UKK", "DIK"], type: "Terminal Block" },
    { patterns: ["E/UK", "CLIPFIX", "E/NS"], type: "Terminal Accessory" },
    { patterns: ["MCS", "VIP"], type: "Connector" },
    { patterns: ["VAL-CP", "VAL-MS", "PLUGTRAB"], type: "Surge Protective Device" },
    { patterns: ["MACX", "MCR"], type: "I/O Module", notes: "MACX signal conditioner" },
    { patterns: ["FL"], type: "Communication Gateway", notes: "FL switch / FL gateway" },
    { patterns: ["RAD"], type: "Communication Gateway", notes: "Radioline" },
    { patterns: ["PSR", "PSRMINI"], type: "Safety Relay" }
  ],
  weidmuller: [
    { patterns: ["WPD", "WAD", "WTU"], type: "Power Supply" },
    { patterns: ["WDU", "WDK", "AKZ", "ZDU"], type: "Terminal Block" },
    { patterns: ["EW", "WAP", "ZAP"], type: "Terminal Accessory" },
    { patterns: ["SAI"], type: "I/O Module" }
  ],
  rittal: [
    { patterns: ["AE", "KX", "EB", "BG", "TS", "TS8"], type: "Enclosure" },
    { patterns: ["VX", "VX25"], type: "Enclosure", notes: "VX25 baying enclosure" },
    { patterns: ["DK"], type: "Rack Cabinet" },
    { patterns: ["SK"], type: "Thermal Management", notes: "Climate control / filter fans" }
  ],
  spelsberg: [
    { patterns: ["ABOX", "AK", "TK", "WKE", "GTI"], type: "Enclosure", notes: "Spelsberg junction boxes / enclosures" }
  ],
  schmersal: [
    { patterns: ["AZM", "AZ", "BNS", "RSS", "SLC", "SLB", "EX-AZ"], type: "Safety Sensor" },
    { patterns: ["SRB", "PROTECT-"], type: "Safety Relay" }
  ],
  rockwell: [
    { patterns: ["100-"], type: "Contactor", notes: "Allen-Bradley IEC contactors" },
    { patterns: ["140M"], type: "Motor Circuit Breaker" },
    { patterns: ["140G"], type: "Circuit Breaker" },
    { patterns: ["193"], type: "Motor Starter", notes: "E1 Plus / overload relays" },
    { patterns: ["20F", "20G", "22B", "25B", "25A"], type: "Variable Speed Drive", notes: "PowerFlex drives" },
    { patterns: ["42EF", "42JS", "45CRM", "45DMS", "45LMS"], type: "Photoelectric Sensor" },
    { patterns: ["871", "872"], type: "Inductive Proximity Sensor" },
    { patterns: ["1769-PA", "1769-PB"], type: "Power Supply", notes: "CompactLogix power supply" },
    { patterns: ["1734", "1756", "1769", "1794", "5069"], type: "I/O Module" },
    { patterns: ["2711"], type: "HMI", notes: "PanelView HMI" },
    { patterns: ["800F", "800T"], type: "Pushbutton / Operator" },
    { patterns: ["440R"], type: "Safety Relay" },
    { patterns: ["440N", "440G"], type: "Safety Sensor" },
    { patterns: ["1492"], type: "Terminal Block" }
  ],
  eta: [
    { patterns: ["REX", "3120", "2210", "ESS"], type: "Circuit Breaker" }
  ],
  pilz: [
    { patterns: ["PNOZ"], type: "Safety Relay" },
    { patterns: ["PSEN"], type: "Safety Sensor" },
    { patterns: ["PMI"], type: "HMI" }
  ],
  sick: [
    { patterns: ["WL", "WT", "WS", "WSE"], type: "Photoelectric Sensor" },
    { patterns: ["IME", "IM"], type: "Inductive Proximity Sensor" },
    { patterns: ["UC", "UM"], type: "Ultrasonic Sensor" },
    { patterns: ["MLG", "deTec", "C2000", "C4000"], type: "Safety Sensor", notes: "Safety light curtain" },
    { patterns: ["DFS", "AFS", "AFM"], type: "Encoder" }
  ],
  ifm: [
    { patterns: ["O1D", "O2D", "OGS", "OGP"], type: "Photoelectric Sensor" },
    { patterns: ["IF", "IG", "IH", "IM"], type: "Inductive Proximity Sensor" },
    { patterns: ["KI", "KQ"], type: "Capacitive Sensor" },
    { patterns: ["UGT"], type: "Ultrasonic Sensor" },
    { patterns: ["AL"], type: "I/O Module", notes: "AL IO-Link master" }
  ]
};

/**
 * Lookup a device type from a manufacturer's family/series. Returns the first matching entry,
 * preferring longest prefix match so "PSEN" doesn't accidentally match "PSE".
 */
export function familyTypeFor(
  manufacturerId: string | undefined,
  candidates: ReadonlyArray<string | undefined>
): { type: string; pattern: string; notes?: string } | undefined {
  if (!manufacturerId) return undefined;
  const entries = DEVICE_TYPE_FAMILIES[manufacturerId.toLowerCase()];
  if (!entries) return undefined;
  // Pre-flatten patterns with metadata, sorted longest-first so "PSEN" beats "PS" in checks below.
  const flat = entries.flatMap((entry) =>
    entry.patterns.map((pattern) => ({ pattern, type: entry.type, notes: entry.notes }))
  );
  flat.sort((left, right) => right.pattern.length - left.pattern.length);
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (!text) continue;
    const upper = text.toUpperCase();
    for (const entry of flat) {
      const pattern = entry.pattern.toUpperCase();
      // Match if the candidate STARTS with the pattern at a word boundary. "AF40B" matches "AF"
      // but "AFTER" does not — the character after must be non-letter or end-of-string.
      if (!upper.startsWith(pattern)) continue;
      // Patterns that already include a non-alphanumeric terminator (e.g. "P5-") have done their
      // own disambiguation — accept the match as-is.
      if (/[^A-Z0-9]$/.test(pattern)) return entry;
      const next = upper.charAt(pattern.length);
      if (next === "" || !/[A-Z]/.test(next)) return entry;
    }
  }
  return undefined;
}
