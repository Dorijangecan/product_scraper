import type { AttributeRecord, DocumentRecord, NormalizedProductFields, ProductResult } from "../../shared/types.js";
import { multiplyDecimalExactly } from "../unit-conversion.js";
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

export function normalizeFields(attributes: AttributeRecord[], documents: DocumentRecord[], manufacturerId?: string): NormalizedProductFields {
  // Eaton family PDFs often contain many models in one table. Only normalize their field values
  // when the extractor tied the row to an exact catalog row or an explicitly documented option.
  // The unscoped records remain in raw evidence for review, but cannot override an exact SKU PDP.
  if (manufacturerId === "eaton") attributes = attributes.filter((attribute) => !isUnscopedEatonPdfFact(attribute));
  const rittalPdpAttributes = manufacturerId === "rittal"
    ? attributes.filter((attribute) => attribute.sourceType === "official" || attribute.sourceType === "official-fallback")
    : attributes;
  // Rittal's localized PDPs can label a kA short-circuit withstand figure "Rated current".
  // Also keep accessory prose (for example, NEMA type "3R/4, 12 a NEMA 4X") out of electrical
  // current normalization. Title/description inferences and document-table text are not product-level
  // current evidence; retain them as raw attributes, but normalize current only from official PDP rows.
  const etaVariableE1073Current = manufacturerId === "eta" && attributes.some((attribute) =>
    /^https:\/\/global\.e-t-a\.com\/products\/.+\/battery_isolation_switches\/p\/e_1073_\d+\/?$/i.test(attribute.sourceUrl ?? "")
  );
  const etaEai300NoNormalizedCurrent = manufacturerId === "eta" && attributes.some((attribute) =>
    /^https:\/\/(?:(?:global|www)\.)?e-t-a\.com\/products\/.+\/p\/eai300\/?$/i.test(attribute.sourceUrl ?? "")
  ) && !etaTypicalPowerConsumptionCurrent(attributes);
  const nventPassiveSchroffRack = manufacturerId === "nvent" &&
    attributes.some((attribute) => /^rack height$/i.test(attribute.name.trim())) &&
    attributes.some((attribute) => /^usable width$/i.test(attribute.name.trim()));
  const nventSchroffFanTray = manufacturerId === "nvent" &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^product type$/i.test(attribute.name.trim()) && /^fan unit$/i.test(attribute.value.trim())) &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^input voltage ac$/i.test(attribute.name.trim()));
  const nventExactGroundingClamp = manufacturerId === "nvent" && attributes.some((attribute) =>
    attribute.parser === "nvent-direct" && /^(?:name|title)$/i.test(attribute.name.trim()) && /^multi-purpose grounding clamp\b/i.test(attribute.value)
  );
  const nventCaddyLoadRatingOnly = manufacturerId === "nvent" &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^(?:name|title)$/i.test(attribute.name.trim()) && /\bconduit clamp\b/i.test(attribute.value)) &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^ultimate static load\b/i.test(attribute.name.trim())) &&
    !attributes.some((attribute) => attribute.parser === "nvent-direct" && /^(?:net\s+)?weight$/i.test(attribute.name.trim()));
  const nventExactSurgeProtector = manufacturerId === "nvent" && attributes.some((attribute) =>
    attribute.parser === "nvent-direct" && /\bsurge protection\b/i.test(attribute.value) && /^(?:product type|product category|category|type)$/i.test(attribute.name.trim())
  );
  const nventSurgeNominalVoltage = nventExactSurgeProtector
    ? normalizeVoltageValue(attributes.find((attribute) => /^nominal\s+system\s+voltage\s*\(un\)$/i.test(attribute.name.trim()))?.value)
    : undefined;
  const nventExactRailTerminalBlock = manufacturerId === "nvent" && attributes.some((attribute) =>
    attribute.parser === "nvent-direct" && /^rail four post terminal block\b/i.test(attribute.value) && /^(?:product type|product category|category|type)$/i.test(attribute.name.trim())
  );
  const nventSchroffTestAdapter = manufacturerId === "nvent" &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^product type$/i.test(attribute.name.trim()) && /^test adapter$/i.test(attribute.value.trim())) &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^board depth$/i.test(attribute.name.trim())) &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^rack height$/i.test(attribute.name.trim()));
  const nventCopperBondedGroundRod = manufacturerId === "nvent" &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^category$/i.test(attribute.name.trim()) && /\bcopper-bonded ground rod\b/i.test(attribute.value)) &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^ground rod diameter, actual/i.test(attribute.name.trim())) &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^length\b/i.test(attribute.name.trim()));
  const nventGroundRodDimensions = nventCopperBondedGroundRod ? nventCopperBondedGroundRodDimensions(attributes) : undefined;
  const nventGroundingClampDimensions = nventExactGroundingClamp
    ? (() => {
        const axis = (name: RegExp) => attributes.find((attribute) => attribute.parser === "nvent-direct" && name.test(attribute.name.trim()) && /\d+(?:[.,]\d+)?\s*mm\b/i.test(attribute.value))?.value.match(/\d+(?:[.,]\d+)?\s*mm\b/i)?.[0];
        const length = axis(/^length(?:\s*\(l\))?$/i);
        const width = axis(/^width(?:\s*\(w\))?$/i);
        return length && width ? `L ${length} x W ${width}` : undefined;
      })()
    : undefined;
  const currentAttributes = etaVariableE1073Current
    ? []
    : etaEai300NoNormalizedCurrent
      ? []
    : nventExactSurgeProtector
      ? []
    : nventPassiveSchroffRack
      ? []
    : manufacturerId === "rittal"
    ? rittalPdpAttributes.filter(isRittalCurrentEvidence)
    : attributes.filter((attribute) =>
        !isRelatedProductElectricalAttribute(attribute) &&
        !isNonRatingCurrentArtifact(attribute) &&
        !(manufacturerId === "balluff" && /^analog output$/i.test(attribute.name.trim()) && /\bcurrent\b/i.test(attribute.value)) &&
        !isEatonComponentElectricalValue(attribute, manufacturerId) &&
        !(manufacturerId === "eaton" && /^rated operational current for specified heat dissipation(?:\s*\(in\))?$/i.test(attribute.name.trim()) && normalizeCurrentValue(attribute.value) === "0 A")
      );
  const doepkeDuplineBusPowered = manufacturerId === "doepke" && attributes.some((attribute) =>
    /^operating voltage(?: source)?$/i.test(attribute.name.trim()) && /\bbus signal\b/i.test(attribute.value)
  );
  const voltageAttributes = manufacturerId === "eaton"
    ? attributes.filter((attribute) =>
        !isRelatedProductElectricalAttribute(attribute) &&
        !isEatonComponentElectricalValue(attribute, manufacturerId) &&
        !isEatonSoftStarterHorsepowerVoltage(attribute, attributes)
      )
    : doepkeDuplineBusPowered
      ? attributes.filter((attribute) =>
          !/^rated voltage(?:\s*\([^)]*\))?$/i.test(attribute.name.trim()) &&
          !/^(?:sensor|contact|input)\s+(?:input\s+)?voltage$/i.test(attribute.name.trim())
        )
      : attributes.filter((attribute) => !/(?:rated\s+)?insulation\s+voltage/i.test(`${attribute.name} ${attribute.value}`));
  const findAttr = (...patterns: RegExp[]) => {
    return bestAttributeValue(attributes, patterns);
  };

  const heightAttr = bestDimensionAxisAttribute(attributes, "height", manufacturerId);
  const widthAttr = bestDimensionAxisAttribute(attributes, "width", manufacturerId);
  const depthAttr = bestDimensionAxisAttribute(attributes, "depth", manufacturerId);
  const lengthAttr = bestDimensionAxisAttribute(attributes, "length", manufacturerId);
  // A cable length is not the housing size. For sensors that separately publish their measuring
  // length/range, keep the cable spec in attributes and leave physical dimensions blank unless
  // the source also provides a true product dimension.
  const hasSeparateMeasuringLength = attributes.some((attr) => /\b(?:measuring|measurement)\s+length\b/i.test(`${attr.group ?? ""} ${attr.name}`));
  const cableLengthDimension = hasSeparateMeasuringLength ? undefined : bestCableLengthDimensionValue(attributes);
  const axisAssembledDimensions = normalizeDimensionValue(
    formatDimensions(heightAttr?.value, widthAttr?.value, depthAttr?.value, lengthAttr?.value)
  );
  const exactDoepkeDimensions = manufacturerId === "doepke"
    ? normalizeDimensionValue(doepkeExactAttribute(attributes, /^verified device dimensions$/i)?.value)
    : undefined;
  const combinedDimensionsAttr = attributes
    .filter((attr) => {
      const haystack = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      if (manufacturerId === "schmersal" && /sensor chain|\bwire\b/.test(haystack)) return false;
      // FIELD_LABEL_PATTERNS.dimensions matches on GROUP text too (e.g. "Rockwell Dimensions"), so
      // a bare single-axis attribute like name="Height" would otherwise ALSO qualify as a "combined
      // Dimensions string" candidate purely because it sits in a dimensions-named group — stealing
      // this arbitration's role from the genuine combined "H x W x D" attribute it's supposed to
      // compete against (confirmed live: with an "official" sourceType bump, a bare 0.7-confidence
      // "Height" attribute out-scored the real 0.85-confidence combined "Dimensions" attribute this
      // way, defeating the whole point of comparing them). Single-axis attributes are already
      // handled via bestDimensionAxisAttribute above; exclude them here.
      if (/^(?:height|width|depth|length)$/i.test(attr.name.trim())) return false;
      // Panel cut-outs describe the opening needed to install an HMI, not the panel's external
      // envelope. Preserve the exact value as a source attribute without normalizing it as product
      // dimensions.
      if (!fieldMatchesLabel("dimensions", attr.name)) return false;
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
  const axisDimensionCount = axisAttrs.length;
  const combinedDimensionCount = combinedDimensionsValue ? dimensionMeasurementCount(combinedDimensionsValue) : 0;
  const rittalCableGlandWithSeparateMechanicalMeasures = manufacturerId === "rittal" &&
    attributes.some((attribute) => attribute.parser === "rittal-order-resolver" && /^product description$/i.test(attribute.name.trim()) && /\bcable gland\b/i.test(attribute.value)) &&
    attributes.some((attribute) => /^width across flats$/i.test(attribute.name.trim())) &&
    attributes.some((attribute) => /^thread length$/i.test(attribute.name.trim()));
  const rittalLockInsertWithOnlyLength = manufacturerId === "rittal" &&
    attributes.some((attribute) => attribute.parser === "rittal-order-resolver" && /^product description$/i.test(attribute.name.trim()) && /\block insert\b/i.test(attribute.value)) &&
    attributes.some((attribute) => /^length$/i.test(attribute.name.trim())) &&
    !attributes.some((attribute) => /^(?:width|height|depth)$/i.test(attribute.name.trim()));
  const rittalMechanicalAccessoryWithoutEnvelope = rittalCableGlandWithSeparateMechanicalMeasures || rittalLockInsertWithOnlyLength;
  const preferAxisAssembly =
    Boolean(axisAssembledDimensions) &&
    (!combinedDimensionsValue || (axisDimensionCount >= combinedDimensionCount && weakestAxisConfidence >= (combinedDimensionsAttr?.confidence ?? 1)));
  const dimensions = (manufacturerId === "schneider" && isSchneiderPendantStation(attributes)) || nventSchroffTestAdapter || nventSchroffFanTray ? undefined : (
    (manufacturerId === "rittal" ? rittalProductDimensions(attributes) : undefined) ??
    nventGroundingClampDimensions ??
    nventGroundRodDimensions ??
    exactDoepkeDimensions ??
    (manufacturerId === "balluff" ? balluffProbeDimensions(attributes) : undefined) ??
    (manufacturerId === "phoenix" ? phoenixContactSensorDimensions(attributes) : undefined) ??
    (rittalMechanicalAccessoryWithoutEnvelope ? undefined : (preferAxisAssembly ? axisAssembledDimensions : undefined)) ??
    (rittalMechanicalAccessoryWithoutEnvelope ? undefined : combinedDimensionsValue) ??
    (rittalMechanicalAccessoryWithoutEnvelope ? undefined : axisAssembledDimensions) ??
    (rittalMechanicalAccessoryWithoutEnvelope ? undefined : registryFieldValue(attributes, "dimensions", normalizeDimensionValue)) ??
    (rittalMechanicalAccessoryWithoutEnvelope ? undefined : deriveDimensionsFromText(attributes)) ??
    (rittalMechanicalAccessoryWithoutEnvelope ? undefined : schneiderDescriptionDimensions(attributes)) ??
    (rittalMechanicalAccessoryWithoutEnvelope ? undefined : cableLengthDimension));
  const safeDimensions = manufacturerId === "eta" && etaDimensionMatchesTerminalDesign(attributes, dimensions)
    ? undefined
    : dimensions;
  const material = nventExactRailTerminalBlock
    ? undefined
    : nventSchroffFanTray
    ? attributes.find((attribute) => attribute.parser === "nvent-direct" && /^material$/i.test(attribute.name.trim()) && /^(?:steel|polypropylene)(?:\s*;\s*(?:steel|polypropylene))*$/i.test(attribute.value.trim()))?.value
    : nventExactGroundingClamp
    ? attributes.find((attribute) => attribute.parser === "nvent-direct" && /^material$/i.test(attribute.name.trim()))?.value
    : manufacturerId === "nvent"
    ? attributes.find((attribute) => attribute.parser === "nvent-direct" && /^material$/i.test(attribute.name.trim()))?.value ?? findMaterialAttr(attributes)
    : manufacturerId === "rittal"
    ? rittalExplicitLabelValue(rittalPdpAttributes, /^basic material$/i, rittalMaterialValue) ??
      rittalExplicitLabelValue(rittalPdpAttributes, /^materials?$/i, rittalMaterialValue)
    : manufacturerId === "schmersal"
    ? exactSchmersalPdpFieldValue(attributes, /^(?:housing|body|enclosure) material$/i, normalizeHtmlSpecValue) ?? findMaterialAttr(attributes)
    : manufacturerId === "sce"
    ? sceWindowKitMaterial(attributes) ?? sceLevelingPadMaterial(attributes) ?? findMaterialAttr(attributes) ??
      registryFieldValue(attributes, "material", materialValueFromText) ?? deriveMaterialFromAttributes(attributes) ??
      ontologyFieldValue(attributes, "material", materialValueFromText)
    : manufacturerId === "balluff"
    ? balluffHousingMaterial(attributes) ?? findMaterialAttr(attributes) ??
      registryFieldValue(attributes, "material", materialValueFromText) ?? deriveMaterialFromAttributes(attributes) ??
      ontologyFieldValue(attributes, "material", materialValueFromText)
    : manufacturerId === "schneider"
    ? schneiderPrimaryMaterial(attributes)
    : manufacturerId === "phoenix"
    ? phoenixProductMaterial(attributes) ?? findMaterialAttr(attributes.filter((attribute) =>
        !/\b(?:flammability|version)\b|\*/i.test(`${attribute.name} ${attribute.value}`)
      ))
    : findMaterialAttr(attributes) ??
      registryFieldValue(attributes, "material", materialValueFromText) ??
      deriveMaterialFromAttributes(attributes) ??
      ontologyFieldValue(attributes, "material", materialValueFromText);
  const finish = manufacturerId === "rittal"
    ? rittalExplicitLabelValue(rittalPdpAttributes, /^(?:surface\s+)?(?:finish|finishing|treatment|coating)$/i, rittalSpecText)
    : manufacturerId === "schmersal"
    ? exactSchmersalPdpFieldValue(attributes, /^(?:surface\s+)?(?:finish|finishing|treatment|coating)$/i, normalizeFinishValue)
    : manufacturerId === "balluff"
    ? balluffFinish(attributes) ?? normalizeFinishValue(bestAttributeValue(attributes, normalizerFieldLabelPatterns("finish")))
    : manufacturerId === "phoenix"
    ? phoenixProductFinish(attributes) ?? normalizeFinishValue(bestAttributeValue(attributes, normalizerFieldLabelPatterns("finish")))
    :
    normalizeFinishValue(bestAttributeValue(attributes, normalizerFieldLabelPatterns("finish"))) ??
    registryFieldValue(attributes, "finish", (value) => finishPhraseFromText(value) ?? normalizeFinishValue(value)) ??
    deriveFinishFromAttributes(attributes) ??
    deriveFinishFromMaterial(material) ??
    ontologyFieldValue(attributes, "finish", (value) => finishPhraseFromText(value) ?? normalizeFinishValue(value));
  const finishForColor = manufacturerId === "rittal"
    ? undefined
    : manufacturerId === "schmersal"
    ? undefined
    : normalizeFinishValue(bestAttributeValue(attributes.filter((attr) => attr.scope !== "variant-option"), normalizerFieldLabelPatterns("finish")));
  const safeFinish = (manufacturerId === "phoenix" && /\bno\b|\*/i.test(finish ?? "")) || nventCopperBondedGroundRod || nventExactGroundingClamp ? undefined : finish;
  const wallThicknessAttributes = attributes.filter((attribute) =>
    !/\bbusbar\b|front\s+panel/i.test(`${attribute.group ?? ""} ${attribute.name}`) &&
    !/\bpanel thickness\b/i.test(attribute.name) &&
    !(manufacturerId === "spelsberg" && (
      /\b(?:ceiling\s+)?slab thickness\b/i.test(`${attribute.name} ${attribute.value}`) ||
      (/^thickness$/i.test(attribute.name.trim()) && /\bup to\b/i.test(attribute.value))
    )) &&
    !(/^thickness$/i.test(attribute.name.trim()) && /ontology/i.test(attribute.group ?? ""))
  );
  const wallThickness = (manufacturerId === "rittal"
    ? (() => {
        const enclosureThickness = rittalPdpAttributes.find((attribute) =>
          /material thickness/i.test(attribute.name) && /\benclosure\b/i.test(attribute.name)
        );
        // The value alone (for example "1.5 mm") loses the evidence that it is a thickness.
        // Keep the exact PDP label in the value passed to the strict shared validator.
        return normalizeWallThicknessValue(enclosureThickness ? `${enclosureThickness.name}: ${enclosureThickness.value}` : undefined);
      })()
    : undefined) ?? bestWallThicknessAttributeValue(wallThicknessAttributes) ??
    registryFieldValue(wallThicknessAttributes, "wallThickness", normalizeWallThicknessValue) ??
    deriveWallThicknessFromAttributes(wallThicknessAttributes);
  const color = manufacturerId === "eta"
    ? exactEtaPdpColor(attributes)
    : manufacturerId === "rittal"
    ? rittalExplicitLabelValue(rittalPdpAttributes, /^(?:colou?r)$/i, (value) => findColorAttr([{ name: "Colour", value }]))
    : manufacturerId === "schmersal"
    ? exactSchmersalPdpFieldValue(attributes, /^(?:colou?r)$/i, (value) => findColorAttr([{ name: "Colour", value }]))
    : manufacturerId === "phoenix"
    ? phoenixContactExplicitColor(attributes)
    : manufacturerId === "schneider"
    ? schneiderExplicitProductColor(attributes)
    : withoutForeignQuantityKinds(
    findColorAttr(attributes) ??
      registryFieldValue(attributes, "color", deriveColorFromFinish) ??
      deriveColorFromFinish(finishForColor) ??
      deriveColorFromMaterial(material) ??
      ontologyFieldValue(attributes, "color", deriveColorFromFinish) ??
      deriveColorFromProseAttributes(attributes)
  );

  const protectionAttributes = manufacturerId === "rittal"
    ? rittalPdpAttributes.filter((attribute) => /\b(?:protection|degree|type\s+rating|ik\s+code|nema|ip\s+(?:class|rating|protection))\b/i.test(attribute.name))
    : attributes;
  const doepkeProtectionEvidence = manufacturerId === "doepke"
    ? protectionAttributes.filter((attribute) => !/\bIIP\s*42\b|\b(?:Encl\.?\s*)?protection[^\n]{0,50}\b(?:standards?|Normen)\b/i.test(`${attribute.name} ${attribute.value}`))
    : protectionAttributes;
  const balluffExactProtectionAttributes = manufacturerId === "balluff"
    ? protectionAttributes.filter((attribute) =>
        attribute.matchLevel === "exact" && /\b(?:ip\b|nema|protection|environmental rating)\b/i.test(`${attribute.group ?? ""} ${attribute.name}`)
      )
    : [];
  const doepkeProtection = manufacturerId === "doepke" ? doepkeExactProtection(doepkeProtectionEvidence) : undefined;
  const protectionFromAttr = manufacturerId === "doepke"
    ? doepkeProtection ?? collectProtectionValues(doepkeProtectionEvidence.filter((attribute) => attribute.group !== "PDF datasheet - Dimensions"))
    : manufacturerId === "rittal"
    ? collectProtectionValues(protectionAttributes)
    : hasConflictingExactEatonPdpProtection(protectionAttributes, manufacturerId)
      ? undefined
      : exactEatonMcbProtection(protectionAttributes, manufacturerId) ??
      exactSchmersalPdpProtection(protectionAttributes, manufacturerId) ??
      collectProtectionValues(balluffExactProtectionAttributes.length ? balluffExactProtectionAttributes : protectionAttributes) ??
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

  const rittalVoltageModes = manufacturerId === "rittal" ? rittalMultipleVoltageRanges(attributes) : undefined;
  const schneiderSupplyVoltage = manufacturerId === "schneider"
    ? schneiderMcbVoltage(attributes) ??
      schneiderTransformerOutputVoltage(voltageAttributes, attributes) ??
      schneiderDualSupplyVoltage(voltageAttributes) ?? schneiderPowerSupplyOutputVoltage(voltageAttributes, attributes)
    : undefined;
  const scePdpSupplyVoltage = manufacturerId === "sce"
    ? normalizeVoltageValue(attributes.find((attribute) =>
        attribute.parser === "sce-product-page" &&
        /^supply voltage range$/i.test(attribute.name) &&
        /^sce electrical ratings$/i.test(attribute.group ?? "")
      )?.value)
    : undefined;
  const fallbackVoltage = nventSurgeNominalVoltage ?? schneiderSupplyVoltage ?? scePdpSupplyVoltage ?? (manufacturerId === "phoenix"
    ? phoenixContactNormalizedVoltage(attributes) ?? withoutMixedKindProse(
      exactSchmersalPdpVoltage(attributes, manufacturerId) ??
      powerSupplyOutputVoltage(voltageAttributes) ??
      normalizeVoltageValue(deriveVoltageRangeFromMinMax(voltageAttributes)) ??
      explicitRatedVoltageFromText(voltageAttributes) ??
      numericVoltAttributeVoltage(voltageAttributes) ??
      bestNormalizedAttributeValue(voltageAttributes, normalizerFieldLabelPatterns("voltage"), normalizeVoltageValue, "voltage") ??
      registryFieldValue(voltageAttributes, "voltage", normalizeVoltageValue) ??
      normalizeVoltageValue(deriveVoltageFromText(voltageAttributes)) ??
      ontologyFieldValue(voltageAttributes, "ratedVoltage", normalizeVoltageValue) ??
      inferredOntologyFieldValue(voltageAttributes, "ratedVoltage", normalizeVoltageValue)
    )
    : manufacturerId === "schmersal"
    ? exactSchmersalPdpVoltage(attributes, manufacturerId)
    : rittalVoltageModes ?? withoutMixedKindProse(
      exactEtaSCS1000DatasheetVoltage(voltageAttributes, manufacturerId) ??
      powerSupplyOutputVoltage(voltageAttributes) ??
      exactEtaPdpVoltage(voltageAttributes, manufacturerId) ??
      exactEtaEAI300DatasheetVoltage(voltageAttributes, manufacturerId) ??
      exactSchmersalPdpVoltage(attributes, manufacturerId) ??
      exactEatonControlRelaySupplyVoltage(voltageAttributes, manufacturerId) ??
      exactEatonSoftStarterMainsVoltage(voltageAttributes, manufacturerId) ??
      exactEatonRccbVoltageOptions(voltageAttributes, manufacturerId) ??
      exactEatonPowerVoltage(voltageAttributes, manufacturerId) ??
      exactEatonUpsVoltage(voltageAttributes, manufacturerId) ??
      exactEatonMcbVoltageRating(voltageAttributes, manufacturerId) ??
      exactEatonDriveVoltage(attributes, manufacturerId) ??
      exactEatonPdpVoltageRating(voltageAttributes, manufacturerId) ??
      powerSupplyOutputVoltage(voltageAttributes) ??
    normalizeVoltageValue(deriveVoltageRangeFromMinMax(voltageAttributes)) ??
    explicitRatedVoltageFromText(voltageAttributes) ??
    numericVoltAttributeVoltage(voltageAttributes) ??
    bestNormalizedAttributeValue(voltageAttributes, normalizerFieldLabelPatterns("voltage"), normalizeVoltageValue, "voltage") ??
    registryFieldValue(voltageAttributes, "voltage", normalizeVoltageValue) ??
    normalizeVoltageValue(deriveVoltageFromText(voltageAttributes)) ??
    // Last resort: the ontology recognises FR/IT/DE voltage labels that FIELD_LABEL_PATTERNS
    // (mostly EN/DE) miss. Most-specific matchProperty keeps insulation/impulse voltage out.
      ontologyFieldValue(voltageAttributes, "ratedVoltage", normalizeVoltageValue) ??
      inferredOntologyFieldValue(voltageAttributes, "ratedVoltage", normalizeVoltageValue)
   ));
  const voltage = manufacturerId === "turck"
    ? (isPowerSupplyProduct(attributes)
        ? powerSupplyOutputVoltage(voltageAttributes) ?? turckOperatingVoltage(attributes) ?? fallbackVoltage
        : turckOperatingVoltage(attributes) ?? fallbackVoltage)
    : manufacturerId === "doepke"
    ? (doepkeDuplineBusPowered
        ? doepkeExactAttribute(attributes, /^device supply voltage$/i)?.value
        : doepkeHasNoNormalizedDeviceSupply(attributes)
          ? undefined
          : doepkeOperatingVoltage(attributes) ?? fallbackVoltage)
    : fallbackVoltage;
  const genericCurrent = manufacturerId === "phoenix" && isPhoenixSignalConditioner(attributes)
    ? undefined
    : manufacturerId === "phoenix" && isPhoenixSurgeProtector(attributes)
    ? phoenixSurgeNominalDischargeCurrent(attributes)
    : manufacturerId === "phoenix" && isPhoenixSafetyRelay(attributes)
    ? phoenixSafetyRelaySupplyCurrent(attributes)
    : manufacturerId === "schmersal"
    ? exactSchmersalNoLoadSupplyCurrent(attributes, manufacturerId)
    : manufacturerId === "schneider" && isSchneiderSurgeProtector(attributes)
    ? undefined
    : manufacturerId === "schneider" && isSchneiderSafetyLightCurtain(attributes)
    ? undefined
    : manufacturerId === "schneider" && isSchneiderSafetyControllerWithChannelCurrent(attributes)
    ? undefined
    : manufacturerId === "schneider" && isSchneiderM221OutputCurrent(attributes)
    ? undefined
    : manufacturerId === "schneider" && isSchneiderSoftStarter(attributes)
    ? schneiderSoftStarterRatedCurrent(attributes)
    : manufacturerId === "rittal"
    // Rittal's multi-row cooling-unit rating can be split across definition-list rows.
    // Preserve all exact-page rated-current variants (for example 50 Hz and 60 Hz) instead
    // of the single value left after generic candidate ranking.
    ? rittalRatedCurrent(attributes)
    : withoutMixedKindProse(
    (manufacturerId === "schneider" && isSchneiderTransformer(attributes)
      ? schneiderTransformerSecondaryCurrent(currentAttributes)
      : undefined) ??
    (manufacturerId === "eta"
      ? etaExactPdpCurrent(currentAttributes) ?? etaRatedCurrent(attributes) ?? etaTypicalPowerConsumptionCurrent(currentAttributes)
      : undefined) ??
    exactSchmersalNoLoadSupplyCurrent(attributes, manufacturerId) ??
    balluffPublishedCurrentConsumption(currentAttributes, manufacturerId) ??
    eatonNacPowerSupplyCurrent(currentAttributes, manufacturerId) ??
      phoenixContactCategoryCurrent(currentAttributes, manufacturerId) ??
      phoenixContactSwitchMaximumCurrent(currentAttributes, manufacturerId) ??
      phoenixContactPowerSupplyOutputCurrent(currentAttributes, manufacturerId) ??
      powerSupplyOutputCurrent(currentAttributes) ??
      eatonSurgeNominalDischargeCurrent(attributes, manufacturerId) ??
      exactEatonControlRelaySwitchingCurrent(currentAttributes, manufacturerId) ??
      exactEatonMainSwitchCurrent(currentAttributes, manufacturerId) ??
      eatonContactorAc3Current(currentAttributes, manufacturerId) ??
      exactEatonSoftStarterAc53Current(currentAttributes, manufacturerId) ??
      eatonOverloadRangeCurrent(currentAttributes, manufacturerId) ??
      eatonRatedOperationalCurrent(currentAttributes, manufacturerId) ??
      abbContactorAc3Current(currentAttributes, manufacturerId) ??
      schneiderContactorAc3Current(currentAttributes) ??
      explicitRatedCurrentFromText(currentAttributes) ??
      voltageAlignedAc15Current(currentAttributes, voltage) ??
      numericCurrentAttributeCurrent(currentAttributes) ??
      bestNormalizedAttributeValue(currentAttributes, normalizerFieldLabelPatterns("current"), normalizeCurrentValue, "current") ??
      registryFieldValue(currentAttributes, "current", normalizeCurrentValue) ??
      normalizeCurrentValue(deriveCurrentFromText(currentAttributes)) ??
      ontologyFieldValue(currentAttributes, "ratedCurrent", normalizeCurrentValue) ??
      inferredOntologyFieldValue(currentAttributes, "ratedCurrent", normalizeCurrentValue)
    );
  const current = manufacturerId === "turck"
    ? (isPowerSupplyProduct(attributes) ? powerSupplyOutputCurrent(attributes) ?? turckCurrent(attributes) : turckCurrent(attributes))
    : manufacturerId === "doepke"
    ? doepkeCurrent(attributes, genericCurrent)
    : genericCurrent;

  const exactEatonPdpTemperature = manufacturerId === "eaton"
    ? temperatureFromSeparateMinMaxRows(
        attributes.filter((attribute) =>
          attribute.parser === "eaton-product-page" &&
          /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
          /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "") &&
          /^ambient operating temperature - (?:min|max)$/i.test(attribute.name.trim())
        ),
        () => true,
        () => false
      )
    : undefined;
  const derivedOperatingTemperature = deriveOperatingTemperature(
    manufacturerId === "turck"
      ? attributes.filter((attribute) => /^ambient temperature (?:min|max)/i.test(attribute.name.trim()))
      : attributes
  );
  const exactEatonPsgTemperature = manufacturerId === "eaton"
    ? deriveOperatingTemperature(attributes.filter((attribute) => attribute.group === "Eaton Volume 7 PSG exact model column" && attribute.matchLevel === "exact"))
    : undefined;
  const phoenixTemperature = manufacturerId === "phoenix" ? phoenixContactOperatingTemperature(attributes) : undefined;
  const schneiderTemperature = manufacturerId === "schneider" ? schneiderOperatingTemperature(attributes) : undefined;
  const etaEai300Temperature = manufacturerId === "eta" ? etaEai300DatasheetTemperature(attributes) : undefined;
  const operatingTemperature = {
    min: exactEatonPdpTemperature?.min ?? exactEatonPsgTemperature?.min ?? phoenixTemperature?.min ?? schneiderTemperature?.min ?? etaEai300Temperature?.min ?? derivedOperatingTemperature.min,
    max: exactEatonPdpTemperature?.max ?? exactEatonPsgTemperature?.max ?? phoenixTemperature?.max ?? schneiderTemperature?.max ?? etaEai300Temperature?.max ?? derivedOperatingTemperature.max
  };
  // An exact product page can contain a unit typo (for example 1.59 g for a 120 W supply).
  // Filter such a candidate before arbitration so it cannot suppress a valid exact-catalog weight.
  const isEta18plusSystem = manufacturerId === "eta" && attributes.some((attribute) =>
    /\/solutions\/automation_process_control\/car_production\/p\/modul_18plus\/?$/i.test(attribute.sourceUrl ?? "")
  );
  const weightAttributes = (isPowerSupplyProduct(attributes)
    ? attributes.filter((attribute) => !isImplausiblyLowPowerSupplyWeight(attributes, attribute.value))
    : attributes).filter((attribute) =>
      // The 18plus family datasheet reports separate EM/AM/SM submodule masses, not the
      // complete power-distribution system. Keep those rows in raw evidence, but do not publish
      // a submodule's mass as the normalized weight of the requested system.
      !(isEta18plusSystem && /\b18plus\s+(?:EM|AM|SM)\b/i.test(`${attribute.name} ${attribute.value}`))
    ).filter((attribute) => !(nventCaddyLoadRatingOnly && /^ultimate static load\b/i.test(attribute.name.trim())));
  const weight = (manufacturerId === "phoenix" ? phoenixProductNetWeight(weightAttributes) : undefined) ??
    bestNormalizedAttributeValue(weightAttributes, normalizerFieldLabelPatterns("weight"), normalizeWeightValue, "weight") ??
    registryFieldValue(weightAttributes, "weight", normalizeWeightValue) ??
    ontologyFieldValue(weightAttributes, "weight", normalizeWeightValue) ??
    inferredOntologyFieldValue(weightAttributes, "weight", normalizeWeightValue) ??
    schneiderDescriptionWeight(weightAttributes);

  return {
    weight: nventCaddyLoadRatingOnly || isImplausiblyLowPowerSupplyWeight(attributes, weight) ? undefined : weight,
    dimensions: safeDimensions,
    material,
    wallThickness,
    finish: safeFinish,
    color,
    voltage,
    current: etaVariableE1073Current || etaEai300NoNormalizedCurrent || nventExactSurgeProtector ? undefined : current,
    protection: protectionFromAttr,
    certificates: certificates || undefined,
    operatingTemperatureMin: operatingTemperature.min,
    operatingTemperatureMax: operatingTemperature.max
  };
}

