import { describe, expect, it } from "vitest";
import { catalogTableKeyFor, isCatalogIdHeaderCell, isCatalogTableHeaderText } from "../src/server/scrapers/catalog-table-vocabulary.js";

describe("isCatalogIdHeaderCell", () => {
  it("recognizes English id-column labels as whole cells", () => {
    for (const cell of ["Catalog Number", "Cat. No.", "Part Number", "Order No.", "Ordering Code", "Type Code", "MLFB", "Item No."]) {
      expect(isCatalogIdHeaderCell(cell)).toBe(true);
    }
  });

  it("recognizes a bare '#' as a No./Number stand-in, but only after an identifier keyword", () => {
    // Real Saginaw/SCE floor-stand-kit datasheets header their ordering table "PART #" rather than
    // "Part No."/"Part Number" (confirmed via raw positioned-text dump of a real installation
    // manual PDF). A standalone "#" (a plain row-index column) must NOT qualify.
    for (const cell of ["PART #", "part#", "Order #", "Catalog #", "Article #", "Item #", "Model #"]) {
      expect(isCatalogIdHeaderCell(cell)).toBe(true);
    }
    for (const cell of ["#", "No. 2", "Part 2"]) {
      expect(isCatalogIdHeaderCell(cell)).toBe(false);
    }
  });

  it("recognizes German / French / Italian id-column labels", () => {
    for (const cell of ["Bestell-Nr.", "Bestellnummer", "Artikelnummer", "Art.-Nr.", "Sachnummer", "Ident-Nr.", "Référence", "Réf.", "Codice", "Codice articolo"]) {
      expect(isCatalogIdHeaderCell(cell)).toBe(true);
    }
  });

  it("does NOT treat bare ambiguous words as id headers (handled structurally instead)", () => {
    for (const cell of ["Type", "Model", "Weight", "Description", "A 12 mm rod of type X"]) {
      expect(isCatalogIdHeaderCell(cell)).toBe(false);
    }
  });
});

describe("catalogTableKeyFor", () => {
  it("maps English column labels", () => {
    expect(catalogTableKeyFor("Catalog Number")).toBe("catalogNumber");
    expect(catalogTableKeyFor("Description")).toBe("description");
    expect(catalogTableKeyFor("Weight")).toBe("weight");
    expect(catalogTableKeyFor("Dimensions")).toBe("dimensions");
    expect(catalogTableKeyFor("Width [mm]")).toBe("width");
  });

  it("maps German / French / Italian column labels", () => {
    expect(catalogTableKeyFor("Bestell-Nr.")).toBe("catalogNumber");
    expect(catalogTableKeyFor("Beschreibung")).toBe("description");
    expect(catalogTableKeyFor("Gewicht")).toBe("weight");
    expect(catalogTableKeyFor("Abmessungen")).toBe("dimensions");
    expect(catalogTableKeyFor("Werkstoff")).toBe("material");
    expect(catalogTableKeyFor("Breite")).toBe("width");
    expect(catalogTableKeyFor("Höhe")).toBe("height");
    expect(catalogTableKeyFor("Tiefe")).toBe("depth");
    expect(catalogTableKeyFor("Spannung")).toBe("voltage");
    expect(catalogTableKeyFor("Strom")).toBe("current");
    expect(catalogTableKeyFor("Référence")).toBe("catalogNumber");
    expect(catalogTableKeyFor("Poids")).toBe("weight");
  });

  it("returns undefined for unrecognized labels", () => {
    expect(catalogTableKeyFor("Notes")).toBeUndefined();
    expect(catalogTableKeyFor("")).toBeUndefined();
  });
});

describe("isCatalogTableHeaderText", () => {
  it("accepts a header row that names any recognized column keyword", () => {
    expect(isCatalogTableHeaderText("Description | Dimensions | Catalog Number")).toBe(true);
    expect(isCatalogTableHeaderText("Bestell-Nr. Gewicht Abmessungen")).toBe(true);
  });

  it("rejects a plain prose line", () => {
    expect(isCatalogTableHeaderText("The following notes apply to installation.")).toBe(false);
  });
});
