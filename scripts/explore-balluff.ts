/**
 * Exploration script: opens a Balluff product page in real browser and dumps
 * every clickable section, every modal panel reachable after clicking,
 * every download in each subcategory, every video, every knowledge-base link,
 * and tells you exactly what content lives in each click target.
 *
 * Run with:
 *   "C:\Program Files\nodejs\node.exe" --import tsx scripts/explore-balluff.ts BOS0074
 */
import { chromium, type Page } from "playwright";

const CATALOG_NUMBER = process.argv[2] || "BOS0074";
const URL = `https://www.balluff.com/en-gb/products/${CATALOG_NUMBER}`;

async function dismissCookies(page: Page) {
  const selectors = [
    "button:has-text('Accept all')",
    "button:has-text('Accept All')",
    "button:has-text('I agree')",
    "button:has-text('Agree')",
    "button:has-text('Alle akzeptieren')",
    "button:has-text('Akzeptieren')",
    "button:has-text('Zustimmen')",
    "#onetrust-accept-btn-handler"
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      if (await loc.count()) {
        await loc.first().click({ timeout: 1500 });
        await page.waitForTimeout(400);
        return;
      }
    } catch {
      // ignore
    }
  }
}

async function main() {
  console.log(`\n=== Exploring ${CATALOG_NUMBER} at ${URL} ===\n`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1440, height: 1200 }
  });
  const page = await context.newPage();

  page.on("response", (resp) => {
    const url = resp.url();
    if (/publications\.balluff\.com|partcommunity|eprel\.ec\.europa\.eu|\.pdf|\.stp|\.dxf|\.dwg/.test(url)) {
      console.log(`[network] ${resp.status()} ${url}`);
    }
  });

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("load", { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  await dismissCookies(page);

  // Scroll fully — wrap each step in try/catch since the page can navigate (locale redirect).
  for (let i = 0; i < 4; i += 1) {
    try {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    } catch {}
    await page.waitForTimeout(500);
  }
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch {}
  await page.waitForTimeout(500);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);

  console.log("\n--- ALL py-5 BUTTONS (section openers) ---");
  const py5 = await page.locator("button.py-5").all();
  for (const b of py5) {
    try {
      const text = (await b.textContent())?.trim().slice(0, 80) || "";
      console.log(`  py-5 button: "${text}"`);
    } catch {}
  }

  console.log("\n--- ALL buttons with aria-expanded ---");
  const expandable = await page.locator("button[aria-expanded]").all();
  for (const b of expandable) {
    try {
      const text = (await b.textContent())?.trim().slice(0, 80) || "";
      const expanded = await b.getAttribute("aria-expanded");
      console.log(`  expanded=${expanded}: "${text}"`);
    } catch {}
  }

  console.log("\n--- ALL <summary> elements ---");
  const summaries = await page.locator("summary").all();
  for (const s of summaries) {
    try {
      const text = (await s.textContent())?.trim().slice(0, 80) || "";
      console.log(`  summary: "${text}"`);
    } catch {}
  }

  // Open every section in sequence and explore inside
  const sectionLabels = [
    "Key features",
    "Downloads",
    "Classifications",
    "Digital Product Passport",
    "Knowledge Base articles",
    "Videos",
    "Alternative products",
    "Accessories",
    "Spare parts",
    "Related products",
    "Suitable accessories"
  ];

  for (const label of sectionLabels) {
    console.log(`\n=== Opening section "${label}" ===`);
    const opener = page.locator(`button.py-5:has(div:text-is('${label}'))`).first();
    if (!(await opener.count())) {
      console.log(`  [SKIP] no opener button.py-5 with label "${label}"`);
      continue;
    }
    try {
      await opener.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
      await opener.click({ timeout: 3000 });
      await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => undefined);
      await page.waitForTimeout(1200);
    } catch (err) {
      console.log(`  [ERR] click failed: ${(err as Error).message}`);
      continue;
    }

    // Inside the opened modal/drawer: list every clickable element, look for sub-section buttons,
    // and dump anchor hrefs (PDF/CAD links live in here).
    const modalSelectors = [
      "[role='dialog']",
      "[aria-modal='true']",
      "div[class*='fixed'][class*='inset-0']",
      "[data-balluff-modal]"
    ];
    let modalRoot = page.locator(modalSelectors.join(", ")).first();
    if (!(await modalRoot.count())) modalRoot = page.locator("body").first();

    const innerButtons = await modalRoot.locator("button").all();
    console.log(`  modal buttons (${innerButtons.length}):`);
    for (const b of innerButtons.slice(0, 60)) {
      try {
        const text = (await b.textContent())?.trim().replace(/\s+/g, " ").slice(0, 100) || "";
        if (text) console.log(`    - "${text}"`);
      } catch {}
    }

    const innerAnchors = await modalRoot.locator("a[href]").all();
    console.log(`  modal anchors with href (${innerAnchors.length}):`);
    for (const a of innerAnchors.slice(0, 80)) {
      try {
        const href = await a.getAttribute("href");
        const text = (await a.textContent())?.trim().replace(/\s+/g, " ").slice(0, 80) || "";
        if (href && /publications\.balluff|partcommunity|eprel|\.pdf|knowledge|download|article|news/i.test(href)) {
          console.log(`    [link] "${text}" -> ${href}`);
        }
      } catch {}
    }

    // For Downloads specifically: click every sub-category button to expose nested docs.
    if (/Downloads/i.test(label)) {
      const subLabels = [
        "Product documentation",
        "Software",
        "Info material",
        "Technical drawing",
        "CAD/CAE Files",
        "CAD"
      ];
      for (const subLabel of subLabels) {
        const sub = page.locator(`button:has-text('${subLabel}')`).first();
        if (!(await sub.count())) continue;
        try {
          await sub.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => undefined);
          await sub.click({ timeout: 2500 });
          await page.waitForTimeout(700);
          console.log(`  [sub] opened "${subLabel}"`);
          const links = await page.locator(`a[href*='publications.balluff'], a[href*='partcommunity'], a[href*='eprel.ec.europa.eu'], a[href*='.pdf']`).all();
          for (const link of links.slice(0, 30)) {
            const href = await link.getAttribute("href");
            const text = (await link.textContent())?.trim().slice(0, 80) || "";
            if (href) console.log(`      doc: "${text}" -> ${href}`);
          }
        } catch (err) {
          console.log(`  [sub-err] "${subLabel}": ${(err as Error).message}`);
        }
      }
    }

    // Close modal with Escape
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(400);
  }

  console.log(`\n=== Done ===\n`);
  await browser.close();
}

main().catch((err) => {
  console.error("explore failed:", err);
  process.exit(1);
});
