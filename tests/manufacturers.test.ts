import { describe, expect, it } from "vitest";
import { listManufacturerConfigs } from "../src/server/config/manufacturers.js";

describe("manufacturer configuration", () => {
  it("includes the supported built-in manufacturers", () => {
    const manufacturers = listManufacturerConfigs();
    const byId = new Map(manufacturers.map((manufacturer) => [manufacturer.id, manufacturer]));

    expect([...byId.keys()]).toEqual(
      expect.arrayContaining(["abb", "balluff", "sce", "nvent", "rockwell", "eaton", "eta", "schmersal", "schneider", "siemens", "spelsberg"])
    );
    expect(byId.get("balluff")?.shortName).toBe("BAL");
    expect(byId.get("balluff")?.concurrency).toBe(2);
    expect(byId.get("sce")?.shortName).toBe("SCE");
    expect(byId.get("schneider")?.shortName).toBe("SE");
    expect(byId.get("siemens")?.shortName).toBe("SIE");
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
});
