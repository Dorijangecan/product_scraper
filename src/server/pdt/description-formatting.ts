import { collapseWhitespaceOrUndefined as clean } from "../text-util.js";


export function isDecorativeAssetText(value: string | undefined): boolean {
  return /(?:^|\s)\.cls-\d+\s*\{|[{;]\s*fill\s*:\s*#[0-9a-f]{3,6}\b|_AB_Logo\b|\bAB_Logo\b|\bsvg\b/i.test(value ?? "");
}

export function cleanProductDescription(value: string | undefined, catalogNumber?: string): string | undefined {
  const cleaned = clean(value);
  if (!cleaned || isDecorativeAssetText(cleaned)) return undefined;
  if (catalogNumber && comparableDescriptionText(cleaned) === comparableDescriptionText(catalogNumber)) return undefined;
  return cleaned;
}

export function compactFamilyShortDescription(value: string | undefined): string | undefined {
  const cleaned = clean(value);
  if (!cleaned) return undefined;
  const withoutFamily = cleaned.replace(/^Compact\s+5000\s+/i, "").trim();
  const compacted = withoutFamily
    .replace(/\bDC\s+Input\b/i, "DC-Input")
    .replace(/\bDC\s+Output\b/i, "DC-Output");
  return compacted !== cleaned ? compacted : undefined;
}

function comparableDescriptionText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
