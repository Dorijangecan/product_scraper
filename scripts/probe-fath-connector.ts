import path from "node:path";
import { fileURLToPath } from "node:url";
import { getManufacturerConfig, initializeManufacturerConfig } from "../src/server/config/manufacturers.js";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { GenericFallbackScraper } from "../src/server/scrapers/generic.js";
import { CachedHttpClient } from "../src/server/scrapers/http-client.js";
import { getConnector } from "../src/server/scrapers/index.js";
import { BrowserRenderSession } from "../src/server/scrapers/browser-renderer.js";
import { finalizeQualityGate } from "../src/server/scrapers/quality-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const appPaths = createAppPaths(rootDir);
initializeManufacturerConfig(appPaths.dataDir);

const catalogNumber = process.argv[2] ?? "098ABG045";
const manufacturer = getManufacturerConfig("fath");
if (!manufacturer) throw new Error("FATH manufacturer not configured");

const db = new ScraperDb(appPaths);
const http = new CachedHttpClient(db, appPaths.cacheDir);
const browserRenderer = new BrowserRenderSession();
const fallback = new GenericFallbackScraper(manufacturer.id, http, manufacturer);
const connector = getConnector(manufacturer.id);

try {
  console.log(`\n=== FATH scrape probe: ${catalogNumber} ===\n`);
  const scraped = await connector.scrape(catalogNumber, {
    http,
    manufacturer,
    runDir: rootDir,
    documentsDir: path.join(rootDir, "benchmarks", "output", "probe-fath"),
    signal: undefined,
    browserRenderer,
    learnedEndpoints: {
      list: (id, limit) => db.listLearnedEndpoints(id, limit),
      upsert: (endpoint) => db.upsertLearnedEndpoint(endpoint)
    },
    fallback: { scrape: (cn, sources) => fallback.scrape(cn, sources) },
    downloadDocument: async (doc) => doc
  });
  const result = finalizeQualityGate(scraped, manufacturer);

  console.log(`status:     ${result.status}`);
  console.log(`confidence: ${result.confidence}`);
  console.log(`title:      ${result.title ?? "(none)"}`);
  console.log(`productUrl: ${result.productUrl ?? "(none)"}`);
  console.log(`description: ${result.description ?? "(none)"}`);

  console.log(`\n--- documents (${result.documents.length}) ---`);
  for (const doc of result.documents) {
    console.log(`  ${doc.type.padEnd(11)} ${doc.label}`);
    console.log(`              -> ${doc.url}`);
  }

  console.log(`\n--- attributes (${result.attributes.length}) ---`);
  for (const attr of result.attributes.slice(0, 20)) {
    console.log(`  [${attr.group ?? ""}] ${attr.name}: ${attr.value}`);
  }
  if (result.attributes.length > 20) console.log(`  ... and ${result.attributes.length - 20} more`);

  console.log(`\n--- diagnostics ---`);
  console.dir(result.diagnostics, { depth: 4 });
} finally {
  await browserRenderer.close();
  db.close();
}
