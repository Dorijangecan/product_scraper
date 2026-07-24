import { describe, expect, it } from "vitest";
import {
  extractEmbeddedPdfAssetUrl,
  isDocumentViewerUrl,
  resolveViewerPdfUrl
} from "../src/server/scrapers/document-viewer-resolver.js";
import type { CachedHttpClient, FetchedText } from "../src/server/scrapers/http-client.js";

const ABB_VIEWER_URL =
  "https://search.abb.com/library/Download.aspx?DocumentID=2CDC400002D0201&LanguageCode=en&DocumentPartId=&Action=Launch";

// Trimmed from a real ABB Download.aspx viewer response: the actual PDF lives in an <iframe>
// pointing at a signed, short-lived library.e.abb.com asset.
const ABB_VIEWER_HTML = `
  <html><head><title>Comparison of tripping characteristics for MCBs</title></head>
  <body>
    <form name="form1" method="post" action="./Download.aspx?DocumentID=2CDC400002D0201">
      <input type="hidden" name="__VIEWSTATE" value="abc" />
      <div id="mainGrid">
        <iframe src="https://library.e.abb.com/public/114371fcc8e0456096db42d614bead67/2CDC400002D0201_view.pdf?x-sign=ofaKNuWcasRTONCVIppU33UXZjPlqp%2fDM9SZtGxJuF6U5Mb" id="mainFrame" width="100%"></iframe>
      </div>
    </form>
  </body></html>
`;

function fetched(text: string, effectiveUrl: string, statusCode = 200): FetchedText {
  return {
    requestedUrl: effectiveUrl,
    effectiveUrl,
    statusCode,
    contentType: "text/html",
    text,
    fetchedAt: "2026-05-13T00:00:00.000Z",
    fromCache: false
  };
}

describe("document viewer resolver", () => {
  it("recognizes ABB library Download.aspx viewer URLs", () => {
    expect(isDocumentViewerUrl(ABB_VIEWER_URL)).toBe(true);
    expect(isDocumentViewerUrl("https://library.abb.com/library/Download.aspx?DocumentID=X")).toBe(true);
    // A direct PDF and the SPA landing page are not viewer wrappers.
    expect(isDocumentViewerUrl("https://library.e.abb.com/public/abc/2CDC_view.pdf?x-sign=y")).toBe(false);
    expect(isDocumentViewerUrl("https://library.abb.com/d/2CDC400002D0201")).toBe(false);
    expect(isDocumentViewerUrl("https://example.com/datasheet.pdf")).toBe(false);
  });

  it("extracts the embedded signed PDF asset from a viewer page", () => {
    const url = extractEmbeddedPdfAssetUrl(ABB_VIEWER_HTML, ABB_VIEWER_URL);
    expect(url).toBe(
      "https://library.e.abb.com/public/114371fcc8e0456096db42d614bead67/2CDC400002D0201_view.pdf?x-sign=ofaKNuWcasRTONCVIppU33UXZjPlqp%2fDM9SZtGxJuF6U5Mb"
    );
  });

  it("ignores non-PDF embeds (image thumbnail / video viewer)", () => {
    const thumbnailOnly = `<html><body><iframe src="https://library.e.abb.com/public/x/doc.pdf.jpg"></iframe></body></html>`;
    expect(extractEmbeddedPdfAssetUrl(thumbnailOnly, ABB_VIEWER_URL)).toBeUndefined();
    const videoViewer = `<html><body><video id="multi-media-player-video" src="https://library.e.abb.com/public/x/clip.mp4"></video></body></html>`;
    expect(extractEmbeddedPdfAssetUrl(videoViewer, ABB_VIEWER_URL)).toBeUndefined();
    expect(extractEmbeddedPdfAssetUrl("", ABB_VIEWER_URL)).toBeUndefined();
  });

  it("resolves a viewer URL to its PDF asset over HTTP, and swallows failures", async () => {
    const okHttp = {
      fetchText: async (requestedUrl: string) => fetched(ABB_VIEWER_HTML, requestedUrl)
    } as unknown as CachedHttpClient;
    await expect(resolveViewerPdfUrl(okHttp, ABB_VIEWER_URL)).resolves.toBe(
      "https://library.e.abb.com/public/114371fcc8e0456096db42d614bead67/2CDC400002D0201_view.pdf?x-sign=ofaKNuWcasRTONCVIppU33UXZjPlqp%2fDM9SZtGxJuF6U5Mb"
    );

    const blockedHttp = {
      fetchText: async (requestedUrl: string) => fetched("<html>Access Denied</html>", requestedUrl, 403)
    } as unknown as CachedHttpClient;
    await expect(resolveViewerPdfUrl(blockedHttp, ABB_VIEWER_URL)).resolves.toBeUndefined();

    const throwingHttp = {
      fetchText: async () => {
        throw new Error("network down");
      }
    } as unknown as CachedHttpClient;
    await expect(resolveViewerPdfUrl(throwingHttp, ABB_VIEWER_URL)).resolves.toBeUndefined();
  });
});
