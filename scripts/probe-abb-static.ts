/**
 * Static probe: directly fetches an ABB product page via node-fetch and PowerShell,
 * parses with the existing ABB parser, and prints what's extracted.
 *
 *   "C:\Program Files\nodejs\node.exe" --import tsx scripts/probe-abb-static.ts 1SDA126493R1
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAbbProductPage } from "../src/server/scrapers/abb.js";

const CATALOG = process.argv[2] || "1SDA126493R1";

const ABB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

async function fetchOne(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    headers: {
      "user-agent": ABB_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9"
    },
    redirect: "follow"
  });
  return { status: response.status, body: await response.text() };
}

async function main() {
  const urls = [
    `https://new.abb.com/products/${encodeURIComponent(CATALOG)}`,
    `https://new.abb.com/products/en/${encodeURIComponent(CATALOG)}`,
    `https://search.abb.com/library/Download.aspx?DocumentID=${encodeURIComponent(CATALOG)}&Action=Launch`
  ];
  for (const url of urls) {
    console.log(`\n=== ${url}`);
    try {
      const { status, body } = await fetchOne(url);
      console.log(`status=${status} body-length=${body.length}`);
      // Detect if ABB returned a real product page or a placeholder.
      const hasModel = /\bvar\s+model\s*=/.test(body);
      const hasJsonLd = /application\/ld\+json/.test(body);
      const hasH1 = /<h1[^>]*>([^<]+)<\/h1>/i.exec(body);
      console.log(`hasModel=${hasModel} hasJsonLd=${hasJsonLd} h1="${hasH1?.[1]?.slice(0, 80) ?? ""}"`);
      if (status < 400 && hasModel) {
        const parsed = parseAbbProductPage(CATALOG, {
          requestedUrl: url,
          effectiveUrl: url,
          statusCode: status,
          contentType: "text/html",
          text: body,
          fetchedAt: new Date().toISOString(),
          fromCache: false
        });
        console.log(`status=${parsed.status} attrs=${parsed.attributes.length} docs=${parsed.documents.length}`);
        const groups = new Map<string, number>();
        for (const a of parsed.attributes) groups.set(a.group ?? "", (groups.get(a.group ?? "") ?? 0) + 1);
        console.log("Groups:");
        for (const [g, c] of [...groups.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${g}: ${c}`);
        console.log("First 20 attributes:");
        for (const a of parsed.attributes.slice(0, 20)) console.log(`  [${a.group}] ${a.name}: ${(a.value ?? "").slice(0, 100)}`);
        console.log(`Docs (${parsed.documents.length}):`);
        for (const d of parsed.documents.slice(0, 15)) console.log(`  ${d.type}: ${d.label.slice(0, 50)} -> ${d.url.slice(0, 120)}`);
        // Save the HTML for offline inspection.
        const dump = path.join("scripts", `abb-${CATALOG}.html`);
        fs.writeFileSync(dump, body);
        console.log(`Saved HTML to ${dump}`);
        break;
      }
    } catch (err) {
      console.log(`ERR: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
