import type {
  ManufacturerConfig,
  ProductResult,
  QualityGateResult,
  ScrapeAttemptRecord,
  ScrapeRecipeConfig,
  SourceRecord
} from "../../shared/types.js";
import { requiredElectricalFields } from "../../shared/product-requirements.js";
import { catalogTextMatches, compactCatalogNumber } from "./catalog-number.js";
import {
  hasMatchingStructuredIdentity,
  identityConflictReason,
  structuredIdentityConflict
} from "./product-identity.js";

export function evaluateQualityGate(
  result: ProductResult,
  manufacturer: ManufacturerConfig,
  catalogNumber = result.catalogNumber,
  attempts: ScrapeAttemptRecord[] = []
): QualityGateResult {
  const recipe = manufacturer.scrapeRecipe ?? defaultRecipe();
  const identityConflict = structuredIdentityConflict(result, catalogNumber, manufacturer);
  const identityConfirmed = !identityConflict && confirmsIdentity(result, catalogNumber, manufacturer);
  const missing = new Set<string>();
  const sectionAttributeCounts = countRecipeSections(result, recipe);

  if (!identityConfirmed) missing.add("identity");
  if (identityConflict) missing.add("identity-conflict");

  for (const pattern of recipe.requiredSections ?? []) {
    if (!sectionAttributeCounts[pattern]) missing.add(`section:${pattern}`);
  }

  for (const pattern of recipe.requiredAttributes ?? []) {
    if (!hasMatchingAttribute(result, pattern)) missing.add(`attribute:${pattern}`);
  }

  for (const pattern of recipe.requiredDocuments ?? []) {
    if (!hasMatchingDocument(result, String(pattern))) missing.add(`document:${pattern}`);
  }

  for (const field of recipe.qualityPolicy?.requiredNormalizedFields ?? []) {
    if (!result.normalized[field]) missing.add(`normalized:${field}`);
  }

  const electricalFields = requiredElectricalFields(result);
  if (electricalFields.includes("voltage") && !result.normalized.voltage) {
    missing.add("normalized:voltage");
  }
  if (electricalFields.includes("current") && !result.normalized.current) {
    missing.add("normalized:current");
  }

  if (recipe.minAttributes !== undefined && result.attributes.length < recipe.minAttributes) {
    missing.add(`minAttributes:${recipe.minAttributes}`);
  }

  if (recipe.qualityPolicy?.minRawAttributes !== undefined && result.attributes.length < recipe.qualityPolicy.minRawAttributes) {
    missing.add(`minRawAttributes:${recipe.qualityPolicy.minRawAttributes}`);
  }

  if (recipe.minDocuments !== undefined && result.documents.length < recipe.minDocuments) {
    missing.add(`minDocuments:${recipe.minDocuments}`);
  }

  for (const type of recipe.qualityPolicy?.requiredDocumentTypes ?? []) {
    if (!result.documents.some((doc) => doc.type === type)) missing.add(`documentType:${type}`);
  }

  const score = scoreResult(result, recipe, manufacturer, identityConfirmed, [...missing]);
  const hasAuthoritativeSource = !requiresOfficialSource(recipe) || hasOfficialEvidence(result, manufacturer);
  if (!hasAuthoritativeSource) missing.add("official-source");
  const passed = identityConfirmed && missing.size === 0 && score >= (recipe.confidenceRules?.foundMinScore ?? 70);
  const reason = passed
    ? "Quality gate passed."
    : identityConflict
      ? identityConflictReason(identityConflict)
      : missing.size
      ? `Missing required product data: ${[...missing].join("; ")}`
      : `Quality score ${score} below threshold.`;

  const currentAttempt = resultAttempt(result, passed ? "passed" : identityConfirmed ? "partial" : "failed", score, [...missing], reason, sectionAttributeCounts);
  return {
    passed,
    identityConfirmed,
    score,
    missing: [...missing],
    reason,
    attempts: mergeAttempts([...attempts, currentAttempt, ...(result.qualityGate?.attempts ?? [])])
  };
}

