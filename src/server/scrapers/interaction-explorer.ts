import type { PageMiningRecord, ScrapeRecipeConfig } from "../../shared/types.js";

const TECHNICAL_TERMS = [
  "Technical data",
  "Technical Data",
  "Technische Daten",
  "Specifications",
  "Specification",
  "Specifikationen",
  "Characteristics",
  "Product details",
  "Product Details",
  "Details",
  "Electrical data",
  "Mechanical data",
  "Environmental",
  "Classifications",
  "Klassifizierungen",
  "Approvals",
  "Certificates",
  "Downloads",
  "Documents",
  "Resources",
  "CAD",
  "Drawings",
  "Media",
  "Images",
  "Show more",
  "Show More",
  "All details",
  "View all"
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

export function interactionYieldUseful(before: PageMiningRecord | undefined, after: PageMiningRecord): boolean {
  if (!before) return after.attributeCount > 0 || after.documentCount > 0;
  return after.attributeCount > before.attributeCount || after.documentCount > before.documentCount;
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
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
