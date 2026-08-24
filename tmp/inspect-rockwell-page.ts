import Database from "better-sqlite3";
import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import { readHtmlTableAttributes } from "../src/server/scrapers/html-table-reader.ts";
import { parseGenericProductPage } from "../src/server/scrapers/generic.ts";

const db = new Database("data/scraper.db", { readonly: true });
const row = db.prepare("SELECT pc.url AS url, pc.path AS cachePath, MIN(ri.catalog_number) AS catalog FROM page_cache pc JOIN run_items ri ON ri.product_url=pc.url WHERE pc.url LIKE '%details.1606-XLE240ERL.html%' GROUP BY pc.url LIMIT 1").get() as {url:string;cachePath:string;catalog:string};
const html = await fs.readFile(row.cachePath, "utf8");
const $ = cheerio.load(html);
const read = readHtmlTableAttributes($, row.catalog, row.url);
console.log(JSON.stringify({row,handled:read.handledTables.size,attrs:read.attributes},null,2));
$("table").each((i,table)=>{
  const spans=$(table).find("[colspan],[rowspan]").length;
  if (!spans) return;
  console.log(`TABLE ${i} handled=${read.handledTables.has(table)} spans=${spans}`);
  console.log($(table).text().replace(/\s+/g," ").slice(0,2000));
});
const parsed=parseGenericProductPage("rockwell",row.catalog,{requestedUrl:row.url,effectiveUrl:row.url,statusCode:200,contentType:"text/html",fetchedAt:new Date(0).toISOString(),fromCache:true,text:html},"official");
console.log(JSON.stringify({count:parsed.attributes.length,attrs:parsed.attributes},null,2));
