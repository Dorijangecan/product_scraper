import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ManufacturerConfig, ProductResult, RunItemRecord } from "../src/shared/types.js";
import { exportRunPdt } from "../src/server/pdt/exporter.js";
import { ACCESSORY_CONDITIONS_SHEET } from "../src/server/pdt/accessory-conditions-sheet.js";
import { cellText, describeSheet, firstDataRow } from "../src/server/pdt/sheet-descriptor.js";

const TEMPLATE_PATH = path.resolve("templates", "master_pdt.xlsx");
const MATRIX_PATH = path.resolve("fixtures", "_assets", "accessory-matrix-example.xlsx");

const manufacturer = {
  id: "test",
  canonicalName: "ACME Corp",
  shortName: "ACM",
  rateLimitMs: 0,
  officialBaseUrls: ["https://acme.test"],
  fallbackSources: []
} as unknown as ManufacturerConfig;

function item(catalogNumber: string, id: number): RunItemRecord {
  const result: ProductResult = {
    manufacturerId: "test",
    catalogNumber,
    status: "found",
    confidence: 0.9,
    title: `Enclosure ${catalogNumber}`,
    normalized: {},
    attributes: [],
    documents: [],
    sources: []
  };
  return {
    id,
    runId: "run-1",
    rowIndex: id,
    catalogNumber,
    status: "found",
    result,
    updatedAt: new Date().toISOString()
  };
}

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Body rows of a filled tab, as `column → text` maps (blank separator rows included as empty). */
function bodyRows(ws: ExcelJS.Worksheet): Array<Map<number, string>> {
  const descriptor = describeSheet(ws)!;
  const rows: Array<Map<number, string>> = [];
  for (let row = firstDataRow(descriptor); row <= (ws.rowCount || 0); row++) {
    const values = new Map<number, string>();
    for (let col = 1; col <= (ws.columnCount || 0); col++) {
      const text = cellText(ws.getCell(row, col).value);
      if (text) values.set(col, text);
    }
    rows.push(values);
  }
  while (rows.length > 0 && rows[rows.length - 1].size === 0) rows.pop();
  return rows;
}

