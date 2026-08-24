import type { AttributeRecord, DocumentRecord, NormalizedProductFields, ProductResult } from "../../shared/types.js";
import { cleanText, uniqueStrings } from "../text-util.js";
import type { QuantityKind } from "./quantity.js";

export type RegistryFieldKey =
  | keyof NormalizedProductFields
  | "image"
  | "datasheetUrl"
  | "manualUrl"
  | "certificateUrl"
  | "operatingTemperature"
  | "typeCode";

export interface RegistryFieldDefinition {
  key: RegistryFieldKey;
  label: string;
  aliases: RegExp[];
  /**
   * The ontology properties whose values legitimately belong in this shipped field.
   *
   * This is the missing link between the codebase's label systems. Without it, "does the registry and the
   * ontology agree about this label" is unanswerable, so nothing could detect the two drifting apart — and
   * they had, silently: `audit:labels` found `Power input` routed to `voltage` by the registry while the
   * ontology types it as power. Declaring the intended correspondence makes that check possible.
   *
   * Absent for fields the ontology has no property for (images, document URLs).
   */
  ontologyKeys?: string[];
}

export interface FieldHealthRecord {
  field: RegistryFieldKey;
  label: string;
  status: "found" | "missing" | "low-confidence" | "conflicting";
  value?: string;
  confidence?: number;
  sourceUrls?: string[];
  conflicts?: Array<{
    value: string;
    sourceUrls: string[];
    confidence?: number;
    sourceTypes?: Array<NonNullable<AttributeRecord["sourceType"]>>;
    parsers?: string[];
    stages?: string[];
    priority?: number;
    priorityReason?: string;
    selected?: boolean;
  }>;
  reason?: string;
  reasonCode?: "no-source-discovered" | "source-fetched-no-label" | "label-found-value-rejected" | "document-not-parsed" | "scoping-failed" | "conflicting-candidates" | "not-published";
  resolution?: string;
}

/**
 * `satisfies` rather than a type annotation, so each entry's `key` keeps its literal type and
 * `RegisteredFieldKey` below can be derived from the array instead of restated next to it.
 */
