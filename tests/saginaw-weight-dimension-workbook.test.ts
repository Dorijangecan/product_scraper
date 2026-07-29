import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AttributeRecord, RunItemRecord } from "../src/shared/types.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";
import { parseSceProductPage } from "../src/server/scrapers/sce.js";
import {
  buildSaginawWeightDimensionRows,
  saginawWorkbookPathForPdt,
  writeSaginawWeightDimensionWorkbook
} from "../src/server/pdt/saginaw-weight-dimension-workbook.js";

const FIXTURE_PAGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "sce-SCE-6PBSSI-page",
  "page.html"
);
const FIXTURE_URL = "https://www.saginawcontrol.com/partnumber_info/?n=SCE-6PBSSI";

function fetched(text: string, effectiveUrl: string): FetchedText {
  return {
    requestedUrl: effectiveUrl,
    effectiveUrl,
    statusCode: 200,
    contentType: "text/html",
    text,
    fetchedAt: "2026-07-29T00:00:00.000Z",
    fromCache: false
  };
}

async function fixtureItem(): Promise<RunItemRecord> {
  const html = await fs.readFile(FIXTURE_PAGE, "utf8");
  const result = parseSceProductPage("SCE-6PBSSI", fetched(html, FIXTURE_URL));
  return {
    id: 1,
    runId: "run-1",
    rowIndex: 0,
    catalogNumber: "SCE-6PBSSI",
    status: "found",
    result,
    updatedAt: "2026-07-29T00:00:00.000Z"
  };
}

function sceItem(attributes: AttributeRecord[]): RunItemRecord {
  return {
    id: 2,
    runId: "run-1",
    rowIndex: 1,
    catalogNumber: "SCE-SYNTHETIC",
    status: "partial",
    result: {
      manufacturerId: "sce",
      catalogNumber: "SCE-SYNTHETIC",
      status: "partial",
      confidence: 0.5,
      normalized: {},
      attributes,
      documents: [],
      sources: []
    },
    updatedAt: "2026-07-29T00:00:00.000Z"
  };
}

describe("saginaw weight & dimension workbook", () => {
  it("repeats the recorded product page's digits with no unit marker and a decimal comma", async () => {
    const [row] = buildSaginawWeightDimensionRows([await fixtureItem()]);

    expect(row.catalogNumber).toBe("SCE-6PBSSI");
    expect(row.description).toBe("S.S. PB Enclosure");
    // Page prints 9.50" / 6.25" / 3.00" / 5.00 lbs — same digits, no unit, comma separator.
    expect(row.height).toBe("9,50");
    expect(row.width).toBe("6,25");
    expect(row.depth).toBe("3,00");
    expect(row.weight).toBe("5,00");
    expect(row.productUrl).toBe(FIXTURE_URL);
  });

  it("also strips the H/W/D suffix the dimension widget prints", () => {
    const [row] = buildSaginawWeightDimensionRows([sceItem([
      { group: "Dimensions", name: "Height", value: "20.00H" },
      { group: "Dimensions", name: "Width", value: "16.00W" },
      { group: "Dimensions", name: "Depth", value: "8.00D" },
      { group: "Product Information", name: "Weight", value: "41 lb" }
    ])]);

    expect([row.height, row.width, row.depth]).toEqual(["20,00", "16,00", "8,00"]);
    expect(row.weight).toBe("41");
  });

  it("drops values that are not a single bare number instead of guessing", () => {
    const [row] = buildSaginawWeightDimensionRows([sceItem([
      { group: "Search Result", name: "Height", value: "20.00 x 16.00" },
      { group: "Product Specifications", name: "Weight", value: "see table" }
    ])]);

    expect(row.height).toBeUndefined();
    expect(row.weight).toBeUndefined();
  });

  it("leaves metric values out instead of printing them under inch/lbs headers", () => {
    const [row] = buildSaginawWeightDimensionRows([sceItem([
      { group: "Product Specifications", name: "Height", value: "241 mm" },
      { group: "Product Specifications", name: "Weight", value: "2.27 kg" }
    ])]);

    expect(row.height).toBeUndefined();
    expect(row.weight).toBeUndefined();
  });

  it("writes the companion workbook only for Saginaw runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "saginaw-extra-"));
    const pdtPath = path.join(dir, "run-1_PDT.xlsx");
    const items = [await fixtureItem()];

    expect(await writeSaginawWeightDimensionWorkbook(pdtPath, { id: "abb" }, items)).toBeUndefined();

    const written = await writeSaginawWeightDimensionWorkbook(pdtPath, { id: "sce" }, items);
    expect(written).toBe(saginawWorkbookPathForPdt(pdtPath));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(written!);
    const sheet = workbook.worksheets[0];
    expect(sheet.name).toBe("Saginaw Weight & Dimensions");
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      "Part Number",
      "Description",
      "Height (in)",
      "Width (in)",
      "Depth (in)",
      "Est. Ship Weight (lbs)",
      "Product Page"
    ]);
    expect(sheet.getCell("A2").value).toBe("SCE-6PBSSI");
    expect(sheet.getCell("C2").value).toBe("9,50");
    expect(sheet.getCell("F2").value).toBe("5,00");
    // Text format, so Excel keeps 9,50 as typed instead of parsing it into a number.
    expect(sheet.getCell("C2").numFmt).toBe("@");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
