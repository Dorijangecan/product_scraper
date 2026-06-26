import { describe, expect, it } from "vitest";
import { isRetryableStatus, parseRetryAfterMs } from "../src/server/scrapers/http-client.js";

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