export const FIELD_REGISTRY = [
  {
    key: "weight",
    label: "Weight",
    aliases: [/\bweight\b/i, /\bmass\b/i, /\bgewicht\b/i, /\bpeso\b/i, /\bunit weight\b/i, /\bnet weight\b/i, /\bgross weight\b/i],
    ontologyKeys: ["weight"]
  },
  {
    key: "dimensions",
    label: "Dimensions",
    aliases: [/\bdimensions?\b/i, /\bsize\b/i, /\babmessungen?\b/i, /\bdimenzije\b/i, /\bheight\b/i, /\bwidth\b/i, /\bdepth\b/i, /\blength\b/i, /\boverall\b/i, /\bh\s*x\s*w\s*x\s*d\b/i, /\bhxwxd\b/i],
    ontologyKeys: ["width", "height", "depth"]
  },
  {
    key: "material",
    label: "Material",
    aliases: [/\bmaterials?\b(?!\s+thickness\b)/i, /\bwerkstoff\b/i, /\bmaterijal\b/i, /\bmat[eé]riau\b/i, /\bmateriale\b/i, /\bhousing\b/i, /\benclosure\s+(?:material|body|housing|construction)\b/i, /\bbody\b(?!\s+thickness\b)/i],
    ontologyKeys: ["material"]
  },
  {
    key: "wallThickness",
    label: "Wall thickness",
    aliases: [/\bwall\s+thickness\b/i, /\bmaterial\s+thickness\b/i, /\bsheet\s+thickness\b/i, /\bbody\s+thickness\b/i, /\bdoor\s+thickness\b/i, /\bthickness\b/i, /\bgauge\b/i],
    ontologyKeys: ["wallThickness"]
  },
  {
    key: "finish",
    label: "Finish",
    aliases: [/\bfinish(?:ing)?\b/i, /\bcoating\b/i, /\bpaint\b/i, /\bpowder\s+coat/i, /\bsurface\s+(?:treatment|finish|finishing|coating)\b/i],
    ontologyKeys: ["finish"]
  },
  {
    key: "color",
    label: "Color",
    aliases: [/\bcolou?r\b/i, /\bfarbe\b/i, /\bcouleur\b/i, /\bcolore\b/i, /\bRAL\b/i],
    ontologyKeys: ["color"]
  },
  {
    key: "voltage",
    label: "Voltage",
    aliases: [/\bvoltage\b/i, /\bvolts?\b/i, /\bVAC\b/i, /\bVDC\b/i, /\bspannung\b/i, /\bnapon\b/i, /\brated.*voltage\b/i, /\bsupply voltage\b/i, /\binput voltage\b/i, /\binput power\b/i, /\boperating voltage\b/i],
    // `powerConsumption` belongs here even though it names a wattage, because vendors label a supply
    // as "Power input" and then print a VOLTAGE under it. That is safe only because the quantity-kind
    // guard runs first: measured end to end, "Power input 24 W" yields nothing and "Power input 24 V DC"
    // yields the voltage. Ui, Uimp and voltage drop are deliberately absent — those are other ratings.
    ontologyKeys: ["ratedVoltage", "controlVoltage", "powerConsumption"]
  },
  {
    key: "current",
    label: "Current",
    aliases: [/\bcurrent\b/i, /\bamps?\b/i, /\bamperage\b/i, /\bamperes?\b/i, /\bstrom\b/i, /\bstruja\b/i, /\brated.*current\b/i, /\bmax\.?\s*current\b/i, /\boperational.*current\b/i, /\bswitching capacity\b/i],
    // A single shipped column carries whichever current the vendor publishes, so several properties are
    // legitimate: for a sensor the current CONSUMPTION is the figure customers want, and for a relay or
    // thermostat the SWITCHING capacity is the contact rating. Absent on purpose: residual current
    // (30 mA on a 40 A device), let-through I²t, leakage and locked-rotor ratio — all measured in the
    // same unit yet none of them the rating the product is sold on.
    ontologyKeys: ["ratedCurrent", "currentConsumption", "switchingCapacity"]
  },
  {
    key: "protection",
    label: "Protection rating",
    aliases: [/\bIP\s*\d*/i, /\bNEMA\b/i, /\bIK\s*\d*/i, /\bprotection\b/i, /\bschutzart\b/i, /\benclosure type\b/i, /\benvironmental rating\b/i],
    ontologyKeys: ["protection", "ikRating"]
  },
  {
    key: "certificates",
    label: "Certificates",
    aliases: [/\bapproval\b/i, /\bconformity\b/i, /\bcompliance\b/i, /\bcertificates?\b/i, /\bcertifications?\b/i, /\bstandards?\b/i, /\bmarking\b/i, /\bUL\b/i, /\bCE\b/i, /\bUKCA\b/i, /\bRoHS\b/i, /\bREACH\b/i, /\bWEEE\b/i],
    ontologyKeys: ["certificates"]
  },
  {
    key: "operatingTemperature",
    label: "Operating temperature",
    aliases: [/\boperating\s+temperature\b/i, /\boperational\s+temperature\b/i, /\bambient\s+temperature\b/i, /\btemperature range\b/i, /\bumgebungstemperatur\b/i, /\bbetriebstemperatur\b/i],
    ontologyKeys: ["operatingTemperature"]
  },
  {
    key: "image",
    label: "Product image",
    aliases: [/\bimage\b/i, /\bpicture\b/i, /\bphoto\b/i, /\bproduct media\b/i, /\bmedia\b/i]
  },
  {
    key: "datasheetUrl",
    label: "Datasheet URL",
    aliases: [/\bdata\s*sheet\b/i, /\bdatasheet\b/i, /\btechnical\s+data\b/i, /\btechnical\s+sheet\b/i, /\bspec(?:ification)?\s*sheet\b/i]
  },
  {
    key: "manualUrl",
    label: "Manual URL",
    aliases: [/\bmanual\b/i, /\binstruction\b/i, /\binstallation\b/i, /\buser\s+guide\b/i]
  },
  {
    key: "certificateUrl",
    label: "Certificate URL",
    aliases: [/\bcertificate\b/i, /\bdeclaration\b/i, /\bconformity\b/i, /\bapproval\b/i, /\brohs\b/i, /\breach\b/i, /\bul\b/i, /\bce\b/i]
  },
  {
    key: "typeCode",
    label: "Type code",
    aliases: [/\btype\s*code\b/i, /\bmodel\s*code\b/i, /\bextended product type\b/i, /\btype designation\b/i, /\bMLFB\b/i],
    ontologyKeys: ["typeCode"]
  }
] satisfies readonly RegistryFieldDefinition[];

