/**
 * Property ontology (Understanding Engine, workstream B-2) — the deterministic KNOWLEDGE BASE.
 *
 * This is the opposite of per-manufacturer templates: a general, data-driven dictionary of what
 * a spec LABEL *means*, across languages, regardless of which manufacturer wrote it. "Nennstrom",
 * "rated operational current", "courant assigné" all mean the same canonical property. Paired with
 * the quantity grammar (which understands the VALUE), this lets the scraper understand a page from
 * a manufacturer it has never seen — and FLAG what it cannot map instead of guessing.
 *
 * To teach it more, add entries/synonyms here (data), not new regexes scattered through scrapers.
 */
import { parseQuantities, type ParsedQuantity, type QuantityKind } from "./quantity.js";

export interface CanonicalProperty {
  /** Stable canonical id. */
  key: string;
  /** Human-readable English label. */
  label: string;
  /** Expected physical quantity kind (drives value parsing + sanity); omit for non-numeric props. */
  unitKind?: QuantityKind;
  /** Multilingual label matchers (EN/DE first; extend freely). Matched case-insensitively. */
  synonyms: RegExp[];
  /** Labels that must NOT be treated as this property (kills look-alikes, e.g. "colour temperature"). */
  exclude?: RegExp[];
}

const COLOUR_TEMP = /colou?r\s*temp(?:erature)?|farbtemperatur/i;

export const PROPERTY_ONTOLOGY: CanonicalProperty[] = [
  {
    key: "controlVoltage",
    label: "Control / coil voltage",
    unitKind: "voltage",
    synonyms: [/control(?:\s+circuit)?\s+voltage/i, /coil\s+voltage/i, /steuerspannung/i, /spulenspannung/i]
  },
  {
    key: "ratedVoltage",
    label: "Rated / operational voltage",
    unitKind: "voltage",
    synonyms: [
      /rated\s+(?:operational\s+)?voltage/i,
      /operational\s+voltage/i,
      /operating\s+voltage/i,
      /nominal\s+voltage/i,
      /\bvoltage\b/i,
      /nennspannung/i,
      /bemessungsspannung/i,
      /betriebsspannung/i,
      /\bspannung\b/i
    ]
  },
  {
    key: "ratedCurrent",
    label: "Rated / operational current",
    unitKind: "current",
    synonyms: [
      /rated\s+(?:operational\s+)?current/i,
      /operational\s+current/i,
      /nominal\s+current/i,
      /\bcurrent\b/i,
      /nennstrom/i,
      /bemessungsstrom/i,
      /\bstrom\b/i
    ]
  },
  {
    key: "breakingCapacity",
    label: "Breaking / short-circuit capacity",
    unitKind: "current",
    synonyms: [/breaking\s+capacity/i, /short[-\s]?circuit\s+(?:current|capacity|breaking)/i, /schaltverm[öo]gen/i, /kurzschluss/i]
  },
  {
    key: "power",
    label: "Power",
    unitKind: "power",
    synonyms: [/\bpower\b/i, /output\s+power/i, /\bleistung\b/i, /\bwattage\b/i],
    exclude: [/power\s+loss/i, /verlustleistung/i, /power\s+supply/i]
  },
  {
    key: "powerLoss",
    label: "Power loss",
    unitKind: "power",
    synonyms: [/power\s+loss/i, /verlustleistung/i, /heat\s+dissipation/i]
  },
  {
    key: "frequency",
    label: "Frequency",
    unitKind: "frequency",
    synonyms: [/\bfrequency\b/i, /\bfrequenz\b/i]
  },
  {
    key: "operatingTemperature",
    label: "Operating / ambient temperature",
    unitKind: "temperature",
    synonyms: [
      /(?:operating|operational|ambient|working|surrounding|service)\s+temperature/i,
      /temperature\s+range/i,
      /umgebungstemperatur/i,
      /betriebstemperatur/i
    ],
    exclude: [COLOUR_TEMP, /storage|lager|transport/i]
  },
  {
    key: "storageTemperature",
    label: "Storage temperature",
    unitKind: "temperature",
    synonyms: [/storage\s+temperature/i, /lagertemperatur/i, /transport\s+temperature/i]
  },
  {
    key: "weight",
    label: "Weight",
    unitKind: "mass",
    synonyms: [/\bweight\b/i, /\bmass\b/i, /\bgewicht\b/i, /\bmasse\b/i, /\bpeso\b/i, /te[zž]ina/i],
    exclude: [/molecular|atomic/i]
  },
  {
    key: "torque",
    label: "Tightening torque",
    unitKind: "torque",
    synonyms: [/\btorque\b/i, /tightening\s+torque/i, /drehmoment/i, /anzugsdrehmoment/i]
  },
  {
    key: "pressure",
    label: "Pressure",
    unitKind: "pressure",
    synonyms: [/\bpressure\b/i, /\bdruck\b/i],
    exclude: [/pressure\s+(?:switch|sensor|transmitter|gauge)/i]
  },
  {
    key: "width",
    label: "Width",
    unitKind: "length",
    synonyms: [/\bwidth\b/i, /\bbreite\b/i, /[šs]irina/i]
  },
  {
    key: "height",
    label: "Height",
    unitKind: "length",
    synonyms: [/\bheight\b/i, /\bh[öo]he\b/i, /visina/i]
  },
  {
    key: "depth",
    label: "Depth / length",
    unitKind: "length",
    synonyms: [/\bdepth\b/i, /\btiefe\b/i, /dubina/i]
  },
  {
    key: "material",
    label: "Material",
    unitKind: undefined,
    synonyms: [/\bmaterial\b/i, /\bwerkstoff\b/i, /materijal/i, /housing\s+material/i, /enclosure\s+material/i, /body\s+material/i],
    exclude: [/declaration|compliance|rohs|reach/i]
  },
  {
    key: "color",
    label: "Colour",
    unitKind: undefined,
    synonyms: [/\bcolou?r\b/i, /\bfarbe\b/i, /\bboja\b/i],
    exclude: [COLOUR_TEMP]
  },
  {
    key: "finish",
    label: "Surface finish",
    unitKind: undefined,
    synonyms: [/\bfinish\b/i, /surface\s+(?:finish|treatment|coating)/i, /\bcoating\b/i, /ober(?:fl[äa]che|fl[äa]chenbehandlung)/i, /beschichtung/i]
  },
  {
    key: "protection",
    label: "Degree of protection (IP/NEMA)",
    unitKind: undefined,
    synonyms: [/degree\s+of\s+protection/i, /protection\s+(?:class|rating|degree)/i, /ingress\s+protection/i, /\bip\s*rating\b/i, /schutzart/i, /\bnema\s+(?:type|rating)/i]
  },
  {
    key: "poles",
    label: "Number of poles",
    unitKind: undefined,
    synonyms: [/number\s+of\s+poles/i, /\bpoles\b/i, /polzahl/i, /\bpolig\b/i, /anzahl\s+pole/i]
  },
  {
    key: "certificates",
    label: "Approvals / standards",
    unitKind: undefined,
    synonyms: [/\bapprovals?\b/i, /certificat/i, /\bconformity\b/i, /\bstandards?\b/i, /\bzulassung\b/i, /\bnormen?\b/i, /\bmarking\b/i]
  }
];

