import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { exportRunWorkbook } from "../src/server/excel.js";
import type { ManufacturerConfig, RunItemRecord, RunRecord } from "../src/shared/types.js";

describe("excel export", () => {
  it("writes a workbook for run results", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-xlsx-"));
    const run: RunRecord = {
      id: "test-run",
      manufacturerId: "abb",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
      total: 1,
      processed: 1,
      found: 1,
      partial: 0,
      failed: 0
    };
    const manufacturer: ManufacturerConfig = {
      id: "abb",
      canonicalName: "ABB",
      shortName: "ABB",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: []
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "1SDA126387R1",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "abb",
          catalogNumber: "1SDA126387R1",
          status: "found",
          confidence: 0.9,
          title: "ABB Padlock",
          localizedUrls: {
            en: "https://new.abb.com/smartlinks/en?ProductId=1SDA126387R1",
            de: "https://new.abb.com/smartlinks/de?ProductId=1SDA126387R1"
          },
          normalized: { weight: "0.028 kg", dimensions: "10 x 20 x 30 mm", material: "Steel", certificates: "CE" },
          attributes: [
            { group: "Structured Data", name: "weight", value: "0.028 kg" },
            { group: "Table", name: "Material", value: "Steel" }
          ],
          documents: [],
          sources: []
        }
      }
    ];
    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    await expect(fs.stat(filePath)).resolves.toBeTruthy();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    expect(headers).toContain("Product URL EN");
    expect(headers).toContain("Product URL DE");
    expect(headers).toContain("Material");
    expect(headers).toContain("Missing Required Fields");
    expect(products.getRow(2).getCell("I").value).toBe("https://new.abb.com/smartlinks/de?ProductId=1SDA126387R1");
    expect(products.getRow(2).getCell("M").value).toBe("Steel");
  });
});
