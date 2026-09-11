/**
 * The vendor's OTHER name for the same product (COLD-START-PLAN §6.2, P4.8 and P4.9).
 *
 * The deepest reason a vendor's own search fails is not a broken endpoint — it is that we ask with
 * the ordering code (`1SVR405611R1000`) while their index is built on the type designation
 * (`CT-MFD.21`), or the reverse. Today a failed search ends the item. But every confirmed product page
 * prints both names, and usually a GTIN too, so the translation is free to collect the moment one
 * item succeeds — and a real run is 150 catalog numbers from ONE manufacturer, so an alias learned on
 * the third item is paid back on the remaining 147. It is the only part of P4 that amortises inside a
 * single run.
 *
 * The hard rule, and the reason `identityLevel` exists: a type designation is frequently one-to-MANY
 * (one type, many ordering codes). Such an alias may be used to ASK the vendor a question. It may
 * never be used to conclude that a fetched page is the requested product — that stays with
 * `scoreFetchedDiscoveryEvidence`, which demands an exact match on a product identity surface.
 */
import type { ProductAliasRecord, ProductResult } from "../../shared/types.js";
import { compactCatalogNumber } from "./catalog-number.js";
import { identityAttributeLabelStrength } from "./product-identity.js";

export interface ProductAliasStore {
  list: (manufacturerId: string, catalogNumber: string, limit?: number) => ProductAliasRecord[];
  upsert: (alias: Omit<ProductAliasRecord, "id" | "confirmedAt">) => void;
}

const GTIN_LABEL = /\b(?:ean|gtin|upc|barcode)\b/i;
/** A type designation narrows to a family far more often than to one product. */
const FAMILY_PRONE_LABEL = /\b(?:type\s*designation|product\s*type|model\s*code|extended\s*product\s*type|baureihe|typ)\b/i;

/** 8, 12, 13 or 14 digits — the only lengths GS1 actually issues. */
function looksLikeGtin(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, "");
  return /^\d+$/.test(digits) && [8, 12, 13, 14].includes(digits.length);
}

/**
 * Read every second name a confirmed product page printed.
 *
 * Only called for a page that already passed the quality gate for THIS catalog number, so the page's
 * identity is not in question — the only judgement left is how tightly each alias narrows.
 */
export function harvestProductAliases(
  result: ProductResult,
  manufacturerId: string,
  catalogNumber: string,
  provenanceUrl: string
): Array<Omit<ProductAliasRecord, "id" | "confirmedAt">> {
  const aliases = new Map<string, Omit<ProductAliasRecord, "id" | "confirmedAt">>();
  const requested = compactCatalogNumber(catalogNumber);
  for (const attribute of result.attributes ?? []) {
    const label = `${attribute.group ?? ""} ${attribute.name}`;
    const value = (attribute.value ?? "").trim();
    // A value carrying several codes is a family listing, not this product's second name.
    if (!value || value.length > 60 || /[;,]/.test(value)) continue;
    const compact = compactCatalogNumber(value);
    // The catalog number restated under a different label teaches nothing.
    if (!compact || compact.length < 4 || compact === requested) continue;

    if (GTIN_LABEL.test(label)) {
      if (!looksLikeGtin(value)) continue;
      aliases.set(`gtin:${compact}`, {
        manufacturerId,
        catalogNumber,
        aliasKind: "gtin",
        aliasValue: value.replace(/[^0-9]/g, ""),
        // A GTIN is issued per trade item: when it is present it is the single most precise key a
        // vendor search accepts, and it is never a family.
        identityLevel: "exact",
        provenanceUrl
      });
      continue;
    }

    const strength = identityAttributeLabelStrength(label);
    if (!strength) continue;
    const familyProne = strength === "weak" || FAMILY_PRONE_LABEL.test(label);
    aliases.set(`id:${compact}`, {
      manufacturerId,
      catalogNumber,
      aliasKind: familyProne ? "type-designation" : "order-code",
      aliasValue: value,
      identityLevel: familyProne ? "family" : "exact",
      provenanceUrl
    });
  }
  return [...aliases.values()];
}

/**
 * Alias terms worth typing into the vendor's search, most precise first.
 *
 * GTIN leads because a vendor search that accepts one answers with exactly one product; the
 * family-level type designation goes last and stays labelled, so the caller can score it below an
 * exact answer exactly as it does for a family-prefix query (P4.6).
 */
export function aliasSearchTerms(aliases: ProductAliasRecord[]): Array<{ term: string; level: "exact" | "family"; reason: string }> {
  const ranked = [...aliases].sort((left, right) => aliasRank(left) - aliasRank(right));
  const seen = new Set<string>();
  const terms: Array<{ term: string; level: "exact" | "family"; reason: string }> = [];
  for (const alias of ranked) {
    const key = compactCatalogNumber(alias.aliasValue);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    terms.push({
      term: alias.aliasValue,
      level: alias.identityLevel,
      reason: `learned ${alias.aliasKind} from ${alias.provenanceUrl}`
    });
  }
  return terms;
}

function aliasRank(alias: ProductAliasRecord): number {
  if (alias.aliasKind === "gtin") return 0;
  if (alias.aliasKind === "vendor-product-id") return 1;
  if (alias.aliasKind === "order-code") return 2;
  return 3;
}
