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
        extractionPolicy: {
          labelAliases: { Gewicht: "Weight" },
          documentUrlPatterns: ["datasheet"],
          embeddedProductTableNames: ["customProductRows"],
          embeddedResourceTableNames: ["customResourceRows"]
        },
        qualityPolicy: {
          requiredNormalizedFields: ["weight", "color", "operatingTemperatureMin", "operatingTemperatureMax"],
          requiredFinalFields: ["weight", "dimensions", "material"],
          preferredFinalFields: ["certificates"],
          typeCodeFallback: "catalogNumber",
          rationales: {
            requiredFinalFields: "Custom official datasheets require physical final fields.",
            preferredFinalFields: "Custom PDT examples treat certificates as preferred.",
            typeCodeFallback: "Custom official pages use catalog number as source-backed type code."
          },
          requiredDocumentTypes: ["datasheet"]
        },
        fallbackPolicy: {
          documentDownloadProfile: "images-only",
          skipPreferredFinalCompletenessRetry: true,
          rationales: {
            documentDownloadProfile: "Custom official image documents are source-backed, but non-image files should not be saved.",
            skipPreferredFinalCompletenessRetry: "Custom official pages do not improve preferred-only final fields."
          }
        }
      }
    });

    expect(saved.scrapeRecipe?.discoveryPolicy?.maxCandidates).toBe(7);
    expect(saved.scrapeRecipe?.interactionPolicy?.maxClicks).toBe(20);
    expect(saved.scrapeRecipe?.extractionPolicy?.labelAliases?.Gewicht).toBe("Weight");
    expect(saved.scrapeRecipe?.extractionPolicy?.embeddedProductTableNames).toEqual(["customProductRows"]);
    expect(saved.scrapeRecipe?.extractionPolicy?.embeddedResourceTableNames).toEqual(["customResourceRows"]);
    expect(saved.scrapeRecipe?.qualityPolicy?.requiredNormalizedFields).toEqual([
      "weight",
      "color",
      "operatingTemperatureMin",
      "operatingTemperatureMax"
    ]);
    expect(saved.scrapeRecipe?.qualityPolicy?.requiredFinalFields).toEqual(["weight", "dimensions", "material"]);
    expect(saved.scrapeRecipe?.qualityPolicy?.preferredFinalFields).toEqual(["certificates"]);
    expect(saved.scrapeRecipe?.qualityPolicy?.typeCodeFallback).toBe("catalogNumber");
    expect(saved.scrapeRecipe?.qualityPolicy?.rationales?.requiredFinalFields).toBe("Custom official datasheets require physical final fields.");
    expect(saved.scrapeRecipe?.qualityPolicy?.rationales?.preferredFinalFields).toBe("Custom PDT examples treat certificates as preferred.");
    expect(saved.scrapeRecipe?.qualityPolicy?.rationales?.typeCodeFallback).toBe(
      "Custom official pages use catalog number as source-backed type code."
    );
    expect(saved.scrapeRecipe?.fallbackPolicy?.documentDownloadProfile).toBe("images-only");
    expect(saved.scrapeRecipe?.fallbackPolicy?.rationales?.documentDownloadProfile).toBe(
      "Custom official image documents are source-backed, but non-image files should not be saved."
    );
    expect(saved.scrapeRecipe?.fallbackPolicy?.skipPreferredFinalCompletenessRetry).toBe(true);
    expect(saved.scrapeRecipe?.fallbackPolicy?.rationales?.skipPreferredFinalCompletenessRetry).toBe(
      "Custom official pages do not improve preferred-only final fields."
    );
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