export function applyQualityGate(
  result: ProductResult,
  manufacturer: ManufacturerConfig,
  gate: QualityGateResult = evaluateQualityGate(result, manufacturer)
): ProductResult {
  const recipe = manufacturer.scrapeRecipe ?? defaultRecipe();
  const hasData = result.attributes.length > 0 || result.documents.length > 0;
  const status: ProductResult["status"] = gate.passed && hasData ? "found" : gate.identityConfirmed && result.status !== "failed" ? "partial" : "failed";
  const sourceTypes = new Set(result.sources.map((source) => source.sourceType));
  const distributorOnly = sourceTypes.size > 0 && [...sourceTypes].every((sourceType) => sourceType === "distributor");
  const partialCap = recipe.qualityPolicy?.partialConfidenceCap ?? recipe.confidenceRules?.partialMaxConfidence ?? 0.74;
  const distributorCap =
    recipe.qualityPolicy?.distributorConfidenceCap ??
    recipe.confidenceRules?.distributorMaxConfidence ??
    recipe.fallbackPolicy?.distributorConfidenceCap ??
    0.45;
  const officialFloor = recipe.qualityPolicy?.officialSourceConfidenceFloor;
  const trustedOfficialEvidence = hasOfficialEvidence(result, manufacturer);
  const cappedConfidence = status === "found"
    ? Math.max(result.confidence, trustedOfficialEvidence && officialFloor !== undefined ? officialFloor : 0)
    : Math.min(result.confidence, distributorOnly ? distributorCap : partialCap);
  const productUrl = canonicalizeProductUrl(result.productUrl, recipe);

  return {
    ...result,
    status,
    confidence: status === "failed" ? 0 : Math.max(0, Math.min(0.99, cappedConfidence)),
    productUrl,
    qualityGate: gate,
    diagnostics: {
      ...result.diagnostics,
      attemptedUrls: uniqueStrings([...(result.diagnostics?.attemptedUrls ?? []), ...result.sources.map((source) => source.url)]),
      chosenUrl: productUrl ?? result.diagnostics?.chosenUrl,
      sectionAttributeCounts: {
        ...result.diagnostics?.sectionAttributeCounts,
        ...(gate.attempts.at(-1)?.sectionAttributeCounts ?? {})
      }
    },
    error: status === "found" ? undefined : gate.reason ?? result.error
  };
}

export function finalizeQualityGate(result: ProductResult, manufacturer: ManufacturerConfig): ProductResult {
  return applyQualityGate(result, manufacturer, evaluateQualityGate(result, manufacturer, result.catalogNumber, result.qualityGate?.attempts ?? []));
}

function defaultRecipe(): ScrapeRecipeConfig {
  return {
    minAttributes: 1,
    fallbackPolicy: {
      officialFirst: true,
      readerOnQualityFailure: true,
      browserOnQualityFailure: true,
      distributorFallback: true,
      distributorConfidenceCap: 0.45
    },
    confidenceRules: {
      foundMinScore: 70,
      partialMaxConfidence: 0.74,
      distributorMaxConfidence: 0.45
    }
  };
}

function confirmsIdentity(result: ProductResult, catalogNumber: string, manufacturer: ManufacturerConfig): boolean {
  if (result.status === "failed" && result.attributes.length === 0 && result.documents.length === 0) return false;
  const match = {
    compact: true,
    afterColon: true,
    ignoreCase: true,
    ...manufacturer.match
  };
  if (result.productUrl && urlContainsIdentitySignal(result.productUrl, catalogNumber)) return true;
  if (result.sources.some((source) => urlContainsIdentitySignal(source.url, catalogNumber))) return true;
  if (result.title && !isSearchLikeText(result.title) && catalogTextMatches(result.title, catalogNumber, match)) return true;

  if (hasMatchingStructuredIdentity(result, catalogNumber, manufacturer)) return true;

  // Customer-document attributes are only emitted when our extractor found the catalog
  // number inside the customer file — the very act of the customer doc producing data
  // for this catalog IS the identity proof. Without this, customer-only items used to
  // fail "identity" even with 30+ attributes extracted from a matching PDF section.
  if (result.attributes.some((attr) => attr.parser === "customer-document")) return true;

  return result.documents.some((doc) => {
    if (!["datasheet", "certificate", "manual"].includes(doc.type)) return false;
    return catalogTextMatches(`${doc.label} ${doc.url}`, catalogNumber, match);
  });
}

