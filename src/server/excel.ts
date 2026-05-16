import ExcelJS from "exceljs";
import path from "node:path";
import type { ManufacturerConfig, ProductResult, RunItemRecord, RunRecord } from "../shared/types.js";
import { buildLocalizedProductUrls } from "./scrapers/localized-urls.js";

export async function exportRunWorkbook(input: {
  run: RunRecord;
  manufacturer: ManufacturerConfig;
  items: RunItemRecord[];
  outputDir: string;
}): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Product Scraper";
  workbook.created = new Date();
  workbook.modified = new Date();

  const products = workbook.addWorksheet("Products", { views: [{ state: "frozen", ySplit: 1 }] });
  const attributes = workbook.addWorksheet("Attributes", { views: [{ state: "frozen", ySplit: 1 }] });
  const documents = workbook.addWorksheet("Documents", { views: [{ state: "frozen", ySplit: 1 }] });
  const sources = workbook.addWorksheet("Sources", { views: [{ state: "frozen", ySplit: 1 }] });
  const failures = workbook.addWorksheet("Failures", { views: [{ state: "frozen", ySplit: 1 }] });

  products.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Short Name", key: "shortName", width: 12 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Status", key: "status", width: 12 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Title", key: "title", width: 42 },
    { header: "Description", key: "description", width: 56 },
    { header: "Product URL EN", key: "productUrlEn", width: 60 },
    { header: "Product URL DE", key: "productUrlDe", width: 60 },
    { header: "Product URL Source", key: "productUrl", width: 60 },
    { header: "Weight", key: "weight", width: 18 },
    { header: "Dimensions", key: "dimensions", width: 28 },
    { header: "Material", key: "material", width: 28 },
    { header: "Voltage", key: "voltage", width: 20 },
    { header: "Current", key: "current", width: 20 },
    { header: "Protection", key: "protection", width: 28 },
    { header: "Certificates", key: "certificates", width: 36 },
    { header: "Page Attribute Count", key: "attributeCount", width: 18 },
    { header: "Document Count", key: "documentCount", width: 14 },
    { header: "Missing Required Fields", key: "missingRequiredFields", width: 42 },
    { header: "Error", key: "error", width: 40 }
  ];

  attributes.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Group", key: "group", width: 28 },
    { header: "Attribute", key: "name", width: 34 },
    { header: "Value", key: "value", width: 72 },
    { header: "Unit", key: "unit", width: 12 },
    { header: "Source URL", key: "sourceUrl", width: 60 }
  ];

  documents.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Type", key: "type", width: 14 },
    { header: "Label", key: "label", width: 42 },
    { header: "URL", key: "url", width: 60 },
    { header: "Local Path", key: "localPath", width: 60 },
    { header: "Source URL", key: "sourceUrl", width: 60 }
  ];

  sources.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Source Type", key: "sourceType", width: 18 },
    { header: "Parser", key: "parser", width: 26 },
    { header: "Status Code", key: "statusCode", width: 14 },
    { header: "Fetched At", key: "fetchedAt", width: 26 },
    { header: "URL", key: "url", width: 70 }
  ];

  failures.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Status", key: "status", width: 12 },
    { header: "Error", key: "error", width: 80 }
  ];

  for (const item of input.items) {
    const result = item.result;
    products.addRow(productRow(input.manufacturer, item, result));
    if (!result || result.status === "failed") {
      failures.addRow({
        manufacturer: input.manufacturer.canonicalName,
        catalogNumber: item.catalogNumber,
        status: item.status,
        error: item.error ?? result?.error ?? "No result"
      });
    }
    if (!result) continue;
    for (const attr of sortAttributes(result.attributes)) {
      attributes.addRow({
        manufacturer: input.manufacturer.canonicalName,
        catalogNumber: result.catalogNumber,
        group: attr.group,
        name: attr.name,
        value: attr.value,
        unit: attr.unit,
        sourceUrl: attr.sourceUrl
      });
    }
    for (const doc of result.documents) {
      documents.addRow({
        manufacturer: input.manufacturer.canonicalName,
        catalogNumber: result.catalogNumber,
        type: doc.type,
        label: doc.label,
        url: doc.url,
        localPath: doc.localPath,
        sourceUrl: doc.sourceUrl
      });
    }
    for (const source of result.sources) {
      sources.addRow({
        manufacturer: input.manufacturer.canonicalName,
        catalogNumber: result.catalogNumber,
        sourceType: source.sourceType,
        parser: source.parser,
        statusCode: source.statusCode,
        fetchedAt: source.fetchedAt,
        url: source.url
      });
    }
  }

  for (const sheet of [products, attributes, documents, sources, failures]) {
    styleSheet(sheet);
  }

  const outputPath = path.join(input.outputDir, `${safeWorkbookPart(input.manufacturer.shortName)}.product-scrape-${input.run.id}.xlsx`);
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

