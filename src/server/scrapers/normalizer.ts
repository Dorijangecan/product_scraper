import type { AttributeRecord, DocumentRecord, NormalizedProductFields, ProductResult } from "../../shared/types.js";
import { OUNCE_TO_KILOGRAM, POUND_TO_KILOGRAM } from "../unit-conversion.js";
import { dedupeAttributes as dedupeAttributesBase, dedupeDocuments as dedupeSharedDocuments } from "./dedupe.js";
import { evidenceConfidence } from "./evidence-score.js";
import { fieldDefinition, fieldMatchesLabel, normalizerFieldLabelPatterns, registryFieldQuantityKind, type NormalizedRegistryFieldKey } from "./field-registry.js";
import { isPlausibleTemperatureCelsius, parseQuantities, parseTemperatureRange } from "./quantity.js";
import { inferPropertyFromQuantities, isDisqualifiedForQuantityKind, matchProperty } from "./ontology.js";
import { cleanText, normalizeNumberSeparators } from "../text-util.js";

// cleanText/entity decoding now live in the leaf text-util module so field-registry can
// share the canonical cleaner without creating an import cycle.
export { cleanText };

export function splitNameValue(text: string): { name: string; value: string } | undefined {
  const cleaned = cleanText(text);
  if (!isLikelySpecText(cleaned)) return undefined;
  // Colon is the primary separator; also accept "=" (e.g. "R = 10 Ω", "Weight = 1.2 kg"). Colon is
  // tried first so a value that itself contains "=" isn't torn at the wrong place. The label is
  // capped at 80 chars so a whole prose sentence can't become a name. (Tab isn't handled here —
  // cleanText has already collapsed whitespace by this point; tab-separated table cells are split
  // upstream by splitPdfTableCells instead.)
  const match = cleaned.match(/^([^:]{2,80}):\s*(.+)$/) ?? cleaned.match(/^([^=]{2,80})=\s*(.+)$/);
  if (!match) return undefined;
  const name = cleanText(match[1]);
  // A "name" that is itself a bare value (a measurement like "120 W" / "6 kA", a parenthetical unit
  // conversion like "(1.65 lb)", or a lone number) is a mis-split value cell, not a label — emitting
  // it produces junk attributes (confirmed in the unmapped-label audit). "W x H x D" is deliberately
  // NOT rejected: it is a legitimate dimensions label.
  if (isValueFragmentLabel(name)) return undefined;
  return { name, value: cleanText(match[2]) };
}

/** True when a candidate label is actually a value fragment (measurement / parenthetical unit /
 * bare number), which must never be stored as an attribute name. */
export function isValueFragmentLabel(name: string): boolean {
  const t = name.trim();
  if (!t) return true;
  if (/^\([^)]*\d[^)]*\)$/.test(t)) return true; // "(0.60 lb)", "(1.54 x 4.88 in.)"
  if (/^[+-]?\d+(?:[.,]\d+)?$/.test(t)) return true; // pure number
  // "120 W", "20 A", "6 kA", "-40 °C", "2.5 mm²" — a leading number followed only by a unit token
  if (/^[+-]?\d+(?:[.,]\d+)?\s*[a-zµΩ°%/().²³]+$/i.test(t)) return true;
  return false;
}

/* Historical pre-registry normalizer map retained in source comments only while reviewing this
 * mechanical migration. Runtime normalization reads normalizerFieldLabelPatterns from field-registry. */
/*
  weight: [
    /weight/,
    /\bmass\b/,
    /net.*weight/,
    /gross.*weight/,
    /gewicht/,
    /masse\b/,
    /massa/,
    /peso/,
    /te[z\u017e]ina/,
    /\u91cd\u91cf/
  ],
  dimensions: [
    /\bdimensions?\b/,
    /\bdimensioni\b/,
    /\babmessungen\b/,
    /\babmessung\b/,
    /\bma(?:sse|\u00dfe)\b/,
    /\bmasse\b/,
    /\bdimenzije\b/,
    /\bcable length\b/,
    /\u5c3a\u5bf8/
  ],
  material: [
    /\bmaterial\b/,
    /\bmaterials\b/,
    /\bwerkstoff\b/,
    /\bmaterijal\b/,
    /\bmateriale\b/,
    /housing.*material/,
    /enclosure.*material/,
    /body.*material/,
    /cover.*material/,
    /cable.*material/
  ],
  wallThickness: [
    /\bwall\s+thickness\b/,
    /\bthickness\b/,
    /\bmaterial\s+thickness\b/,
    /\bsheet\s+thickness\b/,
    /\bbody\s+thickness\b/,
    /\bdoor\s+thickness\b/,
    /\bgauge\b/
  ],
  finish: [
    /\bfinish\b/,
    /\bfinishes\b/,
    /\bsurface\s+(?:finish|finishing|treatment|coating)\b/,
    /\bcoating\b/,
    /\bpaint\b/,
    /\bpowder\s+coat/,
    /\bfarbe\b/
  ],
  color: [
    /\bcolou?r\b/,
    /\bfarbe\b/
  ],
  voltage: [
    /voltage/,
    /\bvolts?\b/,
    /\bspannung\b/,
    /\boperating voltage\b/,
    /\brated voltage\b/,
    /\brated.*voltage\b/,
    /\boperational.*voltage\b/,
    /\bcontrol.*circuit.*voltage\b/,
    /\binput voltage\b/,
    /\binput power\b/,
    /\bpower input\b/,
    /\bnominal voltage\b/,
    /\bcontinuous operating voltage\b/,
    /\bmaximum operating voltage\b/,
    /\bvoltage protection level\b/,
    /napon/,
    /\u7535\u538b/,
    // Ue/Un/Ur (operational/nominal/rated) and Ua/Ub/Us (output/supply) are real operating-voltage
    // symbols. Ui (insulation voltage) and Uimp (impulse withstand voltage) are deliberately excluded
    // \u2014 they are NOT the operating voltage and used to leak into it; the ontology keeps them as
    // separate insulationVoltage / impulseVoltage properties.
    /\b(?:u[ern]|u[abs])\b/
  ],
  current: [
    /\brated.*current\b/,
    /\boperational.*current\b/,
    /\brated current\b/,
    /\bcurrent ratings?\b/,
    /\bamps?\b/,
    /\bamperes?\b/,
    /\bcurrent consumption\b/,
    /\boutput current\b/,
    /\binput current\b/,
    /\bthermal current\b/,
    /\bthermal protection adjustment range\b/,
    /\bcontinuous current\b/,
    /\bampere rating\b/,
    // "Switching capacity"/"switching current" are kept: for a relay/thermostat/contactor these ARE
    // the contact current rating in A (e.g. nVent thermostat "10 A resistive / 4 A inductive"), and
    // the scoring below ranks them below a genuine "rated current" so a breaker that has both still
    // prefers the real rated current.
    /\bswitching capacity\b/,
    /\bswitching current\b/,
    // Deliberately EXCLUDED: nominal discharge current / impulse current / short-circuit
    // (breaking|capacity|current). Those are kA fault/surge ratings, not the rated operational
    // current, and used to overwrite `current` when they were the only current-shaped attribute
    // (confirmed on breakers/SPDs). The ontology keeps them as separate breakingCapacity /
    // inrushCurrent properties, so nothing is lost — only the mis-attribution.
    /\bshort-?time.*current\b/,
    /\bcurrent\b/,
    /\bstrom\b/,
    /amperage/,
    /corrente/,
    /struja/,
    /\u7535\u6d41/
  ],
  protection: [
    /\bip\b/,
    /nema/,
    /protection/,
    /schutzart/,
    /degree of protection/,
    /environmental rating/,
    /\benclosure\b/,
    /enclosure rating/,
    /enclosure type/,
    /industry standard/,
    /stupanj/,
    /\u9632\u62a4\u7b49\u7ea7/,
    /\u4fdd\u62a4\u7b49\u7ea7/
  ],
  certificates: [
    /\bapproval\b/,
    /\bconformity\b/,
    /\bcertificates?\b/,
    /\bcertifications?\b/,
    /\bapprovals?\b/,
    /\bstandards?\b/,
    /\bmarking\b/,
    /\bul\b/,
    /\bce\b/,
    /\brohs\b/,
    /\bweee\b/,
    /\breach\b/
  ],
  operatingTemperatureMin: [
    /\b(operating|operational|ambient|working|surrounding|service)\b[^.;|]*\btemp(?:erature)?\b/,
    /\btemperature range\b/,
    /\bumgebungstemperatur\b/,
    /\bbetriebstemperatur\b/,
    /\u5de5\u4f5c\u6e29\u5ea6/,
    /\u73af\u5883\u6e29\u5ea6/
  ],
  operatingTemperatureMax: [
    /\b(operating|operational|ambient|working|surrounding|service)\b[^.;|]*\btemp(?:erature)?\b/,
    /\btemperature range\b/,
    /\bumgebungstemperatur\b/,
    /\bbetriebstemperatur\b/,
    /\u5de5\u4f5c\u6e29\u5ea6/,
    /\u73af\u5883\u6e29\u5ea6/
  ]
};
*/

export function normalizeFields(attributes: AttributeRecord[], documents: DocumentRecord[]): NormalizedProductFields {
  const findAttr = (...patterns: RegExp[]) => {
    return bestAttributeValue(attributes, patterns);
  };

  const heightAttr = bestDimensionAxisAttribute(attributes, "height");
  const widthAttr = bestDimensionAxisAttribute(attributes, "width");
  const depthAttr = bestDimensionAxisAttribute(attributes, "depth");
  const lengthAttr = bestDimensionAxisAttribute(attributes, "length");
  const cableLengthDimension = bestCableLengthDimensionValue(attributes);
  const axisAssembledDimensions = normalizeDimensionValue(
    formatDimensions(heightAttr?.value, widthAttr?.value, depthAttr?.value, lengthAttr?.value)
  );
  const combinedDimensionsAttr = attributes
    .filter((attr) => {
      const haystack = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      // FIELD_LABEL_PATTERNS.dimensions matches on GROUP text too (e.g. "Rockwell Dimensions"), so
      // a bare single-axis attribute like name="Height" would otherwise ALSO qualify as a "combined
      // Dimensions string" candidate purely because it sits in a dimensions-named group — stealing
      // this arbitration's role from the genuine combined "H x W x D" attribute it's supposed to
      // compete against (confirmed live: with an "official" sourceType bump, a bare 0.7-confidence
      // "Height" attribute out-scored the real 0.85-confidence combined "Dimensions" attribute this
      // way, defeating the whole point of comparing them). Single-axis attributes are already
      // handled via bestDimensionAxisAttribute above; exclude them here.
      if (/^(?:height|width|depth|length)$/i.test(attr.name.trim())) return false;
      return normalizerFieldLabelPatterns("dimensions").some((pattern) => pattern.test(haystack)) && isLikelySpecText(attr.value) && isAvailableSpecValue(attr.value);
    })
    .sort((left, right) => dimensionsFieldScore(right) - dimensionsFieldScore(left))
    // The GROUP-based match above still lets an unrelated same-group attribute through (e.g.
    // "Rockwell Dimensions"/"Weight" — same group as the real Height/Width/Length entries, but its
    // OWN value is a weight reading, not a dimension) — skip to the next-best-scored candidate
    // whose value doesn't actually normalize as a dimension, mirroring how the old
    // bestNormalizedAttributeValue(..., "dimensions") call already tolerated this via its own
    // normalize-then-filter chain, rather than picking the top score unconditionally.
    .find((attr) => normalizeDimensionValue(attr.value));
  // Assembling H/W/D/L from separately-labeled axis attributes used to ALWAYS take priority over a
  // single combined "Dimensions" string, regardless of which one is actually better evidenced —
  // confirmed live on Rockwell's 1606-XLSBAT5: the digital product passport's Height/Width/Length
  // (confidence deliberately dropped to 0.7 — see dppAttributeConfidence in rockwell.ts — because
  // they read like rounded PACKAGING-box dimensions, not the product's own) had no competing
  // Height/Width/Length from anywhere else to lose to, so they trivially "won" their own per-axis
  // comparison and got assembled into a full W x H x D string BEFORE this function ever looked at
  // the datasheet PDF's own, much better evidenced combined "Dimensions" attribute (0.85, "PDF
  // Catalog Table Row") — even though that one is correct and the assembled one is wrong (90 x 106
  // x 70 mm vs. an assembled ~152 x 157 x 190 mm).
  //
  // Compare raw `confidence` directly rather than the full attributeEvidenceScore/dimensionsFieldScore
  // — those also weigh `sourceType`, and stampDocumentAttributes (document-enrichment.ts) marks
  // EVERY document-sourced attribute (including this exact "PDF Catalog Table Row" one) as
  // sourceType "generated" regardless of how well-verified its confidence is, which would otherwise
  // swamp a 0.85-vs-0.7 confidence gap under a same-source-type-vs-different-source-type gap that
  // has nothing to do with THIS arbitration. An attribute with no explicit confidence at all is
  // treated as maximally trusted (1) so the many manufacturers/attributes that never set one keep
  // today's unconditional axis-assembly-wins behavior unchanged — this only kicks in when the axis
  // reading carries an explicit, lower self-reported confidence than a combined attribute that beats
  // it outright.
  const axisAttrs = [heightAttr, widthAttr, depthAttr ?? lengthAttr].filter((attr): attr is AttributeRecord => Boolean(attr));
  const weakestAxisConfidence = axisAttrs.length ? Math.min(...axisAttrs.map((attr) => attr.confidence ?? 1)) : -Infinity;
  const combinedDimensionsValue = combinedDimensionsAttr ? normalizeDimensionValue(combinedDimensionsAttr.value) : undefined;
  const preferAxisAssembly =
    Boolean(axisAssembledDimensions) && (!combinedDimensionsValue || weakestAxisConfidence >= (combinedDimensionsAttr?.confidence ?? 1));
  const dimensions =
    (preferAxisAssembly ? axisAssembledDimensions : undefined) ??
    combinedDimensionsValue ??
    axisAssembledDimensions ??
    registryFieldValue(attributes, "dimensions", normalizeDimensionValue) ??
    deriveDimensionsFromText(attributes) ??
    cableLengthDimension;
  const material =
    findMaterialAttr(attributes) ??
    registryFieldValue(attributes, "material", materialValueFromText) ??
    deriveMaterialFromAttributes(attributes) ??
    ontologyFieldValue(attributes, "material", materialValueFromText);
  const finish =
    normalizeFinishValue(bestAttributeValue(attributes, normalizerFieldLabelPatterns("finish"))) ??
    registryFieldValue(attributes, "finish", (value) => finishPhraseFromText(value) ?? normalizeFinishValue(value)) ??
    deriveFinishFromAttributes(attributes) ??
    deriveFinishFromMaterial(material) ??
    ontologyFieldValue(attributes, "finish", (value) => finishPhraseFromText(value) ?? normalizeFinishValue(value));
  const finishForColor = normalizeFinishValue(bestAttributeValue(attributes.filter((attr) => attr.scope !== "variant-option"), normalizerFieldLabelPatterns("finish")));
  const wallThickness = bestWallThicknessAttributeValue(attributes) ?? registryFieldValue(attributes, "wallThickness", normalizeWallThicknessValue) ?? deriveWallThicknessFromAttributes(attributes);
  const color = withoutForeignQuantityKinds(
    findColorAttr(attributes) ??
      registryFieldValue(attributes, "color", deriveColorFromFinish) ??
      deriveColorFromFinish(finishForColor) ??
      deriveColorFromMaterial(material) ??
      ontologyFieldValue(attributes, "color", deriveColorFromFinish) ??
      deriveColorFromProseAttributes(attributes)
  );

  const protectionFromAttr =
    collectProtectionValues(attributes) ??
    deriveProtectionFromText(attributes) ??
    registryFieldValue(attributes, "protection", normalizeProtectionValue) ??
    ontologyFieldValue(attributes, "protection", normalizeProtectionValue);
  // If the manufacturer publishes an explicit "Standards" attribute (e.g. ABB's "Standards: IEC/UL"),
  // that IS the curated certification list — don't pollute it with document-derived RoHS / REACH
  // declarations, which aren't certifications in the same sense and only appear because the
  // datasheet links to a PDF declaration of compliance. Without this guard, ABB's expected
  // "IEC, UL" becomes "RoHS, UL, IEC, REACh Regulation".
  const explicitStandardsAttr = attributes.find(
    (attr) => /^standards?$/i.test(attr.name) && /\b(?:IEC|UL|CSA|CE|EN|ISO|DIN|VDE|JIS|UKCA)\b/.test(attr.value)
  );
  const literalCertificateValues = literalCertificateAttributeValues(attributes);
  const certificateValues = [
    ...(literalCertificateValues.length
      ? literalCertificateValues
      : attributes
          .filter((attr) => fieldMatchesLabel("certificates", `${attr.group ?? ""} ${attr.name}`))
          .flatMap((attr) => splitCertificateValues(normalizeCertificateValue(attr.value, true)))),
    ...(explicitStandardsAttr || literalCertificateValues.length
      ? []
      : documents
          .filter(
            (doc) =>
              !/\bwarranty\b/i.test(doc.label) &&
              (doc.type === "certificate" || /\b(certificate|declaration|conformity|rohs|weee|ce declaration)\b/i.test(doc.label))
          )
          .flatMap((doc) => splitCertificateValues(normalizeDocumentCertificateValue(doc))))
  ];
  const certificateTokens = literalCertificateValues.length
    ? uniqueLiteralCertificateTokens(certificateValues)
    : removeSubsumedCertificateTokens(uniqueCertificateTokens(certificateValues)).sort(compareCertificateToken);
  const certificates = certificateTokens.join(", "); // Comma-space matches the format used in manual PDTs (ABB: "IEC, UL"; Rockwell: "c-UL-us, FM, CE...").

  const voltage = withoutMixedKindProse(
    normalizeVoltageValue(deriveVoltageRangeFromMinMax(attributes)) ??
    powerSupplyOutputVoltage(attributes) ??
    numericVoltAttributeVoltage(attributes) ??
    bestNormalizedAttributeValue(attributes, normalizerFieldLabelPatterns("voltage"), normalizeVoltageValue, "voltage") ??
    registryFieldValue(attributes, "voltage", normalizeVoltageValue) ??
    normalizeVoltageValue(deriveVoltageFromText(attributes)) ??
    // Last resort: the ontology recognises FR/IT/DE voltage labels that FIELD_LABEL_PATTERNS
    // (mostly EN/DE) miss. Most-specific matchProperty keeps insulation/impulse voltage out.
      ontologyFieldValue(attributes, "ratedVoltage", normalizeVoltageValue) ??
      inferredOntologyFieldValue(attributes, "ratedVoltage", normalizeVoltageValue)
  );
  const current = withoutMixedKindProse(
    numericCurrentAttributeCurrent(attributes) ??
      bestNormalizedAttributeValue(attributes, normalizerFieldLabelPatterns("current"), normalizeCurrentValue, "current") ??
      registryFieldValue(attributes, "current", normalizeCurrentValue) ??
      normalizeCurrentValue(deriveCurrentFromText(attributes)) ??
      ontologyFieldValue(attributes, "ratedCurrent", normalizeCurrentValue) ??
      inferredOntologyFieldValue(attributes, "ratedCurrent", normalizeCurrentValue)
  );

  const operatingTemperature = deriveOperatingTemperature(attributes);

  return {
    weight: bestNormalizedAttributeValue(attributes, normalizerFieldLabelPatterns("weight"), normalizeWeightValue, "weight") ?? registryFieldValue(attributes, "weight", normalizeWeightValue) ?? ontologyFieldValue(attributes, "weight", normalizeWeightValue) ?? inferredOntologyFieldValue(attributes, "weight", normalizeWeightValue),
    dimensions,
    material,
    wallThickness,
    finish,
    color,
    voltage,
    current,
    protection: protectionFromAttr,
    certificates: certificates || undefined,
    operatingTemperatureMin: operatingTemperature.min,
    operatingTemperatureMax: operatingTemperature.max
  };
}

