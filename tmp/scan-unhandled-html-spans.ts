import Database from "better-sqlite3";
import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import { readHtmlTableAttributes } from "../src/server/scrapers/html-table-reader.ts";

const db = new Database("data/scraper.db", { readonly: true });
const rows = db.prepare(`
  SELECT pc.url AS url, pc.path AS cachePath, MIN(ri.catalog_number) AS catalog
  FROM page_cache pc JOIN run_items ri ON ri.product_url = pc.url
  WHERE pc.status_code = 200 AND (pc.content_type IS NULL OR pc.content_type LIKE '%html%')
  GROUP BY pc.url ORDER BY pc.url LIMIT 5000
`).all() as Array<{url:string;cachePath:string;catalog:string}>;

let seen = 0;
for (const row of rows) {
  const html = await fs.readFile(row.cachePath, "utf8");
  const $ = cheerio.load(html);
  const spanTables = $("table").filter((_, table) => $(table).find("[colspan],[rowspan]").length > 0);
  if (!spanTables.length) continue;
  const read = readHtmlTableAttributes($, row.catalog ?? "", row.url);
  const unhandled = spanTables.filter((_, table) => !read.handledTables.has(table)).length;
  if (!unhandled) continue;
  seen += 1;
  console.log(JSON.stringify({host:new URL(row.url).hostname,catalog:row.catalog,url:row.url,spanTables:spanTables.length,handled:read.handledTables.size,unhandled,attributes:read.attributes.length}));
  if (seen >= 80) break;
}
console.error(`scanned ${rows.length}, candidates ${seen}`);
