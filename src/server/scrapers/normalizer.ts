import type { AttributeRecord, DocumentRecord, NormalizedProductFields, ProductResult } from "../../shared/types.js";

export function cleanText(value: string | undefined | null): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitNameValue(text: string): { name: string; value: string } | undefined {
  const cleaned = cleanText(text);
  if (!isLikelySpecText(cleaned)) return undefined;
  const match = cleaned.match(/^([^:]{2,80}):\s*(.+)$/);
  if (!match) return undefined;
  return { name: cleanText(match[1]), value: cleanText(match[2]) };
}

export function normalizeFields(attributes: AttributeRecord[], documents: DocumentRecord[]): NormalizedProductFields {
  const findAttr = (...patterns: RegExp[]) => {
    for (const attr of attributes) {
      const haystack = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
      if (patterns.some((pattern) => pattern.test(haystack))) {
        if (!isLikelySpecText(attr.value)) continue;
        if (!isAvailableSpecValue(attr.value)) continue;
        return attr.value;
      }
    }
    return undefined;
  };

  const height = findAttr(/\bheight\b/, /\baltezza\b/);
  const width = findAttr(/\bwidth\b/, /\blarghezza\b/);
  const depth = findAttr(/\bdepth\b/, /\bprofond/, /\blength\b/);
  const dimensions = findAttr(/\bdimensions?\b/, /\bdimensioni\b/, /\bcable length\b/) ?? formatDimensions(height, width, depth);
  const material = findMaterialAttr(attributes) ?? deriveMaterialFromAttributes(attributes);

  const protectionFromAttr = collectProtectionValues(attributes);
  const certificateNamePattern = /\b(approval|conformity|certificates?|certifications?|approvals?|standards?)\b|\b(ul|ce|rohs|weee|reach)\b/i;
  const certificateValues = [
    ...attributes
      .filter((attr) => certificateNamePattern.test(`${attr.group ?? ""} ${attr.name}`))
      .flatMap((attr) => splitCertificateValues(normalizeCertificateValue(attr.value, true))),
    ...documents
      .filter((doc) => doc.type === "certificate" || /\b(certificate|declaration|conformity|rohs|weee|ul listed|ce declaration)\b/i.test(doc.label))
      .flatMap((doc) => splitCertificateValues(doc.label))
  ];
  const certificates = [
    ...removeSubsumedCertificateTokens(
      [...new Set(certificateValues.map(cleanText).filter(Boolean))]
    ).sort(compareCertificateToken)
  ].join("; ");

  return {
    weight: findAttr(/weight/, /\bmass\b/, /net.*weight/, /gross.*weight/, /gewicht/, /massa/, /peso/),
    dimensions,
    material,
    voltage: findAttr(/voltage/, /napon/, /\bu[enil]?\b/),
    current: findAttr(/\brated current\b/, /\bcurrent ratings?\b/, /\bcurrent consumption\b/, /\boutput current\b/, /\binput current\b/, /amperage/, /corrente/, /struja/),
    protection: protectionFromAttr,
    certificates: certificates || undefined
  };
}

export function mergeResults(primary: ProductResult, fallback?: ProductResult): ProductResult {
  if (!fallback) return primary;
  const attributes = dedupeAttributes([...primary.attributes, ...fallback.attributes]);
  const documents = dedupeDocuments([...primary.documents, ...fallback.documents]);
  const normalized = {
    ...normalizeFields(attributes, documents),
    ...Object.fromEntries(
      Object.entries(primary.normalized).filter(([, value]) => value !== undefined && value !== "")
    )
  };
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
    normalized,
    attributes,
    documents,
    sources: [...primary.sources, ...fallback.sources],
    error: primary.status === "failed" && fallback.status !== "failed" ? undefined : primary.error
  };
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

