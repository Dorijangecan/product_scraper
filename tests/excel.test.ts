import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { exportRunWorkbook } from "../src/server/excel.js";
import type { ManufacturerConfig, RunItemRecord, RunRecord } from "../src/shared/types.js";

function cellText(cell: ExcelJS.Cell): string {
  return cell.text || String(cell.value ?? "");
}

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
          normalized: { weight: "0.028 kg", dimensions: "10 x 20 x 30 mm", material: "Steel", voltage: "24 V DC", current: "2 A", certificates: "CE" },
          attributes: [
            { group: "ABB Product Data", name: "Product ID", value: "1SDA126387R1", sourceType: "official" },
            { group: "ABB Product Data", name: "Extended Product Type", value: "KLP-D", sourceType: "official" },
            { group: "ABB Product Data", name: "EAN", value: "8056221267000", sourceType: "official" },
            { group: "ABB Product Data", name: "Catalog Description", value: "ABB padlock device", sourceType: "official" },
            { group: "ABB Product Data", name: "Rated Operational Voltage", value: "24 V DC", sourceType: "official" },
            { group: "ABB Product Data", name: "Rated Current", value: "2 A", sourceType: "official" },
            { group: "ABB Product Data", name: "Standards", value: "IEC/UL", sourceType: "official" },
            { group: "ABB Product Classification", name: "ECLASS 14.0", value: "27-14-23-90", sourceType: "official" },
            { group: "ABB Product Data", name: "Product Sales Status", value: "Active", sourceType: "official" },
            { group: "ABB Product Data", name: "Country of Origin", value: "Italy", sourceType: "official" },
            { group: "ABB Accessories", name: "Accessory", value: "1SBN010015R1001 - Auxiliary Contact Block (Qty: 1 piece)", sourceType: "official" },
            { group: "Structured Data", name: "weight", value: "0.028 kg" },
            { group: "Table", name: "Material", value: "Steel" }
          ],
          documents: [
            {
              type: "datasheet",
              label: "Data Sheet, Technical Information: 1SBC100214C0202",
              url: "https://search.abb.com/library/Download.aspx?DocumentID=1SBC100214C0202&LanguageCode=en&DocumentPartId=&Action=Launch",
              sourceType: "official",
              parser: "abb-product-model"
            },
            {
              type: "manual",
              label: "Instructions and Manuals: 1SBC101027M6801",
              url: "https://search.abb.com/library/Download.aspx?DocumentID=1SBC101027M6801&LanguageCode=en&DocumentPartId=&Action=Launch",
              sourceType: "official",
              parser: "abb-product-model"
            },
            {
              type: "certificate",
              label: "RoHS Declaration: 9AKK108466A1424",
              url: "https://search.abb.com/library/Download.aspx?DocumentID=9AKK108466A1424&LanguageCode=en&DocumentPartId=&Action=Launch",
              sourceType: "official",
              parser: "abb-embedded-json-document-ref",
              confidence: 0.9
            }
          ],
          sources: [],
          evidence: [
            {
              kind: "normalized",
              name: "weight",
              value: "0.028 kg",
              sourceUrl: "https://new.abb.com/smartlinks/en?ProductId=1SDA126387R1",
              sourceType: "official"
            }
          ]
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
    expect(headers).toContain("Image");
    expect(headers).toContain("Image Local Path");
    expect(headers).toContain("Image Count");
    expect(headers).toContain("All Image URLs");
    expect(headers).toContain("Product Type");
    expect(headers).toContain("Device Type");
    expect(headers).toContain("Device Type Confidence");
    expect(headers).toContain("Device Type Evidence");
    expect(headers).toContain("Copy Summary");
    expect(headers).toContain("EAN / GTIN");
    expect(headers).toContain("All Specifications");
    expect(headers).toContain("Key Specifications");
    expect(headers).toContain("Electrical Ratings");
    expect(headers).toContain("Mechanical / Installation");
    expect(headers).toContain("Compliance / Standards");
    expect(headers).toContain("Lifecycle / Commercial");
    expect(headers).toContain("All Resources");
    expect(headers).toContain("Weight (lb)");
    expect(headers).toContain("Weight (kg)");
    expect(headers).toContain("Weight");
    expect(headers).toContain("Dimensions");
    expect(headers).toContain("Height (in)");
    expect(headers).toContain("Height (mm)");
    expect(headers).toContain("Length (in)");
    expect(headers).toContain("Length (mm)");
    expect(headers).toContain("Material");
    expect(headers).toContain("ECLASS");
    expect(headers).toContain("IP Rating");
    expect(headers).toContain("NEMA / Type Rating");
    expect(headers).toContain("IK Rating");
    expect(headers).toContain("Frequency");
    expect(headers).toContain("Phase");
    expect(headers).toContain("Poles");
    expect(headers).toContain("Terminals / Connection");
    expect(headers).toContain("Mounting");
    expect(headers).toContain("Operating Temperature");
    expect(headers).toContain("Wire / Cable Size");
    expect(headers).toContain("Thread Size");
    expect(headers).toContain("Final Completeness Check");
    expect(headers).toContain("Missing Required Fields");
    expect(workbook.getWorksheet("Run Summary")).toBeTruthy();
    expect(workbook.getWorksheet("Clean Export")).toBeTruthy();
    expect(workbook.getWorksheet("Import Ready")).toBeTruthy();
    expect(workbook.getWorksheet("Needs Review")).toBeTruthy();
    expect(workbook.getWorksheet("Issue Summary")).toBeTruthy();
    expect(workbook.getWorksheet("Column Guide")).toBeTruthy();
    expect(workbook.getWorksheet("Clean Attributes")).toBeTruthy();
    expect(workbook.getWorksheet("Clean Documents")).toBeTruthy();
    expect(workbook.getWorksheet("Field Coverage")).toBeTruthy();
    expect(workbook.getWorksheet("Spec Matrix")).toBeTruthy();
    expect(workbook.getWorksheet("Checks")).toBeTruthy();
    expect(workbook.getWorksheet("Evidence")).toBeTruthy();
    expect(workbook.getWorksheet("Final Audit")).toBeTruthy();
    const productUrlDeCell = products.getRow(2).getCell(headers.indexOf("Product URL DE") + 1);
    expect(cellText(productUrlDeCell)).toBe("https://new.abb.com/smartlinks/de?ProductId=1SDA126387R1");
    expect(productUrlDeCell.hyperlink).toBe("https://new.abb.com/smartlinks/de?ProductId=1SDA126387R1");
    expect(products.getRow(2).getCell(headers.indexOf("Weight (kg)") + 1).value).toBe(0.028);
    expect(products.getRow(2).getCell(headers.indexOf("Weight (lb)") + 1).value).toBeCloseTo(0.061729433, 9);
    expect(products.getRow(2).getCell(headers.indexOf("Height (mm)") + 1).value).toBe(10);
    expect(products.getRow(2).getCell(headers.indexOf("Height (in)") + 1).value).toBeCloseTo(0.393700787, 9);
    expect(products.getRow(2).getCell(headers.indexOf("Material") + 1).value).toBe("Steel");
    expect(products.getRow(2).getCell(headers.indexOf("Dimensions") + 1).value).toBe("10 x 20 x 30 mm");
    expect(products.getRow(2).getCell(headers.indexOf("ECLASS") + 1).value).toBe("ECLASS 14.0: 27-14-23-90");
    expect(products.getRow(2).getCell(headers.indexOf("Product Type") + 1).value).toBe("KLP-D");
    expect(products.getRow(2).getCell(headers.indexOf("Device Type") + 1).value).toBe("Lock / Interlock");
    expect(products.getRow(2).getCell(headers.indexOf("Device Type Confidence") + 1).value).toBeGreaterThanOrEqual(0.8);
    expect(String(products.getRow(2).getCell(headers.indexOf("Device Type Evidence") + 1).value)).toContain("Catalog Description");
    expect(products.getRow(2).getCell(headers.indexOf("EAN / GTIN") + 1).value).toBe("8056221267000");
    expect(String(products.getRow(2).getCell(headers.indexOf("All Specifications") + 1).value)).toContain("[ABB Product Data]");
    expect(String(products.getRow(2).getCell(headers.indexOf("Copy Summary") + 1).value)).toContain("Voltage: 24 V DC");
    expect(String(products.getRow(2).getCell(headers.indexOf("Copy Summary") + 1).value)).toContain("Material: Steel");
    expect(String(products.getRow(2).getCell(headers.indexOf("Copy Summary") + 1).value)).toContain("ECLASS: 27-14-23-90");
    expect(String(products.getRow(2).getCell(headers.indexOf("All Specifications") + 1).value)).toContain("Rated Operational Voltage: 24 V DC");
    expect(String(products.getRow(2).getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Catalog Description: ABB padlock device");
    expect(String(products.getRow(2).getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Rated Current: 2 A");
    expect(String(products.getRow(2).getCell(headers.indexOf("Compliance / Standards") + 1).value)).toContain("Standards: IEC/UL");
    expect(String(products.getRow(2).getCell(headers.indexOf("Lifecycle / Commercial") + 1).value)).toContain("Product Sales Status: Active");
    expect(String(products.getRow(2).getCell(headers.indexOf("Accessories / Related Parts") + 1).value)).toContain("Accessory: 1SBN010015R1001");
    expect(String(products.getRow(2).getCell(headers.indexOf("Downloads") + 1).value)).toContain("Datasheet: Data Sheet, Technical Information");
    expect(String(products.getRow(2).getCell(headers.indexOf("Downloads") + 1).value)).toContain("Manual: Instructions and Manuals");
    expect(String(products.getRow(2).getCell(headers.indexOf("All Resources") + 1).value)).toContain("Datasheet: Data Sheet, Technical Information");
    expect(String(products.getRow(2).getCell(headers.indexOf("All Resources") + 1).value)).toContain("DocumentID=1SBC100214C0202");
    const attributes = workbook.getWorksheet("Attributes")!;
    const attributeHeaders = (attributes.getRow(1).values as unknown[]).slice(1);
    expect(attributeHeaders).toContain("Source Type");
    expect(attributeHeaders).toContain("Parser");
    expect(attributeHeaders).toContain("Confidence");
    const documents = workbook.getWorksheet("Documents")!;
    const documentHeaders = (documents.getRow(1).values as unknown[]).slice(1);
    expect(documentHeaders).toContain("Source Type");
    expect(documentHeaders).toContain("Parser");
    expect(documentHeaders).toContain("Confidence");

    const cleanDocuments = workbook.getWorksheet("Clean Documents")!;
    const cleanDocumentHeaders = (cleanDocuments.getRow(1).values as unknown[]).slice(1);
    expect(cleanDocumentHeaders).toContain("Document Ready");
    expect(cleanDocumentHeaders).toContain("Clean Export");
    expect(cleanDocumentHeaders).toContain("Priority");
    expect(cleanDocumentHeaders).toContain("Primary");
    expect(cleanDocumentHeaders).toContain("Type");
    expect(cleanDocumentHeaders).toContain("URL");
    expect(cleanDocuments.rowCount).toBe(4);
    expect(cleanDocuments.getRow(2).getCell(cleanDocumentHeaders.indexOf("Priority") + 1).value).toBe(10);
    expect(cleanDocuments.getRow(2).getCell(cleanDocumentHeaders.indexOf("Document Ready") + 1).value).toBe("Yes");
    expect(cleanDocuments.getRow(2).getCell(cleanDocumentHeaders.indexOf("Clean Export") + 1).hyperlink).toBe("#'Clean Export'!A2");
    expect(cleanDocuments.getRow(2).getCell(cleanDocumentHeaders.indexOf("Primary") + 1).value).toBe("Yes");
    expect(cleanDocuments.getRow(2).getCell(cleanDocumentHeaders.indexOf("Type") + 1).value).toBe("Datasheet");
    expect(cellText(cleanDocuments.getRow(2).getCell(cleanDocumentHeaders.indexOf("URL") + 1))).toContain("DocumentID=1SBC100214C0202");

    const cleanExport = workbook.getWorksheet("Clean Export")!;
    const cleanHeaders = (cleanExport.getRow(1).values as unknown[]).slice(1);
    expect(cleanHeaders).toContain("Datasheet URLs");
    expect(cleanHeaders).toContain("Primary Datasheet URL");
    expect(cleanHeaders).toContain("Export Decision");
    expect(cleanHeaders).toContain("Import Ready");
    expect(cleanHeaders).toContain("Review Link");
    expect(cleanHeaders).toContain("Action Needed");
    expect(cleanHeaders).toContain("Coverage Score");
    expect(cleanHeaders).toContain("Confidence");
    expect(cleanHeaders).toContain("Quality Tier");
    expect(cleanHeaders).toContain("Missing Key Fields");
    expect(cleanHeaders).not.toContain("All Specifications");
    expect(cellText(cleanExport.getRow(2).getCell(cleanHeaders.indexOf("Product URL DE") + 1))).toBe("https://new.abb.com/smartlinks/de?ProductId=1SDA126387R1");
    expect(cleanExport.getRow(2).getCell(cleanHeaders.indexOf("Export Decision") + 1).value).toBe("Review");
    expect(cleanExport.getRow(2).getCell(cleanHeaders.indexOf("Import Ready") + 1).value).toBe("No");
    expect(cleanExport.getRow(2).getCell(cleanHeaders.indexOf("Confidence") + 1).value).toBe(0.9);
    expect(cleanExport.getRow(2).getCell(cleanHeaders.indexOf("Quality Tier") + 1).value).toBe("Good");
    const cleanReviewLinkCell = cleanExport.getRow(2).getCell(cleanHeaders.indexOf("Review Link") + 1);
    expect(cellText(cleanReviewLinkCell)).toBe("Review");
    expect(cleanReviewLinkCell.hyperlink).toBe("#'Needs Review'!A2");
    expect(cleanExport.getRow(2).getCell(cleanHeaders.indexOf("Action Needed") + 1).value).toBe("Add a product image URL/file or confirm image is not required.");
    const primaryDatasheetCell = cleanExport.getRow(2).getCell(cleanHeaders.indexOf("Primary Datasheet URL") + 1);
    expect(cellText(primaryDatasheetCell)).toContain("DocumentID=1SBC100214C0202");
    expect(primaryDatasheetCell.hyperlink).toContain("DocumentID=1SBC100214C0202");

    const importReady = workbook.getWorksheet("Import Ready")!;
    const importReadyHeaders = (importReady.getRow(1).values as unknown[]).slice(1);
    expect(importReadyHeaders).toContain("Export Decision");
    expect(importReadyHeaders).toContain("Action Needed");
    expect(importReadyHeaders).toContain("Quality Tier");
    expect(importReady.rowCount).toBe(1);

    const issueSummary = workbook.getWorksheet("Issue Summary")!;
    const issueHeaders = (issueSummary.getRow(1).values as unknown[]).slice(1);
    expect(issueHeaders).toContain("Issue Type");
    expect(issueHeaders).toContain("Severity");
    expect(issueHeaders).toContain("Affected Catalog Numbers");
    expect(issueHeaders).toContain("Suggested Action");
    const issueValues = issueSummary.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(issueValues).toContain("Missing image");
    expect(issueValues).toContain("1SDA126387R1");

    const columnGuide = workbook.getWorksheet("Column Guide")!;
    const guideHeaders = (columnGuide.getRow(1).values as unknown[]).slice(1);
    expect(guideHeaders).toEqual(["Sheet", "Column / Area", "Purpose", "Use For", "Notes"]);
    const guideValues = columnGuide.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(cellText(columnGuide.getRow(2).getCell(1))).toBe("Import Ready");
    expect(guideValues).toContain("Export Decision");
    expect(guideValues).toContain("Review Status");
    expect(guideValues).toContain("Start here when you only want rows without review blockers.");
    expect(columnGuide.getRow(2).getCell(1).hyperlink).toBe("#'Import Ready'!A1");

    const fieldCoverage = workbook.getWorksheet("Field Coverage")!;
    const coverageHeaders = (fieldCoverage.getRow(1).values as unknown[]).slice(1);
    expect(coverageHeaders).toContain("Primary Datasheet URL");
    expect(coverageHeaders).toContain("Datasheet Count");
    expect(coverageHeaders).toContain("Manual Count");
    expect(coverageHeaders).toContain("Certificate Count");
    expect(fieldCoverage.getRow(2).getCell(coverageHeaders.indexOf("Product URL") + 1).value).toBe("OK");
    expect(fieldCoverage.getRow(2).getCell(coverageHeaders.indexOf("Image") + 1).value).toBe("Missing");
    expect(fieldCoverage.getRow(2).getCell(coverageHeaders.indexOf("Datasheet Count") + 1).value).toBe(1);
    expect(fieldCoverage.getRow(2).getCell(coverageHeaders.indexOf("Manual Count") + 1).value).toBe(1);
    expect(fieldCoverage.getRow(2).getCell(coverageHeaders.indexOf("Certificate Count") + 1).value).toBe(1);
    expect(cellText(fieldCoverage.getRow(2).getCell(coverageHeaders.indexOf("Primary Datasheet URL") + 1))).toContain("DocumentID=1SBC100214C0202");
    expect(Number(fieldCoverage.getRow(2).getCell(coverageHeaders.indexOf("Coverage Score") + 1).value)).toBeGreaterThan(0.6);

    const specMatrix = workbook.getWorksheet("Spec Matrix")!;
    const matrixHeaders = (specMatrix.getRow(1).values as unknown[]).slice(1);
    expect(matrixHeaders).toContain("Product URL");
    expect(matrixHeaders).toContain("Datasheet URL");
    expect(matrixHeaders).toContain("Operating Voltage Ub");
    expect(specMatrix.getRow(2).getCell(matrixHeaders.indexOf("Product Type") + 1).value).toBe("KLP-D");
    expect(cellText(specMatrix.getRow(2).getCell(matrixHeaders.indexOf("Datasheet URL") + 1))).toContain("DocumentID=1SBC100214C0202");

    const checks = workbook.getWorksheet("Checks")!;
    const checkValues = checks.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(checkValues).toContain("Missing image");
  });

  it("writes a dedicated Import Ready sheet with only direct-import rows", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-import-ready-xlsx-"));
    const run: RunRecord = {
      id: "import-ready-run",
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
        catalogNumber: "READY-1",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "abb",
          catalogNumber: "READY-1",
          status: "found",
          confidence: 0.95,
          title: "Ready relay",
          productUrl: "https://example.com/products/READY-1",
          localizedUrls: {
            en: "https://example.com/en/products/READY-1",
            de: "https://example.com/de/products/READY-1"
          },
          normalized: {
            weight: "1 kg",
            dimensions: "10 x 20 x 30 mm",
            material: "Steel",
            voltage: "24 V DC",
            current: "2 A",
            protection: "IP20",
            certificates: "CE"
          },
          attributes: [
            { group: "Product Data", name: "Product or Component Type", value: "Relay", sourceType: "official" },
            { group: "Product Data", name: "Material", value: "Steel", sourceType: "official" },
            { group: "Product Data", name: "Rated Operational Voltage", value: "24 V DC", sourceType: "official" },
            { group: "Product Data", name: "Rated Current", value: "2 A", sourceType: "official" },
            { group: "Product Data", name: "Certificates", value: "CE", sourceType: "official" }
          ],
          documents: [
            { type: "datasheet", label: "Product datasheet", url: "https://example.com/READY-1-datasheet.pdf", sourceType: "official" },
            { type: "image", label: "Product image", url: "https://example.com/READY-1.png", sourceType: "official" }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const importReady = workbook.getWorksheet("Import Ready")!;
    const headers = (importReady.getRow(1).values as unknown[]).slice(1);
    expect(importReady.rowCount).toBe(2);
    expect(importReady.getRow(2).getCell(headers.indexOf("Catalog Number") + 1).value).toBe("READY-1");
    expect(importReady.getRow(2).getCell(headers.indexOf("Export Decision") + 1).value).toBe("Import");
    expect(importReady.getRow(2).getCell(headers.indexOf("Import Ready") + 1).value).toBe("Yes");
    expect(importReady.getRow(2).getCell(headers.indexOf("Action Needed") + 1).value).toBe("Ready");
    expect(importReady.getRow(2).getCell(headers.indexOf("Quality Tier") + 1).value).toBe("Complete");
    expect(cellText(importReady.getRow(2).getCell(headers.indexOf("Primary Datasheet URL") + 1))).toBe("https://example.com/READY-1-datasheet.pdf");

    const needsReview = workbook.getWorksheet("Needs Review")!;
    expect(needsReview.rowCount).toBe(1);
    const summaryValues = workbook.getWorksheet("Run Summary")!.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(summaryValues).toContain("Ready for import");
    expect(summaryValues).toContain("Ready-only export tab");
  });

  it("writes final audit records to a dedicated worksheet", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-final-audit-xlsx-"));
    const run: RunRecord = {
      id: "audit-run",
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
        catalogNumber: "ABC-123",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "abb",
          catalogNumber: "ABC-123",
          status: "found",
          confidence: 0.8,
          title: "ABC-123 enclosure",
          normalized: { dimensions: "10 x 20 x 30 mm", material: "steel" },
          attributes: [],
          documents: [],
          sources: [],
          diagnostics: {
            finalCompleteness: {
              checkedAt: "2026-05-24T00:00:00.000Z",
              beforeMissing: ["weight"],
              retryMissing: ["weight"],
              afterMissing: ["weight"],
              notApplicable: ["voltage", "current"],
              repairedFields: [],
              networkRetry: {
                attempted: false,
                fields: ["weight"],
                reason: "Skipped duplicate final fallback; already tried discovery, reader, browser.",
                triedStages: ["discovery", "reader", "browser"],
                untriedStages: []
              },
              records: [
                {
                  field: "weight",
                  status: "not-published",
                  requirement: "preferred",
                  action: "Skipped duplicate retry",
                  reason: "Skipped duplicate final fallback; already tried discovery, reader, browser."
                },
                {
                  field: "voltage",
                  status: "not-applicable",
                  requirement: "not-applicable",
                  action: "Skipped",
                  reason: "Product type does not require this electrical rating."
                }
              ]
            }
          }
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const productHeaders = (products.getRow(1).values as unknown[]).slice(1);
    expect(String(products.getRow(2).getCell(productHeaders.indexOf("Final Completeness Check") + 1).value)).toContain("Weight: not published");

    const finalAudit = workbook.getWorksheet("Final Audit")!;
    const auditHeaders = (finalAudit.getRow(1).values as unknown[]).slice(1);
    expect(finalAudit.rowCount).toBe(3);
    expect(finalAudit.getRow(2).getCell(auditHeaders.indexOf("Field") + 1).value).toBe("weight");
    expect(finalAudit.getRow(2).getCell(auditHeaders.indexOf("Status") + 1).value).toBe("not-published");
    expect(finalAudit.getRow(2).getCell(auditHeaders.indexOf("Network Retry") + 1).value).toBe("skipped");

    const needsReview = workbook.getWorksheet("Needs Review")!;
    const reviewHeaders = (needsReview.getRow(1).values as unknown[]).slice(1);
    expect(reviewHeaders).toContain("Review Priority");
    expect(reviewHeaders).toContain("Review Status");
    expect(reviewHeaders).toContain("Fix Needed");
    expect(reviewHeaders).toContain("Reviewed By");
    expect(reviewHeaders).toContain("Review Notes");
    expect(reviewHeaders).toContain("Issue Type");
    expect(reviewHeaders).toContain("Suggested Action");
    expect(reviewHeaders).toContain("Clean Export");
    expect(reviewHeaders).toContain("Products");
    expect(reviewHeaders).toContain("Coverage Score");
    expect(reviewHeaders).toContain("Confidence");
    expect(reviewHeaders).toContain("Primary Datasheet URL");
    expect(needsReview.rowCount).toBe(2);
    expect((needsReview.views[0] as ExcelJS.WorksheetView & { xSplit?: number } | undefined)?.xSplit).toBe(10);
    expect(needsReview.getRow(2).getCell(reviewHeaders.indexOf("Catalog Number") + 1).value).toBe("ABC-123");
    expect(["High", "Medium", "Low"]).toContain(needsReview.getRow(2).getCell(reviewHeaders.indexOf("Review Priority") + 1).value);
    const reviewStatusCell = needsReview.getRow(2).getCell(reviewHeaders.indexOf("Review Status") + 1);
    expect(reviewStatusCell.value).toBe("Open");
    expect(reviewStatusCell.dataValidation?.type).toBe("list");
    expect(needsReview.getRow(2).getCell(reviewHeaders.indexOf("Fix Needed") + 1).value).toBe("Yes");
    expect(needsReview.getRow(2).getCell(reviewHeaders.indexOf("Confidence") + 1).value).toBe(0.8);
    const cleanExportLinkCell = needsReview.getRow(2).getCell(reviewHeaders.indexOf("Clean Export") + 1);
    expect(cellText(cleanExportLinkCell)).toBe("Open");
    expect(cleanExportLinkCell.hyperlink).toBe("#'Clean Export'!A2");
    expect(needsReview.getRow(2).getCell(reviewHeaders.indexOf("Products") + 1).hyperlink).toBe("#'Products'!A2");
    expect(String(needsReview.getRow(2).getCell(reviewHeaders.indexOf("Review Reason") + 1).value)).toContain("Missing: Weight");
    expect(String(needsReview.getRow(2).getCell(reviewHeaders.indexOf("Issue Type") + 1).value)).toContain("Missing required fields");
    const suggestedAction = String(needsReview.getRow(2).getCell(reviewHeaders.indexOf("Suggested Action") + 1).value);
    expect(suggestedAction).toContain("Fill or confirm required fields:");
    expect(suggestedAction).toContain("Weight");

    const issueSummary = workbook.getWorksheet("Issue Summary")!;
    const issueValues = issueSummary.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(issueValues).toContain("Missing required fields");
    expect(issueValues).toContain("ABC-123");

    const summary = workbook.getWorksheet("Run Summary")!;
    const summaryValues = summary.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(summaryValues).toContain("Readiness");
    expect(summaryValues).toContain("Decision legend");
    expect(summaryValues).toContain("Workbook status");
    expect(summaryValues).toContain("Recommended next step");
    expect(summaryValues).toContain("Primary product export with import decisions, clean fields, and core URLs.");
    expect(summaryValues).toContain("Ready-only product export containing rows marked Import.");
    expect(summaryValues).toContain("Top issue types");
    expect(summaryValues).toContain("Aggregated QA view of review blockers and affected catalog numbers.");
    expect(summaryValues).toContain("Data dictionary for key workbook sheets and workflow columns.");
    expect(summaryValues).toContain("High priority review");
    expect(summaryValues).toContain("Import ready");
    expect(summaryValues).toContain("Top review queue");
    expect(summaryValues).toContain("ABC-123");
  });

  it("writes SCE commercial fields, related parts, and downloads into product summaries", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-sce-xlsx-"));
    const run: RunRecord = {
      id: "sce-run",
      manufacturerId: "sce",
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
      id: "sce",
      canonicalName: "Saginaw Control and Engineering",
      shortName: "SCE",
      rateLimitMs: 100,
      officialBaseUrls: ["https://www.saginawcontrol.com"],
      fallbackSources: [],
      localizedUrlTemplates: [{ locale: "en", urlTemplate: "https://www.saginawcontrol.com/partnumber_info?n={part}" }]
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "SCE-12EL1206LP",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "sce",
          catalogNumber: "SCE-12EL1206LP",
          status: "found",
          confidence: 0.95,
          title: "SCE-12EL1206LP",
          productUrl: "https://www.saginawcontrol.com/partnumber_info?n=SCE-12EL1206LP",
          normalized: {
            weight: "16.00 lbs (7.26 kg)",
            dimensions: "12.00 x 12.00 x 6.00 in (304.8 x 304.8 x 152.4 mm)",
            material: "carbon steel",
            voltage: "120 V AC",
            finish: "ANSI-61 gray powder coating inside and out.",
            certificates: "UL; CSA"
          },
          attributes: [
            { group: "Product Specifications", name: "Part Number", value: "SCE-12EL1206LP", sourceType: "official" },
            { group: "Product Specifications", name: "Description", value: "EL Enclosure", sourceType: "official" },
            { group: "SCE Product Data", name: "Product Type", value: "EL Enclosure", sourceType: "official" },
            { group: "Product Specifications", name: "Price Code", value: "E3", sourceType: "official" },
            { group: "Product Specifications", name: "List Price", value: "$223.37", sourceType: "official" },
            { group: "Product Specifications", name: "Catalog Page", value: "90", sourceType: "official" },
            { group: "Product Specifications", name: "Model No.", value: "SL-400100FC-SG", sourceType: "official" },
            { group: "Product Specifications", name: "Lumens", value: "400", sourceType: "official" },
            { group: "Product Specifications", name: "Life Expectancy", value: "100,000 Hr", sourceType: "official" },
            { group: "Product Specifications", name: "Volt AC", value: "100 to 265 VAC", sourceType: "official" },
            { group: "Product Specifications", name: "Interface", value: "Ethernet/USB", sourceType: "official" },
            { group: "Product Specifications", name: "Volt", value: "120 VAC", sourceType: "official" },
            { group: "Product Specifications", name: "Watt", value: "125", sourceType: "official" },
            { group: "Product Specifications", name: "Input Power", value: "85 to 264 VDC", sourceType: "official" },
            { group: "Product Specifications", name: "Max. Current", value: "2.5", sourceType: "official" },
            { group: "SCE Electrical Ratings", name: "Switch Capacity", value: "10 amp 120-250 VAC Resistive load", sourceType: "official" },
            { group: "SCE Electrical Ratings", name: "Power", value: "125 W", sourceType: "official" },
            { group: "SCE Thermal Ratings", name: "Set Point Range", value: "30 to 140 F", sourceType: "official" },
            { group: "SCE Thermal Ratings", name: "Cooling Capacity", value: "3400 BTU/Hr", sourceType: "official" },
            { group: "SCE Thermal Ratings", name: "Air Flow", value: "140 CFM", sourceType: "official" },
            { group: "SCE Thermal Ratings", name: "Refrigerant", value: "R513a Refrigerant", sourceType: "official" },
            { group: "SCE Thermal Ratings", name: "Controller Cooling Setpoint", value: "95°F to cool - adjustable 68°F to 122°F", sourceType: "official" },
            { group: "SCE Thermal Ratings", name: "Temperature Hysteresis", value: "5.4°F", sourceType: "official" },
            { group: "SCE Thermal Ratings", name: "High Temperature Alarm", value: "Preset 131°F", sourceType: "official" },
            { group: "SCE Mechanical Ratings", name: "Pressure Range", value: "0 to 180 PSI Gage", sourceType: "official" },
            { group: "SCE Mechanical Ratings", name: "Filter Rating", value: "5um filter", sourceType: "official" },
            { group: "SCE Mechanical Ratings", name: "Thread Size", value: "1/4 inch NPT", sourceType: "official" },
            { group: "Construction", name: "Construction Detail", value: "0.075 In. carbon steel.", sourceType: "official" },
            { group: "Application", name: "Application", value: "Designed to house electrical controls.", sourceType: "official" },
            { group: "Notes", name: "Note", value: "Special sizes are available.", sourceType: "official" },
            { group: "SCE Certification Details", name: "Certification Detail", value: "cULus File Component Recognized SA32278", sourceType: "official" },
            { group: "Industry Standards - (IS4)", name: "UL Type", value: "4", sourceType: "official" },
            { group: "Optional Accessories", name: "Optional Accessory", value: "SCE-12DLP12 - Subpanel, Flat", sourceType: "official" },
            { group: "Similar Part Numbers", name: "Similar Part", value: "SCE-16EL1206LP - EL Enclosure", sourceType: "official" },
            { group: "People who have purchased this part also bought:", name: "Related Purchase", value: "SCE-ELMFK4 - Foot Kit", sourceType: "official" }
          ],
          documents: [
            { type: "manual", label: "Service Parts Wall Mount Enclosures", url: "https://www.saginawcontrol.com/instman/service-parts-el-enclosure.pdf" },
            { type: "cad", label: "SCE-12EL1206LP CAD package", url: "https://www.saginawcontrol.com/download/sce-12el1206lp.zip" },
            { type: "image", label: "Product image - SCE-12EL1206LP", url: "https://www.saginawcontrol.com/wp-content/uploads/2017/05/SCE-1412PCW.png" }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(headers).toContain("Accessories / Related Parts");
    expect(headers).toContain("Downloads");
    expect(row.getCell(headers.indexOf("Product Type") + 1).value).toBe("EL Enclosure");
    expect(row.getCell(headers.indexOf("Device Type") + 1).value).toBe("Enclosure");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Note: Special sizes are available.");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Model No.: SL-400100FC-SG");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Lumens: 400");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Life Expectancy: 100,000 Hr");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Interface: Ethernet/USB");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Voltage: 120 V AC");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Volt AC: 100 to 265 VAC");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Watt: 125");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Power: 125 W");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Input Power: 85 to 264 VDC");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Max. Current: 2.5");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Switch Capacity: 10 amp 120-250 VAC Resistive load");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Set Point Range: 30 to 140 F");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Cooling Capacity: 3400 BTU/Hr");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Air Flow: 140 CFM");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Refrigerant: R513a Refrigerant");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Construction Detail: 0.075 In. carbon steel.");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Application: Designed to house electrical controls.");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Pressure Range: 0 to 180 PSI Gage");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Filter Rating: 5um filter");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Thread Size: 1/4 inch NPT");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("High Temperature Alarm: Preset 131°F");
    expect(String(row.getCell(headers.indexOf("Compliance / Standards") + 1).value)).toContain("UL Type: 4");
    expect(String(row.getCell(headers.indexOf("Compliance / Standards") + 1).value)).toContain("Certification Detail: cULus File Component Recognized SA32278");
    expect(String(row.getCell(headers.indexOf("Lifecycle / Commercial") + 1).value)).toContain("List Price: $223.37");
    expect(String(row.getCell(headers.indexOf("Lifecycle / Commercial") + 1).value)).toContain("Catalog Page: 90");
    expect(String(row.getCell(headers.indexOf("Accessories / Related Parts") + 1).value)).toContain("Optional Accessory: SCE-12DLP12");
    expect(String(row.getCell(headers.indexOf("Accessories / Related Parts") + 1).value)).toContain("Related Purchase: SCE-ELMFK4");
    expect(String(row.getCell(headers.indexOf("Downloads") + 1).value)).toContain("CAD: SCE-12EL1206LP CAD package");
    expect(cellText(row.getCell(headers.indexOf("Image URL") + 1))).toBe("https://www.saginawcontrol.com/wp-content/uploads/2017/05/SCE-1412PCW.png");
  });

  it("writes Balluff key feature summaries and raw attributes to Excel", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-balluff-xlsx-"));
    const run: RunRecord = {
      id: "balluff-run",
      manufacturerId: "balluff",
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
      id: "balluff",
      canonicalName: "Balluff",
      shortName: "BAL",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: [],
      localizedUrlTemplates: [
        { locale: "en", urlTemplate: "https://www.balluff.com/en-gb/products/{part}" },
        { locale: "de", urlTemplate: "https://www.balluff.com/de-de/products/{part}" }
      ]
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "BOS025P",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "balluff",
          catalogNumber: "BOS025P",
          status: "found",
          confidence: 0.92,
          title: "BOS025P (BOS 18M-PA-IE21-S4) Through-beam sensors",
          productUrl: "https://www.balluff.com/en-gb/products/BOS025P",
          normalized: {
            dimensions: "Ø 18 x 75 mm",
            material: "Brass, nickel-plated",
            voltage: "10...30 V DC",
            certificates: "CE; cULus; UKCA; WEEE"
          },
          attributes: [
            { group: "Structured Data", name: "alternateName", value: "BOS 18M-PA-IE21-S4" },
            { group: "Balluff Key features", name: "Series", value: "18M" },
            { group: "Balluff Key features", name: "Interface", value: "PNP normally open (NO); PNP normally closed (NC)" },
            { group: "Balluff Key features", name: "Principle of operation", value: "Photoelectric sensor" },
            { group: "Balluff Key features", name: "Principle of optical operation", value: "Through-beam sensor (receiver)" },
            { group: "Balluff Key features", name: "Light type", value: "Infrared" },
            { group: "Balluff Key features", name: "Fork opening", value: "10 mm" },
            { group: "Balluff Key features", name: "Output characteristic", value: "falling on approach" },
            { group: "Balluff Key features", name: "Segments, number max.", value: "3" },
            { group: "Balluff Key features", name: "Predefined colors", value: "Yellow; White; Green; Blue; Red; Orange; Configurable" },
            { group: "Balluff Key features", name: "Light intensity", value: "746 lm" },
            { group: "Balluff Key features", name: "Color temperature", value: "4000 K" },
            { group: "Balluff Key features", name: "Dimension", value: "Ø 18 x 75 mm" },
            { group: "Balluff Key features", name: "Operating voltage Ub", value: "10...30 VDC" },
            { group: "Balluff Key features", name: "Scope of delivery", value: "2x nut M18x1; User manual" },
            { group: "Balluff Lifecycle", name: "Product status", value: "Canceled" },
            { group: "Balluff Lifecycle", name: "Recommended alternative", value: "BOS02E5 - Photoelectric sensor" },
            { group: "Balluff Classifications", name: "ECLASS 14.0", value: "27-27-09-01" },
            { group: "Balluff Classifications", name: "ETIM 9.0", value: "EC002716" },
            { group: "Balluff Classifications", name: "UNSPSC 11", value: "39121528" },
            { group: "Digital Product Passport", name: "Manufacturer", value: "Balluff GmbH" },
            { group: "Digital Product Passport", name: "Tariff Code", value: "85444290" },
            { group: "Balluff Key features", name: "Approval/Conformity", value: "cULus; CE; UKCA; WEEE" },
            { group: "Meta", name: "og:image", value: "https://assets.balluff.com/noisy-image.png" },
            { group: "Balluff Key features", name: "Downloads", value: "Product documentation" }
          ],
          documents: [
            { type: "datasheet", label: "Datasheet", url: "https://publications.balluff.com/pdfengine/pdf?type=pdb&id=123&con=en" },
            { type: "other", label: "EPREL product data sheet", url: "https://eprel.ec.europa.eu/screen/product/lightsources/2018608" },
            { type: "image", label: "EPREL energy label", url: "https://eprel.ec.europa.eu/labels/lightsources/Label_2018608_big_color.svg" }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(row.getCell(headers.indexOf("Product Type") + 1).value).toBe("BOS 18M-PA-IE21-S4");
    expect(row.getCell(headers.indexOf("Device Type") + 1).value).toBe("Photoelectric Sensor");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Principle of operation: Photoelectric sensor");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Segments, number max.: 3");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Light intensity: 746 lm");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Interface: PNP normally open");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Output characteristic: falling on approach");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Scope of delivery: 2x nut M18x1");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Fork opening: 10 mm");
    expect(String(row.getCell(headers.indexOf("Lifecycle / Commercial") + 1).value)).toContain("Product status: Canceled");
    expect(String(row.getCell(headers.indexOf("Accessories / Related Parts") + 1).value)).toContain("Recommended alternative: BOS02E5");
    expect(String(row.getCell(headers.indexOf("Downloads") + 1).value)).toContain("EPREL product data sheet");
    expect(String(row.getCell(headers.indexOf("Compliance / Standards") + 1).value)).toContain("ECLASS 14.0: 27-27-09-01");
    expect(String(row.getCell(headers.indexOf("All Specifications") + 1).value)).toContain("[Digital Product Passport]");
    expect(String(row.getCell(headers.indexOf("All Specifications") + 1).value)).toContain("Tariff Code: 85444290");

    const attributes = workbook.getWorksheet("Attributes")!;
    const attrValues = attributes.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(attrValues).toContain("Principle of optical operation");
    expect(attrValues).toContain("Through-beam sensor (receiver)");
    expect(attrValues).toContain("Digital Product Passport");
    expect(attrValues).toContain("Balluff GmbH");

    const cleanAttributes = workbook.getWorksheet("Clean Attributes")!;
    const cleanAttrValues = cleanAttributes.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(cleanAttrValues).toContain("Operating voltage Ub");
    expect(cleanAttrValues).toContain("10...30 VDC");
    expect(cleanAttrValues).not.toContain("og:image");
    expect(cleanAttrValues).not.toContain("Product documentation");

    const specMatrix = workbook.getWorksheet("Spec Matrix")!;
    const matrixHeaders = (specMatrix.getRow(1).values as unknown[]).slice(1);
    const matrixRow = specMatrix.getRow(2);
    expect(matrixHeaders).toContain("Connection 1");
    expect(matrixHeaders).toContain("Operating Voltage Ub");
    expect(matrixHeaders).toContain("ECLASS");
    expect(matrixHeaders).toContain("Tariff Code (HS)");
    expect(matrixRow.getCell(matrixHeaders.indexOf("Operating Voltage Ub") + 1).value).toBe("10...30 VDC");
    expect(matrixRow.getCell(matrixHeaders.indexOf("ECLASS") + 1).value).toBe("27-27-09-01");
    expect(matrixRow.getCell(matrixHeaders.indexOf("Tariff Code (HS)") + 1).value).toBe("85444290");
    expect(String(matrixRow.getCell(matrixHeaders.indexOf("Approval/Conformity") + 1).value)).toContain("cULus");
  });

  it("writes Balluff cable length, lens measurements, certificates, and image URL to Excel", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-balluff-cable-xlsx-"));
    const run: RunRecord = {
      id: "balluff-cable-run",
      manufacturerId: "balluff",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
      total: 2,
      processed: 2,
      found: 2,
      partial: 0,
      failed: 0
    };
    const manufacturer: ManufacturerConfig = {
      id: "balluff",
      canonicalName: "Balluff",
      shortName: "BAL",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: [],
      localizedUrlTemplates: [
        { locale: "en", urlTemplate: "https://www.balluff.com/en-gb/products/{part}" },
        { locale: "de", urlTemplate: "https://www.balluff.com/de-de/products/{part}" }
      ]
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "BCC039H",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "balluff",
          catalogNumber: "BCC039H",
          status: "found",
          confidence: 0.92,
          title: "BCC039H Double-ended cordsets",
          productUrl: "https://www.balluff.com/en-gb/products/BCC039H",
          normalized: {},
          attributes: [
            { group: "Structured Data", name: "alternateName", value: "BCC M415-M414-3A-304-PX0434-003" },
            { group: "Balluff Key features", name: "Connection 1", value: "M12x1-Female, straight, 5-pin, A-coded" },
            { group: "Balluff Key features", name: "Connection 2", value: "M12x1-Male, straight, 4-pin, A-coded" },
            { group: "Balluff Key features", name: "Cable", value: "PUR black, 0.3 m, Drag chain compatible" },
            { group: "PDF datasheet - Mechanical data", name: "Cable length L", value: "0.30 m", sourceType: "generated", parser: "pdf-table-extractor" },
            { group: "Balluff Key features", name: "Operating voltage Ub", value: "250 VDC / 250 VAC" },
            { group: "Balluff Key features", name: "Rated current (40 °C)", value: "4.0 A" },
            { group: "Balluff Key features", name: "Approval/Conformity", value: "CE; cULus; WEEE" }
          ],
          documents: [
            { type: "image", label: "Product image", url: "https://assets.balluff.com/product_view_cropped/50644_01_P_01_bk_bk_bk.png" },
            { type: "certificate", label: "Material compliance declaration", url: "https://publications.balluff.com/pdfengine/pdf?id=PV156653&type=mcd&language=en" }
          ],
          sources: []
        }
      },
      {
        id: 2,
        runId: run.id,
        rowIndex: 2,
        catalogNumber: "FHW0069",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "balluff",
          catalogNumber: "FHW0069",
          status: "found",
          confidence: 0.92,
          title: "FHW0069 C-mount lenses",
          productUrl: "https://www.balluff.com/en-gb/products/FHW0069",
          normalized: {},
          attributes: [
            { group: "Structured Data", name: "alternateName", value: "LM8HC-VIS-SW" },
            { group: "Balluff Key features", name: "Focal length", value: "8 mm" },
            { group: "Balluff Key features", name: "Minimum object distance (MOD)", value: "200 mm" },
            { group: "Balluff Key features", name: "Dimension", value: "Ø 58 x 79.5 mm" },
            { group: "Balluff Key features", name: "Material", value: "Aluminum, black anodized" },
            { group: "Balluff Key features", name: "Weight", value: "235 g" }
          ],
          documents: [
            { type: "image", label: "Product image", url: "https://assets.balluff.com/product_view_cropped/LM8HC-VIS-SW_P_00_00_00.png" }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const rows = products.getRows(2, products.rowCount - 1)!;
    const rowFor = (part: string) => rows.find((candidate) => candidate.getCell(headers.indexOf("Catalog Number") + 1).value === part)!;
    const row = rowFor("BCC039H");
    const lens = rowFor("FHW0069");

    expect(row.getCell(headers.indexOf("Length (mm)") + 1).value).toBe(300);
    expect(String(row.getCell(headers.indexOf("Material") + 1).value)).toContain("PUR black");
    expect(String(row.getCell(headers.indexOf("Color") + 1).value)).toContain("black");
    expect(String(row.getCell(headers.indexOf("Certificates") + 1).value)).toContain("CE");
    expect(cellText(row.getCell(headers.indexOf("Image URL") + 1))).toContain("product_view_cropped");
    expect(String(lens.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Dimensions: Ø 58 x 79.5 mm");
    expect(lens.getCell(headers.indexOf("Weight (kg)") + 1).value).toBe(0.235);
    expect(lens.getCell(headers.indexOf("Length (mm)") + 1).value).toBeNull();
    expect(String(lens.getCell(headers.indexOf("Finish") + 1).value)).toContain("black anodized");
  });

  it("writes Schneider drive ratings, lifecycle, and compliance summaries to Excel", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-schneider-xlsx-"));
    const run: RunRecord = {
      id: "schneider-run",
      manufacturerId: "schneider",
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
      id: "schneider",
      canonicalName: "Schneider Electric",
      shortName: "SE",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: [],
      localizedUrlTemplates: [
        { locale: "en", urlTemplate: "https://www.se.com/us/en/product/{part}/" },
        { locale: "de", urlTemplate: "https://www.se.com/de/de/product/{part}/" }
      ]
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "ATV320U15N4B",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "schneider",
          catalogNumber: "ATV320U15N4B",
          status: "found",
          confidence: 0.9,
          title: "Variable speed drive ATV320 - 1.5kW - 380...500V - 3 phase - book",
          productUrl: "https://www.se.com/us/en/product/ATV320U15N4B/",
          normalized: {
            weight: "2.4 lb(US) (1.1 kg)",
            dimensions: "H 325 mm x W 45 mm x D 245 mm",
            material: "Metal; plastic",
            voltage: "380...500 V",
            current: "4.9 A at 500 V",
            protection: "IP20",
            certificates: "CSA; EAC; RCM; UL"
          },
          attributes: [
            { group: "Schneider Main", name: "Product or Component Type", value: "Variable speed drive", sourceType: "official" },
            { group: "Schneider Main", name: "Range of Product", value: "Altivar Machine ATV320", sourceType: "official" },
            { group: "Schneider Main", name: "Product destination", value: "Asynchronous motors; Synchronous motors", sourceType: "official" },
            { group: "Schneider Main", name: "Network number of phases", value: "3 phases", sourceType: "official" },
            { group: "Schneider Main", name: "[Us] rated supply voltage", value: "380...500 V (- 15...10 %)", sourceType: "official" },
            { group: "Schneider Main", name: "Motor power kW", value: "1.5 kW for heavy duty", sourceType: "official" },
            { group: "Schneider Main", name: "Line current", value: "4.9 A at 500 V for heavy duty; 6.5 A at 380 V for heavy duty", sourceType: "official" },
            { group: "Schneider Main", name: "Continuous output current", value: "4.1 A at 4 kHz for heavy duty", sourceType: "official" },
            { group: "Schneider Main", name: "Product Weight", value: "2.4 lb(US) (1.1 kg)", sourceType: "official" },
            { group: "Schneider Main", name: "IP degree of protection", value: "IP20 conforming to EN/IEC 61800-5-1", sourceType: "official" },
            { group: "Schneider Complementary", name: "Material", value: "Metal; plastic", sourceType: "official" },
            { group: "Schneider Environment", name: "Product certifications", value: "CSA; EAC; RCM; UL", sourceType: "official" },
            { group: "Schneider Lifecycle", name: "Product Status", value: "Active", sourceType: "official" }
          ],
          documents: [{ type: "datasheet", label: "Product Datasheet", url: "https://www.se.com/us/en/product/download-pdf/ATV320U15N4B" }],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(row.getCell(headers.indexOf("Product Type") + 1).value).toBe("Variable speed drive");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Product destination: Asynchronous motors");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("[Us] rated supply voltage: 380...500 V");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Line current: 4.9 A");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Motor power kW: 1.5 kW");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("IP degree of protection: IP20");
    expect(String(row.getCell(headers.indexOf("Compliance / Standards") + 1).value)).toContain("Product certifications: CSA");
    expect(String(row.getCell(headers.indexOf("Lifecycle / Commercial") + 1).value)).toContain("Product Status: Active");
    expect(row.getCell(headers.indexOf("Missing Required Fields") + 1).value).toBeFalsy();
  });

  it("writes nVent HOFFMAN sections, product attributes, and resources to Excel", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-nvent-xlsx-"));
    const run: RunRecord = {
      id: "nvent-run",
      manufacturerId: "nvent",
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
      id: "nvent",
      canonicalName: "nVent HOFFMAN",
      shortName: "NVE",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: [],
      localizedUrlTemplates: [
        { locale: "en", urlTemplate: "https://www.nvent.com/en-us/hoffman/products/enc{partLower}" },
        { locale: "de", urlTemplate: "https://www.nvent.com/de-de/hoffman/products/enc{partLower}" }
      ]
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "DAH4001B",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "nvent",
          catalogNumber: "DAH4001B",
          status: "found",
          confidence: 0.9,
          title: "Electric Heater, 115VAC 400W, 7.50x4.25x4.38 inch, Brushed, Aluminum",
          productUrl: "https://www.nvent.com/en-us/hoffman/products/encdah4001b",
          normalized: {
            weight: "2.5lb (1.13 kg)",
            dimensions: "7.5 x 4.25 x 4.38 in (190.5 x 107.95 x 111.25 mm)",
            material: "Aluminum",
            finish: "Brushed",
            voltage: "115 V",
            current: "3.72 A",
            certificates: "UL; CSA; CE"
          },
          attributes: [
            { group: "Identity", name: "Catalog Number", value: "DAH4001B", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Article Number", value: "70570", sourceType: "official-fallback" },
            { group: "Product Specifications", name: "Bulletin Number", value: "D85", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Height", value: "7.5in", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Width", value: "4.25in", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Depth", value: "4.38in", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Nominal Voltage", value: "115V", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Heating Capacity", value: "400W", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Max Current", value: "3.72A", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Material", value: "Aluminum", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Finish", value: "Brushed", sourceType: "official-fallback" },
            { group: "Features", name: "Feature", value: "Ball bearing fan", sourceType: "official-fallback" },
            { group: "Industry Standards", name: "Industry Standard", value: "UL 508A Component Recognized; File No. E61997", sourceType: "official-fallback" },
            { group: "Declarations", name: "Declaration", value: "nVent RoHS Declaration125.04 KBEnglishTSCA", sourceType: "official-fallback" }
          ],
          documents: [
            { type: "datasheet", label: "Enclosure Heaters Spec Sheet", url: "https://www.nvent.com/sites/default/files/dam/spec-00051.pdf" },
            { type: "cad", label: "Electric Heater 2D/3D CAD Files", url: "https://www.nvent.com/sites/default/files/dam/electricheater_cadfiles.zip" }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Bulletin Number: D85");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Feature: Ball bearing fan");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Heating Capacity: 400W");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Finish: Brushed");
    expect(String(row.getCell(headers.indexOf("Compliance / Standards") + 1).value)).toContain("Industry Standard: UL 508A");
    expect(String(row.getCell(headers.indexOf("Compliance / Standards") + 1).value)).toContain("Declaration: RoHS; TSCA");
    expect(String(row.getCell(headers.indexOf("Compliance / Standards") + 1).value)).not.toContain("125.04 KB");
    expect(row.getCell(headers.indexOf("Height (in)") + 1).value).toBe(7.5);

    const documents = workbook.getWorksheet("Documents")!;
    const documentValues = documents.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(documentValues).toContain("Enclosure Heaters Spec Sheet");
    expect(documentValues).toContain("Electric Heater 2D/3D CAD Files");
  });

  it("writes nVent multi-brand electrical, mechanical, compliance, and package fields to Excel", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-nvent-eriflex-xlsx-"));
    const run: RunRecord = {
      id: "nvent-eriflex-run",
      manufacturerId: "nvent",
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
      id: "nvent",
      canonicalName: "nVent",
      shortName: "NVE",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: []
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "SBLL-800",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "nvent",
          catalogNumber: "SBLL-800",
          status: "found",
          confidence: 0.9,
          title: "Power Terminal, Lug-to-Lug, 800 A",
          productUrl: "https://www.nvent.com/en-us/eriflex/products/efssbll-800",
          normalized: {
            weight: "1.54 lb (0.70 kg)",
            dimensions: "8.1 x 4.53 x 2.95 in (205.74 x 115.06 x 74.93 mm)",
            material: "Copper;Thermoplastic",
            current: "1250 A",
            certificates: "CE; UKCA; UL"
          },
          attributes: [
            { group: "Identity", name: "Catalog Number", value: "SBLL-800", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Product Type", value: "Power Terminal", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Max Current Rating, IEC", value: "1250A", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Max Current Rating, UL/CSA", value: "800A", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Short Circuit Current Rating (SCCR)", value: "100kA", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Max Working Voltage, IEC (Ui)", value: "1000;1500", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Conductor Material", value: "Copper Clad Aluminum", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Complies With", value: "IEC 61439.1;UL 1059", sourceType: "official-fallback" },
            { group: "Embedded Spec Rows", name: "Standard Packaging Quantity", value: "1", sourceType: "official-fallback" }
          ],
          documents: [
            { type: "datasheet", label: "Distribution Blocks, Power Blocks, Power Terminals", url: "https://www.nvent.com/sites/default/files/dam/catalog.pdf" },
            { type: "manual", label: "SBLL250/SBLL500/SBLL800", url: "https://www.nvent.com/sites/default/files/dam/manual.pdf" },
            { type: "cad", label: "CAD", url: "https://www.nvent.com/sites/default/files/dam/sbll800.step" },
            { type: "certificate", label: "CE, ERIFLEX SB", url: "https://www.nvent.com/sites/default/files/dam/ce.pdf" }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Max Current Rating, IEC: 1250A");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Short Circuit Current Rating (SCCR): 100kA");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Conductor Material: Copper Clad Aluminum");
    expect(String(row.getCell(headers.indexOf("Compliance / Standards") + 1).value)).toContain("Complies With: IEC 61439.1");
    expect(String(row.getCell(headers.indexOf("Lifecycle / Commercial") + 1).value)).toContain("Standard Packaging Quantity: 1");
  });

  it("writes nVent RAYCHEM heating cable power and jacket fields to Excel", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-nvent-raychem-xlsx-"));
    const run: RunRecord = {
      id: "nvent-raychem-run",
      manufacturerId: "nvent",
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
      id: "nvent",
      canonicalName: "nVent",
      shortName: "NVE",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: []
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "10BTV1-CR",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "nvent",
          catalogNumber: "10BTV1-CR",
          status: "found",
          confidence: 0.9,
          title: "BTV Self-Regulating Heating Cable",
          productUrl: "https://www.chemelex.com/en-us/raychem/products/btv-self-regulating-heating-cable-0",
          normalized: {
            voltage: "100...130 V",
            material: "Modified Polyolefin"
          },
          attributes: [
            { group: "Embedded Product Table", name: "Catalog Number", value: "002349-000", sourceType: "official-fallback" },
            { group: "Embedded Product Table", name: "Item Name", value: "10BTV1-CR", sourceType: "official-fallback" },
            { group: "Embedded Product Table", name: "Nominal Power Output @ 10°C, 120V", value: "33 W/m", sourceType: "official-fallback" },
            { group: "Embedded Product Table", name: "Nominal Power Output @ 50°F, 120V", value: "10 W/ft", sourceType: "official-fallback" },
            { group: "Embedded Product Table", name: "Supply Voltage", value: "100 - 130 V", sourceType: "official-fallback" },
            { group: "Embedded Product Table", name: "Outer Jacket Material", value: "Modified Polyolefin", sourceType: "official-fallback" },
            { group: "Specifications", name: "Nominal Width", value: "0.54 in", sourceType: "official-fallback" },
            { group: "Specifications", name: "Minimum Installation Temperature", value: "0 F", sourceType: "official-fallback" },
            { group: "Specifications", name: "Maximum Circuit Breaker Size", value: "30 A", sourceType: "official-fallback" },
            { group: "Specifications", name: "Area Classification", value: "Non-Hazardous; Hazardous", sourceType: "official-fallback" },
            { group: "Specifications", name: "Ground Path Type", value: "Braid", sourceType: "official-fallback" },
            { group: "Specifications", name: "Max Intermittent Exposure Temperature, Power On/Off", value: "185 F", sourceType: "official-fallback" }
          ],
          documents: [
            {
              type: "datasheet",
              label: "Data Sheet - English (Americas) Datasheet BTV - 705.37 KB - English",
              url: "https://cdn.chemelex.com/Product%20Documents/Data%20Sheets/RAYCHEM-DS-BTV-EN.pdf"
            }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Nominal Power Output @ 10°C, 120V: 33 W/m");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Supply Voltage: 100 - 130 V");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Maximum Circuit Breaker Size: 30 A");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Item Name: 10BTV1-CR");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Area Classification: Non-Hazardous; Hazardous");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Ground Path Type: Braid");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Outer Jacket Material: Modified Polyolefin");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Nominal Width: 0.54 in");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Minimum Installation Temperature: 0 F");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Max Intermittent Exposure Temperature, Power On/Off: 185 F");

    const documents = workbook.getWorksheet("Documents")!;
    const documentValues = documents.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(documentValues).toContain("Data Sheet - English (Americas) Datasheet BTV - 705.37 KB - English");
  });

  it("writes nVent RAYCHEM length as a separate Excel axis", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-nvent-raychem-length-xlsx-"));
    const run: RunRecord = {
      id: "nvent-raychem-length-run",
      manufacturerId: "nvent",
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
      id: "nvent",
      canonicalName: "nVent",
      shortName: "NVE",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: []
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "HWAT-ECO-GF-V5",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "nvent",
          catalogNumber: "HWAT-ECO-GF-V5",
          status: "found",
          confidence: 0.9,
          title: "HWAT-ECO Electronic Control Unit",
          productUrl: "https://www.chemelex.com/en-us/raychem/products/hwat-eco-electronic-control-unit-0",
          normalized: {
            dimensions: "H 110 mm x D 85 mm x L 210 mm",
            material: "Polycarbonate",
            voltage: "120 V"
          },
          attributes: [
            { group: "Embedded Product Table", name: "Height (H)", value: "110 mm", sourceType: "official-fallback" },
            { group: "Embedded Product Table", name: "Depth (D)", value: "85 mm", sourceType: "official-fallback" },
            { group: "Embedded Product Table", name: "Length (L)", value: "210 mm", sourceType: "official-fallback" }
          ],
          documents: [],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(row.getCell(headers.indexOf("Depth (mm)") + 1).value).toBe(85);
    expect(row.getCell(headers.indexOf("Length (mm)") + 1).value).toBe(210);
    expect(row.getCell(headers.indexOf("Depth (in)") + 1).value).toBeCloseTo(3.346456693, 9);
    expect(row.getCell(headers.indexOf("Length (in)") + 1).value).toBeCloseTo(8.267716535, 9);
  });

  it("writes Eaton specification sections and resources to Excel", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-eaton-xlsx-"));
    const run: RunRecord = {
      id: "eaton-run",
      manufacturerId: "eaton",
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
      id: "eaton",
      canonicalName: "Eaton",
      shortName: "EAT",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: [],
      localizedUrlTemplates: [
        { locale: "en", urlTemplate: "https://www.eaton.com/us/en-us/skuPage.{partSlashBraces}.html" },
        { locale: "de", urlTemplate: "https://www.eaton.com/de/de-de/skuPage.{partSlashBraces}.html" }
      ]
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "P1-25/I2/SVB",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "eaton",
          catalogNumber: "P1-25/I2/SVB",
          status: "found",
          confidence: 0.9,
          title: "P1-25/I2/SVB | Eaton rotary disconnect switch",
          productUrl: "https://www.eaton.com/us/en-us/skuPage.P1-25%7B%7DI2%7B%7DSVB.html",
          normalized: {
            weight: "1.62 lb (0.73 kg)",
            dimensions: "5.25 x 4 x 7.25 in (133.35 x 101.6 x 184.15 mm)",
            current: "25 A",
            certificates: "UL"
          },
          attributes: [
            { group: "General specifications", name: "Product Name", value: "Eaton rotary disconnect switch", sourceType: "official-fallback" },
            { group: "General specifications", name: "Catalog Number", value: "P1-25/I2/SVB", sourceType: "official-fallback" },
            { group: "General specifications", name: "EAN", value: "4015082072933", sourceType: "official-fallback" },
            { group: "General specifications", name: "Product Length/Depth", value: "7.25 in", sourceType: "official-fallback" },
            { group: "General specifications", name: "Product Height", value: "5.25 in", sourceType: "official-fallback" },
            { group: "General specifications", name: "Product Width", value: "4 in", sourceType: "official-fallback" },
            { group: "General specifications", name: "Product Weight", value: "1.62 lb", sourceType: "official-fallback" },
            { group: "General specifications", name: "Certifications", value: "UL Listed", sourceType: "official-fallback" },
            { group: "General specifications", name: "Product Type", value: "Rotary disconnect switch", sourceType: "official-fallback" },
            { group: "Physical Attributes", name: "Handle color", value: "Red", sourceType: "official-fallback" },
            { group: "Physical Attributes", name: "Mounting", value: "Surface", sourceType: "official-fallback" },
            { group: "Physical Attributes", name: "Type", value: "Main switch", sourceType: "official-fallback" },
            { group: "Performance Ratings", name: "Amperage Rating", value: "25A", sourceType: "official-fallback" },
            { group: "Miscellaneous", name: "Product Category", value: "Disconnect switch", sourceType: "official-fallback" }
          ],
          documents: [
            {
              type: "datasheet",
              label: "Eaton Specification Sheet - P1-25/I2/SVB",
              url: "https://www.eaton.com/us/en-us/skuPage.P1-25%7B%7DI2%7B%7DSVB.pdf",
              sourceType: "official-fallback"
            },
            {
              type: "datasheet",
              label: "UL listed 100%-rated molded case circuit breakers",
              url: "https://www.eaton.com/content/dam/eaton/products/electrical-circuit-protection/molded-case-circuit-breakers/ul-listed-100-rated-mccb-ap01200008e.pdf",
              sourceType: "official-fallback"
            },
            {
              type: "certificate",
              label: "Eaton extended warranty certificate",
              url: "https://www.eaton.com/content/dam/eaton/support/warranty/eaton-extended-warranty-certificate.pdf",
              sourceType: "official-fallback"
            }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(cellText(row.getCell(headers.indexOf("Product URL EN") + 1))).toBe("https://www.eaton.com/us/en-us/skuPage.P1-25%7B%7DI2%7B%7DSVB.html");
    expect(cellText(row.getCell(headers.indexOf("Product URL DE") + 1))).toBe("https://www.eaton.com/de/de-de/skuPage.P1-25%7B%7DI2%7B%7DSVB.html");
    expect(row.getCell(headers.indexOf("Product Type") + 1).value).toBe("Rotary disconnect switch");
    expect(row.getCell(headers.indexOf("EAN / GTIN") + 1).value).toBe("4015082072933");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Product Category: Disconnect switch");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Amperage Rating: 25A");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Handle color: Red");
    expect(String(row.getCell(headers.indexOf("Mounting") + 1).value)).toContain("Mounting: Surface");
    expect(String(row.getCell(headers.indexOf("Compliance / Standards") + 1).value)).toContain("Certifications: UL Listed");
    expect(row.getCell(headers.indexOf("Certificates") + 1).value).toBe("UL");

    const documents = workbook.getWorksheet("Documents")!;
    const documentValues = documents.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(documentValues).toContain("Eaton Specification Sheet - P1-25/I2/SVB");
  });

  it("writes Eaton contactor model, coil, horsepower, and terminal details to Excel summaries", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-eaton-contactor-xlsx-"));
    const run: RunRecord = {
      id: "eaton-contactor-run",
      manufacturerId: "eaton",
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
      id: "eaton",
      canonicalName: "Eaton",
      shortName: "EAT",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: []
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "DILM9-10",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "eaton",
          catalogNumber: "DILM9-10",
          status: "found",
          confidence: 0.86,
          title: "276705 | Eaton Moeller series DILM contactor",
          productUrl: "https://www.eaton.com/us/en-us/skuPage.276705.html",
          normalized: {
            weight: "0.24 kg",
            dimensions: "68 x 45 x 75 mm",
            current: "9 A",
            voltage: "24 V DC"
          },
          attributes: [
            { group: "General specifications", name: "Product Name", value: "Eaton Moeller series DILM contactor", sourceType: "official-fallback" },
            { group: "General specifications", name: "Catalog Number", value: "276705", sourceType: "official-fallback" },
            { group: "General specifications", name: "Model Code", value: "DILM9-10(24VDC)", sourceType: "official-fallback" },
            { group: "General specifications", name: "Product Type", value: "Contactor", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Amperage Rating", value: "9A", sourceType: "official-fallback" },
            { group: "Product specifications", name: "HP rating - max", value: "0.5, 1.5/ 3, 3, 5, 7.5 (1/3PH @120,240/208,240,480,575 V)", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Frame size", value: "45 mm", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Coil", value: "24 V DC", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Coil voltage", value: "24 V DC", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Contact configuration", value: "1 NO", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Continuous ampere rating", value: "9 A", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Operation", value: "Non-reversing", sourceType: "official-fallback" },
            { group: "Installation", name: "Terminals", value: "Screw terminals", sourceType: "official-fallback" }
          ],
          documents: [
            {
              type: "datasheet",
              label: "Eaton Specification Sheet - 276705",
              url: "https://www.eaton.com/us/en-us/skuPage.276705.pdf",
              sourceType: "official-fallback"
            }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(row.getCell(headers.indexOf("Product Type") + 1).value).toBe("Contactor");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Model Code: DILM9-10(24VDC)");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Contact configuration: 1 NO");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Coil voltage: 24 V DC");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("HP rating - max: 0.5");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Continuous ampere rating: 9 A");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Terminals: Screw terminals");
    expect(String(row.getCell(headers.indexOf("Terminals / Connection") + 1).value)).toContain("Terminals: Screw terminals");
  });

  it("writes Eaton breaker, safety switch, pushbutton, and loadcenter fields to Excel summaries", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-eaton-distribution-xlsx-"));
    const run: RunRecord = {
      id: "eaton-distribution-run",
      manufacturerId: "eaton",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
      total: 4,
      processed: 4,
      found: 4,
      partial: 0,
      failed: 0
    };
    const manufacturer: ManufacturerConfig = {
      id: "eaton",
      canonicalName: "Eaton",
      shortName: "EAT",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: []
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "BR120",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "eaton",
          catalogNumber: "BR120",
          status: "found",
          confidence: 0.9,
          title: "BR120 | Eaton BR thermal magnetic circuit breaker",
          productUrl: "https://www.eaton.com/us/en-us/skuPage.BR120.html",
          normalized: { voltage: "120/240 V", current: "20 A", weight: "0.3 lb" },
          attributes: [
            { group: "General specifications", name: "Product Type", value: "Thermal magnetic circuit breakers", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Used with", value: "Type BR Loadcenters", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Amperage Rating", value: "20 A", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Voltage rating", value: "120/240 V", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Circuit breaker type", value: "BR", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Mounting Method", value: "Plug-on", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Interrupt rating", value: "10 kAIC", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Main circuit breaker", value: "BR", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Wire size", value: "#14-4 AWG Cu/Al", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Number of poles", value: "Single-pole", sourceType: "official-fallback" }
          ],
          documents: [],
          sources: []
        }
      },
      {
        id: 2,
        runId: run.id,
        rowIndex: 2,
        catalogNumber: "DG221URB",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "eaton",
          catalogNumber: "DG221URB",
          status: "found",
          confidence: 0.9,
          title: "DG221URB | Eaton general duty non-fusible safety switch",
          productUrl: "https://www.eaton.com/us/en-us/skuPage.DG221URB.html",
          normalized: { voltage: "240 V", current: "30 A", protection: "NEMA 3R", material: "Painted galvanized steel" },
          attributes: [
            { group: "General specifications", name: "Product Type", value: "Non-fusible safety switch", sourceType: "official-fallback" },
            { group: "Physical Attributes", name: "Enclosure", value: "NEMA 3R", sourceType: "official-fallback" },
            { group: "Physical Attributes", name: "Enclosure material", value: "Painted galvanized steel", sourceType: "official-fallback" },
            { group: "Physical Attributes", name: "Fuse configuration", value: "Non-fusible", sourceType: "official-fallback" },
            { group: "Physical Attributes", name: "Number of wires", value: "2", sourceType: "official-fallback" },
            { group: "Performance Ratings", name: "Amperage Rating", value: "30A", sourceType: "official-fallback" },
            { group: "Performance Ratings", name: "Voltage rating", value: "240V", sourceType: "official-fallback" },
            { group: "Miscellaneous", name: "Product Category", value: "General duty safety switch", sourceType: "official-fallback" }
          ],
          documents: [],
          sources: []
        }
      },
      {
        id: 3,
        runId: run.id,
        rowIndex: 3,
        catalogNumber: "M22-PV-K12",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "eaton",
          catalogNumber: "M22-PV-K12",
          status: "found",
          confidence: 0.9,
          title: "M22-PV-K12 | Eaton M22 modular pushbutton",
          productUrl: "https://www.eaton.com/us/en-us/skuPage.M22-PV-K12.html",
          normalized: { protection: "IP67, IP69K, NEMA 4X, NEMA 13", weight: "0.15 lb" },
          attributes: [
            { group: "General specifications", name: "Product Type", value: "Modular pushbutton", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Type", value: "Emergency Stop", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Bezel", value: "Silver", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Actuator function", value: "Maintained", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Button color", value: "Red", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Actuator", value: "Knob, push-pull", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Contact configuration", value: "1 NO-2 NC", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Illumination", value: "Non-illuminated", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Environmental rating", value: "IP67, IP69K, NEMA 4X, NEMA 13", sourceType: "official-fallback" }
          ],
          documents: [],
          sources: []
        }
      },
      {
        id: 4,
        runId: run.id,
        rowIndex: 4,
        catalogNumber: "BRP30B150V25",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "eaton",
          catalogNumber: "BRP30B150V25",
          status: "found",
          confidence: 0.9,
          title: "BRP30B150V25 | Eaton BR main breaker loadcenter",
          productUrl: "https://www.eaton.com/us/en-us/skuPage.BRP30B150V25.html",
          normalized: { voltage: "120/240 V", current: "150 A", protection: "NEMA 1" },
          attributes: [
            { group: "General specifications", name: "Product Type", value: "Main breaker loadcenter", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Special features", value: "Value pack: 30 spaces w/ (2) BR120 & (1) BR230", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Amperage Rating", value: "150 A", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Bus material", value: "Aluminum", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Cover", value: "Cover included", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Number of circuits", value: "60", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Number of spaces", value: "30", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Phase", value: "Single-phase", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Box size", value: "X5", sourceType: "official-fallback" },
            { group: "Product specifications", name: "NEMA rating", value: "NEMA 1", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Interrupt rating", value: "22 kAIC", sourceType: "official-fallback" }
          ],
          documents: [],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const byCatalog = new Map([2, 3, 4, 5].map((rowNumber) => [String(products.getRow(rowNumber).getCell(headers.indexOf("Catalog Number") + 1).value), products.getRow(rowNumber)]));

    expect(String(byCatalog.get("BR120")?.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Interrupt rating: 10 kAIC");
    expect(String(byCatalog.get("BR120")?.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Wire size: #14-4 AWG Cu/Al");
    expect(String(byCatalog.get("BR120")?.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Mounting Method: Plug-on");
    expect(String(byCatalog.get("BR120")?.getCell(headers.indexOf("Mounting") + 1).value)).toContain("Mounting Method: Plug-on");
    expect(String(byCatalog.get("BR120")?.getCell(headers.indexOf("Wire / Cable Size") + 1).value)).toContain("Wire size: #14-4 AWG Cu/Al");
    expect(String(byCatalog.get("BR120")?.getCell(headers.indexOf("Poles") + 1).value)).toContain("Number of poles: Single-pole");
    expect(String(byCatalog.get("DG221URB")?.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Fuse configuration: Non-fusible");
    expect(String(byCatalog.get("DG221URB")?.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Enclosure: NEMA 3R");
    expect(String(byCatalog.get("DG221URB")?.getCell(headers.indexOf("NEMA / Type Rating") + 1).value)).toBe("NEMA 3R");
    expect(String(byCatalog.get("M22-PV-K12")?.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Button color: Red");
    expect(String(byCatalog.get("M22-PV-K12")?.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Environmental rating: IP67");
    expect(String(byCatalog.get("M22-PV-K12")?.getCell(headers.indexOf("IP Rating") + 1).value)).toBe("IP67; IP69K");
    expect(String(byCatalog.get("M22-PV-K12")?.getCell(headers.indexOf("NEMA / Type Rating") + 1).value)).toBe("NEMA 4X; NEMA 13");
    expect(String(byCatalog.get("BRP30B150V25")?.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Number of spaces: 30");
    expect(String(byCatalog.get("BRP30B150V25")?.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Phase: Single-phase");
    expect(String(byCatalog.get("BRP30B150V25")?.getCell(headers.indexOf("Phase") + 1).value)).toContain("Phase: Single-phase");
    expect(String(byCatalog.get("BRP30B150V25")?.getCell(headers.indexOf("NEMA / Type Rating") + 1).value)).toBe("NEMA 1");
    expect(String(byCatalog.get("BRP30B150V25")?.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Interrupt rating: 22 kAIC");
  });

  it("writes Eaton UPS battery, input, output, and warranty details to Excel summaries", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-eaton-ups-xlsx-"));
    const run: RunRecord = {
      id: "eaton-ups-run",
      manufacturerId: "eaton",
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
      id: "eaton",
      canonicalName: "Eaton",
      shortName: "EAT",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: [],
      localizedUrlTemplates: [
        { locale: "en", urlTemplate: "https://www.eaton.com/us/en-us/skuPage.{partSlashBraces}.html" },
        { locale: "de", urlTemplate: "https://www.eaton.com/de/de-de/skuPage.{partSlashBraces}.html" }
      ]
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "5S1500G",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "eaton",
          catalogNumber: "5S1500G",
          status: "found",
          confidence: 0.9,
          title: "5S1500G | Eaton 5S UPS",
          productUrl: "https://www.eaton.com/us/en-us/skuPage.5S1500G.html",
          normalized: {
            weight: "24.6 lb (11.16 kg)",
            dimensions: "9.8 x 3.4 x 15 in (248.92 x 86.36 x 381 mm)",
            voltage: "230 V",
            certificates: "UL"
          },
          attributes: [
            { group: "General specifications", name: "Product Name", value: "Eaton 5S UPS", sourceType: "official-fallback" },
            { group: "General specifications", name: "Catalog Number", value: "5S1500G", sourceType: "official-fallback" },
            { group: "General specifications", name: "Product Type", value: "UPS", sourceType: "official-fallback" },
            { group: "Electrical output", name: "Battery type", value: "Sealed, lead-acid", sourceType: "official-fallback" },
            { group: "Electrical output", name: "Receptacle", value: "(8) C13", sourceType: "official-fallback" },
            { group: "Electrical output", name: "VA rating", value: "1500 VA", sourceType: "official-fallback" },
            { group: "Electrical output", name: "Wattage", value: "900 W", sourceType: "official-fallback" },
            { group: "Electrical output", name: "Output nominal voltage", value: "230V", sourceType: "official-fallback" },
            { group: "Electrical input", name: "Input connection", value: "C14", sourceType: "official-fallback" },
            { group: "Electrical input", name: "Input nominal voltage", value: "230V", sourceType: "official-fallback" },
            { group: "Electrical input", name: "Nominal frequency", value: "50/60 Hz", sourceType: "official-fallback" },
            { group: "General specifications", name: "Standard factory warranty", value: "3 year", sourceType: "official-fallback" }
          ],
          documents: [
            {
              type: "datasheet",
              label: "Eaton Specification Sheet - 5S1500G",
              url: "https://www.eaton.com/us/en-us/skuPage.5S1500G.pdf",
              sourceType: "official-fallback"
            },
            {
              type: "other",
              label: "Eaton extended warranty certificate",
              url: "https://www.eaton.com/content/dam/eaton/support/warranty/eaton-extended-warranty-certificate.pdf",
              sourceType: "official-fallback"
            }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(row.getCell(headers.indexOf("Product Type") + 1).value).toBe("UPS");
    expect(row.getCell(headers.indexOf("Device Type") + 1).value).toBe("UPS");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Battery type: Sealed, lead-acid");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("VA rating: 1500 VA");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Wattage: 900 W");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Input connection: C14");
    expect(String(row.getCell(headers.indexOf("Frequency") + 1).value)).toContain("Nominal frequency: 50/60 Hz");
    expect(String(row.getCell(headers.indexOf("Terminals / Connection") + 1).value)).toContain("Input connection: C14");
    expect(String(row.getCell(headers.indexOf("Lifecycle / Commercial") + 1).value)).toContain("Standard factory warranty: 3 year");
    expect(String(row.getCell(headers.indexOf("Downloads") + 1).value)).toContain("Datasheet: Eaton Specification Sheet - 5S1500G");
    expect(String(row.getCell(headers.indexOf("All Resources") + 1).value)).toContain("Datasheet: Eaton Specification Sheet - 5S1500G - https://www.eaton.com/us/en-us/skuPage.5S1500G.pdf");
    expect(String(row.getCell(headers.indexOf("All Resources") + 1).value)).toContain("Other: Eaton extended warranty certificate");
    expect(row.getCell(headers.indexOf("Certificates") + 1).value).toBe("UL");
  });

  it("writes Eaton cable and cable gland details to Excel summaries and measurements", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-eaton-cable-xlsx-"));
    const run: RunRecord = {
      id: "eaton-cable-run",
      manufacturerId: "eaton",
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
      id: "eaton",
      canonicalName: "Eaton",
      shortName: "EAT",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: []
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "P569-006-2B-MF",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "eaton",
          catalogNumber: "P569-006-2B-MF",
          status: "found",
          confidence: 0.9,
          title: "P569-006-2B-MF | Eaton Tripp Lite series cable",
          productUrl: "https://www.eaton.com/us/en-us/skuPage.P569-006-2B-MF.html",
          normalized: { weight: "0.3 lb", material: "PVC", color: "Black" },
          attributes: [
            { group: "General specifications", name: "Product Type", value: "Cable", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Cable Length", value: "6 Foot", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Cable Outer Diameter (OD)", value: "7.3 mm", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Cable Jacket Material", value: "PVC", sourceType: "official-fallback" },
            { group: "Product specifications", name: "Connector type", value: "Video", sourceType: "official-fallback" },
            { group: "Product specifications", name: "SideA Connector1", value: "HDMI (MALE)", sourceType: "official-fallback" },
            { group: "Product specifications", name: "SideB Connector1", value: "HDMI (FEMALE)", sourceType: "official-fallback" }
          ],
          documents: [
            { type: "image", label: "Cable front", url: "https://dynamicmedia.eaton.com/is/image/eaton/P569_FRONT?wid=500&hei=500", sourceType: "official-fallback" },
            { type: "image", label: "Cable connector", url: "https://dynamicmedia.eaton.com/is/image/eaton/P569_CONN?wid=500&hei=500", sourceType: "official-fallback" },
            { type: "datasheet", label: "Eaton Specification Sheet - P569-006-2B-MF", url: "https://www.eaton.com/us/en-us/skuPage.P569-006-2B-MF.pdf", sourceType: "official-fallback" }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(row.getCell(headers.indexOf("Length (in)") + 1).value).toBe(72);
    expect(row.getCell(headers.indexOf("Length (mm)") + 1).value).toBe(1828.8);
    expect(row.getCell(headers.indexOf("Product Type") + 1).value).toBe("Cable");
    expect(row.getCell(headers.indexOf("Device Type") + 1).value).toBe("Cable");
    expect(row.getCell(headers.indexOf("Image") + 1).value).toBe("Linked");
    expect(row.getCell(headers.indexOf("Image Count") + 1).value).toBe(2);
    expect(cellText(row.getCell(headers.indexOf("Image URL") + 1))).toContain("P569_FRONT");
    expect(String(row.getCell(headers.indexOf("All Image URLs") + 1).value)).toContain("Cable front: https://dynamicmedia.eaton.com/is/image/eaton/P569_FRONT");
    expect(String(row.getCell(headers.indexOf("All Image URLs") + 1).value)).toContain("Cable connector: https://dynamicmedia.eaton.com/is/image/eaton/P569_CONN");
    expect(String(row.getCell(headers.indexOf("Downloads") + 1).value)).toContain("Datasheet: Eaton Specification Sheet - P569-006-2B-MF");
    expect(String(row.getCell(headers.indexOf("Downloads") + 1).value)).not.toContain("Image:");
    expect(String(row.getCell(headers.indexOf("All Specifications") + 1).value)).toContain("[Product specifications]");
    expect(String(row.getCell(headers.indexOf("All Specifications") + 1).value)).toContain("SideA Connector1: HDMI (MALE)");
    expect(String(row.getCell(headers.indexOf("All Specifications") + 1).value)).toContain("SideB Connector1: HDMI (FEMALE)");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Connector type: Video");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Cable Outer Diameter (OD): 7.3 mm");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Cable Jacket Material: PVC");
  });

  it("writes localized Eaton automation and I/O fields into Excel summaries", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-eaton-io-xlsx-"));
    const run: RunRecord = {
      id: "eaton-io-run",
      manufacturerId: "eaton",
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
      id: "eaton",
      canonicalName: "Eaton",
      shortName: "EAT",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: [],
      localizedUrlTemplates: [
        { locale: "en", urlTemplate: "https://www.eaton.com/us/en-us/skuPage.{partSlashBraces}.html" },
        { locale: "de", urlTemplate: "https://www.eaton.com/de/de-de/skuPage.{partSlashBraces}.html" }
      ]
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "197517",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "eaton",
          catalogNumber: "197517",
          status: "found",
          confidence: 0.9,
          title: "197517 | Eaton Moeller series EASY I/O expansion",
          productUrl: "https://www.eaton.com/no/no-no/skuPage.197517.html",
          normalized: {
            weight: "0.1 kg",
            dimensions: "90 x 36 x 58 mm",
            voltage: "20.4...28.8 V DC",
            current: "40 mA",
            protection: "IP20",
            certificates: "UL; CE"
          },
          attributes: [
            { group: "General specifications", name: "Product Name", value: "Eaton Moeller series EASY I/O expansion", sourceType: "official-fallback" },
            { group: "General specifications", name: "Catalog Number", value: "197517", sourceType: "official-fallback" },
            { group: "General specifications", name: "Model Code", value: "EASY-E4-DC-4PE1P", sourceType: "official-fallback" },
            { group: "Elektrisk klassifisering", name: "Rated operational voltage", value: "20.4 - 28.8 V DC", sourceType: "official-fallback" },
            { group: "Elektrisk klassifisering", name: "Supply voltage at DC - max", value: "28.8 VDC", sourceType: "official-fallback" },
            { group: "Elektrisk klassifisering", name: "Power consumption", value: "1 W", sourceType: "official-fallback" },
            { group: "Generell informasjon", name: "Protocol", value: "MODBUS", sourceType: "official-fallback" },
            { group: "Generell informasjon", name: "Software", value: "EASYSOFT-SWLIC/easySoft", sourceType: "official-fallback" },
            { group: "Inn-/utgang", name: "Input", value: "Input type resistance sensor: Platinum sensor Pt100", sourceType: "official-fallback" },
            { group: "Inn-/utgang", name: "Input current", value: "40 mA", sourceType: "official-fallback" },
            { group: "Inn-/utgang", name: "Number of inputs (analog)", value: "4", sourceType: "official-fallback" },
            { group: "Terminalkapasitet", name: "Terminal capacity", value: "0.2 - 2.5 mm2 (22 - 12 AWG), flexible with ferrule", sourceType: "official-fallback" },
            { group: "Miljøforhold", name: "Ambient operating temperature - max", value: "55 C", sourceType: "official-fallback" },
            { group: "Miljøforhold", name: "Relative humidity", value: "5 - 95 %", sourceType: "official-fallback" }
          ],
          documents: [
            {
              type: "certificate",
              label: "eaton-i-o-expansion-declaration-of-conformity-eu251486en.pdf",
              url: "https://www.eaton.com/content/dam/eaton/products/industrialcontrols-drives-automation-sensors/easy-relays/eaton-i-o-expansion-declaration-of-conformity-eu251486en.pdf",
              sourceType: "official-fallback"
            },
            {
              type: "cad",
              label: "DA-CE-ETN.EASY-E4-DC-4PE1P",
              url: "https://www.eaton.com/content/dam/eaton/products/industrialcontrols-drives-automation-sensors/easy-relays/DA-CE-ETN.EASY-E4-DC-4PE1P",
              sourceType: "official-fallback"
            }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Protocol: MODBUS");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Number of inputs (analog): 4");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Supply voltage at DC - max: 28.8 VDC");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Power consumption: 1 W");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Terminal capacity: 0.2 - 2.5 mm2");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Relative humidity: 5 - 95 %");
    expect(String(row.getCell(headers.indexOf("Terminals / Connection") + 1).value)).toContain("Terminal capacity: 0.2 - 2.5 mm2");
    expect(String(row.getCell(headers.indexOf("Wire / Cable Size") + 1).value)).toContain("Terminal capacity: 0.2 - 2.5 mm2");
    expect(String(row.getCell(headers.indexOf("Operating Temperature") + 1).value)).toContain("Ambient operating temperature - max: 55 C");
    expect(String(row.getCell(headers.indexOf("Downloads") + 1).value)).toContain("CAD: DA-CE-ETN.EASY-E4-DC-4PE1P");
    expect(String(row.getCell(headers.indexOf("All Resources") + 1).value)).toContain("Certificate: eaton-i-o-expansion-declaration-of-conformity-eu251486en.pdf");
    expect(String(row.getCell(headers.indexOf("All Resources") + 1).value)).toContain("CAD: DA-CE-ETN.EASY-E4-DC-4PE1P");
  });

  it("writes Schneider Electric structured specs into product summaries and raw sheets", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-schneider-xlsx-"));
    const run: RunRecord = {
      id: "schneider-run",
      manufacturerId: "schneider",
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
      id: "schneider",
      canonicalName: "Schneider Electric",
      shortName: "SE",
      rateLimitMs: 100,
      officialBaseUrls: ["https://www.se.com"],
      fallbackSources: [],
      localizedUrlTemplates: [
        { locale: "en", urlTemplate: "https://www.se.com/ww/en/product/{part}/" },
        { locale: "de", urlTemplate: "https://www.se.com/de/de/product/{part}/" }
      ]
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "GV2ME08",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "schneider",
          catalogNumber: "GV2ME08",
          status: "found",
          confidence: 0.9,
          title: "TeSys Deca Manual Starter and Protector",
          productUrl: "https://www.se.com/us/en/product/GV2ME08/tesys-deca-manual-starter-and-protector/",
          normalized: {
            weight: "0.57 lb(US) (0.26 kg)",
            dimensions: "H 3.5 in (89 mm) x W 1.8 in (45 mm) x D 3.09 in (78.5 mm)",
            voltage: "690 V AC 50/60 Hz",
            current: "4 A",
            protection: "IP20 IEC 60529",
            certificates: "UL; CSA; IEC 60947"
          },
          attributes: [
            { group: "Schneider Product Info", name: "Catalog Number", value: "GV2ME08", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Product Info", name: "Product label", value: "TeSys Deca Manual Starters and Protectors GV2", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Main", name: "Range", value: "TeSys Deca", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Main", name: "Product or Component Type", value: "Motor circuit breaker", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Main", name: "Device short name", value: "GV2ME", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Complementary", name: "[Ue] rated operational voltage", value: "690 V AC 50/60 Hz", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Complementary", name: "Rated Current", value: "4 A", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Complementary", name: "Breaking capacity", value: "100 kA Icu 400/415 V AC 50/60 Hz", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Complementary", name: "Mounting support", value: "35 mm symmetrical DIN rail", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Environment", name: "IP degree of protection", value: "IP20 IEC 60529", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Environment", name: "Product Certifications", value: "UL; CSA; IEC 60947", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Sustainability", name: "Total lifecycle Carbon footprint", value: "11 kg CO2 eq.", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Commercial", name: "Price", value: "179.93 USD", sourceType: "official-fallback", parser: "schneider-product-page" },
            { group: "Schneider Product Info", name: "Product availability", value: "Stock", sourceType: "official-fallback", parser: "schneider-product-page" }
          ],
          documents: [
            {
              type: "datasheet",
              label: "Product Datasheet",
              url: "https://www.se.com/us/en/product/download-pdf/GV2ME08?filename=GV2ME08.pdf",
              sourceType: "official-fallback",
              parser: "schneider-product-page"
            },
            {
              type: "manual",
              label: "User guide",
              url: "https://download.schneider-electric.com/files?p_enDocType=User+guide&p_File_Name=1672546-08.pdf&p_Doc_Ref=1672546",
              sourceType: "official-fallback",
              parser: "schneider-product-page"
            }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(row.getCell(headers.indexOf("Product Type") + 1).value).toBe("Motor circuit breaker");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Range: TeSys Deca");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("[Ue] rated operational voltage: 690 V AC");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Breaking capacity: 100 kA");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Mounting support: 35 mm symmetrical DIN rail");
    expect(String(row.getCell(headers.indexOf("Compliance / Standards") + 1).value)).toContain("Total lifecycle Carbon footprint: 11 kg CO2 eq.");
    expect(String(row.getCell(headers.indexOf("Lifecycle / Commercial") + 1).value)).toContain("Price: 179.93 USD");

    const attributes = workbook.getWorksheet("Attributes")!;
    const attributeValues = attributes.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(attributeValues).toContain("Schneider Complementary");
    expect(attributeValues).toContain("[Ue] rated operational voltage");

    const documents = workbook.getWorksheet("Documents")!;
    const documentValues = documents.getSheetValues().flat().map((value) => String(value ?? ""));
    expect(documentValues).toContain("Product Datasheet");
    expect(documentValues).toContain("User guide");
  });

  it("writes Telemecanique sensor characteristics into Schneider Excel summaries", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-xlsx-"));
    const run: RunRecord = {
      id: "schneider-sensor-run",
      manufacturerId: "schneider",
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
      id: "schneider",
      canonicalName: "Schneider Electric",
      shortName: "Schneider",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: []
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "XS618B1PAL2",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          manufacturerId: "schneider",
          catalogNumber: "XS618B1PAL2",
          status: "found",
          confidence: 0.88,
          title: "Inductive proximity sensor XS6 M18",
          productUrl: "https://telemecaniquesensors.com/us/en/product/reference/XS618B1PAL2",
          localizedUrls: { en: "https://telemecaniquesensors.com/us/en/product/reference/XS618B1PAL2" },
          normalized: {
            material: "nickel plated brass",
            voltage: "12...48 V DC",
            current: "<= 200 mA",
            protection: "IP68; IP69K"
          },
          attributes: [
            { group: "Schneider Product Info", name: "Catalog Number", value: "XS618B1PAL2", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Main", name: "Sensor type", value: "Inductive proximity sensor", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Main", name: "Sensor design", value: "Cylindrical M18", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Main", name: "[Sn] nominal sensing distance", value: "8 mm", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Main", name: "Detector flush mounting acceptance", value: "Flush mountable", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Output circuit type", value: "DC 3-wire", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Type of output signal", value: "Discrete", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Discrete output function", value: "1 NO", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Discrete output type", value: "PNP", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Switching capacity in mA", value: "<= 200 mA", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Current consumption", value: "<= 10 mA no-load", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Voltage drop", value: "<= 2 V closed state", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Electrical connection", value: "Cable 2 m", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Thread type", value: "M18 x 1", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Front material", value: "PPS", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Cable composition", value: "3 x 0.34 mm2", sourceType: "official", parser: "schneider-telemecanique-product-page" },
            { group: "Schneider Complementary", name: "Wire insulation material", value: "PVC", sourceType: "official", parser: "schneider-telemecanique-product-page" }
          ],
          documents: [
            {
              type: "datasheet",
              label: "Product data sheet",
              url: "https://downloads.telemecaniquesensors.com/dam/product-data-sheet.pdf",
              sourceType: "official",
              parser: "schneider-telemecanique-product-page"
            }
          ],
          sources: []
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const row = products.getRow(2);

    expect(row.getCell(headers.indexOf("Product Type") + 1).value).toBe("Inductive proximity sensor");
    expect(String(row.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("[Sn] nominal sensing distance: 8 mm");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Switching capacity in mA: <= 200 mA");
    expect(String(row.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Output circuit type: DC 3-wire");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Front material: PPS");
    expect(String(row.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Cable composition: 3 x 0.34 mm2");
  });

  it("writes Schneider transformer and EV charger domain specs into Excel summaries", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-schneider-domain-xlsx-"));
    const run: RunRecord = {
      id: "schneider-domain-run",
      manufacturerId: "schneider",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
      total: 2,
      processed: 2,
      found: 2,
      partial: 0,
      failed: 0
    };
    const manufacturer: ManufacturerConfig = {
      id: "schneider",
      canonicalName: "Schneider Electric",
      shortName: "Schneider",
      rateLimitMs: 100,
      officialBaseUrls: [],
      fallbackSources: []
    };
    const commonResult = {
      manufacturerId: "schneider" as const,
      status: "found" as const,
      confidence: 0.9,
      localizedUrls: {},
      documents: [],
      sources: []
    };
    const items: RunItemRecord[] = [
      {
        id: 1,
        runId: run.id,
        rowIndex: 1,
        catalogNumber: "METSECT5CC008",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          ...commonResult,
          catalogNumber: "METSECT5CC008",
          title: "current transformer tropicalised DIN mount 75 5 for cables d. 21",
          normalized: { voltage: "< 720 V AC 50/60 Hz", current: "75 A" },
          attributes: [
            { group: "Schneider Main", name: "Product or component type", value: "Current transformer", sourceType: "official" },
            { group: "Schneider Main", name: "Secondary current", value: "5 A", sourceType: "official" },
            { group: "Schneider Main", name: "Accuracy class", value: "Class 1 at 1.5 VA; Class 3 at 2.5 VA", sourceType: "official" },
            { group: "Schneider Main", name: "[In] rated current", value: "75 A", sourceType: "official" },
            { group: "Schneider Complementary", name: "Current transformer type", value: "Tropicalised for cable; Solid core", sourceType: "official" },
            { group: "Schneider Complementary", name: "Current transformer ratio", value: "75/5", sourceType: "official" },
            { group: "Schneider Complementary", name: "Cable outer diameter", value: "21 mm", sourceType: "official" }
          ]
        }
      },
      {
        id: 2,
        runId: run.id,
        rowIndex: 2,
        catalogNumber: "EVH4S03N2",
        status: "found",
        updatedAt: run.updatedAt,
        result: {
          ...commonResult,
          catalogNumber: "EVH4S03N2",
          title: "Charging station, EVlink Home, 1P+N, 1xT2, 3.7kW, 16A, with RDC-DD",
          normalized: { voltage: "230 V AC 50 Hz +/- 10 %", current: "16 A", protection: "IP54; IK10" },
          attributes: [
            { group: "Schneider Main", name: "Product or component type", value: "Charging station", sourceType: "official" },
            { group: "Schneider Main", name: "Poles description", value: "1P + N", sourceType: "official" },
            { group: "Schneider Main", name: "Max power", value: "3.7 kW 16 A 230 V", sourceType: "official" },
            { group: "Schneider Main", name: "Connection to the vehicle", value: "Socket-outlet T2 front face", sourceType: "official" },
            { group: "Schneider Complementary", name: "rated supply voltage", value: "230 V AC 50 Hz +/- 10 %", sourceType: "official" },
            { group: "Schneider Complementary", name: "Earthing system", value: "TT; TN-S", sourceType: "official" },
            { group: "Schneider Complementary", name: "Protection type", value: "Earth-leakage protection", sourceType: "official" },
            { group: "Schneider Complementary", name: "Maximum supply current", value: "16 A", sourceType: "official" }
          ]
        }
      }
    ];

    const filePath = await exportRunWorkbook({ run, manufacturer, items, outputDir });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const products = workbook.getWorksheet("Products")!;
    const headers = (products.getRow(1).values as unknown[]).slice(1);
    const byCatalog = new Map([2, 3].map((rowNumber) => [String(products.getRow(rowNumber).getCell(headers.indexOf("Catalog Number") + 1).value), products.getRow(rowNumber)]));

    expect(byCatalog.get("METSECT5CC008")?.getCell(headers.indexOf("Product Type") + 1).value).toBe("Current transformer");
    expect(String(byCatalog.get("METSECT5CC008")?.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Current transformer ratio: 75/5");
    expect(String(byCatalog.get("METSECT5CC008")?.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Secondary current: 5 A");
    expect(String(byCatalog.get("METSECT5CC008")?.getCell(headers.indexOf("Mechanical / Installation") + 1).value)).toContain("Cable outer diameter: 21 mm");
    expect(byCatalog.get("EVH4S03N2")?.getCell(headers.indexOf("Product Type") + 1).value).toBe("Charging station");
    expect(String(byCatalog.get("EVH4S03N2")?.getCell(headers.indexOf("Key Specifications") + 1).value)).toContain("Connection to the vehicle: Socket-outlet T2 front face");
    expect(String(byCatalog.get("EVH4S03N2")?.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Max power: 3.7 kW 16 A 230 V");
    expect(String(byCatalog.get("EVH4S03N2")?.getCell(headers.indexOf("Electrical Ratings") + 1).value)).toContain("Maximum supply current: 16 A");
  });
});
