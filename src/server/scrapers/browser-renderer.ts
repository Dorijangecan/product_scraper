import type { BrowserNetworkRecord, ScrapeRecipeConfig } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";

interface BrowserLike {
  newContext(options?: Record<string, unknown>): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface LocatorLike {
  count(): Promise<number>;
  nth(index: number): LocatorLike;
  click(options?: Record<string, unknown>): Promise<void>;
}

interface PageLike {
  on(event: "response", listener: (response: ResponseLike) => void): void;
  goto(url: string, options?: Record<string, unknown>): Promise<{ status(): number } | null>;
  locator(selector: string): LocatorLike;
  waitForLoadState(state: "load" | "domcontentloaded" | "networkidle", options?: Record<string, unknown>): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: string | (() => T | Promise<T>)): Promise<T>;
  content(): Promise<string>;
  close(): Promise<void>;
}

interface ResponseLike {
  url(): string;
  status(): number;
  headers(): Promise<Record<string, string>>;
  text(): Promise<string>;
}

interface ChromiumLike {
  launch(options?: Record<string, unknown>): Promise<BrowserLike>;
}

export interface RenderedPage {
  fetched?: FetchedText;
  networkTexts: FetchedText[];
  networkDiagnostics: BrowserNetworkRecord[];
  error?: string;
}

const DEFAULT_EXPAND_SELECTORS = [
  "button[aria-expanded='false']",
  "[role='button'][aria-expanded='false']",
  "summary",
  "[role='tab']",
  "button:has-text('Show more')",
  "button:has-text('Mehr anzeigen')",
  "button:has-text('Downloads')",
  "button:has-text('Classifications')",
  "button:has-text('Klassifizierungen')",
  "button:has-text('Technical data')",
  "button:has-text('Technische Daten')"
];

const OVERLAY_CLOSE_SELECTORS = [
  "button:has-text('Accept all')",
  "button:has-text('Accept All')",
  "button:has-text('I agree')",
  "button:has-text('Agree')",
  "button:has-text('Akzeptieren')",
  "button:has-text('Alle akzeptieren')",
  "button:has-text('Zustimmen')",
  "button[aria-label='Close']",
  "button[aria-label='Schliessen']",
  "button[aria-label='Schließen']",
  ".cookie button",
  "#onetrust-accept-btn-handler"
];

export async function renderProductPage(url: string, recipe: ScrapeRecipeConfig | undefined, signal?: AbortSignal): Promise<RenderedPage> {
  const session = new BrowserRenderSession();
  try {
    return await session.renderProductPage(url, recipe, signal);
  } finally {
    await session.close();
  }
}

export class BrowserRenderSession {
  private browser?: BrowserLike;
  private context?: BrowserContextLike;

  async renderProductPage(url: string, recipe: ScrapeRecipeConfig | undefined, signal?: AbortSignal): Promise<RenderedPage> {
    if (signal?.aborted) throw new Error("Cancelled by user.");
    const captured: FetchedText[] = [];
    const responseCaptures: Promise<void>[] = [];
    const networkDiagnostics: BrowserNetworkRecord[] = [];
    let page: PageLike | undefined;
    try {
      const context = await this.ensureContext();
      page = await context.newPage();
      page.on("response", (response) => {
        responseCaptures.push(captureResponse(response, captured, networkDiagnostics, signal));
      });
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: recipe?.interactionPolicy?.networkIdleTimeoutMs ?? 12000 }).catch(() => undefined);
      await clickSafeSelectors(page, [...(recipe?.interactionPolicy?.closeOverlaySelectors ?? []), ...OVERLAY_CLOSE_SELECTORS], 5, signal);
      await clickSafeSelectors(page, recipe?.interactionPolicy?.localeSelectors ?? [], 4, signal);
      await waitForRecipeSelectors(page, recipe?.interactionPolicy?.waitForSelectors ?? [], signal);
      await scrollToBottom(page, recipe?.interactionPolicy?.scrollPasses ?? 1, signal);
      await clickSafeSelectors(
        page,
        [
          ...(recipe?.interactionPolicy?.tabSelectors ?? []),
          ...(recipe?.interactionPolicy?.downloadSectionSelectors ?? []),
          ...(recipe?.interactionPolicy?.expandSelectors ?? []),
          ...(recipe?.expandSelectors ?? []),
          ...DEFAULT_EXPAND_SELECTORS
        ],
        recipe?.interactionPolicy?.maxClicks ?? 50,
        signal
      );
      await clickSafeSelectors(page, recipe?.interactionPolicy?.paginationSelectors ?? [], 12, signal);
      await scrollToBottom(page, recipe?.interactionPolicy?.scrollPasses ?? 1, signal);
      await page.waitForLoadState("networkidle", { timeout: recipe?.interactionPolicy?.networkIdleTimeoutMs ?? 12000 }).catch(() => undefined);
      await page.waitForTimeout(750);
      await Promise.allSettled(responseCaptures);
      const text = await page.content();
      const fetchedAt = new Date().toISOString();
      return {
        fetched: {
          requestedUrl: url,
          effectiveUrl: url,
          statusCode: response?.status() ?? 200,
          contentType: "text/html; rendered=playwright",
          text,
          fetchedAt,
          fromCache: false
        },
        networkTexts: captured,
        networkDiagnostics
      };
    } catch (error) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      return {
        networkTexts: captured,
        networkDiagnostics,
        error: error instanceof Error ? error.message : "Browser render failed"
      };
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = undefined;
    this.browser = undefined;
  }

  private async ensureContext(): Promise<BrowserContextLike> {
    if (this.context) return this.context;
    const { chromium } = await loadPlaywright();
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1440, height: 1200 }
    });
    return this.context;
  }
}