function doepkeExactAttribute(attributes: AttributeRecord[], name: RegExp): AttributeRecord | undefined {
  return doepkeExactAttributes(attributes, name)[0];
}

function doepkeExactAttributes(attributes: AttributeRecord[], name: RegExp): AttributeRecord[] {
  const catalogNumber = attributes.find((attribute) =>
    /^catalog number$/i.test(attribute.name.trim()) && /source\/prodext\.php/i.test(attribute.sourceUrl ?? "")
  )?.value;
  if (!catalogNumber) return [];
  const exactProductPath = new RegExp("source/prodext\\.php\\?ARTNR=" + catalogNumber + "(?:&|$)", "i");
  const exactDatasheetPath = new RegExp("doepke_" + catalogNumber + "_dbl_[a-z]{2}\\.pdf", "i");
  return attributes
    .filter((attribute) => name.test(attribute.name.trim()) && (
      exactProductPath.test(attribute.sourceUrl ?? "") ||
      exactDatasheetPath.test(attribute.sourceUrl ?? "") ||
      (attribute.parser === "doepke-exact-pdf" && attribute.matchLevel === "exact")
    ))
    .sort(compareAttributeEvidence);
}

function doepkeTypeCode(attributes: AttributeRecord[]): string {
  return attributes.find((attribute) => /^type code$/i.test(attribute.name.trim()) && /source\/prodext\.php/i.test(attribute.sourceUrl ?? ""))?.value ??
    attributes.find((attribute) => /^product designation$/i.test(attribute.name.trim()) && /source\/prodext\.php/i.test(attribute.sourceUrl ?? ""))?.value ?? "";
}

function doepkeUnitRatings(value: string | undefined, unit: "V" | "A", suffix: string): string | undefined {
  if (!value) return undefined;
  const contextualValue = value.replace(/^\s*\((?:AC|DC)\)\s*/i, "").split("(")[0];
  const ratings = [...contextualValue.matchAll(new RegExp("(\\d+(?:[.,]\\d+)?)\\s*" + unit + "\\b", "gi"))]
    .map((match) => match[1].replace(",", ".") + " " + unit + (suffix ? " " + suffix : ""));
  const unique = [...new Set(ratings)];
  return unique.length ? unique.join(" / ") : undefined;
}

/**
 * Doepke's product information PDFs expose several differently scoped voltage rows. Keep the
 * operating/supply voltage distinct from relay-contact ratings, switching thresholds and RCCB
 * ratings, and retain AC/DC or multiple output-voltage context in the normalized value.
 */
function doepkeOperatingVoltage(attributes: AttributeRecord[]): string | undefined {
  const verifiedVoltage = doepkeExactAttribute(attributes, /^device supply voltage$/i)?.value;
  if (verifiedVoltage) return verifiedVoltage;
  const typeCode = doepkeTypeCode(attributes);
  // The DRCA kit is a measuring system with a USB connection, not a fixed-voltage
  // field device. The datasheet does not publish a rated device supply voltage.
  if (/\bDRCA\s*[- ]?1(?:\s*[- ]?Set)?\b/i.test(typeCode)) return undefined;
  // The DRP voltage rows describe selected control/auxiliary supplies and are handled
  // through their exact operating-voltage rows below, not generic rated-voltage text.
  const operatingRows = doepkeExactAttributes(attributes, /^operating voltage$/i);
  const ratedVoltageRows = doepkeExactAttributes(attributes, /^rated voltage$/i);
  const rowForContext = (rows: AttributeRecord[], context: "AC" | "DC") =>
    rows.find((attribute) => new RegExp("^\\s*\\(" + context + "\\)", "i").test(attribute.value))?.value;
  if (/^Dasy\s+016-230\s+V\s+TC/i.test(typeCode)) {
    return doepkeUnitRatings(rowForContext(operatingRows, "AC"), "V", "AC");
  }
  if (/^RUR\s*3$/i.test(typeCode)) {
    return doepkeUnitRatings(rowForContext(operatingRows, "AC"), "V", "AC");
  }
  if (/^RK\s*3\s*U$/i.test(typeCode)) {
    return doepkeUnitRatings(rowForContext(ratedVoltageRows, "AC"), "V", "AC");
  }
  if (/^DFA\s*2\s*[-–]?\s*1$/i.test(typeCode)) {
    const ac = doepkeUnitRatings(rowForContext(operatingRows, "AC"), "V", "AC");
    const dc = doepkeUnitRatings(rowForContext(operatingRows, "DC"), "V", "DC");
    return [ac, dc].filter(Boolean).join(" / ") || undefined;
  }
  return undefined;
}

function doepkeCurrentConsumption(attributes: AttributeRecord[], kind: "AC" | "DC"): string | undefined {
  const row = doepkeExactAttributes(attributes, /^current consumption$/i)
    .find((attribute) => new RegExp("^\\s*\\(" + kind + "\\)", "i").test(attribute.value));
  if (!row) return undefined;
  const contextualValue = row.value.replace(/^\s*\((?:AC|DC)\)\s*/i, "");
  const ratings = [...contextualValue.matchAll(/(\d+(?:[.,]\d+)?)\s*A\b/gi)]
    .map((match) => match[1].replace(",", "."));
  const unique = [...new Set(ratings)];
  if (!unique.length) return undefined;
  if (unique.length > 1) return unique[0] + "–" + unique[1] + " A " + kind;
  return unique[0] + " A " + kind;
}

function doepkeTransformerSecondaryCurrent(attributes: AttributeRecord[]): string | undefined {
  const row = doepkeExactAttributes(attributes, /^rated current$/i)
    .find((attribute) => /^\s*\(AC\)/i.test(attribute.value));
  return doepkeUnitRatings(row?.value, "A", "");
}

/**
 * Doepke's DFA datasheet lists current consumption and several separate contact ratings. RUR's
 * 5 A is its relay-contact rating, not device consumption. The RK transformer current is the
 * secondary output rating, paired with its 8/12 V outputs rather than 230 V mains input.
 */
function doepkeCurrent(attributes: AttributeRecord[], fallback: string | undefined): string | undefined {
  const exactDesignationAttributes = doepkeExactAttributes(attributes, /^(?:product designation|verified product designation|type code)$/i);
  if (exactDesignationAttributes.some((attribute) =>
    /\bDRCA\s*[- ]?1\s*[- ]?Set\b/i.test(attribute.value)
  )) return undefined;
  const verifiedCurrent = doepkeExactAttribute(attributes, /^device supply current$/i)?.value;
  if (verifiedCurrent) return verifiedCurrent;
  const typeCode = doepkeTypeCode(attributes);
  // DRCA's 0–10 A is a residual-current measurement range, and DRP's 2 A is
  // the isolated alarm contact rating; neither is the device's own consumption.
  if (/\bDRCA\s*[- ]?1(?:\s*[- ]?Set)?\b|\bDRP\b/i.test(typeCode)) return undefined;
  if (/^RUR\s*3$/i.test(typeCode)) return undefined;
  if (/^DFA\s*2\s*[-–]?\s*1$/i.test(typeCode)) {
    const ac = doepkeCurrentConsumption(attributes, "AC");
    const dc = doepkeCurrentConsumption(attributes, "DC");
    return [ac, dc].filter(Boolean).join(" / ") || undefined;
  }
  if (/^RK\s*3\s*U$/i.test(typeCode)) {
    return doepkeTransformerSecondaryCurrent(attributes) ?? fallback;
  }
  return fallback;
}

function doepkeHasNoNormalizedDeviceSupply(attributes: AttributeRecord[]): boolean {
  const typeCode = doepkeTypeCode(attributes);
  return /\bDRCA\s*[- ]?1(?:\s*[- ]?Set)?\b/i.test(typeCode);
}

function doepkeExactProtection(attributes: AttributeRecord[]): string | undefined {
  const directProductPage = attributes.filter((attribute) =>
    /^protection class$/i.test(attribute.name.trim()) && /source\/prodext\.php\?ARTNR=\d+/i.test(attribute.sourceUrl ?? "")
  );
  const exactDocument = attributes.filter((attribute) =>
    /^protection class$/i.test(attribute.name.trim()) &&
    /doepke_\d+_dbl_[a-z]{2}\.pdf/i.test(attribute.sourceUrl ?? "")
  );
  if (directProductPage.length) return collectProtectionValues(directProductPage);
  const outsideDimensions = exactDocument.filter((attribute) => !/^PDF datasheet - Dimensions$/i.test(attribute.group ?? ""));
  return collectProtectionValues(outsideDimensions.length ? outsideDimensions : exactDocument);
}

function balluffHousingMaterial(attributes: AttributeRecord[]): string | undefined {
  return attributes
    .filter((attribute) =>
      (attribute.sourceType === "official" || isBalluffOfficialSourceUrl(attribute.sourceUrl)) &&
      /^housing material$/i.test(attribute.name.trim())
    )
    .sort(compareAttributeEvidence)
    .map((attribute) => cleanText(attribute.value))
    .find(Boolean);
}

function isBalluffOfficialSourceUrl(sourceUrl: string | undefined): boolean {
  return typeof sourceUrl === "string" && /^https?:\/\/(?:www\.)?balluff\.com\//i.test(sourceUrl);
}

function sceLevelingPadMaterial(attributes: AttributeRecord[]): string | undefined {
  const application = attributes
    .filter((attribute) => attribute.sourceType === "official" && /^application$/i.test(attribute.name.trim()))
    .map((attribute) => cleanText(attribute.value))
    .find((value) => /pads? are zinc[- ]plated with (?:a )?plastic base/i.test(value));
  return application ? "zinc-plated with plastic base" : undefined;
}

function balluffProbeDimensions(attributes: AttributeRecord[]): string | undefined {
  const probe = attributes
    .filter((attribute) => /^probe diameter$/i.test(attribute.name.trim()) && isBalluffExactDatasheetEvidence(attribute))
    .sort(compareAttributeEvidence)[0];
  const installationLength = attributes
    .filter((attribute) => /^installation length from contact surface$/i.test(attribute.name.trim()) &&
      (attribute.sourceType === "official" || isBalluffOfficialSourceUrl(attribute.sourceUrl) || isBalluffExactDatasheetEvidence(attribute)))
    .sort(compareAttributeEvidence)[0];
  const diameter = probe && normalizeSingleDimensionValue(probe.value);
  const length = installationLength && normalizeSingleDimensionValue(installationLength.value);
  if (!diameter || !length) return undefined;
  return `Ø ${diameter} x ${length}`;
}

function phoenixContactSensorDimensions(attributes: AttributeRecord[]): string | undefined {
  const productText = attributes
    .filter((attribute) => /^(?:title|product type|product name|catalog description)$/i.test(attribute.name.trim()))
    .map((attribute) => attribute.value)
    .join(" ");
  if (!/\b(?:safety switch sensor|safety sensor)\b/i.test(productText)) return undefined;
  const diameter = attributes
    .filter((attribute) => /^diameter$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeSingleDimensionValue(attribute.value))
    .find((value): value is string => Boolean(value));
  const depth = attributes
    .filter((attribute) => /^depth$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeSingleDimensionValue(attribute.value))
    .find((value): value is string => Boolean(value));
  return diameter && depth ? `Ø ${diameter} x D ${depth}` : undefined;
}

