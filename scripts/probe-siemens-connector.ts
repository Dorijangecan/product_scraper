import path from "node:path";
import { fileURLToPath } from "node:url";
import { getManufacturerConfig, initializeManufacturerConfig } from "../src/server/config/manufacturers.js";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { GenericFallbackScraper } from "../src/server/scrapers/generic.js";
import { CachedHttpClient } from "../src/server/scrapers/http-client.js";
import { getConnector } from "../src/server/scrapers/index.js";
import { finalizeQualityGate } from "../src/server/scrapers/quality-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const appPaths = createAppPaths(rootDir);
initializeManufacturerConfig(appPaths.dataDir);

const numbers = process.argv.slice(2);
if (!numbers.length) numbers.push("S55180-A179", "S55499-D820");

const manufacturer = getManufacturerConfig("siemens")!;
const db = new ScraperDb(appPaths);
const http = new CachedHttpClient(db, appPaths.cacheDir);
const fallback = new GenericFallbackScraper(manufacturer.id, http, manufacturer);
const connector = getConnector(manufacturer.id);

try {
  for (const cn of numbers) {
    const scraped = await connector.scrape(cn, {
      http,
      manufacturer,
      runDir: rootDir,
      documentsDir: path.join(rootDir, "benchmarks", "output", "probe-siemens"),
      signal: undefined,
      learnedEndpoints: { list: (id, limit) => db.listLearnedEndpoints(id, limit), upsert: (e) => db.upsertLearnedEndpoint(e) },
      fallback: { scrape: (c, sources) => fallback.scrape(c, sources) },
      downloadDocument: async (doc) => doc
    } as never);
    const r = finalizeQualityGate(scraped, manufacturer);
    console.log(`\n### ${cn}  status=${r.status} conf=${r.confidence} gate=${r.qualityGate?.passed} missing=${JSON.stringify(r.qualityGate?.missing ?? [])}`);
    console.log(`  title: ${r.title}`);
    console.log(`  desc:  ${r.description ?? "(none)"}`);
    console.log(`  url:   ${r.productUrl}`);
    console.log(`  attrs(${r.attributes.length}): ${r.attributes.map((a) => `${a.name}=${a.value}`).join(" | ").slice(0, 200)}`);
    console.log(`  docs(${r.documents.length}): ${r.documents.map((d) => `${d.type}:${d.url.slice(0, 60)}`).join(" | ")}`);
  }
} finally {
  db.close();
}
