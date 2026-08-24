import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeMaybeCompressedText, looksGzipped, urlLooksCompressed } from "../src/server/scrapers/gzip-text.js";

/**
 * Gzipped sitemaps were a silent hole: the `.gz` in `sitemap.xml.gz` is the FILE format, not a transport
 * encoding, so `fetch` returns raw deflate bytes, the text decode yields mojibake, and the `<loc>` regex
 * finds nothing — zero URLs, no error. Sitemap indexes are commonly gzipped, and a sitemap is the one
 * discovery channel a brand-new vendor reliably offers.
 */
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://vendor.test/en/catalogue/abc-123</loc></url>
  <url><loc>https://vendor.test/en/catalogue/zzz-999</loc></url>
</urlset>`;

describe("looksGzipped", () => {
  it("recognises a gzip stream by its magic bytes", () => {
    expect(looksGzipped(zlib.gzipSync(Buffer.from(SITEMAP_XML)))).toBe(true);
  });

  it("does not mistake plain XML for gzip", () => {
    expect(looksGzipped(Buffer.from(SITEMAP_XML))).toBe(false);
    expect(looksGzipped(Buffer.alloc(0))).toBe(false);
    expect(looksGzipped(Buffer.from([0x1f]))).toBe(false);
  });
});

describe("decodeMaybeCompressedText", () => {
  it("decompresses a gzipped sitemap back to readable XML", () => {
    const text = decodeMaybeCompressedText(zlib.gzipSync(Buffer.from(SITEMAP_XML)));
    expect(text).toContain("<loc>https://vendor.test/en/catalogue/abc-123</loc>");
  });

  it("decompresses a raw zlib body, which some servers send for .gz URLs", () => {
    const text = decodeMaybeCompressedText(zlib.deflateSync(Buffer.from(SITEMAP_XML)));
    expect(text).toContain("abc-123");
  });

  it("passes uncompressed text through untouched", () => {
    expect(decodeMaybeCompressedText(Buffer.from(SITEMAP_XML))).toBe(SITEMAP_XML);
  });

  it("never throws on a truncated or corrupt archive", () => {
    // Best-effort contract: a broken archive degrades to the raw decode rather than failing the run.
    const truncated = zlib.gzipSync(Buffer.from(SITEMAP_XML)).subarray(0, 12);
    expect(() => decodeMaybeCompressedText(truncated)).not.toThrow();
  });

  it("handles an empty body", () => {
    expect(decodeMaybeCompressedText(Buffer.alloc(0))).toBe("");
  });
});

describe("urlLooksCompressed", () => {
  it("spots compressed sitemap URLs", () => {
    expect(urlLooksCompressed("https://vendor.test/sitemap.xml.gz")).toBe(true);
    expect(urlLooksCompressed("https://vendor.test/sitemap.xml.gz?v=2")).toBe(true);
  });

  it("leaves plain sitemaps alone, so the binary path is not paid for needlessly", () => {
    expect(urlLooksCompressed("https://vendor.test/sitemap.xml")).toBe(false);
    expect(urlLooksCompressed("https://vendor.test/gzip-info.html")).toBe(false);
  });
});
