import * as cheerio from "cheerio";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readHtmlTableAttributes } from "../src/server/scrapers/html-table-reader.js";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";

function read(html: string, catalogNumber: string) {
  return readHtmlTableAttributes(cheerio.load(html), catalogNumber, "https://example.test/product");
}

describe("HTML table reader", () => {
  it("expands spans, merges multi-row headers, and selects the one matching catalog row", () => {
    const result = read(
      `<table>
        <thead>
          <tr><th rowspan="2">Catalog Number</th><th colspan="2">Dimensions</th></tr>
          <tr><th>Width mm</th><th>Height mm</th></tr>
        </thead>
        <tbody><tr><td>ABC-100</td><td>10</td><td>20</td></tr></tbody>
      </table>`,
      "ABC-100"
    );

    expect(result.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Dimensions / Width mm", value: "10" }),
      expect.objectContaining({ name: "Dimensions / Height mm", value: "20" })
    ]));
    expect(result.handledTables.size).toBe(1);
  });

  it("adds a unit published only in the header without losing an AC/DC qualifier", () => {
    const result = read(
      `<table><tr><th>Article number</th><th>Rated voltage [V]</th></tr>
        <tr><td>PRD-55</td><td>24 DC</td></tr></table>`,
      "PRD-55"
    );

    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "Rated voltage [V]", value: "24 V DC" }));
  });

  it("reconstructs a selected option column from the ordering-code segment", () => {
    const result = read(
      `<table><thead><tr><th>Length mm</th><th colspan="2">Cable length m</th></tr></thead>
        <tbody>
          <tr><td><select><option>180</option></select></td><td colspan="2"><select><option>2,5</option><option>5</option></select></td></tr>
          <tr><td>180</td><td>2,5</td><td>5</td></tr>
        </tbody>
      </table>`,
      "GN-6284-KU-2,5"
    );

    expect(result.attributes).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Cable length m", value: "2,5" })]));
    expect(result.attributes.some((attribute) => attribute.name === "Cable length m" && attribute.value === "5")).toBe(false);
    expect(result.suppressedPairs).toContainEqual({ name: "Cable length m", value: "2,5 5" });
  });

  it("refuses to guess when the requested catalog labels two different columns", () => {
    const result = read(
      `<table><tr><th>Property</th><th>DUP-1</th><th>DUP-1</th></tr>
        <tr><td>Weight</td><td>1 kg</td><td>2 kg</td></tr>
      </table>`,
      "DUP-1"
    );

    expect(result.attributes).toEqual([]);
    expect(result.handledTables.size).toBe(1);
  });

  it("selects the requested catalog column in a property-per-row comparison table", () => {
    const result = read(
      `<table><thead><tr><th>Property</th><th>ABC-100</th><th>ABC-200</th></tr></thead>
        <tbody>
          <tr><th>Color</th><td>Red</td><td>Black</td></tr>
          <tr><th>Rated voltage [V]</th><td>24 DC</td><td>230 AC</td></tr>
        </tbody>
      </table>`,
      "ABC-100"
    );

    expect(result.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Color", value: "Red", scope: "variant" }),
      expect.objectContaining({ name: "Rated voltage [V]", value: "24 V DC", scope: "variant" })
    ]));
    expect(result.attributes.some((attribute) => /Black|230 AC/.test(attribute.value))).toBe(false);
    expect(result.handledTables.size).toBe(1);
  });

  it("selects only the requested option columns in the recorded Ganter interactive configurator", () => {
    const html = readFileSync(new URL("../fixtures/gan-GN-3310-19-LK-K2-page/page.html", import.meta.url), "utf8");
    const result = readHtmlTableAttributes(
      cheerio.load(html),
      "GN 3310-19-LK-K2",
      "https://live-katalog.ganternorm.com/en/products/2.3-Operating-parts/Push-buttons-and-switches/GN-3310-Buttons"
    );

    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "d Connection type K2 / K5", value: "6", scope: "variant" }));
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "Installation opening Ø", value: "19 +0,1 / +0,3", scope: "variant" }));
    expect(result.attributes.some((attribute) => attribute.name === "Connection type S025" && attribute.value === "5")).toBe(false);
    expect(result.attributes.some((attribute) => attribute.name === "S025" && /Cable with plug/i.test(attribute.value))).toBe(false);
    expect(result.handledTables.size).toBeGreaterThanOrEqual(1);
  });

  it("does not let the semantic td[headers] fallback reintroduce Ganter's S025 sibling column", () => {
    const html = readFileSync(new URL("../fixtures/gan-GN-3310-19-LK-K5-page/page.html", import.meta.url), "utf8");
    const result = parseGenericProductPage(
      "gan",
      "GN 3310-19-LK-K5",
      {
        requestedUrl: "https://www.ganternorm.com/en/product/gn331019lkk5",
        effectiveUrl: "https://www.ganternorm.com/en/product/gn331019lkk5",
        statusCode: 200,
        contentType: "text/html",
        text: html,
        fetchedAt: "2026-08-21T00:00:00.000Z",
        fromCache: true
      },
      "official",
      "generic"
    );

    expect(result.attributes).toContainEqual(expect.objectContaining({
      group: "Catalog variant option",
      name: "Connection type",
      value: "K5 - Cable, end open, 5 m"
    }));
    expect(result.attributes.some((attribute) => attribute.name === "Connection type S025" && attribute.value === "5")).toBe(false);
  });
});
