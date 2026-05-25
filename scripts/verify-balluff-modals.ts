/**
 * Verifies that the Balluff modal-sequence renderer actually opens all 5 sections
 * (Key features, Downloads, Classifications, Digital Product Passport, Knowledge Base
 * articles) and that the Digital Product Passport modal yields a Weight value.
 *
 * Run with:
 *   "C:\Program Files\nodejs\node.exe" --import tsx scripts/verify-balluff-modals.ts BCC039H
 */
import { BrowserRenderSession } from "../src/server/scrapers/browser-renderer.js";
import { parseBalluffProductPage } from "../src/server/scrapers/balluff.js";

const BALLUFF_MODAL_SECTIONS = [
  {
    label: "Key features",
    openSelectors: [
      "button:has-text('Key features')",
      "[role='button']:has-text('Key features')",
      "a:has-text('Key features')"
    ],
    contentMarkerSelectors: ["text=Operating voltage Ub", "text=Housing material", "text=IP rating"]
  },
  {
    label: "Downloads",
    openSelectors: [
      "button:has-text('Downloads')",
      "[role='button']:has-text('Downloads')",
      "a:has-text('Downloads')"
    ],
    subOpenSelectors: [
      "button:has-text('Product documentation')",
      "button:has-text('Software')",
      "button:has-text('Info material')",
      "button:has-text('Technical drawing')",
      "button:has-text('CAD/CAE Files')"
    ],
    contentMarkerSelectors: ["text=Product documentation", "text=CAD/CAE"]
  },
  {
    label: "Classifications",
    openSelectors: [
      "button:has-text('Classifications')",
      "[role='button']:has-text('Classifications')",
      "a:has-text('Classifications')"
    ],
    contentMarkerSelectors: ["text=ECLASS", "text=ETIM", "text=UNSPSC"]
  },
  {
    label: "Digital Product Passport",
    openSelectors: [
      "button:has-text('Digital Product Passport')",
      "[role='button']:has-text('Digital Product Passport')",
      "a:has-text('Digital Product Passport')"
    ],
    contentMarkerSelectors: ["text=Weight", "text=Tariff Code", "text=Country of origin"]
  },
  {
    label: "Knowledge Base articles",
    openSelectors: [
      "button:has-text('Knowledge Base articles')",
      "[role='button']:has-text('Knowledge Base articles')",
      "a:has-text('Knowledge Base articles')"
    ]
  }
];

async function main() {
  const catalogNumber = process.argv[2] || "BCC039H";
  const url = `https://www.balluff.com/en-gb/products/${catalogNumber}`;
  console.log(`\n=== Verifying ${catalogNumber} at ${url} ===\n`);

  const session = new BrowserRenderSession();
  try {
    const rendered = await session.renderProductPageWithModalSequence(url, undefined, BALLUFF_MODAL_SECTIONS);
    console.log(`\nRender error: ${rendered.error ?? "none"}`);
    console.log(`Section fragments captured: ${rendered.sectionFragments.length}`);
    for (const fragment of rendered.sectionFragments) {
      console.log(`  - ${fragment.label.padEnd(35)} ${fragment.html.length} bytes`);
    }

    if (!rendered.fetched) {
      console.error("\nNO HTML CAPTURED — abort");
      process.exit(1);
    }

    const combined = rendered.fetched.text;
    console.log(`\nCombined HTML length: ${combined.length} bytes`);

    // Check that section markers are present in the combined HTML
    const checks = [
      { name: "Key features marker", pattern: /operating voltage ub/i },
      { name: "Downloads marker", pattern: /product documentation|cad\/cae|technical drawing/i },
      { name: "Classifications ECLASS", pattern: /\beclass\b/i },
      { name: "Classifications ETIM", pattern: /\betim\b/i },
      { name: "Classifications UNSPSC", pattern: /\bunspsc\b/i },
      { name: "DPP Weight", pattern: /\bweight\b/i },
      { name: "DPP Tariff Code", pattern: /tariff code|taric code/i },
      { name: "DPP Country of origin", pattern: /country of origin/i }
    ];
    console.log(`\n=== Marker presence in combined HTML ===`);
    let allOk = true;
    for (const check of checks) {
      const hit = check.pattern.test(combined);
      console.log(`  ${hit ? "[OK]  " : "[MISS]"} ${check.name}`);
      if (!hit) allOk = false;
    }

    // Now actually parse and look for the Weight value
    console.log(`\n=== Parsing combined HTML with Balluff parser ===`);
    const result = parseBalluffProductPage(catalogNumber, rendered.fetched, { parser: "verify-script" });
    console.log(`Status: ${result.status}, confidence: ${result.confidence}`);
    console.log(`Attributes: ${result.attributes.length}, Documents: ${result.documents.length}`);
    console.log(`Normalized weight: ${result.normalized.weight ?? "(none)"}`);
    console.log(`Normalized dimensions: ${result.normalized.dimensions ?? "(none)"}`);
    console.log(`Normalized voltage: ${result.normalized.voltage ?? "(none)"}`);
    console.log(`Normalized current: ${result.normalized.current ?? "(none)"}`);

    // Find Weight-like attribute
    const weightAttr = result.attributes.find((attr) => /weight|gewicht/i.test(`${attr.group ?? ""} ${attr.name}`));
    if (weightAttr) {
      console.log(`Weight attribute found: group="${weightAttr.group}" name="${weightAttr.name}" value="${weightAttr.value}"`);
    } else {
      console.log(`NO WEIGHT ATTRIBUTE in result.attributes`);
      allOk = false;
    }

    // Find DPP-grouped attributes
    const dppAttrs = result.attributes.filter((attr) => /digital product passport/i.test(attr.group ?? ""));
    console.log(`\nDPP-grouped attributes (${dppAttrs.length}):`);
    for (const attr of dppAttrs.slice(0, 15)) {
      console.log(`  ${attr.name}: ${attr.value}`);
    }

    // Find Key features attributes
    const keyAttrs = result.attributes.filter((attr) => /key features/i.test(attr.group ?? ""));
    console.log(`\nKey features attributes (${keyAttrs.length}):`);
    for (const attr of keyAttrs.slice(0, 15)) {
      console.log(`  ${attr.name}: ${attr.value}`);
    }

    // Find Classifications
    const classAttrs = result.attributes.filter((attr) => /classifications/i.test(attr.group ?? ""));
    console.log(`\nClassification attributes (${classAttrs.length}):`);
    for (const attr of classAttrs.slice(0, 10)) {
      console.log(`  ${attr.name}: ${attr.value}`);
    }

    // Datasheets / CAD documents
    const datasheets = result.documents.filter((doc) => doc.type === "datasheet" || doc.type === "cad" || doc.type === "manual");
    console.log(`\nDatasheet/CAD/Manual documents (${datasheets.length}):`);
    for (const doc of datasheets.slice(0, 10)) {
      console.log(`  ${doc.type}: ${doc.label} -> ${doc.url}`);
    }

    console.log(`\n=== ${allOk ? "VERIFICATION PASSED" : "VERIFICATION INCOMPLETE — see misses above"} ===\n`);
    process.exit(allOk ? 0 : 1);
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error("Verification failed:", error);
  process.exit(2);
});