function normalizeSingleDimensionValue(value: string): string | undefined {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return undefined;
  return /^\d+(?:[.,]\d+)?\s*(?:mm|cm|m|in|inch|inches|\")$/i.test(cleaned) ? cleaned : undefined;
}

function isBalluffExactDatasheetEvidence(attribute: AttributeRecord): boolean {
  return attribute.sourceType === "generated" &&
    attribute.parser === "pdf-table-extractor" &&
    attribute.matchLevel === "exact" &&
    /^https?:\/\/publications\.balluff\.com\//i.test(attribute.sourceUrl ?? "");
}

function balluffFinish(attributes: AttributeRecord[]): string | undefined {
  const explicit = attributes
    .filter((attribute) => /^(?:surface\s+)?finish$/i.test(attribute.name.trim()) &&
      (attribute.sourceType === "official" || isBalluffOfficialSourceUrl(attribute.sourceUrl)))
    .sort(compareAttributeEvidence)[0]?.value;
  if (explicit) return normalizeFinishValue(explicit);
  const housingMaterial = attributes
    .filter((attribute) => /^(?:housing )?material$/i.test(attribute.name.trim()) &&
      (attribute.sourceType === "official" || isBalluffOfficialSourceUrl(attribute.sourceUrl)))
    .sort(compareAttributeEvidence)[0]?.value;
  return housingMaterial ? deriveFinishFromMaterial(housingMaterial) : undefined;
}

function balluffPublishedCurrentConsumption(attributes: AttributeRecord[], manufacturerId: string | undefined): string | undefined {
  if (manufacturerId !== "balluff") return undefined;
  const eligible = attributes
    .filter((attribute) =>
      (attribute.sourceType === "official" ||
        (attribute.sourceType === "generated" &&
          attribute.parser === "pdf-table-extractor" &&
          attribute.matchLevel === "exact" &&
          /^https?:\/\/publications\.balluff\.com\//i.test(attribute.sourceUrl ?? ""))) &&
      /^(?:current (?:draw|consumption)(?:\s+max\.?)?|no-load current(?:\s+io)?(?:\s+max\.?)?(?:\s+at ue)?|rated operating current(?:\s+ie)?)$/i.test(attribute.name.trim()));
  const preferred = eligible.filter((attribute) =>
    /^(?:current (?:draw|consumption)(?:\s+max\.?)?|no-load current(?:\s+io)?(?:\s+max\.?)?(?:\s+at ue)?)$/i.test(attribute.name.trim()));
  const selected = (preferred.length ? preferred : eligible).sort(compareAttributeEvidence);
  return selected
    .map((attribute) => {
      const value = normalizeCurrentValue(attribute.value);
      return value && /\bmax\.?\b/i.test(attribute.name) && !/^max\b/i.test(value) ? `max. ${value}` : value;
    })
    .find(Boolean);
}

function isUnscopedEatonPdfFact(attribute: AttributeRecord): boolean {
  return attribute.sourceType === "generated" &&
    attribute.parser === "pdf-table-extractor" &&
    attribute.matchLevel !== "exact";
}

function isEatonComponentElectricalValue(attribute: AttributeRecord, manufacturerId?: string): boolean {
  if (manufacturerId !== "eaton") return false;
  return /^included built-in led$/i.test(attribute.group?.trim() ?? "") ||
    /^led\s+(?:voltage|rated current)$/i.test(attribute.name.trim()) ||
    (/^accessories$/i.test(attribute.name.trim()) && /built-in\s+(?:multiple\s+)?led/i.test(attribute.value));
}

function isRelatedProductElectricalAttribute(attribute: AttributeRecord): boolean {
  return /\b(?:related product|designed to work together|recommended alternative|similar part|compatible product)\b/i.test(
    `${attribute.group ?? ""} ${attribute.name}`
  );
}

function hasExactEatonSkuPageEvidence(attributes: AttributeRecord[]): boolean {
  return attributes.some((attribute) =>
    attribute.parser === "eaton-product-page" &&
    attribute.sourceType === "official-fallback" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "")
  );
}

function eatonContactorAc3Current(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton" || !hasExactEatonSkuPageEvidence(attributes)) return undefined;
  const exactContactor = attributes.some((attribute) =>
    /^product type$/i.test(attribute.name.trim()) && /^contactor$/i.test(cleanText(attribute.value)) &&
    attribute.parser === "eaton-product-page" && /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "")
  );
  if (!exactContactor) return undefined;
  const values = attributes
    .filter((attribute) => /\brated operational current\b.*\bAC[-\s]?3\b/i.test(attribute.name) &&
      attribute.parser === "eaton-product-page" && /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? ""))
    .flatMap((attribute) => [...attribute.value.matchAll(/\b(\d+(?:[.,]\d+)?)\s*A\b/gi)].map((match) => localizedNumber(match[1])))
    .filter((value): value is number => Number.isFinite(value));
  const distinct = [...new Set(values)].sort((left, right) => left - right);
  if (distinct.length === 0) return undefined;
  return distinct.length === 1
    ? `${formatNumber(distinct[0])} A`
    : `${formatNumber(distinct[0])}...${formatNumber(distinct[distinct.length - 1])} A`;
}

function eatonOverloadRangeCurrent(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton" || !hasExactEatonSkuPageEvidence(attributes)) return undefined;
  const exactOverloadRelay = attributes.some((attribute) =>
    /^product type$/i.test(attribute.name.trim()) && /\boverload relay\b/i.test(attribute.value) &&
    attribute.parser === "eaton-product-page" && /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "")
  );
  if (!exactOverloadRelay) return undefined;
  const exactPageAttributes = attributes.filter((attribute) =>
    attribute.parser === "eaton-product-page" &&
    attribute.sourceType === "official-fallback" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "")
  );
  const explicitRange = exactPageAttributes
    .filter((attribute) => /^overload range$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeCurrentValue(attribute.value))
    .find((value): value is string => Boolean(value));
  if (explicitRange) return explicitRange;

  // Thermal overload relays often publish the trip adjustment as separate minimum and maximum
  // rows. Prefer that protection setting over auxiliary-contact thermal current (Ith), which is
  // a different rating and must not become the device's adjustable current.
  const minimum = exactPageAttributes
    .filter((attribute) => /^adjustable current range\s*-\s*min$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeCurrentValue(attribute.value))
    .find((value): value is string => Boolean(value));
  const maximum = exactPageAttributes
    .filter((attribute) => /^adjustable current range\s*-\s*max$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeCurrentValue(attribute.value))
    .find((value): value is string => Boolean(value));
  if (!minimum || !maximum) return undefined;
  return normalizeCurrentValue(`${minimum.replace(/\s*A$/i, "")}...${maximum}`);
}

function eatonSurgeNominalDischargeCurrent(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton" || !hasExactEatonSkuPageEvidence(attributes)) return undefined;
  const exactSurgeDevice = attributes.some((attribute) =>
    /^(?:product type|type)$/i.test(attribute.name.trim()) && /surge protect(?:ive|ion) device/i.test(attribute.value) &&
    attribute.parser === "eaton-product-page" && /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "")
  );
  if (!exactSurgeDevice) return undefined;
  const exactCatalogNumbers = new Set(attributes
    .filter((attribute) => /^(?:catalog number|product sku|sku)$/i.test(attribute.name.trim()) &&
      attribute.parser === "eaton-product-page" && /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? ""))
    .map((attribute) => cleanText(attribute.value).toUpperCase())
    .filter(Boolean));
  if (exactCatalogNumbers.size === 0) return undefined;
  const exactPdpSurgeCurrent = attributes
    .filter((attribute) => /^surge current$/i.test(attribute.name.trim()) &&
      attribute.parser === "eaton-product-page" &&
      attribute.sourceType === "official-fallback" &&
      /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
      /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? ""))
    .sort(compareAttributeEvidence)
    .find((attribute) => {
      const sourceUrl = attribute.sourceUrl ?? "";
      const sourceCatalogNumbers = attributes
        .filter((candidate) => /^(?:catalog number|product sku|sku)$/i.test(candidate.name.trim()) &&
          candidate.parser === "eaton-product-page" && candidate.sourceUrl === sourceUrl)
        .map((candidate) => cleanText(candidate.value).toUpperCase());
      const sourceModelCodes = attributes
        .filter((candidate) => /^model code$/i.test(candidate.name.trim()) &&
          candidate.parser === "eaton-product-page" && candidate.sourceUrl === sourceUrl)
        .map((candidate) => cleanText(candidate.value).toUpperCase());
      const routeNumber = decodeURIComponent(sourceUrl.match(/\/skuPage\.([^/]+?)\.html$/i)?.[1] ?? "").toUpperCase();
      return sourceCatalogNumbers.includes(routeNumber) || sourceModelCodes.some((model) => exactCatalogNumbers.has(model));
    });
  if (exactPdpSurgeCurrent) {
    const match = exactPdpSurgeCurrent.value.match(/\b(\d+(?:[.,]\d+)?)\s*kA\b(\s+per\s+phase)?/i);
    if (match) return `${formatNumber(localizedNumber(match[1]))} kA${match[2] ? " per phase" : ""}`;
  }
  const exactFamilyRow = attributes
    .filter((attribute) => /nominal discharge current/i.test(`${attribute.group ?? ""} ${attribute.name}`) &&
      attribute.sourceType === "generated" && attribute.parser === "pdf-table-extractor" &&
      /^https:\/\/(?:www\.)?eaton\.com\/(?:content\/dam\/|[^/]+\/)/i.test(attribute.sourceUrl ?? ""))
    .sort(compareAttributeEvidence)
    .find((attribute) => [...exactCatalogNumbers].some((catalogNumber) => {
      const modelToken = catalogNumber.replace(/^.*?-(?=[^-]+$)/, "");
      return modelToken.length >= 4 && attribute.value.toUpperCase().split(/[^A-Z0-9]+/).includes(modelToken);
    }));
  if (!exactFamilyRow) return undefined;
  const matched = exactFamilyRow.value.match(/\b(\d+(?:[.,]\d+)?)\s*kA\b/i);
  return matched ? `${formatNumber(localizedNumber(matched[1]))} kA` : undefined;
}

function isEatonSoftStarterHorsepowerVoltage(attribute: AttributeRecord, attributes: AttributeRecord[]): boolean {
  const exactPdp = (candidate: AttributeRecord): boolean =>
    candidate.parser === "eaton-product-page" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(candidate.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(candidate.sourceUrl ?? "");
  const exactSoftStarter = attributes.some((candidate) =>
    /^(?:product type|type)$/i.test(candidate.name.trim()) && /\b(?:soft starter|soft start controller)\b/i.test(candidate.value) && exactPdp(candidate)
  );
  if (!exactSoftStarter || !exactPdp(attribute)) return false;
  const hasOperatingVoltage = attributes.some((candidate) =>
    /^operating voltage$/i.test(candidate.name.trim()) && exactPdp(candidate)
  );
  return !hasOperatingVoltage && /^voltage rating$/i.test(attribute.name.trim()) && /eaton description/i.test(attribute.group ?? "");
}

function exactEatonPowerVoltage(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton" || !hasExactEatonSkuPageEvidence(attributes)) return undefined;
  const exactPowerSupply = attributes.some((attribute) => /^product type$/i.test(attribute.name.trim()) &&
    /\bpower suppl(?:y|ies)\b/i.test(attribute.value) && attribute.parser === "eaton-product-page" &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? ""));
  if (!exactPowerSupply) return undefined;
  const exactPageAttribute = (attribute: AttributeRecord) => attribute.parser === "eaton-product-page" &&
    attribute.sourceType === "official-fallback" && /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "");
  const input = attributes.filter((attribute) => /^input voltage$/i.test(attribute.name.trim()) && exactPageAttribute(attribute))
    .sort(compareAttributeEvidence).map((attribute) => normalizeVoltageValue(attribute.value)).find(Boolean);
  const output = attributes.filter((attribute) => /^output voltage$/i.test(attribute.name.trim()) && exactPageAttribute(attribute))
    .sort(compareAttributeEvidence).map((attribute) => normalizeVoltageValue(attribute.value)).find(Boolean);
  if (!input && !output) return undefined;
  return [input && `Input: ${input}`, output && `Output: ${output}`].filter(Boolean).join("; ");
}

function exactEatonUpsVoltage(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton" || !hasExactEatonSkuPageEvidence(attributes)) return undefined;
  const exactUps = attributes.some((attribute) => /^product type$/i.test(attribute.name.trim()) &&
    /^ups$/i.test(cleanText(attribute.value)) && attribute.parser === "eaton-product-page" &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? ""));
  if (!exactUps) return undefined;
  const exactPageAttribute = (attribute: AttributeRecord) => attribute.parser === "eaton-product-page" &&
    attribute.sourceType === "official-fallback" && /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "");
  const input = attributes.filter((attribute) => /^input voltage range$/i.test(attribute.name.trim()) && exactPageAttribute(attribute))
    .sort(compareAttributeEvidence).map((attribute) => normalizeVoltageValue(attribute.value)).find(Boolean);
  const output = attributes.filter((attribute) => /^output nominal voltage$/i.test(attribute.name.trim()) && exactPageAttribute(attribute))
    .sort(compareAttributeEvidence).map((attribute) => normalizeVoltageValue(attribute.value)).find(Boolean);
  if (!input && !output) return undefined;
  return [input && `Input: ${input}`, output && `Output: ${output}`].filter(Boolean).join("; ");
}

function hasConflictingExactEatonPdpProtection(attributes: AttributeRecord[], manufacturerId?: string): boolean {
  if (manufacturerId !== "eaton" || !hasExactEatonSkuPageEvidence(attributes)) return false;
  const exactPdpCodeSets = attributes
    .filter((attribute) => /^(?:degree of protection|description|open graph description)$/i.test(attribute.name.trim()) &&
      attribute.parser === "eaton-product-page" &&
      /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
      /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? ""))
    .map((attribute) => new Set([...attribute.value.matchAll(/\bIP\s*(\d{2}[A-Z]?)\b/gi)].map((match) => match[1].toUpperCase())))
    .filter((codes) => codes.size > 0);
  return exactPdpCodeSets.some((left, index) => exactPdpCodeSets.slice(index + 1)
    .some((right) => ![...left].some((code) => right.has(code))));
}

function exactEatonMcbVoltageRating(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton" || !hasExactEatonSkuPageEvidence(attributes)) return undefined;
  const exactMcb = attributes.some((attribute) =>
    /^(?:product type|type)$/i.test(attribute.name.trim()) && /\b(?:mcb|miniature circuit breaker)\b/i.test(attribute.value) &&
    attribute.parser === "eaton-product-page" && /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "")
  );
  if (!exactMcb) return undefined;
  return attributes
    .filter((attribute) => /^voltage rating$/i.test(attribute.name.trim()) &&
      attribute.parser === "eaton-product-page" && attribute.sourceType === "official-fallback" &&
      /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
      /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? ""))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeVoltageValue(attribute.value))
    .find((value): value is string => Boolean(value));
}

function exactEatonMcbProtection(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton" || !hasExactEatonSkuPageEvidence(attributes)) return undefined;
  const exactMcb = attributes.some((attribute) =>
    /^(?:product type|type)$/i.test(attribute.name.trim()) && /\b(?:mcb|miniature circuit breaker)\b/i.test(attribute.value) &&
    attribute.parser === "eaton-product-page" && /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "")
  );
  if (!exactMcb) return undefined;
  const published = attributes
    .filter((attribute) => /^degree of protection$/i.test(attribute.name.trim()) &&
      attribute.parser === "eaton-product-page" && attribute.sourceType === "official-fallback" &&
      /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
      /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? ""))
    .sort(compareAttributeEvidence)[0]?.value;
  if (!published) return undefined;
  const tokens = [...published.matchAll(/\b(IP\s*\d{2}[A-Z]?)(?:\s*\(([^)]*)\))?/gi)]
    .map((match) => `${match[1].replace(/\s+/g, "")}${match[2] ? ` (${cleanText(match[2])})` : ""}`);
  return [...new Set(tokens)].join("; ") || undefined;
}

function exactEatonPdpVoltageRating(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton") return undefined;
  const exactPdp = (attribute: AttributeRecord): boolean =>
    attribute.parser === "eaton-product-page" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "");
  const exactSoftStarter = attributes.some((attribute) =>
    /^(?:product type|type)$/i.test(attribute.name.trim()) &&
    /\bsoft starter\b/i.test(attribute.value) && exactPdp(attribute)
  );
  if (exactSoftStarter) {
    const operatingVoltage = attributes
      .filter((attribute) => /^operating voltage$/i.test(attribute.name.trim()) && exactPdp(attribute))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeVoltageValue(attribute.value))
      .find((value): value is string => Boolean(value));
    if (operatingVoltage) return operatingVoltage;
  }
  const exactProtectiveRelay = attributes.some((attribute) =>
    /^(?:product category|product type|type)$/i.test(attribute.name.trim()) &&
    /\b(?:protective|overcurrent)\s+relay\b/i.test(attribute.value) && exactPdp(attribute)
  );
  if (exactProtectiveRelay) {
    const supplyVoltage = attributes
      .filter((attribute) => /^power supply$/i.test(attribute.name.trim()) && exactPdp(attribute))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeVoltageValue(attribute.value))
      .find((value): value is string => Boolean(value));
    if (supplyVoltage) return supplyVoltage;
  }
  const exactTransformer = attributes.some((attribute) =>
    /^product type$/i.test(attribute.name.trim()) && /\btransformer\b/i.test(attribute.value) && exactPdp(attribute)
  );
  if (exactTransformer) {
    const transformerRows = (["primary voltage", "secondary voltage"] as const).flatMap((label) => {
      const value = attributes
        .filter((attribute) => attribute.name.trim().toLowerCase() === label && exactPdp(attribute))
        .sort(compareAttributeEvidence)
        .map((attribute) => cleanText(attribute.value))
        .find(Boolean);
      return value ? [`${label === "primary voltage" ? "Primary" : "Secondary"} voltage: ${value}`] : [];
    });
    if (transformerRows.length > 0) return transformerRows.join("; ");
  }
  const exactMonitoredSupplyVoltage = attributes
    .filter((attribute) => /^rated operational voltage of monitored supply system$/i.test(attribute.name.trim()) && exactPdp(attribute))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeElectricalValue(attribute.value)
      ?.replace(/(V\s+DC)\s+(?=\d+(?:\.\.\.\d+)?\s*V\s+AC\b)/i, "$1 or "))
    .find((value): value is string => Boolean(value && /\b\d+(?:\.\.\.\d+)?\s*V\s+(?:AC|DC)\b/i.test(value)));
  if (exactMonitoredSupplyVoltage) return exactMonitoredSupplyVoltage;
  const exactContactor = attributes.some((attribute) =>
    /^(?:product type|type)$/i.test(attribute.name.trim()) && /^contactor$/i.test(cleanText(attribute.value)) && exactPdp(attribute)
  );
  const exactOperationalVoltageRows = attributes.filter((attribute) =>
    exactPdp(attribute) &&
    (exactContactor
      ? /^rated operational voltage\b/i.test(attribute.name)
      : /\b(?:rated\s+operational\s+voltage|operating\s+voltage)\b/i.test(attribute.name)) &&
    !/\b(?:control\s+supply|control\s+circuit)\b/i.test(attribute.name)
  );
  const exactOperationalRange = deriveVoltageRangeFromMinMax(exactOperationalVoltageRows);
  if (exactOperationalRange) return exactOperationalRange;
  const repeatedExactOperationalVoltage = exactOperationalVoltageRows
    .filter((attribute) => /^rated operational voltage\b/i.test(attribute.name.trim()))
    .flatMap((attribute) => [...attribute.value.matchAll(/\b(\d+(?:[.,]\d+)?\s*V\s*(?:AC|DC))\b/gi)].map((match) => cleanText(match[1])))
    .map((value) => normalizeVoltageValue(value))
    .filter((value): value is string => Boolean(value));
  const distinctRepeatedRatings = [...new Set(repeatedExactOperationalVoltage)];
  // Some exact Eaton relay/controller PDPs repeat one operating rating in a prose row for the
  // device supply, transistor outputs, and input reference. Keep that one verified mode instead
  // of letting the surrounding explanatory text suppress the voltage field.
  if (distinctRepeatedRatings.length === 1) return distinctRepeatedRatings[0];
  const exactOperationalVoltage = exactOperationalVoltageRows
    .filter((attribute) => /^(?:rated operational voltage\b.*|operating voltage)$/i.test(attribute.name.trim()) && exactPdp(attribute))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeVoltageValue(attribute.value))
    .find((value): value is string => Boolean(value));
  if (exactOperationalVoltage) return exactOperationalVoltage;
  const exactRatings = attributes
    .filter((attribute) => /^voltage rating$/i.test(attribute.name.trim()) &&
      exactPdp(attribute))
    .sort(compareAttributeEvidence);
  return exactRatings.map((attribute) => normalizeVoltageValue(attribute.value)).find((value): value is string => Boolean(value));
}

/** Preserve Eaton VFD input and output ratings as separate, exact-page values. */
function exactEatonDriveVoltage(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton" || !hasExactEatonSkuPageEvidence(attributes)) return undefined;
  const exactPdp = (attribute: AttributeRecord): boolean =>
    attribute.parser === "eaton-product-page" &&
    attribute.sourceType === "official-fallback" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "");
  const isDrive = attributes.some((attribute) =>
    /^(?:product type|product name)$/i.test(attribute.name.trim()) &&
    /\b(?:adjustable frequency drive|variable frequency drive|variable speed drive)\b/i.test(attribute.value) && exactPdp(attribute)
  );
  if (!isDrive) return undefined;
  const description = attributes.find((attribute) =>
    /^(?:description|open graph description)$/i.test(attribute.name.trim()) && exactPdp(attribute) &&
    /\b\d+\s*V\s*\d+\s*PH\s+IN\s*\//i.test(attribute.value)
  )?.value;
  const match = description?.match(/\b(\d+(?:[.,]\d+)?)\s*V\s*(?:AC|DC)?\s*(\d+)\s*PH\s+IN\s*\/\s*(\d+(?:[.,]\d+)?)\s*V\s*(?:AC|DC)?\s*(\d+)\s*PH\s+OUT\b/i);
  if (!match) return undefined;
  return `Input: ${normalizeVoltageValue(`${match[1]} V`)} (${match[2]} phase); Output: ${normalizeVoltageValue(`${match[3]} V`)} (${match[4]} phase)`;
}

function eatonNacPowerSupplyCurrent(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton" || !isPowerSupplyProduct(attributes)) return undefined;
  const isNacSupply = attributes.some((attribute) =>
    /^(?:type|product type|product name)$/i.test(attribute.name.trim()) && /\bNAC\s+power\s+supply\b/i.test(attribute.value)
  );
  if (!isNacSupply) return undefined;
  const candidate = attributes.find((attribute) => /^NAC power$/i.test(attribute.name.trim()) &&
    attribute.parser === "eaton-product-page" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? ""));
  return candidate ? normalizeCurrentValue(candidate.value) : undefined;
}

/** Prefer Eaton's exact, explicit Ie rating over distinct auxiliary "supply current" rows. */
function eatonRatedOperationalCurrent(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton") return undefined;
  return attributes
    .filter((attribute) =>
      /^rated operational current(?:\s*\(\s*ie\s*\))?$/i.test(attribute.name.trim()) &&
      attribute.parser === "eaton-product-page" &&
      /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "")
    )
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeCurrentValue(attribute.value))
    .find((value): value is string => Boolean(value && value !== "0 A"));
}

/** The easyE4 base device has several supply modes in one exact operational-voltage row. */
function exactEatonControlRelaySupplyVoltage(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton") return undefined;
  const exactPdp = (attribute: AttributeRecord): boolean =>
    attribute.parser === "eaton-product-page" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "");
  const isControlRelay = attributes.some((attribute) =>
    /^(?:product type|type|product name)$/i.test(attribute.name.trim()) && /\bcontrol relays?\b/i.test(attribute.value) && exactPdp(attribute)
  );
  if (!isControlRelay) return undefined;
  const row = attributes
    .filter((attribute) => /^rated operational voltage$/i.test(attribute.name.trim()) && exactPdp(attribute))
    .sort(compareAttributeEvidence)[0];
  if (!row) return undefined;
  const supplySection = row.value.match(/\bpower supply:\s*([\s\S]*?)(?=\s+relay outputs:|\s+inputs:|$)/i)?.[1];
  if (!supplySection) return undefined;
  const ratings = [...supplySection.matchAll(/\b(\d+(?:[.,]\d+)?\s*V\s*(?:AC|DC))\b/gi)]
    .map((match) => normalizeVoltageValue(match[1]))
    .filter((value): value is string => Boolean(value));
  const distinct = [...new Set(ratings)];
  return distinct.length ? distinct.join(" or ") : undefined;
}

/** Main-circuit voltage for Eaton soft starters; ignore their separate control voltage. */
function exactEatonSoftStarterMainsVoltage(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton") return undefined;
  const exactPdp = (attribute: AttributeRecord): boolean =>
    attribute.parser === "eaton-product-page" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "");
  const isSoftStarter = attributes.some((attribute) =>
    /^(?:product type|type|product name)$/i.test(attribute.name.trim()) && /\bsoft starter\b/i.test(attribute.value) && exactPdp(attribute)
  );
  if (!isSoftStarter) return undefined;
  const rowValue = (name: RegExp): string | undefined => attributes
    .filter((attribute) => name.test(attribute.name.trim()) && exactPdp(attribute))
    .sort(compareAttributeEvidence)
    .map((attribute) => cleanText(attribute.value))
    .find(Boolean);
  const minimum = rowValue(/^mains voltage\s*-\s*min$/i);
  const maximum = rowValue(/^mains voltage\s*-\s*max$/i);
  if (minimum && maximum) {
    const min = minimum.match(/\d+(?:[.,]\d+)?/)?.[0];
    const max = maximum.match(/\d+(?:[.,]\d+)?/)?.[0];
    if (min && max) return normalizeVoltageValue(`${min}...${max} V${/\bAC\b/i.test(rowValue(/^voltage type$/i) ?? "") ? " AC" : ""}`);
  }
  return attributes
    .filter((attribute) => /^voltage rating$/i.test(attribute.name.trim()) && exactPdp(attribute))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeVoltageValue(attribute.value))
    .find((value): value is string => Boolean(value));
}