function hasMatchingAttribute(result: ProductResult, pattern: string): boolean {
  const normalizedText = Object.entries(result.normalized)
    .map(([name, value]) => `${name} ${value ?? ""}`)
    .join(" ");
  if (matchesPattern(normalizedText, pattern)) return true;
  return result.attributes.some((attr) => matchesPattern(`${attr.group ?? ""} ${attr.name} ${attr.value}`, pattern));
}

function hasMatchingDocument(result: ProductResult, pattern: string): boolean {
  return result.documents.some((doc) => matchesPattern(`${doc.type} ${doc.label} ${doc.url}`, pattern));
}

function countRecipeSections(result: ProductResult, recipe: ScrapeRecipeConfig): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const pattern of recipe.requiredSections ?? []) {
    counts[pattern] = result.attributes.filter((attr) => matchesPattern(`${attr.group ?? ""} ${attr.name}`, pattern)).length;
  }
  return counts;
}

function scoreResult(
  result: ProductResult,
  recipe: ScrapeRecipeConfig,
  manufacturer: ManufacturerConfig,
  identityConfirmed: boolean,
  missing: string[]
): number {
  if (!identityConfirmed) return 0;
  let score = 35;
  const requiredAttributes = recipe.requiredAttributes?.length ?? 0;
  const requiredDocuments = recipe.requiredDocuments?.length ?? 0;
  const requiredSections = recipe.requiredSections?.length ?? 0;
  const missingAttributes = missing.filter((item) => item.startsWith("attribute:")).length;
  const missingDocuments = missing.filter((item) => item.startsWith("document:")).length;
  const missingSections = missing.filter((item) => item.startsWith("section:")).length;

  score += coverageScore(requiredAttributes, missingAttributes, 25);
  score += coverageScore(requiredDocuments, missingDocuments, 18);
  score += coverageScore(requiredSections, missingSections, 12);
  if (result.attributes.length >= (recipe.minAttributes ?? 1)) score += 6;
  if (result.documents.length >= (recipe.minDocuments ?? 0)) score += 4;
  if (hasOfficialEvidence(result, manufacturer)) score += 8;
  if (result.sources.some((source) => source.stage === "localized-template" || source.stage === "direct-template")) score += 3;
  if (missing.some((item) => item.startsWith("normalized:"))) score -= 10;
  if (result.documents.some((doc) => doc.localPath || doc.type === "datasheet" || doc.type === "certificate")) {
    score += recipe.confidenceRules?.officialDocumentBonus ?? 4;
  }
  if (result.sources.length > 0 && result.sources.every((source) => source.sourceType === "distributor")) score -= 18;
  if (result.sources.some((source) => /reader/i.test(source.parser))) score -= recipe.confidenceRules?.readerPenalty ?? 2;
  if (result.sources.some((source) => /browser/i.test(source.parser))) score -= recipe.confidenceRules?.browserPenalty ?? 4;
  if (missing.some((item) => item.startsWith("min"))) score -= 12;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function coverageScore(total: number, missing: number, weight: number): number {
  if (total === 0) return weight;
  return Math.round(((total - missing) / total) * weight);
}

function resultAttempt(
  result: ProductResult,
  status: ScrapeAttemptRecord["status"],
  score: number,
  missing: string[],
  reason: string,
  sectionAttributeCounts: Record<string, number>
): ScrapeAttemptRecord {
  const primarySource = result.sources[0];
  return {
    stage: stageFromSource(primarySource),
    url: result.productUrl ?? primarySource?.url,
    status,
    score,
    missing,
    reason,
    sourceType: primarySource?.sourceType,
    parser: primarySource?.parser,
    statusCode: primarySource?.statusCode,
    attributeCount: result.attributes.length,
    documentCount: result.documents.length,
    sectionAttributeCounts
  };
}

function stageFromSource(source: SourceRecord | undefined): string {
  if (!source) return "empty-result";
  if (/browser/i.test(source.parser)) return "browser-render";
  if (/reader|r\.jina/i.test(source.parser) || /r\.jina\.ai/i.test(source.url)) return "reader";
  if (source.sourceType === "distributor") return "distributor";
  if (source.parser === "generic" || /fallback/i.test(source.parser)) return "static-html";
  return source.parser || source.sourceType;
}

function mergeAttempts(attempts: ScrapeAttemptRecord[]): ScrapeAttemptRecord[] {
  const seen = new Set<string>();
  const merged: ScrapeAttemptRecord[] = [];
  for (const attempt of attempts) {
    const key = `${attempt.stage}|${attempt.url ?? ""}|${attempt.parser ?? ""}|${attempt.status}|${attempt.reason ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(attempt);
  }
  return merged.slice(-20);
}

function matchesPattern(value: string, pattern: string): boolean {
  const cleanValue = value.toLowerCase();
  const cleanPattern = pattern.trim();
  if (!cleanPattern) return false;
  try {
    return new RegExp(cleanPattern, "i").test(value);
  } catch {
    return cleanValue.includes(cleanPattern.toLowerCase());
  }
}

function urlContainsIdentitySignal(url: string, catalogNumber: string): boolean {
  try {
    const parsed = new URL(url);
    const compactPart = compactCatalogNumber(catalogNumber).toLowerCase();
    if (!compactPart) return false;
    if (parsed.pathname.split("/").map(decodeURIComponent).some((segment) => compactCatalogNumber(segment).toLowerCase() === compactPart)) {
      return true;
    }
    const strongParams = ["sku", "mpn", "mlfb", "part", "partnumber", "productid", "product", "catalog", "catalognumber", "article", "articlenumber"];
    for (const [key, value] of parsed.searchParams.entries()) {
      const cleanKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (!strongParams.includes(cleanKey)) continue;
      if (compactCatalogNumber(value).toLowerCase() === compactPart) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isSearchLikeText(value: string): boolean {
  return /\b(search results?|suche|suchergebnisse|results for)\b/i.test(value);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function hasOfficialEvidence(result: ProductResult, manufacturer: ManufacturerConfig): boolean {
  return hasCustomerDocumentEvidence(result) || hasTrustedOfficialSource(result, manufacturer) || hasOfficialProductUrl(result, manufacturer);
}

/**
 * Customer-supplied documents are authoritative by design — the customer's own datasheet
 * trumps anything we'd scrape from the web. Treat them as satisfying the "official source"
 * requirement so the quality gate doesn't mark a perfectly-customer-sourced product as
 * failed just because the URL is file:// instead of eaton.com.
 */
function hasCustomerDocumentEvidence(result: ProductResult): boolean {
  return result.sources.some((source) => source.parser === "customer-document");
}

function hasTrustedOfficialSource(result: ProductResult, manufacturer: ManufacturerConfig): boolean {
  return result.sources.some((source) => isTrustedOfficialSource(source, manufacturer));
}

function isTrustedOfficialSource(source: SourceRecord, manufacturer: ManufacturerConfig): boolean {
  if (source.sourceType !== "official" && source.sourceType !== "official-fallback") return false;
  return isOfficialUrl(source.url, manufacturer);
}

function hasOfficialProductUrl(result: ProductResult, manufacturer: ManufacturerConfig): boolean {
  const candidates = [
    result.productUrl,
    ...result.sources
      .filter((source) => source.sourceType === "official" || source.sourceType === "official-fallback")
      .map((source) => source.url)
  ].filter((url): url is string => Boolean(url));
  return candidates.some((url) => isOfficialUrl(url, manufacturer));
}

function isOfficialUrl(url: string, manufacturer: ManufacturerConfig): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return manufacturer.officialBaseUrls.some((baseUrl) => {
      const baseHostname = officialHostname(baseUrl);
      if (!baseHostname) return false;
      return hostname === baseHostname || hostname.endsWith(`.${baseHostname}`) || (hostname === "r.jina.ai" && url.toLowerCase().includes(baseHostname));
    });
  } catch {
    return false;
  }
}

function officialHostname(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function requiresOfficialSource(recipe: ScrapeRecipeConfig): boolean {
  return recipe.fallbackPolicy?.officialFirst !== false;
}

function canonicalizeProductUrl(url: string | undefined, recipe: ScrapeRecipeConfig): string | undefined {
  if (!url) return undefined;
  const denylist = recipe.canonicalParamDenylist ?? [];
  if (!denylist.length) return url;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (denylist.some((denied) => key === denied || key.startsWith(`${denied}[`) || key.startsWith(`${denied}.`))) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
