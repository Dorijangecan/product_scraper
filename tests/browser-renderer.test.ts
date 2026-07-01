import { describe, expect, it } from "vitest";
import { captureFrameFragments, captureShadowDomFragments, clickSafeSelectors } from "../src/server/scrapers/browser-renderer.js";

// Minimal PageLike/LocatorLike fakes. The renderer only uses locator().count/nth/click,
// scrollIntoViewIfNeeded, waitForTimeout, waitForLoadState, and frames() from these in the
// code paths under test.
interface FakeControl {
  selector: string;
  failFirstClick?: boolean; // click() rejects unless force:true (covers scroll+force retry)
  clicks: number;
  forcedClicks: number;
}

function fakePage(controls: FakeControl[], opts: { onClick?: (c: FakeControl) => void } = {}) {
  const bySelector = (selector: string) => controls.filter((c) => c.selector === selector);
  return {
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    locator: (selector: string) => ({
      count: async () => bySelector(selector).length,
      nth: (index: number) => {
        const control = bySelector(selector)[index];
        return {
          scrollIntoViewIfNeeded: async () => undefined,
          click: async (options?: { force?: boolean }) => {
            if (!control) throw new Error("no control");
            if (control.failFirstClick && !options?.force) throw new Error("intercepted");
            control.clicks += 1;
            if (options?.force) control.forcedClicks += 1;
            opts.onClick?.(control);
          }
        };
      }
    })
  };
}

describe("clickSafeSelectors", () => {
  it("retries with force:true when a normal click is intercepted", async () => {
    const control: FakeControl = { selector: "button.tab", failFirstClick: true, clicks: 0, forcedClicks: 0 };
    await clickSafeSelectors(fakePage([control]) as never, ["button.tab"], 10);
    expect(control.clicks).toBe(1);
    expect(control.forcedClicks).toBe(1);
  });

  it("re-scans state-aware expanders to open nested accordions revealed by the first click", async () => {
    // The nested control only "appears" (count > 0) after the parent has been clicked.
    const parent: FakeControl = { selector: "button[aria-expanded='false']", clicks: 0, forcedClicks: 0 };
    const nested: FakeControl = { selector: "details:not([open]) > summary", clicks: 0, forcedClicks: 0 };
    let parentOpen = false; // parent stops matching aria-expanded='false' once opened
    let nestedVisible = false; // nested only appears after the parent opens
    let nestedOpen = false; // and stops matching details:not([open]) once opened (state-aware)
    const page = {
      waitForTimeout: async () => undefined,
      waitForLoadState: async () => undefined,
      locator: (selector: string) => {
        const matches =
          selector === "button[aria-expanded='false']"
            ? parentOpen ? [] : [parent]
            : selector === "details:not([open]) > summary"
              ? nestedVisible && !nestedOpen ? [nested] : []
              : [];
        return {
          count: async () => matches.length,
          nth: (index: number) => ({
            scrollIntoViewIfNeeded: async () => undefined,
            click: async () => {
              const control = matches[index];
              if (!control) throw new Error("no control");
              control.clicks += 1;
              if (control === parent) {
                parentOpen = true;
                nestedVisible = true; // first click reveals the nested accordion
              }
              if (control === nested) nestedOpen = true;
            }
          })
        };
      }
    };
    await clickSafeSelectors(page as never, ["button[aria-expanded='false']"], 10, undefined, {
      rescanSelectors: ["details:not([open]) > summary"]
    });
    expect(parent.clicks).toBe(1);
    expect(nested.clicks).toBe(1);
  });

  it("never exceeds maxClicks", async () => {
    const controls: FakeControl[] = Array.from({ length: 8 }, () => ({ selector: "button.x", clicks: 0, forcedClicks: 0 }));
    let total = 0;
    await clickSafeSelectors(fakePage(controls, { onClick: () => (total += 1) }) as never, ["button.x"], 3);
    expect(total).toBe(3);
  });
});

describe("captureFrameFragments", () => {
  const frame = (url: string, content: string, throws = false) => ({
    url: () => url,
    content: async () => {
      if (throws) throw new Error("cross-origin");
      return content;
    }
  });

  it("captures same-site iframe content and skips main/blank/cross-origin frames", async () => {
    const page = {
      frames: () => [
        frame("https://example.test/product/123", "<main>MAIN</main>"), // main frame — skipped
        frame("about:blank", "<html></html>"), // skipped
        frame("https://widgets.example.test/specs", `<table>${"x".repeat(400)}</table>`), // same-site subdomain — captured
        frame("https://ads.other.test/banner", "<div>ad</div>", true) // cross-origin content() throws — skipped
      ]
    };
    const fragments = await captureFrameFragments(page as never, "https://example.test/product/123");
    expect(fragments).toHaveLength(1);
    expect(fragments[0].label).toBe("iframe:https://widgets.example.test/specs");
    expect(fragments[0].html).toContain("<table>");
  });

  it("returns nothing when the page exposes no frames()", async () => {
    const fragments = await captureFrameFragments({} as never, "https://example.test/x");
    expect(fragments).toEqual([]);
  });
});

describe("captureShadowDomFragments (Phase 5 P7)", () => {
  it("captures substantial shadow-root HTML returned by the in-page walker and drops tiny ones", async () => {
    const page = { evaluate: async () => [`<table>${"x".repeat(200)}</table>`, "<i>tiny</i>"] };
    const fragments = await captureShadowDomFragments(page as never);
    expect(fragments).toHaveLength(1);
    expect(fragments[0].label).toBe("shadow-dom-1");
    expect(fragments[0].html).toContain("<table>");
  });

  it("degrades gracefully when evaluate throws or returns a non-array", async () => {
    const throwing = { evaluate: async () => { throw new Error("no shadow"); } };
    const nonArray = { evaluate: async () => "oops" };
    expect(await captureShadowDomFragments(throwing as never)).toEqual([]);
    expect(await captureShadowDomFragments(nonArray as never)).toEqual([]);
  });
});