/**
 * Understand an operating/ambient temperature range from explicitly temperature-labelled
 * attributes only — never from a current/power de-rating row or a "color temperature" spec.
 * Uses the quantity grammar (workstream B-1) so messy ranges ("-40 to +80 °C", "-20 °C bis
 * +55 °C", "Temperature range -40 do 70") and condition temps ("70 A at 40 °C") are handled.
 */
function deriveOperatingTemperature(attributes: AttributeRecord[]): { min?: string; max?: string } {
  const label = (attr: AttributeRecord): string => `${attr.group ?? ""} ${attr.name}`;
  const isTemperatureLabel = (attr: AttributeRecord): boolean =>
    /\b(operating|operational|ambient|working|surrounding|service)\b[^.;|]*\btemp(?:erature)?\b/i.test(label(attr)) ||
    /\btemp(?:erature)?\b[^.;|]*\b(operating|operational|ambient|working|surrounding|service)\b/i.test(label(attr)) ||
    /\b(operating|ambient)\s+temperature\b/i.test(label(attr)) ||
    /\btemperature range\b/i.test(label(attr)) ||
    /\bumgebungstemperatur\b|\bbetriebstemperatur\b/i.test(label(attr)) ||
    fieldMatchesLabel("operatingTemperature", label(attr));
  const isExcludedLabel = (attr: AttributeRecord): boolean =>
    /\b(current|strom|storage|lager|colou?r\s+temp(?:erature)?|color\s+temp)\b/i.test(label(attr)) ||
    // A SET POINT is the temperature the device can be adjusted TO; the operating temperature is the
    // ambient range it tolerates. Different properties entirely — a thermostat adjustable to 60 °C is
    // not a thermostat rated for 60 °C ambient. Confirmed on nVent SPEC-00583, whose
    // "Temperature Set Point (adjustable)" row was being recorded as the operating range.
    /\b(set\s?point|setpoint|sollwert|consigne|adjustment\s+range|einstellbereich)\b/i.test(label(attr));

  const fromText = (text: string): { min?: string; max?: string } | undefined => {
    const range = parseTemperatureRange(text);
    if (range.min === undefined && range.max === undefined) return undefined;
    // Reject physically impossible operating temperatures so a misparse never reaches the PDT.
    if (range.min !== undefined && !isPlausibleTemperatureCelsius(range.min)) return undefined;
    if (range.max !== undefined && !isPlausibleTemperatureCelsius(range.max)) return undefined;
    return {
      min: range.min !== undefined ? formatTemperatureBound(range.min) : undefined,
      max: range.max !== undefined ? formatTemperatureBound(range.max) : undefined
    };
  };

  // 1) Explicitly temperature-labelled attributes (most reliable).
  for (const attr of attributes) {
    if (!attr.value || !isTemperatureLabel(attr) || isExcludedLabel(attr)) continue;
    const result = fromText(`${attr.name}: ${attr.value}`);
    if (result) return result;
  }

  // 2) Prose fallback: mine the operating/ambient temperature out of a long description, but only
  // when the text explicitly mentions temperature/°C (parseTemperatureRange already ignores
  // de-rating conditions and storage temps). This is the "buried in a sentence" case.
  for (const attr of attributes) {
    if (!attr.value || isExcludedLabel(attr)) continue;
    if (!/\b(catalog description|long description|short description|product description|description|features?|technical data|specifications?)\b/i.test(label(attr))) continue;
    if (!/\btemp(?:erature|eratur)?\b|°\s*c|℃/i.test(attr.value)) continue;
    const result = fromText(attr.value);
    if (result) return result;
  }

  // 3) Separate min/max ROWS, the unit living in the label:
  //      "Ambient temperature min. (°C)" = "-30"
  //      "Ambient temperature max. (°C)" = "85"
  // Neither row carries a range, so the two passes above see nothing at all. This layout is the norm for
  // sensor vendors (found on a real Turck page, where both rows were extracted as attributes and the
  // temperature fields still came out empty).
  return temperatureFromSeparateMinMaxRows(attributes, isTemperatureLabel, isExcludedLabel);
}

/** Label without its min/max qualifier or its parenthesised unit, so the two rows can be paired. */
function minMaxTemperatureLabelBase(label: string): string {
  return cleanText(
    label
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b(?:min|max|minimum|maximum|minimal|maximal)\b\.?/gi, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
  ).toLowerCase();
}

/** The unit a label declares in brackets — "(°C)", "(°F / °C)", "(C)". */
function temperatureUnitFromLabel(label: string): string | undefined {
  const group = /\(([^)]*)\)/.exec(label)?.[1] ?? "";
  if (/℃|°\s*c\b|\bc\b/i.test(group) && !/°\s*f\b|\bf\b/i.test(group)) return "°C";
  if (/°\s*f\b|\bf\b/i.test(group) && !/℃|°\s*c\b|\bc\b/i.test(group)) return "°F";
  return undefined;
}

function temperatureFromSeparateMinMaxRows(
  attributes: AttributeRecord[],
  isTemperatureLabel: (attr: AttributeRecord) => boolean,
  isExcludedLabel: (attr: AttributeRecord) => boolean
): { min?: string; max?: string } {
  const candidates = attributes.filter(
    (attr) =>
      attr.value &&
      isTemperatureLabel(attr) &&
      !isExcludedLabel(attr) &&
      /\b(?:min|max|minimum|maximum|minimal|maximal)\b/i.test(`${attr.group ?? ""} ${attr.name}`)
  );

  const boundOf = (attr: AttributeRecord): number | undefined => {
    const label = `${attr.group ?? ""} ${attr.name}`;
    // The value is a bare number, so the unit has to come from the label. Feeding "-30 °C" through
    // parseQuantities reuses the existing °F→°C conversion instead of duplicating it here.
    const unit = temperatureUnitFromLabel(label) ?? "°C";
    const [quantity] = parseQuantities(`${attr.value} ${unit}`, { kind: "temperature" });
    const bound = quantity?.value ?? quantity?.min ?? quantity?.max;
    return bound !== undefined && isPlausibleTemperatureCelsius(bound) ? bound : undefined;
  };

  for (const minAttr of candidates) {
    const minLabel = `${minAttr.group ?? ""} ${minAttr.name}`;
    if (!/\b(?:min|minimum|minimal)\b/i.test(minLabel)) continue;
    const base = minMaxTemperatureLabelBase(minLabel);
    const maxAttr = candidates.find((attr) => {
      const maxLabel = `${attr.group ?? ""} ${attr.name}`;
      return /\b(?:max|maximum|maximal)\b/i.test(maxLabel) && minMaxTemperatureLabelBase(maxLabel) === base;
    });
    if (!maxAttr) continue;
    const min = boundOf(minAttr);
    const max = boundOf(maxAttr);
    if (min === undefined || max === undefined || min >= max) continue;
    return { min: formatTemperatureBound(min), max: formatTemperatureBound(max) };
  }
  return {};
}

function formatTemperatureBound(value: number): string {
  return String(Number(value.toFixed(6)));
}

/**
 * General gap-fill via the property ontology (B-2): when the field-specific extractors above found
 * nothing, look for an attribute whose label MEANS this field (any language the ontology knows,
 * incl. FR/IT labels the FIELD_LABEL_PATTERNS miss) and run its value through the SAME value
 * normalizer used elsewhere — so we only ever add a clean, source-backed value, never raw text.
 */
function ontologyFieldValue(
  attributes: AttributeRecord[],
  key: string,
  normalize: (value: string) => string | undefined
): string | undefined {
  for (const attr of attributes) {
    if (!attr.value || !isLikelySpecText(attr.value) || !isAvailableSpecValue(attr.value)) continue;
    const label = `${attr.group ?? ""} ${attr.name}`;
    const property = matchProperty(label);
    if (property?.key !== key) continue;
    // The ontology already knows what kind of quantity this property carries, so the guard needs no
    // per-key condition here — see isDisqualifiedForQuantityKind.
    if (property.unitKind && isDisqualifiedForQuantityKind(label, attr.value, property.unitKind)) continue;
    const value = normalize(attr.value);
    if (value) return value;
  }
  return undefined;
}

/**
 * Very-last-resort sibling of ontologyFieldValue for labels in languages/phrasings NO synonym
 * list knows yet: classify by the VALUE's unit instead (see inferPropertyFromQuantities and
 * its multilingual danger-qualifier blocklists). Only consulted for labels matchProperty
 * cannot place at all, so an explicit synonym match always wins.
 */
function inferredOntologyFieldValue(
  attributes: AttributeRecord[],
  key: string,
  normalize: (value: string) => string | undefined
): string | undefined {
  for (const attr of attributes) {
    if (!attr.value || !isLikelySpecText(attr.value) || !isAvailableSpecValue(attr.value)) continue;
    const label = `${attr.group ?? ""} ${attr.name}`;
    if (matchProperty(label)) continue;
    const inferred = inferPropertyFromQuantities(label, attr.value)?.property;
    if (inferred?.key !== key) continue;
    if (inferred.unitKind && isDisqualifiedForQuantityKind(label, attr.value, inferred.unitKind)) continue;
    const value = normalize(attr.value);
    if (value) return value;
  }
  return undefined;
}

function registryFieldValue(
  // Not `keyof NormalizedProductFields`: two of those keys have no registry entry, and passing one used to
  // compile and then return undefined forever. See NormalizedRegistryFieldKey.
  attributes: AttributeRecord[],
  key: NormalizedRegistryFieldKey,
  normalize: (value: string) => string | undefined
): string | undefined {
  return attributes
    .filter((attr) => {
      if (!attr.value || !isLikelySpecText(attr.value) || !isAvailableSpecValue(attr.value)) return false;
      if (shouldSkipRegistryFieldCandidate(attr, key)) return false;
      return fieldMatchesLabel(key, `${attr.group ?? ""} ${attr.name}`);
    })
    .sort((left, right) => attributeEvidenceScore(right) + normalizedFieldLabelScore(right, key) - attributeEvidenceScore(left) - normalizedFieldLabelScore(left, key))
    .map((attr) => normalize(attr.value) ?? normalize(`${attr.name}: ${attr.value}`))
    .find((value): value is string => Boolean(value));
}

function shouldSkipRegistryFieldCandidate(attr: AttributeRecord, key: keyof NormalizedProductFields): boolean {
  const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
  const kind = registryFieldQuantityKind(key);
  if (kind && isDisqualifiedForQuantityKind(label, attr.value, kind)) return true;
  if (registryFieldContradictsOntology(key, label)) return true;
  return normalizedFieldLabelScore(attr, key) < -50;
}

/**
 * The ontology decides WHICH field; the registry only widens the vocabulary that reaches it.
 *
 * The registry's aliases are deliberately loose — `/\blength\b/` for dimensions, `/\bmaterials?\b/` for
 * material — so that an unfamiliar vendor phrasing still lands somewhere. The cost is that a loose alias
 * also claims labels that name a different property entirely, and `audit:labels` section E enumerated 17 of
 * them across the two systems' own vocabularies. The ones that would ship a wrong value:
 *   "Rated residual current (RCD)"  → 30 mA into `current`, where the rating is 40 A
 *   "Let-through current / I²t"     → a kA²s fault figure into `current`
 *   "Leakage / off-state current"   → µA into `current`
 *   "Stripping length" / "Stroke"   → a detail measurement into `dimensions`
 *   "Material thickness"            → "1.5 mm" into the `material` TEXT column
 *   "Enclosure protection"          → an IP rating into `material`
 * None of these can be caught by the quantity-kind guard: some share the field's kind exactly (a residual
 * current is still a current) and `material` has no kind at all.
 *
 * So when the ontology CAN place a label, and places it somewhere this field is not meant to carry, the
 * registry defers. When the ontology cannot place it at all, the registry's guess stands — that is what the
 * loose aliases are for, and it is what keeps unfamiliar vendors working.
 */
function registryFieldContradictsOntology(key: keyof NormalizedProductFields, label: string): boolean {
  const expected = fieldDefinition(key)?.ontologyKeys;
  if (!expected) return false;
  const property = matchProperty(label);
  if (!property || expected.includes(property.key)) return false;

  // A CROSS-KIND mismatch is not a contradiction, it is an ambiguous label — and the value's own unit
  // already settles those, so deferring here would throw away real data. "Input Power" resolves to the
  // power property, yet SCE publishes "Input Power: 85 to 264 VDC"; the regression suite lost that voltage
  // until this exception existed. What this rule is for is the SAME-kind sibling, where no unit can tell
  // the two apart: a residual current and a rated current are both amperes, and only the label knows that
  // 30 mA is the trip threshold of a 40 A device.
  const fieldKind = registryFieldQuantityKind(key);
  if (fieldKind && property.unitKind && property.unitKind !== fieldKind) return false;
  return true;
}

function mergeLocalizedDescriptions(
  primary: ProductResult["localizedDescriptions"],
  fallback: ProductResult["localizedDescriptions"]
): ProductResult["localizedDescriptions"] {
  if (!primary && !fallback) return undefined;
  const result: NonNullable<ProductResult["localizedDescriptions"]> = {};
  const locales: Array<"de"> = ["de"];
  for (const locale of locales) {
    const p = primary?.[locale];
    const f = fallback?.[locale];
    if (!p && !f) continue;
    const title = p?.title ?? f?.title;
    const description = p?.description ?? f?.description;
    if (title || description) result[locale] = { title, description };
  }
  return Object.keys(result).length ? result : undefined;
}

