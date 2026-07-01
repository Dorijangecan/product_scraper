import type { AttributeRecord, DocumentRecord, SourceRecord } from "../../shared/types.js";

export function dedupeAttributes(
  attributes: AttributeRecord[],
  options: { includeSourceUrl?: boolean; requireNameValue?: boolean } = {}
): AttributeRecord[] {
  const requireNameValue = options.requireNameValue ?? true;
  const seen = new Set<string>();
  return attributes.filter((attr) => {
    const key = [
      attr.group ?? "",
      attr.name,
      attr.value,
      options.includeSourceUrl ? attr.sourceUrl ?? "" : ""
    ]
      .join("|")
      .toLowerCase();
    if ((requireNameValue && (!attr.name || !attr.value)) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface DedupeDocumentOptions {
  bucketKey?: (doc: DocumentRecord) => string | undefined;
  compare?: (candidate: DocumentRecord, existing: DocumentRecord) => number;
}

export function dedupeDocuments(documents: DocumentRecord[], options: DedupeDocumentOptions = {}): DocumentRecord[] {
  const byUrl = new Map<string, DocumentRecord>();
  const order: string[] = [];
  for (const doc of documents) {
    if (!doc.url) continue;
    const key = options.bucketKey?.(doc) ?? canonicalDocumentUrlKey(doc.url);
    const existing = byUrl.get(key);
    if (!existing) {
      order.push(key);
      byUrl.set(key, doc);
      continue;
    }
    const comparison = options.compare?.(doc, existing) ?? documentQualityScore(doc) - documentQualityScore(existing);
    if (comparison > 0) {
      byUrl.set(key, doc);
    }
  }
  return order.map((key) => byUrl.get(key)).filter((doc): doc is DocumentRecord => Boolean(doc));
}

export function canonicalDocumentUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:utm_.*|fbclid|gclid|msclkid|_gl|cacheBust|cacheBuster|timestamp|ts)$/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    const sorted = [...parsed.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
    parsed.search = "";
    for (const [key, value] of sorted) parsed.searchParams.append(key, value);
    return parsed.toString().toLowerCase();
  } catch {
    return url.trim().replace(/#.*$/g, "").toLowerCase();
  }
}

function documentQualityScore(doc: DocumentRecord): number {
  const text = `${doc.type} ${doc.label} ${doc.url}`.toLowerCase();
  let score = 0;
  if (doc.type === "datasheet") score += 130;
  else if (doc.type === "manual") score += 80;
  else if (doc.type === "certificate") score += 70;
  else if (doc.type === "cad") score += 60;
  else if (doc.type === "image") score += 50;
  if (/\b(?:data\s*sheet|datasheet|technical\s+data|spec(?:ification)?\s*sheet|pdf)\b/i.test(text)) score += 20;
  if (/\b(?:manual|instruction|installation)\b/i.test(text)) score += 15;
  if (/\s/.test(doc.label) && doc.label.length > 18) score += 12;
  if (/^[A-Z0-9_-]+\.(?:pdf|zip|dwg|dxf|stp|step)$/i.test(doc.label.trim())) score -= 25;
  if (isGenericDocumentLabel(doc.label)) score -= 60;
  if (doc.sourceType === "official") score += 10;
  if (doc.sourceType === "official-fallback") score += 6;
  if (doc.localPath || doc.downloadStatus === "downloaded") score += 10;
  if (doc.confidence !== undefined) score += Math.round(doc.confidence * 10);
  return score;
}

function isGenericDocumentLabel(label: string): boolean {
  const cleaned = label.trim();
  if (!cleaned) return true;
  if (/\b(?:data\s*sheet|datasheet|technical|manual|instruction|installation|certificate|declaration|conformity|pdf|cad|drawing)\b/i.test(cleaned)) return false;
  return /^(?:files?|downloads?|documents?|resources?|media|dam|api|view|open)$/i.test(cleaned) || /^[A-Z0-9_-]{5,80}$/i.test(cleaned);
}

export function dedupeSources(sources: SourceRecord[]): SourceRecord[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.parser}|${source.url}`.toLowerCase();
    if (!source.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
