/**
 * Decode a fetched body that may be gzip-compressed.
 *
 * Sitemaps are the reason this exists. Google's sitemap protocol explicitly allows (and large catalogs
 * routinely use) `sitemap.xml.gz`, and `Content-Encoding` is often absent because the `.gz` is the FILE
 * format rather than a transport encoding — so `fetch` hands back raw deflate bytes that decode to
 * mojibake. `extractSitemapLocs` then regexes that mojibake, finds no `<loc>`, and reports zero URLs
 * with no error. A gzipped sitemap was therefore silently invisible, which mattered most for exactly the
 * brand-new vendor whose sitemap is the only reliable discovery channel.
 *
 * Kept as a leaf module with no dependencies beyond `node:zlib` so it is trivially unit-testable — the
 * previous excuse for not implementing gzip support was that it "could not be validated offline", which
 * was wrong: a gzipped buffer is three lines to construct in a test.
 */
import zlib from "node:zlib";

/** gzip magic number: 0x1f 0x8b, followed by the deflate compression method (0x08). */
export function looksGzipped(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0x1f && buffer[1] === 0x8b && buffer[2] === 0x08;
}

/** zlib/deflate stream magic — some servers serve `.gz` URLs as raw zlib rather than gzip. */
function looksZlibDeflated(buffer: Buffer): boolean {
  if (buffer.length < 2) return false;
  const header = (buffer[0] << 8) + buffer[1];
  return (buffer[0] & 0x0f) === 0x08 && header % 31 === 0;
}

/**
 * Text of `buffer`, transparently decompressing gzip (or raw zlib) when present.
 *
 * Never throws: a corrupt or truncated archive falls back to the undecompressed decode, so a caller
 * that only wants "best effort text" behaves exactly as it did before.
 */
export function decodeMaybeCompressedText(buffer: Buffer, encoding: BufferEncoding = "utf8"): string {
  if (looksGzipped(buffer)) {
    try {
      return zlib.gunzipSync(buffer).toString(encoding);
    } catch {
      return buffer.toString(encoding);
    }
  }
  if (looksZlibDeflated(buffer)) {
    try {
      return zlib.inflateSync(buffer).toString(encoding);
    } catch {
      return buffer.toString(encoding);
    }
  }
  return buffer.toString(encoding);
}

/** Does this URL name a compressed file? Used to decide whether a binary-capable fetch is worth it. */
export function urlLooksCompressed(url: string): boolean {
  return /\.(?:gz|gzip)(?:[?#]|$)/i.test(url);
}