/**
 * Strict start-of-label form of the existing registry aliases. `fieldMatchesLabel` deliberately
 * matches anywhere for field resolution; compact inline prose needs a boundary at the label start.
 */
export function matchRegistryFieldLabelPrefix(label: string): { field: RegistryFieldKey; length: number } | undefined {
  const cleanLabel = label.trimStart();
  if (!cleanLabel) return undefined;
  let best: { field: RegistryFieldKey; length: number } | undefined;
  for (const field of FIELD_REGISTRY) {
    for (const pattern of [...field.aliases, ...(FIELD_REGISTRY_EXTRA_ALIASES[field.key] ?? [])]) {
      const anchored = new RegExp(`^(?:${pattern.source})`, pattern.flags.replace(/[gy]/g, ""));
      const found = anchored.exec(cleanLabel);
      if (found && (!best || found[0].length > best.length)) best = { field: field.key, length: found[0].length };
    }
  }
  return best;
}

/** The keys that actually HAVE a registry entry, derived from the array above. */
export type RegisteredFieldKey = (typeof FIELD_REGISTRY)[number]["key"];

/**
 * A normalized field that the registry can really route.
 *
 * `RegistryFieldKey` includes every `keyof NormalizedProductFields`, but the registry has no entry for
 * `operatingTemperatureMin`/`operatingTemperatureMax` — they are derived from a parsed range, not matched
 * by label. Passing one to `registryFieldValue` compiled fine and returned `undefined` forever, because
 * `fieldMatchesLabel` answers `false` for a key with no definition. Making the parameter type derive from
 * the array turns that silent no-op into a compile error.
 */
export type NormalizedRegistryFieldKey = Extract<RegisteredFieldKey, keyof NormalizedProductFields>;

/**
 * Some normalizer paths deliberately search the combined `group + name` context and need a wider
 * vocabulary than registry admission. Keeping those exceptional forms next to FIELD_REGISTRY gives
 * the project one module that owns every shipped-field label rule, while preserving their different
 * role from `fieldMatchesLabel` (which decides whether a raw attribute may be admitted at all).
 */
const NORMALIZER_CONTEXT_ALIASES: Partial<Record<NormalizedRegistryFieldKey, RegExp[]>> = {
  weight: [/weight/, /\bmass\b/, /net.*weight/, /gross.*weight/, /gewicht/, /masse\b/, /massa/, /peso/, /te[z\u017e]ina/, /\u91cd\u91cf/],
  dimensions: [/\bdimensions?\b/, /\bdimensioni\b/, /\babmessungen\b/, /\babmessung\b/, /\bma(?:sse|\u00dfe)\b/, /\bmasse\b/, /\bdimenzije\b/, /\bcable length\b/, /\u5c3a\u5bf8/],
  wallThickness: [/\bwall\s+thickness\b/, /\bthickness\b/, /\bmaterial\s+thickness\b/, /\bsheet\s+thickness\b/, /\bbody\s+thickness\b/, /\bdoor\s+thickness\b/, /\bgauge\b/],
  finish: [/\bfinish\b/, /\bfinishes\b/, /\bsurface\s+(?:finish|finishing|treatment|coating)\b/, /\bcoating\b/, /\bpaint\b/, /\bpowder\s+coat/, /\bfarbe\b/],
  color: [/\bcolou?r\b/, /\bfarbe\b/],
  voltage: [/voltage/, /\bvolts?\b/, /\bspannung\b/, /\boperating voltage\b/, /\brated voltage\b/, /\brated.*voltage\b/, /\boperational.*voltage\b/, /\bcontrol.*circuit.*voltage\b/, /\binput voltage\b/, /\binput power\b/, /\bpower input\b/, /\bnominal voltage\b/, /\bcontinuous operating voltage\b/, /\bmaximum operating voltage\b/, /\bvoltage protection level\b/, /napon/, /\u7535\u538b/, /\b(?:u[ern]|u[abs])\b/],
  current: [/\brated.*current\b/, /\boperational.*current\b/, /\brated current\b/, /\bcurrent ratings?\b/, /\bamps?\b/, /\bamperes?\b/, /\bcurrent consumption\b/, /\boutput current\b/, /\binput current\b/, /\bthermal current\b/, /\bthermal protection adjustment range\b/, /\bcontinuous current\b/, /\bampere rating\b/, /\bswitching capacity\b/, /\bswitching current\b/, /\bshort-?time.*current\b/, /\bcurrent\b/, /\bstrom\b/, /amperage/, /corrente/, /struja/, /\u7535\u6d41/]
};

