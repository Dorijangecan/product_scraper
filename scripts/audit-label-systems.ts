/**
 * Reports DRIFT between the two label systems the scraper maintains.
 *
 * `FIELD_REGISTRY` (16 shipped fields, hand-written English-first regexes) decides which extracted
 * attribute lands in which exported column. `PROPERTY_ONTOLOGY` (98 canonical properties, EN/DE/FR/IT/ES/NL)
 * decides whether an attribute is admitted at all. They were built separately and nothing keeps them in
 * agreement — which is P1.2 in docs/COLD-START-PLAN.md, and this script is its detector.
 *
 * The four checks, in order of how much a hit costs:
 *
 *  A. UNADMITTED REGISTRY LABEL — a label the registry knows how to route, but the ontology does not
 *     recognise. This is the expensive one: the ontology is now consulted FIRST (it is the admission gate),
 *     so such a label is dropped before the registry ever sees it. Real data lost, silently.
 *
 *  B. UNROUTED ONTOLOGY PROPERTY — a property the ontology understands but no registry field can carry.
 *     Informational, not a defect: most of the 98 properties are extra attributes by design, and only a
 *     handful map to exported columns.
 *
 *  C. UNIT-KIND DISAGREEMENT — a label that a registry field claims, where the ontology says the value is
 *     a DIFFERENT physical quantity. This is the automated form of the kA/Ui misattribution guard, which
 *     five separate assignment paths in `normalizer.ts` used to spell out by hand, twice over, because the
 *     registry paths and the ontology paths name their fields differently. That is now one function keyed
 *     on the quantity kind (`isDisqualifiedForQuantityKind`); this section watches for the disagreement
 *     that would make it fire on the wrong field.
 *
 *  D. NON-SPEC CONTEXT COLLISION — see the comment on NON_SPEC_CONTEXT below.
 *
 * Reads nothing but the two modules — no network, no database, runs in milliseconds. Wired into
 * `npm run audit:pdt`; also available on its own as `npm run audit:labels`.
 */
import {
  FIELD_REGISTRY,
  fieldMatchesLabel,
  listFieldRegistryDocumentLabels,
  registryFieldQuantityKind,
  type RegistryFieldKey
} from "../src/server/scrapers/field-registry.js";
import { matchProperty, PROPERTY_ONTOLOGY } from "../src/server/scrapers/ontology.js";
import type { QuantityKind } from "../src/server/scrapers/quantity.js";

/**
 * The physical quantity each shipped field carries, read from the registry itself rather than restated
 * here. This script used to keep its own copy of the map — which would have made it a THIRD label system,
 * the exact failure it exists to detect.
 */
const REGISTRY_FIELD_KIND = new Map<RegistryFieldKey, QuantityKind>(
  FIELD_REGISTRY.flatMap((field) => {
    const kind = registryFieldQuantityKind(field.key);
    return kind ? [[field.key, kind] as [RegistryFieldKey, QuantityKind]] : [];
  })
);

/**
 * Labels whose ontology miss is understood and accepted, with the reason. Anything NOT in here that shows
 * up in section A is drift that must be either fixed or justified — same contract as
 * `REVIEWED_ACCEPTABLE_DROPS` in `audit-spec-plausibility.ts`.
 */
