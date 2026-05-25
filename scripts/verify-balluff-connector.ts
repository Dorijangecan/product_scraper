import os from "node:os";
import path from "node:path";
import { BalluffConnector } from "../src/server/scrapers/balluff.js";
import { BrowserRenderSession } from "../src/server/scrapers/browser-renderer.js";
import { CachedHttpClient } from "../src/server/scrapers/http-client.js";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import type { DocumentRecord } from "../src/shared/types.js";

const catalogs = process.argv.slice(2);
if (!catalogs.length) {
  catalogs.push("BTL4W6A", "BIR0005", "BDG FB058-BCR6-DSRB2-1417-0000-S8R1");
}

const db = {
  getPageCache: () => undefined,
  setPageCache: () => undefined
};

const manufacturer = getManufacturerConfig("balluff");
if (!manufacturer) throw new Error("Missing Balluff manufacturer config.");

const http = new CachedHttpClient(db as never, path.join(os.tmpdir(), "product-scraper-balluff-verify-cache"));
http.setHostMinIntervalMs(250);
const browserRenderer = new BrowserRenderSession();
const connector = new BalluffConnector();

try {
  for (const catalog of catalogs) {
    console.log(`\n--- ${catalog} ---`);
    const result = await connector.scrape(catalog, {
      http,
      manufacturer,
      runDir: os.tmpdir(),
      documentsDir: os.tmpdir(),
      browserRenderer,
      learnedEndpoints: {
        list: () => [],
        upsert: () => undefined
      },
      fallback: {
        scrape: async () => undefined
      },
      downloadDocument: async (doc: DocumentRecord) => doc
    });
    const find = (pattern: RegExp) => result.attributes.find((attr) => pattern.test(`${attr.group ?? ""} ${attr.name}`))?.value ?? "-";
    const images = result.documents.filter((doc) => doc.type === "image");
    console.log({
      status: result.status,
      productUrl: result.productUrl,
      attributes: result.attributes.length,
      documents: result.documents.length,
      images: images.length,
      weight: result.normalized.weight ?? find(/weight|gewicht/i),
      tariff: find(/tariff/i),
      datasheet: result.documents.some((doc) => doc.type === "datasheet"),
      cad: result.documents.some((doc) => doc.type === "cad"),
      parsers: result.sources.map((source) => source.parser),
      fallbackStages: result.diagnostics?.fallbackStages,
      error: result.error
    });
  }
} finally {
  await browserRenderer.close();
}