export function classifyDocument(label: string, url: string): DocumentRecord["type"] {
  const text = `${label} ${url}`.toLowerCase();
  if (/\b(cert|certificate|declaration|conformity|rohs|weee)\b|\bul\b|\bce\b|\bul-listed\b/.test(text)) return "certificate";
  if (/\/documents\/in\//.test(text) || /manual|instruction|instman|installation/.test(text)) return "manual";
  if (/cad|drawing|dwg|dxf|step|stp|zip/.test(text)) return "cad";
  if (/\/documents\/td\//.test(text) || /cutsheet|data.?sheet|datasheet|technical|specification(?:s)? sheet|spec sheet/.test(text)) return "datasheet";
  if (/\.(png|jpe?g|webp|gif)(\?|$)/.test(text)) return "image";
  return "other";
}

function formatDimensions(height?: string, width?: string, depth?: string): string | undefined {
  const parts = [
    height ? `H ${height}` : undefined,
    width ? `W ${width}` : undefined,
    depth ? `D ${depth}` : undefined
  ].filter(Boolean);
  return parts.length ? parts.join(" x ") : undefined;
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
    candidates.push({
      value: attr.value,
      score: materialCandidateScore(attr)
    });
  }
  return candidates.sort((left, right) => right.score - left.score)[0]?.value;
}

function collectProtectionValues(attributes: AttributeRecord[]): string | undefined {
  const values = attributes
    .filter((attr) => /\bip\b|nema|protection|industry standard|stupanj/i.test(`${attr.group ?? ""} ${attr.name}`))
    .map((attr) => normalizeHtmlSpecValue(attr.value))
    .filter((value): value is string => Boolean(value && isLikelySpecText(value) && isAvailableSpecValue(value)));
  const unique = [...new Set(values)];
  return unique.length ? unique.join("; ") : undefined;
}

function deriveMaterialFromAttributes(attributes: AttributeRecord[]): string | undefined {
  const cable = attributes.find((attr) => /^cable$/i.test(attr.name));
  if (cable?.value) {
    const material = cable.value.split(",")[0]?.trim();
    if (material && /pur|pvc|tpe|ptfe|rubber|silicone|poly|steel|stainless|aluminum|aluminium|zinc|brass|copper|cast iron|epdm/i.test(material)) {
      return material;
    }
  }

  const description = attributes.find((attr) => /description/i.test(attr.name));
  if (description?.value) {
    const match = description.value.match(/\b(spheroidal cast iron|malleable cast iron|cast iron|stainless steel|carbon steel|mild steel|steel|aluminum|aluminium|die-cast zinc|zinc|nickel-plated brass|brass|copper|polycarbonate|polyester|fiberglass|pvc|pur|epdm|abs)\b/i);
    if (match) return cleanText(match[1]);
  }

  for (const attr of attributes) {
    if (!/(description|application|feature|detail|material|body|housing|enclosure|cable)/i.test(`${attr.group ?? ""} ${attr.name}`)) continue;
    if (/(accessor(?:y|ies)|fittings?|hex nut|knurled nut|screw|terminal|wire size|mounting screw)/i.test(attr.value)) continue;
    const match = attr.value.match(/\b(spheroidal cast iron|malleable cast iron|cast iron|stainless steel|carbon steel|mild steel|steel|aluminum|aluminium|die-cast zinc|zinc|nickel-plated brass|brass|copper|polycarbonate|polyester|fiberglass|pvc|pur|epdm|abs)\b/i);
    if (match) return cleanText(match[1]);
  }

  return undefined;
}

function normalizeCertificateValue(value: string, allowNotApplicable = false): string {
  const cleaned = cleanText(value)
    .replace(/ddrivetip\('([\s\S]*?)'\s*,[\s\S]*$/i, "$1")
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/CE(?=cULus)/g, "CE, ")
    .replace(/cULus(?=WEEE)/g, "cULus, ")
    .replace(/([,;])\s*/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
  if (allowNotApplicable && /^(not applicable|no certification needed|no certifications? needed|n\/a)$/i.test(cleaned)) return cleaned;
  const tokens = [
    ...(cleaned.match(/\bNEMA(?:\s+Type)?\s+[^;]+/gi) ?? []),
    ...(cleaned.match(/\bUL\s+Listed\s+[^;]+/gi) ?? []),
    ...(cleaned.match(/\bCSA\s+Type\s+[^;]+/gi) ?? []),
    ...(cleaned.match(/\bIEC\s+\d+(?:\s+IP\s+\d+[A-Z]?)?/gi) ?? []),
    ...(cleaned.match(/\bIP\s*\d+[A-Z]?\b/gi) ?? []),
    ...(cleaned.match(/\bcULus\b/g) ?? []),
    ...(cleaned.match(/\bVDE\b/g) ?? []),
    ...(cleaned.match(/\bCSA\b/g) ?? []),
    ...(cleaned.match(/\bUL\b/g) ?? []),
    ...(cleaned.match(/\bWEEE\b/g) ?? []),
    ...(cleaned.match(/\bREACH\b/gi) ?? []),
    ...(cleaned.match(/\bRoHS\b/gi) ?? []),
    ...(cleaned.match(/\bUKCA\b/g) ?? []),
    ...(cleaned.match(/\bPED\s+\d{4}\/\d+\/[A-Z]+/gi) ?? []),
    ...(cleaned.match(/\bCE\b/g) ?? [])
  ].map(cleanText);
  if (tokens.length > 0) return [...new Set(tokens)].sort(compareCertificateToken).join("; ");
  if (/\b(certificate|declaration|conformity|listed|approved)\b/i.test(cleaned)) return cleaned;
  return "";
}

function splitCertificateValues(value: string): string[] {
  return value
    .split(";")
    .map(cleanText)
    .filter(Boolean);
}

function removeSubsumedCertificateTokens(values: string[]): string[] {
  return values.filter((value) => {
    const compact = compactCertificateToken(value);
    return !values.some((other) => {
      if (other === value) return false;
      const compactOther = compactCertificateToken(other);
      return compactOther.length > compact.length && compactOther.includes(compact);
    });
  });
}

function compactCertificateToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function compareCertificateToken(left: string, right: string): number {
  return certificateTokenRank(left) - certificateTokenRank(right) || left.localeCompare(right, undefined, { sensitivity: "base" });
}

function certificateTokenRank(value: string): number {
  if (/^ce$/i.test(value)) return 10;
  if (/^culus$/i.test(value)) return 20;
  if (/^weee$/i.test(value)) return 30;
  if (/^reach$/i.test(value)) return 40;
  if (/^rohs$/i.test(value)) return 50;
  if (/^ukca$/i.test(value)) return 55;
  if (/^nema/i.test(value)) return 60;
  if (/^ul/i.test(value)) return 70;
  if (/^csa/i.test(value)) return 80;
  if (/^iec/i.test(value)) return 90;
  if (/^ip/i.test(value)) return 100;
  return 100;
}

function isLikelySpecText(value: string): boolean {
  const cleaned = cleanText(value);
  if (!cleaned || cleaned.length > 500) return false;
  return !/[{}]|var\(--|@media|display\s*:|calc\(|--[a-z0-9-]+/i.test(cleaned);
}

function isAvailableSpecValue(value: string): boolean {
  return !/^(not available|n\/a|na|none|-|not applicable)$/i.test(cleanText(value)) && !/\bsee\s+[«"]?dimensions[»"]?\b/i.test(cleanText(value)) && !/^(internal connection diagram|installation drawings?|installation drawing)$/i.test(cleanText(value));
}

function materialCandidateScore(attr: AttributeRecord): number {
  const haystack = `${attr.group ?? ""} ${attr.name} ${attr.value}`.toLowerCase();
  let score = 0;
  if (/\bmaterial\b/i.test(attr.name)) score += 20;
  if (/housing|enclosure|body|valve body|cable jacket/i.test(haystack)) score += 40;
  if (/spheroidal cast iron|carbon steel|stainless steel|mild steel|polycarbonate|polyester|pvc|pur/i.test(haystack)) score += 20;
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

function dedupeAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  const seen = new Set<string>();
  return attributes.filter((attr) => {
    const key = `${attr.group ?? ""}|${attr.name}|${attr.value}|${attr.sourceUrl ?? ""}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(attr.name && attr.value);
  });
}

function dedupeDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const seen = new Set<string>();
  return documents.filter((doc) => {
    const key = doc.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(doc.url);
  });
}