describe("PDT export with an accessory matrix", () => {
  it("fills Product Accessory and Connection Point Information from the matrix", async () => {
    const dir = await tempDir("scraper-pdt-accessory-matrix-");
    const outputPath = path.join(dir, "out.xlsx");

    const result = await exportRunPdt({
      manufacturer,
      items: [item("A444GSC", 1), item("A664GSC", 2)],
      templatePath: TEMPLATE_PATH,
      outputPath,
      accessoryMatrixPath: MATRIX_PATH,
      accessoryMatrixFileName: "Accessori matrix.xlsx"
    });

    expect(result.accessoryMatrix).toBeDefined();
    const summary = result.accessoryMatrix!;
    expect(summary.fileName).toBe("Accessori matrix.xlsx");
    expect(summary.accessoryRows).toBeGreaterThan(100);
    expect(summary.connectionPointRows).toBeGreaterThan(100);
    expect(summary.pointCount).toBe(4);
    // Only two of the matrix's main parts were scraped; the rest are still written but reported.
    expect(summary.mainPartsNotInRun).not.toContain("A444GSC");
    expect(summary.mainPartsNotInRun.length).toBe(summary.mainPartCount - 2);
    expect(summary.warnings.some((warning) => /not in this run/i.test(warning))).toBe(true);

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);

    // Product Accessory keeps the template's label column, so the macro's staging layout
    // (A/B/C/E/I) lands one column further right: main part | point | accessory | _ | relation |
    // ... | variant. The writer resolves these by PDT property id, not by position.
    const accessory = bodyRows(out.getWorksheet("Product Accessory")!);
    expect(result.filledSheets["Product Accessory"]).toBe(summary.accessoryRows);
    expect([...accessory[0].entries()]).toEqual([
      [2, "A444GSC"],
      [3, "MP_MP_1"],
      [4, "CMFKSS"],
      [6, "1"],
      [10, "1"]
    ]);
    expect(accessory[2].get(3)).toBe("MP_B_2");
    expect(accessory[2].get(10)).toBe("2"); // variant index from the "_2" suffix
    expect(accessory[4].size).toBe(0); // blank row between main-part groups
    expect(accessory[5].get(2)).toBe("A664GSC");

    // Connection Point Information: this tab keeps its label column, so the macro's C/D/G/I/U/
    // AF/AG/AJ/AP columns apply as-is.
    const connectionPoints = bodyRows(out.getWorksheet("Connection Point Information")!);
    expect(result.filledSheets["Connection Point Information"]).toBe(summary.connectionPointRows);
    expect([...connectionPoints[0].entries()]).toEqual([
      [3, "A444GSC"],
      [4, "MP_MP_1"],
      [7, "User supplementary point 1"],
      [9, "aa"],
      [21, "aa"],
      [32, "aa"],
      [33, "aa"],
      [36, "aa"],
      [42, "User supplementary point 1"]
    ]);
    expect(connectionPoints[3].get(7)).toBe("User supplementary point 4");
    expect(connectionPoints[4].size).toBe(0);
    // Numbering restarts for the next main part.
    expect(connectionPoints[5].get(3)).toBe("A664GSC");
    expect(connectionPoints[5].get(7)).toBe("User supplementary point 1");
  });

  it("ignores scraped and curated accessory rows while a matrix is attached", async () => {
    const dir = await tempDir("scraper-pdt-accessory-matrix-replaces-");
    const outputPath = path.join(dir, "out.xlsx");
    const scraped = item("852C-B24RGYPQD5", 1);
    scraped.result!.manufacturerId = "rockwell";
    scraped.result!.attributes = [
      { group: "Accessories", name: "Recommended accessories", value: "852C-ABVM bracket", sourceType: "official" }
    ];

    const result = await exportRunPdt({
      manufacturer: { ...manufacturer, id: "rockwell" } as ManufacturerConfig,
      items: [scraped],
      templatePath: TEMPLATE_PATH,
      outputPath,
      accessoryMatrixPath: MATRIX_PATH
    });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const values = bodyRows(out.getWorksheet("Product Accessory")!).flatMap((row) => [...row.values()]);
    expect(values).not.toContain("852C-ABVM");
    expect(values).not.toContain("852C-B24RGYPQD5");
    expect(values).toContain("CMFKSS");
    expect(result.accessoryMatrix!.accessoryRows).toBe(result.filledSheets["Product Accessory"]);
  });

  it("leaves both tabs empty when no matrix is attached", async () => {
    const dir = await tempDir("scraper-pdt-accessory-matrix-absent-");
    const outputPath = path.join(dir, "out.xlsx");

    const result = await exportRunPdt({
      manufacturer,
      items: [item("A444GSC", 1)],
      templatePath: TEMPLATE_PATH,
      outputPath
    });

    expect(result.accessoryMatrix).toBeUndefined();
    expect(result.filledSheets["Connection Point Information"]).toBe(0);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    expect(bodyRows(out.getWorksheet("Connection Point Information")!)).toEqual([]);
  });

  it("writes the INLIST conditions into the products workbook", async () => {
    const dir = await tempDir("scraper-pdt-accessory-matrix-conditions-");
    const outputPath = path.join(dir, "out.xlsx");
    const productsPath = path.join(dir, "products.xlsx");
    const products = new ExcelJS.Workbook();
    products.addWorksheet("Products").addRow(["catalog"]);
    await products.xlsx.writeFile(productsPath);

    const result = await exportRunPdt({
      manufacturer,
      items: [item("A444GSC", 1)],
      templatePath: TEMPLATE_PATH,
      outputPath,
      accessoryMatrixPath: MATRIX_PATH,
      productsWorkbookPath: productsPath
    });

    expect(result.accessoryMatrix!.conditionsPath).toBe(productsPath);
    expect(result.accessoryMatrix!.conditionCount).toBe(4);

    const patched = new ExcelJS.Workbook();
    await patched.xlsx.readFile(productsPath);
    expect(patched.getWorksheet("Products")).toBeDefined(); // existing sheets survive
    const conditions = patched.getWorksheet(ACCESSORY_CONDITIONS_SHEET)!;
    expect(cellText(conditions.getCell(1, 1).value)).toBe("Point");
    expect(cellText(conditions.getCell(2, 1).value)).toBe("MP_MP_1");
    expect(cellText(conditions.getCell(2, 2).value)).toMatch(/^INLIST\('A444GSC,A664GSC,/);
    expect(cellText(conditions.getCell(5, 1).value)).toBe("MP_C_1");
  });

  it("reports, but survives, a missing products workbook", async () => {
    const dir = await tempDir("scraper-pdt-accessory-matrix-noproducts-");
    const outputPath = path.join(dir, "out.xlsx");

    const result = await exportRunPdt({
      manufacturer,
      items: [item("A444GSC", 1)],
      templatePath: TEMPLATE_PATH,
      outputPath,
      accessoryMatrixPath: MATRIX_PATH,
      productsWorkbookPath: path.join(dir, "does-not-exist.xlsx")
    });

    expect(result.accessoryMatrix!.conditionsPath).toBeUndefined();
    expect(result.accessoryMatrix!.warnings.some((warning) => /accessory conditions/i.test(warning))).toBe(true);
    // The PDT itself is still written.
    await expect(fs.access(outputPath)).resolves.toBeUndefined();
  });
});