/** Preserve both Eaton RCCB voltage options instead of selecting the Ue maximum row. */
function exactEatonRccbVoltageOptions(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton") return undefined;
  const exactPdp = (attribute: AttributeRecord): boolean =>
    attribute.parser === "eaton-product-page" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "");
  const isRccb = attributes.some((attribute) =>
    /^(?:product type|type)$/i.test(attribute.name.trim()) && /\bresidual current(?: circuit)? devices?\b|\bRCCB\b/i.test(attribute.value) && exactPdp(attribute)
  );
  if (!isRccb) return undefined;
  return attributes
    .filter((attribute) => /^voltage rating$/i.test(attribute.name.trim()) && exactPdp(attribute))
    .sort(compareAttributeEvidence)
    .map((attribute) => {
      const options = [...attribute.value.matchAll(/\b\d+(?:[.,]\d+)?\s*V\s*(?:AC|DC)?\b/gi)]
        .map((match) => normalizeVoltageValue(match[0]))
        .filter((value): value is string => Boolean(value));
      return [...new Set(options)].join(" or ");
    })
    .find(Boolean);
}

/** easyE4 relay contact rating; do not substitute a thermal derating value from a long current row. */
function exactEatonControlRelaySwitchingCurrent(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton") return undefined;
  const exactPdp = (attribute: AttributeRecord): boolean =>
    attribute.parser === "eaton-product-page" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "");
  const isControlRelay = attributes.some((attribute) =>
    /^(?:product type|type|product name)$/i.test(attribute.name.trim()) && /\bcontrol relays?\b/i.test(attribute.value) && exactPdp(attribute)
  );
  if (!isControlRelay) return undefined;
  return attributes
    .filter((attribute) => /^switching current$/i.test(attribute.name.trim()) && exactPdp(attribute))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeCurrentValue(attribute.value))
    .find((value): value is string => Boolean(value));
}

/** Prefer the explicit main-contact continuous/rated value over a lower UL general-use rating. */
function exactEatonMainSwitchCurrent(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton") return undefined;
  const exactPdp = (attribute: AttributeRecord): boolean =>
    attribute.parser === "eaton-product-page" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "");
  const isMainSwitch = attributes.some((attribute) =>
    /^(?:product type|product category|type)$/i.test(attribute.name.trim()) && /^main switch$/i.test(attribute.value.trim()) && exactPdp(attribute)
  );
  if (!isMainSwitch) return undefined;
  const ratings = [
    /^rated uninterrupted current\s*\(\s*iu\s*\)$/i,
    /^rated operational current for specified heat dissipation\s*\(\s*in\s*\)$/i,
    /^rated permanent current at ac-21\b/i
  ];
  for (const pattern of ratings) {
    const value = attributes
      .filter((attribute) => pattern.test(attribute.name.trim()) && exactPdp(attribute))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeCurrentValue(attribute.value))
      .find((candidate): candidate is string => Boolean(candidate && candidate !== "0 A"));
    if (value) return value;
  }
  return undefined;
}

/** For a soft starter, AC-53 is the main-circuit rating; control input current is auxiliary data. */
function exactEatonSoftStarterAc53Current(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eaton") return undefined;
  const exactPdp = (attribute: AttributeRecord): boolean =>
    attribute.parser === "eaton-product-page" &&
    /^https:\/\/(?:www\.)?eaton\.com(?:\.cn)?\//i.test(attribute.sourceUrl ?? "") &&
    /\/skuPage\.[^/]+?\.html$/i.test(attribute.sourceUrl ?? "");
  const isSoftStarter = attributes.some((attribute) =>
    /^(?:product type|type|product name)$/i.test(attribute.name.trim()) && /\bsoft starter\b/i.test(attribute.value) && exactPdp(attribute)
  );
  if (!isSoftStarter) return undefined;
  return attributes
    .filter((attribute) => /^rated operational current\s*\(\s*ie\s*\)\s*at\s+ac-53$/i.test(attribute.name.trim()) && exactPdp(attribute))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeCurrentValue(attribute.value))
    .find((value): value is string => Boolean(value && value !== "0 A"));
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
    /\b(operating|operational|ambient|working|surrounding|service)\b[^.;|]*\btemp(?:erature)?\b/i.test(`${label(attr)} ${attr.value}`) ||
    /\btemp(?:erature)?\b[^.;|]*\b(operating|operational|ambient|working|surrounding|service)\b/i.test(`${label(attr)} ${attr.value}`) ||
    /\b(operating|ambient)\s+temperature\b/i.test(`${label(attr)} ${attr.value}`) ||
    /\btemperature range\b/i.test(`${label(attr)} ${attr.value}`) ||
    /\bumgebungstemperatur\b|\bbetriebstemperatur\b/i.test(`${label(attr)} ${attr.value}`) ||
    fieldMatchesLabel("operatingTemperature", `${label(attr)} ${attr.value}`);
  const isExcludedLabel = (attr: AttributeRecord): boolean =>
    /\b(current|strom|storage|lager|colou?r\s+temp(?:erature)?|color\s+temp)\b/i.test(`${label(attr)} ${attr.value}`) ||
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

  const temperatureBounds = (text: string): string[] =>
    [...text.matchAll(/([+-]?\d+(?:[.,]\d+)?)\s*°?\s*C\b/gi)].map((match) => String(localizedNumber(match[1] ?? "")));
  const explicitStorageRanges = attributes
    .filter((attr) => /\b(?:storage|transport|lager)\b/i.test(`${label(attr)} ${attr.value}`))
    .map((attr) => temperatureBounds(`${attr.name} ${attr.value}`))
    .filter((bounds) => bounds.length >= 2);
  const duplicatesStorageRange = (attr: AttributeRecord): boolean => {
    if (/\b(?:operat(?:ion|ing|ional)|working|service)\b/i.test(`${label(attr)} ${attr.value}`)) return false;
    const bounds = temperatureBounds(`${attr.name} ${attr.value}`);
    return bounds.length >= 2 && explicitStorageRanges.some((storage) =>
      storage[0] === bounds[0] && storage[storage.length - 1] === bounds[bounds.length - 1]
    );
  };

  // 1) Explicitly temperature-labelled attributes (most reliable).
  for (const attr of attributes) {
    if (!attr.value || !isTemperatureLabel(attr) || isExcludedLabel(attr) || duplicatesStorageRange(attr)) continue;
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
  return temperatureFromSeparateMinMaxRows(attributes.filter((attr) => !duplicatesStorageRange(attr)), isTemperatureLabel, isExcludedLabel);
}

function isSchneiderSurgeProtector(attributes: AttributeRecord[]): boolean {
  return attributes.some((attribute) =>
    /^(?:product or component type|product type|title)$/i.test(attribute.name.trim()) &&
    /\bsurge arrester\b|\bsurge protective device\b/i.test(attribute.value)
  );
}

function isSchneiderTransformer(attributes: AttributeRecord[]): boolean {
  return attributes.some((attribute) =>
    /^(?:product or component type|product type)$/i.test(attribute.name.trim()) &&
    /\btransformer\b/i.test(attribute.value) &&
    (attribute.sourceType === "official" || attribute.sourceType === "official-fallback" ||
      (attribute.sourceType === "generated" && attribute.matchLevel === "exact"))
  );
}

export function isSchneiderSafetyLightCurtain(attributes: AttributeRecord[]): boolean {
  return attributes.some((attribute) =>
    /^(?:product or component type|product type)$/i.test(attribute.name.trim()) &&
    /\bsafety light curtain\b/i.test(attribute.value) &&
    (attribute.sourceType === "official" || attribute.sourceType === "official-fallback")
  );
}

function isSchneiderSafetyControllerWithChannelCurrent(attributes: AttributeRecord[]): boolean {
  const text = attributes.map((attribute) => `${attribute.group ?? ""} ${attribute.name} ${attribute.value}`).join(" ");
  const hasControllerOssdOutputs = /\bsafety controller cpu\b/i.test(text) && /\bOSSD\b/i.test(text);
  const hasDeviceSupplyCurrent = attributes.some((attribute) =>
    /^(?:rated\s+(?:supply\s+)?current|supply current|input current|current consumption)$/i.test(attribute.name.trim())
  );
  return hasControllerOssdOutputs && !hasDeviceSupplyCurrent;
}

export function isSchneiderM221OutputCurrent(attributes: AttributeRecord[]): boolean {
  const text = attributes.map((attribute) => `${attribute.group ?? ""} ${attribute.name} ${attribute.value}`).join(" ");
  const isM221Controller = /\b(?:TM221[A-Z0-9]+|Modicon\s+M221)\b/i.test(text) && /\blogic controller\b/i.test(text);
  const hasSupplyCurrent = attributes.some((attribute) => /^(?:rated\s+supply\s+current|supply current|current consumption)$/i.test(attribute.name.trim()));
  const hasOutputCurrent = attributes.some((attribute) => /^(?:discrete output current|output current|maximum current per output)$/i.test(attribute.name.trim()));
  return isM221Controller && hasOutputCurrent && !hasSupplyCurrent;
}

function isSchneiderSoftStarter(attributes: AttributeRecord[]): boolean {
  const text = attributes.map((attribute) => `${attribute.group ?? ""} ${attribute.name} ${attribute.value}`).join(" ");
  return /\b(?:soft starter|Altistart\s*01)\b/i.test(text);
}

function schneiderSoftStarterRatedCurrent(attributes: AttributeRecord[]): string | undefined {
  if (!isSchneiderSoftStarter(attributes)) return undefined;
  const rating = attributes.find((attribute) => /^IcL starter rating$/i.test(attribute.name.trim()));
  return normalizeCurrentValue(rating?.value);
}

function schneiderMcbVoltage(attributes: AttributeRecord[]): string | undefined {
  const isMcb = attributes.some((attribute) =>
    /^(?:product or component type|product type)$/i.test(attribute.name.trim()) && /miniature circuit.breaker/i.test(attribute.value)
  );
  if (!isMcb) return undefined;
  const description = attributes.find((attribute) =>
    /^description$/i.test(attribute.name.trim()) && attribute.parser === "schneider-product-page" &&
    (attribute.sourceType === "official" || attribute.sourceType === "official-fallback")
  )?.value ?? "";
  // The exact MCB description ties its breaking-capacity ratings to circuit voltages. Do not
  // treat the datasheet's lower Ue boundary (12 V) as the normal application voltage.
  const range = description.match(/\b\d+\s*kA\s+at\s+(\d{3})\s*V\s*AC\s+to\s*(\d{3})\s*V\s*AC\b/i);
  if (range) return `${range[1]}...${range[2]} V AC`;
  const single = description.match(/\b\d+\s*A\s+at\s+(\d{3})\s*V\s*AC\b/i);
  return single ? `${single[1]} V AC` : undefined;
}

export function isSchneiderPendantStation(attributes: AttributeRecord[]): boolean {
  const text = attributes.map((attribute) => `${attribute.group ?? ""} ${attribute.name} ${attribute.value}`).join(" ");
  return /\b(?:pendant control station|pendant station)\b/i.test(text) && /\bXACA\b/i.test(text);
}

function schneiderExplicitProductColor(attributes: AttributeRecord[]): string | undefined {
  const attribute = attributes
    .filter((candidate) =>
      /^(?:housing\s+)?colou?r\s*:?$/i.test(candidate.name.trim().replace(/^•\s*/, "")) &&
      !/\b(?:led|display|screen|signall?ing|indicator)\b/i.test(`${candidate.group ?? ""} ${candidate.name} ${candidate.value}`) &&
      (candidate.sourceType === "official" || candidate.sourceType === "official-fallback" ||
        (candidate.sourceType === "generated" && candidate.matchLevel === "exact")) &&
      Boolean(deriveColorFromFinish(candidate.value))
    )
    .sort(compareAttributeEvidence)[0];
  return attribute ? normalizeHtmlSpecValue(attribute.value)?.replace(/\)+\s*$/, "") : undefined;
}

function schneiderTransformerOutputVoltage(
  voltageAttributes: AttributeRecord[],
  attributes: AttributeRecord[]
): string | undefined {
  if (!isSchneiderTransformer(attributes)) return undefined;
  return voltageAttributes
    .filter((attribute) =>
      /^output voltage$/i.test(attribute.name.trim()) &&
      attribute.sourceType === "generated" &&
      attribute.matchLevel === "exact" &&
      /^PDF datasheet$/i.test(attribute.group ?? "")
    )
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeVoltageValue(attribute.value))
    .find((value): value is string => Boolean(value));
}

/**
 * Derive the rated single-secondary current only when one exact datasheet row supplies both the
 * output voltage and VA rating. This is a transparent VA/V calculation, not a sibling lookup or
 * an inferred electrical operating point from unrelated input/output rows.
 */
function schneiderTransformerSecondaryCurrent(attributes: AttributeRecord[]): string | undefined {
  const exactDatasheetRows = attributes.filter((attribute) =>
    attribute.sourceType === "generated" && attribute.matchLevel === "exact" &&
    /^PDF datasheet$/i.test(attribute.group ?? "")
  );
  const sourceUrls = [...new Set(exactDatasheetRows.map((attribute) => attribute.sourceUrl).filter(Boolean))];
  for (const sourceUrl of sourceUrls) {
    const rows = exactDatasheetRows.filter((attribute) => attribute.sourceUrl === sourceUrl);
    const componentType = rows.find((attribute) => /^product or component type$/i.test(attribute.name.trim()));
    const winding = rows.find((attribute) => /^secondary winding$/i.test(attribute.name.trim()));
    const output = rows.find((attribute) => /^output voltage$/i.test(attribute.name.trim()));
    const ratedPower = rows.find((attribute) => /^rated power in VA$/i.test(attribute.name.trim()));
    if (!componentType || !/\btransformer\b/i.test(componentType.value) || !/^single$/i.test(winding?.value.trim() ?? "")) continue;
    const voltageMatch = output?.value.match(/^\s*(\d+(?:[.,]\d+)?)\s*V\s*AC\s*$/i);
    const powerMatch = ratedPower?.value.match(/^\s*(\d+(?:[.,]\d+)?)\s*VA\s*$/i);
    if (!voltageMatch || !powerMatch) continue;
    const volts = Number(voltageMatch[1].replace(",", "."));
    const voltAmps = Number(powerMatch[1].replace(",", "."));
    if (!(volts > 0) || !(voltAmps > 0)) continue;
    return `${Number((voltAmps / volts).toFixed(2))} A`;
  }
  return undefined;
}

function schneiderDualSupplyVoltage(attributes: AttributeRecord[]): string | undefined {
  const attribute = attributes
    .filter((candidate) => /^\[Us\]\s*rated supply voltage$/i.test(candidate.name.trim()))
    .sort(compareAttributeEvidence)[0];
  if (attribute && /\bAC\b/i.test(attribute.value) && /\bDC\b/i.test(attribute.value)) return cleanText(attribute.value);

  // Some exact Schneider product pages publish the AC/DC supply in the model description,
  // while the PDF text table captures only the first (AC) tolerance row. Preserve both modes.
  for (const description of attributes.filter((candidate) =>
    /^(?:description|title)$/i.test(candidate.name.trim()) &&
    (candidate.sourceType === "official" || candidate.sourceType === "official-fallback")
  )) {
    const match = /\b(\d+(?:[.,]\d+)?)\s*V\s*AC\s*(?:\/|or)\s*DC\b/i.exec(description.value);
    if (match) return `${match[1]} V AC/DC`;
  }
  return undefined;
}

function schneiderPowerSupplyOutputVoltage(
  voltageAttributes: AttributeRecord[],
  attributes: AttributeRecord[]
): string | undefined {
  const productText = attributes
    .filter((attribute) => /^(?:product or component type|product type|title|description)$/i.test(attribute.name.trim()))
    .map((attribute) => attribute.value)
    .join(" ");
  if (!/\bpower supply\b/i.test(productText)) return undefined;
  const output = voltageAttributes
    .filter((attribute) => /^output voltage$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeVoltageValue(attribute.value))
    .filter((value): value is string => Boolean(value));
  // Schneider product descriptions often state the output voltage beside the rated output
  // current, while the PDF text pass can mislabel an input-voltage range as "Output Voltage".
  // When that happens, prefer the candidate that agrees with the explicit output rating in the
  // exact product description (for example, "rated output current of 5A at 24 V DC").
  const ratedOutputVoltage = attributes
    .filter((attribute) => /^(?:description|title)$/i.test(attribute.name.trim()) &&
      (attribute.sourceType === "official" || attribute.sourceType === "official-fallback"))
    .map((attribute) => /\brated output (?:current|power)\b[^.]{0,100}?\bat\s+(\d+(?:[.,]\d+)?\s*V\s*(?:AC|DC))\b/i.exec(attribute.value)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeVoltageValue(value))
    .find(Boolean);
  const outputVoltage = ratedOutputVoltage && output.find((value) => value === ratedOutputVoltage);
  if (outputVoltage) return outputVoltage;
  return output[0];
}

function schneiderOperatingTemperature(attributes: AttributeRecord[]): { min?: string; max?: string } | undefined {
  const attribute = attributes.find((candidate) =>
    /^ambient air temperature for operation$/i.test(candidate.name.trim()) &&
    (candidate.sourceType === "official" || candidate.sourceType === "official-fallback" ||
      (candidate.sourceType === "generated" && candidate.parser === "pdf-table-extractor" && candidate.matchLevel === "exact"))
  );
  if (!attribute) return undefined;

  // Schneider's ABL8 datasheet can give multiple operating ranges in one row, such as
  // -25..50 °C without derating and 50..60 °C with derating. Use the full published envelope.
  const ranges = [...attribute.value.matchAll(/\(?\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:…|\.{2,}|\bto\b)\s*([+-]?\d+(?:[.,]\d+)?)\s*°\s*C\s*\)?/gi)]
    .map((match) => [Number((match[1] ?? "").replace(",", ".")), Number((match[2] ?? "").replace(",", "."))])
    .filter(([min, max]) => Number.isFinite(min) && Number.isFinite(max) && min <= max);
  if (!ranges.length) return undefined;
  return {
    min: formatTemperatureBound(Math.min(...ranges.map(([min]) => min))),
    max: formatTemperatureBound(Math.max(...ranges.map(([, max]) => max)))
  };
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
  const locales: Array<"de" | "en"> = ["de", "en"];
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
    normalizeFields(attributes, documents, primary.manufacturerId === "rittal" || primary.manufacturerId === "schmersal" || primary.manufacturerId === "phoenix" || primary.manufacturerId === "schneider" || primary.manufacturerId === "doepke" || primary.manufacturerId === "sce" || primary.manufacturerId === "nvent" ? primary.manufacturerId : undefined),
    primary.normalized,
    fallback.normalized,
    attributes,
    primary.manufacturerId === "rittal" || primary.manufacturerId === "phoenix" || primary.manufacturerId === "schneider" || primary.manufacturerId === "doepke" || primary.manufacturerId === "sce" || primary.manufacturerId === "nvent" ? primary.manufacturerId : undefined
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
      if (field === "current" && isNonOperatingCurrentLabel(haystack)) return false;
      // `patterns` here is FIELD_LABEL_PATTERNS — a third label vocabulary, even looser than the
      // registry's aliases (`/voltage/`, `/weight/` with no word boundary at all). It needs the same
      // deference to the ontology, and measurement says so: with the check only in
      // shouldSkipRegistryFieldCandidate, "Rated residual current 30 mA" still reached the current field
      // through this path, because this path never consults the registry.
      if (field && registryFieldContradictsOntology(field, haystack)) return false;
      return patterns.some((pattern) => pattern.test(haystack)) && isLikelySpecText(attr.value) && isAvailableSpecValue(attr.value);
    })
    .sort((left, right) => attributeEvidenceScore(right) + normalizedFieldLabelScore(right, field) - attributeEvidenceScore(left) - normalizedFieldLabelScore(left, field))
    // `voltage` and `current` run the winner through withoutMixedKindProse afterwards. Applying it
    // here too is what makes that guard a candidate filter instead of a field killer: a top-ranked
    // label whose value is a mixed V/A table (ABB prints "Rated Operational Current AC-21A" as
    // "(380 ... 415 V) 1000 A; (500 V) 1000 A; ...") used to win the ranking, get voided, and take
    // the whole field down with it — even with a clean "Conventional Thermal Current 1000 A" next
    // in line. Scoped to the two fields that already have the outer guard, so nothing else moves.
    .map((attr) => (field === "voltage" || field === "current" ? withoutMixedKindProse(normalize(attr.value)) : normalize(attr.value)))
    .find((value): value is string => Boolean(value));
}

/** ABB's master-data certificate column contains only compact certification names. */
export function normalizeAbbFields(attributes: AttributeRecord[], documents: DocumentRecord[]): NormalizedProductFields {
  const normalized = normalizeFields(attributes, documents);
  const disconnectSwitchRatings = abbDisconnectSwitchRatings(attributes);
  const monitoringRelaySupplyVoltage = abbMonitoringRelaySupplyVoltage(attributes);
  const primaryVoltage = abbMeterRatedVoltage(attributes);
  const hmiSupplyVoltage = abbHmiSupplyVoltage(attributes);
  const operatorLampVoltage = abbOperatorLampVoltage(attributes);
  const productProtection = abbOfficialProductAttribute(attributes, /^degree of protection$/i);
  const productMaterial = abbOfficialProductAttribute(attributes, /^material(?: of (?:housing|enclosure))?$/i);
  const productColor = abbOfficialProductAttribute(attributes, /^(?:color|colour)$/i);
  const source = [
    ...attributes
      .filter((attr) => /certificate|certification|approval|standard/i.test(`${attr.group ?? ""} ${attr.name}`))
      .map((attr) => attr.value),
    normalized.certificates
  ].filter((value): value is string => Boolean(value)).join("; ");
  const certificates = compactAbbCertificateNames(source);
  return {
    ...normalized,
    voltage: disconnectSwitchRatings?.voltage ?? monitoringRelaySupplyVoltage ?? primaryVoltage ?? hmiSupplyVoltage ?? operatorLampVoltage ?? normalized.voltage,
    current: disconnectSwitchRatings?.current ?? abbContactorAc3Current(attributes, "abb") ?? normalized.current,
    protection: productProtection ?? normalized.protection,
    material: productMaterial,
    color: productColor,
    certificates: certificates || undefined
  };
}

/** The LED supply on an ABB illuminated command/pilot operator is not its contact insulation rating. */
function abbOperatorLampVoltage(attributes: AttributeRecord[]): string | undefined {
  const lampType = attributes
    .filter((attribute) => attribute.sourceType === "official" && /^lamp type$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => cleanText(attribute.value))
    .find((value) => /\b(?:AC|DC|V)\b/i.test(value));
  if (!lampType) return undefined;
  const voltage = lampType.match(/\b\d+(?:[.,]\d+)?\s*V(?:\s*AC\s*\/\s*DC|\s*AC\/DC|\s*DC|\s*AC)?\b/i)?.[0];
  return voltage ? normalizeVoltageValue(voltage) : undefined;
}

/**
 * ABB switch-disconnector pages may expose a UL/CSA ampere rating and insulation voltage as
 * generic current/voltage fields, while the IEC catalogue gives the actual AC-23A operating
 * rating. Prefer the exact ABB operational table for this product class and keep the max voltage
 * and current values from that table as the normalized headline ratings.
 */
