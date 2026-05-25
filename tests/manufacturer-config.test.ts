import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getManufacturerConfig,
  initializeManufacturerConfig,
  listManufacturerConfigs,
  resetManufacturerOverride,
  saveManufacturerConfig
} from "../src/server/config/manufacturers.js";

describe("manufacturer config aliases", () => {
  it("maps legacy production scraper IDs onto current built-ins", () => {
    expect(getManufacturerConfig("newabb")?.id).toBe("abb");
    expect(getManufacturerConfig("saginawcontrol")?.id).toBe("sce");
    expect(getManufacturerConfig("schneiderelectric")?.id).toBe("schneider");
    expect(getManufacturerConfig("nventhoffman")?.id).toBe("nvent");
  });

  it("persists advanced scrape recipe policies for custom manufacturers", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-config-"));
    initializeManufacturerConfig(dataDir);

    const saved = await saveManufacturerConfig({
      id: "custom",
      canonicalName: "Custom",
      shortName: "CUS",
      rateLimitMs: 1000,
      officialBaseUrls: ["https://example.test/products"],
      fallbackSources: [],
      scrapeRecipe: {
        discoveryPolicy: {
          searchUrlTemplates: ["https://example.test/search?q={part}"],
          enableRobotsSitemaps: true,
          maxCandidates: 7
        },
        interactionPolicy: { expandSelectors: ["button[aria-expanded='false']"], maxClicks: 20 },
        extractionPolicy: { labelAliases: { Gewicht: "Weight" }, documentUrlPatterns: ["datasheet"] },
        qualityPolicy: { requiredNormalizedFields: ["weight"], requiredDocumentTypes: ["datasheet"] }
      }
    });

    expect(saved.scrapeRecipe?.discoveryPolicy?.maxCandidates).toBe(7);
    expect(saved.scrapeRecipe?.interactionPolicy?.maxClicks).toBe(20);
    expect(saved.scrapeRecipe?.extractionPolicy?.labelAliases?.Gewicht).toBe("Weight");
    expect(saved.scrapeRecipe?.qualityPolicy?.requiredNormalizedFields).toEqual(["weight"]);
  });

  it("edits built-ins as local overrides and can reset back to the built-in config", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-config-"));
    initializeManufacturerConfig(dataDir);

    const saved = await saveManufacturerConfig({
      id: "abb",
      canonicalName: "ABB Local Test Override",
      shortName: "ABB",
      rateLimitMs: 999,
      officialBaseUrls: ["https://example.test/abb/{part}"],
      fallbackSources: []
    });

    expect(saved.origin).toBe("override");
    expect(getManufacturerConfig("abb")?.canonicalName).toBe("ABB Local Test Override");
    expect(listManufacturerConfigs().find((manufacturer) => manufacturer.id === "abb")?.hasOverride).toBe(true);

    const reset = await resetManufacturerOverride("abb");
    expect(reset.origin).toBe("built-in");
    expect(getManufacturerConfig("abb")?.canonicalName).toBe("ABB");
    expect(listManufacturerConfigs().find((manufacturer) => manufacturer.id === "abb")?.hasOverride).toBe(false);
  });
});