/** Context-sensitive normalizer patterns, owned by the registry rather than a parallel map. */
export function normalizerFieldLabelPatterns(key: NormalizedRegistryFieldKey): RegExp[] {
  return NORMALIZER_CONTEXT_ALIASES[key] ?? fieldDefinition(key)?.aliases ?? [];
}

const FIELD_REGISTRY_EXTRA_ALIASES: Partial<Record<RegistryFieldKey, RegExp[]>> = {
  material: [/\bcover\s+material\b/i, /\bcable\s+material\b/i],
  voltage: [/\bpower input\b/i, /\bnominal voltage\b/i, /\bcontinuous operating voltage\b/i],
  certificates: [/\bdeclarations?\b/i, /\bapproved\b/i, /\blisted\b/i],
  operatingTemperature: [/\bworking\s+temperature\b/i, /\bservice\s+temperature\b/i, /\bsurrounding\s+temperature\b/i]
};

// These labels contain a dimension word but name a different engineering property. The product model
// does not export those properties yet, so retaining the raw attribute is safer than publishing it as
// the enclosure/device envelope under `dimensions`.
const NON_DIMENSIONAL_SIZE_LABELS = /\b(?:frame\s+size|stripping\s+length|stroke\s+length)\b/i;
const NON_NAMEPLATE_VOLTAGE_LABELS = /\b(?:rated\s+insulation\s+voltage|rated\s+impulse\s+withstand\s+voltage|voltage\s+drop)\b/i;
const NON_NAMEPLATE_CURRENT_LABELS = /\b(?:inrush\s+current|starting\s*\/\s*locked-rotor\s+current\s+ratio|rated\s+residual\s+current|let-through\s+current|leakage\s*\/\s*off-state\s+current)\b/i;

const FIELD_REGISTRY_DOCUMENT_LABELS: Partial<Record<RegistryFieldKey, string[]>> = {
  weight: ["Weight", "Mass", "Unit weight", "Net weight", "Gross weight", "Shipping weight", "Peso"],
  dimensions: ["Dimensions", "Overall dimensions", "External dimensions", "Size", "Height", "Width", "Depth", "Length"],
  material: ["Material", "Materials", "Housing material", "Enclosure material", "Body material", "Base element material", "Cover material", "Cable material", "Materiale", "Werkstoff", "Materijal"],
  wallThickness: ["Wall thickness", "Material thickness", "Sheet thickness", "Body thickness", "Door thickness", "Thickness", "Gauge"],
  finish: ["Finish", "Finishing", "Coating", "Surface treatment", "Surface finish", "Surface finishing"],
  color: ["Color", "Colour", "Farbe", "Couleur", "Colore", "RAL"],
  voltage: ["Voltage", "Voltage rating", "Rated voltage", "Supply voltage", "Input voltage", "Output voltage", "Operating voltage", "Nominal voltage", "Power input", "Napon", "Spannung"],
  current: ["Current", "Current rating", "Current ratings", "Rated current", "Max. current", "Operating current", "Nominal current", "Struja", "Strom"],
  protection: ["Protection", "Protection rating", "Degree of protection", "Protection class", "Enclosure protection", "IP rating", "NEMA rating", "IK rating", "Schutzart", "Environmental rating"],
  certificates: ["Approvals", "Approval/Conformity", "Conformity", "Compliance", "Certificates", "Certifications", "Standards", "Marking"],
  operatingTemperature: ["Operating temperature", "Operational temperature", "Ambient temperature", "Temperature range", "Working temperature", "Service temperature"],
  typeCode: ["Type code", "Model code", "Extended product type", "Type designation", "MLFB", "Catalog Number"]
};