function abbDisconnectSwitchRatings(attributes: AttributeRecord[]): { voltage?: string; current?: string } | undefined {
  const context = attributes
    .filter((attribute) => /^(?:display name|extended product type|catalog description|long description)$/i.test(attribute.name.trim()))
    .map((attribute) => attribute.value)
    .join(" ");
  if (!/\b(?:switch[- ]disconnect(?:or)?|disconnect switch)\b/i.test(context)) return undefined;

  const operatingRatings = attributes
    .filter((attribute) => attribute.sourceType === "official" &&
      /^rated operational current AC[-\s]?23A$/i.test(attribute.name.trim()) && isLikelySpecText(attribute.value))
    .sort(compareAttributeEvidence);
  for (const attribute of operatingRatings) {
    const pairs = [...attribute.value.matchAll(/\(\s*((?:\d+(?:[.,]\d+)?\s*(?:\.\.\.|…|[-–])\s*)?\d+(?:[.,]\d+)?)\s*V\s*\)\s*(\d+(?:[.,]\d+)?)\s*A/gi)];
    const currents = pairs.map((pair) => localizedNumber(pair[2])).filter((value): value is number => Number.isFinite(value));
    const highestCurrent = Math.max(...currents);
    const representativeRating = pairs.find((pair) => localizedNumber(pair[2]) === highestCurrent);
    if (representativeRating && Number.isFinite(highestCurrent)) {
      return {
        // Keep a real voltage/current operating point together. For instance OT16F3 is 16 A at
        // 380...415 V but only 10 A at 690 V; publishing the two independent maxima together
        // would imply a rating combination ABB does not specify.
        voltage: normalizeVoltageValue(`${representativeRating[1]} V`),
        current: `${highestCurrent} A`
      };
    }
  }
  return undefined;
}

function abbHmiSupplyVoltage(attributes: AttributeRecord[]): string | undefined {
  const productContext = attributes
    .filter((attribute) => /^(?:display name|extended product type|product type|catalog description)$/i.test(attribute.name.trim()))
    .map((attribute) => attribute.value)
    .join(" ");
  if (!/\bCP6\d{2}(?:-WEB)?\b/i.test(productContext)) return undefined;

  const supply = attributes
    .filter((attribute) => attribute.sourceType === "official" && /^power supply$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => cleanText(attribute.value))
    .find(Boolean);
  if (!supply) return undefined;

  const range = supply.match(/\(\s*(\d+(?:[.,]\d+)?)\s*(?:\.\.\.|…|[-–])\s*(\d+(?:[.,]\d+)?)\s*\)\s*(k?V\s*(?:AC|DC)?)/i);
  if (range) return normalizeVoltageValue(`${range[1]}...${range[2]} ${range[3]}`);
  return normalizeVoltageValue(supply);
}

function abbOfficialProductAttribute(attributes: AttributeRecord[], namePattern: RegExp): string | undefined {
  return attributes
    .filter((attribute) => attribute.sourceType === "official" && namePattern.test(attribute.name.trim()) &&
      !/^(?:not applicable|n\/a|unknown|-)$/i.test(attribute.value.trim()) && isLikelySpecText(attribute.value))
    .sort(compareAttributeEvidence)
    .map((attribute) => cleanText(attribute.value))
    .find(Boolean);
}

function abbMeterRatedVoltage(attributes: AttributeRecord[]): string | undefined {
  const productContext = attributes
    .filter((attribute) => /(?:display name|catalog description|product type|long description)/i.test(attribute.name))
    .map((attribute) => attribute.value)
    .join(" ");
  if (!/\bM4M\s*20\b/i.test(productContext)) return undefined;
  const ratedVoltage = attributes
    .filter((attribute) => attribute.sourceType === "official" && /^rated voltage\b/i.test(attribute.name.trim()) &&
      /\bN-L\b/i.test(attribute.value) && /\bL-L\b/i.test(attribute.value))
    .sort(compareAttributeEvidence)
    .map((attribute) => cleanText(attribute.value))
    .find(Boolean);
  return ratedVoltage?.replace(/\s*…\s*/g, "...").replace(/\s*\.\.\.\s*/g, "...");
}

function abbMonitoringRelaySupplyVoltage(attributes: AttributeRecord[]): string | undefined {
  const productContext = attributes
    .filter((attribute) => /(?:product type|catalog description|long description|extended product type|type designation)/i.test(attribute.name))
    .map((attribute) => attribute.value)
    .join(" ");
  if (!/\b(?:three[-\s]?phase\s+monitoring\s+relay|CM-MP[SN](?:\.|\b))/i.test(productContext)) return undefined;

  return attributes
    .filter((attribute) => /^rated control supply voltage\b/i.test(attribute.name.trim()) &&
      attribute.sourceType === "official" && isLikelySpecText(attribute.value) && isAvailableSpecValue(attribute.value))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeVoltageValue(attribute.value))
    .find((value): value is string => Boolean(value));
}

function compactAbbCertificateNames(value: string): string {
  const canonicalNames = [
    "A2L", "ABS", "ATEX", "BV", "CB", "CCC", "CCS", "CE", "CSA", "DNV", "EAC", "IECEx", "IEC",
    "KC", "KCC", "Lloyds", "ODVA", "RCM", "RINA", "TUV", "UKCA", "UL", "cULus", "cURus", "VDE"
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of value.matchAll(/\b(?:A2L|ABS|ATEX|BV|CB|CCC|CCS|CE|CSA|cULus|cURus|DNV(?:\s+GL)?|EAC|IECEx|IEC|KC|KCC|Lloyds?|ODVA|RCM|RINA|T(?:Ü|U)V|UKCA|UL|VDE)\b/gi)) {
    const raw = match[0].replace(/TÜV/i, "TUV");
    const canonical = canonicalNames.find((name) => name.toLowerCase() === raw.toLowerCase()) ?? raw;
    if (!seen.has(canonical.toLowerCase())) {
      seen.add(canonical.toLowerCase());
      result.push(canonical);
    }
  }
  return result.join(", ");
}

function isNonOperatingCurrentLabel(label: string): boolean {
  return /\b(?:fault|surge|nominal discharge|short[-\s]?circuit|interrupt|withstand|breaking)\s+current\b|\bcurrent\s+(?:fault|surge|short[-\s]?circuit|interrupt|withstand|breaking)\b/i.test(label);
}

function isNonRatingCurrentArtifact(attribute: AttributeRecord): boolean {
  const value = cleanText(attribute.value);
  return /^\s*(?:UL|CSA|IEC|IEEE|EN|NEMA)\s*[\d.-]+[A-Z0-9./ -]*$/i.test(value) ||
    /^\s*[A-Z]{2,}\d{4,}(?:-[A-Z0-9]+)*\s*$/i.test(value);
}

function powerSupplyOutputVoltage(attributes: AttributeRecord[]): string | undefined {
  const hasExplicitRatedOutput = attributes.some((attribute) => /^rated output voltage$/i.test(attribute.name.trim()));
  if (!isPowerSupplyProduct(attributes) && !hasExplicitRatedOutput) return undefined;
  return attributes
    .filter((attr) => {
      const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      if (/\b(?:settle length|wire stripping|stripping length|conductor)\b/i.test(`${attr.name} ${attr.value}`)) return false;
      return isPowerSupplyOutputVoltageLabel(label) && isLikelySpecText(attr.value) && isAvailableSpecValue(attr.value);
    })
    .sort(compareAttributeEvidence)
    .map((attr) => normalizeVoltageValue(attr.value))
    .find((value): value is string => Boolean(value));
}

function powerSupplyOutputCurrent(attributes: AttributeRecord[]): string | undefined {
  if (!isPowerSupplyProduct(attributes)) return undefined;
  const candidates = attributes
    .filter((attr) => {
      const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      return /\b(?:output current|current at secondary voltage|power supply output current|nominal current)\b/.test(label) &&
        !/\b(?:input|inrush|package|short[- ]circuit)\b/.test(label) &&
        !isDisqualifiedForQuantityKind(label, attr.value, "current") &&
        isLikelySpecText(attr.value) && isAvailableSpecValue(attr.value);
    })
    .sort(compareAttributeEvidence);
  for (const attr of candidates) {
    const value = extractCurrentValues(attr.value, `${attr.group ?? ""} ${attr.name}`)[0];
    if (value) return value;
    const explicitUnit = attr.name.match(/\(\s*(mA|A)\s*\)/i)?.[1];
    const explicitMagnitude = cleanText(attr.value).match(/\d+(?:[.,]\d+)?(?:\s*(?:\.\.\.|…|–|to)\s*\d+(?:[.,]\d+)?)?/i)?.[0];
    if (explicitUnit && explicitMagnitude) {
      const labelledValue = normalizeCurrentValue(`${explicitMagnitude} ${explicitUnit}`);
      if (labelledValue) return labelledValue;
    }
  }
  return undefined;
}

function phoenixContactPowerSupplyOutputCurrent(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "phoenix") return undefined;
  const title = attributes
    .filter((attribute) => /^(?:title|product name|catalog description)$/i.test(attribute.name.trim()))
    .map((attribute) => attribute.value)
    .join(" ");
  if (!/\bQUINT4-PS\//i.test(title)) return undefined;
  const exactModelSuffix = title.match(/\bQUINT4-PS\/[^\s/]+\/[^\s/]+\/(\d+(?:[.,]\d+)?)\b/i)?.[1];
  return exactModelSuffix ? normalizeCurrentValue(`${exactModelSuffix} A`) : undefined;
}

function phoenixContactSwitchMaximumCurrent(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "phoenix" || !attributes.some((attribute) =>
    /^(?:title|product name|catalog description)$/i.test(attribute.name.trim()) && /\bFL\s+SWITCH\b/i.test(attribute.value)
  )) return undefined;
  return attributes
    .filter((attribute) => /^maximum current consumption$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => {
      const current = normalizeCurrentValue(attribute.value);
      const voltage = attribute.value.match(/\bat\s+(\d+(?:[.,]\d+)?\s*V\s*DC)\b/i)?.[1];
      const alreadyQualified = /\bat\s+\d+(?:[.,]\d+)?\s*V\s*DC\b/i.test(attribute.value);
      return current ? `${current}${voltage && !alreadyQualified ? ` (at ${cleanText(voltage)})` : ""}` : undefined;
    })
    .find((value): value is string => Boolean(value));
}

function isPhoenixSafetyRelay(attributes: AttributeRecord[]): boolean {
  return attributes.some((attribute) =>
    /^(?:title|product name|catalog description|product type)$/i.test(attribute.name.trim()) &&
    /\b(?:safety relay|PSR-SPP)\b/i.test(attribute.value)
  );
}

function phoenixSafetyRelaySupplyCurrent(attributes: AttributeRecord[]): string | undefined {
  const current = attributes
    .filter((attribute) => /^supply current$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeCurrentValue(attribute.value))
    .find((value): value is string => Boolean(value));
  return current ? `${current} (supply current)` : undefined;
}

function isPhoenixSignalConditioner(attributes: AttributeRecord[]): boolean {
  return attributes.some((attribute) =>
    /^(?:title|product name|catalog description|product type)$/i.test(attribute.name.trim()) &&
    /\b(?:input signal conditioner|signal conditioner)\b/i.test(attribute.value)
  );
}

function phoenixContactCategoryCurrent(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "phoenix") return undefined;
  const productText = attributes
    .filter((attribute) => /^(?:title|product name|catalog description|product type)$/i.test(attribute.name.trim()))
    .map((attribute) => attribute.value)
    .join(" ");
  const select = (labels: RegExp) => attributes
    .filter((attribute) => labels.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeCurrentValue(attribute.value))
    .find((value): value is string => Boolean(value));
  if (/\b(?:safety switch sensor|safety sensor)\b/i.test(productText)) {
    const value = select(/^load current max$/i);
    return value ? `${value} max. load current` : undefined;
  }
  if (/\bbattery\b/i.test(productText)) {
    const value = select(/^maximum output current$/i);
    const derating = attributes
      .filter((attribute) => /^output current derating$/i.test(attribute.name.trim()))
      .map((attribute) => cleanText(attribute.value))
      .find(Boolean);
    return value ? `${value} max. output${derating ? ` (${derating})` : ""}` : undefined;
  }
  if (/\bhybrid motor starter\b/i.test(productText)) {
    const value = select(/^motor output current$/i);
    return value ? `${value} motor output` : undefined;
  }
  if (/\buninterruptible power supply\b/i.test(productText)) {
    const value = select(/^output current$/i);
    return value ? `${value} output` : undefined;
  }
  if (/\bpcb terminal block\b/i.test(productText)) {
    const value = select(/^nominal current$/i);
    return value ? `${value} nominal` : undefined;
  }
  if (/\bEEM-XM157\b/i.test(productText)) {
    const value = select(/^input current$/i);
    return value ? `${value} (direct measurement)` : undefined;
  }
  if (/\bPT\s*2,5-TWIN\s+RD\b/i.test(productText) || /\bTCP\s*1A\b/i.test(productText)) {
    return select(/^nominal current$/i);
  }
  return undefined;
}

function phoenixContactExplicitColor(attributes: AttributeRecord[]): string | undefined {
  return attributes
    .filter((attribute) => /^color$/i.test(attribute.name.trim()) && attribute.parser === "Phoenix Contact product page")
    .sort(compareAttributeEvidence)
    .map((attribute) => {
      const match = attribute.value.match(/^\s*((?:red|blue|green|yellow|black|white|gray|grey|orange|brown|violet|purple)(?:\s*\(RAL\s*\d{4}\))?)\s*$/i);
      return match?.[1] ? cleanText(match[1]) : undefined;
    })
    .find((value): value is string => Boolean(value));
}

function phoenixProductMaterial(attributes: AttributeRecord[]): string | undefined {
  return attributes
    .filter((attribute) => /^material$/i.test(attribute.name.trim()) &&
      !/^(?:specifications|not available|n\/?a)$/i.test(attribute.value.trim()))
    .sort((left, right) => {
      const score = (attribute: AttributeRecord) =>
        (materialValueFromText(attribute.value) ? 100 : 0) +
        (/\b(?:housing|front plate|body|enclosure)\b/i.test(`${attribute.group ?? ""} ${attribute.value}`) ? 20 : 0) +
        attributeEvidenceScore(attribute);
      return score(right) - score(left);
    })
    .map((attribute) => materialValueFromText(attribute.value))
    .find((value): value is string => Boolean(value));
}

function phoenixProductFinish(attributes: AttributeRecord[]): string | undefined {
  return attributes
    .filter((attribute) => /^material\s+front\s+plate$/i.test(attribute.name.trim()) || /^finish$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => finishPhraseFromText(attribute.value)?.replace(/[()]+$/g, "").trim())
    .find((value): value is string => Boolean(value));
}

function phoenixProductNetWeight(attributes: AttributeRecord[]): string | undefined {
  return attributes
    .filter((attribute) => /^weight per piece \(excluding packing\)$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeWeightValue(attribute.value))
    .find((value): value is string => Boolean(value));
}

function isPowerSupplyProduct(attributes: AttributeRecord[]): boolean {
  return attributes.some((attr) => {
    const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
    if (!/product|range|description|title|family|type|name/.test(label)) return false;
    return /\bpower suppl(?:y|ies)\b/i.test(`${attr.name} ${attr.value}`);
  });
}

