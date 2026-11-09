/**
 * Batch-verifies the ABB scraper against every catalog number in
 * "Testing PDT/ABB test.csv". Uses node-fetch directly (the production scraper
 * does the same via node + PowerShell fallback), parses with the existing parser,
 * and prints a summary per product.
 *
 *   "C:\Program Files\nodejs\node.exe" --import tsx scripts/verify-abb-batch.ts
 */
import { ABBConnector, parseAbbProductPage } from "../src/server/scrapers/abb.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";
import type { ScrapeContext } from "../src/server/scrapers/types.js";

const _UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0";
async function fetchTextStub(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number; method?: string; body?: string; signal?: AbortSignal } = {}): Promise<FetchedText> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25000);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": _UA, accept: "text/html,application/json,*/*", "accept-language": "en-US,en", ...(opts.headers ?? {}) },
      method: opts.method ?? "GET",
      body: opts.body,
      redirect: "follow",
      signal: opts.signal ?? controller.signal
    });
    const text = await r.text();
    return { requestedUrl: url, effectiveUrl: r.url ?? url, statusCode: r.status, contentType: r.headers.get("content-type") ?? "", text, fetchedAt: new Date().toISOString(), fromCache: false };
  } finally {
    clearTimeout(timer);
  }
}
function makeContext(): ScrapeContext {
  return {
    http: { fetchText: fetchTextStub, fetchTextViaPowerShell: fetchTextStub },
    manufacturer: { id: "abb", canonicalName: "ABB", shortName: "ABB", rateLimitMs: 0, officialBaseUrls: [], fallbackSources: [], markerRules: [] },
    runDir: ".cache/scraper-tests",
    documentsDir: ".cache/scraper-tests/documents",
    downloadDocument: async (doc: unknown) => doc,
    fallback: { scrape: async () => undefined }
  } as unknown as ScrapeContext;
}

const DEFAULT = [
  "1STQ005321B0000", "1STQ005328B0000", "1STQ005329B0000", "1STQ005330B0000", "1STQ005331B0000",
  "EC1440K", "EC1460K", "EC1480FC6K", "EC1480K", "EC1610K", "EC1640K", "EC1660K", "EC1680FC6K", "EC1680K",
  "EC1810K", "EC1831K", "EC1840K", "EC1860K", "EC1880FC5K", "EC1880FC6K", "EC1880FC8K", "EC1880FV6K", "EC1880FV8K", "EC1880K", "EC1880VC2K", "EC1880VC4K",
  "EC2012K", "EC2031K", "EC2040K", "EC2060K", "EC2080FC5K", "EC2080FC6K", "EC2080FC8K", "EC2080FV6K", "EC2080FV8K", "EC2080K", "EC2080VC2K", "EC2080VC4K",
  "EC2210K", "EC2232K", "EC2240K", "EC2260K", "EC2280FC5K", "EC2280FC6K", "EC2280FC8K", "EC2280FV6K", "EC2280FV8K", "EC2280K", "EC2280VC2K", "EC2280VC4K",
  "ED1412SK", "ED1612SK", "ED1804SK", "ED1810SK", "ED1812SK", "ED1816SK", "ED2002SK", "ED2004SK", "ED2010SK", "ED2012SK", "ED2016SK", "ED2202SK", "ED2204SK", "ED2210SK", "ED2212SK", "ED2216SK",
  "EE1810K", "EE1860K", "EE1880K", "EE1906K", "EE1908K", "EE1910K", "EE2010K", "EE2060K", "EE2080K", "EE2106K", "EE2108K", "EE2110K", "EE2210K", "EE2260K", "EE2280K", "EE2306K", "EE2308K", "EE2310K",
  "ET1810K", "ET1860K", "ET1880K", "ET2010K", "ET2060K", "ET2080K", "ET2211K", "ET2260K", "ET2280K"
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

async function fetchOnce(url: string): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,*/*", "accept-language": "en-US,en;q=0.9" },
      redirect: "follow"
    });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: `ERR ${(e as Error).message}` };
  }
}

