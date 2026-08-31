/**
 * Feeds the PIS API payload through the exact synthetic-HTML shape `fetchAbbPisApiResult`
 * builds, then prints what parseAbbProductPage makes of it. Offline once the payload is
 * cached, so it isolates parser accuracy from network behaviour.
 *
 *   "C:\Program Files\nodejs\node.exe" --import tsx scripts/probe-abb-pis-parse.ts 1SDA130199R1 [en|de]
 */
import fs from "node:fs";
import path from "node:path";
import { parseAbbProductPage } from "../src/server/scrapers/abb.js";

const catalogNumber = process.argv[2] ?? "1SDA130199R1";
const lang = process.argv[3] ?? "en";
const cachePath = path.join("tmp", `abb-pis-${catalogNumber}-${lang}.json`);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

async function loadPayload(): Promise<Record<string, unknown>> {
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const token = (await (await fetch("https://new.abb.com/api/PisSearchApi/Token", { headers: { accept: "application/json", "user-agent": UA } })).json()) as { Token: string };
  const body = {
    appSettings: { appCode: "9AAG8556", langCode: lang, internalUser: false, anonymousUser: false, treeType: "Products", productRelationshipFiltering: true },
    dataTypes: [
      "ProductDetails",
      "AttributeGroups",
      "ProductClassifications",
      "ProductRelationships",
      "InteractiveGuides",
      "ProductVariantsSelector",
      "ProductVariantsTable",
      "ProductVariantsDropdown",
      "RelatedLinks"
    ],
    search: { productId: catalogNumber }
  };
  const response = await fetch("https://external.productinformation.abb.com/PisWebApi/v1/Products/Detail", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token.Token}`, "Component-Version": "6.15.0" },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as Record<string, unknown>;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(payload, null, 1), "utf8");
  return payload;
}

const payload = await loadPayload();
const effectiveUrl = `https://new.abb.com/products/${catalogNumber}`;
const model = {
  ProductViewModel: {
    Product: payload,
    AppSettings: { appCode: "9AAG8556", langCode: lang, internalUser: false, anonymousUser: false, treeType: "Products", productRelationshipFiltering: true },
    ApiUrl: "https://external.productinformation.abb.com/PisWebApi/v1/"
  }
};
const syntheticHtml = `<script>var model = ${JSON.stringify(model).replace(/</g, "\\u003c")};</script>`;

const result = parseAbbProductPage(catalogNumber, {
  requestedUrl: effectiveUrl,
  effectiveUrl,
  statusCode: 200,
  contentType: "application/json",
  text: syntheticHtml,
  fetchedAt: new Date().toISOString(),
  fromCache: false
});

console.log(`status=${result.status} confidence=${result.confidence}`);
console.log(`title=${JSON.stringify(result.title)}`);
console.log(`description=${JSON.stringify(result.description)}`);
console.log(`productUrl=${result.productUrl}`);
console.log(`normalized=${JSON.stringify(result.normalized, null, 1)}`);
console.log(`documents (${result.documents.length}):`);
for (const doc of result.documents) console.log(`  ${doc.type.padEnd(11)} ${doc.label} -> ${doc.url}`);
console.log(`attributes (${result.attributes.length}):`);
for (const attr of result.attributes) console.log(`  [${attr.group ?? ""}] ${attr.name} = ${attr.value}`);