/**
 * The physical quantity each shipped field is supposed to carry; absent means the field is text or a URL.
 *
 * This exists so the quantity-kind vocabulary has ONE owner. The registry speaks `NormalizedProductFields`
 * keys and the ontology speaks its own property keys, so any rule about "what may go in the voltage
 * column" had to be written twice, once per namespace — see `isDisqualifiedForQuantityKind`. Mapping the
 * registry key to a kind lets both sides state the rule once, in the only namespace they share.
 */
const REGISTRY_FIELD_QUANTITY_KIND: Partial<Record<RegistryFieldKey, QuantityKind>> = {
  weight: "mass",
  voltage: "voltage",
  current: "current",
  operatingTemperature: "temperature",
  wallThickness: "length"
};

export function registryFieldQuantityKind(key: RegistryFieldKey): QuantityKind | undefined {
  return REGISTRY_FIELD_QUANTITY_KIND[key];
}

export function fieldDefinition(key: RegistryFieldKey): RegistryFieldDefinition | undefined {
  return FIELD_REGISTRY.find((field) => field.key === key);
}

export function fieldMatchesLabel(field: RegistryFieldKey, label: string): boolean {
  const definition = fieldDefinition(field);
  if (!definition) return false;
  if (field === "dimensions" && NON_DIMENSIONAL_SIZE_LABELS.test(label)) return false;
  if (field === "voltage" && NON_NAMEPLATE_VOLTAGE_LABELS.test(label)) return false;
  if (field === "current" && NON_NAMEPLATE_CURRENT_LABELS.test(label)) return false;
  return [...definition.aliases, ...(FIELD_REGISTRY_EXTRA_ALIASES[field] ?? [])].some((pattern) => pattern.test(label));
}

export function fieldAttributeLabel(attribute: Pick<AttributeRecord, "group" | "name">): string {
  return cleanText(`${attribute.group ?? ""} ${attribute.name}`);
}

export function findFieldSourceAttribute(
  attributes: AttributeRecord[],
  field: RegistryFieldKey,
  value: string
): AttributeRecord | undefined {
  const fieldMatches = attributes.filter((attribute) => fieldMatchesLabel(field, fieldAttributeLabel(attribute)));
  return fieldMatches.find((attribute) => attributeValueMatches(attribute.value, value)) ??
    fieldMatches[0] ??
    attributes.find((attribute) => attributeValueMatches(attribute.value, value));
}

export function listFieldRegistryDocumentLabels(): string[] {
  return uniqueStrings([
    ...FIELD_REGISTRY.map((field) => field.label),
    ...Object.values(FIELD_REGISTRY_DOCUMENT_LABELS).flat()
  ].map(cleanText));
}

export function buildFieldHealth(result: ProductResult): FieldHealthRecord[] {
  return FIELD_REGISTRY.map((field) => fieldHealthForField(result, field));
}

function fieldHealthForField(result: ProductResult, field: RegistryFieldDefinition): FieldHealthRecord {
  const normalizedValue = normalizedFieldValue(result.normalized, field.key);
  const candidates = fieldCandidates(result, field.key);
  const sourceUrls = uniqueStrings(candidates.map((candidate) => candidate.sourceUrl));
  const confidence = candidates.length ? Math.max(...candidates.map((candidate) => candidate.confidence ?? fallbackConfidence(candidate.sourceType))) : undefined;
  if (isDocumentUrlField(field.key)) {
    return documentUrlFieldHealth(result, field, candidates, confidence, sourceUrls, result.confidence);
  }
  const conflicts = conflictingValues(candidates, normalizedValue);

  if (conflicts.length > 1) {
    const selectedValue = normalizedValue ?? conflicts.find((entry) => entry.selected)?.value;
    return {
      field: field.key,
      label: field.label,
      status: "conflicting",
      value: selectedValue,
      confidence,
      sourceUrls,
      conflicts,
      reason: "Multiple source-backed values were found for the same field.",
      reasonCode: "conflicting-candidates",
      resolution: conflictResolutionReason(selectedValue, conflicts, Boolean(normalizedValue))
    };
  }

  const value = normalizedValue ?? candidates[0]?.value;
  if (!value) {
    return {
      field: field.key,
      label: field.label,
      status: "missing",
      reason: missingFieldReason(result, field.key),
      reasonCode: missingFieldReasonCode(result, field.key)
    };
  }

  if ((confidence ?? result.confidence) < 0.6) {
    return {
      field: field.key,
      label: field.label,
      status: "low-confidence",
      value,
      confidence,
      sourceUrls,
      reason: "Value exists, but the strongest source confidence is below the review threshold.",
      reasonCode: "label-found-value-rejected"
    };
  }

  return {
    field: field.key,
    label: field.label,
    status: "found",
    value,
    confidence,
    sourceUrls
  };
}

