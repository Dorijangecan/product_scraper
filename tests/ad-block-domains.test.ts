import { describe, expect, it } from "vitest";
import { AD_BLOCK_DOMAINS, isAdBlockedHost, isAdBlockedUrl } from "../src/server/scrapers/ad-block-domains.js";

describe("ad-block-domains", () => {
  it("loaded a non-trivial vendored domain list", () => {
    expect(AD_BLOCK_DOMAINS.size).toBeGreaterThan(1000);
  });

  it("matches a known ad domain exactly", () => {
    expect(isAdBlockedHost("doubleclick.net")).toBe(true);
  });

  it("matches a subdomain of a known ad domain", () => {
    expect(isAdBlockedHost("tracker.ads.doubleclick.net")).toBe(true);
  });

  it("does not match an unrelated manufacturer host", () => {
    expect(isAdBlockedHost("new.abb.com")).toBe(false);
    expect(isAdBlockedHost("sieportal.siemens.com")).toBe(false);
  });

  it("never matches a bare TLD even if it were present as a suffix", () => {
    expect(isAdBlockedHost("net")).toBe(false);
    expect(isAdBlockedHost("com")).toBe(false);
  });

  it("isAdBlockedUrl resolves the hostname from a full URL", () => {
    expect(isAdBlockedUrl("https://tracker.ads.doubleclick.net/pixel?x=1")).toBe(true);
    expect(isAdBlockedUrl("https://new.abb.com/products/1SVR340667R1000")).toBe(false);
  });

  it("isAdBlockedUrl fails closed (unblocked) on a malformed URL", () => {
    expect(isAdBlockedUrl("not a url")).toBe(false);
  });
});
