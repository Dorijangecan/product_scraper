import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { extractCustomerDocumentAttributes, extractCustomerFamilyPdfAttributes } from "../src/server/scrapers/customer-documents.js";
import { identityAttributeLabelStrength } from "../src/server/scrapers/product-identity.js";
import type { CustomerDocumentRecord } from "../src/shared/types.js";

async function writeAliasWorkbook(dir: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Feedback");
  sheet.addRow(["Order Number", "Product Model", "Product Description (English)", "Weight (kg)"]);
  sheet.addRow(["CDV00001", "DV1-341D5NB-C20CX1", "3AC 400V, 0.4kW, 1.5A, DO NPN", 0.9]);
  const outputPath = path.join(dir, "feedback.xlsx");
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

describe("customer-documents alias cross-reference", () => {
  it("uses the sibling workbook's model code to match a text document that never mentions the requested catalog number", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-customer-alias-"));
    const workbookPath = await writeAliasWorkbook(dir);
    const textPath = path.join(dir, "manual.txt");
    // Only the manufacturer's own model code appears here — never the customer's order number
    // (this mirrors Eaton's DV1X1 quick-start manual, which prints "DV1-..." model codes but
    // never the CDV##### order number the customer's catalog list and website use).
    await fs.writeFile(
      textPath,
      "DV1-341D5NB-C20CX1  Variable frequency drive 0.4kW 1.5A general purpose drive\nRated current: 1.5 A\n",
      "utf8"
    );

    const documents: CustomerDocumentRecord[] = [
      { id: "xlsx", originalName: "feedback.xlsx", storedPath: workbookPath, uploadedAt: new Date(0).toISOString() },
      { id: "txt", originalName: "manual.txt", storedPath: textPath, uploadedAt: new Date(0).toISOString() }
    ];

    const extraction = await extractCustomerDocumentAttributes("CDV00001", documents);

    const workbookAttrs = extraction.attributes.filter((attr) => attr.sourceUrl?.includes("feedback.xlsx"));
    expect(workbookAttrs.length).toBeGreaterThan(0);

    const textAttrs = extraction.attributes.filter((attr) => attr.sourceUrl?.includes("manual.txt"));
    expect(textAttrs.length).toBeGreaterThan(0);
    expect(textAttrs.some((attr) => /1\.5\s*A/i.test(attr.value))).toBe(true);

    // The manual's text never contains "CDV00001" and only matches via the alias — any
    // attribute the free-text extractor labeled as a strong/weak identity field (e.g.
    // "Catalog Number") must NOT hold the alias value, or downstream identity-conflict
    // detection would read the manufacturer's own model code as a second, mismatched product.
    for (const attr of textAttrs) {
      const strength = identityAttributeLabelStrength(`${attr.group ?? ""} ${attr.name}`);
      if (strength) expect(attr.value).not.toContain("DV1-341D5NB-C20CX1");
    }

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not invent aliases from unrelated cells (units, certifications, short codes)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-customer-alias-noise-"));
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Feedback");
    sheet.addRow(["Order Number", "Certification", "Weight (kg)"]);
    sheet.addRow(["CDV00001", "CE", 0.9]);
    const workbookPath = path.join(dir, "feedback.xlsx");
    await workbook.xlsx.writeFile(workbookPath);

    const textPath = path.join(dir, "unrelated.txt");
    await fs.writeFile(textPath, "This document does not mention the product at all.\n", "utf8");

    const documents: CustomerDocumentRecord[] = [
      { id: "xlsx", originalName: "feedback.xlsx", storedPath: workbookPath, uploadedAt: new Date(0).toISOString() },
      { id: "txt", originalName: "unrelated.txt", storedPath: textPath, uploadedAt: new Date(0).toISOString() }
    ];

    const extraction = await extractCustomerDocumentAttributes("CDV00001", documents);
    expect(extraction.attributes.some((attr) => attr.sourceUrl?.includes("unrelated.txt"))).toBe(false);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("extractCustomerFamilyPdfAttributes", () => {
  const documentName = "DV1X1 Quick Start Manual.pdf";
  const sourceUrl = "file:///manual.pdf";

  function buildManualText(): string {
    const noise = Array.from({ length: 60 }, (_, index) => `Safety precaution paragraph number ${index} about drive installation and wiring.`);
    const table = [
      "Product number\tRated power (kW)\tRated current (A)",
      "DV1-341D5NB-C20CX1\t0.4\t1.5",
      "DV1-343D0NB-C20CX1\t0.75\t3",
      "DV1-121D8NB-C20CX1\t0.2\t1.8"
    ];
    return [...noise, ...table, ...noise].join("\n");
  }

  it("scopes to the matched family instead of dumping the whole manual as prose", () => {
    // "-LC" is a variant suffix the manual never prints (mirrors real Eaton "-LC" SKUs),
    // so this only matches via the loose family-key fallback, not an exact substring hit.
    const attributes = extractCustomerFamilyPdfAttributes("DV1-121D8NB-C20CX1-LC", documentName, sourceUrl, buildManualText());

    expect(attributes.length).toBeGreaterThan(0);
    expect(attributes.length).toBeLessThan(20);
    expect(attributes.some((attr) => /rated power/i.test(attr.name) && /0\.2/.test(attr.value))).toBe(true);
    expect(attributes.some((attr) => /rated current/i.test(attr.name) && /1\.8/.test(attr.value))).toBe(true);
    expect(attributes.some((attr) => /safety precaution paragraph/i.test(attr.value))).toBe(false);
  });

  it("never echoes the alias back under a strong-identity label", () => {
    const attributes = extractCustomerFamilyPdfAttributes("DV1-121D8NB-C20CX1-LC", documentName, sourceUrl, buildManualText());
    for (const attr of attributes) {
      const strength = identityAttributeLabelStrength(`${attr.group ?? ""} ${attr.name}`);
      if (strength) expect(attr.value).not.toBe("DV1-121D8NB-C20CX1-LC");
    }
  });

  it("returns nothing when no family evidence exists in the text", () => {
    expect(extractCustomerFamilyPdfAttributes("ZZZ-UNRELATED-999", documentName, sourceUrl, buildManualText())).toEqual([]);
  });
});