function missingFieldReasonCode(result: ProductResult, field?: RegistryFieldKey): NonNullable<FieldHealthRecord["reasonCode"]> {
  if (field && result.diagnostics?.finalCompleteness?.records?.some((record) => record.field === field && record.status === "not-published")) {
    return "not-published";
  }
  if (result.documents.some((document) => document.parseStatus === "failed")) return "document-not-parsed";
  if (result.diagnostics?.notes?.some((note) => /scope.*(?:unresolved|failed)|unscoped/i.test(note))) return "scoping-failed";
  if (result.sources.length > 0 || result.documents.length > 0) return "source-fetched-no-label";
  return "no-source-discovered";
}

function missingFieldReason(result: ProductResult, field?: RegistryFieldKey): string {
  const code = missingFieldReasonCode(result, field);
  if (code === "not-published") return "All applicable retrieval stages were exhausted and this field was confirmed not published for this catalog.";
  if (code === "document-not-parsed") return "A source document was found but could not be parsed.";
  if (code === "scoping-failed") return "Source text could not be scoped safely to this catalog.";
  if (code === "source-fetched-no-label") return "A source was fetched, but no matching field label/value was found.";
  return "No source-backed value was found.";
}

function fieldCandidates(result: ProductResult, field: RegistryFieldKey): Array<{
  value: string;
  sourceUrl?: string;
  sourceType?: AttributeRecord["sourceType"];
  parser?: string;
  stage?: string;
  confidence?: number;
}> {
  if (field === "image") {
    return result.documents
      .filter((doc) => doc.type === "image")
      .map((doc) => ({ value: doc.localPath ?? doc.url, sourceUrl: doc.sourceUrl ?? doc.url, sourceType: doc.sourceType, parser: doc.parser, stage: doc.stage, confidence: doc.confidence }));
  }
  const documentType = documentTypeForField(field);
  if (documentType) {
    return result.documents
      .filter((doc) => doc.type === documentType)
      .map((doc) => ({ value: doc.url, sourceUrl: doc.url, sourceType: doc.sourceType, parser: doc.parser, stage: doc.stage, confidence: doc.confidence }));
  }

  const attrCandidates = result.attributes
    .filter((attr) => fieldMatchesLabel(field, fieldAttributeLabel(attr)))
    .map((attr) => ({ value: cleanText(attr.value), sourceUrl: attr.sourceUrl, sourceType: attr.sourceType, parser: attr.parser, stage: attr.stage, confidence: attr.confidence }));

  const normalized = normalizedFieldValue(result.normalized, field);
  if (!normalized) return attrCandidates.filter((candidate) => candidate.value);
  const sourceAttribute = findFieldSourceAttribute(result.attributes, field, normalized);

  return [
    {
      value: normalized,
      sourceUrl: sourceAttribute?.sourceUrl,
      sourceType: sourceAttribute?.sourceType ?? "generated",
      parser: sourceAttribute?.parser ?? "normalizer",
      stage: sourceAttribute?.stage ?? "normalize",
      confidence: sourceAttribute?.confidence ?? result.confidence
    },
    ...attrCandidates
  ].filter((candidate) => candidate.value);
}

