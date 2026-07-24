import * as cheerio from "cheerio";
import { DEFAULT_USER_AGENT, type CachedHttpClient } from "./http-client.js";

/**
 * Some manufacturer "download" links do not serve a PDF directly — they serve an HTML *viewer*
 * page that embeds the real PDF in an `<iframe>`/`<embed>` pointing at a separate (often signed,
 * short-lived) asset URL. Downloading the link as-is stores the HTML wrapper, which then fails
 * `%PDF-` validation and PDF enrichment.
 *
 * ABB's library is the concrete case this exists for: every datasheet/certificate/manual link the
 * ABB connector emits is `https://search.abb.com/library/Download.aspx?DocumentID=<id>&Action=Launch`,
 * which returns
 *   <iframe id="mainFrame"
 *           src="https://library.e.abb.com/public/<guid>/<id>_view.pdf?x-sign=<signature>">
 * The signed asset URL cannot be constructed statically and expires quickly, so it must be
 * resolved lazily at download time — the stable `Download.aspx` URL stays as the exported link.
 */

// ABB's Akamai edge rejects stale Chrome UAs (Chrome/125 → 403) but accepts the current one, so
// reuse the shared DEFAULT_USER_AGENT rather than hardcoding a version that will silently rot.

/** True for a URL that serves an HTML PDF-viewer wrapper rather than a PDF, and therefore needs
 *  {@link resolveViewerPdfUrl} before it can be downloaded/parsed as a datasheet. */
export function isDocumentViewerUrl(url: string): boolean {
  return /(?:^|[/.])search\.abb\.com\/library\/Download\.aspx\?/i.test(url) ||
    /(?:^|[/.])library\.abb\.com\/[^?#]*\/Download\.aspx\?/i.test(url);
}

/**
 * Extract the embedded PDF asset URL from a viewer page's HTML. Returns an absolute URL, or
 * undefined when the page embeds something that is not a PDF (e.g. ABB serves a video player for
 * multimedia documents) so the caller can fall back to the original link.
 */
export function extractEmbeddedPdfAssetUrl(html: string, baseUrl: string): string | undefined {
  if (!html) return undefined;
  const $ = cheerio.load(html);
  const candidates: string[] = [];
  $("iframe[src], embed[src], object[data]").each((_, element) => {
    const raw = $(element).attr("src") ?? $(element).attr("data");
    if (raw) candidates.push(raw);
  });
  for (const candidate of candidates) {
    const absolute = absoluteUrl(candidate, baseUrl);
    if (absolute && looksLikePdfAssetUrl(absolute)) return absolute;
  }
  return undefined;
}

/** Fetch the viewer page and resolve the embedded PDF asset URL. Best-effort: any failure
 *  (blocked fetch, non-viewer response, no embedded PDF) returns undefined so the caller keeps
 *  the original behaviour of downloading the link directly. */
export async function resolveViewerPdfUrl(
  http: CachedHttpClient,
  url: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    const fetched = await http.fetchText(url, {
      timeoutMs: 15000,
      cacheTtlMs: 1000 * 60 * 60 * 24,
      signal,
      maxAttempts: 2,
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    if (fetched.statusCode >= 400) return undefined;
    return extractEmbeddedPdfAssetUrl(fetched.text, fetched.effectiveUrl || url);
  } catch {
    return undefined;
  }
}

function absoluteUrl(candidate: string, baseUrl: string): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function looksLikePdfAssetUrl(url: string): boolean {
  const pathOnly = url.split(/[?#]/, 1)[0] ?? url;
  // `_view.pdf` is ABB's rendition suffix; `.pdf` covers the general viewer-embeds-a-pdf case.
  return /\.pdf$/i.test(pathOnly);
}
