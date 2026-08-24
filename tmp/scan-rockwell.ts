import Database from "better-sqlite3";
import fs from "node:fs/promises";
import { parseGenericProductPage } from "../src/server/scrapers/generic.ts";

const db = new Database("data/scraper.db", { readonly: true });
const rows = db.prepare(`
  SELECT pc.url AS url, pc.path AS cachePath, MIN(ri.catalog_number) AS catalog
  FROM page_cache pc JOIN run_items ri ON ri.product_url = pc.url
  WHERE pc.status_code = 200 AND pc.url LIKE '%www.rockwellautomation.com%'
  GROUP BY pc.url LIMIT 200
`).all() as Array<{url:string;cachePath:string;catalog:string}>;

for (const row of rows) {
  const text = await fs.readFile(row.cachePath, "utf8");
  const result = parseGenericProductPage("rockwell", row.catalog, {
    requestedUrl: row.url, effectiveUrl: row.url, statusCode: 200,
    contentType: "text/html", fetchedAt: new Date(0).toISOString(), fromCache: true, text
  }, "official");
  const ids = result.attributes.filter((a) => /unique product identifier/i.test(a.name));
  if (ids.length > 1) {
    console.log(JSON.stringify({catalog: row.catalog, url: row.url, pageLevel: result.pageLevel, ids: ids.map((a) => a.value)}, null, 2));
  }
}
