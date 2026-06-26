import * as fs from "node:fs";
import * as path from "node:path";
import type { BrowserNetworkRecord, ScrapeRecipeConfig } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import { adaptiveInteractionSelectors } from "./interaction-explorer.js";

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
  scrollIntoViewIfNeeded?(options?: Record<string, unknown>): Promise<void>;
}

interface KeyboardLike {
  press(key: string): Promise<void>;
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
  keyboard: KeyboardLike;
  route(url: string | RegExp | ((url: URL) => boolean), handler: (route: RouteLike) => unknown): Promise<void>;
}

interface RouteLike {
  request(): { resourceType(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
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

export interface ModalSection {
  /** Friendly label used in synthetic HTML wrapper (e.g. "Key features"). */
  label: string;
  /** Selectors to try in order to open the modal. First match wins. */
  openSelectors: string[];
  /** Optional: selectors to click INSIDE the opened modal (e.g. Downloads sub-categories). */
  subOpenSelectors?: string[];
  /** Selectors that, if present in DOM, confirm the modal is open. */
  contentMarkerSelectors?: string[];
}

export interface RenderedModalSequence extends RenderedPage {
  /** Per-section HTML fragments captured while each modal was open. */
  sectionFragments: Array<{ label: string; html: string }>;
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
  private unavailableReason?: string;
  /**
   * Number of consecutive launch failures that have occurred. We only stop trying
   * after MAX_LAUNCH_FAILURES so a transient first-launch hiccup (e.g. Chromium
   * binary still finishing install, AV scan in progress) doesn't doom the whole run.
   */
  private launchFailureCount = 0;
  private static readonly MAX_LAUNCH_FAILURES = 5;
  /** The last underlying Playwright error message — surfaced in logs so users can actually fix the cause. */
  private lastLaunchError?: string;
  /** Discovered Chromium executablePath fallback (when Playwright's default resolution fails). */
  private discoveredExecutablePath?: string;

  isUnavailable(): boolean {
    return Boolean(this.unavailableReason);
  }

  getLastLaunchError(): string | undefined {
    return this.lastLaunchError;
  }

  async renderProductPage(url: string, recipe: ScrapeRecipeConfig | undefined, signal?: AbortSignal): Promise<RenderedPage> {
    if (signal?.aborted) throw new Error("Cancelled by user.");
    if (this.unavailableReason) {
      return {
        networkTexts: [],
        networkDiagnostics: [],
        error: this.unavailableReason
      };
    }
    const captured: FetchedText[] = [];
    const responseCaptures: Promise<void>[] = [];
    const networkDiagnostics: BrowserNetworkRecord[] = [];
    const captureState = createNetworkCaptureState();
    let page: PageLike | undefined;
    try {
      const context = await this.ensureContext();
      page = await context.newPage();
      page.on("response", (response) => {
        responseCaptures.push(captureResponse(response, captured, networkDiagnostics, captureState, signal));
      });
      const blockedResourceTypes = new Set(recipe?.interactionPolicy?.blockResourceTypes ?? []);
      if (blockedResourceTypes.size > 0) {
        await page.route("**/*", (route) => {
          if (blockedResourceTypes.has(route.request().resourceType() as never)) return route.abort();
          return route.continue();
        }).catch(() => undefined);
      }
      const gotoWaitUntil = recipe?.interactionPolicy?.gotoWaitUntil ?? "domcontentloaded";
      const gotoTimeoutMs = recipe?.interactionPolicy?.gotoTimeoutMs ?? 45000;
      const response = await page.goto(url, { waitUntil: gotoWaitUntil, timeout: gotoTimeoutMs });
      // Ensure the DOM is parsed even when the caller asked for the early "commit" event
      // (commit returns as soon as response headers arrive — selectors won't exist yet).
      if (gotoWaitUntil === "commit") {
        await page.waitForLoadState("domcontentloaded", { timeout: gotoTimeoutMs }).catch(() => undefined);
      }
      await page.waitForLoadState("networkidle", { timeout: recipe?.interactionPolicy?.networkIdleTimeoutMs ?? 12000 }).catch(() => undefined);
      await clickSafeSelectors(page, [...(recipe?.interactionPolicy?.closeOverlaySelectors ?? []), ...OVERLAY_CLOSE_SELECTORS], 5, signal);
      await clickSafeSelectors(page, recipe?.interactionPolicy?.localeSelectors ?? [], 4, signal);
      await waitForRecipeSelectors(page, recipe?.interactionPolicy?.waitForSelectors ?? [], signal);
      await scrollToBottom(page, recipe?.interactionPolicy?.scrollPasses ?? 1, signal);
      await clickSafeSelectors(
        page,
        [
          ...adaptiveInteractionSelectors(recipe),
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
      const message = error instanceof Error ? error.message : "Browser render failed";
      // If Playwright Chromium isn't installed/launchable, mark the session as unavailable
      // so subsequent calls return immediately instead of burning 5+ seconds per item.
      // Surface the underlying Playwright error so logs/UI show the actual root cause.
      // We only set unavailableReason here when ensureContext itself decided the session is dead
      // (after MAX_LAUNCH_FAILURES). For one-off errors we let the next item retry.
      if (this.unavailableReason && /Chromium browser nije instaliran|Playwright paket nije instaliran/i.test(this.unavailableReason)) {
        // Already marked dead by ensureContext — keep that authoritative message.
      } else if (/Chromium browser nije instaliran|Playwright paket nije instaliran|Executable doesn't exist|playwright install/i.test(message)) {
        // First few failures: log loudly but allow retries on the next item.
        console.error(`[browser-renderer] transient launch failure (count=${this.launchFailureCount}): ${message}`);
      }
      return {
        networkTexts: captured,
        networkDiagnostics,
        error: message
      };
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  /**
   * Renders a product page and then sequentially opens each modal-style section
   * (e.g. Balluff "Key features", "Downloads", "Classifications", "Digital Product Passport").
   * For each section it:
   *   1. clicks the section opener
   *   2. waits for a modal/dialog to appear with real content
   *   3. clicks any sub-openers inside the modal (Downloads sub-categories)
   *   4. captures the full HTML (modal included) into sectionFragments
   *   5. closes the modal with Escape so the next section can be opened cleanly
   * The captured fragments are also concatenated into the main `fetched.text` so the
   * existing Balluff parser sees everything in one HTML pass.
   */
  async renderProductPageWithModalSequence(
    url: string,
    recipe: ScrapeRecipeConfig | undefined,
    sections: ModalSection[],
    signal?: AbortSignal
  ): Promise<RenderedModalSequence> {
    if (signal?.aborted) throw new Error("Cancelled by user.");
    if (this.unavailableReason) {
      return {
        networkTexts: [],
        networkDiagnostics: [],
        sectionFragments: [],
        error: this.unavailableReason
      };
    }
    const captured: FetchedText[] = [];
    const responseCaptures: Promise<void>[] = [];
    const networkDiagnostics: BrowserNetworkRecord[] = [];
    const sectionFragments: Array<{ label: string; html: string }> = [];
    const captureState = createNetworkCaptureState();
    let page: PageLike | undefined;
    try {
      const context = await this.ensureContext();
      page = await context.newPage();
      page.on("response", (response) => {
        responseCaptures.push(captureResponse(response, captured, networkDiagnostics, captureState, signal));
      });
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: Math.min(recipe?.interactionPolicy?.networkIdleTimeoutMs ?? 3000, 3000) }).catch(() => undefined);
      await clickSafeSelectors(page, [...(recipe?.interactionPolicy?.closeOverlaySelectors ?? []), ...OVERLAY_CLOSE_SELECTORS], 6, signal);
      await scrollToBottom(page, recipe?.interactionPolicy?.scrollPasses ?? 2, signal);
      await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => undefined);

      // Snapshot the main page BEFORE opening any modal so we keep the unmodified product header/specs.
      const mainHtml = await page.content();

      for (const section of sections) {
        if (signal?.aborted) throw new Error("Cancelled by user.");
        // Make sure no prior drawer is still open (Balluff drawers intercept clicks).
        await dispatchBalluffCloseSidebar(page);
        await page.waitForTimeout(75);

        const opened = await openModalSection(page, section, signal);
        if (!opened) {
          console.warn(`[balluff] modal "${section.label}" failed to open at ${url}`);
          continue;
        }

        // Wait for the drawer's Livewire content to actually load (Balluff streams it in via AJAX).
        await waitForBalluffDrawerContent(page, section, balluffDrawerInitialWaitMs(section));

        // Click configured sub-openers inside the open drawer. Balluff Downloads currently keeps
        // this to Product documentation so we avoid large non-parseable CAD/software assets.
        if (section.subOpenSelectors?.length) {
          await expandAllBalluffSubSections(page, section.subOpenSelectors, signal);
          await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => undefined);
          await page.waitForTimeout(250);
        }

        let fragment = await captureModalFragment(page, section);
        // Validate fragment actually contains expected content; if not, retry the section once.
        if (fragment && section.contentMarkerSelectors?.length) {
          let hasMarker = fragmentHasSectionMarker(fragment, section);
          if (!hasMarker) {
            await waitForBalluffDrawerContent(page, section, balluffDrawerGraceWaitMs(section));
            const delayedFragment = await captureModalFragment(page, section);
            if (delayedFragment && delayedFragment.length >= fragment.length) {
              fragment = delayedFragment;
              hasMarker = fragmentHasSectionMarker(fragment, section);
            }
          }
          if (!hasMarker && shouldReopenBalluffSection(section)) {
            console.warn(`[balluff] modal "${section.label}" opened but content markers missing at ${url}, retrying...`);
            await dispatchBalluffCloseSidebar(page);
            await closeOpenModal(page, signal);
            await page.waitForTimeout(250);
            const reopened = await openModalSection(page, section, signal);
            if (reopened) {
              await waitForBalluffDrawerContent(page, section, balluffDrawerRetryWaitMs(section));
              if (section.subOpenSelectors?.length) {
                await expandAllBalluffSubSections(page, section.subOpenSelectors, signal);
                await page.waitForTimeout(250);
              }
              fragment = (await captureModalFragment(page, section)) ?? fragment;
            }
          }
        }
        if (fragment) sectionFragments.push({ label: section.label, html: fragment });

        // Close the drawer cleanly via Alpine event before moving to the next section.
        await dispatchBalluffCloseSidebar(page);
        await closeOpenModal(page, signal);
        await page.waitForTimeout(150);
      }

      // DPP-specific safety net: weight, tariff code, and country of origin almost always live
      // in the Digital Product Passport modal. If after the main loop none of those markers are
      // anywhere in our captured fragments, retry DPP one more time with extra patience.
      const combinedSoFar = sectionFragments.map((fragment) => fragment.html).join(" ").toLowerCase();
      const hasDppMarkers = /\b(weight|gewicht|tariff code|country of origin|herkunftsland)\b/i.test(combinedSoFar);
      if (!hasDppMarkers) {
        console.warn(`[balluff] DPP markers (weight/tariff/country) missing after main sequence at ${url} — final DPP retry`);
        const dppSection = sections.find((section) => section.label === "Digital Product Passport");
        if (dppSection) {
          try {
            await closeOpenModal(page, signal);
            await page.waitForTimeout(400);
            await page.evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
            await page.waitForTimeout(300);
            const reopened = await openModalSection(page, dppSection, signal);
            if (reopened) {
              await page.waitForTimeout(1200);
              const fragment = await captureModalFragment(page, { ...dppSection, label: "Digital Product Passport (retry)" });
              if (fragment) sectionFragments.push({ label: "Digital Product Passport (retry)", html: fragment });
              await closeOpenModal(page, signal);
            } else {
              console.warn(`[balluff] DPP retry: could not reopen modal at ${url}`);
            }
          } catch (error) {
            console.warn(`[balluff] DPP retry failed at ${url}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      // Final per-section summary so the user sees exactly which sections succeeded per product.
      const capturedLabels = new Set(sectionFragments.map((fragment) => fragment.label.replace(/\s+\(retry\)$/i, "")));
      const summary = sections.map((section) => `${section.label}:${capturedLabels.has(section.label) ? "ok" : "miss"}`).join(" ");
      console.info(`[balluff] modal sequence ${url} → ${summary}`);

      await Promise.allSettled(responseCaptures);
      // Build a synthetic combined HTML so the existing Balluff text/DOM parsers see everything.
      const combinedHtml = combineHtmlWithFragments(mainHtml, sectionFragments);
      const fetchedAt = new Date().toISOString();
      return {
        fetched: {
          requestedUrl: url,
          effectiveUrl: url,
          statusCode: response?.status() ?? 200,
          contentType: "text/html; rendered=playwright-modal-sequence",
          text: combinedHtml,
          fetchedAt,
          fromCache: false
        },
        networkTexts: captured,
        networkDiagnostics,
        sectionFragments
      };
    } catch (error) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      const message = error instanceof Error ? error.message : "Browser render failed";
      // Surface the underlying Playwright error so logs/UI show the actual root cause.
      // We only set unavailableReason here when ensureContext itself decided the session is dead
      // (after MAX_LAUNCH_FAILURES). For one-off errors we let the next item retry.
      if (this.unavailableReason && /Chromium browser nije instaliran|Playwright paket nije instaliran/i.test(this.unavailableReason)) {
        // Already marked dead by ensureContext — keep that authoritative message.
      } else if (/Chromium browser nije instaliran|Playwright paket nije instaliran|Executable doesn't exist|playwright install/i.test(message)) {
        // First few failures: log loudly but allow retries on the next item.
        console.error(`[browser-renderer] transient launch failure (count=${this.launchFailureCount}): ${message}`);
      }
      return {
        networkTexts: captured,
        networkDiagnostics,
        sectionFragments,
        error: message
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

    // Attempt #1: let Playwright resolve the executable normally.
    let launched: BrowserLike | undefined;
    let firstError: Error | undefined;
    // Disable HTTP/2 because some manufacturer sites (eaton.com) violate the spec and Chromium
    // aborts the navigation with ERR_HTTP2_PROTOCOL_ERROR. HTTP/1.1 fallback is universally safe.
    const chromiumArgs = ["--disable-http2"];
    try {
      launched = await chromium.launch({ headless: true, args: chromiumArgs });
    } catch (error) {
      firstError = error instanceof Error ? error : new Error(String(error));
      const fullMessage = firstError.message;
      this.lastLaunchError = fullMessage;
      // Log the underlying Playwright error verbatim so the user can act on the real cause
      // (missing dependency, AV blocking, wrong revision, port collision, etc.).
      console.error(`[browser-renderer] Playwright chromium.launch failed: ${fullMessage}`);

      // Attempt #2: discover a cached Chromium binary and retry with explicit executablePath.
      const fallbackPath = this.discoveredExecutablePath ?? findCachedChromiumExecutable();
      if (fallbackPath) {
        this.discoveredExecutablePath = fallbackPath;
        try {
          console.warn(`[browser-renderer] retrying chromium.launch with executablePath=${fallbackPath}`);
          launched = await chromium.launch({ headless: true, executablePath: fallbackPath, args: chromiumArgs });
        } catch (retryError) {
          const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
          console.error(`[browser-renderer] executablePath fallback failed: ${retryMessage}`);
          this.lastLaunchError = `${fullMessage} | executablePath fallback: ${retryMessage}`;
        }
      }
    }

    if (!launched) {
      this.launchFailureCount += 1;
      const friendlyHint =
        "Playwright Chromium browser nije instaliran ili je blokiran. Pokreni: npx playwright install chromium " +
        "(ili pokreni Start-ProductScraper.bat koji to radi automatski). Bez Chromium-a Balluff prosirene sekcije " +
        "(Key features, Downloads, Classifications, Digital Product Passport) ne mogu se skinuti.";
      // Only mark permanently unavailable after several consecutive failures — protects against
      // a first-product race where the cache is mid-install or AV scan momentarily locks the binary.
      if (this.launchFailureCount >= BrowserRenderSession.MAX_LAUNCH_FAILURES) {
        this.unavailableReason = `${friendlyHint}\nUnderlying error: ${this.lastLaunchError ?? "unknown"}`;
      }
      throw new Error(`${friendlyHint}\nUnderlying error: ${this.lastLaunchError ?? "unknown"}`);
    }

    this.browser = launched;
    // Reset counters on success so a later transient failure doesn't immediately disable.
    this.launchFailureCount = 0;
    this.context = await this.browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1440, height: 1200 }
    });
    return this.context;
  }
}

/**
 * Scans the standard Playwright browser cache locations for an installed Chromium executable
 * and returns the first hit. Used as a fallback when Playwright's normal launcher reports
 * "Executable doesn't exist" even though the binary is present in cache.
 */
function findCachedChromiumExecutable(): string | undefined {
  // We do filesystem inspection lazily and only when launch fails, so the cost is irrelevant.
  const candidateRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : undefined,
    process.env.HOME ? path.join(process.env.HOME, ".cache", "ms-playwright") : undefined,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local", "ms-playwright") : undefined
  ].filter((value): value is string => Boolean(value));

  for (const root of candidateRoots) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root);
      // Prefer the headless-shell binary because we always launch with `headless: true`,
      // and on some Windows installs the full chrome.exe refuses to spawn (`spawn UNKNOWN`)
      // due to AV / process-execution policies, while chrome-headless-shell.exe works fine.
      // Falls back to full chromium only if headless-shell isn't available.
      const headless = entries.filter((name) => /^chromium_headless_shell-\d+$/i.test(name)).sort().reverse();
      const fullChromium = entries.filter((name) => /^chromium-\d+$/i.test(name)).sort().reverse();
      for (const dir of [...headless, ...fullChromium]) {
        const candidates = [
          path.join(root, dir, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
          path.join(root, dir, "chrome-headless-shell-mac", "headless_shell"),
          path.join(root, dir, "chrome-headless-shell-linux", "headless_shell"),
          path.join(root, dir, "chrome-win64", "chrome.exe"),
          path.join(root, dir, "chrome-win", "chrome.exe"),
          path.join(root, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
          path.join(root, dir, "chrome-linux", "chrome")
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            console.warn(`[browser-renderer] discovered cached Chromium at ${candidate}`);
            return candidate;
          }
        }
      }
    } catch {
      // Ignore unreadable cache entries; try the next root.
    }
  }
  return undefined;
}

async function loadPlaywright(): Promise<{ chromium: ChromiumLike }> {
  const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  try {
    const loaded = await importer("playwright") as { chromium?: ChromiumLike };
    if (!loaded.chromium) throw new Error("Playwright is installed but Chromium launcher is unavailable.");
    return { chromium: loaded.chromium };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Cannot find module|MODULE_NOT_FOUND/i.test(message)) {
      throw new Error(
        "Playwright paket nije instaliran. Pokreni: npm install playwright && npx playwright install chromium."
      );
    }
    throw error;
  }
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
            const root = document.documentElement || document.body;
            if (!root) {
              resolve();
              return;
            }
            const height = Math.max(root.scrollHeight || 0, document.body?.scrollHeight || 0);
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

/**
 * Mutable capture budget shared across all `captureResponse` calls for one render.
 * Network responses arrive in chronological order, but the product/document API payload
 * we actually want often fires LATE (after analytics, ads, tracking pixels). A plain
 * "stop after N bodies" FIFO cap would silently drop that late payload. So we split the
 * budget: low-value bodies (html/text/search-api) are capped early, while high-value
 * product-api/document-api bodies are always captured up to a higher total ceiling.
 */
interface NetworkCaptureState {
  lowValue: number;
}

const TOTAL_BODY_CAP = 60;
const LOW_VALUE_BODY_CAP = 30;

function createNetworkCaptureState(): NetworkCaptureState {
  return { lowValue: 0 };
}

async function captureResponse(
  response: ResponseLike,
  captured: FetchedText[],
  diagnostics: BrowserNetworkRecord[],
  state: NetworkCaptureState,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted || captured.length >= TOTAL_BODY_CAP) return;
  try {
    const headers = await response.headers();
    const contentType = headers["content-type"] ?? "";
    const url = response.url();
    const category = categorizeNetworkResponse(url, contentType);
    diagnostics.push({
      url,
      statusCode: response.status(),
      contentType,
      category
    });
    if (!shouldCaptureNetworkBody(url, contentType, category)) return;
    // Reserve capacity for the payloads that actually carry specs/documents so a late
    // product-api response is never crowded out by earlier low-value html/text bodies.
    const highValue = category === "product-api" || category === "document-api";
    if (!highValue && state.lowValue >= LOW_VALUE_BODY_CAP) return;
    const text = await response.text();
    if (!text.trim() || text.length > 750_000) return;
    if (!highValue) state.lowValue += 1;
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

function shouldCaptureNetworkBody(url: string, contentType: string, category: BrowserNetworkRecord["category"]): boolean {
  if (category === "asset-api" || category === "other") return false;
  if (!/(json|text|html|javascript)/i.test(contentType)) return false;
  if (/javascript/i.test(contentType) && !/livewire|product|sku|catalog|pim|graphql|api/i.test(url)) return false;
  return true;
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

const MODAL_CONTAINER_SELECTORS = [
  "[role='dialog']",
  "[aria-modal='true']",
  ".modal:not(.cookie):not(.cookies)",
  "[class*='Modal'][class*='open']",
  "[class*='dialog'][class*='open']",
  "[data-headlessui-state='open']",
  "div[class*='fixed'][class*='inset-0']"
];

const MODAL_CLOSE_SELECTORS = [
  "[role='dialog'] button[aria-label*='close' i]",
  "[role='dialog'] button[aria-label*='schlie' i]",
  "[role='dialog'] button[aria-label*='zatvor' i]",
  "[role='dialog'] button[title*='close' i]",
  "[aria-modal='true'] button[aria-label*='close' i]",
  "button.modal__close",
  "button.close",
  "[role='dialog'] svg[class*='close']"
];

async function openModalSection(page: PageLike, section: ModalSection, signal?: AbortSignal): Promise<boolean> {
  // Balluff uses Alpine.js side-drawers that don't expose role='dialog' on the panel itself,
  // so generic modal-open detection is unreliable. The pragmatic flow: scroll the button into
  // view, click it, wait for Livewire to render the panel, then trust that the content is now
  // in the DOM. We verify success by checking that the section's content markers appear in the
  // page body, not by hunting for a specific modal container.
  // We augment the user-provided openSelectors with extra patterns that target the actual DOM
  // shape we discovered on Balluff: <button class="...py-5"> containing <div class="font-medium text-base">Label</div>.
  const augmented = expandSectionSelectors(section);
  for (const selector of augmented) {
    if (signal?.aborted) throw new Error("Cancelled by user.");
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      if (!count) continue;
      for (let index = 0; index < Math.min(count, 3); index += 1) {
        if (signal?.aborted) throw new Error("Cancelled by user.");
        try {
          const instance = locator.nth(index);
          // Bring the button into view first — Balluff section buttons are below the fold,
          // and Playwright's strict-mode click can reject buttons outside the viewport.
          if (instance.scrollIntoViewIfNeeded) {
            await instance.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
          }
          await instance.click({ timeout: 3000, force: false });
          // Give Livewire / Alpine ~2.5s to fetch and render the section's data, then verify
          // by checking page-wide content markers (not modal containers).
          for (let attempt = 0; attempt < 12; attempt += 1) {
            await page.waitForTimeout(250);
            if (await sectionContentLoaded(page, section)) return true;
          }
          // Even if no marker hit, the click likely succeeded — return true so we still capture the page.
          return true;
        } catch {
          // Try the next instance / selector.
        }
      }
    } catch {
      // Selector didn't match anything; try the next one.
    }
  }

  // All click strategies failed (drawer overlay, AV interrupting click, hidden behind sticky bar...).
  // Fall back to the Alpine.js event dispatch the page itself uses internally. We read the
  // x-on:click handler from the matching py-5 button and replay the dispatch from JS.
  if (await dispatchBalluffOpenSidebar(page, section.label)) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      await page.waitForTimeout(250);
      if (await sectionContentLoaded(page, section)) return true;
    }
    return true;
  }
  return false;
}

/**
 * Fallback opener: many Balluff sections wire their button with
 *   x-on:click.prevent="$dispatch('open-sidebar', 'downloads')"
 * Clicking can be blocked when another drawer is open (overlay intercepts pointer events)
 * or when the button is hidden behind a sticky bar. Replaying the dispatch from JS bypasses
 * those issues entirely.
 */
async function dispatchBalluffOpenSidebar(page: PageLike, label: string): Promise<boolean> {
  try {
    const dispatched = await page.evaluate(
      `(() => {
        const wanted = ${JSON.stringify(label.toLowerCase())};
        const buttons = Array.from(document.querySelectorAll("button.py-5, button[x-on\\\\:click], button[\\\\@click]"));
        for (const button of buttons) {
          const text = (button.textContent || "").trim().toLowerCase();
          if (!text || !text.startsWith(wanted)) continue;
          const handler =
            button.getAttribute("x-on:click.prevent") ||
            button.getAttribute("x-on:click") ||
            button.getAttribute("@click.prevent") ||
            button.getAttribute("@click") ||
            "";
          const match = handler.match(/\\$dispatch\\(\\s*['"]open-sidebar['"]\\s*,\\s*['"]([^'"]+)['"]\\s*\\)/);
          if (match) {
            window.dispatchEvent(new CustomEvent("open-sidebar", { detail: match[1] }));
            return true;
          }
        }
        return false;
      })()`
    );
    return Boolean(dispatched);
  } catch {
    return false;
  }
}

function expandSectionSelectors(section: ModalSection): string[] {
  // Capture the literal label so we can build Balluff-specific patterns that hit the
  // exact button shape used on product pages.
  const escaped = section.label.replace(/'/g, "\\'");
  const augmented = [
    ...section.openSelectors,
    // Match the <button class="...py-5"> wrapper that contains a child <div> with the label text.
    // This is robust against nav-menu false positives because the product-page buttons have py-5.
    `button.py-5:has-text('${escaped}')`,
    `button:has(div:text-is('${escaped}'))`,
    `button:has(span:text-is('${escaped}'))`,
    // Some sections (like Downloads) use anchor tags inside an Alpine drawer.
    `a:has(div:text-is('${escaped}'))`,
    // Generic Alpine click-handler buttons that include the label text.
    `[\\@click]:has-text('${escaped}')`,
    `[x-on\\:click]:has-text('${escaped}')`
  ];
  return [...new Set(augmented)];
}

async function sectionContentLoaded(page: PageLike, section: ModalSection): Promise<boolean> {
  for (const marker of section.contentMarkerSelectors ?? []) {
    try {
      if ((await page.locator(marker).count()) > 0) return true;
    } catch {
      // ignore
    }
  }
  // No markers configured (e.g. Knowledge Base) — fall back to "modal container exists".
  if (!section.contentMarkerSelectors?.length) return isModalOpen(page, section);
  return false;
}

async function isModalOpen(page: PageLike, section: ModalSection): Promise<boolean> {
  // Either a generic modal container is visible, or the section's content marker is in the DOM.
  for (const selector of MODAL_CONTAINER_SELECTORS) {
    try {
      if ((await page.locator(selector).count()) > 0) return true;
    } catch {
      // Selector syntax error or detached frame; ignore.
    }
  }
  for (const marker of section.contentMarkerSelectors ?? []) {
    try {
      if ((await page.locator(marker).count()) > 0) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

async function captureModalFragment(page: PageLike, section: ModalSection): Promise<string | undefined> {
  const markerTexts = (section.contentMarkerSelectors ?? [])
    .map((marker) => marker.replace(/^text=/i, "").replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const terms = uniqueStrings([section.label, ...markerTexts]).filter((term) => term.length >= 3);
  try {
    const html = await page.evaluate(
      `(() => {
        const terms = ${JSON.stringify(terms.map((term) => term.toLowerCase()))};
        const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const hasTerm = (text) => {
          const cleaned = norm(text);
          return terms.some((term) => cleaned.includes(term));
        };
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const candidates = [];
        const selectors = [
          "[role='dialog']",
          "[aria-modal='true']",
          "dialog",
          "aside",
          "[class*='sidebar']",
          "[class*='Sidebar']",
          "[class*='drawer']",
          "[class*='Drawer']",
          "div[class*='fixed']"
        ];
        for (const selector of selectors) {
          for (const el of Array.from(document.querySelectorAll(selector))) {
            if (!visible(el)) continue;
            const text = norm(el.textContent);
            if (text.length < 40 || !hasTerm(text)) continue;
            const className = String(el.getAttribute('class') || '');
            const score =
              terms.reduce((sum, term) => sum + (text.includes(term) ? 10 : 0), 0) +
              (/fixed|sidebar|drawer|modal|dialog/i.test(className) ? 12 : 0) -
              Math.min(text.length / 25000, 8);
            candidates.push({ el, score });
          }
        }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!hasTerm(node.textContent)) continue;
          let el = node.parentElement;
          for (let depth = 0; el && depth < 8; depth += 1, el = el.parentElement) {
            if (el.tagName === 'BODY' || el.tagName === 'HTML') break;
            if (!visible(el)) continue;
            const text = norm(el.textContent);
            if (text.length >= 80 && text.length <= 250000) {
              candidates.push({ el, score: 20 - depth - Math.min(text.length / 30000, 6) });
              break;
            }
          }
        }
        candidates.sort((left, right) => right.score - left.score);
        return candidates[0]?.el?.outerHTML || "";
      })()`
    ) as string;
    if (html && html.length > 500) {
      return `<section data-balluff-modal="${section.label}">${html}</section>`;
    }
  } catch {
    // Fall through to full body snapshot.
  }
  // Balluff renders modal panels as Alpine.js side-drawers that don't sit in a predictable
  // container. Take a snapshot of the body innerHTML after the click — the section panel will
  // be in there along with everything else, and Balluff parsers extract from anywhere.
  try {
    const html = await page.evaluate(`document.body.innerHTML`) as string;
    if (html && html.length > 500) {
      return `<section data-balluff-modal="${section.label}">${html}</section>`;
    }
  } catch {
    // Fall through to full content.
  }
  try {
    return `<section data-balluff-modal="${section.label}">${await page.content()}</section>`;
  } catch {
    return undefined;
  }
}

async function closeOpenModal(page: PageLike, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;

  // Strategy 1: Escape key (most reliable, works for almost every modal framework).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.keyboard.press("Escape");
    } catch {
      break;
    }
    await page.waitForTimeout(150);
    if (!(await anyModalStillOpen(page))) return;
  }

  // Strategy 2: click explicit close button.
  for (const selector of MODAL_CLOSE_SELECTORS) {
    try {
      const locator = page.locator(selector);
      if ((await locator.count()) > 0) {
        await locator.nth(0).click({ timeout: 1500, force: false });
        await page.waitForTimeout(150);
        if (!(await anyModalStillOpen(page))) return;
      }
    } catch {
      // Try next selector.
    }
  }

  // Strategy 3: programmatically remove the modal container from the DOM and remove body
  // scroll-lock so the next section button is reachable. Heavy-handed but reliable when
  // close handlers refuse to fire.
  try {
    await page.evaluate(
      `(() => {
        const selectors = [
          "[role='dialog']",
          "[aria-modal='true']",
          ".modal.show",
          "[class*='Modal__open']",
          "[data-headlessui-state='open']",
          "div[class*='fixed'][class*='inset-0']"
        ];
        for (const sel of selectors) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            el.parentElement && el.parentElement.removeChild(el);
          }
        }
        document.body.style.removeProperty('overflow');
        document.documentElement.style.removeProperty('overflow');
        document.body.classList.remove('modal-open', 'overflow-hidden');
      })()`
    );
    await page.waitForTimeout(200);
  } catch {
    // Best-effort; if even this fails the next openModalSection will at least retry from a known scroll position.
  }
}

/**
 * Balluff product pages use Alpine.js side-drawers that listen for the `open-sidebar` /
 * `close-sidebar` window events. Dispatching these directly closes any drawer reliably,
 * including when DOM click handlers are blocked because the drawer overlay sits on top
 * of the next section button.
 */
async function dispatchBalluffCloseSidebar(page: PageLike): Promise<void> {
  try {
    await page.evaluate(
      `(() => {
        try {
          window.dispatchEvent(new CustomEvent('close-sidebar'));
        } catch {}
        document.body.style.removeProperty('overflow');
        document.documentElement.style.removeProperty('overflow');
        document.body.classList.remove('overflow-hidden', 'modal-open');
      })()`
    );
  } catch {
    // Best effort.
  }
}

/**
 * Wait until the drawer renders content matching this section's markers. Balluff fetches
 * Key features / Downloads / Classifications / DPP via Livewire after the open click, so
 * we may need to wait a few hundred ms before the data is in the DOM.
 */
async function waitForBalluffDrawerContent(page: PageLike, section: ModalSection, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await sectionContentLoaded(page, section)) return;
    await page.waitForTimeout(200);
  }
}

function fragmentHasSectionMarker(fragment: string | undefined, section: ModalSection): boolean {
  if (!fragment || !section.contentMarkerSelectors?.length) return false;
  return section.contentMarkerSelectors.some((marker) =>
    new RegExp(marker.replace(/^text=/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(fragment)
  );
}

function balluffDrawerInitialWaitMs(section: ModalSection): number {
  if (/knowledge base/i.test(section.label)) return 400;
  if (/classifications|digital product passport/i.test(section.label)) return 600;
  if (/downloads/i.test(section.label)) return 900;
  return 700;
}

function balluffDrawerGraceWaitMs(section: ModalSection): number {
  if (/knowledge base/i.test(section.label)) return 0;
  if (/classifications|digital product passport/i.test(section.label)) return 1200;
  return 800;
}

function balluffDrawerRetryWaitMs(section: ModalSection): number {
  if (/downloads/i.test(section.label)) return 1800;
  return 2200;
}

function shouldReopenBalluffSection(section: ModalSection): boolean {
  return /key features|downloads|classifications|digital product passport/i.test(section.label);
}

/**
 * Click configured nested py-5 buttons inside the currently-open Balluff drawer. Some products
 * show only a subset, so we tolerate misses.
 * Each sub-section may dynamically reveal more links, so we re-query after each click.
 */
async function expandAllBalluffSubSections(page: PageLike, selectors: string[], signal?: AbortSignal): Promise<void> {
  const seenLabels = new Set<string>();
  for (let pass = 0; pass < 1; pass += 1) {
    for (const selector of uniqueStrings(selectors)) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      let count = 0;
      try {
        count = await page.locator(selector).count();
      } catch {
        continue;
      }
      for (let index = 0; index < Math.min(count, 8); index += 1) {
        if (signal?.aborted) throw new Error("Cancelled by user.");
        try {
          const handle = page.locator(selector).nth(index);
          const text = await page
            .evaluate(
              `(() => {
                const nodes = document.querySelectorAll(${JSON.stringify(selector)});
                const n = nodes[${index}];
                return n ? (n.textContent || '').trim().slice(0, 80) : '';
              })()`
            )
            .catch(() => "");
          const labelKey = String(text).toLowerCase() || selector;
          if (seenLabels.has(labelKey)) continue;
          if (handle.scrollIntoViewIfNeeded) {
            await handle.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => undefined);
          }
          await handle.click({ timeout: 2000, force: false });
          seenLabels.add(labelKey);
          await page.waitForTimeout(350);
        } catch {
          // Sub-button might already be expanded, hidden, or covered — keep going.
        }
      }
    }
  }
}

async function anyModalStillOpen(page: PageLike): Promise<boolean> {
  for (const selector of MODAL_CONTAINER_SELECTORS) {
    try {
      if ((await page.locator(selector).count()) > 0) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

function combineHtmlWithFragments(mainHtml: string, fragments: Array<{ label: string; html: string }>): string {
  if (!fragments.length) return mainHtml;
  const blob = fragments.map((fragment) => fragment.html).join("\n");
  // Inject before </body> if possible so cheerio sees a well-formed document.
  const bodyClose = mainHtml.lastIndexOf("</body>");
  if (bodyClose >= 0) {
    return `${mainHtml.slice(0, bodyClose)}\n<!-- balluff modal fragments -->\n${blob}\n${mainHtml.slice(bodyClose)}`;
  }
  return `${mainHtml}\n<!-- balluff modal fragments -->\n${blob}`;
}