function productRow(manufacturer: ManufacturerConfig, item: RunItemRecord, result?: ProductResult) {
  const urls = {
    ...buildLocalizedProductUrls(manufacturer.id, item.catalogNumber, result?.productUrl ?? item.productUrl),
    ...result?.localizedUrls
  };
  const row = {
    manufacturer,
    result,
    productUrlEn: urls.en,
    productUrlDe: urls.de,
    weight: result?.normalized.weight,
    dimensions: result?.normalized.dimensions,
    material: result?.normalized.material,
    certificates: result?.normalized.certificates
  };

  return {
    manufacturer: manufacturer.canonicalName,
    shortName: manufacturer.shortName,
    catalogNumber: item.catalogNumber,
    status: result?.status ?? item.status,
    confidence: result?.confidence ?? item.confidence ?? 0,
    title: result?.title ?? item.title,
    description: result?.description,
    productUrlEn: row.productUrlEn,
    productUrlDe: row.productUrlDe,
    productUrl: result?.productUrl ?? item.productUrl,
    weight: row.weight,
    dimensions: row.dimensions,
    material: row.material,
    voltage: result?.normalized.voltage,
    current: result?.normalized.current,
    protection: result?.normalized.protection,
    certificates: row.certificates,
    attributeCount: result?.attributes.length ?? 0,
    documentCount: result?.documents.length ?? 0,
    missingRequiredFields: missingRequiredFields(row),
    error: result?.error ?? item.error
  };
}

function missingRequiredFields(row: {
  manufacturer: ManufacturerConfig;
  result?: ProductResult;
  productUrlEn?: string;
  productUrlDe?: string;
  weight?: string;
  dimensions?: string;
  material?: string;
  certificates?: string;
}): string | undefined {
  const missing = [
    row.productUrlEn ? undefined : "English URL",
    row.productUrlDe ? undefined : row.manufacturer.id === "sce" ? "German URL (no official German source configured)" : "German URL",
    row.weight ? undefined : "Weight",
    row.dimensions ? undefined : "Dimensions",
    row.material ? undefined : "Material",
    row.certificates ? undefined : "Certificates"
  ].filter(Boolean);
  return missing.length ? missing.join("; ") : undefined;
}

function sortAttributes(attributes: ProductResult["attributes"]): ProductResult["attributes"] {
  return [...attributes].sort((left, right) => {
    const leftGroup = groupRank(left.group) - groupRank(right.group);
    if (leftGroup !== 0) return leftGroup;
    const leftName = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    if (leftName !== 0) return leftName;
    return left.value.localeCompare(right.value, undefined, { sensitivity: "base" });
  });
}

function groupRank(group?: string): number {
  const value = (group ?? "").toLowerCase();
  if (/dimension/.test(value)) return 10;
  if (/spec|product information|product details|technical|table|definition/.test(value)) return 20;
  if (/industry|standard|approval|cert/.test(value)) return 30;
  if (/search/.test(value)) return 40;
  if (/offer/.test(value)) return 50;
  if (/embedded/.test(value)) return 70;
  if (/structured/.test(value)) return 80;
  if (/meta/.test(value)) return 90;
  return 60;
}

function styleSheet(sheet: ExcelJS.Worksheet) {
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount }
  };
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  header.alignment = { vertical: "middle", horizontal: "left" };
  header.height = 22;
  sheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: "top", wrapText: rowNumber !== 1 };
    if (rowNumber > 1 && rowNumber % 2 === 0) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
  });
}

function safeWorkbookPart(value: string): string {
  return (
    value
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "") || "product"
  );
}
