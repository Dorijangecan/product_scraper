import { describe, expect, it } from "vitest";
import { captureFrameFragments, captureShadowDomFragments, clickSafeSelectors, finalRenderedUrl, submitSearchInput } from "../src/server/scrapers/browser-renderer.js";

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

describe("submitSearchInput", () => {
  it("fills the first discovered search input and submits it with Enter", async () => {
    const fills: string[] = [];
    const keys: string[] = [];
    const page = {
      locator: (selector: string) => ({
        count: async () => selector === "input[type='search']" ? 1 : 0,
        nth: () => ({ fill: async (value: string) => fills.push(value) })
      }),
      keyboard: { press: async (key: string) => keys.push(key) }
    };

    await expect(submitSearchInput(page as never, "ZX-CTRL-24")).resolves.toBe(true);
    expect(fills).toEqual(["ZX-CTRL-24"]);
    expect(keys).toEqual(["Enter"]);
  });

  it("returns false when the rendered page has no usable search input", async () => {
    const page = {
      locator: () => ({ count: async () => 0, nth: () => ({}) }),
      keyboard: { press: async () => { throw new Error("must not submit"); } }
    };

    await expect(submitSearchInput(page as never, "ZX-CTRL-24")).resolves.toBe(false);
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

// --- P4.1 / P4.2 / P4.3 (COLD-START-PLAN §6.2): reaching the vendor's own search like a human ---

describe("submitSearchInput — typing, suggest debounce and hidden search overlays", () => {
  // The whole point of P4.2: fill() sets the value programmatically and typeahead widgets that listen
  // for keydown never fire their suggest request for it. That request's JSON is the richest identity
  // source these sites expose, so real typing is not a stylistic preference.
  it("types key by key when the locator supports it, and waits for the suggest debounce before Enter", async () => {
    const order: string[] = [];
    const page = {
      locator: (selector: string) => ({
        count: async () => (selector === "input[type='search']" ? 1 : 0),
        nth: () => ({
          pressSequentially: async (value: string) => {
            order.push(`type:${value}`);
          },
          fill: async () => {
            order.push("fill");
          }
        })
      }),
      waitForTimeout: async () => {
        order.push("wait");
      },
      keyboard: { press: async (key: string) => order.push(`key:${key}`) }
    };

    await expect(submitSearchInput(page as never, "ZX-CTRL-24")).resolves.toBe(true);
    expect(order).toEqual(["type:ZX-CTRL-24", "wait", "key:Enter"]);
  });

  // On a large share of industrial sites input[type=search] does not exist until the magnifier is
  // clicked, so every selector legitimately finds nothing and the vendor looks searchless.
  it("opens the search overlay when no input exists yet, then uses the input it reveals", async () => {
    let overlayOpen = false;
    const typed: string[] = [];
    const page = {
      locator: (selector: string) => ({
        count: async () => {
          if (selector === "button[aria-label*='search' i]") return 1;
          if (selector === "input[type='search']") return overlayOpen ? 1 : 0;
          return 0;
        },
        nth: () => ({
          click: async () => {
            overlayOpen = true;
          },
          pressSequentially: async (value: string) => typed.push(value)
        })
      }),
      waitForTimeout: async () => undefined,
      keyboard: { press: async () => undefined }
    };

    await expect(submitSearchInput(page as never, "ZX-CTRL-24")).resolves.toBe(true);
    expect(typed).toEqual(["ZX-CTRL-24"]);
  });

  // These selectors can also match a link to a /search page. Clicking several in a row would navigate
  // away and then keep clicking on whatever page we landed on.
  it("clicks at most one overlay toggle", async () => {
    let clicks = 0;
    const page = {
      locator: (selector: string) => ({
        count: async () => (selector.startsWith("button[aria-label") || selector.startsWith("button[title") ? 1 : 0),
        nth: () => ({
          click: async () => {
            clicks += 1;
          }
        })
      }),
      waitForTimeout: async () => undefined,
      keyboard: { press: async () => { throw new Error("must not submit"); } }
    };

    await expect(submitSearchInput(page as never, "ZX-CTRL-24")).resolves.toBe(false);
    expect(clicks).toBe(1);
  });

  it("still reports failure when there is neither a search input nor an overlay toggle", async () => {
    const page = {
      locator: () => ({ count: async () => 0, nth: () => ({}) }),
      waitForTimeout: async () => undefined,
      keyboard: { press: async () => { throw new Error("must not submit"); } }
    };

    await expect(submitSearchInput(page as never, "ZX-CTRL-24")).resolves.toBe(false);
  });
});

describe("finalRenderedUrl", () => {
  it("reports where the page actually ended up", () => {
    const page = { url: () => "https://vendor.test/en/products/ct-mfd-21" };
    expect(finalRenderedUrl(page as never, "https://vendor.test/search?q=CT-MFD.21")).toBe(
      "https://vendor.test/en/products/ct-mfd-21"
    );
  });

  // A failed navigation must not be reported as the product's location.
  it("falls back to the requested URL for about:blank, an empty value, or a page that cannot answer", () => {
    const requested = "https://vendor.test/search?q=CT-MFD.21";
    expect(finalRenderedUrl({ url: () => "about:blank" } as never, requested)).toBe(requested);
    expect(finalRenderedUrl({ url: () => "  " } as never, requested)).toBe(requested);
    expect(finalRenderedUrl({} as never, requested)).toBe(requested);
    expect(
      finalRenderedUrl(
        {
          url: () => {
            throw new Error("page closed");
          }
        } as never,
        requested
      )
    ).toBe(requested);
  });
});
