import { describe, expect, it } from "vitest";
import { curlBudgetOptions, endpointCircuitKey, isRetryableStatus, parseRetryAfterMs } from "../src/server/scrapers/http-client.js";

describe("http retry policy", () => {
  it("retries on rate-limit and transient server statuses, not on success/client errors", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
  });

  it("honors a numeric Retry-After header (seconds → ms)", () => {
    const response = new Response(null, { status: 429, headers: { "retry-after": "5" } });
    expect(parseRetryAfterMs(response)).toBe(5000);
  });

  it("honors an HTTP-date Retry-After header", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const response = new Response(null, { status: 503, headers: { "retry-after": future } });
    const ms = parseRetryAfterMs(response);
    expect(ms).toBeGreaterThan(5_000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("returns undefined when no Retry-After header is present", () => {
    const response = new Response(null, { status: 429 });
    expect(parseRetryAfterMs(response)).toBeUndefined();
  });
});

/**
 * A document download must not be able to eat the whole item.
 *
 * Without a budget one file can spend 90 s buffering in memory and then up to another 130 s in the
 * curl fallback. The shipped curl defaults are also internally inconsistent: `--max-time` is per
 * attempt, so `--retry 2 --max-time 120` can run well past the 130 s process timeout meant to bound
 * it, which means the later attempts could never finish anyway.
 */
describe("curl download budget", () => {
  it("leaves the generous defaults alone when no budget is supplied", () => {
    expect(curlBudgetOptions(undefined)).toEqual({});
    expect(curlBudgetOptions(Number.POSITIVE_INFINITY)).toEqual({});
  });

  it("fits two attempts plus curl's retry delay inside the window when there is room", () => {
    const options = curlBudgetOptions(60_000);
    expect(options.timeoutMs).toBe(60_000);
    expect(options.retries).toBe(1);
    // 2 attempts x 29 s + 2 s delay = 60 s.
    expect((options.maxTimeSeconds ?? 0) * 2 + 2).toBeLessThanOrEqual(60);
  });

  it("drops the retry rather than starting an attempt that cannot finish", () => {
    const options = curlBudgetOptions(20_000);
    expect(options.retries).toBe(0);
    expect(options.maxTimeSeconds).toBe(18);
  });

  it("never asks for longer than the shipped ceiling, however much budget is left", () => {
    const options = curlBudgetOptions(10 * 60_000);
    expect(options.timeoutMs).toBe(130_000);
  });
});

/**
 * The reachability breaker skips a target that has proven unreachable, so its key decides what
 * "unreachable" covers. ABB is the case that forced this: `new.abb.com/api/*` answers in under a
 * second while `new.abb.com/products/*` accepts the connection and never replies for an unknown id.
 * At host granularity three dead `/products` guesses — easily produced by other items running
 * concurrently — refused the next item's healthy `/api` call and failed a product whose data was
 * one request away.
 */
describe("reachability circuit key", () => {
  it("separates a healthy API route from a dead HTML route on the same host", () => {
    expect(endpointCircuitKey("https://new.abb.com/api/PisSearchApi?query=X")).toBe("new.abb.com/api");
    expect(endpointCircuitKey("https://new.abb.com/products/1SVR340667R1000")).toBe("new.abb.com/products");
    expect(endpointCircuitKey("https://new.abb.com/api/PisSearchApi/Token")).not.toBe(
      endpointCircuitKey("https://new.abb.com/products/de/1SVR340667R1000/product")
    );
  });

  it("still groups locale and path variants of one dead route together", () => {
    const variants = [
      "https://new.abb.com/products/pl/1SDA124715R1/product",
      "https://new.abb.com/products/de/1SDA124715R1/product",
      "https://new.abb.com/products/it/1SDA124715R1"
    ].map(endpointCircuitKey);
    expect(new Set(variants).size).toBe(1);
  });

  it("falls back to the bare host for a root URL, and to undefined for a non-URL", () => {
    expect(endpointCircuitKey("https://new.abb.com/")).toBe("new.abb.com");
    expect(endpointCircuitKey("not a url")).toBeUndefined();
  });
});
