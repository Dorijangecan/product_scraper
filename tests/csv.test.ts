import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { extractCatalogNumbers, previewCsv } from "../src/server/csv.js";

describe("csv parser", () => {
  it("detects a likely catalog column and de-duplicates values", async () => {
    const csv = Buffer.from("Description,Catalog Number\nBreaker,1SDA126387R1\nBreaker duplicate,1SDA126387R1\nBox,SCE-20EL2010LP\n");
    const preview = await previewCsv(csv);
    expect(preview.detectedColumn).toBe("Catalog Number");
    expect(preview.rowCount).toBe(3);
    await expect(extractCatalogNumbers(csv, "Catalog Number")).resolves.toEqual(["1SDA126387R1", "SCE-20EL2010LP"]);
  });

  it("accepts a headerless one-column catalog list", async () => {
    const csv = Buffer.from("SCE-12H2406LP\nSCE-12H2408LP\n");
    const preview = await previewCsv(csv);
    expect(preview.columns).toEqual(["Catalog Number"]);
    expect(preview.detectedColumn).toBe("Catalog Number");
    expect(preview.rowCount).toBe(2);
    await expect(extractCatalogNumbers(csv, "Catalog Number")).resolves.toEqual(["SCE-12H2406LP", "SCE-12H2408LP"]);
  });

  it("accepts semicolon-delimited Excel CSV exports", async () => {
    const csv = Buffer.from("Opis;Kataloski broj\nPrekidac;1SDA126387R1\nKutija;SCE-20EL2010LP\n");
    const preview = await previewCsv(csv);
    expect(preview.columns).toEqual(["Opis", "Kataloski broj"]);
    expect(preview.detectedColumn).toBe("Kataloski broj");
    await expect(extractCatalogNumbers(csv, "Kataloski broj")).resolves.toEqual(["1SDA126387R1", "SCE-20EL2010LP"]);
  });

  it("accepts an Excel workbook even when uploaded as a csv-named file", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["BCC039H"]);
    sheet.addRow(["BNI00CR"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const preview = await previewCsv(buffer);
    expect(preview.columns).toEqual(["Catalog Number"]);
    expect(preview.rowCount).toBe(2);
    await expect(extractCatalogNumbers(buffer, "Catalog Number")).resolves.toEqual(["BCC039H", "BNI00CR"]);
  });
});