async function fetchAbb(catalog: string): Promise<{ url: string; status: number; body: string }> {
  const urls = [
    `https://new.abb.com/products/${encodeURIComponent(catalog)}`,
    `https://new.abb.com/products/en/${encodeURIComponent(catalog)}`,
    `https://www.abb.com/global/en/products/${encodeURIComponent(catalog)}`
  ];
  for (const url of urls) {
    const { ok, status, body } = await fetchOnce(url);
    if (ok && /\bvar\s+model\s*=/.test(body)) return { url, status, body };
  }
  // Final fallback: search API to find the canonical product id, then fetch.
  try {
    const search = await fetchOnce(
      `https://new.abb.com/api/PisSearchApi?query=${encodeURIComponent(catalog)}&pageNumber=1&pageSize=8&lang=en`
    );
    if (search.ok) {
      const json = JSON.parse(search.body) as { Items?: Array<{ ProductId?: string }> };
      const id = json.Items?.[0]?.ProductId;
      if (id) {
        const url = `https://new.abb.com/products/${encodeURIComponent(id)}`;
        const r = await fetchOnce(url);
        if (r.ok) return { url, status: r.status, body: r.body };
      }
    }
  } catch {}
  return { url: urls[0], status: 0, body: "" };
}

async function main() {
  const args = process.argv.slice(2);
  const catalogs = args.length > 0 ? args : DEFAULT;
  console.log(`\n=== Verifying ${catalogs.length} ABB catalog numbers ===\n`);

  const rows: Array<{
    catalog: string;
    attrs: number;
    docs: number;
    status: string;
    title: string;
    voltage: string;
    current: string;
    weight: string;
    dim: string;
    datasheet: string;
    cad: string;
    cert: string;
    related: number;
  }> = [];

  const connector = new ABBConnector();
  for (const catalog of catalogs) {
    process.stdout.write(`\n[${catalog}] scraping... `);
    const parsed = await connector.scrape(catalog, makeContext());
    console.log(`status=${parsed.status} attrs=${parsed.attributes.length} docs=${parsed.documents.length}`);
    if (parsed.diagnostics?.terminal) console.log(`terminal=${parsed.diagnostics.terminal.reason}; notes=${parsed.diagnostics.notes?.join(" | ") ?? "-"}`);
    const find = (re: RegExp) =>
      parsed.attributes.find((a) => re.test(`${a.group ?? ""} ${a.name}`))?.value ?? "-";
    const relatedCount = parsed.attributes.filter((a) => /related|accessor|spare|variant|used with/i.test(`${a.group ?? ""} ${a.name}`)).length;
    rows.push({
      catalog,
      attrs: parsed.attributes.length,
      docs: parsed.documents.length,
      status: parsed.status,
      title: (parsed.title ?? "").slice(0, 36),
      voltage: parsed.normalized.voltage ?? find(/voltage/i),
      current: parsed.normalized.current ?? find(/current/i),
      weight: parsed.normalized.weight ?? find(/weight/i),
      dim: parsed.normalized.dimensions ?? "-",
      datasheet: parsed.documents.some((d) => d.type === "datasheet") ? "yes" : "-",
      cad: parsed.documents.some((d) => d.type === "cad") ? "yes" : "-",
      cert: parsed.documents.filter((d) => d.type === "certificate").length.toString(),
      related: relatedCount
    });
  }

  console.log("\n\n==========================================================================================");
  console.log("Catalog          | st     | atr | doc | ds  | cad | crt | rel | volt          | weight       | dim");
  console.log("---------------- | ------ | --- | --- | --- | --- | --- | --- | ------------- | ------------ | ----------");
  for (const r of rows) {
    console.log(
      `${r.catalog.padEnd(16)} | ${r.status.padEnd(6)} | ${String(r.attrs).padStart(3)} | ${String(r.docs).padStart(3)} | ${r.datasheet.padEnd(3)} | ${r.cad.padEnd(3)} | ${r.cert.padStart(3)} | ${String(r.related).padStart(3)} | ${(r.voltage || "-").padEnd(13).slice(0, 13)} | ${(r.weight || "-").padEnd(12).slice(0, 12)} | ${(r.dim || "-").slice(0, 20)}`
    );
  }
  console.log("==========================================================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