const REVIEWED_UNADMITTED: Record<string, string> = {
  "Product image": "A resource, not a specification. The ontology describes properties; images are routed by the registry alone.",
  "Datasheet URL": "Same — a document link, not a property.",
  "Manual URL": "Same — a document link, not a property.",
  // The four size labels below are a genuine ontology gap, not a lost value: `isUsefulSpecLabel` treats the
  // ontology as an ADDITIONAL admission path, and the parser was measured end-to-end to admit all four
  // (`Dimensions`, `Size`, `Overall/External dimensions` all reach `normalized.dimensions`). Adding an
  // aggregate `dimensions` property to the ontology is the tidy fix; it is not urgent, because nothing is
  // being dropped today. Recorded rather than guessed at.
  Dimensions: "Ontology has width/height/depth but no aggregate property; the parser admits it anyway (measured).",
  "Overall dimensions": "Same as Dimensions.",
  "External dimensions": "Same as Dimensions.",
  Size: "Same as Dimensions.",
  Gauge: "Sheet-metal gauge; the registry routes it to wallThickness and the parser was measured to admit it.",
  Finishing: "Admitted through the registry alias /finish(?:ing)?/ and the English keyword list; ontology synonym is /\\bfinish\\b/, which 'Finishing' does not match.",
  Protection: "matchProperty declines bare 'Protection' since the P1.1b precision pass, but the parser admits it and routes it correctly (measured)."
};

/**
 * Section C/D findings that have been reviewed and are NOT defects, with the reason. Anything else in those
 * sections is unexplained drift.
 */
const REVIEWED_CONFLICTS: Record<string, string> = {
  "Power input":
    "Genuinely ambiguous: vendors label a supply as 'Power input' with either a wattage or a voltage. Measured end-to-end, the runtime already resolves it by the VALUE's unit — `Power input 24 W` yields nothing (correct silence) and `Power input 24 V DC` yields voltage. Kept visible rather than deleted, because the registry alias is only safe as long as that downstream unit check exists, and making that guarantee structural is the point of P1.2.",
  Certifications:
    "This is our own group name for attributes that really do hold certificates, so matching the `certificates` property is correct behaviour, not a collision."
};

interface Finding {
  label: string;
  detail: string;
}

const unadmitted: Finding[] = [];
const accepted: Finding[] = [];

for (const label of listFieldRegistryDocumentLabels()) {
  if (matchProperty(label)) continue;
  const owners = FIELD_REGISTRY.filter((field) => fieldMatchesLabel(field.key, label)).map((field) => field.key);
  const finding = { label, detail: owners.length > 0 ? `routes to ${owners.join(", ")}` : "no registry field claims it either" };
  (REVIEWED_UNADMITTED[label] ? accepted : unadmitted).push(finding);
}

const unrouted: Finding[] = [];
for (const property of PROPERTY_ONTOLOGY) {
  const owners = FIELD_REGISTRY.filter((field) => fieldMatchesLabel(field.key, property.label)).map((field) => field.key);
  if (owners.length === 0) unrouted.push({ label: property.label, detail: `ontology key ${property.key}` });
}

// Walks the REAL routing path — the label as a vendor writes it, through `matchProperty`, the same call
// the admission gate makes — rather than comparing the two modules' own English labels to each other. An
// earlier version of this check compared `property.label` only and reported zero conflicts, which said
// more about the check than about the code.
const kindConflicts: Finding[] = [];
for (const [key, expected] of REGISTRY_FIELD_KIND) {
  for (const label of listFieldRegistryDocumentLabels()) {
    if (!fieldMatchesLabel(key, label)) continue;
    const property = matchProperty(label);
    if (!property?.unitKind || property.unitKind === expected) continue;
    kindConflicts.push({
      label,
      detail: `registry field "${key}" (${expected}) claims it, ontology types it as ${property.unitKind} (${property.key})`
    });
  }
}

/**
 * Text that is NOT vendor specification vocabulary: the group names this codebase invents itself, plus the
 * page furniture every vendor site carries. An ontology synonym that fires on any of these mislabels data
 * on every page that has such a block.
 *
 * This section exists because of a real hit: the French synonym for finish, `/finition/i`, was unanchored,
 * so it matched the ENGLISH word "de-finition" — and "Definition List" is the group name the generic parser
 * gives every `<dl>` spec block. Every page with specs in a `<dl>` was therefore assigning that block's
 * first value to the shipped `finish` column. Anchoring the synonym fixed it; this check keeps the class
 * from coming back through some other language's synonym.
 */
