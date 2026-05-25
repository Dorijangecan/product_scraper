/**
 * Renders an ABB product page in a real Chromium browser, dumps every clickable
 * accordion / tab / expand button / disclosure widget, opens every section it can find,
 * and reports:
 *   - what got captured before clicking anything (static-HTML model)
 *   - what got captured after clicking everything (browser-rendered DOM)
 *
 * Run with:
 *   "C:\Program Files\nodejs\node.exe" --import tsx scripts/explore-abb.ts 1SDA126493R1
 */
import { chromium, type Page } from "playwright";
import { parseAbbProductPage } from "../src/server/scrapers/abb.js";

const CATALOG = process.argv[2] || "1SDA126493R1";

async function dismissCookies(page: Page) {
  const sel = [
    "button:has-text('Accept all')",
    "button:has-text('Accept All')",
    "button:has-text('I accept')",
    "button:has-text('Agree')",
    "button:has-text('Accept')",
    "button#onetrust-accept-btn-handler",
    "[aria-label='Accept all cookies']"
  ];
  for (const s of sel) {
    try {
      const loc = page.locator(s);
      if (await loc.count()) {
        await loc.first().click({ timeout: 1500 });
        await page.waitForTimeout(400);
        return;
      }
    } catch {}
  }
}

async function main() {
  const url = `https://new.abb.com/products/${encodeURIComponent(CATALOG)}`;
  console.log(`\n=== Exploring ${CATALOG} at ${url} ===\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"]
  });
  const ctx = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1440, height: 1200 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    extraHTTPHeaders: {
      "accept-language": "en-US,en;q=0.9",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  const page = await ctx.newPage();
  // Retry navigation a couple of times — ABB has sporadic HTTP/2 protocol issues.
  let navOk = false;
  for (let attempt = 0; attempt < 3 && !navOk; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      navOk = true;
    } catch (e) {
      console.log(`[nav-retry ${attempt + 1}] ${(e as Error).message}`);
      await page.waitForTimeout(1500);
    }
  }
  if (!navOk) {
    console.error("Could not navigate after retries");
    await browser.close();
    process.exit(1);
  }

  const docLinks: string[] = [];
  page.on("response", (resp) => {
    const u = resp.url();
    if (/library\/Download\.aspx|cdn\.productimages|\.pdf|\.zip|\.stp|\.dxf|\.dwg/i.test(u)) {
      docLinks.push(`${resp.status()} ${u.slice(0, 140)}`);
    }
  });

  await page.waitForLoadState("load", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  await dismissCookies(page);

  console.log(`Effective URL: ${page.url()}`);
  console.log(`Title: ${await page.title()}`);

  // Scroll a few times so lazy-loaded content materializes.
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

  // Baseline: parse before any clicks.
  const beforeHtml = await page.content();
  const beforeParsed = parseAbbProductPage(CATALOG, {
    requestedUrl: url,
    effectiveUrl: page.url(),
    statusCode: 200,
    contentType: "text/html",
    text: beforeHtml,
    fetchedAt: new Date().toISOString(),
    fromCache: false
  });
  console.log(`\n--- BEFORE clicks: attrs=${beforeParsed.attributes.length}, docs=${beforeParsed.documents.length}, status=${beforeParsed.status}`);
  console.log(`Groups present:`);
  const beforeGroups = new Map<string, number>();
  for (const a of beforeParsed.attributes) beforeGroups.set(a.group ?? "", (beforeGroups.get(a.group ?? "") ?? 0) + 1);
  for (const [g, c] of beforeGroups) console.log(`  ${g}: ${c}`);

  // Identify every clickable element that looks like an accordion / tab / disclosure.
  console.log(`\n--- Clickable elements on page ---`);
  const ariaExpanded = await page.locator("[aria-expanded='false']").all();
  console.log(`  aria-expanded='false' count: ${ariaExpanded.length}`);
  for (const el of ariaExpanded.slice(0, 30)) {
    try {
      const tag = await el.evaluate((node) => node.tagName);
      const text = (await el.textContent())?.trim().replace(/\s+/g, " ").slice(0, 80) || "";
      const role = await el.getAttribute("role");
      const cls = (await el.getAttribute("class") || "").slice(0, 60);
      console.log(`    [${tag}${role ? ` role=${role}` : ""}] cls="${cls}" text="${text}"`);
    } catch {}
  }

  const summaries = await page.locator("summary").all();
  console.log(`  <summary> count: ${summaries.length}`);
  for (const s of summaries.slice(0, 30)) {
    try {
      const text = (await s.textContent())?.trim().replace(/\s+/g, " ").slice(0, 80) || "";
      console.log(`    summary: "${text}"`);
    } catch {}
  }

  const tabs = await page.locator("[role='tab']").all();
  console.log(`  role='tab' count: ${tabs.length}`);
  for (const t of tabs.slice(0, 20)) {
    try {
      const text = (await t.textContent())?.trim().slice(0, 80) || "";
      const selected = await t.getAttribute("aria-selected");
      console.log(`    tab(selected=${selected}): "${text}"`);
    } catch {}
  }

  // Try common ABB labels for accordions.
  const labels = [
    "Specifications",
    "Documents",
    "Documentation",
    "Description",
    "Features and Benefits",
    "Approvals",
    "Ratings",
    "Ordering",
    "Accessories",
    "Related Products",
    "Spare parts",
    "Compare",
    "Software",
    "Downloads",
    "Datasheets",
    "Drawings",
    "Manuals",
    "Certificates",
    "Show more",
    "More details",
    "Read more",
    "Expand all",
    "View all"
  ];
  console.log(`\n--- Trying common ABB label clicks ---`);
  for (const label of labels) {
    const sels = [
      `button:has-text('${label}')`,
      `[role='button']:has-text('${label}')`,
      `a:has-text('${label}')`,
      `summary:has-text('${label}')`,
      `h2:has-text('${label}')`,
      `h3:has-text('${label}')`
    ];
    let hit = false;
    for (const sel of sels) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count();
        if (!count) continue;
        for (let i = 0; i < Math.min(count, 3); i += 1) {
          try {
            const el = loc.nth(i);
            await el.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => undefined);
            await el.click({ timeout: 2000, force: false });
            await page.waitForTimeout(350);
            console.log(`  [OK] clicked "${label}" via ${sel}`);
            hit = true;
            break;
          } catch {}
        }
        if (hit) break;
      } catch {}
    }
  }

  // Click ALL aria-expanded='false' buttons (single pass).
  console.log(`\n--- Clicking ALL aria-expanded='false' ---`);
  let expandedCount = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const more = await page.locator("[aria-expanded='false']").all();
    if (!more.length) break;
    for (const el of more) {
      try {
        await el.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => undefined);
        await el.click({ timeout: 1500 }).catch(() => undefined);
        expandedCount += 1;
        await page.waitForTimeout(120);
      } catch {}
    }
  }
  console.log(`  expanded ${expandedCount} elements over passes`);
  // Click <summary> elements too.
  const sumEls = await page.locator("summary").all();
  for (const s of sumEls) {
    try {
      await s.click({ timeout: 1000 }).catch(() => undefined);
      await page.waitForTimeout(100);
    } catch {}
  }
  // Click ALL tabs in turn so each section's content is loaded into the DOM.
  const tabEls = await page.locator("[role='tab']").all();
  for (const t of tabEls) {
    try {
      await t.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => undefined);
      await t.click({ timeout: 1500 }).catch(() => undefined);
      await page.waitForTimeout(300);
    } catch {}
  }

  // Final scroll pass to flush any lazy content triggered by tab activation.
  for (let i = 0; i < 3; i += 1) {
    try {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    } catch {}
    await page.waitForTimeout(400);
  }
  await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => undefined);

  const afterHtml = await page.content();
  const afterParsed = parseAbbProductPage(CATALOG, {
    requestedUrl: url,
    effectiveUrl: page.url(),
    statusCode: 200,
    contentType: "text/html",
    text: afterHtml,
    fetchedAt: new Date().toISOString(),
    fromCache: false
  });
  console.log(`\n--- AFTER clicks: attrs=${afterParsed.attributes.length}, docs=${afterParsed.documents.length}, status=${afterParsed.status}`);
  const afterGroups = new Map<string, number>();
  for (const a of afterParsed.attributes) afterGroups.set(a.group ?? "", (afterGroups.get(a.group ?? "") ?? 0) + 1);
  for (const [g, c] of afterGroups) console.log(`  ${g}: ${c}`);

  console.log(`\n--- Document URLs captured (network-observed) ---`);
  for (const l of [...new Set(docLinks)].slice(0, 30)) console.log(`  ${l}`);

  console.log(`\n--- Documents in parsed result ---`);
  for (const d of afterParsed.documents.slice(0, 30)) {
    console.log(`  ${d.type}: ${d.label} -> ${d.url.slice(0, 120)}`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error("explore-abb failed:", err);
  process.exit(1);
});
