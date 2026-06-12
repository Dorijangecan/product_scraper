import { describe, expect, it } from "vitest";
import { listManufacturerConfigs } from "../src/server/config/manufacturers.js";
import { ETAConnector } from "../src/server/scrapers/eta.js";
import type { ScrapeContext } from "../src/server/scrapers/types.js";

describe("manufacturer configuration", () => {
  it("includes the supported built-in manufacturers", () => {
    const manufacturers = listManufacturerConfigs();
    const byId = new Map(manufacturers.map((manufacturer) => [manufacturer.id, manufacturer]));

    expect([...byId.keys()]).toEqual(
      expect.arrayContaining(["abb", "balluff", "sce", "nvent", "rockwell", "eaton", "eta", "phoenix", "schmersal", "schneider", "siemens", "spelsberg", "scame"])
    );
    expect(byId.get("balluff")?.shortName).toBe("BAL");
    expect(byId.get("balluff")?.concurrency).toBe(2);
    expect(byId.get("balluff")?.scrapeRecipe?.fallbackPolicy?.documentDownloadProfile).toBe("quality");
    expect(byId.get("balluff")?.scrapeRecipe?.fallbackPolicy?.rationales?.documentDownloadProfile).toMatch(/official.*source PDF/i);
    expect(byId.get("abb")?.scrapeRecipe?.qualityPolicy?.preferredFinalFields).toEqual(["material"]);
    expect(byId.get("abb")?.scrapeRecipe?.qualityPolicy?.rationales?.preferredFinalFields).toMatch(/official.*manual PDT/i);
    expect(byId.get("sce")?.shortName).toBe("SCE");
    expect(byId.get("sce")?.scrapeRecipe?.qualityPolicy?.requiredFinalFields).toEqual(["weight", "dimensions", "material"]);
    expect(byId.get("sce")?.scrapeRecipe?.qualityPolicy?.rationales?.requiredFinalFields).toMatch(/manual PDT.*source-backed/i);
    expect(byId.get("schneider")?.shortName).toBe("SE");
    expect(byId.get("rockwell")?.scrapeRecipe?.qualityPolicy?.typeCodeFallback).toBe("catalogNumber");
    expect(byId.get("rockwell")?.scrapeRecipe?.qualityPolicy?.rationales?.typeCodeFallback).toMatch(/official.*manual PDT/i);
    expect(byId.get("rockwell")?.scrapeRecipe?.fallbackPolicy?.documentDownloadProfile).toBe("quality");
    expect(byId.get("rockwell")?.scrapeRecipe?.fallbackPolicy?.rationales?.documentDownloadProfile).toMatch(/official.*source PDFs/i);
    expect(byId.get("rockwell")?.scrapeRecipe?.fallbackPolicy?.skipPreferredFinalCompletenessRetry).toBe(true);
    expect(byId.get("rockwell")?.scrapeRecipe?.fallbackPolicy?.rationales?.skipPreferredFinalCompletenessRetry).toMatch(/official.*manual PDT/i);
    expect(byId.get("siemens")?.shortName).toBe("SIE");
    expect(byId.get("phoenix")?.shortName).toBe("PHX");
    expect(byId.get("scame")?.shortName).toBe("SCA");
    expect(byId.get("scame")?.scrapeRecipe?.fallbackPolicy?.distributorFallback).toBe(false);
    expect(byId.get("scame")?.scrapeRecipe?.fallbackPolicy?.documentDownloadProfile).toBe("quality");
    expect(byId.get("eta")?.fallbackSources[0]?.directUrlTemplates.some((template) => template.includes("{partSnake}"))).toBe(true);
  });

  it("configures nVent discovery beyond HOFFMAN-only product URLs", () => {
    const nvent = listManufacturerConfigs().find((manufacturer) => manufacturer.id === "nvent");
    const templates = nvent?.fallbackSources.flatMap((source) => source.directUrlTemplates) ?? [];

    expect(nvent?.canonicalName).toBe("nVent");
    expect(nvent?.officialBaseUrls).toContain("https://www.chemelex.com");
    expect(templates).toEqual(expect.arrayContaining([
      "https://www.nvent.com/en-us/caddy/products/efs{partLower}",
      "https://www.nvent.com/en-us/erico/products/efs{partLower}",
      "https://www.nvent.com/en-us/eriflex/products/efs{partLower}",
      "https://www.nvent.com/en-us/schroff/products/enc{partLower}"
    ]));
    expect(nvent?.scrapeRecipe?.discoveryPolicy?.allowedOfficialDomains).toContain("chemelex.com");
    expect(nvent?.scrapeRecipe?.discoveryPolicy?.searchUrlTemplates).toContain("https://www.chemelex.com/en-us/raychem/search?keyword={part}");
  });

  it("configures Eaton official site-search API discovery", () => {
    const eaton = listManufacturerConfigs().find((manufacturer) => manufacturer.id === "eaton");
    const searchTemplates = eaton?.scrapeRecipe?.searchUrlTemplates ?? [];

    expect(searchTemplates.some((template) => template.includes("/site-search/jcr:content/root/responsivegrid/search_results.searchTerm${part}"))).toBe(true);
    expect(searchTemplates.some((template) => template.includes("/skuPage.{partSlashBraces}.html"))).toBe(true);
  });

  it("routes ETA 3120-F variants through the declared official family datasheet rule", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "eta")!;
    const connector = new ETAConnector();
    const result = await connector.scrape("3120-F521-P7T1-W01D-16A", {
      manufacturer,
      runDir: "",
      documentsDir: "",
      http: {} as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async () => undefined
      }
    });

    expect(result.status).toBe("partial");
    expect(result.productUrl).toContain("D_3120-F_en.pdf");
    expect(result.documents[0]).toMatchObject({ type: "datasheet", sourceType: "official-fallback" });
    expect(result.attributes.find((attr) => attr.name === "Catalog Number")?.value).toBe("3120-F521-P7T1-W01D-16A");
    expect(result.normalized.current).toBeUndefined();
  });

  it("configures Schmersal and Spelsberg discovery through current official search pages", () => {
    const manufacturers = listManufacturerConfigs();
    const schmersal = manufacturers.find((manufacturer) => manufacturer.id === "schmersal");
    const spelsberg = manufacturers.find((manufacturer) => manufacturer.id === "spelsberg");

    expect(schmersal?.officialBaseUrls).toContain("https://products.schmersal.com");
    expect(schmersal?.scrapeRecipe?.searchUrlTemplates).toContain("https://products.schmersal.com/en_US/search?query={part}");
    expect(schmersal?.scrapeRecipe?.discoveryPolicy?.allowedOfficialDomains).toContain("products.schmersal.com");

    expect(spelsberg?.officialBaseUrls).toContain("https://www.spelsberg.com");
    expect(spelsberg?.scrapeRecipe?.searchUrlTemplates).toContain("https://www.spelsberg.com/product-finder/?query={part}");
    expect(spelsberg?.scrapeRecipe?.extractionPolicy?.documentUrlPatterns).toContain("\\.download\\?file=.+\\.pdf");
  });

  it("configures SCAME through official techsheet PDFs", () => {
    const scame = listManufacturerConfigs().find((manufacturer) => manufacturer.id === "scame");

    expect(scame?.officialBaseUrls).toEqual(expect.arrayContaining(["https://www.scame.com", "https://techsheet.scame.com"]));
    expect(scame?.homepageUrl).toBe("https://www.scame.com/web/scame-uk/home");
    expect(scame?.scrapeRecipe?.requiredDocuments).toEqual(["datasheet"]);
    expect(scame?.scrapeRecipe?.extractionPolicy?.documentUrlPatterns).toEqual(expect.arrayContaining([
      "techsheet\\.scame\\.com/infodata/.+\\.pdf",
      "techsheet\\.scame\\.com/Download/dms/cad/pdf/.+\\.pdf"
    ]));
  });
});