function normalizedFieldValue(normalized: NormalizedProductFields, field: RegistryFieldKey): string | undefined {
  if (field === "image" || field === "datasheetUrl" || field === "manualUrl" || field === "certificateUrl" || field === "typeCode") return undefined;
  if (field === "operatingTemperature") {
    const min = normalized.operatingTemperatureMin;
    const max = normalized.operatingTemperatureMax;
    if (min && max) return `${min}..${max} °C`;
    if (min) return `>= ${min} °C`;
    if (max) return `<= ${max} °C`;
    return undefined;
  }
  return normalized[field];
}

function isDocumentUrlField(field: RegistryFieldKey): boolean {
  return field === "datasheetUrl" || field === "manualUrl" || field === "certificateUrl";
}

function documentTypeForField(field: RegistryFieldKey): DocumentRecord["type"] | undefined {
  if (field === "datasheetUrl") return "datasheet";
  if (field === "manualUrl") return "manual";
  if (field === "certificateUrl") return "certificate";
  return undefined;
}

function documentUrlFieldHealth(
  result: ProductResult,
  field: RegistryFieldDefinition,
  candidates: ReturnType<typeof fieldCandidates>,
  confidence: number | undefined,
  sourceUrls: string[],
  resultConfidence: number
): FieldHealthRecord {
  const selected = highestPriorityCandidate(candidates) ?? candidates[0];
  const value = selected?.value;
  if (!value) {
    return {
      field: field.key,
      label: field.label,
      status: "missing",
      reason: missingFieldReason(result, field.key),
      reasonCode: missingFieldReasonCode(result, field.key)
    };
  }
  const status = (confidence ?? resultConfidence) < 0.6 ? "low-confidence" : "found";
  return {
    field: field.key,
    label: field.label,
    status,
    value,
    confidence,
    sourceUrls,
    reason: status === "low-confidence"
      ? "Document URL exists, but the strongest source confidence is below the review threshold."
      : `Found ${candidates.length} ${field.label.toLowerCase()} document${candidates.length === 1 ? "" : "s"}; selected ${conflictSourcePriority(selected).reason}.`,
    reasonCode: status === "low-confidence" ? "label-found-value-rejected" : undefined
  };
}

function attributeValueMatches(attributeValue: string, normalizedValue: string): boolean {
  const attributeComparable = comparableValue(attributeValue);
  const normalizedComparable = comparableValue(normalizedValue);
  return Boolean(
    attributeComparable &&
    normalizedComparable &&
    (
      attributeComparable === normalizedComparable ||
      attributeComparable.includes(normalizedComparable) ||
      normalizedComparable.includes(attributeComparable)
    )
  );
}

function conflictingValues(candidates: ReturnType<typeof fieldCandidates>, preferredValue?: string): NonNullable<FieldHealthRecord["conflicts"]> {
  const selectedKey = comparableValue(preferredValue ?? highestPriorityCandidate(candidates)?.value ?? candidates[0]?.value ?? "");
  const groups = new Map<string, {
    display: string;
    sourceUrls: Set<string>;
    sourceTypes: Set<NonNullable<AttributeRecord["sourceType"]>>;
    parsers: Set<string>;
    stages: Set<string>;
    confidence?: number;
    priority?: number;
    priorityReason?: string;
  }>();
  for (const candidate of candidates) {
    const key = comparableValue(candidate.value);
    if (!key) continue;
    const priority = conflictSourcePriority(candidate);
    const existing = groups.get(key);
    if (existing) {
      if (candidate.sourceUrl) existing.sourceUrls.add(candidate.sourceUrl);
      if (candidate.sourceType) existing.sourceTypes.add(candidate.sourceType);
      if (candidate.parser) existing.parsers.add(candidate.parser);
      if (candidate.stage) existing.stages.add(candidate.stage);
      existing.confidence = Math.max(existing.confidence ?? 0, candidate.confidence ?? fallbackConfidence(candidate.sourceType));
      if ((priority.priority ?? 0) > (existing.priority ?? 0)) {
        existing.priority = priority.priority;
        existing.priorityReason = priority.reason;
      }
      continue;
    }
    groups.set(key, {
      display: candidate.value,
      sourceUrls: new Set(candidate.sourceUrl ? [candidate.sourceUrl] : []),
      sourceTypes: new Set(candidate.sourceType ? [candidate.sourceType] : []),
      parsers: new Set(candidate.parser ? [candidate.parser] : []),
      stages: new Set(candidate.stage ? [candidate.stage] : []),
      confidence: candidate.confidence ?? fallbackConfidence(candidate.sourceType),
      priority: priority.priority,
      priorityReason: priority.reason
    });
  }
  const values = [...groups.values()];
  if (values.length <= 1) return [];
  return values
    .map((entry) => ({
      value: entry.display,
      sourceUrls: [...entry.sourceUrls],
      confidence: entry.confidence,
      sourceTypes: [...entry.sourceTypes],
      parsers: [...entry.parsers],
      stages: [...entry.stages],
      priority: entry.priority,
      priorityReason: entry.priorityReason,
      selected: comparableValue(entry.display) === selectedKey
    }))
    .sort((left, right) => Number(right.selected) - Number(left.selected) || (right.priority ?? 0) - (left.priority ?? 0))
    .slice(0, 6);
}

