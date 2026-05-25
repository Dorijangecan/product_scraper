import type { AttributeRecord, DocumentRecord, SourceRecord } from "../../shared/types.js";

export function dedupeAttributes(attributes: AttributeRecord[], options: { includeSourceUrl?: boolean } = {}): AttributeRecord[] {
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
    if (!attr.name || !attr.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function dedupeDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const seen = new Set<string>();
  return documents.filter((doc) => {
    const key = doc.url.toLowerCase();
    if (!doc.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
