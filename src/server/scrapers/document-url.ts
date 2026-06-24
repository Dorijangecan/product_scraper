import type { DocumentRecord } from "../../shared/types.js";

export function isKnownNonPdfDocumentUrl(url: string): boolean {
  return /configurator\.rockwellautomation\.com\/api\/Product\/[^/]+\/cutsheet\b/i.test(url);
}

export function isPdfLikeDocumentUrl(url: string): boolean {
  if (isKnownNonPdfDocumentUrl(url)) return false;
  return (
    /\.pdf(?:[?#]|$)/i.test(url) ||
    /\/download-pdf(?:[/?#]|$)/i.test(url) ||
    /pdfengine\/pdf/i.test(url) ||
    /[?&](?:format|output|filetype|type)=pdf\b/i.test(url) ||
    /[?&](?:documentid|docid|mediaid|p_Doc_Ref|docRef)=/i.test(url) ||
    hasPdfQueryHint(url)
  );
}

export function documentUrlLooksDownloadable(url: string): boolean {
  return (
    isPdfLikeDocumentUrl(url) ||
    /\.(zip|dwg|dxf|stp|step|igs|iges)(?:[?#]|$)/i.test(url) ||
    hasDownloadableFileQueryHint(url) ||
    /\/teddatasheet\/?\?[^#]*(?:format=pdf|mlfbs=)/i.test(url) ||
    /\/documents\/(?:td|in|sg)\//i.test(url) ||
    /\/cutsheet(?:[?#]|$)/i.test(url)
  );
}

export function documentUrlLooksRelevant(url: string, context: string, type: DocumentRecord["type"]): boolean {
  if (documentUrlLooksDownloadable(url)) return true;
  const text = `${context} ${url}`;
  if (!/\b(?:pdf|data\s*sheet|datasheet|manual|instruction|installation|certificate|declaration|conformity|technical\s+(?:data|sheet|information)|spec(?:ification)?\s*sheet|download)\b/i.test(text)) {
    return false;
  }
  if (type !== "other") return true;
  return /\/(?:download|downloads|files?|documents?|resources?|media|dam)(?:[/?#]|$)|[?&](?:doc|document|file|asset|media|download|p_Doc_Ref|p_enDocType)=/i.test(url);
}

export function isPdfLikeDocument(doc: Pick<DocumentRecord, "url">): boolean {
  return isPdfLikeDocumentUrl(doc.url);
}

function hasPdfQueryHint(url: string): boolean {
  return queryEntries(url).some(([key, value]) => {
    const combined = `${key}=${value}`;
    return (
      /^(?:format|output|filetype|type|ext|extension|mime|contenttype|content-type)$/i.test(key) &&
      /(?:^|[\/;=])(?:application\/)?pdf(?:$|[;&/])/i.test(value)
    ) || (
      /(?:file|filename|file_name|name|path|url|uri|asset|media|download|document|doc|resource|target|attachment|content)/i.test(key) &&
      /\.pdf(?:$|[?#&;])/i.test(value)
    ) || /\.pdf(?:$|[?#&;])/i.test(combined);
  });
}

function hasDownloadableFileQueryHint(url: string): boolean {
  if (hasPdfQueryHint(url)) return true;
  return queryEntries(url).some(([key, value]) => {
    if (!/(?:file|filename|file_name|name|path|url|uri|asset|media|download|document|doc|resource|target|attachment|content)/i.test(key)) {
      return false;
    }
    return /\.(?:zip|dwg|dxf|stp|step|igs|iges)(?:$|[?#&;])/i.test(value);
  });
}

function queryEntries(url: string): Array<[string, string]> {
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams.entries()].map(([key, value]) => [key, decodeLoose(value)]);
  } catch {
    const query = url.split("?")[1]?.split("#")[0] ?? "";
    return query
      .split("&")
      .map((part) => part.split("="))
      .filter(([key]) => Boolean(key))
      .map(([key, value = ""]) => [decodeLoose(key), decodeLoose(value)]);
  }
}

function decodeLoose(value: string): string {
  const plusAsSpace = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plusAsSpace);
  } catch {
    return plusAsSpace;
  }
}
