import type { ManufacturerConfig, ProductResult } from "../src/shared/types.js";

export interface BenchmarkUrlFixture {
  expectedOfficialUrlPatterns?: string[];
}

export function matchesExpectedOfficialUrl(result: ProductResult, manufacturer: ManufacturerConfig, fixture: BenchmarkUrlFixture): boolean {
  const urls = benchmarkEvidenceUrls(result);
  if (urls.length === 0) return false;
  const patterns = fixture.expectedOfficialUrlPatterns?.map((pattern) => safeRegExp(pattern)) ?? [];
  if (patterns.length > 0 && urls.some((url) => patterns.some((pattern) => pattern.test(url)))) return true;

  return urls.some((url) => urlMatchesManufacturerBase(url, manufacturer));
}

function benchmarkEvidenceUrls(result: ProductResult): string[] {
  return uniqueStrings([
    result.productUrl,
    result.localizedUrls?.en,
    result.localizedUrls?.de,
    ...result.sources.flatMap((source) => [source.url]),
    ...result.documents.flatMap((document) => [document.url, document.sourceUrl, document.localPath])
  ]);
}

function urlMatchesManufacturerBase(url: string, manufacturer: ManufacturerConfig): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return manufacturer.officialBaseUrls.some((baseUrl) => {
      try {
        const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");
        return host === baseHost || host.endsWith(`.${baseHost}`);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function safeRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return /$a/;
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}