function conflictResolutionReason(
  selectedValue: string | undefined,
  conflicts: NonNullable<FieldHealthRecord["conflicts"]>,
  selectedFromNormalizer: boolean
): string | undefined {
  if (!selectedValue) return "No preferred value was selected; all conflicting source values are retained for review.";
  const selected = conflicts.find((entry) => entry.selected);
  const source = selected?.parsers?.includes("customer-document")
    ? "customer document"
    : selected?.sourceTypes?.includes("official")
      ? "official source"
      : selected?.sourceTypes?.includes("generated")
        ? "parsed document"
        : "highest-ranked normalizer candidate";
  const priority = selected?.priorityReason ? ` (${selected.priorityReason})` : "";
  const confidence = selected?.confidence !== undefined ? ` Confidence ${selected.confidence.toFixed(2)}.` : "";
  const subject = selectedFromNormalizer ? "Normalized value" : "Preferred value";
  return `${subject} '${selectedValue}' was selected from ${source}${priority}; all conflicting source values are retained.${confidence}`;
}

function highestPriorityCandidate(candidates: ReturnType<typeof fieldCandidates>): ReturnType<typeof fieldCandidates>[number] | undefined {
  return candidates
    .filter((candidate) => comparableValue(candidate.value))
    .map((candidate, index) => ({ candidate, index, priority: conflictSourcePriority(candidate).priority }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)[0]?.candidate;
}

function conflictSourcePriority(candidate: {
  sourceType?: AttributeRecord["sourceType"];
  parser?: string;
  stage?: string;
  confidence?: number;
}): { priority: number; reason: string } {
  const parser = candidate.parser ?? "";
  const stage = candidate.stage ?? "";
  const sourceType = candidate.sourceType;
  let priority = 100;
  let reason = "lowest-priority source";
  if (/customer-document/i.test(parser) || /customer/i.test(stage)) {
    priority = 1000;
    reason = "customer-provided document priority";
  } else if (sourceType === "official" && /pdf|document|datasheet|manual/i.test(parser)) {
    priority = 880;
    reason = "official parsed document priority";
  } else if (sourceType === "official") {
    priority = 850;
    reason = "official product source priority";
  } else if (sourceType === "official-fallback") {
    priority = 720;
    reason = "official fallback source priority";
  } else if (sourceType === "generated" && /pdf|document|datasheet|manual/i.test(parser)) {
    priority = 690;
    reason = "parsed document priority";
  } else if (sourceType === "generated") {
    priority = 620;
    reason = "generated/normalized value priority";
  } else if (sourceType === "cache") {
    priority = 520;
    reason = "cached source priority";
  } else if (sourceType === "distributor") {
    priority = 300;
    reason = "distributor fallback priority";
  }
  if (candidate.confidence !== undefined) priority += Math.round(candidate.confidence * 20);
  return { priority, reason };
}

function comparableValue(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*(?:;|\|)\s*/g, ";")
    .trim();
}

function fallbackConfidence(sourceType: AttributeRecord["sourceType"] | DocumentRecord["sourceType"] | undefined): number {
  if (sourceType === "official") return 0.9;
  if (sourceType === "official-fallback") return 0.78;
  if (sourceType === "generated") return 0.68;
  if (sourceType === "distributor") return 0.45;
  return 0.55;
}