export function mergeResults(primary: ProductResult, fallback?: ProductResult): ProductResult {
  if (!fallback) return primary;
  // Sort merged attributes deterministically so byte-for-byte reproducibility is possible
  // across runs that hit primary/fallback in different orders.
  const attributes = sortAttributesStable(dedupeAttributes([...primary.attributes, ...fallback.attributes]));
  const documents = dedupeDocuments([...primary.documents, ...fallback.documents]);
  const normalized = mergeNormalizedFields(
    normalizeFields(attributes, documents),
    primary.normalized,
    fallback.normalized,
    attributes
  );
  const hasFallbackAdditions = fallback.status !== "failed" && (fallback.attributes.length > 0 || fallback.documents.length > 0);
  return {
    ...primary,
    status: primary.status === "failed" && fallback.status !== "failed" ? fallback.status : primary.status,
    confidence: Math.max(primary.confidence, hasFallbackAdditions ? Math.min(fallback.confidence, 0.7) : 0),
    productUrl: primary.productUrl ?? fallback.productUrl,
    localizedUrls: {
      ...fallback.localizedUrls,
      ...primary.localizedUrls
    },
    title: primary.title ?? fallback.title,
    description: primary.description ?? fallback.description,
    localizedDescriptions: mergeLocalizedDescriptions(primary.localizedDescriptions, fallback.localizedDescriptions),
    normalized,
    attributes,
    documents,
    sources: [...primary.sources, ...fallback.sources],
    evidence: [...(primary.evidence ?? []), ...(fallback.evidence ?? [])],
    error: primary.status === "failed" && fallback.status !== "failed" ? undefined : primary.error
  };
}

function bestAttributeValue(attributes: AttributeRecord[], patterns: RegExp[]): string | undefined {
  return attributes
    .filter((attr) => {
      const haystack = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      return patterns.some((pattern) => pattern.test(haystack)) && isLikelySpecText(attr.value) && isAvailableSpecValue(attr.value);
    })
    .sort(compareAttributeEvidence)[0]?.value;
}

function bestWallThicknessAttributeValue(attributes: AttributeRecord[]): string | undefined {
  const attr = attributes
    .filter((candidate) => {
      const haystack = `${candidate.group ?? ""} ${candidate.name}`.toLowerCase();
      return normalizerFieldLabelPatterns("wallThickness").some((pattern) => pattern.test(haystack)) && isLikelySpecText(candidate.value) && isAvailableSpecValue(candidate.value);
    })
    .sort(compareAttributeEvidence)[0];
  return attr ? normalizeWallThicknessValue(`${attr.name} ${attr.value}`) : undefined;
}

function bestNormalizedAttributeValue(
  attributes: AttributeRecord[],
  patterns: RegExp[],
  normalize: (value: string | undefined) => string | undefined,
  field?: keyof NormalizedProductFields
): string | undefined {
  return attributes
    .filter((attr) => {
      const haystack = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      const kind = field ? registryFieldQuantityKind(field) : undefined;
      if (kind && isDisqualifiedForQuantityKind(haystack, attr.value, kind)) return false;
      // `patterns` here is FIELD_LABEL_PATTERNS — a third label vocabulary, even looser than the
      // registry's aliases (`/voltage/`, `/weight/` with no word boundary at all). It needs the same
      // deference to the ontology, and measurement says so: with the check only in
      // shouldSkipRegistryFieldCandidate, "Rated residual current 30 mA" still reached the current field
      // through this path, because this path never consults the registry.
      if (field && registryFieldContradictsOntology(field, haystack)) return false;
      return patterns.some((pattern) => pattern.test(haystack)) && isLikelySpecText(attr.value) && isAvailableSpecValue(attr.value);
    })
    .sort((left, right) => attributeEvidenceScore(right) + normalizedFieldLabelScore(right, field) - attributeEvidenceScore(left) - normalizedFieldLabelScore(left, field))
    .map((attr) => normalize(attr.value))
    .find((value): value is string => Boolean(value));
}

function powerSupplyOutputVoltage(attributes: AttributeRecord[]): string | undefined {
  if (!isPowerSupplyProduct(attributes)) return undefined;
  return attributes
    .filter((attr) => {
      const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      return isPowerSupplyOutputVoltageLabel(label) && isLikelySpecText(attr.value) && isAvailableSpecValue(attr.value);
    })
    .sort(compareAttributeEvidence)
    .map((attr) => normalizeVoltageValue(attr.value))
    .find((value): value is string => Boolean(value));
}

function isPowerSupplyProduct(attributes: AttributeRecord[]): boolean {
  return attributes.some((attr) => {
    const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
    if (!/product|range|description|title|family|type|name/.test(label)) return false;
    return /\bpower suppl(?:y|ies)\b/i.test(`${attr.name} ${attr.value}`);
  });
}

function isPowerSupplyOutputVoltageLabel(label: string): boolean {
  if (/\b(?:discrete|relay|minimum|maximum|min|max|drop|limits?|threshold|contact)\b/.test(label)) return false;
  return /(?:^|\s)(?:power supply )?output voltage$|(?:^|\s)(?:rated|nominal) output voltage$/.test(label);
}

function numericVoltAttributeVoltage(attributes: AttributeRecord[]): string | undefined {
  return bestNumericElectricalAttribute(attributes, /\bvolts?\b/i, "V");
}

function numericCurrentAttributeCurrent(attributes: AttributeRecord[]): string | undefined {
  return bestNumericElectricalAttribute(attributes, /\b(?:max\.?\s*current|rated current|current ratings?|ampere rating|amperage|amps?|amperes?)\b/i, "A");
}

function bestNumericElectricalAttribute(attributes: AttributeRecord[], labelPattern: RegExp, unit: "V" | "A"): string | undefined {
  return attributes
    .filter((attr) => {
      const label = `${attr.group ?? ""} ${attr.name}`;
      return labelPattern.test(label) && isNumericElectricalSpecValue(attr.value) && isLikelySpecText(attr.value) && isAvailableSpecValue(attr.value);
    })
    .sort((left, right) => attributeEvidenceScore(right) + numericElectricalLabelScore(right, unit) - attributeEvidenceScore(left) - numericElectricalLabelScore(left, unit))
    .map((attr) => formatNumericElectricalValue(attr.value, unit))
    .find((value): value is string => Boolean(value));
}

function isNumericElectricalSpecValue(value: string): boolean {
  return /^\s*\d+(?:[.,]\d+)?\s*$/.test(value);
}

function formatNumericElectricalValue(value: string, unit: "V" | "A"): string | undefined {
  const number = localizedNumber(cleanText(value));
  if (!Number.isFinite(number)) return undefined;
  return `${formatNumber(number)} ${unit}`;
}

function numericElectricalLabelScore(attr: AttributeRecord, unit: "V" | "A"): number {
  const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
  let score = 0;
  if (/product specifications|technical data|main|complementary/.test(label)) score += 25;
  if (unit === "V" && /\bvolts?\b/.test(label)) score += 80;
  if (unit === "A" && /\bmax\.?\s*current\b/.test(label)) score += 90;
  if (unit === "A" && /\brated current|current rating|ampere rating|amperage\b/.test(label)) score += 75;
  return score;
}

function normalizedFieldLabelScore(attr: AttributeRecord, field?: keyof NormalizedProductFields): number {
  const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
  if (field === "dimensions") {
    if (/product net (height|width|depth|length)/.test(label)) return 80;
    if (/dimensioning|drawing|document|data sheet/.test(label)) return -80;
  }
  if (field === "weight") {
    if (/\bdigital product passport\b.*\bweight\b|\bweight\b.*\bdigital product passport\b/.test(label)) return 170;
    if (/\bproduct net weight|net weight|unit weight|product weight|mechanical data weight\b/.test(label)) return 130;
    if (/\bshipping|gross|package|packing|packaging\b/.test(label)) return -40;
    if (/\bcertificate|declaration|compliance|rohs|reach|substance|material compliance\b/.test(label)) return -160;
    if (/\bweight\b|\bmass\b|\bgewicht\b/.test(label)) return 80;
  }
  if (field === "voltage") {
    if (/\babb\b/.test(label) && /rated ou?tput voltage|ou?tput voltage/.test(label)) return 115;
    if (/minimum output voltage|discrete output voltage|relay output voltage|output voltage limits?|voltage drop/.test(label)) return 35;
    if (/rated operational voltage|operational voltage/.test(label)) return 140;
    if (/supply voltage.*(?:max|min)/.test(label)) return 90;
    if (/\[(?:us|ue|uc)\]\s+rated|rated supply voltage|supply voltage/.test(label)) return 135;
    if (/\b(?:us|ua|ub)\b.*(?:sensor|actuator|supply|voltage)|(?:sensor|actuator|supply|voltage).*\b(?:us|ua|ub)\b/.test(label)) return 134;
    if (/rated input voltage|input voltage/.test(label)) return 130;
    if (/input power|power input/.test(label)) return 126;
    if (/\bvolts?\b/.test(label)) return 145;
    if (/(?:^|\s)(?:power supply )?output voltage$/.test(label)) return 115;
    if (/rated ou?tput voltage|ou?tput voltage/.test(label)) return 115;
    if (/maximum operating voltage/.test(label)) return 100;
    // Bare "Rated voltage" is the nameplate/certified value; prefer it over a bare "Operating
    // voltage" reading (which without a min/max/maximum qualifier is often a tolerance or an
    // internal electronics spec rather than the product's own rated supply voltage).
    if (/\brated\s+voltage\b/.test(label)) return 110;
    if (/(?:^|\s)operating\s+voltage$/.test(label)) return 60;
    if (/nominal voltage|continuous operating voltage/.test(label)) return 95;
    if (/rated control circuit voltage|control circuit voltage/.test(label)) return 80;
    if (/voltage protection level/.test(label)) return 65;
    if (/rated insulation voltage|insulation voltage/.test(label)) return 20;
    if (/impulse|withstand/.test(label)) return -60;
  }
  if (field === "current") {
    if (/inrush current|starting current|peak current/.test(label)) return -140;
    if (/max\.?\s*current/.test(label)) return 126;
    if (/minimum output current|discrete output current|relay output current/.test(label)) return 35;
    if (/rated output current|output current|nominal output current/.test(label)) return 130;
    if (/current consumption/.test(label)) return 105;
    if (/rated supply current|supply current|input current/.test(label)) return 70;
    if (/thermal protection adjustment range|line current|continuous output current|maximum transient current|\[(?:in|ie)\]\s+/.test(label)) return 125;
    if (/rated current\b|ampere rating\b|rated operational current ac-3\b/.test(label)) return 115;
    if (/rated operational current ac-23a?\b/.test(label)) return 105;
    if (/rated operational current ac-22a?\b/.test(label)) return 95;
    if (/\[ith\]\s+/.test(label)) return 80;
    if (/minimum switching capacity/.test(label)) return 40;
    if (/maximum switching capacity|switching capacity.*(?:normally closed|\bnc\b)/.test(label)) return 90;
    if (/rated operational current ac-(?:1|21a?)\b|continuous current/.test(label)) return 85;
    if (/switching capacity|switching current/.test(label)) return 75;
    if (/thermal current|short-?time/.test(label)) return 55;
    if (/nominal discharge current|impulse current|short-?circuit.*(?:current|capacity|breaking)/.test(label)) return 45;
    if (/current type/.test(label)) return -120;
  }
  return 0;
}

function compareAttributeEvidence(left: AttributeRecord, right: AttributeRecord): number {
  return attributeEvidenceScore(right) - attributeEvidenceScore(left);
}

function attributeEvidenceScore(attr: AttributeRecord): number {
  const source = attr.sourceType ?? "generated";
  const parser = `${attr.parser ?? ""} ${attr.stage ?? ""} ${attr.group ?? ""}`.toLowerCase();
  let score = Math.round(evidenceConfidence({
    sourceType: source,
    parser,
    confidence: attr.confidence
  }) * 700);
  if (/browser-render/.test(parser)) score += 5;
  if (/reader|r\.jina/.test(parser)) score -= 20;
  return score;
}

export function bestDimensionAxisValue(attributes: AttributeRecord[], axis: "height" | "width" | "depth" | "length"): string | undefined {
  return bestDimensionAxisAttribute(attributes, axis)?.value;
}

/** Same selection as {@link bestDimensionAxisValue} but returns the winning attribute itself (not
 * just its value) so callers can weigh its evidence score against a competing candidate — see the
 * axis-vs-combined-"Dimensions"-attribute arbitration in normalizeFields. */
function bestDimensionAxisAttribute(attributes: AttributeRecord[], axis: "height" | "width" | "depth" | "length"): AttributeRecord | undefined {
  return attributes
    .filter((attr) => {
      const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      return dimensionAxisLabelScore(label, axis) > -100 && isLikelyDimensionAxisValue(attr.value) && isLikelySpecText(attr.value) && isAvailableSpecValue(attr.value);
    })
    .sort((left, right) => {
      const leftScore = attributeEvidenceScore(left) + dimensionAxisLabelScore(`${left.group ?? ""} ${left.name}`.toLowerCase(), axis);
      const rightScore = attributeEvidenceScore(right) + dimensionAxisLabelScore(`${right.group ?? ""} ${right.name}`.toLowerCase(), axis);
      return rightScore - leftScore;
    })[0];
}

/** Overall evidence quality of an attribute as a candidate for the combined "dimensions" field —
 * used to arbitrate between an assembled height/width/depth/length reading and a single combined
 * "Dimensions" string attribute (see normalizeFields), not just to rank within one axis. */
function dimensionsFieldScore(attr: AttributeRecord): number {
  return attributeEvidenceScore(attr) + normalizedFieldLabelScore(attr, "dimensions");
}

function isLikelyDimensionAxisValue(value: string): boolean {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned || cleaned.length > 80 || !/\d/.test(cleaned)) return false;
  if (/[{}]|\b(?:function|nvent|product|catalog|accessor(?:y|ies)|bracket|support|box|plate)\b/i.test(cleaned)) return false;
  return /^\d+(?:[.,]\d+)?(?:\s+\d+\/\d+)?\s*(?:mm|cm|m|in|inch|inches|")?(?:\s*\(\s*\d+(?:[.,]\d+)?\s*(?:mm|cm|m|in|inch|inches|")\s*\))?$/i.test(cleaned);
}

function dimensionAxisLabelScore(label: string, axis: "height" | "width" | "depth" | "length"): number {
  if (
    /package|packing|packaging|number of height units|height units|suitable for enclosure|wire stripping|stripping length|cable length|bus length|tap links length|cable distance|operating distance|communication distance|serial link|modbus|ethernet|segment|pulse width|time delay|recovery time|power on delay|response time|reset time|duration|control signal|signal pulse|connecting capacity|conductor|terminal|focal length|back focal|object distance|minimum object distance|angle of view|sensor size|lens|mount/.test(
      label
    )
  ) {
    return -200;
  }
  if (axis === "height") {
    if (/product\s+(?:net\s+)?height/.test(label)) return 140;
    if (/\bheight\b|\baltezza\b|wysoko\u015b\u0107|produkth\u00f6he/.test(label)) return 70;
  }
  if (axis === "width") {
    if (/product\s+(?:net\s+)?width/.test(label)) return 140;
    if (/\bwidth\b|\blarghezza\b|szeroko\u015b\u0107|produktbreite/.test(label)) return 70;
  }
  if (axis === "depth") {
    if (/product\s+(?:net\s+)?depth|product\s+(?:net\s+)?length\s*\/\s*depth/.test(label)) return 140;
    if (/\bdepth\b|\bprofond|d\u0142ugo\u015b\u0107\s*\/\s*g\u0142\u0119boko\u015b\u0107|produkt\s+l\u00e4nge\s*\/\s*tiefe/.test(label)) return 75;
    if (/\blength\b/.test(label)) return 35;
  }
  if (axis === "length") {
    if (/product net .*length/.test(label)) return 140;
    if (/\blength\b/.test(label)) return 70;
  }
  return -200;
}