/** Map any spec label (any supported language) to the canonical property it MEANS. */
export function matchProperty(label: string): CanonicalProperty | undefined {
  if (!label) return undefined;
  let best: { property: CanonicalProperty; score: number } | undefined;
  for (const property of PROPERTY_ONTOLOGY) {
    if (property.exclude?.some((pattern) => pattern.test(label))) continue;
    let matched = 0;
    for (const pattern of property.synonyms) {
      const found = label.match(pattern);
      if (found) matched = Math.max(matched, found[0].length);
    }
    // Most-specific match wins ("control voltage" beats the generic "voltage").
    if (matched > 0 && (!best || matched > best.score)) best = { property, score: matched };
  }
  return best?.property;
}

export interface UnderstoodValue {
  property?: CanonicalProperty;
  quantities: ParsedQuantity[];
}

/** Understand a labelled spec: what property it is + the structured quantity in its value. */
export function understand(label: string, value: string): UnderstoodValue {
  const property = matchProperty(label);
  const quantities = parseQuantities(value, property?.unitKind ? { kind: property.unitKind } : {});
  return { property, quantities };
}

export interface LabelledValue {
  group?: string;
  name: string;
  value: string;
}

/**
 * Self-diagnosis (workstream I): spec attributes whose VALUE contains a recognizable quantity but
 * whose LABEL maps to no known property — i.e. a real knowledge-base gap to teach, not a guess to make.
 */
export function findUnmappedSpecLabels(attributes: LabelledValue[]): string[] {
  const unmapped = new Set<string>();
  for (const attribute of attributes) {
    const label = `${attribute.group ?? ""} ${attribute.name}`.trim();
    if (!label || matchProperty(label)) continue;
    if (parseQuantities(attribute.value).length === 0) continue;
    unmapped.add(attribute.name.trim());
  }
  return [...unmapped];
}
