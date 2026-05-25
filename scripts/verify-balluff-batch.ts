/**
 * Batch-verifies a list of Balluff catalog numbers by running the modal-sequence renderer
 * and the parser, then summarizes for each product:
 *   - which modal sections produced content
 *   - how many attributes / documents the parser pulled out
 *   - whether key DPP fields (weight, tariff, country) are present
 *
 * Run with:
 *   "C:\Program Files\nodejs\node.exe" --import tsx scripts/verify-balluff-batch.ts BOS0074 BCC0312 BAM01LE
 *   (no args -> uses the default test set from Testing PDT/Balluff test.csv)
 */
import { BrowserRenderSession } from "../src/server/scrapers/browser-renderer.js";
import { parseBalluffProductPage } from "../src/server/scrapers/balluff.js";

const DEFAULT_CATALOG_NUMBERS = [
  "BOS0074",
  "BES00CK",
  "BIC007F",
  "BGL0007",
  "BFO0041",
  "BCC0312",
  "BCC0HZT",
  "BCC00T8",
  "BCC0HL1",
  "BIS0004",
  "BIS00P5",
  "BIS01AF",
  "BNI0087",
  "BNI0008",
  "BUS0021",
  "BNS0173",
  "BPI0099",
  "BTL4W6A",
  "BNN000W",
  "BCS017M",
  "BSE0005",
  "BCM0003",
  "BAE00M3",
  "BIR0005",
  "BNI00JF",
  "BDG FB058-BCR6-DSRB2-1417-0000-S8R1",
  "BVS0064",
  "BMF00PM",
  "BWL000L",
  "BAM01LE"
];

const BALLUFF_VERIFY_PRODUCT_CODE_ALIASES: Record<string, string> = {
  BTL4W6A: "BTL4E6W"
};

function balluffVerifyProductCode(catalog: string): string {
  const cleaned = catalog.trim().toUpperCase();
  if (BALLUFF_VERIFY_PRODUCT_CODE_ALIASES[cleaned]) return BALLUFF_VERIFY_PRODUCT_CODE_ALIASES[cleaned];
  if (/^BDG\s+FB058-[A-Z0-9]+-DSR[BG]\d-/i.test(catalog)) return "MP11418306";
  return catalog;
}

const BALLUFF_MODAL_SECTIONS = [
  {
    label: "Key features",
    openSelectors: ["button.py-5:has(div:text-is('Key features'))"],
    contentMarkerSelectors: ["text=Operating voltage Ub", "text=Housing material", "text=IP rating"]
  },
  {
    label: "Downloads",
    openSelectors: ["button.py-5:has(div:text-is('Downloads'))"],
    subOpenSelectors: [
      "button:has-text('Product documentation')",
      "button:has-text('Software')",
      "button:has-text('Info material')",
      "button:has-text('Technical drawing')",
      "button:has-text('CAD/CAE Files')",
      "button:has-text('CAD')"
    ],
    contentMarkerSelectors: ["text=Product documentation", "text=CAD/CAE", "text=Datasheet", "text=Technical drawing"]
  },
  {
    label: "Classifications",
    openSelectors: ["button.py-5:has(div:text-is('Classifications'))"],
    contentMarkerSelectors: ["text=ECLASS", "text=ETIM", "text=UNSPSC"]
  },
  {
    label: "Digital Product Passport",
    openSelectors: ["button.py-5:has(div:text-is('Digital Product Passport'))"],
    contentMarkerSelectors: ["text=Weight", "text=Tariff Code", "text=Country of origin"]
  },
  {
    label: "Knowledge Base articles",
    openSelectors: ["button.py-5:has(div:text-is('Knowledge Base articles'))"]
  }
];

async function main() {
  const args = process.argv.slice(2);
  const catalogs = args.length > 0 ? args : DEFAULT_CATALOG_NUMBERS;

  console.log(`\n=== Batch verifying ${catalogs.length} Balluff catalog numbers ===\n`);

  const session = new BrowserRenderSession();
  const summary: Array<{
    catalog: string;
    sections: string;
    attrs: number;
    docs: number;
    weight: string;
    tariff: string;
    country: string;
    datasheet: string;
    cad: string;
    error?: string;
  }> = [];

  try {
    for (const catalog of catalogs) {
      const url = `https://www.balluff.com/en-gb/products/${encodeURIComponent(balluffVerifyProductCode(catalog))}`;
      console.log(`\n--- ${catalog} ---`);
      try {
        const rendered = await session.renderProductPageWithModalSequence(url, undefined, BALLUFF_MODAL_SECTIONS);
        if (rendered.error || !rendered.fetched) {
          summary.push({
            catalog,
            sections: "-",
            attrs: 0,
            docs: 0,
            weight: "-",
            tariff: "-",
            country: "-",
            datasheet: "-",
            cad: "-",
            error: rendered.error || "no html"
          });
          continue;
        }
        const captured = new Set(rendered.sectionFragments.map((f) => f.label));
        const sectionsTag = BALLUFF_MODAL_SECTIONS.map((s) => (captured.has(s.label) ? s.label[0] : "_")).join("");
        const parsed = parseBalluffProductPage(catalog, rendered.fetched, { parser: "verify-batch" });
        const find = (re: RegExp) =>
          parsed.attributes.find((a) => re.test(`${a.group ?? ""} ${a.name}`))?.value ?? "-";
        const datasheetDoc = parsed.documents.find((d) => d.type === "datasheet");
        const cadDoc = parsed.documents.find((d) => d.type === "cad");
        summary.push({
          catalog,
          sections: sectionsTag,
          attrs: parsed.attributes.length,
          docs: parsed.documents.length,
          weight: find(/weight|gewicht/i),
          tariff: find(/tariff/i),
          country: find(/country of origin|herkunftsland/i),
          datasheet: datasheetDoc ? "yes" : "-",
          cad: cadDoc ? "yes" : "-"
        });
      } catch (error) {
        summary.push({
          catalog,
          sections: "-",
          attrs: 0,
          docs: 0,
          weight: "-",
          tariff: "-",
          country: "-",
          datasheet: "-",
          cad: "-",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } finally {
    await session.close();
  }

  console.log("\n\n=========================================");
  console.log("Catalog       | sect   | attr | doc | weight       | tariff      | country         | ds  | cad | error");
  console.log("------------- | ------ | ---- | --- | ------------ | ----------- | --------------- | --- | --- | -----");
  for (const row of summary) {
    console.log(
      `${row.catalog.padEnd(13)} | ${row.sections.padEnd(6)} | ${String(row.attrs).padStart(4)} | ${String(row.docs).padStart(3)} | ${row.weight.padEnd(12).slice(0, 12)} | ${row.tariff.padEnd(11).slice(0, 11)} | ${row.country.padEnd(15).slice(0, 15)} | ${row.datasheet.padEnd(3)} | ${row.cad.padEnd(3)} | ${row.error ?? ""}`
    );
  }
  console.log("=========================================");
  console.log("sect legend: each char = section (K=Key features, D=Downloads, C=Classifications, D=DPP, K=KB), _ = missed\n");
}

main().catch((error) => {
  console.error("Batch verify failed:", error);
  process.exit(1);
});