const NON_SPEC_CONTEXT = [
  "Definition List",
  "Product Specifications",
  "Structured Data",
  "Plain Text",
  "Plain Text Specs",
  "Ontology Spec Text",
  "Electrical Text",
  "Certifications",
  "Meta",
  "Table",
  "Documentation",
  "Downloads",
  "Overview",
  "Description",
  "Features",
  "Benefits",
  "Applications",
  "Related products",
  "Accessories",
  "Spare parts",
  "Breadcrumb",
  "Navigation",
  "Search results",
  "Newsletter",
  "Contact",
  "Cookie settings"
];

const contextCollisions: Finding[] = [];
for (const context of NON_SPEC_CONTEXT) {
  const property = matchProperty(context);
  if (property) {
    contextCollisions.push({ label: context, detail: `matches ontology "${property.key}" — every page with this block mislabels data` });
  }
}

function section(title: string, findings: Finding[], severity: "defect" | "info"): void {
  const marker = findings.length === 0 ? "clean" : severity === "defect" ? "MUST EXPLAIN" : "info";
  console.log(`\n=== ${title} — ${findings.length} (${marker}) ===`);
  for (const finding of findings.slice(0, 60)) console.log(`  ${finding.label.padEnd(34)} ${finding.detail}`);
  if (findings.length > 60) console.log(`  … ${findings.length - 60} more`);
}

console.log(`Comparing ${FIELD_REGISTRY.length} registry fields against ${PROPERTY_ONTOLOGY.length} ontology properties.`);
section("A. Registry labels the ontology does not admit", unadmitted, "defect");
if (accepted.length > 0) section("A2. Reviewed and accepted misses", accepted, "info");
section("B. Ontology properties no registry field can carry", unrouted, "info");
/**
 * Where the two systems disagree about a CONCRETE label: the registry routes it to a shipped field, the
 * ontology resolves it to a property that field is not supposed to carry.
 *
 * `ontologyKeys` on each registry entry is what makes this answerable — see its comment in
 * `field-registry.ts`. Every string both systems know is tried: the registry's own document labels and the
 * ontology's 98 property labels. Using real strings rather than comparing the two modules' regexes to each
 * other is what caught `Power input`; comparing English labels module-to-module had reported nothing.
 */
const routeDisagreements: Finding[] = [];
const everyKnownLabel = [...new Set([...listFieldRegistryDocumentLabels(), ...PROPERTY_ONTOLOGY.map((p) => p.label)])];
for (const field of FIELD_REGISTRY) {
  if (!field.ontologyKeys) continue;
  for (const label of everyKnownLabel) {
    if (!fieldMatchesLabel(field.key, label)) continue;
    const property = matchProperty(label);
    if (!property || field.ontologyKeys.includes(property.key)) continue;
    routeDisagreements.push({
      label,
      detail: `registry sends it to "${field.key}" (expects ${field.ontologyKeys.join("/")}), ontology reads it as "${property.key}"`
    });
  }
}

const unexplainedConflicts = kindConflicts.filter((finding) => !REVIEWED_CONFLICTS[finding.label]);
const unexplainedCollisions = contextCollisions.filter((finding) => !REVIEWED_CONFLICTS[finding.label]);
section("C. Unit-kind disagreements", unexplainedConflicts, "defect");
section("D. Ontology synonyms firing on our own group names / page furniture", unexplainedCollisions, "defect");
section("E. Concrete labels the two systems route differently", routeDisagreements, "info");
console.log(
  `\nreviewed and accepted: ${accepted.length} label(s) in A, ` +
    `${kindConflicts.length - unexplainedConflicts.length} in C, ${contextCollisions.length - unexplainedCollisions.length} in D`
);

const defects = unadmitted.length + unexplainedConflicts.length + unexplainedCollisions.length;
console.log(`\n${defects === 0 ? "OK" : `${defects} finding(s) needing a decision`}`);
process.exitCode = 0; // Reporting only until section A is empty; see the header note.