function bestCableLengthDimensionValue(attributes: AttributeRecord[]): string | undefined {
  const candidate = attributes
    .filter((attr) => {
      const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      if (/\b(?:focal|object distance|sensor size|mounting|thread|wire stripping|terminal)\b/.test(label)) return false;
      return (
        /\bcable length\b/.test(label) ||
        (/^cable$/i.test(attr.name) && /\b\d+(?:[.,]\d+)?\s*(?:mm|cm|m|ft|feet|foot|in|inch|inches|")\b/i.test(attr.value))
      );
    })
    .sort(compareAttributeEvidence)
    .map((attr) => extractCableLengthDimension(attr.value))
    .find((value): value is string => Boolean(value));
  return candidate;
}

function extractCableLengthDimension(value: string | undefined): string | undefined {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return undefined;
  const match = cleaned.match(/\b(\d+(?:[.,]\d+)?)\s*(mm|cm|m|ft|feet|foot|in|inch|inches|")\b/i);
  if (!match) return undefined;
  const number = localizedNumber(match[1]);
  const unit = normalizeDimensionUnit(match[2]);
  if (!Number.isFinite(number) || !unit) return undefined;
  const original = `${formatNumber(number)} ${unit === "in" ? "in" : unit}`;
  if (unit === "mm") return `Cable length ${original}`;
  return `Cable length ${original} (${formatNumber(convertDimensionToMillimeters(number, unit))} mm)`;
}

function mergeNormalizedFields(
  computed: NormalizedProductFields,
  primary: NormalizedProductFields,
  fallback: NormalizedProductFields,
  attributes: AttributeRecord[]
): NormalizedProductFields {
  const merged: NormalizedProductFields = { ...computed };
  for (const field of Object.keys(computed) as Array<keyof NormalizedProductFields>) {
    if (merged[field]) continue;
    merged[field] = primary[field] ?? fallback[field];
  }

  for (const field of Object.keys(primary) as Array<keyof NormalizedProductFields>) {
    const primaryValue = primary[field];
    if (!primaryValue) continue;
    const computedValue = merged[field];
    if (!computedValue) {
      merged[field] = primaryValue;
      continue;
    }
    if (valueHasOfficialEvidence(attributes, primaryValue) && !valueHasOfficialEvidence(attributes, computedValue)) {
      merged[field] = primaryValue;
    }
  }

  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined && value !== "")) as NormalizedProductFields;
}

function valueHasOfficialEvidence(attributes: AttributeRecord[], value: string): boolean {
  return attributes.some(
    (attr) =>
      (attr.value === value || value.includes(attr.value) || attr.value.includes(value)) &&
      (attr.sourceType === "official" || attr.sourceType === "official-fallback" || attr.sourceType === "generated")
  );
}

export function emptyResult(manufacturerId: ProductResult["manufacturerId"], catalogNumber: string, error: string): ProductResult {
  return {
    manufacturerId,
    catalogNumber,
    status: "failed",
    confidence: 0,
    normalized: {},
    attributes: [],
    documents: [],
    sources: [],
    error
  };
}

/**
 * A legal or policy document, not a product approval.
 *
 * `declaration` maps to "certificate" because of the declaration of conformity — but a vendor's footer
 * also links a "Data Protection Declaration", and that matched too. The document's LABEL then flowed into
 * `normalized.certificates`, so a Fath cable shipped with
 * `certificates = "RoHS, Data Protection Declaration, REACH Regulation"`. Checked BEFORE the certificate
 * branch, because these documents almost always carry a certificate keyword as well.
 */
const LEGAL_POLICY_DOCUMENT =
  /\b(?:data.?protection|datenschutz|privacy|gdpr|dsgvo|cookie|imprint|impressum|terms|whistleblow|legal\s*notice|accessibility)\b/i;

export function classifyDocument(label: string, url: string): DocumentRecord["type"] {
  const text = `${label} ${url}`.toLowerCase();
  if (LEGAL_POLICY_DOCUMENT.test(text)) return "other";
  if (/\b(cert|certificate|certifications?|declaration|conformity|rohs|weee|reach|tsca|prop\s*65|culus|curus|cul|ul|ce|ukca|eac)\b|\bul-listed\b/.test(text)) return "certificate";
  if (/\b(?:data.?sheet|datasheet|tech(?:nical)?\s*data|technical\s+(?:sheet|information)|specification(?:s)? sheet|spec sheet)\b/i.test(label)) return "datasheet";
  if (/\b(?:manual|instruction|installation)\b/i.test(label)) return "manual";
  if (/\/documents\/in\//.test(text) || /manual|instruction|instman|installation/.test(text)) return "manual";
  if (/\b(?:cad|drawing|dwg|dxf|step|stp|igs|iges|zip)\b|\.(?:dwg|dxf|step|stp|igs|iges|zip)(?:[?#]|$)/.test(text)) return "cad";
  if (
    /\/documents\/td\//.test(text) ||
    /\/products\/[^?#]+\/pdf(?:[?#]|$)/.test(text) ||
    /(?:^|\b)download\s+pdf\b/.test(text) ||
    /[?&](?:file|uri)=[^&#]*\d+[^&#]*\.pdf\b/.test(text) ||
    /cutsheet|data.?sheet|datasheet|tech(?:nical)?\s*data|technical|specification(?:s)? sheet|spec sheet|catalog|brochure|flyer|handbook|test report|engineering specification/.test(text)
  ) return "datasheet";
  if (/\.(png|jpe?g|webp|gif)(\?|$)/.test(text)) return "image";
  return "other";
}

function formatDimensions(height?: string, width?: string, depth?: string, length?: string): string | undefined {
  const direct = joinDimensionParts([height, width, depth]);
  if (direct) return direct;
  const parts = [
    height ? `H ${height}` : undefined,
    width ? `W ${width}` : undefined,
    depth ? `D ${depth}` : undefined,
    !width && length ? `L ${length}` : undefined
  ].filter(Boolean);
  return parts.length ? parts.join(" x ") : undefined;
}

function joinDimensionParts(parts: Array<string | undefined>): string | undefined {
  if (parts.some((part) => !part)) return undefined;
  const parsed = parts.map((part) => cleanText(part).match(/^(\d+(?:[.,]\d+)?)\s*(mm|cm|m|in|inch|inches|")?$/i));
  if (parsed.some((match) => !match)) return undefined;
  const unit = parsed.find((match) => match?.[2])?.[2];
  if (!unit) return undefined;
  return `${parsed.map((match) => match?.[1]).join(" x ")} ${unit === `"` ? "in" : unit}`;
}

/** A clean single weight/dimension reading has at most 2 unit-bearing numbers — the metric value
 * and its own imperial conversion (e.g. "270 g (0.60 lb)"), or 2 lengths for a bore/stroke pair.
 * 3+ distinct matches means several DIFFERENT measurements got concatenated into one string —
 * confirmed on Rockwell's large multi-model datasheets, where several generic "any line with a
 * recognized label" parsers all independently glued a shared comparison-table ROW's several
 * models' values into one "Weight"/"Dimensions" attribute for whichever catalog happened to be
 * one of that row's own columns. Rejecting here (return undefined, letting the caller fall
 * through to the next-best candidate) is a single, common backstop for every such parser instead
 * of patching each one individually. */
function hasTooManyDistinctMeasurements(value: string, unitPattern: RegExp): boolean {
  const matches = value.match(unitPattern);
  return Boolean(matches && matches.length > 2);
}

const WEIGHT_UNIT_MATCH_PATTERN = /\b\d+(?:[.,]\d+)?\s*(?:kg|g|lbs?|pounds?|oz|ounces?)\b/gi;
const WEIGHT_UNIT_FAMILY_PATTERN = /\b(kg|g|lbs?|pounds?|oz|ounces?)\b/i;

/** A clean weight string mentions each unit FAMILY (metric grams, imperial pounds, imperial ounces)
 * at most once — e.g. "270 g (0.60 lb)" has one metric and one imperial mention. Two separate
 * gram readings ("600 g 700 g") is the tell-tale sign of two different models' rows concatenated,
 * even though the total match count (2) is too low for {@link hasTooManyDistinctMeasurements} to
 * catch on its own. */
function hasRepeatedWeightUnitFamily(value: string): boolean {
  const matches = value.match(WEIGHT_UNIT_MATCH_PATTERN);
  if (!matches || matches.length < 2) return false;
  const families = matches.map((match) => {
    const unit = match.match(WEIGHT_UNIT_FAMILY_PATTERN)?.[1]?.toLowerCase() ?? "";
    if (unit === "kg" || unit === "g") return "metric";
    if (unit.startsWith("lb") || unit.startsWith("pound")) return "lb";
    return "oz";
  });
  return new Set(families).size !== families.length;
}

/** One "H x W x D unit" (or "H x W unit") group counts as a single measurement — a clean value has
 * at most 2 (metric + its own imperial conversion). 3+ means multiple different models' dimensions
 * got concatenated into one string. */
const DIMENSION_TRIPLET_MATCH_PATTERN =
  /\b\d+(?:[.,]\d+)?\s*[xX*]\s*\d+(?:[.,]\d+)?(?:\s*[xX*]\s*\d+(?:[.,]\d+)?)?\s*(?:mm|cm|m|in|inch|inches|")\b/gi;

function normalizeWeightValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return undefined;
  if (hasTooManyDistinctMeasurements(cleaned, WEIGHT_UNIT_MATCH_PATTERN)) return undefined;
  if (hasRepeatedWeightUnitFamily(cleaned)) return undefined;
  // Resolve decimal vs. thousands separators before reading the number so "1,050.00 lbs"
  // is 1050, not 1.05 (or 50). The original `cleaned` text is kept for display.
  const normalized = normalizeNumberSeparators(cleaned);
  const match = normalized.match(/\b(\d+(?:\.\d+)?)\s*(kg|g|lb|lbs|pound|pounds|oz|ounce|ounces)\b/i);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return cleaned;
  const unit = match[2].toLowerCase();
  if (unit === "kg") return cleaned;
  if (/\bkg\b/i.test(cleaned)) return cleaned;
  if (unit === "g") return `${cleaned} (${formatConvertedNumber(number / 1000)} kg)`;
  if (/^lb|pound/.test(unit)) return `${cleaned} (${formatConvertedNumber(number * POUND_TO_KILOGRAM)} kg)`;
  if (/^oz|ounce/.test(unit)) return `${cleaned} (${formatConvertedNumber(number * OUNCE_TO_KILOGRAM)} kg)`;
  return cleaned;
}

function normalizeDimensionValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return undefined;
  if (hasTooManyDistinctMeasurements(cleaned, DIMENSION_TRIPLET_MATCH_PATTERN)) return undefined;
  if (/\b\d+(?:[.,]\d+)?\s*[xX*]\s*\d+(?:[.,]\d+)?(?:\s*[xX*]\s*\d+(?:[.,]\d+)?)?\s*(?:mm|cm|m)\s*(?:²|2)/i.test(cleaned)) return undefined;
  const boreStroke = normalizeBoreStrokeDimensionValue(cleaned);
  if (boreStroke) return boreStroke;
  const labeledParts = parseLabeledDimensionParts(cleaned);
  if (labeledParts.length >= 1) {
    const unit = firstDimensionUnit(labeledParts);
    if (!unit || unit === "mm" || /\bmm\b/i.test(cleaned)) return cleaned;
    return `${cleaned} (${formatLabeledMillimeters(labeledParts, unit)})`;
  }
  const repeatedUnitDimensions = normalizeRepeatedUnitDimensionChain(cleaned);
  if (repeatedUnitDimensions) return repeatedUnitDimensions;
  const match = cleaned.match(/\b(\d+(?:[.,]\d+)?)\s*[xX*]\s*(\d+(?:[.,]\d+)?)\s*(?:[xX*]\s*(\d+(?:[.,]\d+)?)\s*)?(mm|cm|m|in|inch|inches|")\b/i);
  if (!match) return undefined;
  const unit = match[4] === `"` ? "in" : match[4].toLowerCase();
  if (unit === "mm") return cleaned;
  const values = [match[1], match[2], match[3]]
    .filter((part): part is string => Boolean(part))
    .map((part) => localizedNumber(part));
  if (values.some((number) => !Number.isFinite(number))) return cleaned;
  const millimeters = values.map((number) => convertDimensionToMillimeters(number, unit));
  return `${cleaned} (${millimeters.map(formatNumber).join(" x ")} mm)`;
}

/**
 * Quantity kinds that a descriptive field (colour, material, finish) can never legitimately carry.
 *
 * The colour field on a real Ganter page came out as `24 V DC ± 10 % / 7 mA` — an electrical rating in a
 * COLOUR. Six different sources feed `color`, so chasing which one produced it is whack-a-mole; the
 * unit-kind check belongs at the boundary, exactly like the concatenated-measurement backstop above.
 *
 * Only kinds that are unambiguous are listed. Length is deliberately absent: "RAL 9005" carries no unit,
 * but a finish legitimately can ("black anodised 20 µm").
 */
const FOREIGN_QUANTITY_KINDS_FOR_DESCRIPTIVE_FIELDS = new Set(["voltage", "current", "power", "frequency"]);

function withoutForeignQuantityKinds(value: string | undefined): string | undefined {
  if (!value) return value;
  const foreign = parseQuantities(value).some((quantity) =>
    FOREIGN_QUANTITY_KINDS_FOR_DESCRIPTIVE_FIELDS.has(quantity.kind)
  );
  return foreign ? undefined : value;
}

/**
 * A prose paragraph that happens to contain ratings is not a rating.
 *
 * The same Ganter page put this in BOTH `voltage` and `current`:
 *   "Changeover contact, snap contact silver alloy max. 125 V (plug) max. 240 V (cable) max. 3 A
 *    106 switching cycles 50,000 switching cycles (under full load)"
 * — a whole contact-specification paragraph, identical in two different fields.
 *
 * The tell is MIXED quantity kinds inside a long run of words. Same-kind multi-values are legitimate and
 * must survive ("230/400 V", "1 A, 3 A, 6 A"), so kinds alone is not enough; and a terse mixed value is
 * legitimate too ("24 V DC / 7 mA"), so the word count carries the decision. Twelve words is well above
 * any real rating and well below this paragraph's twenty-five.
 */
const MIXED_KIND_PROSE_MIN_WORDS = 12;

function withoutMixedKindProse(value: string | undefined): string | undefined {
  if (!value) return value;
  const wordCount = value.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < MIXED_KIND_PROSE_MIN_WORDS) return value;
  const kinds = new Set(parseQuantities(value).map((quantity) => quantity.kind));
  return kinds.size >= 2 ? undefined : value;
}

/**
 * Parse one number token that may use either separator convention.
 *
 * Replaces a bare `Number(token.replace(",", "."))`, which silently divided thousands-separated values
 * by a thousand: the dimension regexes capture "1,200" as a single token, so a 1200 mm enclosure width
 * became "1.2 mm". `normalizeNumberSeparators` is the project's single decision on this (see the
 * number-separator note in text-util.ts) — it was already used for weight, and the dimension paths
 * simply never adopted it.
 */
function localizedNumber(token: string): number {
  return Number(normalizeNumberSeparators(token));
}

function normalizeRepeatedUnitDimensionChain(value: string): string | undefined {
  const match = value.match(
    /\b(\d+(?:[.,]\d+)?\s*(?:mm|cm|m|inches|inch|in|")\s*[xX*]\s*\d+(?:[.,]\d+)?\s*(?:mm|cm|m|inches|inch|in|")(?:\s*[xX*]\s*\d+(?:[.,]\d+)?\s*(?:mm|cm|m|inches|inch|in|")){0,3})\b/i
  );
  if (!match) return undefined;
  const dimensionText = cleanText(match[1]).replace(/\*/g, "x");
  const parts = [...dimensionText.matchAll(/(\d+(?:[.,]\d+)?)\s*(mm|cm|m|inches|inch|in|")\b/gi)].map((part) => ({
    value: localizedNumber(part[1]),
    unit: normalizeDimensionUnit(part[2])
  }));
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part.value) || !part.unit)) return undefined;
  const firstUnit = parts[0].unit;
  if (!firstUnit) return undefined;
  if (parts.some((part) => part.unit !== firstUnit)) return dimensionText;
  if (firstUnit === "mm") return dimensionText;
  const millimeters = parts.map((part) => convertDimensionToMillimeters(part.value, firstUnit));
  return `${dimensionText} (${millimeters.map(formatNumber).join(" x ")} mm)`;
}

function normalizeBoreStrokeDimensionValue(value: string): string | undefined {
  const bore = value.match(/\b(\d+(?:[.,]\d+)?)\s*(mm|cm|m|in|inch|inches|")?\s*bore\b/i);
  const stroke = value.match(/\b(\d+(?:[.,]\d+)?)\s*(mm|cm|m|in|inch|inches|")?\s*stroke\b/i);
  if (!bore && !stroke) return undefined;
  const parts: string[] = [];
  if (bore) parts.push(`Bore ${formatDimensionQuantity(bore[1], bore[2])}`);
  if (stroke) parts.push(`stroke ${formatDimensionQuantity(stroke[1], stroke[2])}`);
  return parts.join("; ");
}

function formatDimensionQuantity(rawNumber: string, rawUnit: string | undefined): string {
  const unit = normalizeDimensionUnit(rawUnit) ?? "mm";
  const number = localizedNumber(rawNumber);
  return `${Number.isFinite(number) ? formatNumber(number) : cleanText(rawNumber)} ${unit}`;
}

interface LabeledDimensionPart {
  label: "H" | "W" | "D" | "L";
  value: number;
  unit?: string;
}

function parseLabeledDimensionParts(value: string): LabeledDimensionPart[] {
  const parts: LabeledDimensionPart[] = [];
  const beforeValue = /\b([HWDL])\s*(\d+(?:[.,]\d+)?)\s*(in|inch|inches|"|mm|cm|m|ft|feet|foot)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = beforeValue.exec(value))) {
    const number = localizedNumber(match[2]);
    if (Number.isFinite(number)) parts.push({ label: match[1].toUpperCase() as LabeledDimensionPart["label"], value: number, unit: normalizeDimensionUnit(match[3]) });
  }
  if (parts.length >= 2) return parts;

  const afterValue = /\b(\d+(?:[.,]\d+)?)(?:\s*(in|inch|inches|"|mm|cm|m|ft|feet|foot))?\s*([HWDL])\b/gi;
  while ((match = afterValue.exec(value))) {
    const number = localizedNumber(match[1]);
    if (Number.isFinite(number)) parts.push({ label: match[3].toUpperCase() as LabeledDimensionPart["label"], value: number, unit: normalizeDimensionUnit(match[2]) ?? "in" });
  }
  return parts;
}

function firstDimensionUnit(parts: LabeledDimensionPart[]): string | undefined {
  return parts.find((part) => part.unit)?.unit;
}

function formatLabeledMillimeters(parts: LabeledDimensionPart[], fallbackUnit: string): string {
  return parts
    .map((part) => `${part.label} ${formatNumber(convertDimensionToMillimeters(part.value, part.unit ?? fallbackUnit))} mm`)
    .join(" x ");
}

function normalizeDimensionUnit(unit: string | undefined): string | undefined {
  if (!unit) return undefined;
  if (unit === `"` || /^in/i.test(unit)) return "in";
  if (/^(?:ft|foot|feet)$/i.test(unit)) return "ft";
  return unit.toLowerCase();
}

function convertDimensionToMillimeters(value: number, unit: string): number {
  if (unit === "mm") return value;
  if (unit === "cm") return value * 10;
  if (unit === "m") return value * 1000;
  if (unit === "ft") return value * 304.8;
  return value * 25.4;
}

function normalizeElectricalValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return undefined;
  return cleaned
    .replace(/(\d)\s*VAC\b/gi, "$1 V AC")
    .replace(/(\d)\s*VDC\b/gi, "$1 V DC")
    .replace(/(\d)\s*kV\b/gi, "$1 kV")
    .replace(/\bVAC\b/gi, "V AC")
    .replace(/\bVDC\b/gi, "V DC")
    .replace(/\s+\d+\)(?=\s*(?:IEC|EN|UL|CSA)\b)/gi, " ")
    .replace(/\bAC\s*\/\s*DC\b/gi, "AC/DC")
    .replace(/\bAC\s*-\s*DC\b/gi, "AC-DC")
    .replace(/(\d+(?:[.,]\d+)?)\s*volts?\b/gi, "$1 V")
    .replace(/(\d)\s*V\b/gi, "$1 V")
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:amps?|amperes?)\b/gi, "$1 A")
    .replace(/(\d+(?:[.,]\d+)?)\s*kA\b/gi, (_match, number: string) => `${number} kA`)
    .replace(/(\d+(?:[.,]\d+)?)\s*mA\b/gi, (_match, number: string) => `${number} mA`)
    .replace(/(\d+(?:[.,]\d+)?)\s*A\b/g, "$1 A")
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:\.{2,3}|\u2026|\u2013|\u2014|-|to)\s*(\d+(?:[.,]\d+)?)(?=\s*(?:kV|V|kA|mA|A)\b)/gi, "$1...$2")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeVoltageValue(value: string | undefined): string | undefined {
  const cleaned = trimElectricalSegments(normalizeElectricalValue(value), /\b\d+(?:[.,]\d+)?\s*(?:\.\.\.\s*\d+(?:[.,]\d+)?\s*)?(?:kV|V)\b/i);
  if (!cleaned || !/\b\d+(?:[.,]\d+)?\s*(?:\.\.\.\s*\d+(?:[.,]\d+)?\s*)?(?:kV|V)\b/i.test(cleaned)) return undefined;
  return cleaned;
}

function normalizeCurrentValue(value: string | undefined): string | undefined {
  const cleaned = trimElectricalSegments(normalizeElectricalValue(value), /\b\d+(?:[.,]\d+)?\s*(?:\.\.\.\s*\d+(?:[.,]\d+)?\s*)?(?:kA|mA|A)\b/i);
  if (!cleaned || !/\b\d+(?:[.,]\d+)?\s*(?:\.\.\.\s*\d+(?:[.,]\d+)?\s*)?(?:kA|mA|A)\b/i.test(cleaned)) return undefined;
  return cleaned;
}

function trimElectricalSegments(value: string | undefined, pattern: RegExp): string | undefined {
  if (!value || !/[;]/.test(value)) return value;
  const parts = value.split(";").map(cleanText).filter(Boolean);
  const matching = parts.filter((part) => pattern.test(part));
  return matching.length && matching.length < parts.length ? matching.join("; ") : value;
}

function deriveVoltageRangeFromMinMax(attributes: AttributeRecord[]): string | undefined {
  const hasPrimaryVoltage = attributes.some((attr) => {
    const label = `${attr.group ?? ""} ${attr.name}`;
    return isPrimaryVoltageLabel(label) && isLikelySpecText(attr.value) && isAvailableSpecValue(attr.value) && Boolean(normalizeVoltageValue(attr.value));
  });
  const voltageAttributes = attributes.filter((attr) => {
    const label = `${attr.group ?? ""} ${attr.name}`;
    if (!/\bvoltage\b/i.test(label) || !/\b(?:min|max|minimum|maximum)\b/i.test(label)) return false;
    // A loose "label: value" split can leave a disqualifying "... of test circuit" qualifier in
    // the value instead of the label (e.g. name="min. Operating voltage", value="range of test
    // circuit 150 V"). Check both so the RCD's own test-instrument voltage can't masquerade as a
    // primary rated-voltage label just because the qualifier landed on the wrong side of the split.
    if (isDisqualifiedForQuantityKind("", attr.value, "voltage")) return false;
    if (isPrimaryVoltageLabel(label)) return true;
    if (hasPrimaryVoltage && isSecondaryVoltageLabel(label)) return false;
    return !isDisqualifiedForQuantityKind(label, "", "voltage");
  });
  for (const minAttr of voltageAttributes) {
    const minLabel = `${minAttr.group ?? ""} ${minAttr.name}`;
    if (!/\b(?:min|minimum)\b/i.test(minLabel)) continue;
    const base = minMaxElectricalLabelBase(minLabel);
    const maxAttr = voltageAttributes.find((attr) => {
      const maxLabel = `${attr.group ?? ""} ${attr.name}`;
      return /\b(?:max|maximum)\b/i.test(maxLabel) && minMaxElectricalLabelBase(maxLabel) === base;
    });
    if (!maxAttr) continue;
    const min = normalizeVoltageValue(minAttr.value);
    const max = normalizeVoltageValue(maxAttr.value);
    const range = combineElectricalRange(min, max);
    if (range) return range;
  }
  return undefined;
}

function isPrimaryVoltageLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  if (isSecondaryVoltageLabel(normalized) || isDisqualifiedForQuantityKind(normalized, "", "voltage")) return false;
  return /\[(?:us|ue|uc)\]\s+rated|rated supply voltage|supply voltage|rated input voltage|input voltage|input power|power input|rated operational voltage|operational voltage|operating voltage|nominal input voltage|rated control circuit voltage|control circuit voltage/.test(
    normalized
  );
}

function isSecondaryVoltageLabel(label: string): boolean {
  return /\b(?:output|discrete|relay|contact)\b/i.test(label);
}

// The kA/Ui/test-circuit vocabulary that used to live here now has one owner:
// isDisqualifiedForQuantityKind in ontology.ts, keyed on the physical quantity rather than on either
// label system's field names. See its comment for why.

function minMaxElectricalLabelBase(label: string): string {
  return label
    .toLowerCase()
    .replace(/\b(?:minimum|maximum|min|max)\b/g, "")
    .replace(/[-:()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function combineElectricalRange(min: string | undefined, max: string | undefined): string | undefined {
  if (!min || !max) return undefined;
  const minMatch = min.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  const maxMatch = max.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!minMatch || !maxMatch) return undefined;
  const minUnit = cleanText(minMatch[2]);
  const maxUnit = cleanText(maxMatch[2]);
  if (minUnit && maxUnit && minUnit.toLowerCase() !== maxUnit.toLowerCase()) return `${min}...${max}`;
  return cleanText(`${minMatch[1]}...${maxMatch[1]} ${maxUnit || minUnit}`);
}

function deriveVoltageFromText(attributes: AttributeRecord[]): string | undefined {
  return bestDerivedElectricalValue(attributes, extractVoltageValues);
}

function deriveCurrentFromText(attributes: AttributeRecord[]): string | undefined {
  return bestDerivedElectricalValue(attributes, extractCurrentValues);
}

function deriveDimensionsFromText(attributes: AttributeRecord[]): string | undefined {
  const candidates = attributes
    .filter(isDimensionTextCandidate)
    .flatMap((attr) =>
      extractDimensionValuesFromText(derivedSpecText(attr)).map((value) => ({
        value,
        score: attributeEvidenceScore(attr) + electricalTextLabelScore(`${attr.group ?? ""} ${attr.name}`)
      }))
    );
  return candidates.sort((left, right) => right.score - left.score)[0]?.value;
}

function isDimensionTextCandidate(attr: AttributeRecord): boolean {
  const label = `${attr.group ?? ""} ${attr.name}`;
  const text = derivedSpecText(attr);
  if (!/\b\d+(?:[.,]\d+)?\s*[xX*]\s*\d+(?:[.,]\d+)?(?:\s*[xX*]\s*\d+(?:[.,]\d+)?)?\s*(?:mm|cm|m|in|inch|inches|")\b/i.test(text)) {
    return false;
  }
  if (/\bplain text\b/i.test(label) && /\btitle\b/i.test(label)) return /\bschneider\b/i.test(`${attr.name} ${attr.value}`);
  if (/\b(structured data|meta)\b/i.test(label) && /\b(name|title|description|og:description|twitter:description)\b/i.test(label)) return true;
  if (/\bschneider\b/i.test(label) && /\b(product info|description|title|name|product type|long description)\b/i.test(label)) return true;
  if (/\b(product specifications|sce product data)\b/i.test(label) && /\b(description|product type|product name)\b/i.test(label)) return true;
  return /\babb\b/i.test(label) && /\b(name|title|description|catalog description|long description|short description|product short text|product type|type description)\b/i.test(label);
}

function extractDimensionValuesFromText(value: string): string[] {
  const cleaned = cleanText(value);
  const matches = cleaned.match(/\b\d+(?:[.,]\d+)?\s*[xX*]\s*\d+(?:[.,]\d+)?(?:\s*[xX*]\s*\d+(?:[.,]\d+)?)?\s*(?:mm|cm|m|in|inch|inches|")\b/gi) ?? [];
  return [...new Set(matches.map((match) => normalizeDimensionValue(match)).filter((match): match is string => Boolean(match)))];
}

function bestDerivedElectricalValue(
  attributes: AttributeRecord[],
  extractor: (value: string, label: string) => string[]
): string | undefined {
  const candidates = attributes
    .filter(isElectricalTextCandidate)
    .flatMap((attr) => {
      const label = `${attr.group ?? ""} ${attr.name}`;
      return extractor(derivedSpecText(attr), label).map((value) => ({
        value,
        score: attributeEvidenceScore(attr) + electricalTextLabelScore(label) + electricalValueSpecificityScore(value)
      }));
    });
  return candidates.sort((left, right) => right.score - left.score)[0]?.value;
}

function isElectricalTextCandidate(attr: AttributeRecord): boolean {
  const label = `${attr.group ?? ""} ${attr.name}`;
  if (/\bplain text\b/i.test(label) && /\btitle\b/i.test(label)) {
    const text = `${attr.name} ${attr.value}`;
    return /\bschneider\b/i.test(text) && /(?:\bip\s*\d{2}[a-z]?\b|\bik\s*\d{2}\b|\bvac\b|\bvdc\b|\bv\s*(?:ac|dc)?\b|\bkw\b|\bka\b|\bma\b|\b\d+(?:[.,]\d+)?\s*a\b)/i.test(text);
  }
  if (/\b(plain text|script|style|console|image|url|document|download|certificate|approval|standard|classification|eclass|etim|unspsc)\b/i.test(label)) {
    return false;
  }
  if (/\b(structured data|meta)\b/i.test(label) && /\b(name|title|description|og:description|twitter:description)\b/i.test(label)) {
    return /(?:\bi2n\b|\bip\s*\d{2}[a-z]?\b|\bik\s*\d{2}\b|\bvac\b|\bvdc\b|\bv\s*(?:ac|dc)\b|\bkw\b|\bka\b|\bma\b|\b(?:operating|rated|supply|input|output|operational|utilization|current|voltage)\b.{0,80}\b\d+(?:[.,]\d+)?\s*v(?:\s*(?:ac|dc)|ac|dc)?\b|\b\d+(?:[.,]\d+)?\s*v(?:\s*(?:ac|dc)|ac|dc)\b|\b\d+(?:[.,]\d+)?\s*a\b)/i.test(attr.value);
  }
  if (/\bschneider\b/i.test(label) && /\b(product info|description|title|name|product type|long description)\b/i.test(label)) {
    return /(?:\bvac\b|\bvdc\b|\bv\s*(?:ac|dc)?\b|\bkw\b|\bka\b|\bma\b|\b\d+(?:[.,]\d+)?\s*v(?:\s*(?:ac|dc)|ac|dc)?\b|\b\d+(?:[.,]\d+)?\s*a\b)/i.test(attr.value);
  }
  if (/\b(product specifications|sce product data)\b/i.test(label) && /\b(description|product type|product name)\b/i.test(label)) {
    return /\b(?:vac|vdc|v\s*(?:ac|dc)?|\d+(?:[.,]\d+)?\s*(?:v(?:ac|dc)?|volts?))\b/i.test(attr.value);
  }
  if (/\bsce\b/i.test(label) && /\b(electrical ratings?|switch capacity)\b/i.test(label)) {
    return /\b(?:vac|vdc|v\s*(?:ac|dc)?|\d+(?:[.,]\d+)?\s*(?:v(?:ac|dc)?|volts?|a|amps?|amperes?))\b/i.test(attr.value);
  }
  if (/\bapplication\b/i.test(label) && /\b(?:switch capacity|vac|vdc|\d+(?:[.,]\d+)?\s*(?:v(?:ac|dc)?|volts?|a|amps?|amperes?))\b/i.test(attr.value)) {
    return true;
  }
  return /\babb\b/i.test(label) && /\b(name|title|description|catalog description|long description|short description|product short text|product type|type description)\b/i.test(label);
}

function derivedSpecText(attr: AttributeRecord): string {
  const label = `${attr.group ?? ""} ${attr.name}`;
  if (/\bplain text\b/i.test(label) && /\btitle\b/i.test(label)) return `${attr.name} ${attr.value}`;
  return attr.value;
}

function electricalTextLabelScore(label: string): number {
  if (/\b(catalog description|long description|description|title|name|product short text)\b/i.test(label)) return 35;
  if (/\b(extended product type|product type|display name)\b/i.test(label)) return 30;
  return 0;
}

function electricalValueSpecificityScore(value: string): number {
  let score = 0;
  if (/(?:\.{2,3}|\u2026|\u2013|\u2014|-|to)/i.test(value)) score += 45;
  if (/\b(?:ac\/dc|ac-dc|vac\/dc|v\s*ac\s*\/\s*dc)\b/i.test(value)) score += 10;
  return score;
}

function extractVoltageValues(value: string): string[] {
  const cleaned = cleanText(value);
  const matches = cleaned.match(
    /(?<![\w.])\d+(?:[.,]\d+)?\s*(?:v?\s*(?:(?:\.{2,3}|\u2026|\u2013|\u2014|-|to)\s*\d+(?:[.,]\d+)?\s*)?v(?:\s*(?:ac|dc)|ac|dc)?(?:\s*(?:\/|-)\s*dc)?|volts?)\b/gi
  ) ?? [];
  return [...new Set(matches.map(cleanText).filter((match) => isPlausibleVoltageValue(match, cleaned)))];
}

function extractCurrentValues(value: string, label: string): string[] {
  const cleaned = cleanText(value);
  const context = `${label} ${cleaned}`;
  const matches =
    cleaned.match(
      /(?<![\w.-])\d+(?:[.,]\d+)?\s*(?:(?:\.{2,3}|\u2026|\u2013|\u2014|-|to)\s*\d+(?:[.,]\d+)?\s*)?(?:kA|mA|A|amps?|amperes?)\b(?![a-z0-9-])/gi
    ) ?? [];
  return [
    ...new Set(
      matches
        .map(cleanText)
        .filter((match) => isPlausibleCurrentValue(match, context))
    )
  ];
}

function isPlausibleCurrentValue(value: string, context: string): boolean {
  const firstNumber = localizedNumber(value.match(/\d+(?:[.,]\d+)?/)?.[0] ?? "");
  if (!Number.isFinite(firstNumber)) return false;
  if (/\b(current|rated|sensor|toroid|transformer|neutral|amp(?:ere|s)?|amperage|input|output|supply|power supply|starter|breaker|drive|contactor|push-?button|switch(?:ing)? capacity|switching current|iu|ie|i2n)\b/i.test(context)) {
    return true;
  }
  if (/\binn?\s*[=:]/i.test(context)) {
    return true;
  }
  return /\b(?:kA|mA)\b/i.test(value) || firstNumber >= 10;
}

function isPlausibleVoltageValue(value: string, context: string): boolean {
  const firstNumber = localizedNumber(value.match(/\d+(?:[.,]\d+)?/)?.[0] ?? "");
  if (!Number.isFinite(firstNumber)) return false;
  if (/(?:v\s*(?:ac|dc)|vac|vdc|ac\/dc|ac-dc|\bvolts?\b)/i.test(value)) return true;
  return /\b(voltage|supply|power|input|output|operating|rated|operational|utilization|control circuit|u[eirn])\b/i.test(context);
}

function findMaterialAttr(attributes: AttributeRecord[]): string | undefined {
  const materialPatterns = [
    /\bmaterial\b/,
    /\bmaterials\b/,
    /\bwerkstoff\b/,
    /\bmaterijal\b/,
    /\bmateriale\b/,
    /housing.*material/,
    /enclosure.*material/,
    /body.*material/,
    /cover.*material/,
    /cable.*material/,
    /material valve body/,
    /plug.*seat.*stem/,
    /diaphragm/
  ];
  const candidates: Array<{ value: string; score: number }> = [];
  for (const attr of attributes) {
    const haystack = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
    if (/compliance|declaration|certificate|rohs|reach|tsca|substances?/.test(haystack)) continue;
    if (!materialPatterns.some((pattern) => pattern.test(haystack))) continue;
    if (!isLikelySpecText(attr.value) || !isAvailableSpecValue(attr.value)) continue;
    if (isAccessoryOrderWarningMaterialText(attr.value)) continue;
    const material = materialValueFromText(attr.value);
    if (!material) continue;
    candidates.push({
      value: /\bmaterial\b/i.test(attr.name) ? cleanText(attr.value) : material,
      score: materialCandidateScore(attr)
    });
  }
  return candidates.sort((left, right) => right.score - left.score)[0]?.value;
}

function normalizeFinishValue(value: string | undefined): string | undefined {
  const cleaned = normalizeHtmlSpecValue(value);
  return cleaned || undefined;
}

function deriveFinishFromAttributes(attributes: AttributeRecord[]): string | undefined {
  for (const attr of attributes) {
    if (!/(application|construction|finish|feature|detail|material|housing|body|enclosure)/i.test(`${attr.group ?? ""} ${attr.name}`)) continue;
    const finish = finishPhraseFromText(attr.value);
    if (finish) return finish;
  }
  return undefined;
}

function finishPhraseFromText(value: string): string | undefined {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return undefined;
  const phrase = cleaned.match(
    /\b(?:(?:black|white|gr[ae]y|red|blue|green|yellow|orange|silver|natural)\s+)?(?:ANSI[-\s]?61|RAL\s*\d{4}|powder[-\s]?coated|painted|anodized|brushed|nickel[-\s]?plated|zinc[-\s]?plated|chrome[-\s]?plated|(?:pre)?galvanized)\b[^.;]*/i
  )?.[0];
  return phrase ? cleanText(phrase) : undefined;
}

function deriveFinishFromMaterial(value: string | undefined): string | undefined {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return undefined;
  const finishes = [
    ...(cleaned.match(/\b(?:black\s+)?anodized\b/gi) ?? []),
    ...(cleaned.match(/\bnickel[-\s]?plated\b/gi) ?? []),
    ...(cleaned.match(/\bgold[-\s]?plated\b/gi) ?? []),
    ...(cleaned.match(/\bzinc[-\s]?plated\b/gi) ?? []),
    ...(cleaned.match(/\bchrome[-\s]?plated\b/gi) ?? []),
    ...(cleaned.match(/\b(?:pre)?galvanized\b/gi) ?? []),
    ...(cleaned.match(/\bpowder[-\s]?coated\b/gi) ?? []),
    ...(cleaned.match(/\bpainted\b/gi) ?? []),
    ...(cleaned.match(/\bCu\s*\d+(?:[.,]\d+)?\s*(?:µm|um)\b/gi) ?? []),
    ...(cleaned.match(/\bNi\s*\d+(?:[.,]\d+)?\s*(?:µm|um)\b/gi) ?? [])
  ].map((item) => cleanText(item.replace(/\s+/g, " ")));
  return finishes.length ? [...new Set(finishes)].join("; ") : undefined;
}

function findColorAttr(attributes: AttributeRecord[]): string | undefined {
  const explicit = attributes
    .filter((attr) => {
      const haystack = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      return normalizerFieldLabelPatterns("color").some((pattern) => pattern.test(haystack)) &&
        !/\b(display|screen|lcd|tft)\b/.test(haystack) &&
        isLikelySpecText(attr.value) &&
        isAvailableSpecValue(attr.value);
    })
    .sort(compareAttributeEvidence)[0]?.value;
  if (explicit) return normalizeHtmlSpecValue(explicit);
  // A selected ordering-code option may prove a finish (e.g. `SR → RAL 9006`) while not
  // declaring a standalone product color. Do not invent `color` from that option's finish; an
  // explicit target-scoped Color attribute above still wins normally.
  return deriveColorFromFinish(bestAttributeValue(attributes.filter((attr) => attr.scope !== "variant-option"), normalizerFieldLabelPatterns("finish")));
}

function deriveColorFromFinish(value: string | undefined): string | undefined {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return undefined;
  const ansi = cleaned.match(/\bANSI[-\s]?61\s+gr[ae]y\b/i);
  if (ansi) {
    return /optional\s+sub-?panels?.*white/i.test(cleaned) ? "ANSI-61 gray (optional sub-panels white)" : "ANSI-61 gray";
  }
  const colors = [
    ...(cleaned.match(/\b(?:black|white|gr[ae]y|red|blue|green|yellow|orange|silver|natural|beige|cream|brown|clear|transparent)\b/gi) ?? []).map((color) =>
      color.toLowerCase().replace("grey", "gray")
    ),
    ...foreignColorMatches(cleaned)
  ];
  if (colors.length) return [...new Set(colors)].join("; ");
  const ral = cleaned.match(/\bRAL\s*(\d{4})\b/i);
  if (ral) return `RAL ${ral[1]}`;
  return undefined;
}

// German colour words (and a couple of neighbours) mapped to the canonical English name,
// so colours buried in non-English finish/colour text are still understood.
const FOREIGN_COLOR_SYNONYMS: Array<[RegExp, string]> = [
  [/\bhell\s*grau\b|\blicht\s*grau\b|\bgris\s+clair\b|\bgrigio\s+chiaro\b/i, "light gray"],
  [/\bdunkel\s*grau\b|\bgris\s+fonc[ée]\b|\bgrigio\s+scuro\b/i, "dark gray"],
  [/\bgrau\b|\bgris\b|\bgrigio\b/i, "gray"],
  [/\bschwarz\b|\bnoir\b|\bnero\b/i, "black"],
  [/\bwei(?:ß|ss)\b|\bblanc\b|\bbianco\b/i, "white"],
  [/\bsilber\b|\bargent\b|\bargento\b/i, "silver"],
  [/\brot\b|\brouge\b|\brosso\b/i, "red"],
  [/\bblau\b|\bbleu\b|\bblu\b|\bazzurro\b/i, "blue"],
  [/\bgr[üu]n\b|\bvert\b|\bverde\b/i, "green"],
  [/\bgelb\b|\bjaune\b|\bgiallo\b/i, "yellow"]
];

function foreignColorMatches(cleaned: string): string[] {
  const found: string[] = [];
  for (const [pattern, canonical] of FOREIGN_COLOR_SYNONYMS) {
    if (pattern.test(cleaned)) found.push(canonical);
  }
  // A specific shade ("light gray") supersedes the bare "gray" the same text also matches.
  if (found.includes("light gray") || found.includes("dark gray")) {
    return found.filter((color) => color !== "gray");
  }
  return found;
}

function deriveColorFromMaterial(value: string | undefined): string | undefined {
  return deriveColorFromFinish(value);
}

function deriveColorFromProseAttributes(attributes: AttributeRecord[]): string | undefined {
  const hasVariantMaterialOrFinish = attributes.some((attr) =>
    /\bcatalog variant\b/i.test(`${attr.group ?? ""}`) && /\b(material|finish)\b/i.test(attr.name)
  );
  for (const attr of attributes) {
    const label = `${attr.group ?? ""} ${attr.name}`;
    if (!/\b(catalog description|long description|short description|product description|description|features?|application|construction|overview)\b/i.test(label)) continue;
    if (/\b(display|screen|lcd|tft|colour temperature|color temperature)\b/i.test(`${label} ${attr.value}`)) continue;
    const cleaned = normalizeHtmlSpecValue(attr.value);
    if (!cleaned) continue;

    const explicitColor = cleaned.match(/\b(?:colou?r|farbe|couleur|colore|kleur)\b\s*(?:is|:|=|-|of)?\s*([^.;]{1,80})/i);
    const explicitValue = explicitColor ? deriveColorFromFinish(explicitColor[1]) : undefined;
    if (explicitValue) return explicitValue;
    if (hasVariantMaterialOrFinish) continue;

    const componentValue = colorFromComponentProse(cleaned);
    if (componentValue) return componentValue;

    const finishColor = cleaned.match(
      new RegExp(String.raw`\b(?:painted|powder[-\s]?coated|anodized|finished|coated)\s+(?:in\s+)?${COLOR_TOKEN}\b`, "i")
    );
    const finishValue = finishColor ? deriveColorFromFinish(finishColor[0]) : undefined;
    if (finishValue) return finishValue;
  }
  return undefined;
}

const COLOR_TOKEN = String.raw`(?:ANSI[-\s]?61\s+gr[ae]y|RAL\s*\d{4}|black|white|gr[ae]y|red|blue|green|yellow|orange|silver|natural|beige|cream|brown|clear|transparent|hell\s*grau|licht\s*grau|dunkel\s*grau|grau|schwarz|wei(?:ß|ss)|silber|rot|blau|gr[üu]n|gelb|gris\s+clair|gris\s+fonc[ée]|gris|noir|blanc|rouge|bleu|vert|jaune|grigio\s+chiaro|grigio\s+scuro|grigio|nero|bianco|rosso|blu|verde|giallo)`;
const MATERIAL_OR_COMPONENT_TOKEN = String.raw`(?:stainless\s+steel|carbon\s+steel|mild\s+steel|galvanized\s+steel|galvannealed\s+steel|sheet\s+steel|steel|alumin(?:um|ium)|engineering\s+plastic|thermoplastic|polycarbonate|polyamide|polyester|polypropylene|polyethylene|polyolefin|plastic|pvc|pur|rubber|housing|enclosure|body|cover|case|casing|jacket)`;

function colorFromComponentProse(cleaned: string): string | undefined {
  const colorBeforeMaterial = cleaned.match(
    new RegExp(String.raw`\b${COLOR_TOKEN}\s+(?:(?:powder[-\s]?coated|painted|anodized|finished|coated)\s+)?${MATERIAL_OR_COMPONENT_TOKEN}\b`, "i")
  );
  const colorBeforeMaterialValue = colorBeforeMaterial ? deriveColorFromFinish(colorBeforeMaterial[0]) : undefined;
  if (colorBeforeMaterialValue) return colorBeforeMaterialValue;

  const componentThenColor = cleaned.match(
    new RegExp(String.raw`\b(?:housing|enclosure|body|cover|case|casing|jacket)\b[^.;]{0,80}\b(?:in|is|:|,)?\s*(${COLOR_TOKEN})\b`, "i")
  );
  const componentValue = componentThenColor ? deriveColorFromFinish(componentThenColor[1]) : undefined;
  if (componentValue) return componentValue;

  return undefined;
}

function deriveWallThicknessFromAttributes(attributes: AttributeRecord[]): string | undefined {
  const candidates = attributes
    .filter((attr) => {
      const label = `${attr.group ?? ""} ${attr.name}`;
      const haystack = `${label} ${attr.value}`;
      if (/\brelated product\b/i.test(`${attr.group ?? ""} ${attr.name}`)) return false;
      if (!/\b(thick(?:ness)?|gauge|wall|sheet|body|door)\b/i.test(label) && !isDescriptionLikelyWallThickness(attr.value)) return false;
      if (/description/i.test(attr.name) && !/\b(thick(?:ness)?|gauge|sheet|body|wall|door)\b/i.test(haystack)) return false;
      if (/description/i.test(attr.name) && !isDescriptionLikelyWallThickness(attr.value)) return false;
      return /(construction|material|enclosure|body|sheet|wall|thickness|gauge)/i.test(haystack) && !/(height|width|depth|dimension)/i.test(attr.name);
    })
    .map((attr) => normalizeWallThicknessValue(`${attr.name} ${attr.value}`))
    .filter((value): value is string => Boolean(value));
  return candidates[0];
}

function isDescriptionLikelyWallThickness(value: string): boolean {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return false;
  if (/\b(?:thick(?:ness)?|gauge)\b.{0,40}\b\d+(?:[.,]\d+)?\s*(?:in\.?|inch|inches|"|mm|cm)\b/i.test(cleaned)) return true;
  if (/\b\d+(?:[.,]\d+)?\s*(?:in\.?|inch|inches|"|mm|cm)\b.{0,40}\b(?:thick(?:ness)?|gauge)\b/i.test(cleaned)) return true;
  return /\b\d+(?:[.,]\d+)?\s*(?:in\.?|inch|inches|"|mm|cm)\.?\s+(?:carbon|mild|stainless|galvanized|galvannealed)?\s*(?:steel|aluminum|aluminium)\b/i.test(cleaned);
}

function normalizeWallThicknessValue(value: string | undefined): string | undefined {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return undefined;
  if (/[{}\[\]]|attributeid|data-row-data|measuresys/i.test(cleaned)) return undefined;
  if (/\b(?:wall\s+)?mounting\b/i.test(cleaned) && !/\b(?:thick(?:ness)?|gauge|sheet|steel|stainless|aluminum|aluminium|body|door)\b/i.test(cleaned)) return undefined;
  const explicitlyThickness = /\b(?:thick(?:ness)?|gauge|wall|sheet)\b/i.test(cleaned);
  if (!explicitlyThickness && /\b(?:lead wire|wire|cable|cord|flange|studs?|npt|thread)\b/i.test(cleaned)) return undefined;
  if (!explicitlyThickness && /\b(?:mm²|mm2|kcmil|awg|conductor|wire size|hole size|diameter|length|height|width|depth)\b/i.test(cleaned)) return undefined;
  if (/\b\d+(?:[.,]\d+)?\s*[xX*]\s*\d+(?:[.,]\d+)?\s*(?:[xX*]\s*\d+(?:[.,]\d+)?\s*)?(?:mm|cm|m|in|inch|inches|")\b/i.test(cleaned)) {
    if (!/\b(?:thick(?:ness)?|gauge)\b.{0,40}\b\d+(?:[.,]\d+)?\s*(?:in\.?|inch|inches|"|mm|cm)\b/i.test(cleaned)) return undefined;
  }
  const match = cleaned.match(/\b(\d+(?:[.,]\d+)?)\s*(in\.?|inch|inches|"|mm|cm)\b/i);
  if (!match) return undefined;
  if (!explicitlyThickness && isNonWallThicknessMeasurementContext(cleaned, match)) return undefined;
  const haystack = cleaned.toLowerCase();
  if (!/\b(thick(?:ness)?|gauge|steel|stainless|aluminum|aluminium|carbon|sheet|body|wall|door)\b/.test(haystack)) return undefined;
  const number = localizedNumber(match[1]);
  if (!Number.isFinite(number)) return undefined;
  const unit = normalizeDimensionUnit(match[2]) ?? match[2].toLowerCase();
  if (unit === "mm") return `${formatNumber(number)} mm`;
  if (unit === "cm") return `${formatNumber(number)} cm (${formatConvertedNumber(number * 10)} mm)`;
  return `${match[1]} in (${formatConvertedNumber(number * 25.4)} mm)`;
}

function isNonWallThicknessMeasurementContext(value: string, match: RegExpMatchArray): boolean {
  const index = match.index ?? 0;
  const context = value.slice(Math.max(0, index - 35), Math.min(value.length, index + match[0].length + 45));
  return /\b(?:lead wire|wire|cable|cord|flange|studs?|npt|thread|connector|terminal|filter|grille|gasket|hinge|latch|mounting bracket)\b/i.test(context);
}

function collectProtectionValues(attributes: AttributeRecord[]): string | undefined {
  const values = attributes
    .filter((attr) => /\bip\b|nema|protection|environmental rating|\benclosure\b|industry standard|stupanj/i.test(`${attr.group ?? ""} ${attr.name}`))
    .flatMap((attr) => {
      const value = normalizeProtectionValue(attr.value);
      if (!value || !isLikelySpecText(value) || !isAvailableSpecValue(value)) return [];
      // Standards blocks commonly repeat a rating in multiple certification paragraphs. Their
      // protection meaning is the published rating token, not the surrounding approval prose.
      const label = `${attr.group ?? ""} ${attr.name}`;
      return /\bindustry standards?\b/i.test(label) ? protectionTokens(value) : [value];
    });
  const unique = uniqueProtectionValues(values);
  return unique.length ? unique.join("; ") : undefined;
}

function deriveProtectionFromText(attributes: AttributeRecord[]): string | undefined {
  const values = attributes
    .filter(isElectricalTextCandidate)
    .map((attr) => normalizeProtectionValue(derivedSpecText(attr)))
    .filter((value): value is string => Boolean(value && isLikelySpecText(value) && isAvailableSpecValue(value)));
  const unique = uniqueProtectionValues(values);
  return unique.length ? unique.join("; ") : undefined;
}

function normalizeProtectionValue(value: string | undefined): string | undefined {
  const cleaned = normalizeHtmlSpecValue(value);
  // Require a real protection token (a digit after NEMA/IP/IK/Type, or the IEC 60529 standard).
  // A bare "NEMA" with no rating is page chrome or accessory prose ("Works With: NEMA Details")
  // and must not be treated as a protection rating.
  if (!cleaned || !/\b(?:ip\s*\d|nema\s*\d|ik\s*\d|iec\s*60529|type\s+\d)/i.test(cleaned)) return undefined;
  const withoutDownloadLabels = cleanProtectionSegments(
    cleaned
    .replace(/\s*(?:datasheet|data sheet|manual|downloads?|cad|certificate).*$/i, "")
    .replace(/[;,\s]+$/g, "")
      .trim()
  );
  const compact = [
    ...new Set(withoutDownloadLabels.match(/\b(?:IP\s*\d{2}[A-Z]?|IK\s*\d{2}|NEMA\s*\d+[A-Z]?|Type\s+\d+[A-Z]?)\b/gi) ?? [])
  ].map((token) => token.replace(/\s+/g, "").replace(/^type/i, "Type"));
  if (
    (withoutDownloadLabels.length > 80 || /\b(?:pn|i2n|acs\d|kw)\b/i.test(withoutDownloadLabels)) &&
    !/\b(?:front|rear|panel|terminal|housing|enclosure)\b/i.test(withoutDownloadLabels)
  ) {
    if (compact.length) return compact.join("; ");
  }
  return withoutDownloadLabels || undefined;
}

function cleanProtectionSegments(value: string): string {
  return value
    .split(";")
    .map((part) => {
      const cleaned = cleanText(part);
      return cleaned.includes("(") ? cleaned : cleaned.replace(/\)+$/g, "");
    })
    .filter(Boolean)
    .join("; ");
}

function uniqueProtectionValues(values: string[]): string[] {
  const unique: string[] = [];
  const uniqueTokenSets: string[][] = [];
  for (const value of values) {
    for (const part of splitProtectionValues(value)) {
      const tokens = protectionDedupeTokens(part);
      const key = tokens.length ? tokens.join("|") : part.toLowerCase();
      if (!key) continue;
      if (tokens.length && uniqueTokenSets.some((existing) => tokens.every((token) => existing.includes(token)))) continue;
      unique.push(part);
      uniqueTokenSets.push(tokens.length ? tokens : [key]);
    }
  }
  return unique;
}

function splitProtectionValues(value: string): string[] {
  if (!value.includes(";")) return [value];
  const parts = value.split(";").map(cleanText).filter(Boolean);
  if (parts.length <= 1) return [value];
  return parts;
}

function protectionDedupeKey(value: string): string {
  const tokens = protectionDedupeTokens(value);
  return tokens.length ? tokens.join("|") : value.toLowerCase();
}

function protectionDedupeTokens(value: string): string[] {
  return protectionTokens(value).map((token) => token.toUpperCase());
}

function protectionTokens(value: string): string[] {
  const tokens = value.match(/\b(?:IP\s*\d{2}[A-Z]?|IK\s*\d{2}|NEMA\s*\d+[A-Z]?|Type\s*\d+[A-Z]?)\b/gi);
  return tokens?.length ? [...new Set(tokens.map((token) => token.replace(/\s+/g, "").replace(/^type/i, "Type")))] : [];
}

function deriveMaterialFromAttributes(attributes: AttributeRecord[]): string | undefined {
  const cable = attributes.find((attr) => /^cable$/i.test(attr.name));
  if (cable?.value) {
    const material = cable.value.split(",")[0]?.trim();
    if (material && !isAccessoryOrderWarningMaterialText(cable.value) && /pur|pvc|tpe|ptfe|rubber|silicone|poly|steel|stainless|aluminum|aluminium|zinc|brass|copper|cast iron|epdm/i.test(material)) {
      return material;
    }
  }

  for (const attr of attributes) {
    if (!/(construction|material|body|housing|enclosure)/i.test(`${attr.group ?? ""} ${attr.name}`)) continue;
    const madeOfMaterial = materialFromMadeOfPhrase(attr.value);
    if (madeOfMaterial) return madeOfMaterial;
    if (isSecondaryComponentMaterialText(attr.value)) continue;
    const material = materialValueFromText(attr.value);
    if (material) return material;
  }

  const description = attributes.find((attr) => /description/i.test(attr.name));
  if (description?.value) {
    if (isAccessoryOrderWarningMaterialText(description.value)) return undefined;
    const material = materialValueFromText(description.value);
    if (material) return material;
  }

  for (const attr of attributes) {
    if (!/(description|overview|application|finish|feature|detail|material|body|housing|enclosure)/i.test(`${attr.group ?? ""} ${attr.name}`)) continue;
    const madeOfMaterial = materialFromMadeOfPhrase(attr.value);
    if (madeOfMaterial) return madeOfMaterial;
    if (isSecondaryComponentMaterialText(attr.value)) continue;
    const material = materialValueFromText(attr.value);
    if (material) return material;
  }

  return undefined;
}

function materialFromMadeOfPhrase(value: string): string | undefined {
  const cleaned = normalizeHtmlSpecValue(value);
  if (isAccessoryOrderWarningMaterialText(cleaned)) return undefined;
  const match = cleaned?.match(/\bmade\s+(?:of|from)\s+([^.]+)|\b(?:constructed|fabricated|manufactured|formed)\s+(?:of|from)\s+([^.]+)/i);
  return materialValueFromText(match?.[1] ?? match?.[2] ?? "");
}

function isAccessoryOrderWarningMaterialText(value: string | undefined): boolean {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return false;
  if (/\bdownload\s*(?:\(\s*zip\s*\)|zip)?\b/i.test(cleaned)) return true;
  if (/\bdo\s+not\s+order\b/i.test(cleaned)) return true;
  if (/\border(?:ing)?\b[^.;]{0,80}\bpart\s+number\b/i.test(cleaned)) return true;
  if (/\bpart\s+number\b[^.;]{0,80}\b(?:accessor(?:y|ies)|cable|cord|connector|usb|cp-usb)\b/i.test(cleaned)) return true;
  return false;
}

function isSecondaryComponentMaterialText(value: string): boolean {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return false;
  if (/\bbase material\b/i.test(cleaned)) return false;
  if (/\b(?:housing|body|enclosure)\b/i.test(cleaned)) return false;
  if (/\bcover\b/i.test(cleaned) && !/\bfilter cover\b/i.test(cleaned)) return false;
  return /\b(?:accessor(?:y|ies)|fittings?|hex nut|knurled nut|fasteners?|screws?|washers?|hardware|terminal|wire size|mounting screw|mounting bracket|filters?|grille|ports?|gaskets?|hinges?|latches?|lead wire|wire|cable|cord|connector)\b/i.test(cleaned);
}

function materialValueFromText(value: string): string | undefined {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return undefined;
  if (isAccessoryOrderWarningMaterialText(cleaned)) return undefined;
  if (/\b(?:stainless steel|carbon steel|mild steel|galvannealed steel|galvanized steel|steel|aluminum|aluminium)\s+(?:cleaner|cleaning|paint|label)\b/i.test(cleaned)) {
    return undefined;
  }
  if (/\bstainless\s+steel\s+type\s+316\/316L\b/i.test(cleaned)) return "stainless steel Type 316/316L";
  if (/\bstainless\s+steel\s+type\s+304\b/i.test(cleaned)) return "stainless steel Type 304";
  if (/\baluzinc\s+coated\s+steel\b/i.test(cleaned)) return "aluzinc coated steel";
  const composite = compositeMaterialValue(cleaned);
  if (composite) return composite;
  if (/\bS\.?\s*S\.?\b/i.test(cleaned)) return "stainless steel";
  if (/^(?:PA|PC|POM|PBTP?|PETP?|PE|PP|PPS|PTFE|PUR|PVC|ABS|ASA|SAN|PMMA|PEEK|PEI|TPE|TPU|HDPE|LDPE)(?:\s*\d{1,2})?$/u.test(cleaned)) return cleaned;
  const foreign = foreignMaterialSynonym(cleaned);
  if (foreign) return foreign;
  const match = cleaned.match(
    /\b(techpolymer|feraloy iron alloy|iron alloy|spheroidal cast iron|malleable cast iron|cast iron|stainless steel|carbon steel|mild steel|galvannealed steel|galvanized steel|sheet steel|steel|aluminum|aluminium|die-cast zinc|zinc|nickel[-\s]?plated brass|brass|nickel[-\s]?plated copper|copper braid|copper|fluoropolymer|polyolefin|engineering plastic|thermoplastic|polycarbonate|polyamide|polyurethane|polypropylene|polyethylene|polyester|fiberglass|plastic|silicone|nylon|rubber|pvc|pur|epdm|abs|ceramic|glass)\b/i
  );
  return match ? cleanText(match[1]).replace(/^aluminium$/i, "aluminum") : undefined;
}

function compositeMaterialValue(cleaned: string): string | undefined {
  const normalized = cleaned.replace(/\bglass\s*fibre\b/gi, "glass fiber");
  const gfPolymer = normalized.match(
    /\b(?:glass[-\s]?fiber|fiberglass)\s*(?:reinforced|filled)?\s+(polyamide|polycarbonate|polyester|polypropylene|polyethylene|polyurethane|plastic|PBT|PA|PC|PP|PE)(?:\s*\d{1,2}(?:[.,]\d)?)?(?:\s*GF\s*\d{1,2})?\b/i
  );
  if (gfPolymer) return `glass-fiber reinforced ${canonicalPolymerName(gfPolymer[1])}`;

  const polymerGf = normalized.match(
    /\b(PA|PC|PBT|PET|PP|PE|ABS|ASA|POM|PPS|PEEK|PEI|polyamide|polycarbonate|polyester|polypropylene|polyethylene|plastic)\s*(?:\d{1,2}(?:[.,]\d)?)?\s*GF\s*(\d{1,2})\b/i
  );
  if (polymerGf) return `${canonicalPolymerName(polymerGf[1])} GF${polymerGf[2]}`;

  if (/\bdie[-\s]?cast\s+alumin(?:um|ium)\b|\balumin(?:um|ium)\s+die[-\s]?cast\b/i.test(cleaned)) return "die-cast aluminum";
  if (/\bpainted\s+galvanized\s+steel\b/i.test(cleaned)) return "painted galvanized steel";
  if (/\bpowder[-\s]?coated\s+(?:sheet\s+)?steel\b/i.test(cleaned)) return "powder-coated steel";

  return undefined;
}

function canonicalPolymerName(value: string): string {
  const compact = value.toUpperCase().replace(/\s+/g, "");
  if (compact === "PA") return "polyamide";
  if (compact === "PC") return "polycarbonate";
  if (compact === "PBT" || compact === "PET") return "polyester";
  if (compact === "PP") return "polypropylene";
  if (compact === "PE") return "polyethylene";
  return cleanText(value).toLowerCase();
}

// Non-English material names (German first, light Italian/French) mapped to the canonical
// English term so multilingual manufacturer pages (Phoenix, Siemens, Schmersal, Spelsberg,
// Fath, Eta...) stop losing material data. Steel grade numbers map to the matching SS type.
const FOREIGN_MATERIAL_SYNONYMS: Array<[RegExp, string]> = [
  [/\b1\.4404\b|\b1\.4571\b|\bv4a\b/i, "stainless steel Type 316/316L"],
  [/\b1\.4301\b|\bv2a\b/i, "stainless steel Type 304"],
  [/\bedelstahl\b|\bnirosta\b|\bacciaio\s+inox\b|\bacier\s+inoxydable\b/i, "stainless steel"],
  [/\bstahlblech\b/i, "sheet steel"],
  [/\bverzinkter?\s+stahl\b|\bverzinktem\s+stahl\b|\bverzinkter?\s+stahlblech\b/i, "galvanized steel"],
  [/\bgusseisen\b|\bgrauguss\b|\bfonte\b|\bghisa\b/i, "cast iron"],
  [/\bstahl\b|\bacciaio\b|\bacier\b/i, "steel"],
  [/\baluminiumlegierung\b|\baluminiumdruckguss\b|\balluminio\b/i, "aluminum"],
  [/\bpolycarbonat\b|\bpolicarbonato\b/i, "polycarbonate"],
  [/\bpolyamid\b|\bpoliammide\b/i, "polyamide"],
  [/\bkunststoff\b|\bthermoplast\b|\bplastik\b|\bplastique\b|\bplastica\b/i, "plastic"],
  [/\bmessing\b|\blaiton\b|\bottone\b/i, "brass"],
  [/\bbronze\b|\bbronzo\b/i, "bronze"],
  [/\bkupfer\b|\bcuivre\b|\brame\b/i, "copper"],
  [/\bzink\b|\bzinco\b/i, "zinc"]
];

function foreignMaterialSynonym(cleaned: string): string | undefined {
  for (const [pattern, canonical] of FOREIGN_MATERIAL_SYNONYMS) {
    if (pattern.test(cleaned)) return canonical;
  }
  return undefined;
}

function normalizeCertificateValue(value: string, allowNotApplicable = false): string {
  const cleaned = stripCertificateLegalProse(cleanCertificateResourceText(
    cleanText(value)
      .replace(/ddrivetip\('([\s\S]*?)'\s*,[\s\S]*$/i, "$1")
      .replace(/<br\s*\/?>/gi, "; ")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/CE(?=cULus)/g, "CE, ")
      .replace(/cULus(?=cURus)/g, "cULus, ")
      .replace(/cULus(?=WEEE)/g, "cULus, ")
      .replace(/([,;])\s*/g, "$1 ")
      .replace(/\s+/g, " ")
      .trim()
  ));
  if (allowNotApplicable && /^(not applicable|no certification needed|no certifications? needed|n\/a)$/i.test(cleaned)) return cleaned;
  if (allowNotApplicable && /^(?:UL|CSA|NEMA)\s+(?:not applicable|n\/a|na)$/i.test(cleaned)) return cleaned;
  if (isGenericCertificatePlaceholder(cleaned)) return "";
  const tokens = [
    ...(cleaned.match(/\bcULus\s+File\s+Component\s+Recognized\s+[A-Z0-9-]+/gi) ?? []),
    ...(cleaned.match(/\bcULus\s+(?:Listed|Recognized)\s+[A-Z0-9-]+/gi) ?? []),
    ...(cleaned.match(/\bUL\s+File(?:\s+No\.?)?\s+[A-Z]*\d[A-Z0-9_-]*/gi) ?? []),
    ...(cleaned.match(/\bCSA\s+File(?:\s+No\.?)?\s+[A-Z]*\d[A-Z0-9_-]*/gi) ?? []),
    ...(cleaned.match(/\bCSA\s+C22\.2\s+No\.?\s+\d+(?:\.\d+)*/gi) ?? []),
    ...(cleaned.match(/\bUL\s+\d+(?:\.\d+)*/gi) ?? []),
    ...(cleaned.match(/\bNEMA\s+BI\s+\d+/gi) ?? []),
    ...(cleaned.match(/\bNEMA\s+Type\s+[A-Z0-9 -]+/gi) ?? []),
    ...(cleaned.match(/\bUL\s+Listed\b/gi) ?? []),
    ...(cleaned.match(/\bUL\s+Listed\s+[^;]+/gi) ?? []),
    ...(cleaned.match(/\bUL\s+(?:Component\s+)?Recognized\b/gi) ?? []),
    ...(cleaned.match(/\bCSA\s+Listed\b/gi) ?? []),
    ...(cleaned.match(/\bCSA\s+Type\s+[^;]+/gi) ?? []),
    ...(cleaned.match(/\bCSA\s+(?:Component\s+)?Recognized\b/gi) ?? []),
    ...(cleaned.match(/\bRegistro\s+Italiano\s+Navale\b/gi) ?? []),
    ...(cleaned.match(/\bRINA\b/g) ?? []),
    ...(cleaned.match(/\bDNV(?:\s+GL)?(?:\s+Marine)?\b/gi) ?? []),
    ...(cleaned.match(/\bIEC\s+\d+(?:[.-]\d+)*(?:\s+IP\s*\d{1,2}[A-Z]?)?/g) ?? []),
    ...(cleaned.match(/\bIEC\b/g) ?? []),
    ...(cleaned.match(/\bcULus\b/g) ?? []),
    ...(cleaned.match(/\bcURus\b/g) ?? []),
    ...(cleaned.match(/\bcUL\b/g) ?? []),
    ...(cleaned.match(/\bCCC\b/g) ?? []),
    ...(cleaned.match(/\bBV\b/g) ?? []),
    ...(cleaned.match(/\bEAC\b/g) ?? []),
    ...(cleaned.match(/\bRCM\b/g) ?? []),
    ...(cleaned.match(/\bKC\b/g) ?? []),
    ...(cleaned.match(/\bODVA\b/g) ?? []),
    ...(cleaned.match(/\bC-?Tick\b/gi) ?? []),
    ...(cleaned.match(/\bATEX\b/g) ?? []),
    ...(cleaned.match(/\bIECEx\b/gi) ?? []),
    ...(cleaned.match(/\bClass\s+I\s+Div\.?\s*2(?:\s+HazLoc)?\b/gi) ?? []),
    ...(cleaned.match(/\bNEC\s+Class\s+2\b/gi) ?? []),
    ...(cleaned.match(/\bSIL\s*\d\b/gi) ?? []),
    ...(cleaned.match(/\bVDE\b/g) ?? []),
    ...(cleaned.match(/\bT(?:Ü|U)V\b/gi) ?? []),
    ...(cleaned.match(/\bCSA\b/g) ?? []),
    ...(cleaned.match(/\bUL\b/g) ?? []),
    ...(cleaned.match(/\bLloyds?\b/gi) ?? []),
    ...(cleaned.match(/\bWEEE\b/g) ?? []),
    ...(cleaned.match(/\bREACH\b/gi) ?? []),
    ...(cleaned.match(/\bRoHS\b/gi) ?? []),
    ...(cleaned.match(/\bUKCA\b/g) ?? []),
    ...(cleaned.match(/\bPED\s+\d{4}\/\d+\/[A-Z]+/gi) ?? []),
    ...(cleaned.match(/\bCE\b/g) ?? [])
  ].map(cleanText);
  if (tokens.length > 0) return uniqueCertificateTokens(tokens).sort(compareCertificateToken).join("; ");
  // Fallback for values that mention certification-flavored words but matched none of the specific
  // codes above: safe for a genuinely short label ("UL Certificate", "Declaration of Conformity")
  // but not for a full sentence — e.g. a resource-list blurb like "Product Certifications website
  // ... Provides declarations of conformity, certificates, and other certification details."
  // describes a WEBSITE, not this product's own certificates, and would otherwise leak into the
  // Certificates field verbatim. Long, sentence-shaped text is dropped instead of guessed at.
  if (cleaned.length <= 60 && /\b(certificate|declaration|conformity|listed|approved)\b/i.test(cleaned)) return cleaned;
  return "";
}

function literalCertificateAttributeValues(attributes: AttributeRecord[]): string[] {
  return attributes
    .filter((attr) => /^Industry Standards\s+-\s+\(IS\d+\)$/i.test(attr.group ?? "") && /^Standard$/i.test(attr.name))
    .map((attr) => cleanCertificateResourceText(attr.value))
    .filter(Boolean);
}

function uniqueLiteralCertificateTokens(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    const compact = compactCertificateToken(cleaned);
    if (!cleaned || seen.has(compact)) continue;
    seen.add(compact);
    unique.push(cleaned);
  }
  return unique;
}

function isGenericCertificatePlaceholder(value: string): boolean {
  return /^(?:certificate\s+programs?|certifications?|approvals?|standards?|product certifications?)$/i.test(cleanText(value));
}

function normalizeDocumentCertificateValue(doc: DocumentRecord): string {
  const text = `${doc.label} ${doc.url}`;
  const cleanedLabel = cleanCertificateResourceText(doc.label);
  if (/circularity/i.test(text)) return "Circularity Profile";
  if (/environmental|ecopassport|pep/i.test(text)) return "Environmental Disclosure";
  if (/end.?of.?life/i.test(text)) return "End of Life Information";
  if (/reach/i.test(text)) return "REACH Regulation";
  if (/rohs/i.test(text)) return "RoHS";
  if (/weee/i.test(text)) return "WEEE";
  if (/tsca/i.test(text)) return "TSCA";
  if (/prop\s*65/i.test(text)) return "Prop 65";
  if (/cmim/i.test(text)) return "CMim Declaration of Conformity";
  if (/\buk\b/i.test(text) && /\b(declaration|conformity)\b/i.test(text)) return "UK Declaration of Conformity";
  if (/\beu\b/i.test(text) && /\b(declaration|conformity)\b/i.test(text)) return "EU Declaration of Conformity";
  if (/\b(declaration|conformity)\b/i.test(doc.label)) return cleanedLabel;
  return normalizeCertificateValue(cleanedLabel, true);
}

function cleanCertificateResourceText(value: string): string {
  return collapseRepeatedPhrase(
    cleanText(value)
      // The size (and any language right after it) is stripped ANYWHERE, not just at the end: nVent
      // writes "Declaration of Conformity 117 KB English Declaration of Conformity", with the download
      // decoration in the MIDDLE, so the previously end-anchored rule never fired and the whole string
      // shipped inside normalized.certificates.
      .replace(
        /\s*\d+(?:[.,]\d+)?\s*(?:KB|MB|GB)(?:\s*(?:English|German|Deutsch|French|Spanish|Italian|Dutch|Polish|Czech|Danish|Swedish|Norwegian|Finnish|Portuguese|Chinese|Japanese|Korean))?\s*/gi,
        " "
      )
      // A bare language name is only stripped at the END. Doing it anywhere would damage real
      // certification bodies whose names contain one — "Germanischer Lloyd", "German Lloyd".
      .replace(/\b(?:English|German|Deutsch|French|Spanish|Italian|Dutch|Polish|Czech|Danish|Swedish|Norwegian|Finnish|Portuguese|Chinese|Japanese|Korean)\b\s*$/i, "")
      .replace(/\s*[-,;:]\s*$/g, "")
      .trim()
  );
}

/**
 * Collapse a phrase repeated back-to-back, which is what removing the decoration between two copies of a
 * document's name leaves behind: "Declaration of Conformity Declaration of Conformity".
 */
function collapseRepeatedPhrase(value: string): string {
  const words = value.split(/\s+/).filter(Boolean);
  for (let size = Math.floor(words.length / 2); size >= 1; size -= 1) {
    const head = words.slice(0, size).join(" ").toLowerCase();
    const next = words.slice(size, size * 2).join(" ").toLowerCase();
    if (head && head === next) return collapseRepeatedPhrase([...words.slice(0, size), ...words.slice(size * 2)].join(" "));
  }
  return value;
}

function stripCertificateLegalProse(value: string): string {
  return value
    .replace(/\bdescribed above is in conformity with[\s\S]*$/i, "")
    .replace(/\bof conformity is issued under[\s\S]*$/i, "")
    .replace(/\bon this Certificate\b[\s\S]*$/i, "")
    .replace(/\s*[,;]\s*$/g, "")
    .trim();
}

function splitCertificateValues(value: string): string[] {
  // Split on ';' and ',' and '/' so values like "IEC/UL" or "CCC,CE,RoHS" become individual tokens.
  // We keep slash-splitting conservative: only when both sides look like short certification
  // tokens (no spaces, no digits in the way) — to avoid breaking things like "EN 60947-1/2".
  return value
    .split(/[;,]/)
    .flatMap((part) => {
      const trimmed = cleanText(part);
      if (!trimmed) return [];
      const slashParts = trimmed.split("/").map(cleanText).filter(Boolean);
      // Only treat as a slash-separated standards list if each part is a short alphanumeric token
      // (e.g. "IEC", "UL", "CSA") with no embedded standards-number that owns the slash.
      const looksLikeStandardsList = slashParts.length > 1 && slashParts.every((p) => /^[A-Za-z][A-Za-z0-9-]{1,10}$/.test(p));
      return looksLikeStandardsList ? slashParts : [trimmed];
    })
    .filter(Boolean);
}

function removeSubsumedCertificateTokens(values: string[]): string[] {
  const compactValues = values.map(compactCertificateToken);
  return values.filter((value) => {
    const compact = compactCertificateToken(value);
    if (compact === "ul" && compactValues.some((other) => /^ul(?:notapplicable|na)$/.test(other))) return false;
    if (compact === "csa" && compactValues.some((other) => /^csa(?:notapplicable|na)$/.test(other))) return false;
    if (/^(?:ul508|ulrecognized)$/.test(compact) && compactValues.some((other) => /^(?:culus|curus)$/.test(other))) return false;
    if (compact === "ul" && compactValues.some((other) => other !== compact && /^(?:ul|cul|culus)/.test(other) && other.includes("ul"))) return false;
    if (compact === "csa" && compactValues.some((other) => other !== compact && /^csa/.test(other))) return false;
    if (/^(?:ce|bv)$/.test(compact)) return true;
    return !values.some((other) => {
      if (other === value) return false;
      const compactOther = compactCertificateToken(other);
      // Subsume only when the larger token STARTS WITH the smaller one (e.g. "UL Listed E12345"
      // subsumes "UL"). Substring-anywhere was too greedy — e.g. "REACh Regulation" contains
      // the substring "ul" inside "regulation" and was wrongly subsuming a bare "UL" token.
      return compactOther.length > compact.length && compactOther.startsWith(compact);
    });
  });
}

function uniqueCertificateTokens(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const canonical = canonicalCertificateToken(value);
    // Drop bare placeholder values that pollute the Certificates column. We KEEP prefixed
    // variants like "UL Not Applicable" / "CSA N/A" / "NEMA Not Applicable" because they're
    // informative (the manufacturer reports a standard was evaluated and didn't apply).
    if (/^(?:no certifications? needed|not applicable|n\/a)$/i.test(canonical)) {
      continue;
    }
    const compact = compactCertificateToken(canonical);
    if (!canonical || seen.has(compact)) continue;
    seen.add(compact);
    unique.push(canonical);
  }
  return unique;
}

function canonicalCertificateToken(value: string): string {
  const cleaned = cleanText(value);
  if (isGenericCertificatePlaceholder(cleaned)) return "";
  if (/^ce(?:\s+marked)?$/i.test(cleaned)) return "CE";
  if (/^ul\s+listed\b/i.test(cleaned)) return "UL Listed";
  if (/^ul\s+(?:component\s+)?recognized\b/i.test(cleaned)) return "UL Recognized";
  if (/^csa\s+listed\b/i.test(cleaned)) return "CSA Listed";
  if (/^registro\s+italiano\s+navale$/i.test(cleaned)) return "RINA";
  if (/^australian\s+rcm$/i.test(cleaned)) return "RCM";
  if (/^korean\s+kc$/i.test(cleaned)) return "KC";
  if (/^china\s+ccc$/i.test(cleaned)) return "CCC";
  if (/^ukca\s+doc$/i.test(cleaned)) return "UKCA";
  if (/^morocco\s+doc$/i.test(cleaned)) return "Morocco";
  if (/^iecex\s+scheme$/i.test(cleaned)) return "IECEx";
  if (/^c-?tick$/i.test(cleaned)) return "C-Tick";
  if (/^t(?:ü|u)v$/i.test(cleaned)) return "TÜV";
  if (/^reach$/i.test(cleaned)) return "REACH";
  if (/^rohs$/i.test(cleaned)) return "RoHS";
  if (/^weee$/i.test(cleaned)) return "WEEE";
  if (/^ce$/i.test(cleaned)) return "CE";
  if (/^ul$/i.test(cleaned)) return "UL";
  if (/^iec$/i.test(cleaned)) return "IEC";
  if (/^csa$/i.test(cleaned)) return "CSA";
  if (/^ukca$/i.test(cleaned)) return "UKCA";
  if (/^eac$/i.test(cleaned)) return "EAC";
  if (/^vde$/i.test(cleaned)) return "VDE";
  if (/^kc$/i.test(cleaned)) return "KC";
  if (/^odva$/i.test(cleaned)) return "ODVA";
  if (/^atex$/i.test(cleaned)) return "ATEX";
  if (/^iecex$/i.test(cleaned)) return "IECEx";
  if (/^culus$/i.test(cleaned)) return "cULus";
  if (/^curus$/i.test(cleaned)) return "cURus";
  if (/^cul$/i.test(cleaned)) return "cUL";
  if (/^lloyds?$/i.test(cleaned)) return "Lloyds";
  return cleaned;
}

function compactCertificateToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function compareCertificateToken(left: string, right: string): number {
  return certificateTokenRank(left) - certificateTokenRank(right) || left.localeCompare(right, undefined, { sensitivity: "base" });
}

function certificateTokenRank(value: string): number {
  // Order roughly matches the manual PDT convention: international/standards first
  // (IEC, then UL family, then regional CE/UKCA), declarations (RoHS/REACH) last.
  if (/^iec/i.test(value)) return 5;
  if (/^ul/i.test(value)) return 10;
  if (/^culus$/i.test(value)) return 15;
  if (/^curus$/i.test(value)) return 16;
  if (/^cul$/i.test(value)) return 18;
  if (/^csa/i.test(value)) return 20;
  if (/^ce$/i.test(value)) return 30;
  if (/^ukca$/i.test(value)) return 35;
  if (/^nema/i.test(value)) return 40;
  if (/^weee$/i.test(value)) return 60;
  if (/^reach$/i.test(value)) return 70;
  if (/^rohs$/i.test(value)) return 80;
  if (/^ip/i.test(value)) return 100;
  return 90;
}

function isLikelySpecText(value: string): boolean {
  const cleaned = cleanText(value);
  if (!cleaned || cleaned.length > 500) return false;
  return !/[{}]|var\(--|@media|display\s*:|calc\(|--[a-z0-9-]+/i.test(cleaned);
}

function isAvailableSpecValue(value: string): boolean {
  return !/^(not available|n\/a|na|none|-|not applicable|selected result)$/i.test(cleanText(value)) && !/\bsee\s+[\u00ab"]?dimensions[\u00bb"]?\b/i.test(cleanText(value)) && !/^(internal connection diagram|installation drawings?|installation drawing)$/i.test(cleanText(value));
}

function materialCandidateScore(attr: AttributeRecord): number {
  const haystack = `${attr.group ?? ""} ${attr.name} ${attr.value}`.toLowerCase();
  let score = Math.round(attributeEvidenceScore(attr) / 10);
  if (/\bmaterial\b/i.test(attr.name)) score += 20;
  if (/\bcatalog variant\b/i.test(haystack)) score += 45;
  if (/housing|enclosure|body|valve body|cable jacket/i.test(haystack)) score += 40;
  if (/spheroidal cast iron|carbon steel|stainless steel|mild steel|galvanized steel|galvannealed steel|engineering plastic|thermoplastic|polycarbonate|polyester|pvc|pur/i.test(haystack)) score += 20;
  if (/accessor(?:y|ies)|fittings?|hex nut|knurled nut|screw|terminal|mounting screw|wire size/i.test(haystack)) score -= 35;
  return score;
}

function normalizeHtmlSpecValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = cleanText(value)
    .replace(/ddrivetip\('([\s\S]*?)'\s*,[\s\S]*$/i, "$1")
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function formatConvertedNumber(value: number): string {
  return Number((value + 1e-9).toFixed(2)).toFixed(2);
}

function dedupeAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  return dedupeAttributesBase(attributes, { includeSourceUrl: true });
}

/**
 * Deterministically sort attributes by (group, name, sourceUrl) so successive runs that hit
 * sources in different orders still produce byte-identical outputs. Used after merging
 * primary + fallback attribute lists.
 */
function sortAttributesStable(attributes: AttributeRecord[]): AttributeRecord[] {
  return [...attributes].sort((left, right) => {
    const groupCmp = (left.group ?? "").localeCompare(right.group ?? "");
    if (groupCmp !== 0) return groupCmp;
    const nameCmp = left.name.localeCompare(right.name);
    if (nameCmp !== 0) return nameCmp;
    return (left.sourceUrl ?? "").localeCompare(right.sourceUrl ?? "");
  });
}

const dedupeDocuments = dedupeSharedDocuments;
