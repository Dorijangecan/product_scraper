import { PDT_ONTOLOGY_FACT_KEYS, PDT_ONTOLOGY_QUANTITY_FACT_KEYS } from "../src/server/pdt/facts.js";
import { PROPERTY_ONTOLOGY } from "../src/server/scrapers/ontology.js";

const SPECIAL_QUANTITY_COVERAGE: Record<string, string> = {
  controlVoltage: "Promoted to ratedVoltage by addOntologyAttributeFacts.",
  ratedVoltage: "Promoted to ratedVoltage by addOntologyAttributeFacts and normalized voltage facts.",
  ratedCurrent: "Promoted to ratedCurrent by addOntologyAttributeFacts and normalized current facts.",
  weight: "Promoted from result.normalized.weight and ontology fact label coverage.",
  width: "Covered by normalized dimensions and device-tab dimension resolvers.",
  height: "Covered by normalized dimensions and device-tab dimension resolvers.",
  depth: "Covered by normalized dimensions and device-tab dimension resolvers.",
  diameter: "Covered by normalized dimensions, signal diameter, and device-tab diameter resolvers."
};

const failures: string[] = [];
const unitOntology = PROPERTY_ONTOLOGY.filter((property) => property.unitKind);

for (const property of unitOntology) {
  const factKeys = PDT_ONTOLOGY_FACT_KEYS[property.key];
  if (!factKeys?.length) {
    failures.push(`${property.key}: unitKind=${property.unitKind} has no PDT ontology fact labels`);
    continue;
  }

  const quantityFact = PDT_ONTOLOGY_QUANTITY_FACT_KEYS[property.key];
  const specialCoverage = SPECIAL_QUANTITY_COVERAGE[property.key];
  if (!quantityFact && !specialCoverage) {
    failures.push(`${property.key}: unitKind=${property.unitKind} has no quantity fact path or documented special coverage`);
    continue;
  }

  if (quantityFact && !factKeys.includes(quantityFact)) {
    failures.push(`${property.key}: quantity fact "${quantityFact}" is not listed in PDT_ONTOLOGY_FACT_KEYS`);
  }
}

for (const key of Object.keys(SPECIAL_QUANTITY_COVERAGE)) {
  const property = PROPERTY_ONTOLOGY.find((candidate) => candidate.key === key);
  if (!property?.unitKind) failures.push(`${key}: special quantity coverage references a missing/non-quantity ontology key`);
  if (!PDT_ONTOLOGY_FACT_KEYS[key]?.length) failures.push(`${key}: special quantity coverage has no PDT fact label mapping`);
}

console.log("=== PDT ontology fact audit ===");
if (failures.length > 0) {
  console.error("PDT ontology fact audit failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`  (clean - ${unitOntology.length} quantity ontology keys have PDT fact coverage)`);
}