async function loadPlaywright(): Promise<{ chromium: ChromiumLike }> {
  const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  const loaded = await importer("playwright") as { chromium?: ChromiumLike };
  if (!loaded.chromium) throw new Error("Playwright is installed but Chromium launcher is unavailable.");
  return { chromium: loaded.chromium };
}

async function clickSafeSelectors(page: PageLike, selectors: string[], maxClicks: number, signal?: AbortSignal): Promise<void> {
  let clicks = 0;
  for (const selector of uniqueStrings(selectors)) {
    if (clicks >= maxClicks) return;
    if (signal?.aborted) throw new Error("Cancelled by user.");
    let count = 0;
    try {
      count = Math.min(await page.locator(selector).count(), maxClicks - clicks);
    } catch {
      continue;
    }
    for (let index = 0; index < count; index += 1) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      try {
        await page.locator(selector).nth(index).click({ timeout: 2500, force: false });
        clicks += 1;
        await page.waitForTimeout(150);
      } catch {
        // Some controls are invisible, already open, or covered; keep trying the rest.
      }
    }
  }
}

async function waitForRecipeSelectors(page: PageLike, selectors: string[], signal?: AbortSignal): Promise<void> {
  for (const selector of uniqueStrings(selectors).slice(0, 8)) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      try {
        if (await page.locator(selector).count()) return;
      } catch {
        // Keep waiting for the next selector or retry.
      }
      await page.waitForTimeout(250);
    }
  }
}

async function scrollToBottom(page: PageLike, passes: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Cancelled by user.");
  for (let pass = 0; pass < Math.max(1, passes); pass += 1) {
    await page.evaluate(
      `new Promise((resolve) => {
        let previousHeight = 0;
        let stableSteps = 0;
        const step = () => {
          const height = document.documentElement.scrollHeight;
          window.scrollTo(0, height);
          stableSteps = height === previousHeight ? stableSteps + 1 : 0;
          previousHeight = height;
          if (stableSteps >= 2) {
            resolve();
            return;
          }
          setTimeout(step, 250);
        };
        step();
      })`
    );
  }
}

async function captureResponse(
  response: ResponseLike,
  captured: FetchedText[],
  diagnostics: BrowserNetworkRecord[],
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted || captured.length >= 40) return;
  try {
    const headers = await response.headers();
    const contentType = headers["content-type"] ?? "";
    const url = response.url();
    diagnostics.push({
      url,
      statusCode: response.status(),
      contentType,
      category: categorizeNetworkResponse(url, contentType)
    });
    if (!/(json|text|html|javascript)/i.test(contentType)) return;
    const text = await response.text();
    if (!text.trim() || text.length > 750_000) return;
    captured.push({
      requestedUrl: url,
      effectiveUrl: url,
      statusCode: response.status(),
      contentType,
      text,
      fetchedAt: new Date().toISOString(),
      fromCache: false
    });
  } catch {
    // Browser response bodies are best-effort enrichment only.
  }
}

function categorizeNetworkResponse(url: string, contentType: string): BrowserNetworkRecord["category"] {
  const combined = `${url} ${contentType}`.toLowerCase();
  if (/\.(?:pdf|zip|dwg|dxf|stp|step)(?:[?#]|$)|\/download|\/documents?\//i.test(combined)) return "document-api";
  if (/\.(?:png|jpe?g|webp|gif|svg|avif)(?:[?#]|$)|\/image|\/assets?\//i.test(combined)) return "asset-api";
  if (/search|suggest|autocomplete/.test(combined)) return "search-api";
  if (/product|sku|catalog|article|pim|graphql|api/.test(combined) && /json|javascript|api|graphql/.test(combined)) return "product-api";
  if (/html/.test(contentType)) return "html";
  if (/text/.test(contentType)) return "text";
  return "other";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