export function isImplausiblyLowPowerSupplyWeight(attributes: AttributeRecord[], weight: string | undefined): boolean {
  if (!weight || !isPowerSupplyProduct(attributes)) return false;
  const ratedOutputPower = attributes
    .filter((attribute) => /^(?:power consumption|rated output power|output power|rated power)$/i.test(attribute.name.trim()))
    .map((attribute) => cleanText(attribute.value).match(/(\d+(?:[.,]\d+)?)\s*W\b/i)?.[1])
    .map((value) => value ? localizedNumber(value) : undefined)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (!ratedOutputPower.some((power) => power >= 20)) return false;
  const gramsText = cleanText(weight).match(/(\d+(?:[.,]\d+)?)\s*g\b/i)?.[1];
  const grams = gramsText
    ? Number(/\d,\d{3}$/.test(gramsText) ? gramsText.replace(/,/g, "") : gramsText.replace(",", "."))
    : undefined;
  // A manufacturer page can carry a unit/decimal typo for a physical attribute. A power supply
  // rated at 20 W or more cannot weigh under 10 g; keep that suspect value blank for review.
  return Boolean(grams !== undefined && grams < 10);
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

/**
 * ETA PDFs can place a locked-rotor protection ceiling beside the actual current range under a
 * generic "Rated current" label. Prefer ETA's explicitly labelled current-rating range so an
 * overload threshold (for example, 30 A) is not normalized as the device's rated current.
 */
function etaRatedCurrent(attributes: AttributeRecord[]): string | undefined {
  const exactDocumentRanges = attributes.filter((attribute) =>
    attribute.sourceType === "generated" &&
    attribute.parser === "pdf-table-extractor" &&
    attribute.matchLevel === "exact" &&
    /^feature$/i.test(attribute.name.trim()) &&
    /\b(?:rated\s+)?current\s+rating\s+range\b/i.test(attribute.value) &&
    /\d+(?:[.,]\d+)?\s*A?\s*(?:\.{2,3}|…|–|—|to)\s*\d+(?:[.,]\d+)?\s*A\b/i.test(attribute.value)
  );
  const supplyMaximums = attributes.filter((attribute) =>
    /^supply max\.? current rating$/i.test(attribute.name.trim()) &&
    isLikelySpecText(attribute.value) &&
    isAvailableSpecValue(attribute.value)
  );
  const totalLoadRatings = attributes.filter((attribute) =>
    /^current rating of load$/i.test(attribute.name.trim()) &&
    !/channel/i.test(attribute.name)
  );
  const labelledRatings = attributes.filter((attribute) =>
    /^(?:rated current|current rating|current ratings)(?:\s+per\s+channel)?$/i.test(attribute.name.trim()) &&
    !/^\s*(?:max(?:imum)?\.?\s*)/i.test(attribute.value) &&
    !/locked[-\s]?rotor|starting current|trip point|breaking capacity/i.test(`${attribute.name} ${attribute.value}`)
  );
  const explicitRanges = [
    ...labelledRatings.filter((attribute) => /\d+(?:[.,]\d+)?\s*A?\s*(?:\.\.|\.\.\.|–|—|to)\s*\d+(?:[.,]\d+)?\s*A\b/i.test(attribute.value)),
    ...exactDocumentRanges
  ];
  const patterns = normalizerFieldLabelPatterns("current");
  return bestNormalizedAttributeValue(totalLoadRatings, patterns, normalizeCurrentValue, "current") ??
    bestNormalizedAttributeValue(supplyMaximums, patterns, normalizeCurrentValue, "current") ??
    bestNormalizedAttributeValue(explicitRanges.filter((attribute) => !exactDocumentRanges.includes(attribute)), patterns, normalizeCurrentValue, "current") ??
    exactDocumentRanges.map((attribute) => {
      const range = attribute.value.match(/(\d+(?:[.,]\d+)?)\s*A?\s*(?:\.{2,3}|…|–|—|to)\s*(\d+(?:[.,]\d+)?)\s*A\b/i);
      return range ? normalizeCurrentValue(`${range[1]}...${range[2]} A`) : undefined;
    }).find((value): value is string => Boolean(value)) ??
    bestNormalizedAttributeValue(labelledRatings, patterns, normalizeCurrentValue, "current");
}

function etaExactPdpCurrent(attributes: AttributeRecord[]): string | undefined {
  const exactPageRatings = attributes.filter((attribute) =>
    attribute.sourceType === "official-fallback" &&
    /^ETA .+ product page$/i.test(attribute.parser ?? "") &&
    /^https:\/\/(?:www\.|global\.)?e-t-a\.com\/products\/.+\/p\/[^/]+\/?$/i.test(attribute.sourceUrl ?? "") &&
    /^(?:rated current|current rating(?: of load)?|current ratings?)$/i.test(attribute.name.trim()) &&
    !/channel/i.test(attribute.name)
  );
  return bestNormalizedAttributeValue(exactPageRatings, normalizerFieldLabelPatterns("current"), normalizeCurrentValue, "current");
}

/**
 * E-T-A datasheets sometimes call actual module draw "Power consumption I Typ.", while nearby
 * rows describe a different interface's maximum load current. Promote only the explicitly
 * typical current-consumption row so output/input load limits cannot become the device supply
 * current in the normalized record.
 */
function etaTypicalPowerConsumptionCurrent(attributes: AttributeRecord[]): string | undefined {
  const hasEtaProductPage = attributes.some((attribute) =>
    attribute.sourceType === "official-fallback" &&
    /^ETA .+ product page$/i.test(attribute.parser ?? "") &&
    /^https:\/\/(?:www\.)?e-t-a\.com\/products\/.+\/p\/[^/]+\/?$/i.test(attribute.sourceUrl ?? "")
  );
  if (!hasEtaProductPage) return undefined;

  for (const attribute of attributes) {
    if (!/^power consumption$/i.test(attribute.name.trim()) || attribute.matchLevel !== "exact") continue;
    if (!/^https:\/\/(?:www\.)?e-t-a\.com\/fileadmin\//i.test(attribute.sourceUrl ?? "")) continue;
    const match = attribute.value.match(/\bI\s+Typ\.?\s*(\d+(?:[.,]\d+)?)\s*(mA|A)\s+at\s+(?:DC\s*)?\d+(?:[.,]\d+)?\s*V\b/i);
    if (match) return normalizeCurrentValue(`${match[1]} ${match[2]}`);
  }
  return undefined;
}

/** Prefer EAI300's exact downloadable data-sheet range over the conflicting PDP temperature label. */
function etaEai300DatasheetTemperature(attributes: AttributeRecord[]): { min?: string; max?: string } | undefined {
  const exactRows = attributes.filter((attribute) =>
    attribute.sourceType === "generated" &&
    attribute.parser === "pdf-table-extractor" &&
    attribute.matchLevel === "exact" &&
    /^ambient temperature$/i.test(attribute.name.trim()) &&
    /\/D_EAI300_EN\.pdf$/i.test(attribute.sourceUrl ?? "")
  );
  return exactRows.length ? deriveOperatingTemperature(exactRows) : undefined;
}

function etaDimensionMatchesTerminalDesign(attributes: AttributeRecord[], dimensions: string | undefined): boolean {
  if (!dimensions) return false;
  const target = normalizeDimensionValue(dimensions);
  if (!target) return false;
  return attributes
    .filter((attribute) => /^terminal design$/i.test(attribute.name.trim()))
    .flatMap((attribute) => attribute.value.match(/\d+(?:[.,]\d+)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?){1,2}\s*(?:mm|cm|in(?:ches?)?\b)?/gi) ?? [])
    .some((candidate) => normalizeDimensionValue(candidate) === target);
}

/**
 * AC-15 is a table of paired operating points, not a single current.  A contact's 24 V AC-15
 * current is often several times its 690 V value, so selecting the first value (or the nearby
 * conventional thermal current) gives the wrong product rating.  Only promote an AC-15 value
 * when the product's published operational voltage names the same voltage; an unmatched table is
 * deliberately left to the ordinary ranking paths below.
 */
function voltageAlignedAc15Current(attributes: AttributeRecord[], normalizedVoltage: string | undefined): string | undefined {
  const ratedOperationalVoltages = attributes.flatMap((attr) => {
    const label = `${attr.group ?? ""} ${attr.name}`;
    if (!/\brated operational voltage\b/i.test(label)) return [];
    return voltageNumbers(attr.value);
  });
  const normalizedVoltages = voltageNumbers(normalizedVoltage ?? "");
  const voltageFromRatedField = ratedOperationalVoltages.filter((voltage) =>
    normalizedVoltages.some((normalized) => Math.abs(voltage - normalized) < 0.001)
  );
  const operatingVoltages = voltageFromRatedField.length > 0
    ? voltageFromRatedField
    : ratedOperationalVoltages.length > 0
      ? ratedOperationalVoltages
      : normalizedVoltages;
  if (operatingVoltages.length === 0) return undefined;

  const candidates = attributes
    .filter((attr) => /\brated (?:operational|operating) current\b[^|;]*\bAC[-\s]?15\b/i.test(`${attr.group ?? ""} ${attr.name}`))
    .flatMap((attr) => currentValuesPairedWithVoltage(attr.value, operatingVoltages).map((value) => ({
      value,
      score: attributeEvidenceScore(attr) + normalizedFieldLabelScore(attr, "current")
    })));
  return candidates.sort((left, right) => right.score - left.score)[0]?.value;
}

function voltageNumbersFollowingLabel(value: string, label: string): number[] {
  const matched = value.match(new RegExp(`\\b${label.replace(/\\s+/g, "\\\\s+")}\\b[^\\d]{0,30}((?:\\d+(?:[.,]\\d+)?\\s*(?:/|\\bor\\b|to|-)?\\s*)+)\\s*V\\b`, "i"));
  return matched ? voltageNumbers(matched[1]) : [];
}

function voltageNumbers(value: string): number[] {
  return [...value.matchAll(/\d+(?:[.,]\d+)?(?=\s*(?:V|VAC|VDC)\b)/gi)]
    .map((match) => localizedNumber(match[0]))
    .filter((number): number is number => Number.isFinite(number));
}

function currentValuesPairedWithVoltage(value: string, operatingVoltages: number[]): string[] {
  const pairs = value.matchAll(/(?:\(|\b)\s*((?:\d+(?:[.,]\d+)?\s*(?:\/|\bor\b|to|-)?\s*)+)V\s*\)?\s*([^;\n\r]*)/gi);
  const matches: string[] = [];
  for (const pair of pairs) {
    const pairedVoltages = voltageNumbers(`${pair[1]} V`);
    if (!pairedVoltages.some((voltage) => operatingVoltages.some((operatingVoltage) => Math.abs(voltage - operatingVoltage) < 0.001))) continue;
    const current = pair[2].match(/\b\d+(?:[.,]\d+)?\s*(?:mA|A|kA)\b/i)?.[0];
    const normalized = normalizeCurrentValue(current);
    if (normalized) matches.push(normalized);
  }
  return matches;
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
    if (/\bweight per piece \(excluding packing\)|\bexcluding (?:the )?(?:packing|packaging)\b|\bnet weight\b/.test(label)) return 150;
    if (/\bweight per piece \(including packing\)|\bincluding (?:the )?(?:packing|packaging)\b/.test(label)) return -60;
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
    // Current through an OSSD/safety output is a load rating, not the device's own consumption.
    if (/safe output|ossd|safety output/.test(label)) return -180;
    if (/inrush current|starting current|peak current/.test(label)) return -140;
    if (/max\.?\s*current/.test(label)) return 126;
    if (/minimum output current|discrete output current|relay output current/.test(label)) return 35;
    if (/rated output current|output current|nominal output current/.test(label)) return 130;
    if (/current consumption/.test(label)) return 105;
    if (/rated supply current|supply current|input current/.test(label)) return 70;
    if (/thermal protection adjustment range|line current|continuous output current|maximum transient current|\[(?:in|ie)\]\s+/.test(label)) return 125;
    if (/rated current\b|ampere rating\b|rated operational current\b/.test(label)) return 115;
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
function bestDimensionAxisAttribute(attributes: AttributeRecord[], axis: "height" | "width" | "depth" | "length", manufacturerId?: string): AttributeRecord | undefined {
  // PDF ontology mining can drop the "Package 1/2" prefix from headings and turn shipping
  // carton dimensions into plain Height/Width/Length rows. If the same datasheet has explicit
  // packing-unit rows, do not promote its unscoped ontology copies to product dimensions.
  const hasPackageDimensions = attributes.some((attr) => /\bpackage\s+\d+\s+(?:height|width|depth|length)\b/i.test(attr.name));
  // The same miner can copy a product's "Measuring length" into an unscoped "Length" row.
  // That is sensor range, not the physical length of the transducer.
  const hasMeasuringLength = attributes.some((attr) => /\bmeasuring\s+length\b/i.test(`${attr.group ?? ""} ${attr.name}`));
  const hasThreadLength = attributes.some((attr) => /\bthread\s+length\b/i.test(`${attr.group ?? ""} ${attr.name}`));
  return attributes
    .filter((attr) => {
      const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      if (manufacturerId === "schmersal" && (/protection field|connectable cable|\bcable\b|\bwire\b|sensor chain|\b(?:castor|roller)\b/.test(label) || /ontology spec text/i.test(attr.group ?? ""))) return false;
      if (hasMeasuringLength && /^length$/i.test(attr.name.trim()) && /pdf ontology spec miner/i.test(attr.group ?? "")) return false;
      if (hasThreadLength && /^length$/i.test(attr.name.trim()) && /pdf ontology spec miner/i.test(attr.group ?? "")) return false;
      if (manufacturerId === "schneider" && hasPackageDimensions && /pdf ontology spec miner/i.test(attr.group ?? "")) return false;
      if (manufacturerId === "schneider" && axis === "depth" && /\blength\b/.test(label) && !/(?:length\s*\/\s*depth|depth\s*\/\s*length)/.test(label)) return false;
      return dimensionAxisLabelScore(label, axis) > -100 && isLikelyDimensionAxisValue(attr.value) && isLikelySpecText(attr.value) && isAvailableSpecValue(attr.value);
    })
    .sort((left, right) => {
      const leftLabel = `${left.group ?? ""} ${left.name}`.toLowerCase();
      const rightLabel = `${right.group ?? ""} ${right.name}`.toLowerCase();
      const leftReceiverPriority = manufacturerId === "schmersal" && axis === "height" && /\breceiver\b/i.test(leftLabel) ? 1 : 0;
      const rightReceiverPriority = manufacturerId === "schmersal" && axis === "height" && /\breceiver\b/i.test(rightLabel) ? 1 : 0;
      const leftScore = attributeEvidenceScore(left) + dimensionAxisLabelScore(leftLabel, axis) + leftReceiverPriority;
      const rightScore = attributeEvidenceScore(right) + dimensionAxisLabelScore(rightLabel, axis) + rightReceiverPriority;
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
  return /^\d+(?:[.,]\d+)?(?:\s+\d+\/\d+)?\s*(?:mm|cm|m|in|inch|inches|")?(?:\s*\(\s*(?:\d+(?:[.,]\d+)?\s*)?(?:mm|cm|m|in|inch|inches|incl\.?|including|DIN rail|rail|")?[^)]*\))?(?:\s+installation)?$/i.test(cleaned);
}

function dimensionAxisLabelScore(label: string, axis: "height" | "width" | "depth" | "length"): number {
  if (
    /package|packing|packaging|thread(?:ed)? length|measuring length|length of cable|cable length|settle length|conductor|number of height units|height units|suitable for enclosure|wire stripping|stripping length|strip length|bus length|tap links length|cable distance|operating distance|communication distance|serial link|modbus|ethernet|segment|pulse width|time delay|recovery time|power on delay|response time|reset time|duration|control signal|signal pulse|connecting capacity|terminal|focal length|back focal|object distance|minimum object distance|angle of view|sensor size|lens|mount/.test(
      label
    )
  ) {
    return -200;
  }
  if (axis === "height") {
    if (/product\s+(?:net\s+)?height/.test(label)) return 140;
    if (/\bheight\b|\bh\u00f6he\b|\baltezza\b|wysoko\u015b\u0107|produkth\u00f6he/.test(label)) return 70;
  }
  if (axis === "width") {
    if (/product\s+(?:net\s+)?width/.test(label)) return 140;
    if (/\bwidth\b|\bbreite\b|\blarghezza\b|szeroko\u015b\u0107|produktbreite/.test(label)) return 70;
  }
  if (axis === "depth") {
    if (/product\s+(?:net\s+)?depth|product\s+(?:net\s+)?length\s*\/\s*depth/.test(label)) return 140;
    if (/\bdepth\b|\btiefe\b|\bprofond|d\u0142ugo\u015b\u0107\s*\/\s*g\u0142\u0119boko\u015b\u0107|produkt\s+l\u00e4nge\s*\/\s*tiefe/.test(label)) return 75;
    if (/\blength\b|\bl\u00e4nge\b/.test(label)) return 35;
  }
  if (axis === "length") {
    if (/product net .*length/.test(label)) return 140;
    if (/\blength\b|\bl\u00e4nge\b/.test(label)) return 70;
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
  return `Cable length ${original} (${convertDimensionTextToMillimeters(match[1].replace(",", "."), unit) ?? String(convertDimensionToMillimeters(number, unit))} mm)`;
}

function mergeNormalizedFields(
  computed: NormalizedProductFields,
  primary: NormalizedProductFields,
  fallback: NormalizedProductFields,
  attributes: AttributeRecord[],
  manufacturerId?: string
): NormalizedProductFields {
  const merged: NormalizedProductFields = { ...computed };
  const suppressPhoenixCurrent = manufacturerId === "phoenix" && isPhoenixSignalConditioner(attributes);
  const suppressDoepkeRurContactCurrent = manufacturerId === "doepke" && attributes.some((attribute) =>
    /^type code$/i.test(attribute.name.trim()) && /^RUR\s*3$/i.test(attribute.value.trim()) && /source\/prodext\.php/i.test(attribute.sourceUrl ?? "")
  );
  const suppressSchneiderLightCurtainCurrent = manufacturerId === "schneider" && isSchneiderSafetyLightCurtain(attributes);
  const suppressSchneiderM221OutputCurrent = manufacturerId === "schneider" && isSchneiderM221OutputCurrent(attributes);
  const suppressNventPassiveSchroffCurrent = manufacturerId === "nvent" &&
    attributes.some((attribute) => /^rack height$/i.test(attribute.name.trim())) &&
    attributes.some((attribute) => /^usable width$/i.test(attribute.name.trim()));
  const suppressNventSurgeCurrent = manufacturerId === "nvent" && attributes.some((attribute) =>
    attribute.parser === "nvent-direct" && /\bsurge protection\b/i.test(attribute.value) && /^(?:product type|product category|category|type)$/i.test(attribute.name.trim())
  );
  const suppressNventTerminalBlockMaterial = manufacturerId === "nvent" && attributes.some((attribute) =>
    attribute.parser === "nvent-direct" && /^rail four post terminal block\b/i.test(attribute.value) && /^(?:product type|product category|category|type)$/i.test(attribute.name.trim())
  );
  const nventProductMaterial = manufacturerId === "nvent"
    ? attributes.find((attribute) => attribute.parser === "nvent-direct" && /^material$/i.test(attribute.name.trim()))?.value
    : undefined;
  const nventSchroffFanTray = manufacturerId === "nvent" &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^product type$/i.test(attribute.name.trim()) && /^fan unit$/i.test(attribute.value.trim())) &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^input voltage ac$/i.test(attribute.name.trim()));
  const nventCaddyLoadRatingOnly = manufacturerId === "nvent" &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^(?:name|title)$/i.test(attribute.name.trim()) && /\bconduit clamp\b/i.test(attribute.value)) &&
    attributes.some((attribute) => attribute.parser === "nvent-direct" && /^ultimate static load\b/i.test(attribute.name.trim())) &&
    !attributes.some((attribute) => attribute.parser === "nvent-direct" && /^(?:net\s+)?weight$/i.test(attribute.name.trim()));
  const nventGroundingClamp = manufacturerId === "nvent" && attributes.some((attribute) =>
    attribute.parser === "nvent-direct" && /^(?:name|title)$/i.test(attribute.name.trim()) && /^multi-purpose grounding clamp\b/i.test(attribute.value)
  );
  const phoenixPreferredVoltage = manufacturerId === "phoenix" ? phoenixContactNormalizedVoltage(attributes) : undefined;
  const phoenixPreferredWeight = manufacturerId === "phoenix" ? phoenixProductNetWeight(attributes) : undefined;
  const phoenixPreferredCurrent = manufacturerId === "phoenix" && isPhoenixSurgeProtector(attributes)
    ? phoenixSurgeNominalDischargeCurrent(attributes)
    : undefined;
  if (phoenixPreferredVoltage) merged.voltage = phoenixPreferredVoltage;
  if (phoenixPreferredWeight) merged.weight = phoenixPreferredWeight;
  if (phoenixPreferredCurrent) merged.current = phoenixPreferredCurrent;
  else if (manufacturerId === "phoenix" && isPhoenixSurgeProtector(attributes)) delete merged.current;
  if (suppressPhoenixCurrent) delete merged.current;
  if (suppressSchneiderM221OutputCurrent) delete merged.current;
  if (suppressNventPassiveSchroffCurrent) delete merged.current;
  if (suppressNventSurgeCurrent) delete merged.current;
  if (suppressNventTerminalBlockMaterial) delete merged.material;
  if (nventCaddyLoadRatingOnly) delete merged.weight;
  if (nventSchroffFanTray) {
    delete merged.dimensions;
    if (nventProductMaterial) merged.material = nventProductMaterial;
  }
  if (nventGroundingClamp) {
    const length = attributes.find((attribute) => attribute.parser === "nvent-direct" && /^length(?:\s*\(l\))?$/i.test(attribute.name.trim()) && /\d+(?:[.,]\d+)?\s*mm\b/i.test(attribute.value))?.value.match(/\d+(?:[.,]\d+)?\s*mm\b/i)?.[0];
    const width = attributes.find((attribute) => attribute.parser === "nvent-direct" && /^width(?:\s*\(w\))?$/i.test(attribute.name.trim()) && /\d+(?:[.,]\d+)?\s*mm\b/i.test(attribute.value))?.value.match(/\d+(?:[.,]\d+)?\s*mm\b/i)?.[0];
    if (length && width) merged.dimensions = `L ${length} x W ${width}`;
    merged.finish = undefined;
    if (nventProductMaterial) merged.material = nventProductMaterial;
  } else if (nventProductMaterial && !suppressNventTerminalBlockMaterial) {
    merged.material = nventProductMaterial;
  }
  for (const field of Object.keys(computed) as Array<keyof NormalizedProductFields>) {
    if (merged[field]) continue;
    if (suppressDoepkeRurContactCurrent && field === "current") continue;
    if (suppressNventPassiveSchroffCurrent && field === "current") continue;
    if (suppressNventSurgeCurrent && field === "current") continue;
    if (suppressNventTerminalBlockMaterial && field === "material") continue;
    if (suppressPhoenixCurrent && field === "current") continue;
    if (suppressSchneiderM221OutputCurrent && field === "current") continue;
    if (suppressSchneiderLightCurtainCurrent && field === "current") continue;
    if (manufacturerId === "phoenix" && field === "current" && isPhoenixSurgeProtector(attributes)) continue;
    if (manufacturerId === "rittal" && field === "current" && !computed.current) continue;
    if (manufacturerId === "schmersal" && field === "wallThickness" && !attributes.some((attribute) => {
      const label = `${attribute.group ?? ""} ${attribute.name}`;
      return /\b(?:wall|housing|body)\s+thickness\b/i.test(label) && !/front\s+panel/i.test(label);
    })) continue;
    merged[field] = primary[field] ?? fallback[field];
  }

  for (const field of Object.keys(primary) as Array<keyof NormalizedProductFields>) {
    const primaryValue = primary[field];
    if (!primaryValue) continue;
    if (suppressDoepkeRurContactCurrent && field === "current") continue;
    if (suppressNventSurgeCurrent && field === "current") continue;
    if (suppressNventTerminalBlockMaterial && field === "material") continue;
    if (suppressPhoenixCurrent && field === "current") continue;
    if (suppressSchneiderLightCurtainCurrent && field === "current") continue;
    if (manufacturerId === "phoenix" && (
      (field === "weight" && phoenixPreferredWeight) ||
      (field === "voltage" && phoenixPreferredVoltage) ||
      (field === "current" && isPhoenixSurgeProtector(attributes)) ||
      ((field === "operatingTemperatureMin" || field === "operatingTemperatureMax" || field === "dimensions") && computed[field])
    )) continue;
    if (manufacturerId === "rittal" && field === "current" && !computed.current) continue;
    if (manufacturerId === "schmersal" && field === "wallThickness" && !attributes.some((attribute) => {
      const label = `${attribute.group ?? ""} ${attribute.name}`;
      return /\b(?:wall|housing|body)\s+thickness\b/i.test(label) && !/front\s+panel/i.test(label);
    })) continue;
    const computedValue = merged[field];
    if (!computedValue) {
      merged[field] = primaryValue;
      continue;
    }
    if (valueHasOfficialEvidence(attributes, primaryValue) && !valueHasOfficialEvidence(attributes, computedValue)) {
      merged[field] = primaryValue;
    }
  }

  if (nventCaddyLoadRatingOnly) delete merged.weight;
  if (nventSchroffFanTray) {
    delete merged.dimensions;
    if (nventProductMaterial) merged.material = nventProductMaterial;
  }
  if (nventGroundingClamp) {
    const length = attributes.find((attribute) => attribute.parser === "nvent-direct" && /^length(?:\s*\(l\))?$/i.test(attribute.name.trim()))?.value.match(/\d+(?:[.,]\d+)?\s*mm\b/i)?.[0];
    const width = attributes.find((attribute) => attribute.parser === "nvent-direct" && /^width(?:\s*\(w\))?$/i.test(attribute.name.trim()))?.value.match(/\d+(?:[.,]\d+)?\s*mm\b/i)?.[0];
    if (length && width) merged.dimensions = `L ${length} x W ${width}`;
    merged.finish = undefined;
    if (nventProductMaterial) merged.material = nventProductMaterial;
  } else if (nventProductMaterial && !suppressNventTerminalBlockMaterial) {
    merged.material = nventProductMaterial;
  }
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined && value !== "")) as NormalizedProductFields;
}

function isRittalCurrentEvidence(attr: AttributeRecord): boolean {
  const label = `${attr.group ?? ""} ${attr.name}`;
  if (!/\b(?:current|strom|amperage|amperes?|amps?)\b/i.test(label)) return false;
  // Rittal uses this source label for short-circuit withstand capacity; retain its raw evidence,
  // but do not claim it is the device's operating current.
  return !/\b\d[\d.,]*\s*kA\b/i.test(attr.value);
}

function rittalRatedCurrent(attributes: AttributeRecord[]): string | undefined {
  const primaryCurrent = attributes.find((attribute) => /^primary current$/i.test(attribute.name.trim()))?.value.match(/\d+(?:[.,]\d+)?\s*A\b/i)?.[0];
  const secondaryCurrent = attributes.find((attribute) => /^secondary current$/i.test(attribute.name.trim()))?.value.match(/\d+(?:[.,]\d+)?\s*A\b/i)?.[0];
  if (primaryCurrent && secondaryCurrent) return `${normalizeCurrentValue(primaryCurrent)} primary / ${normalizeCurrentValue(secondaryCurrent)} secondary`;
  const candidates = attributes.filter((attribute) => /^rated current(?:\s+max\.?)?$/i.test(attribute.name.trim()));
  const maximumRatings = candidates.filter((attribute) => /^rated current\s+max\.?$/i.test(attribute.name.trim()));
  const primaryRatings = maximumRatings.length ? maximumRatings : candidates;
  const values = [...new Set(primaryRatings.flatMap((attribute) =>
    // Adjacent Rittal definition-list values can flatten to `1.2 AAt 60 Hz: 1.4 A`.
    // Allow the next `A` to begin immediately after the unit so the first rating is retained.
    [...attribute.value.matchAll(/(\d+(?:[.,]\d+)?)\s*A(?=A|[^A-Za-z]|$)/gi)].map((match) => `${formatNumber(localizedNumber(match[1]))} A`)
  ))];
  return values.length ? values.join("; ") : undefined;
}

function rittalExplicitLabelValue<T>(
  attributes: AttributeRecord[],
  labelPattern: RegExp,
  normalize: (value: string) => T | undefined
): T | undefined {
  const candidates = attributes
    .filter((attribute) => labelPattern.test(attribute.name.trim()))
    .sort(compareAttributeEvidence);
  for (const attribute of candidates) {
    const value = normalize(attribute.value);
    if (value) return value;
  }
  return undefined;
}

function rittalMaterialValue(value: string): string | undefined {
  // The Rittal page parser flattens adjacent spec cells (for example, "PolyamideFire protection…"
  // or "Light body: AluminiumLight cover: Polycarbonate"). Preserve the named material parts,
  // restore their separators, and drop adjoining fire-protection/halogen notes that are separate
  // properties. Do not infer a material from a busbar description or a linked manual.
  const cleaned = (normalizeHtmlSpecValue(value) ?? "")
    .replace(/(?:Fire\s+protection\s+corresponding\s+to|Halogen[-\s]?free).*/i, "")
    .replace(/\bVolume\s*:\s*\d+(?:[.,]\d+)?\s*(?:l|L)\b.*$/i, "")
    .replace(/(Polyamide)(?=Polycarbonate)/gi, "$1; ")
    .replace(/(Polycarbonate)(?=E-Cu\b)/gi, "$1; ")
    .replace(/([^\s;])(?=(?:enclosure|door|mounting\s+plate|light\s+(?:body|cover|ends)|socket\s+inserts|front|seal)\s*:\s*)/gi, "$1; ")
    .trim();
  return cleaned || undefined;
}

function rittalSpecText(value: string): string | undefined {
  const cleaned = (normalizeHtmlSpecValue(value) ?? "")
    .replace(/([^\s;])(?=(?:enclosure|door|mounting\s+plate|light\s+(?:body|cover|ends)|front)\s*:\s*)/gi, "$1; ")
    .trim();
  return cleaned || undefined;
}

function rittalMultipleVoltageRanges(attributes: AttributeRecord[]): string | undefined {
  const candidates = attributes
    .filter((attr) => /voltage/i.test(attr.name) && /\b\d[\d.,]*\s*V\b/i.test(attr.value))
    .sort(compareAttributeEvidence);
  for (const candidate of candidates) {
    const modes = candidate.value.split(/\s*[|;]\s*/).filter((part) => /\b\d[\d.,]*\s*V\b/i.test(part));
    if (modes.length >= 2) return normalizeHtmlSpecValue(candidate.value);
  }
  return undefined;
}

