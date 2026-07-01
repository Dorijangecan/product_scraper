import { uniqueStrings as uniqueStringsBase } from "../text-util.js";
import type { ScrapeRecipeConfig } from "../../shared/types.js";

const TECHNICAL_TERMS = [
  "Technical data",
  "Technical Data",
  "Technical details",
  "Technische Daten",
  "Technische Details",
  "Specifications",
  "Specification",
  "Specifikationen",
  "Full specifications",
  "Characteristics",
  "Parameters",
  "Parameter",
  "Merkmale",
  "Kenngrößen",
  "Kenngroessen",
  "Eigenschaften",
  "Product details",
  "Product Details",
  "Produktdetails",
  "Details",
  "More details",
  "Mehr Details",
  "Electrical data",
  "Elektrische Daten",
  "Mechanical data",
  "Mechanische Daten",
  "Environmental",
  "Classifications",
  "Klassifizierungen",
  "Approvals",
  "Zulassungen",
  "Certificates",
  "Zertifikate",
  "Datasheet",
  "Data sheet",
  "Datenblatt",
  "Datenblätter",
  "Downloads",
  "Download",
  "Herunterladen",
  "Documents",
  "Dokumente",
  "Dokumentation",
  "Resources",
  "CAD",
  "Drawings",
  "Zeichnungen",
  "Media",
  "Images",
  "Show more",
  "Show More",
  "Mehr anzeigen",
  "Weitere Informationen",
  "Weitere",
  "All details",
  "Alle anzeigen",
  "View all",
  "View more",
  "Read more"
];

export function adaptiveInteractionSelectors(recipe: ScrapeRecipeConfig | undefined): string[] {
  const configured = [
    ...(recipe?.interactionPolicy?.tabSelectors ?? []),
    ...(recipe?.interactionPolicy?.downloadSectionSelectors ?? []),
    ...(recipe?.interactionPolicy?.expandSelectors ?? []),
    ...(recipe?.expandSelectors ?? [])
  ];
  const semantic = TECHNICAL_TERMS.flatMap((term) => selectorsForTerm(term));
  return uniqueStrings([...configured, ...semantic]);
}

function selectorsForTerm(term: string): string[] {
  const escaped = term.replace(/'/g, "\\'");
  return [
    `button:has-text('${escaped}')`,
    `a:has-text('${escaped}')`,
    `[role='button']:has-text('${escaped}')`,
    `[role='tab']:has-text('${escaped}')`,
    `summary:has-text('${escaped}')`,
    `[aria-label*='${escaped}' i]`,
    `[title*='${escaped}' i]`
  ];
}

function uniqueStrings(values: string[]): string[] {
  return uniqueStringsBase(values, { normalize: "trim" });
}
