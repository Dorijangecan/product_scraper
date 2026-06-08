import { describe, expect, it } from "vitest";
import { parseEatonCbeCatalogRecords } from "../src/server/scrapers/eaton.js";

// One representative row per E6-catalog family, tab-delimited exactly as pdf-parse emits them.
const CATALOG = [
  "Rated current\tPart number\tCatalog Number\tUnit", // header — no CBE token, must be skipped
  "40\t1\tEIS-40/1\tCBE04417\t12",
  "40\t3\tEIS-40/3\tCBE04419\t4",
  "1\tE6-1/1/B\tCBE03319\t12",
  "1/0.03\tELD6-1/1N/C/003\tCBE03637\t6",
  "6/0.03\tED6-6/1N/C/003\tCBE03553\t6",
  "E6,ED6,ELD6/1NO1NC\tZ-AHK\tCBE04437\t12"
].join("\n");

describe("Eaton E6 catalog parser", () => {
  it("captures every family, not just EIS/ED6", () => {
    const records = parseEatonCbeCatalogRecords(CATALOG);
    expect(records.size).toBe(6);
  });

  it("derives structured fields from the authoritative part number", () => {
    const records = parseEatonCbeCatalogRecords(CATALOG);
    expect(records.get("CBE04417")).toMatchObject({ partNumber: "EIS-40/1", ratedCurrent: "40", poles: "1" });
    expect(records.get("CBE03319")).toMatchObject({
      partNumber: "E6-1/1/B",
      ratedCurrent: "1",
      poles: "1",
      releaseCharacteristic: "B"
    });
    expect(records.get("CBE03637")).toMatchObject({
      partNumber: "ELD6-1/1N/C/003",
      poles: "2",
      residualCurrent: "0.03",
      releaseCharacteristic: "C"
    });
    expect(records.get("CBE03553")).toMatchObject({ partNumber: "ED6-6/1N/C/003", residualCurrent: "0.03" });
    expect(records.get("CBE04437")).toMatchObject({ partNumber: "Z-AHK", productName: "E6 series accessory" });
  });
});