function rittalProductDimensions(attributes: AttributeRecord[]): string | undefined {
  // Rittal's exact PDP product description labels dimensions as WHD. Use that exact variant row
  // instead of a cut-out, installation-depth, or mounting-panel axis that happens to match a
  // generic width/height/depth label elsewhere on the page.
  const descriptions = attributes
    .filter((attribute) =>
      attribute.parser === "rittal-order-resolver" &&
      attribute.sourceType === "official" &&
      /^product description$/i.test(attribute.name.trim())
    )
    .sort(compareAttributeEvidence);
  for (const attribute of descriptions) {
    const lengthHeightDepth = attribute.value.match(/\bLHD\s*:?\s*(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)(?:\s*mm)?\b/i);
    if (lengthHeightDepth) {
      // Rittal socket strips publish Length x Height x Depth (LHD), unlike most products' WHD.
      // Store the long axis in the normalized width slot and keep Height/Depth on their own axes.
      const normalizedLhd = normalizeDimensionValue(`${lengthHeightDepth[2]} x ${lengthHeightDepth[1]} x ${lengthHeightDepth[3]} mm`);
      if (normalizedLhd) return normalizedLhd;
    }
    const match = attribute.value.match(/\bWHD\s*:?\s*(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)(?:\s*mm)?\b/i);
    if (!match) continue;
    const preciseDepth = attributes.find((candidate) =>
      candidate.parser === "rittal-order-resolver" &&
      candidate.sourceType === "official" &&
      /^depth$/i.test(candidate.name.trim()) &&
      /\d+(?:[.,]\d+)?\s*mm\b/i.test(candidate.value)
    )?.value;
    // normalized dimensions are H x W x D; the source explicitly provides W x H x D.
    const normalized = normalizeDimensionValue(`${match[2]} x ${match[1]} x ${preciseDepth ?? `${match[3]} mm`}`);
    if (normalized) return normalized;
  }
  return undefined;
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
  const parsed = parts.map((part) => cleanText(part).match(/^(\d+(?:[.,]\d+)?)\s*(mm|cm|m|in|inch|inches|")?(?:\s*\([^)]*\))?(?:\s+installation)?$/i));
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
  if (unit === "g") return `${cleaned} (${multiplyDecimalExactly(match[1], "0.001")} kg)`;
  if (/^lb|pound/.test(unit)) return `${cleaned} (${multiplyDecimalExactly(match[1], "0.45359237")} kg)`;
  if (/^oz|ounce/.test(unit)) return `${cleaned} (${multiplyDecimalExactly(match[1], "0.028349523125")} kg)`;
  return cleaned;
}

function nventCopperBondedGroundRodDimensions(attributes: AttributeRecord[]): string | undefined {
  const actualDiameterAttributes = attributes.filter((attribute) =>
    attribute.parser === "nvent-direct" && /^ground rod diameter, actual/i.test(attribute.name.trim()) && /\d/.test(attribute.value)
  );
  const diameter = (actualDiameterAttributes.find((attribute) => /\bmm\b/i.test(attribute.value)) ?? actualDiameterAttributes[0])?.value;
  const length = attributes.find((attribute) =>
    attribute.parser === "nvent-direct" && /^length\b/i.test(attribute.name.trim()) && /\d/.test(attribute.value)
  )?.value;
  const toMillimeters = (value: string | undefined) => {
    const match = value?.match(/([\d.,]+)\s*(mm|cm|m|ft|feet|foot|in|inch|inches|′|')/i);
    if (!match) return undefined;
    const rawUnit = match[2].toLowerCase();
    const unit = /^(?:feet|foot|ft|′|')$/.test(rawUnit) ? "ft" : /^(?:in|inch|inches)$/.test(rawUnit) ? "in" : rawUnit;
    return convertDimensionTextToMillimeters(match[1], unit);
  };
  const diameterMm = toMillimeters(diameter);
  const lengthMm = toMillimeters(length);
  return diameterMm && lengthMm ? `D ${diameterMm} mm x L ${lengthMm} mm` : undefined;
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
  const sourceValues = [match[1], match[2], match[3]].filter((part): part is string => Boolean(part));
  const millimeters = sourceValues.map((part) => convertDimensionTextToMillimeters(part, unit));
  if (millimeters.some((value) => value === undefined)) return cleaned;
  return `${cleaned} (${millimeters.join(" x ")} mm)`;
}

function dimensionMeasurementCount(value: string): number {
  const primary = cleanText(value.split("(", 1)[0]);
  const parts = primary.split(/[x×*]/i).map((part) => part.trim());
  return parts.length > 1 && parts.every((part) => /\d/.test(part)) ? parts.length : 1;
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
  const millimeters = [...dimensionText.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:mm|cm|m|inches|inch|in|")\b/gi)]
    .map((part) => convertDimensionTextToMillimeters(part[1], firstUnit));
  if (millimeters.some((value) => value === undefined)) return dimensionText;
  return `${dimensionText} (${millimeters.join(" x ")} mm)`;
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
  value: string;
  unit?: string;
}

function parseLabeledDimensionParts(value: string): LabeledDimensionPart[] {
  const parts: LabeledDimensionPart[] = [];
  const beforeValue = /\b([HWDL])\s*(\d+(?:[.,]\d+)?)\s*(in|inch|inches|"|mm|cm|m|ft|feet|foot)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = beforeValue.exec(value))) {
    const number = normalizeNumberSeparators(match[2]);
    if (/^\d+(?:\.\d+)?$/.test(number)) parts.push({ label: match[1].toUpperCase() as LabeledDimensionPart["label"], value: number, unit: normalizeDimensionUnit(match[3]) });
  }
  if (parts.length >= 2) return parts;

  const afterValue = /\b(\d+(?:[.,]\d+)?)(?:\s*(in|inch|inches|"|mm|cm|m|ft|feet|foot))?\s*([HWDL])\b/gi;
  while ((match = afterValue.exec(value))) {
    const number = normalizeNumberSeparators(match[1]);
    if (/^\d+(?:\.\d+)?$/.test(number)) parts.push({ label: match[3].toUpperCase() as LabeledDimensionPart["label"], value: number, unit: normalizeDimensionUnit(match[2]) ?? "in" });
  }
  return parts;
}

function firstDimensionUnit(parts: LabeledDimensionPart[]): string | undefined {
  return parts.find((part) => part.unit)?.unit;
}

function formatLabeledMillimeters(parts: LabeledDimensionPart[], fallbackUnit: string): string {
  return parts
    .map((part) => {
      const unit = part.unit ?? fallbackUnit;
      const millimeters = convertDimensionTextToMillimeters(part.value, unit);
      return millimeters
        ? `${part.label} ${millimeters} mm`
        : `${part.label} ${part.value} ${unit}`;
    })
    .join(" x ");
}

function convertDimensionTextToMillimeters(value: string, unit: string): string | undefined {
  const factor = unit === "mm" ? "1" : unit === "cm" ? "10" : unit === "m" ? "1000" : unit === "ft" ? "304.8" : "25.4";
  return multiplyDecimalExactly(normalizeNumberSeparators(value), factor);
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
  const explicitRatingsText = value?.split(/\bUL\s*:/i)[0] ?? "";
  const containsVoltageRange = /\d+(?:[.,]\d+)?\s*(?:\.{2,3}|…|–|—|\bto\b)\s*(?:(?:AC|DC)\s*)?\d+(?:[.,]\d+)?/i.test(explicitRatingsText);
  if (!containsVoltageRange) {
    const explicitModeRatings = [...explicitRatingsText.matchAll(/\b(3\s*)?(AC|DC)\s*(\d+(?:[.,]\d+)?)\s*(kV|V)\b/gi)];
    if (explicitModeRatings.length > 1) {
      const values = [...new Set(explicitModeRatings.map((match) =>
        `${match[1] ? "3 " : ""}${match[2].toUpperCase()} ${match[3]} ${match[4]}`
      ))];
      return values.join(" / ");
    }
  }
  const pairedRating = value?.match(/^\s*(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(kV|V)\s*(AC|DC)\b/i);
  if (pairedRating) return `${pairedRating[1]}/${pairedRating[2]} ${pairedRating[3]} ${pairedRating[4].toUpperCase()}`;
  const cleaned = trimElectricalSegments(normalizeElectricalValue(value?.replace(/\s+setting range of the\b.*$/i, "")), /\b\d+(?:[.,]\d+)?\s*(?:\.\.\.\s*\d+(?:[.,]\d+)?\s*)?(?:kV|V)\b/i);
  if (!cleaned || !/\b\d+(?:[.,]\d+)?\s*(?:\.\.\.\s*\d+(?:[.,]\d+)?\s*)?(?:kV|V)\b/i.test(cleaned)) return undefined;
  const duplicateBounds = cleaned.match(/^(\d+(?:[.,]\d+)?\s*(?:kV|V)(?:\s*(?:AC|DC))?)\s*[-–]\s*(\d+(?:[.,]\d+)?\s*(?:kV|V)(?:\s*(?:AC|DC))?)$/i);
  if (duplicateBounds && duplicateBounds[1].replace(/\s+/g, "").toLowerCase() === duplicateBounds[2].replace(/\s+/g, "").toLowerCase()) {
    return cleanText(duplicateBounds[1]);
  }
  return cleaned;
}

/** Prefer Turck's explicitly admissible/supply range over generic headline voltage rows. */
function turckOperatingVoltage(attributes: AttributeRecord[]): string | undefined {
  const preferred = attributes
    .filter((attribute) => /^(?:admissible range|operating voltage ub)$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeVoltageValue(attribute.value))
    .find((value): value is string => Boolean(value));
  return preferred;
}

/**
 * Turck datasheets publish both device draw and output/load ratings. Prefer no-load or
 * consumption rows for sensor draw, the supply current range for TBEN modules, and retain a
 * pressure transmitter's rated switching-output current when that is the only rated current.
 */
function turckCurrent(attributes: AttributeRecord[]): string | undefined {
  const exactTurckSafetyRelayCurrent = attributes
    .filter((attribute) => attribute.parser === "turck-safety-solutions-catalog" && /^rated output current$/i.test(attribute.name.trim()) && attribute.matchLevel === "exact")
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeCurrentValue(attribute.value))
    .find((value): value is string => Boolean(value));
  if (exactTurckSafetyRelayCurrent) return exactTurckSafetyRelayCurrent;
  const preferredLabels = [/^no-load current$/i, /^current consumption$/i];
  for (const label of preferredLabels) {
    const value = attributes
      .filter((attribute) => label.test(attribute.name.trim()))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeCurrentValue(attribute.value))
      .find((candidate): candidate is string => Boolean(candidate));
    if (value) return value;
  }

  // Turck's exact EDB datasheets use the English and German labels for DC operating draw. It must
  // outrank values such as "Max. current safe output" and "Current output" from the same sheet.
  const ratedOperationalCurrent = attributes
    .filter((attribute) => /^(?:dc rated operational current|dc bemessungsbetriebsstrom)$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeCurrentValue(attribute.value))
    .find((candidate): candidate is string => Boolean(candidate));
  if (ratedOperationalCurrent) return ratedOperationalCurrent;

  const moduleOperatingCurrent = attributes
    .filter((attribute) => /^operating current$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => {
      const matches = [...attribute.value.matchAll(/(\d+(?:[.,]\d+)?)\s*mA\b/gi)];
      return matches.length >= 2
        ? normalizeCurrentValue(`${matches[0][1]}...${matches[1][1]} mA`)
        : undefined;
    })
    .find((candidate): candidate is string => Boolean(candidate));
  if (moduleOperatingCurrent) return moduleOperatingCurrent;

  const hasPressureSwitchOutput = attributes.some((attribute) =>
    /^electrical output$/i.test(attribute.name.trim()) && /switching output/i.test(attribute.value)
  );
  if (hasPressureSwitchOutput) {
    return attributes
      .filter((attribute) => /^rated operational current$/i.test(attribute.name.trim()))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeCurrentValue(attribute.value))
      .find((candidate): candidate is string => Boolean(candidate));
  }

  return undefined;
}

function phoenixContactNormalizedVoltage(attributes: AttributeRecord[]): string | undefined {
    const productText = attributes
    .filter((attribute) => /^(?:title|product type|product name|catalog description)$/i.test(attribute.name.trim()))
    .map((attribute) => attribute.value)
    .join(" ");
  const selectVoltage = (labels: RegExp) => attributes
    .filter((attribute) => labels.test(attribute.name.trim()) && !/^\s*(?:range\b|DC\s)/i.test(attribute.value))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeVoltageValue(attribute.value))
    .find((value): value is string => Boolean(value));
  if (/\b(?:safety switch sensor|safety sensor)\b/i.test(productText)) {
    const minimum = selectVoltage(/^operating voltage min$/i);
    const maximum = selectVoltage(/^operating voltage max$/i);
    if (minimum && maximum) return `${minimum}...${maximum}`;
  }
  if (/\bbattery\b/i.test(productText)) {
    const input = attributes
      .filter((attribute) => /^input voltage$/i.test(attribute.name.trim()) && attribute.parser === "Phoenix Contact product page")
      .sort(compareAttributeEvidence)
      .map((attribute) => {
        const firstVoltage = attribute.value.match(/^\s*(\d+(?:[.,]\d+)?\s*V\s*DC)\b/i)?.[1];
        return firstVoltage ? normalizeVoltageValue(firstVoltage) : undefined;
      })
      .find((value): value is string => Boolean(value)) ?? selectVoltage(/^battery nominal voltage$/i);
    const endOfCharge = selectVoltage(/^end-of-charge voltage$/i);
    if (input && endOfCharge) return `${input} nominal; ${endOfCharge} end-of-charge`;
  }
  if (/\bhybrid motor starter\b/i.test(productText)) {
    const control = selectVoltage(/^control circuit supply voltage$/i) ?? selectVoltage(/^rated control voltage$/i);
    const motor = selectVoltage(/^(?:operating voltage|rated operational voltage)$/i);
    if (control && motor) return `${control} control; ${motor} motor circuit`;
  }
  if (/\buninterruptible power supply\b/i.test(productText)) {
    const input = selectVoltage(/^input voltage$/i);
    const output = selectVoltage(/^output voltage$/i);
    const range = attributes
      .filter((attribute) => /^input voltage range$/i.test(attribute.name.trim()))
      .sort(compareAttributeEvidence)
      .map((attribute) => {
        const matches = [...attribute.value.matchAll(/(\d+(?:[.,]\d+)?)\s*V\s*(AC|DC)/gi)];
        const first = matches[0];
        const second = matches[1];
        return first?.[1] && first[2] && second?.[1] && second[2] && first[2].toUpperCase() === second[2].toUpperCase()
          ? normalizeVoltageValue(`${first[1]}...${second[1]} V ${first[2]}`)
          : undefined;
      })
      .find((value): value is string => Boolean(value));
    if (input && output) return `${input} input${range ? ` (range ${range})` : ""}; ${output} output`;
  }
  if (/\b(?:surge protective device|surge protection device)\b/i.test(productText)) {
    const nominal = attributes
      .filter((attribute) => /^nominal voltage$/i.test(attribute.name.trim()))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeVoltageValue(attribute.value))
      .find((value): value is string => Boolean(value));
    if (nominal) return nominal;
  }
  if (/\b(?:connector|plug|socket)\b/i.test(productText)) {
    const nominal = attributes
      .filter((attribute) => /^nominal voltage(?:\s+u[_ ]?n)?$/i.test(attribute.name.trim()))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeVoltageValue(attribute.value))
      .find((value): value is string => Boolean(value));
    const rated = attributes
      .filter((attribute) => /^rated voltage\s*\(\s*iii\s*\/\s*3\s*\)$/i.test(attribute.name.trim()))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeVoltageValue(attribute.value))
      .find((value): value is string => Boolean(value));
    if (nominal && rated) return `${nominal} nominal; ${rated} rated (III/3)`;
  }
  const supplyRange = attributes
    .filter((attribute) => /^supply voltage range$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => {
      const bounds = [...attribute.value.matchAll(/(\d+(?:[.,]\d+)?)\s*V\s*(AC|DC)\b/gi)];
      const first = bounds[0];
      const second = bounds[1];
      if (!first?.[1] || !first[2] || !second?.[1] || !second[2] || first[2].toUpperCase() !== second[2].toUpperCase()) return undefined;
      return normalizeVoltageValue(`${first[1]}...${second[1]} V ${first[2]}`);
    })
    .find((value): value is string => Boolean(value));
  if (supplyRange) {
    const nominalSupply = attributes
      .filter((attribute) => /^supply voltage$/i.test(attribute.name.trim()))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeVoltageValue(attribute.value))
      .find((value): value is string => Boolean(value));
    return nominalSupply ? `${nominalSupply} nominal; range ${supplyRange}` : supplyRange;
  }
  if (/\bTCP\s*1A\b/i.test(productText)) return "250 V AC / 65 V DC";
  if (/\bEEM-XM157\b/i.test(productText) || /\bPT\s*2,5-TWIN\s+RD\b/i.test(productText)) {
    const nominal = attributes
      .filter((attribute) => /^nominal voltage$/i.test(attribute.name.trim()))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeVoltageValue(attribute.value))
      .find((value): value is string => Boolean(value));
    if (nominal) return nominal;
  }
  // Phoenix's PSR-SPP product code UC identifies the 24 V universal-control-supply variants.
  // The exact product title and Article page here identify the model; the trailing 0...5 V row
  // is a signal interface and must never replace the supply rating.
  if (/\bPSR-SPP-\s*24UC\b/i.test(productText)) return "24 V DC";
  if (/\bPLC-RSC-\s*24DC\b/i.test(productText)) {
    const nominal = attributes
      .filter((attribute) => /^(?:nominal input voltage|nominal voltage)$/i.test(attribute.name.trim()))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeVoltageValue(attribute.value))
      .find((value): value is string => Boolean(value));
    if (nominal) return nominal;
  }
  if (/\bFL\s+SWITCH\s+1005N\b/i.test(productText)) {
    const range = attributes
      .filter((attribute) => /^supply voltage range$/i.test(attribute.name.trim()))
      .sort(compareAttributeEvidence)
      .map((attribute) => attribute.value)
      .find(Boolean);
    const values = range?.match(/\d+(?:[.,]\d+)?\s*V\s*(?:DC|AC)/gi) ?? [];
    const dc = values.filter((value) => /\bDC\b/i.test(value));
    const ac = values.filter((value) => /\bAC\b/i.test(value));
    const bounds = (pair: string[]) => pair.length >= 2
      ? `${pair[0].match(/[\d.,]+/)?.[0]}...${pair[1].match(/[\d.,]+/)?.[0]} V ${pair[0].match(/(?:DC|AC)$/i)?.[0]?.toUpperCase()}`
      : undefined;
    const dcRange = bounds(dc);
    const acRange = bounds(ac);
    if (dcRange || acRange) return [dcRange, acRange].filter(Boolean).join("; ");
  }
  return undefined;
}

function phoenixContactOperatingTemperature(attributes: AttributeRecord[]): { min?: string; max?: string } | undefined {
  const productText = attributes
    .filter((attribute) => /^(?:title|product type|product name|catalog description)$/i.test(attribute.name.trim()))
    .map((attribute) => attribute.value)
    .join(" ");
  if (!/\bbattery\b/i.test(productText)) return undefined;
  const dischargeRange = attributes.filter((attribute) =>
    /^ambient temperature$/i.test(attribute.name.trim()) && /-\s*20\s*°?\s*C\s*[/…-]+\s*60\s*°?\s*C/i.test(attribute.value)
  );
  return dischargeRange.length ? deriveOperatingTemperature(dischargeRange) : undefined;
}

function isPhoenixSurgeProtector(attributes: AttributeRecord[]): boolean {
  return attributes.some((attribute) =>
    /^(?:product type|title|product name)$/i.test(attribute.name.trim()) &&
    /\b(?:surge protective device|surge protection device)\b/i.test(attribute.value)
  );
}

function phoenixSurgeNominalDischargeCurrent(attributes: AttributeRecord[]): string | undefined {
  const value = attributes
    .filter((attribute) => /^nominal discharge current$/i.test(attribute.name.trim()))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeCurrentValue(attribute.value))
    .find((candidate): candidate is string => Boolean(candidate));
  return value ? `${value} (nominal discharge current)` : undefined;
}

function exactSchmersalPdpVoltage(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  const exactPageUrls = exactSchmersalPdpUrls(attributes, manufacturerId);
  if (exactPageUrls.size === 0) return undefined;
  const labels = [
    /^rated operating voltage$/i,
    /^operating voltage$/i,
    /^supply voltage$/i,
    /^rated control voltage$/i,
    /^control voltage$/i,
    /^rated voltage$/i,
    /^voltage,?\s*utili[sz]ation category ac-15$/i,
    /^utili[sz]ation category ac-15$/i,
    /^voltage rating$/i,
    /^bemessungsbetriebsspannung$/i
  ];
  for (const label of labels) {
    const values = [...new Set(attributes
      .filter((attribute) => label.test(attribute.name.trim()) && attribute.sourceUrl !== undefined && exactPageUrls.has(attribute.sourceUrl))
      .sort(compareAttributeEvidence)
      .map((attribute) => normalizeVoltageValue(attribute.value))
      .filter((candidate): candidate is string => Boolean(candidate)))];
    if (values.length) return values.join(" / ");
  }
  return undefined;
}

function exactEtaPdpVoltage(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eta") return undefined;
  const exactPageVoltage = attributes.filter((attribute) =>
    attribute.sourceType === "official-fallback" &&
    /^ETA .+ product page$/i.test(attribute.parser ?? "") &&
    /^https:\/\/(?:(?:www|global)\.)?e-t-a\.com\/products\/.+\/p\/[^/]+\/?$/i.test(attribute.sourceUrl ?? "") &&
    /^(?:rated operating voltage|operating voltage|supply voltage|rated voltage|voltage rating(?: of load)?)$/i.test(attribute.name.trim())
  );
  const ratedValues = bestNormalizedAttributeValue(
    exactPageVoltage.filter((attribute) => /^(?:rated voltage|voltage rating(?: of load)?)$/i.test(attribute.name.trim())),
    normalizerFieldLabelPatterns("voltage"),
    normalizeVoltageValue,
    "voltage"
  );
  return ratedValues ?? bestNormalizedAttributeValue(
    exactPageVoltage,
    normalizerFieldLabelPatterns("voltage"),
    normalizeVoltageValue,
    "voltage"
  );
}

function exactEtaEAI300DatasheetVoltage(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eta") return undefined;
  const exactDatasheetRatings = attributes.filter((attribute) =>
    attribute.sourceUrl === "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/int_Stromverteilung/ControlPlex_Rack/2_en/D_EAI300_EN.pdf" &&
    /^rated voltage range$/i.test(attribute.name.trim())
  );
  return bestNormalizedAttributeValue(
    exactDatasheetRatings,
    normalizerFieldLabelPatterns("voltage"),
    normalizeVoltageValue,
    "voltage"
  );
}

function exactEtaSCS1000DatasheetVoltage(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "eta") return undefined;
  const datasheetUrl = "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/int_Stromverteilung/Smart_Control_System_SCS/2_en/D_SCS1000_en.pdf";
  const exactModelRatings = attributes.filter((attribute) =>
    attribute.sourceType === "official-fallback" &&
    attribute.parser === "eta-family-datasheet-rule" &&
    attribute.sourceUrl === datasheetUrl &&
    /^rated voltage$/i.test(attribute.name.trim())
  );
  return bestNormalizedAttributeValue(
    exactModelRatings,
    normalizerFieldLabelPatterns("voltage"),
    normalizeVoltageValue,
    "voltage"
  );
}

function exactEtaPdpColor(attributes: AttributeRecord[]): string | undefined {
  const exactPageColors = attributes.filter((attribute) =>
    attribute.sourceType === "official-fallback" &&
    /^ETA .+ product page$/i.test(attribute.parser ?? "") &&
    /^https:\/\/global\.e-t-a\.com\/products\/.+\/p\/[^/]+\/?$/i.test(attribute.sourceUrl ?? "") &&
    /^(?:colou?r|housing colou?r|case colou?r)$/i.test(attribute.name.trim())
  );
  return findColorAttr(exactPageColors);
}

function exactSchmersalPdpFieldValue<T>(
  attributes: AttributeRecord[],
  label: RegExp,
  normalize: (value: string) => T | undefined
): T | undefined {
  const exactPageUrls = exactSchmersalPdpUrls(attributes, "schmersal");
  if (!exactPageUrls.size) return undefined;
  return attributes
    .filter((attribute) => label.test(attribute.name.trim()) && attribute.sourceUrl !== undefined && exactPageUrls.has(attribute.sourceUrl))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalize(attribute.value))
    .find((value): value is T => value !== undefined);
}

function exactSchmersalPdpProtection(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  const exactPageUrls = exactSchmersalPdpUrls(attributes, manufacturerId);
  if (exactPageUrls.size === 0) return undefined;
  const enclosureRating = attributes
    .filter((attribute) => /^ip degree of protection of the enclosure$/i.test(attribute.name.trim()) &&
      attribute.sourceUrl !== undefined && exactPageUrls.has(attribute.sourceUrl))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeProtectionValue(attribute.value))
    .find((value): value is string => Boolean(value));
  if (enclosureRating) return enclosureRating;
  const labeledRatings = attributes
    .filter((attribute) => /^(?:degree of protection|ip degree of protection)$/i.test(attribute.name.trim()) &&
      attribute.sourceUrl !== undefined && exactPageUrls.has(attribute.sourceUrl))
    .sort(compareAttributeEvidence)
    .map((attribute) => normalizeProtectionValue(attribute.value))
    .find((value): value is string => Boolean(value));
  return labeledRatings;
}

