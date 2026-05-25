import { describe, expect, it } from "vitest";
import { catalogTextMatches, fillCatalogTemplate, sameCatalogNumber } from "../src/server/scrapers/catalog-number.js";
import { buildLocalizedProductUrls } from "../src/server/scrapers/localized-urls.js";

describe("catalog number utilities", () => {
  it("fills catalog URL templates with common variants", () => {
    expect(fillCatalogTemplate("https://example.test/{partLower}/{partCompact}/{partAfterColonCompact}", "BPZ:VSG519K15-5")).toBe(
      "https://example.test/bpz%3Avsg519k15-5/bpzvsg519k155/vsg519k155"
    );
    expect(fillCatalogTemplate("https://www.eaton.com/us/en-us/skuPage.{partSlashBraces}.html", "P1-25/I2/SVB")).toBe(
      "https://www.eaton.com/us/en-us/skuPage.P1-25%7B%7DI2%7B%7DSVB.html"
    );
  });

  it("matches compact and after-colon catalog variants", () => {
    expect(catalogTextMatches("Part number VSG519K15 5 datasheet", "BPZ:VSG519K15-5")).toBe(true);
    expect(sameCatalogNumber("VSG519K15-5", "BPZ:VSG519K15-5")).toBe(true);
  });

  it("builds configured localized product URLs", () => {
    expect(
      buildLocalizedProductUrls("custom", "ABC-123", undefined, [
        { locale: "en", urlTemplate: "https://example.test/en/{part}" },
        { locale: "de", urlTemplate: "https://example.test/de/{partLower}" }
      ])
    ).toEqual({
      en: "https://example.test/en/ABC-123",
      de: "https://example.test/de/abc-123"
    });

    expect(buildLocalizedProductUrls("eaton", "P1-25/I2/SVB")).toEqual({
      en: "https://www.eaton.com/us/en-us/skuPage.P1-25%7B%7DI2%7B%7DSVB.html",
      de: "https://www.eaton.com/de/de-de/skuPage.P1-25%7B%7DI2%7B%7DSVB.html"
    });
  });
});
