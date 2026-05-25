/**
 * End-to-end verification: runs the full ABBConnector.scrape() pipeline against the AEM-style
 * PLC product (1SAP180400R0001), using a minimal stub http client that re-uses node fetch.
 *
 *   "C:\Program Files\nodejs\node.exe" --import tsx scripts/verify-abb-plc.ts 1SAP180400R0001
 */
import { ABBConnector } from "../src/server/scrapers/abb.js";
import type { ScrapeContext } from "../src/server/scrapers/types.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";

const CATALOG = process.argv[2] || "1SAP180400R0001";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0";

async function fetchText(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<FetchedText> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25000);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/json,*/*", "accept-language": "en-US,en", ...(opts.headers ?? {}) },
      redirect: "follow",
      signal: controller.signal
    });
    const text = await r.text();
    return {
      requestedUrl: url,
      effectiveUrl: r.url ?? url,
      statusCode: r.status,
      contentType: r.headers.get("content-type") ?? "",
      text,
      fetchedAt: new Date().toISOString(),
      fromCache: false
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const stubHttp = {
    fetchText: (url: string, options?: { timeoutMs?: number; headers?: Record<string, string> }) =>
      fetchText(url, options),
    fetchTextViaPowerShell: (url: string, options?: { timeoutMs?: number; headers?: Record<string, string> }) =>
      fetchText(url, options)
  };

  const context = {
    http: stubHttp,
    manufacturer: { id: "abb", canonicalName: "ABB", shortName: "ABB", rateLimitMs: 0, officialBaseUrls: [], fallbackSources: [], markerRules: [] },
    runDir: ".cache/scraper-tests",
    documentsDir: ".cache/scraper-tests/documents",
    downloadDocument: async (doc: unknown) => doc,
    fallback: { scrape: async () => undefined }
  } as unknown as ScrapeContext;

  const connector = new ABBConnector();
  console.log(`\n=== ${CATALOG} - full ABBConnector.scrape() ===\n`);
  const result = await connector.scrape(CATALOG, context);
  console.log(`status=${result.status} confidence=${result.confidence}`);
  console.log(`attrs=${result.attributes.length} docs=${result.documents.length}`);
  console.log(`title="${result.title}"`);
  console.log(`url=${result.productUrl}`);
  console.log("\nGroups:");
  const groups = new Map<string, number>();
  for (const a of result.attributes) groups.set(a.group ?? "", (groups.get(a.group ?? "") ?? 0) + 1);
  for (const [g, c] of [...groups.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${g}: ${c}`);
  console.log("\nDocuments:");
  for (const d of result.documents) {
    console.log(`  ${d.type.padEnd(10)} ${d.label.slice(0, 90)}`);
    console.log(`    -> ${d.url.slice(0, 160)}`);
  }
  console.log("\nFirst 30 attributes:");
  for (const a of result.attributes.slice(0, 30)) console.log(`  [${a.group}] ${a.name}: ${(a.value ?? "").slice(0, 100)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