/** Keep a device's idle supply draw ahead of Schmersal safety-input/diagnostic currents. */
function exactSchmersalNoLoadSupplyCurrent(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  const exactPageUrls = exactSchmersalPdpUrls(attributes, manufacturerId);
  if (exactPageUrls.size === 0) return undefined;
  const exactCurrent = (label: RegExp): string | undefined => {
    const byValue = new Map<string, string>();
    for (const attribute of attributes
      .filter((candidate) => label.test(candidate.name.trim()) && candidate.sourceUrl !== undefined && exactPageUrls.has(candidate.sourceUrl))
      .sort(compareAttributeEvidence)) {
      const value = normalizeCurrentValue(attribute.value);
      if (!value) continue;
      // The page repeats equivalent specs with and without thousands separators and spaces.
      // Normalize only clear three-digit grouping commas so decimal-comma ratings stay intact.
      const key = value.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/\s+/g, "");
      if (!byValue.has(key)) byValue.set(key, value);
    }
    return byValue.size === 1 ? [...byValue.values()][0] : undefined;
  };

  // AC-15 is the primary switching rating for these contact devices. DC-13 remains available in
  // raw evidence when both categories are published. A single operating current is used for TQ;
  // safety light curtains expose separate emitter/receiver currents and must not be collapsed.
  return exactCurrent(/^(?:no-load supply current\b|current consumption\b|as-i current consumption\s*,?\s*maximum$)/i) ??
    exactCurrent(/^(?:utilisation category ac-15|strom,\s*gebrauchskategorie ac-15)$/i) ??
    exactCurrent(/^(?:operating current|rated operating current|bemessungsbetriebsstrom)$/i) ??
    exactCurrent(/^(?:current,\s*)?utilisation category dc-13$/i);
}

function exactSchmersalPdpUrls(attributes: AttributeRecord[], manufacturerId?: string): Set<string> {
  if (manufacturerId !== "schmersal") return new Set();
  return new Set(attributes
    .filter((attribute) => {
      if (!/^(?:article number(?:\s*\(\s*order number\s*\))?|catalog number)$/i.test(attribute.name.trim())) return false;
      const url = attribute.sourceUrl ?? "";
      // Exact identity on an exact official PDP is sufficient here; Schmersal's deterministic
      // identity repair uses its own parser name while preserving the same SKU-specific URL.
      if (!/^https:\/\/products\.schmersal\.com\//i.test(url)) return false;
      const itemNumber = new URL(url).pathname.match(/-(\d+)(?:\.html)?\/?$/i)?.[1];
      return Boolean(itemNumber && attribute.value.replace(/\D/g, "") === itemNumber);
    })
    .map((attribute) => attribute.sourceUrl)
    .filter((url): url is string => Boolean(url)));
}

function normalizeCurrentValue(value: string | undefined): string | undefined {
  if (value && /\|/.test(value) && /\bA-\d/i.test(value)) return undefined;
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
  return /\[(?:us|ue|uc)\]\s+rated|rated supply voltage|supply voltage|rated input voltage|input voltage|input power|power input|rated operational voltage|operational voltage|operating voltage|nominal input voltage|primary voltage|rated control circuit voltage|control circuit voltage|\brated voltage\b/.test(
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
  if (localizedNumber(minMatch[1]) === localizedNumber(maxMatch[1])) return min;
  return cleanText(`${minMatch[1]}...${maxMatch[1]} ${maxUnit || minUnit}`);
}

function deriveVoltageFromText(attributes: AttributeRecord[]): string | undefined {
  return bestDerivedElectricalValue(attributes, extractVoltageValues, (attribute) =>
    isElectricalTextCandidate(attribute) && !isDisqualifiedForQuantityKind(`${attribute.group ?? ""} ${attribute.name}`, attribute.value, "voltage")
  );
}

function deriveCurrentFromText(attributes: AttributeRecord[]): string | undefined {
  return bestDerivedElectricalValue(attributes, extractCurrentValues, isCurrentTextCandidate);
}

function schneiderContactorAc3Current(attributes: AttributeRecord[]): string | undefined {
  const isSchneiderRecord = attributes.some((attr) => /\bschneider\b/i.test(attr.group ?? ""));
  const isContactor = isSchneiderRecord && attributes.some((attr) =>
    /^(?:product or component type|product type)$/i.test(attr.name.trim()) && /\bcontactor\b/i.test(attr.value)
  );
  if (!isContactor) return undefined;
  for (const attr of attributes) {
    if (!/\bschneider\b/i.test(attr.group ?? "")) continue;
    const text = `${attr.name} ${attr.value}`;
    if (!/\bAC-3(?:e)?\b/i.test(text)) continue;
    const current = text.match(/\b(\d+(?:[.,]\d+)?)\s*A\b[^.;|]{0,70}\bAC-3(?:e)?\b/i)?.[1];
    if (current) return normalizeCurrentValue(`${current} A`);
  }
  return undefined;
}

function abbContactorAc3Current(attributes: AttributeRecord[], manufacturerId?: string): string | undefined {
  if (manufacturerId !== "abb") return undefined;
  const exactPdp = new Set(attributes
    .filter((attribute) => /^product id$/i.test(attribute.name.trim()) &&
      attribute.parser === "abb-product-model" && attribute.sourceType === "official")
    .map((attribute) => attribute.sourceUrl)
    .filter((url): url is string => Boolean(url && /^https:\/\/new\.abb\.com\/products\//i.test(url))));
  if (exactPdp.size === 0) return undefined;
  const exactContactor = attributes.some((attribute) =>
    /^(?:catalog description|display name|extended product type|product type|product category)$/i.test(attribute.name.trim()) &&
    /\bcontactor\b/i.test(attribute.value) && attribute.parser === "abb-product-model" && Boolean(attribute.sourceUrl && exactPdp.has(attribute.sourceUrl))
  );
  if (!exactContactor) return undefined;
  for (const attribute of attributes) {
    if (!/^rated operational current AC-3$/i.test(attribute.name.trim()) ||
      attribute.parser !== "abb-product-model" || attribute.sourceType !== "official" || !attribute.sourceUrl || !exactPdp.has(attribute.sourceUrl)) continue;
    const at400V = attribute.value.match(/\(\s*(?:380\s*\/\s*)?400\s*V\s*\)[^;]{0,90}?\b(\d+(?:[.,]\d+)?)\s*A\b/i);
    if (at400V) return normalizeCurrentValue(`${at400V[1]} A`);
  }
  return undefined;
}

/** Prefer explicitly stated product ratings in official descriptions/spec strings over generic
 * PDF-mined values that can describe an analog input, relay output, or a sibling variant. */
function explicitRatedCurrentFromText(attributes: AttributeRecord[]): string | undefined {
  const candidates: Array<{ value: string; score: number }> = [];
  for (const attr of attributes) {
    const text = derivedSpecText(attr);
    const matches = text.matchAll(/(?<![\w.-])\d+(?:[.,]\d+)?\s*(?:(?:\.{2,3}|\u2026|\u2013|\u2014|\-|to)\s*\d+(?:[.,]\d+)?\s*)?(?:kA|mA|A|amps?|amperes?)\b(?![a-z0-9-])/gi);
    for (const match of matches) {
      const start = match.index ?? 0;
      const context = text.slice(Math.max(0, start - 100), Math.min(text.length, start + match[0].length + 45));
      if (!/\b(?:rated|nominal|operational|continuous)\b[^.;|]{0,65}\bcurrent\b|\bcurrent\b[^.;|]{0,65}\b(?:rated|nominal|operational|continuous)\b/i.test(context)) continue;
      if (/\b(?:current consumption|inrush|starting|peak|relay output|analog(?:ue)? input|discrete output|switching current|coil current)\b/i.test(context)) continue;
      const value = normalizeCurrentValue(match[0]);
      if (!value) continue;
      const label = `${attr.group ?? ""} ${attr.name}`;
      const score = attributeEvidenceScore(attr) + 250 + (/\b(?:rated operational current|rated output current|nominal output current)\b|\[ie\]/i.test(label) ? 1000 : 0) + (attr.scope === "variant" ? 120 : 0);
      candidates.push({ value, score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score)[0]?.value;
}

function explicitRatedVoltageFromText(attributes: AttributeRecord[]): string | undefined {
  const labeledRatings = attributes
    .filter((attr) => isPrimaryVoltageLabel(`${attr.group ?? ""} ${attr.name}`) &&
      !isDisqualifiedForQuantityKind(`${attr.group ?? ""} ${attr.name}`, attr.value, "voltage"))
    .map((attr) => ({ value: normalizeVoltageValue(attr.value), label: `${attr.group ?? ""} ${attr.name}`, score: attributeEvidenceScore(attr) + (attr.scope === "variant" ? 120 : 0) }))
    .filter((candidate): candidate is { value: string; label: string; score: number } => Boolean(candidate.value))
    .sort((left, right) => right.score - left.score);
  const primaryRatings = labeledRatings.filter((candidate) => !/\b(?:control circuit|control supply|control voltage)\b/i.test(candidate.label));
  // The main product input/supply rating outranks its separate control voltage.
  const supplyRatings = primaryRatings.filter((candidate) => /\b(?:supply voltage|input voltage|primary voltage|operational voltage|operating voltage)\b/i.test(candidate.label));
  const selectedRatings = supplyRatings.length ? supplyRatings : primaryRatings.length ? primaryRatings : labeledRatings;
  if (selectedRatings[0]) return selectedRatings[0].value;
  const candidates: Array<{ value: string; score: number }> = [];
  for (const attr of attributes) {
    const text = derivedSpecText(attr);
    const matches = text.matchAll(/(?<![\w.])\d+(?:[.,]\d+)?\s*(?:(?:\.{2,3}|\u2026|\u2013|\u2014|\-|to)\s*\d+(?:[.,]\d+)?\s*)?(?:kV|V|volts?)\b(?:\s*(?:AC|DC))?/gi);
    for (const match of matches) {
      const start = match.index ?? 0;
      const context = text.slice(Math.max(0, start - 100), Math.min(text.length, start + match[0].length + 45));
      if (!/\b(?:rated|nominal|operational|supply)\b[^.;|]{0,65}\bvoltage\b|\bvoltage\b[^.;|]{0,65}\b(?:rated|nominal|operational|supply)\b/i.test(context)) continue;
      if (/\b(?:insulation|impulse|withstand|voltage drop|analog(?:ue)? input|relay output|control circuit)\b/i.test(context)) continue;
      const value = normalizeVoltageValue(match[0]);
      if (!value) continue;
      const label = `${attr.group ?? ""} ${attr.name}`;
      // A label-keyed rating from a product datasheet beats a prose sentence in the
      // product description. Both may be accurate, but the table value preserves the
      // full operating range and should survive later text-derived 380 V candidates.
      const score = attributeEvidenceScore(attr) + 250 + (/\b(?:rated supply voltage|rated operational voltage|input voltage)\b/i.test(label) ? 1000 : 0) + (attr.scope === "variant" ? 120 : 0);
      candidates.push({ value, score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score)[0]?.value;
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

function schneiderDescriptionDimensions(attributes: AttributeRecord[]): string | undefined {
  for (const attr of attributes) {
    if (!/\bschneider\b/i.test(attr.group ?? "") || !/^description$/i.test(attr.name.trim())) continue;
    const value = cleanText(attr.value);
    const width = value.match(/\b(\d+(?:[.,]\d+)?)\s*(mm|cm|in|inch|inches)\s*(?:wide|in width)\b/i);
    const height = value.match(/\b(\d+(?:[.,]\d+)?)\s*(mm|cm|in|inch|inches)\s*(?:high|in height)\b/i);
    const depth = value.match(/\b(\d+(?:[.,]\d+)?)\s*(mm|cm|in|inch|inches)\s*(?:deep|in depth)\b/i);
    if (width && height && depth && width[2].toLowerCase() === height[2].toLowerCase() && width[2].toLowerCase() === depth[2].toLowerCase()) {
      return normalizeDimensionValue(`${height[1]} x ${width[1]} x ${depth[1]} ${height[2]}`);
    }
  }
  return undefined;
}

function schneiderDescriptionWeight(attributes: AttributeRecord[]): string | undefined {
  for (const attr of attributes) {
    if (!/\bschneider\b/i.test(attr.group ?? "") || !/^description$/i.test(attr.name.trim())) continue;
    const match = cleanText(attr.value).match(/\bweighs\s+(\d+(?:[.,]\d+)?)\s*(kg|g|lb|lbs)\b/i);
    if (match) return normalizeWeightValue(`${match[1]} ${match[2]}`);
  }
  return undefined;
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
  extractor: (value: string, label: string) => string[],
  isCandidate: (attr: AttributeRecord) => boolean = isElectricalTextCandidate
): string | undefined {
  const candidates = attributes
    .filter(isCandidate)
    .flatMap((attr) => {
      const label = `${attr.group ?? ""} ${attr.name}`;
      return extractor(derivedSpecText(attr), label).map((value) => ({
        value,
        score: attributeEvidenceScore(attr) + electricalTextLabelScore(label) + electricalValueSpecificityScore(value)
      }));
    });
  return candidates.sort((left, right) => right.score - left.score)[0]?.value;
}

/**
 * Current is often published only in a product's long description.  The generic electrical-text
 * allow-list predates that pattern and names individual manufacturers, so keep its established
 * cases and add a cross-vendor path only for an explicitly product-shaped description with a
 * rating context.  A bare `25 A` in prose is deliberately insufficient: it may be a component,
 * accessory, or transient figure rather than the product's own rated current.
 */
function isCurrentTextCandidate(attr: AttributeRecord): boolean {
  const label = `${attr.group ?? ""} ${attr.name}`;
  const text = derivedSpecText(attr);
  // Certification codes such as "UL 508A" and stock numbers such as "SP039010-0019A"
  // contain digit-plus-A tokens that look like amperage after unit normalization. They are
  // not operating-current evidence, even when PDF extraction places them in a generic feature row.
  if (/^\s*(?:UL|CSA|IEC|IEEE|EN|NEMA)\s*[\d.-]+[A-Z0-9./ -]*$/i.test(text) ||
      /^\s*[A-Z]{2,}\d{4,}(?:-[A-Z0-9]+)*\s*$/i.test(text)) return false;
  if (isElectricalTextCandidate(attr)) return true;
  if (!isGenericProductDescriptionLabel(label) || !isLikelySpecText(text) || !isAvailableSpecValue(text)) return false;
  // Descriptions which only state a fault/surge capability must never become the normal rated
  // current.  This mirrors the structured-attribute guard, but must inspect the prose itself.
  if (/\b(?:short-?circuit|breaking capacity|(?:nominal )?discharge current|(?:lightning )?impulse current|inrush current|starting current|peak current)\b/i.test(text)) {
    return false;
  }

  return extractCurrentValues(text, label).some((value) => hasRatedCurrentDescriptionContext(text, value));
}

function isGenericProductDescriptionLabel(label: string): boolean {
  if (/\b(plain text|script|style|console|image|url|document|download|certificate|approval|standard|classification|eclass|etim|unspsc)\b/i.test(label)) {
    return false;
  }
  return /\b(?:product |catalog |item |short |long |technical )?(?:description|name|title|type|summary|overview|details?)\b/i.test(label);
}

function hasRatedCurrentDescriptionContext(text: string, value: string): boolean {
  const index = text.toLowerCase().indexOf(value.toLowerCase());
  if (index < 0) return false;
  const nearby = text.slice(Math.max(0, index - 180), Math.min(text.length, index + value.length + 100));
  // IEC utilization categories (e.g. "25 A (AC-1)") and explicit rating words are direct
  // evidence.  The device vocabulary covers common descriptions such as contactors that state
  // "25 A general use" without spelling out "rated current" next to the number.
  return /\b(?:rated|nominal|operational|continuous|thermal|utili[sz]ation|general use|ac-[1-4]|dc-[1-5])\b/i.test(nearby) ||
    /\b(?:contactor|contactor relay|circuit breaker|fuse(?:holder)?|motor starter|overload relay|power supply|drive|transformer|switch(?:-| )?disconnector|switchgear|relay|thermostat)\b/i.test(nearby);
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

/**
 * SCE's window-kit page lists carbon-steel and stainless-steel variants together. The requested
 * catalog suffix selects which construction applies; treating the Stainless Steel sentence as the
 * material for every SKU incorrectly labels the standard NF kit as stainless.
 */
function sceWindowKitMaterial(attributes: AttributeRecord[]): string | undefined {
  const partNumber = attributes.find((attribute) =>
    /^part number$/i.test(attribute.name) && /^https:\/\/(?:www\.)?saginawcontrol\.com\/partnumber_info\//i.test(attribute.sourceUrl ?? "")
  )?.value.trim();
  if (!partNumber || !/^SCE-PWK\w*$/i.test(partNumber)) return undefined;
  const variantText = attributes
    .filter((attribute) => /^application$/i.test(attribute.name) && /^https:\/\/(?:www\.)?saginawcontrol\.com\/partnumber_info\//i.test(attribute.sourceUrl ?? ""))
    .map((attribute) => attribute.value)
    .join(" ");
  if (!/carbon steel kit/i.test(variantText) || !/stainless steel kits?/i.test(variantText)) return undefined;
  if (/SS6$/i.test(partNumber)) return "stainless steel Type 316";
  if (/SS$/i.test(partNumber)) return "stainless steel Type 304";
  return "carbon steel";
}

function schneiderPrimaryMaterial(attributes: AttributeRecord[]): string | undefined {
  // Schneider PDFs include connector, terminal, wire, and environmental-composition materials
  // alongside product specs. Those are not the material of the requested device. Keep only an
  // exact product material row or a clearly scoped body/housing/enclosure/case material row.
  const primary = attributes.filter((attr) => {
    const name = cleanText(attr.name).toLowerCase();
    const group = cleanText(attr.group ?? "").toLowerCase();
    if (/certificate|compliance|declaration|environment|substance|packaging|terminal|contact|wire|cable|connector|accessor/i.test(`${group} ${name}`)) return false;
    return name === "material" || /\b(?:housing|enclosure|body|case) material\b/.test(name);
  });
  return findMaterialAttr(primary) ?? deriveMaterialFromAttributes(primary);
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
        !/\b(?:led|indicator|signall?ing|ring manager|transmitter|receiver)\b/i.test(`${haystack} ${attr.value}`) &&
        Boolean(deriveColorFromFinish(attr.value)) &&
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
  if (unit === "cm") return `${formatNumber(number)} cm (${convertDimensionTextToMillimeters(match[1], "cm")} mm)`;
  return `${match[1]} in (${convertDimensionTextToMillimeters(match[1], "in")} mm)`;
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

/**
 * A DIN/ISO thread-TOLERANCE standard explains its own scope by contrasting steel/metal threads
 * against plastic ones ("without steel or metallic thread insert", "metric steel / metal threads
 * specified in this catalog are based on these tolerance fields") — that names which thread TYPE the
 * tolerance table covers, not this specific product's construction. Confirmed live: Ganter's shared
 * "Metric ISO Thread DIN 13" reference document names no catalog number anywhere in its text (it is
 * a generic bolt/nut tolerance-field appendix attached to many product pages, steel and plastic ones
 * alike), yet its "Feature" prose let `materialValueFromText`'s bare keyword scan for "steel" invent
 * `material = steel` for whichever catalog the document happened to be attached to.
 */
function isGenericThreadToleranceStandardText(value: string | undefined): boolean {
  const cleaned = normalizeHtmlSpecValue(value);
  if (!cleaned) return false;
  if (!/\btolerances?\b/i.test(cleaned) || !/\bthreads?\b/i.test(cleaned)) return false;
  return /\bwithout\s+steel\s+or\s+metallic\s+thread\s+insert\b/i.test(cleaned) || /\bsteel\s*\/\s*metal\s+threads?\b/i.test(cleaned);
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
  if (isGenericThreadToleranceStandardText(cleaned)) return undefined;
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
  // Phoenix Contact and other IEC datasheets use compact glass-fibre polymer codes such as PA-GF.
  // Preserve the exact material designation instead of dropping it as an unknown bare token.
  if (/^(?:PA|PBT|PC|POM)(?:[-\s]?GF(?:\s*\d{1,2})?)$/iu.test(cleaned)) return cleaned;
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
    if (!isRecognisedCertificateToken(canonical)) continue;
    const compact = compactCertificateToken(canonical);
    if (!canonical || seen.has(compact)) continue;
    seen.add(compact);
    unique.push(canonical);
  }
  return unique;
}

/**
 * Names of certification marks, standards bodies and standard families. A token has to carry one of
 * these to read as a certificate to a person; "SVHC compliance certificate" and "II declaration for
 * Power Supplies" describe paperwork and carry none.
 */
const CERTIFICATE_MARK_PATTERN =
  /\b(?:IEC|EN|ISO|DIN|VDE|JIS|GB|NEC|NEMA|UL|cUL|cULus|cURus|c-?UL-?us|CSA|CE|CCC|CQC|UKCA|ATEX|IECEx|GOST|EAC|RCM|KCC|KC|PSE|SEMKO|FCC|FM|T(?:Ü|U)V|DNV|Lloyds?|BV|ABS|RINA|ClassNK|KR|NK|ODVA|WEEE|RoHS|REACH|TSCA|Prop\s*65|Morocco|CMim|EMC|LVD|ANATEL|C-?Tick|Class\s+I+\s+Div)\b/i;

/**
 * Document names the project treats as real published entries even though they name no mark. These
 * are exact, curated shapes — anything looser lets declaration prose back in.
 */
const CERTIFICATE_KNOWN_DOCUMENT =
  /^(?:(?:[\w-]+\s+)?declaration\s+of\s+conformity\b.*|[\w-]+\s+compliance\s+declaration|environmental\s+disclosure|circularity\s+profile|end\s+of\s+life\s+information|full\s+material\s+disclosure)$/i;

/** Words that only ever appear mid-sentence — their presence proves the token is prose. */
const CERTIFICATE_PROSE_CONNECTOR = /\b(?:that|which|there|except|because|however|listed\s+in)\b/i;

/**
 * Gate for the DERIVED certificates path (the literal, vendor-curated list is never filtered).
 *
 * Needed because `fieldMatchesLabel` matches on `group + name`, so every attribute mined out of a
 * RoHS/REACH declaration PDF — group "PDF certificate" — qualified as a certificate no matter what
 * its name was. That filled the exported Certificates column with things nobody would call a
 * certificate: "(w/w)", "declaration", "II declaration", "compliance certificate", "CERTIFICATE
 * Revision No", "SVHC compliance certificate", and a whole clause, "Declaration of Conformity - CE:
 * 3ADR980151, except for some part types listed in Table 1 that". Filtering each way prose can
 * arrive is whack-a-mole, so the token has to earn its place here, at the boundary.
 *
 * The bar is the one a person applies: name a mark, a standards body or a standard — or be one of
 * the curated document names the catalogues really do publish.
 */
function isRecognisedCertificateToken(value: string): boolean {
  const cleaned = cleanText(value);
  if (!cleaned) return false;
  if (CERTIFICATE_PROSE_CONNECTOR.test(cleaned)) return false;
  // A sentence that happens to quote a mark is still a sentence.
  if (cleaned.split(/\s+/).length > 8) return false;
  if (CERTIFICATE_KNOWN_DOCUMENT.test(cleaned)) return true;
  return CERTIFICATE_MARK_PATTERN.test(cleaned);
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
  return String(value);
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
