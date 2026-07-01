import type { ManufacturerConfig, ProductResult } from "../../shared/types.js";
import { catalogTextMatches, sameCatalogNumber } from "./catalog-number.js";

export interface ProductIdentityConflict {
  catalogNumber: string;
  mismatches: Array<{ label: string; value: string }>;
}

const STRONG_IDENTITY_LABEL =
  /\b(?:sku|mpn|mlfb|catalog(?:ue)?\s*(?:number|no\.?)|product\s*id|productid|manufacturer\s*part\s*number|part\s*(?:number|no\.?)|article\s*(?:number|no\.?)|item\s*(?:number|no\.?)|order\s*(?:code|number|no\.?)|global commercial alias)\b/i;

const WEAK_IDENTITY_LABEL =
  /\b(?:model code|type designation|extended product type|product type)\b/i;

export function identityAttributeLabelStrength(label: string): "strong" | "weak" | undefined {
  if (/\b(?:ean|gtin|upc|barcode)\b/i.test(label)) return undefined;
  if (STRONG_IDENTITY_LABEL.test(label)) return "strong";
  if (WEAK_IDENTITY_LABEL.test(label)) return "weak";
  return undefined;
}

export function hasMatchingStructuredIdentity(
  result: ProductResult,
  catalogNumber: string,
  manufacturer: ManufacturerConfig
): boolean {
  return result.attributes.some((attr) => {
    const label = `${attr.group ?? ""} ${attr.name}`;
    const strength = identityAttributeLabelStrength(label);
    if (!strength) return false;
    return identityValueMatches(attr.value, catalogNumber, manufacturer, strength);
  });
}

export function structuredIdentityConflict(
  result: ProductResult,
  catalogNumber: string,
  manufacturer: ManufacturerConfig
): ProductIdentityConflict | undefined {
  const mismatches = result.attributes
    .filter((attr) => identityAttributeLabelStrength(`${attr.group ?? ""} ${attr.name}`) === "strong")
    .filter((attr) => isUsableIdentityValue(attr.value))
    .filter((attr) => !isInternalNumericArticleOrOrderValue(attr, catalogNumber))
    .filter((attr) => !catalogTextMatches(attr.value, catalogNumber, identityMatchPolicy(manufacturer)))
    .map((attr) => ({ label: [attr.group, attr.name].filter(Boolean).join(" / "), value: attr.value }));
  if (!mismatches.length) return undefined;

  const hasMatch = result.attributes.some((attr) => {
    const label = `${attr.group ?? ""} ${attr.name}`;
    const strength = identityAttributeLabelStrength(label);
    if (!identityStrengthCanResolveConflict(strength)) return false;
    return identityValueMatches(attr.value, catalogNumber, manufacturer, strength);
  });
  return hasMatch ? undefined : { catalogNumber, mismatches: mismatches.slice(0, 6) };
}

export function identityConflictReason(conflict: ProductIdentityConflict): string {
  return `Structured product identity conflicts with requested catalog ${conflict.catalogNumber}: ${conflict.mismatches
    .map((item) => `${item.label}=${item.value}`)
    .join("; ")}`;
}

function identityMatchPolicy(manufacturer: ManufacturerConfig) {
  return {
    compact: true,
    afterColon: true,
    ignoreCase: true,
    ...manufacturer.match
  };
}

function identityValueMatches(
  value: string,
  catalogNumber: string,
  manufacturer: ManufacturerConfig,
  strength: "strong" | "weak"
): boolean {
  const policy = identityMatchPolicy(manufacturer);
  if (strength === "weak") return sameCatalogNumber(value, catalogNumber, policy);
  return catalogTextMatches(value, catalogNumber, policy);
}

function identityStrengthCanResolveConflict(strength: "strong" | "weak" | undefined): strength is "strong" | "weak" {
  return strength === "strong" || strength === "weak";
}

function isUsableIdentityValue(value: string | undefined): value is string {
  if (!value) return false;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean || /^(?:n\/a|na|none|null|not available|not applicable|-+)$/i.test(clean)) return false;
  if (/^`?(?:product\s*number|productnumber|article\s*number|articlenumber|catalog\s*number|catalognumber)`?[,]?$/i.test(clean)) return false;
  return /[a-z0-9]{3,}/i.test(clean);
}

function isInternalNumericArticleOrOrderValue(
  attr: ProductResult["attributes"][number],
  catalogNumber: string
): boolean {
  const label = `${attr.group ?? ""} ${attr.name}`;
  const value = attr.value.replace(/\s+/g, "").trim();
  if (!/^\d{6,10}$/.test(value)) return false;

  const requested = catalogNumber.replace(/[^a-z0-9]+/gi, "");
  if (!/[a-z]/i.test(requested) || /^\d{6,10}$/.test(requested)) return false;
  if (requested.includes(value) || value.includes(requested)) return false;

  if (/\b(?:catalog(?:ue)?\s*(?:number|no\.?)|sku|mpn|manufacturer\s*part\s*number|part\s*(?:number|no\.?))\b/i.test(label)) {
    return false;
  }

  return /\b(?:article\s*(?:number|no\.?)|artnr|order\s*(?:code|number|no\.?)|item\s*(?:number|no\.?))\b/i.test(label);
}
