import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import type { FinalCompletenessRecord, ManufacturerConfig, ProductResult, RunItemRecord, RunRecord } from "../shared/types.js";
import { requiredElectricalFields } from "../shared/product-requirements.js";
import { AI_CLEANED_INPUT_SHEET, writeAiCleanedInputSheet } from "./pdt/ai-cleaned-input-sheet.js";
import { buildPdtRepairResult } from "./pdt/ai-cleanup.js";
import { electricalFieldsForDeviceType } from "./pdt/device-type-profiles.js";
import { classifyDeviceType } from "./scrapers/device-type.js";
import { buildLocalizedProductUrls } from "./scrapers/localized-urls.js";
import { cleanText, normalizeFields } from "./scrapers/normalizer.js";
import { listTechnicalAttributeAliases } from "./scrapers/technical-attribute-aliases.js";

const POUND_TO_KILOGRAM = 0.45359237;
const INCH_TO_MILLIMETER = 25.4;
const MISSING_IMPORTANT_FILL = "FFFEE2E2";
const MISSING_IMPORTANT_FONT = "FF991B1B";

export async function exportRunWorkbook(input: {
  run: RunRecord;
  manufacturer: ManufacturerConfig;
  items: RunItemRecord[];
  outputDir: string;
  onActivity?: (activity: { stage: string; message: string }) => void | Promise<void>;
}): Promise<string> {
  await input.onActivity?.({ stage: "workbook-build", message: "Preparing workbook sheets." });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Product Scraper";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.views = [{ x: 0, y: 0, width: 12000, height: 24000, firstSheet: 0, activeTab: 0, visibility: "visible" }];

  const summary = workbook.addWorksheet("Run Summary", { views: [{ showGridLines: false }] });
  const cleanExport = workbook.addWorksheet("Clean Export", { views: [{ state: "frozen", xSplit: 7, ySplit: 1 }] });
  const importReady = workbook.addWorksheet("Import Ready", { views: [{ state: "frozen", xSplit: 7, ySplit: 1 }] });
  const aiCleanedInput = workbook.addWorksheet(AI_CLEANED_INPUT_SHEET, { views: [{ state: "frozen", ySplit: 11 }] });
  const needsReview = workbook.addWorksheet("Needs Review", { views: [{ state: "frozen", xSplit: 10, ySplit: 1 }] });
  const issueSummary = workbook.addWorksheet("Issue Summary", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const columnGuide = workbook.addWorksheet("Column Guide", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const cleanAttributes = workbook.addWorksheet("Clean Attributes", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const cleanDocuments = workbook.addWorksheet("Clean Documents", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const fieldCoverage = workbook.addWorksheet("Field Coverage", { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
  const specMatrix = workbook.addWorksheet("Spec Matrix", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const checks = workbook.addWorksheet("Checks", { views: [{ state: "frozen", xSplit: 3, ySplit: 1 }] });
  const lookup = workbook.addWorksheet("XLOOKUP", { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
  const products = workbook.addWorksheet("Products", { views: [{ state: "frozen", xSplit: 3, ySplit: 1 }] });
  const attributes = workbook.addWorksheet("Attributes", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const technicalAttributes = workbook.addWorksheet("Technical Attributes", { views: [{ state: "frozen", xSplit: 4, ySplit: 1 }] });
  const aliasDictionary = workbook.addWorksheet("Alias Dictionary", { views: [{ state: "frozen", xSplit: 3, ySplit: 1 }] });
  const documents = workbook.addWorksheet("Documents", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const sources = workbook.addWorksheet("Sources", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const evidence = workbook.addWorksheet("Evidence", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const finalAudit = workbook.addWorksheet("Final Audit", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const failures = workbook.addWorksheet("Failures", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });

  lookup.columns = [
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Short Name", key: "shortName", width: 12 },
    { header: "Status", key: "status", width: 12 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Title", key: "title", width: 42 },
    { header: "Product Type", key: "productType", width: 30 },
    { header: "Device Type", key: "deviceType", width: 30 },
    { header: "Device Type Confidence", key: "deviceTypeConfidence", width: 20, style: { numFmt: "0%" } },
    { header: "Device Type Evidence", key: "deviceTypeEvidence", width: 54 },
    { header: "Copy Summary", key: "copySummary", width: 110 },
    { header: "Voltage", key: "voltage", width: 24 },
    { header: "Current", key: "current", width: 24 },
    { header: "Current Type", key: "currentType", width: 14 },
    { header: "Rated Current", key: "ratedCurrent", width: 18 },
    { header: "Material", key: "material", width: 28 },
    { header: "Certificates", key: "certificates", width: 42 },
    { header: "ECLASS", key: "eclass", width: 24 },
    { header: "Weight", key: "weight", width: 20 },
    { header: "Weight (kg)", key: "weightKg", width: 14, style: { numFmt: "0.#########" } },
    { header: "Weight (lb)", key: "weightLb", width: 14, style: { numFmt: "0.#########" } },
    { header: "Dimensions", key: "dimensions", width: 34 },
    { header: "Height (mm)", key: "heightMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Width (mm)", key: "widthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Depth (mm)", key: "depthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Length (mm)", key: "lengthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "IP Rating", key: "ipRating", width: 18 },
    { header: "Protection", key: "protection", width: 28 },
    { header: "Description", key: "description", width: 70 },
    { header: "EAN / GTIN", key: "ean", width: 20 },
    { header: "Product URL Source", key: "productUrl", width: 60 },
    { header: "Product URL EN", key: "productUrlEn", width: 60 },
    { header: "Product URL DE", key: "productUrlDe", width: 60 },
    { header: "Image Local Path", key: "imageLocalPath", width: 64 },
    { header: "Image URL", key: "imageUrl", width: 64 },
    { header: "Datasheet URLs", key: "datasheetUrls", width: 76 },
    { header: "Manual URLs", key: "manualUrls", width: 76 },
    { header: "CAD URLs", key: "cadUrls", width: 76 },
    { header: "Certificate URLs", key: "certificateUrls", width: 76 },
    { header: "Other URLs", key: "otherUrls", width: 76 },
    { header: "All Document URLs", key: "allDocumentUrls", width: 100 },
    { header: "Height (in)", key: "heightIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Width (in)", key: "widthIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Depth (in)", key: "depthIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Length (in)", key: "lengthIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Finish", key: "finish", width: 42 },
    { header: "Color", key: "color", width: 24 },
    { header: "Poles", key: "poles", width: 18 },
    { header: "Frequency", key: "frequency", width: 24 },
    { header: "Mounting", key: "mounting", width: 36 },
    { header: "Terminals / Connection", key: "terminalsConnection", width: 44 },
    { header: "Standards", key: "standards", width: 36 },
    { header: "Product Family / Class", key: "productFamily", width: 40 },
    { header: "Suitable For", key: "suitableFor", width: 36 },
    { header: "Tariff Code (HS)", key: "tariffCode", width: 18 },
    { header: "Country of Origin", key: "countryOfOrigin", width: 18 },
    { header: "Key Specifications", key: "keySpecifications", width: 90 },
    { header: "Electrical Ratings", key: "electricalRatings", width: 90 },
    { header: "Mechanical / Installation", key: "mechanicalInstallation", width: 84 },
    { header: "Compliance / Standards", key: "complianceStandards", width: 84 },
    { header: "Lifecycle / Commercial", key: "lifecycleCommercial", width: 80 },
    { header: "Downloads", key: "downloads", width: 84 },
    { header: "All Resources", key: "allResources", width: 100 },
    { header: "All Specifications", key: "allSpecifications", width: 120 },
    { header: "Attribute Count", key: "attributeCount", width: 16 },
    { header: "Document Count", key: "documentCount", width: 16 },
    { header: "Image Count", key: "imageCount", width: 12 },
    { header: "Quality Gate Passed", key: "qualityPassed", width: 18 },
    { header: "Quality Score", key: "qualityScore", width: 14 },
    { header: "Quality Missing", key: "qualityMissing", width: 56 },
    { header: "Final Completeness Check", key: "finalCompletenessCheck", width: 64 },
    { header: "Missing Required Fields", key: "missingRequiredFields", width: 48 },
    { header: "Error", key: "error", width: 56 }
  ];

  products.columns = [
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Short Name", key: "shortName", width: 12 },
    { header: "Status", key: "status", width: 12 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Title", key: "title", width: 42 },
    { header: "Product Type", key: "productType", width: 30 },
    { header: "Device Type", key: "deviceType", width: 30 },
    { header: "Device Type Confidence", key: "deviceTypeConfidence", width: 20, style: { numFmt: "0%" } },
    { header: "Device Type Evidence", key: "deviceTypeEvidence", width: 54 },
    { header: "Copy Summary", key: "copySummary", width: 110 },
    { header: "Voltage", key: "voltage", width: 22 },
    { header: "Current", key: "current", width: 22 },
    { header: "Current Type", key: "currentType", width: 14 },
    { header: "Rated Current", key: "ratedCurrent", width: 18 },
    { header: "Material", key: "material", width: 30 },
    { header: "Certificates", key: "certificates", width: 38 },
    { header: "ECLASS", key: "eclass", width: 24 },
    { header: "Weight", key: "weight", width: 20 },
    { header: "Weight (kg)", key: "weightKg", width: 14, style: { numFmt: "0.#########" } },
    { header: "Weight (lb)", key: "weightLb", width: 14, style: { numFmt: "0.#########" } },
    { header: "Dimensions", key: "dimensions", width: 34 },
    { header: "Height (mm)", key: "heightMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Width (mm)", key: "widthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Depth (mm)", key: "depthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Length (mm)", key: "lengthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Protection", key: "protection", width: 28 },
    { header: "IP Rating", key: "ipRating", width: 18 },
    { header: "Description", key: "description", width: 56 },
    { header: "EAN / GTIN", key: "ean", width: 20 },
    { header: "Key Specifications", key: "keySpecifications", width: 82 },
    { header: "Electrical Ratings", key: "electricalRatings", width: 82 },
    { header: "Mechanical / Installation", key: "mechanicalInstallation", width: 76 },
    { header: "Compliance / Standards", key: "complianceStandards", width: 76 },
    { header: "Lifecycle / Commercial", key: "lifecycleCommercial", width: 72 },
    { header: "Accessories / Related Parts", key: "accessoriesRelated", width: 82 },
    { header: "Downloads", key: "downloads", width: 76 },
    { header: "All Resources", key: "allResources", width: 100 },
    { header: "Image", key: "image", width: 16 },
    { header: "Image Local Path", key: "imageLocalPath", width: 60 },
    { header: "Image URL", key: "imageUrl", width: 60 },
    { header: "Image Count", key: "imageCount", width: 12 },
    { header: "All Image URLs", key: "allImageUrls", width: 100 },
    { header: "Product URL EN", key: "productUrlEn", width: 60 },
    { header: "Product URL DE", key: "productUrlDe", width: 60 },
    { header: "Product URL Source", key: "productUrl", width: 60 },
    { header: "Height (in)", key: "heightIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Width (in)", key: "widthIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Depth (in)", key: "depthIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Length (in)", key: "lengthIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Wall Thickness (in)", key: "wallThicknessIn", width: 20, style: { numFmt: "0.#########" } },
    { header: "Wall Thickness (mm)", key: "wallThicknessMm", width: 20, style: { numFmt: "0.#########" } },
    { header: "Finish", key: "finish", width: 46 },
    { header: "Color", key: "color", width: 28 },
    { header: "Voltage AC", key: "voltageAc", width: 18 },
    { header: "Voltage DC", key: "voltageDc", width: 18 },
    { header: "Voltage Range", key: "voltageRange", width: 22 },
    { header: "Operating Voltage Ub / Ur", key: "operatingVoltageUb", width: 26 },
    { header: "Current AC", key: "currentAc", width: 18 },
    { header: "Current DC", key: "currentDc", width: 18 },
    { header: "Current Sum US (sensor)", key: "currentSumUs", width: 24 },
    { header: "Current Sum UA (actuator)", key: "currentSumUa", width: 26 },
    { header: "Standards", key: "standards", width: 28 },
    { header: "Product Family / Class", key: "productFamily", width: 36 },
    { header: "Suitable For", key: "suitableFor", width: 36 },
    { header: "Replaced Product ID", key: "replacedProductId", width: 24 },
    { header: "Tariff Code (HS)", key: "tariffCode", width: 18 },
    { header: "Country of Origin", key: "countryOfOrigin", width: 18 },
    { header: "NEMA / Type Rating", key: "nemaRating", width: 24 },
    { header: "IK Rating", key: "ikRating", width: 16 },
    { header: "Frequency", key: "frequency", width: 34 },
    { header: "Phase", key: "phase", width: 24 },
    { header: "Poles", key: "poles", width: 24 },
    { header: "Terminals / Connection", key: "terminalsConnection", width: 48 },
    { header: "Mounting", key: "mounting", width: 46 },
    { header: "Operating Temperature", key: "operatingTemperature", width: 44 },
    { header: "Wire / Cable Size", key: "wireCableSize", width: 44 },
    { header: "Thread Size", key: "threadSize", width: 28 },
    { header: "All Specifications", key: "allSpecifications", width: 100 },
    { header: "Page Attribute Count", key: "attributeCount", width: 18 },
    { header: "Document Count", key: "documentCount", width: 14 },
    { header: "Quality Gate Passed", key: "qualityPassed", width: 18 },
    { header: "Quality Score", key: "qualityScore", width: 14 },
    { header: "Quality Missing", key: "qualityMissing", width: 48 },
    { header: "Fallback Stages", key: "fallbackStages", width: 32 },
    { header: "Final Completeness Check", key: "finalCompletenessCheck", width: 56 },
    { header: "Missing Required Fields", key: "missingRequiredFields", width: 42 },
    { header: "Unmapped Spec Labels", key: "unmappedSpecLabels", width: 42 },
    { header: "Error", key: "error", width: 40 }
  ];

  attributes.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Group", key: "group", width: 28 },
    { header: "Attribute", key: "name", width: 34 },
    { header: "Value", key: "value", width: 72 },
    { header: "Unit", key: "unit", width: 12 },
    { header: "Source Type", key: "sourceType", width: 18 },
    { header: "Parser", key: "parser", width: 26 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Source URL", key: "sourceUrl", width: 60 }
  ];

  technicalAttributes.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Canonical Key", key: "canonicalKey", width: 26 },
    { header: "Canonical Label", key: "canonicalLabel", width: 34 },
    { header: "Match Type", key: "matchType", width: 24 },
    { header: "Matched Alias", key: "matchedAlias", width: 42 },
    { header: "Alias Manufacturer", key: "matchedAliasManufacturerId", width: 18 },
    { header: "Match Score", key: "matchScore", width: 12, style: { numFmt: "0.000" } },
    { header: "Original Group", key: "originalGroup", width: 28 },
    { header: "Original Attribute", key: "originalName", width: 38 },
    { header: "Original Value", key: "originalValue", width: 72 },
    { header: "Unit Kind", key: "unitKind", width: 14 },
    { header: "Parsed Quantities", key: "quantities", width: 50 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Reason", key: "reason", width: 50 },
    { header: "Source Type", key: "sourceType", width: 18 },
    { header: "Parser", key: "parser", width: 26 },
    { header: "Stage", key: "stage", width: 20 },
    { header: "Source URL", key: "sourceUrl", width: 60 }
  ];

  aliasDictionary.columns = [
    { header: "Canonical Key", key: "canonicalKey", width: 26 },
    { header: "Scope", key: "scope", width: 14 },
    { header: "Manufacturer", key: "manufacturer", width: 22 },
    { header: "Manufacturer ID", key: "manufacturerId", width: 16 },
    { header: "Manufacturer Label", key: "originalName", width: 58 },
    { header: "Evidence", key: "evidenceLabel", width: 34 },
    { header: "Evidence URL", key: "evidenceUrl", width: 76 },
    { header: "Note", key: "note", width: 50 }
  ];
  for (const alias of listTechnicalAttributeAliases()) {
    aliasDictionary.addRow({
      canonicalKey: alias.canonicalKey,
      scope: alias.scope,
      manufacturer: alias.manufacturerName,
      manufacturerId: alias.manufacturerId,
      originalName: alias.originalName,
      evidenceLabel: alias.evidenceLabel,
      evidenceUrl: alias.evidenceUrl,
      note: alias.note
    });
  }

  documents.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Type", key: "type", width: 14 },
    { header: "Label", key: "label", width: 42 },
    { header: "URL", key: "url", width: 60 },
    { header: "Candidate URLs", key: "candidateUrls", width: 70 },
    { header: "Local Path", key: "localPath", width: 60 },
    { header: "Download Status", key: "downloadStatus", width: 18 },
    { header: "Download Error", key: "downloadError", width: 48 },
    { header: "Parse Status", key: "parseStatus", width: 16 },
    { header: "Parse Error", key: "parseError", width: 48 },
    { header: "Source Type", key: "sourceType", width: 18 },
    { header: "Parser", key: "parser", width: 26 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Source URL", key: "sourceUrl", width: 60 }
  ];

  sources.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Source Type", key: "sourceType", width: 18 },
    { header: "Parser", key: "parser", width: 26 },
    { header: "Stage", key: "stage", width: 20 },
    { header: "Reason", key: "reason", width: 36 },
    { header: "Status Code", key: "statusCode", width: 14 },
    { header: "Fetched At", key: "fetchedAt", width: 26 },
    { header: "URL", key: "url", width: 70 }
  ];

  evidence.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Kind", key: "kind", width: 14 },
    { header: "Name", key: "name", width: 34 },
    { header: "Value", key: "value", width: 72 },
    { header: "URL", key: "url", width: 60 },
    { header: "Source URL", key: "sourceUrl", width: 60 },
    { header: "Source Type", key: "sourceType", width: 18 },
    { header: "Parser", key: "parser", width: 24 },
    { header: "Stage", key: "stage", width: 20 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Reason", key: "reason", width: 42 }
  ];

  finalAudit.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Field", key: "field", width: 18 },
    { header: "Status", key: "status", width: 22 },
    { header: "Requirement", key: "requirement", width: 16 },
    { header: "Before Value", key: "beforeValue", width: 42 },
    { header: "After Value", key: "afterValue", width: 42 },
    { header: "Action", key: "action", width: 28 },
    { header: "Reason", key: "reason", width: 64 },
    { header: "Network Retry", key: "networkRetry", width: 18 },
    { header: "Tried Stages", key: "triedStages", width: 36 },
    { header: "Untried Stages", key: "untriedStages", width: 36 },
    { header: "Checked At", key: "checkedAt", width: 26 }
  ];

  failures.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Status", key: "status", width: 12 },
    { header: "Error", key: "error", width: 80 }
  ];

  const productRows: ProductExportRow[] = [];

  for (const item of input.items) {
    const result = item.result;
    const rowData = productRow(input.manufacturer, item, result);
    productRows.push(rowData);
    lookup.addRow(lookupRow(rowData, result));
    const productExcelRow = products.addRow(rowData);
    await addProductThumbnail(workbook, products, productExcelRow, result);
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
        sourceType: attr.sourceType,
        parser: attr.parser,
        confidence: attr.confidence,
        sourceUrl: attr.sourceUrl
      });
    }
    for (const attr of result.technicalAttributes ?? []) {
      technicalAttributes.addRow({
        manufacturer: input.manufacturer.canonicalName,
        catalogNumber: result.catalogNumber,
        canonicalKey: attr.canonicalKey,
        canonicalLabel: attr.canonicalLabel,
        matchType: attr.matchType,
        matchedAlias: attr.matchedAlias,
        matchedAliasManufacturerId: attr.matchedAliasManufacturerId,
        matchScore: attr.matchScore,
        originalGroup: attr.originalGroup,
        originalName: attr.originalName,
        originalValue: attr.originalValue,
        unitKind: attr.unitKind,
        quantities: formatTechnicalQuantities(attr.quantities),
        confidence: attr.confidence,
        reason: attr.reason,
        sourceType: attr.sourceType,
        parser: attr.parser,
        stage: attr.stage,
        sourceUrl: attr.sourceUrl
      });
    }
    for (const doc of documentsForExport(result)) {
      documents.addRow({
        manufacturer: input.manufacturer.canonicalName,
        catalogNumber: result.catalogNumber,
        type: doc.type,
        label: doc.label,
        url: doc.url,
        candidateUrls: doc.candidateUrls?.join("; "),
        localPath: doc.localPath,
        downloadStatus: doc.downloadStatus,
        downloadError: doc.downloadError,
        parseStatus: doc.parseStatus,
        parseError: doc.parseError,
        sourceType: doc.sourceType,
        parser: doc.parser,
        confidence: doc.confidence,
        sourceUrl: doc.sourceUrl
      });
    }
    for (const source of result.sources) {
      sources.addRow({
        manufacturer: input.manufacturer.canonicalName,
        catalogNumber: result.catalogNumber,
        sourceType: source.sourceType,
        parser: source.parser,
        stage: source.stage,
        reason: source.reason,
        statusCode: source.statusCode,
        fetchedAt: source.fetchedAt,
        url: source.url
      });
    }
    for (const record of result.evidence ?? []) {
      evidence.addRow({
        manufacturer: input.manufacturer.canonicalName,
        catalogNumber: result.catalogNumber,
        kind: record.kind,
        name: record.name,
        value: record.value,
        url: record.url,
        sourceUrl: record.sourceUrl,
        sourceType: record.sourceType,
        parser: record.parser,
        stage: record.stage,
        confidence: record.confidence,
        reason: record.reason
      });
    }
    const audit = result.diagnostics?.finalCompleteness;
    if (audit) {
      for (const record of audit.records ?? []) {
        finalAudit.addRow({
          manufacturer: input.manufacturer.canonicalName,
          catalogNumber: result.catalogNumber,
          field: record.field,
          status: record.status,
          requirement: record.requirement,
          beforeValue: record.beforeValue,
          afterValue: record.afterValue,
          action: record.action,
          reason: record.reason,
          networkRetry: audit.networkRetry ? (audit.networkRetry.attempted ? "attempted" : "skipped") : undefined,
          triedStages: audit.networkRetry?.triedStages?.join("; "),
          untriedStages: audit.networkRetry?.untriedStages?.join("; "),
          checkedAt: audit.checkedAt
        });
      }
    }
  }

  await input.onActivity?.({ stage: "cleaned-input", message: "Preparing cleaned PDT input sheet." });
  const aiCleanup = await buildPdtRepairResult(
    input.items.filter((item) => item.result && (item.status === "found" || item.status === "partial")),
    input.manufacturer,
    {
      aiCleanup: process.env.PDT_AI_CLEANUP === "1",
      onProgress: (progress) =>
        input.onActivity?.({
          stage: progress.stage === "qwen-batch" ? "qwen-cleanup" : progress.stage,
          message: progress.message
        })
    }
  );
  await input.onActivity?.({ stage: "cleaned-input-review", message: "Writing cleaned PDT input sheet." });
  writeAiCleanedInputSheet(aiCleanedInput, aiCleanup.audit);

  populateRunSummarySheet(summary, input, productRows);
  styleRunSummarySheet(summary);
  populateCleanExportSheet(cleanExport, input.items, productRows);
  populateCleanExportSheet(importReady, input.items, productRows, { decisions: ["Import"] });
  populateNeedsReviewSheet(needsReview, input.items, productRows);
  populateIssueSummarySheet(issueSummary, productRows);
  populateColumnGuideSheet(columnGuide);
  populateCleanAttributesSheet(cleanAttributes, input);
  populateCleanDocumentsSheet(cleanDocuments, input);
  populateFieldCoverageSheet(fieldCoverage, input.items, productRows);
  populateSpecMatrixSheet(specMatrix, input.items, productRows);
  populateChecksSheet(checks, productRows);

  const dataSheets = [
    cleanExport,
    importReady,
    needsReview,
    issueSummary,
    columnGuide,
    cleanAttributes,
    cleanDocuments,
    fieldCoverage,
    specMatrix,
    checks,
    lookup,
    products,
    attributes,
    technicalAttributes,
    aliasDictionary,
    documents,
    sources,
    evidence,
    finalAudit,
    failures
  ];
  await input.onActivity?.({ stage: "workbook-style", message: "Styling workbook sheets." });
  for (const sheet of dataSheets) {
    styleSheet(sheet);
    applyUsabilityFormatting(sheet);
  }
  applyWorkbookUsability(workbook);

  const inputNamePart = input.run.inputFileName ? safeWorkbookPart(path.parse(input.run.inputFileName).name) : "";
  const outputName = [
    safeWorkbookPart(input.manufacturer.shortName),
    inputNamePart,
    `product-scrape-${input.run.id}`
  ].filter(Boolean).join(".");
  const outputPath = path.join(input.outputDir, `${outputName}.xlsx`);
  await input.onActivity?.({ stage: "workbook-write", message: "Writing Excel workbook to disk." });
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

type ProductExportRow = ReturnType<typeof productRow>;

function formatTechnicalQuantities(quantities: NonNullable<ProductResult["technicalAttributes"]>[number]["quantities"]): string | undefined {
  if (!quantities?.length) return undefined;
  return quantities
    .map((quantity) => {
      const value =
        quantity.value !== undefined
          ? String(quantity.value)
          : quantity.min !== undefined || quantity.max !== undefined
            ? `${quantity.min ?? ""}...${quantity.max ?? ""}`
            : quantity.values?.join("/");
      return [quantity.kind, value ? `${value}${quantity.unit ? ` ${quantity.unit}` : ""}` : undefined, quantity.currentType, quantity.condition]
        .filter(Boolean)
        .join(" ");
    })
    .join("; ");
}

function populateRunSummarySheet(
  sheet: ExcelJS.Worksheet,
  input: {
    run: RunRecord;
    manufacturer: ManufacturerConfig;
    items: RunItemRecord[];
    outputDir: string;
  },
  productRows: ProductExportRow[]
) {
  sheet.columns = [
    { key: "metric", width: 30 },
    { key: "value", width: 26 },
    { key: "detail", width: 44 },
    { key: "link", width: 26 }
  ];
  sheet.mergeCells("A1:D1");
  sheet.getCell("A1").value = `${input.manufacturer.canonicalName} scrape summary`;
  sheet.getCell("A2").value = "Generated workbook overview";
  sheet.getCell("B2").value = new Date().toISOString();

  let row = 4;
  row = addSummarySection(sheet, row, "Run");
  row = addSummaryMetric(sheet, row, "Run ID", input.run.id);
  row = addSummaryMetric(sheet, row, "Input file", input.run.inputFileName ?? "Manual input");
  row = addSummaryMetric(sheet, row, "Created", input.run.createdAt);
  row = addSummaryMetric(sheet, row, "Updated", input.run.updatedAt);
  row = addSummaryMetric(sheet, row, "Output folder", input.outputDir);

  const statusCounts = countValues(productRows.map((item) => String(item.status ?? "unknown")));
  const documents = input.items.flatMap((item) => documentsForExport(item.result));
  const documentCounts = countValues(documents.map((doc) => doc.type));
  const missingCounts = countValues(productRows.flatMap((item) => splitSummaryList(item.missingRequiredFields)));
  const coverage = productRows.map(fieldCoverageForRow);
  const reviewQueue = reviewQueueItems(productRows);
  const reviewCount = reviewQueue.length;
  const reviewPriorityCounts = countValues(reviewQueue.map((item) => item.priorityLabel));
  const averageCoverage = coverage.length ? coverage.reduce((sum, item) => sum + item.score, 0) / coverage.length : 0;
  const readiness = workbookReadiness(productRows, reviewQueue);

  row = addSummarySection(sheet, row, "Readiness");
  row = addSummaryMetric(sheet, row, "Workbook status", readiness.status, readiness.detail);
  row = addSummaryMetric(sheet, row, "Recommended next step", readiness.nextStep);
  row = addSummaryMetric(sheet, row, "Import ready rows", readiness.importReadyCount, `${readiness.totalRows} total rows`, internalSheetHyperlink("Import Ready"));
  row = addSummaryMetric(sheet, row, "Review rows", reviewCount, readiness.reviewDetail, reviewCount ? internalSheetHyperlink("Needs Review") : internalSheetHyperlink("Clean Export"));
  row = addSummaryMetric(sheet, row, "Ready-only export tab", "Import Ready", "Use this sheet when importing only rows with no review blockers.", internalSheetHyperlink("Import Ready"));
  row = addSummaryMetric(sheet, row, "Full clean export tab", "Clean Export", "Use this sheet when you need all rows with import/review/exclude decisions.", internalSheetHyperlink("Clean Export"));

  row += 1;
  row = addSummarySection(sheet, row, "Decision legend");
  row = addSummaryMetric(sheet, row, "Import", "Ready", "Row has no blocking review reason; use it from Clean Export.");
  row = addSummaryMetric(sheet, row, "Review", "Check first", "Row has usable data, but one or more fields should be verified.");
  row = addSummaryMetric(sheet, row, "Exclude", "Do not import", "Row failed or was cancelled; rerun or fix manually before import.");

  row += 1;
  row = addSummarySection(sheet, row, "Results");
  row = addSummaryMetric(sheet, row, "Total rows", input.run.total || productRows.length);
  row = addSummaryMetric(sheet, row, "Found", statusCounts.get("found") ?? input.run.found ?? 0);
  row = addSummaryMetric(sheet, row, "Partial", statusCounts.get("partial") ?? input.run.partial ?? 0);
  row = addSummaryMetric(sheet, row, "Failed", statusCounts.get("failed") ?? input.run.failed ?? 0);
  row = addSummaryMetric(sheet, row, "Quality passed", productRows.filter((item) => item.qualityPassed === true).length);
  row = addSummaryMetric(sheet, row, "Quality failed", productRows.filter((item) => item.qualityPassed === false).length);
  row = addSummaryMetric(sheet, row, "Import ready", productRows.filter((item) => !reviewReason(item)).length);
  row = addSummaryMetric(sheet, row, "Needs review", reviewCount);
  row = addSummaryMetric(sheet, row, "High priority review", reviewPriorityCounts.get("High") ?? 0);
  row = addSummaryMetric(sheet, row, "Medium priority review", reviewPriorityCounts.get("Medium") ?? 0);
  row = addSummaryMetric(sheet, row, "Low priority review", reviewPriorityCounts.get("Low") ?? 0);
  row = addSummaryMetric(sheet, row, "Average coverage", `${Math.round(averageCoverage * 100)}%`);
  row = addSummaryMetric(sheet, row, "Rows with missing fields", productRows.filter((item) => item.missingRequiredFields).length);
  row = addSummaryMetric(sheet, row, "Attributes", productRows.reduce((sum, item) => sum + Number(item.attributeCount ?? 0), 0));
  row = addSummaryMetric(sheet, row, "Documents", documents.length);
  row = addSummaryMetric(sheet, row, "Images", documents.filter((doc) => doc.type === "image").length);

  row += 1;
  row = addSummarySection(sheet, row, "Document mix");
  for (const [type, count] of sortedCountEntries(documentCounts)) {
    row = addSummaryMetric(sheet, row, documentTypeLabel(type as ProductResult["documents"][number]["type"]), count);
  }
  if (documentCounts.size === 0) row = addSummaryMetric(sheet, row, "None", 0);

  row += 1;
  row = addSummarySection(sheet, row, "Most common missing fields");
  for (const [field, count] of sortedCountEntries(missingCounts).slice(0, 12)) {
    row = addSummaryMetric(sheet, row, field, count);
  }
  if (missingCounts.size === 0) row = addSummaryMetric(sheet, row, "None", 0);

  row += 1;
  row = addSummarySection(sheet, row, "Top review queue");
  for (const [index, item] of reviewQueue.slice(0, 10).entries()) {
    row = addSummaryMetric(sheet, row, item.row.catalogNumber, item.priorityLabel, item.reason, internalSheetHyperlink("Needs Review", index + 2));
  }
  if (reviewQueue.length === 0) row = addSummaryMetric(sheet, row, "None", 0);

  row += 1;
  row = addSummarySection(sheet, row, "Top issue types");
  for (const issue of issueSummaryRows(productRows).slice(0, 8)) {
    row = addSummaryMetric(sheet, row, issue.issueType, issue.rows, `${issue.severity} priority`, internalSheetHyperlink("Issue Summary", issue.sheetRow));
  }
  if (issueSummaryRows(productRows).length === 0) row = addSummaryMetric(sheet, row, "None", 0);

  row += 1;
  row = addSummarySection(sheet, row, "Sheets");
  for (const sheetName of [
    "Clean Export",
    "Import Ready",
    AI_CLEANED_INPUT_SHEET,
    "Needs Review",
    "Issue Summary",
    "Column Guide",
    "Clean Attributes",
    "Clean Documents",
    "Field Coverage",
    "Spec Matrix",
    "Checks",
    "XLOOKUP",
    "Products",
    "Attributes",
    "Technical Attributes",
    "Alias Dictionary",
    "Documents",
    "Sources",
    "Evidence",
    "Final Audit",
    "Failures"
  ]) {
    row = addSummaryMetric(sheet, row, sheetName, "Open", sheetPurpose(sheetName), `#'${sheetName.replace(/'/g, "''")}'!A1`);
  }
}

function sheetPurpose(sheetName: string): string {
  const purposes: Record<string, string> = {
    "Clean Export": "Primary product export with import decisions, clean fields, and core URLs.",
    "Import Ready": "Ready-only product export containing rows marked Import.",
    [AI_CLEANED_INPUT_SHEET]: "Qwen-prepared scraped-data sheet for human review; final PDT generation does not consume these suggestions.",
    "Needs Review": "Prioritized queue for rows that should be checked before import.",
    "Issue Summary": "Aggregated QA view of review blockers and affected catalog numbers.",
    "Column Guide": "Data dictionary for key workbook sheets and workflow columns.",
    "Clean Attributes": "User-facing attribute list without noisy metadata fields.",
    "Clean Documents": "Document URLs, local paths, document readiness, and primary document markers.",
    "Field Coverage": "Per-row field completeness and missing-field diagnostics.",
    "Spec Matrix": "Wide comparison matrix for technical product specs.",
    "Checks": "Workbook-level warnings such as duplicates, failed rows, and missing key assets.",
    "XLOOKUP": "Single-line lookup-friendly row set for formulas and external matching.",
    "Products": "Raw rich product rows with summaries, images, measurements, and diagnostics.",
    "Attributes": "Raw extracted attributes with source metadata.",
    "Technical Attributes": "Canonical map of original manufacturer spec names to standard technical properties.",
    "Alias Dictionary": "Known manufacturer-specific aliases and evidence links for canonical technical properties.",
    "Documents": "Raw document records with download and parse metadata.",
    "Sources": "Fetched source URLs and scrape stages.",
    "Evidence": "Normalized field evidence used to support exported values.",
    "Final Audit": "Final completeness check records and retry decisions.",
    "Failures": "Rows that failed or did not produce a usable product result."
  };
  return purposes[sheetName] ?? "Supporting workbook data.";
}

function populateCleanExportSheet(
  sheet: ExcelJS.Worksheet,
  items: RunItemRecord[],
  productRows: ProductExportRow[],
  options: { decisions?: Array<ReturnType<typeof exportDecision>> } = {}
) {
  const reviewRows = reviewRowByProductIndex(productRows);
  sheet.columns = [
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Status", key: "status", width: 12 },
    { header: "Export Decision", key: "exportDecision", width: 16 },
    { header: "Import Ready", key: "importReady", width: 14 },
    { header: "Review Link", key: "reviewLink", width: 14 },
    { header: "Action Needed", key: "actionNeeded", width: 46 },
    { header: "Coverage Score", key: "coverageScore", width: 16, style: { numFmt: "0%" } },
    { header: "Confidence", key: "confidence", width: 12, style: { numFmt: "0%" } },
    { header: "Quality Tier", key: "qualityTier", width: 14 },
    { header: "Missing Key Fields", key: "missingKeyFields", width: 42 },
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Product Type", key: "productType", width: 32 },
    { header: "Title", key: "title", width: 46 },
    { header: "Product URL EN", key: "productUrlEn", width: 60 },
    { header: "Product URL DE", key: "productUrlDe", width: 60 },
    { header: "Image URL", key: "imageUrl", width: 60 },
    { header: "Primary Datasheet URL", key: "primaryDatasheetUrl", width: 64 },
    { header: "Primary Manual URL", key: "primaryManualUrl", width: 64 },
    { header: "Primary CAD URL", key: "primaryCadUrl", width: 64 },
    { header: "Primary Certificate URL", key: "primaryCertificateUrl", width: 64 },
    { header: "Datasheet URLs", key: "datasheetUrls", width: 76 },
    { header: "Manual URLs", key: "manualUrls", width: 76 },
    { header: "CAD URLs", key: "cadUrls", width: 76 },
    { header: "Certificate URLs", key: "certificateUrls", width: 76 },
    { header: "Weight (kg)", key: "weightKg", width: 14, style: { numFmt: "0.#########" } },
    { header: "Height (mm)", key: "heightMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Width (mm)", key: "widthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Depth (mm)", key: "depthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Length (mm)", key: "lengthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Material", key: "material", width: 30 },
    { header: "Finish", key: "finish", width: 34 },
    { header: "Color", key: "color", width: 22 },
    { header: "Voltage", key: "voltage", width: 24 },
    { header: "Current", key: "current", width: 24 },
    { header: "Rated Current", key: "ratedCurrent", width: 20 },
    { header: "IP Rating", key: "ipRating", width: 16 },
    { header: "Protection", key: "protection", width: 24 },
    { header: "Terminals / Connection", key: "terminalsConnection", width: 44 },
    { header: "Mounting", key: "mounting", width: 36 },
    { header: "Operating Temperature", key: "operatingTemperature", width: 36 },
    { header: "Certificates", key: "certificates", width: 36 },
    { header: "Tariff Code (HS)", key: "tariffCode", width: 18 },
    { header: "Country of Origin", key: "countryOfOrigin", width: 18 },
    { header: "Missing Required Fields", key: "missingRequiredFields", width: 42 },
    { header: "Review Reason", key: "reviewReason", width: 44 },
    { header: "Error", key: "error", width: 42 }
  ];

  for (const [index, row] of productRows.entries()) {
    const lookup = lookupRow(row, items[index]?.result);
    const coverage = fieldCoverageForRow(row);
    const reviewRowNumber = reviewRows.get(index);
    const reason = reviewReason(row);
    const decision = exportDecision(row);
    if (options.decisions && !options.decisions.includes(decision)) continue;
    sheet.addRow({
      catalogNumber: row.catalogNumber,
      status: row.status,
      exportDecision: decision,
      importReady: reason ? "No" : "Yes",
      reviewLink: reviewRowNumber ? { text: "Review", hyperlink: internalSheetHyperlink("Needs Review", reviewRowNumber), tooltip: "Open Needs Review row" } : undefined,
      actionNeeded: reviewSuggestedAction(row) ?? "Ready",
      coverageScore: coverage.score,
      confidence: row.confidence,
      qualityTier: qualityTier(coverage.score),
      missingKeyFields: coverage.missing.join("; ") || undefined,
      manufacturer: row.manufacturer,
      productType: row.productType,
      title: row.title,
      productUrlEn: row.productUrlEn,
      productUrlDe: row.productUrlDe,
      imageUrl: row.imageUrl,
      primaryDatasheetUrl: lookup.primaryDatasheetUrl,
      primaryManualUrl: lookup.primaryManualUrl,
      primaryCadUrl: lookup.primaryCadUrl,
      primaryCertificateUrl: lookup.primaryCertificateUrl,
      datasheetUrls: lookup.datasheetUrls,
      manualUrls: lookup.manualUrls,
      cadUrls: lookup.cadUrls,
      certificateUrls: lookup.certificateUrls,
      weightKg: row.weightKg,
      heightMm: row.heightMm,
      widthMm: row.widthMm,
      depthMm: row.depthMm,
      lengthMm: row.lengthMm,
      material: row.material,
      finish: row.finish,
      color: row.color,
      voltage: row.voltage,
      current: row.current,
      ratedCurrent: row.ratedCurrent,
      ipRating: row.ipRating,
      protection: row.protection,
      terminalsConnection: row.terminalsConnection,
      mounting: row.mounting,
      operatingTemperature: row.operatingTemperature,
      certificates: row.certificates,
      tariffCode: row.tariffCode,
      countryOfOrigin: row.countryOfOrigin,
      missingRequiredFields: row.missingRequiredFields,
      reviewReason: reviewReason(row),
      error: row.error
    });
  }
}

function populateNeedsReviewSheet(sheet: ExcelJS.Worksheet, items: RunItemRecord[], productRows: ProductExportRow[]) {
  sheet.columns = [
    { header: "Review Priority", key: "reviewPriority", width: 16 },
    { header: "Priority Score", key: "priorityScore", width: 14 },
    { header: "Review Status", key: "reviewStatus", width: 20 },
    { header: "Fix Needed", key: "fixNeeded", width: 14 },
    { header: "Reviewed By", key: "reviewedBy", width: 20 },
    { header: "Review Notes", key: "reviewNotes", width: 54 },
    { header: "Review Reason", key: "reviewReason", width: 46 },
    { header: "Issue Type", key: "issueType", width: 30 },
    { header: "Suggested Action", key: "suggestedAction", width: 54 },
    { header: "Clean Export", key: "cleanExportLink", width: 14 },
    { header: "Products", key: "productsLink", width: 12 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Status", key: "status", width: 12 },
    { header: "Coverage Score", key: "coverageScore", width: 16, style: { numFmt: "0%" } },
    { header: "Confidence", key: "confidence", width: 12, style: { numFmt: "0%" } },
    { header: "Product Type", key: "productType", width: 32 },
    { header: "Missing Required Fields", key: "missingRequiredFields", width: 48 },
    { header: "Quality Missing", key: "qualityMissing", width: 48 },
    { header: "Final Completeness Check", key: "finalCompletenessCheck", width: 56 },
    { header: "Product URL EN", key: "productUrlEn", width: 60 },
    { header: "Primary Datasheet URL", key: "primaryDatasheetUrl", width: 64 },
    { header: "Datasheet URLs", key: "datasheetUrls", width: 76 },
    { header: "Error", key: "error", width: 56 }
  ];

  for (const { row, index, reason, coverage, priorityScore, priorityLabel } of reviewQueueItems(productRows)) {
    const lookup = lookupRow(row, items[index]?.result);
    sheet.addRow({
      reviewPriority: priorityLabel,
      priorityScore,
      reviewStatus: "Open",
      fixNeeded: priorityScore >= 30 ? "Yes" : "Maybe",
      reviewReason: reason,
      issueType: reviewIssueType(row),
      suggestedAction: reviewSuggestedAction(row),
      cleanExportLink: { text: "Open", hyperlink: internalSheetHyperlink("Clean Export", index + 2), tooltip: "Open matching Clean Export row" },
      productsLink: { text: "Open", hyperlink: internalSheetHyperlink("Products", index + 2), tooltip: "Open matching Products row" },
      catalogNumber: row.catalogNumber,
      status: row.status,
      coverageScore: coverage.score,
      confidence: row.confidence,
      productType: row.productType,
      missingRequiredFields: row.missingRequiredFields,
      qualityMissing: row.qualityMissing,
      finalCompletenessCheck: row.finalCompletenessCheck,
      productUrlEn: row.productUrlEn,
      primaryDatasheetUrl: lookup.primaryDatasheetUrl,
      datasheetUrls: lookup.datasheetUrls,
      error: row.error
    });
  }
}

function populateIssueSummarySheet(sheet: ExcelJS.Worksheet, productRows: ProductExportRow[]) {
  sheet.columns = [
    { header: "Issue Type", key: "issueType", width: 32 },
    { header: "Severity", key: "severity", width: 12 },
    { header: "Rows", key: "rows", width: 10 },
    { header: "High Priority Rows", key: "highPriorityRows", width: 18 },
    { header: "Medium Priority Rows", key: "mediumPriorityRows", width: 20 },
    { header: "Low Priority Rows", key: "lowPriorityRows", width: 16 },
    { header: "Affected Catalog Numbers", key: "catalogNumbers", width: 72 },
    { header: "Suggested Action", key: "suggestedAction", width: 56 },
    { header: "Needs Review", key: "needsReviewLink", width: 14 }
  ];

  const issues = issueSummaryRows(productRows);
  for (const issue of issues) {
    sheet.addRow({
      issueType: issue.issueType,
      severity: issue.severity,
      rows: issue.rows,
      highPriorityRows: issue.highPriorityRows || undefined,
      mediumPriorityRows: issue.mediumPriorityRows || undefined,
      lowPriorityRows: issue.lowPriorityRows || undefined,
      catalogNumbers: issue.catalogNumbers,
      suggestedAction: issue.suggestedAction,
      needsReviewLink: { text: "Open", hyperlink: internalSheetHyperlink("Needs Review", issue.firstReviewRow), tooltip: "Open first matching review row" }
    });
  }

  if (!issues.length) {
    sheet.addRow({
      issueType: "No issues",
      severity: "Info",
      rows: 0,
      suggestedAction: "Use Import Ready as the direct-import product export.",
      needsReviewLink: { text: "Open", hyperlink: internalSheetHyperlink("Import Ready"), tooltip: "Open Import Ready" }
    });
  }
}

function populateColumnGuideSheet(sheet: ExcelJS.Worksheet) {
  sheet.columns = [
    { header: "Sheet", key: "sheet", width: 20 },
    { header: "Column / Area", key: "column", width: 28 },
    { header: "Purpose", key: "purpose", width: 62 },
    { header: "Use For", key: "useFor", width: 36 },
    { header: "Notes", key: "notes", width: 66 }
  ];

  const rows = [
    {
      sheet: "Import Ready",
      column: "All rows",
      purpose: "Ready-only product export containing rows marked Import.",
      useFor: "Direct import",
      notes: "Start here when you only want rows without review blockers."
    },
    {
      sheet: "Clean Export",
      column: "All rows",
      purpose: "Clean product export with every row and an explicit export decision.",
      useFor: "Full export / QA handoff",
      notes: "Use this sheet when you need to see Import, Review, and Exclude rows together."
    },
    {
      sheet: "Clean Export",
      column: "Export Decision",
      purpose: "Classifies each row as Import, Review, or Exclude.",
      useFor: "Filtering",
      notes: "Import means no blocking review reason; Review means check first; Exclude means failed or cancelled."
    },
    {
      sheet: "Clean Export",
      column: "Action Needed",
      purpose: "One-line recommended next step for a row.",
      useFor: "Manual cleanup",
      notes: "Rows marked Ready do not require a manual action before import."
    },
    {
      sheet: "Clean Export",
      column: "Quality Tier",
      purpose: "Readable tier derived from coverage score.",
      useFor: "Sorting by quality",
      notes: "Complete and Good are strongest; Sparse and No data should be reviewed."
    },
    {
      sheet: AI_CLEANED_INPUT_SHEET,
      column: "Accepted / Rejected fields",
      purpose: "Shows Qwen suggestions beside scraped source evidence and deterministic cleanup.",
      useFor: "AI-assisted cleanup",
      notes: "This sheet is for review and preparation only; final PDT export does not read these AI values."
    },
    {
      sheet: "Clean Export",
      column: "Confidence",
      purpose: "Source match confidence as a percentage.",
      useFor: "Catalog match QA",
      notes: "Low confidence rows should be checked against the official product page."
    },
    {
      sheet: "Needs Review",
      column: "Review Priority",
      purpose: "High, Medium, or Low review priority.",
      useFor: "Review ordering",
      notes: "Work High rows first because they usually block import."
    },
    {
      sheet: "Needs Review",
      column: "Review Status",
      purpose: "Editable workflow status for manual review.",
      useFor: "Team tracking",
      notes: "Allowed values are Open, Checked, Needs manual lookup, and Ignore."
    },
    {
      sheet: "Needs Review",
      column: "Fix Needed",
      purpose: "Editable flag for whether a row needs changes.",
      useFor: "Manual cleanup",
      notes: "Allowed values are Yes, No, and Maybe."
    },
    {
      sheet: "Issue Summary",
      column: "Issue Type",
      purpose: "Aggregated reason rows entered Needs Review.",
      useFor: "Batch cleanup planning",
      notes: "Use this to find the biggest source of blocked rows."
    },
    {
      sheet: "Issue Summary",
      column: "Affected Catalog Numbers",
      purpose: "Catalog numbers grouped by issue type.",
      useFor: "Batch investigation",
      notes: "Open the linked Needs Review row to jump into the detailed queue."
    },
    {
      sheet: "Field Coverage",
      column: "Coverage Score",
      purpose: "Share of core fields present for each product row.",
      useFor: "Completeness QA",
      notes: "Use Missing Key Fields beside it to see what drove the score."
    },
    {
      sheet: "Clean Documents",
      column: "Primary",
      purpose: "Marks the first exported document of each type per product.",
      useFor: "Document selection",
      notes: "Primary datasheet/manual/CAD/certificate URLs are also surfaced in Clean Export."
    },
    {
      sheet: "Spec Matrix",
      column: "Technical spec columns",
      purpose: "Wide comparison view for common technical attributes.",
      useFor: "Product comparison",
      notes: "Use this when checking specs across many catalog numbers."
    },
    {
      sheet: "XLOOKUP",
      column: "All rows",
      purpose: "Single-line version of product data for formulas and matching.",
      useFor: "External lookup formulas",
      notes: "Long multiline summaries are flattened for lookup-friendly use."
    },
    {
      sheet: "Products / Attributes / Documents",
      column: "Raw fields",
      purpose: "Detailed extracted data and source metadata.",
      useFor: "Audit / troubleshooting",
      notes: "Use these tabs to trace why a clean export value was produced."
    }
  ];

  for (const row of rows) {
    sheet.addRow({
      sheet: { text: row.sheet, hyperlink: internalSheetHyperlink(row.sheet.split(" / ")[0]), tooltip: `Open ${row.sheet}` },
      column: row.column,
      purpose: row.purpose,
      useFor: row.useFor,
      notes: row.notes
    });
  }
}

function populateCleanAttributesSheet(
  sheet: ExcelJS.Worksheet,
  input: {
    manufacturer: ManufacturerConfig;
    items: RunItemRecord[];
  }
) {
  sheet.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Category", key: "category", width: 18 },
    { header: "Group", key: "group", width: 28 },
    { header: "Attribute", key: "name", width: 34 },
    { header: "Value", key: "value", width: 72 },
    { header: "Unit", key: "unit", width: 12 },
    { header: "Source Type", key: "sourceType", width: 18 },
    { header: "Source URL", key: "sourceUrl", width: 60 }
  ];

  for (const item of input.items) {
    const result = item.result;
    if (!result) continue;
    for (const attr of cleanAttributesForExport(result.attributes)) {
      sheet.addRow({
        manufacturer: input.manufacturer.canonicalName,
        catalogNumber: result.catalogNumber,
        category: cleanAttributeCategory(attr),
        group: attr.group,
        name: attr.name,
        value: attr.value,
        unit: attr.unit,
        sourceType: attr.sourceType,
        sourceUrl: attr.sourceUrl
      });
    }
  }
}

function populateCleanDocumentsSheet(
  sheet: ExcelJS.Worksheet,
  input: {
    manufacturer: ManufacturerConfig;
    items: RunItemRecord[];
  }
) {
  sheet.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Document Ready", key: "documentReady", width: 16 },
    { header: "Clean Export", key: "cleanExportLink", width: 14 },
    { header: "Priority", key: "priority", width: 10 },
    { header: "Primary", key: "primary", width: 10 },
    { header: "Type", key: "type", width: 14 },
    { header: "Label", key: "label", width: 46 },
    { header: "URL", key: "url", width: 72 },
    { header: "Local Path", key: "localPath", width: 62 },
    { header: "Download Status", key: "downloadStatus", width: 18 },
    { header: "Parse Status", key: "parseStatus", width: 16 },
    { header: "Source Type", key: "sourceType", width: 18 },
    { header: "Source URL", key: "sourceUrl", width: 62 }
  ];

  for (const [itemIndex, item] of input.items.entries()) {
    const result = item.result;
    if (!result) continue;
    const primaryTypes = new Set<ProductResult["documents"][number]["type"]>();
    const documents = [...documentsForExport(result)]
      .filter((doc) => Boolean(cleanText(doc.url) || cleanText(doc.localPath)))
      .sort(
        (left, right) =>
          documentSummaryRank(left) - documentSummaryRank(right) ||
          cleanText(left.label || left.url).localeCompare(cleanText(right.label || right.url), undefined, { sensitivity: "base" })
      );
    for (const doc of documents) {
      const primary = !primaryTypes.has(doc.type);
      primaryTypes.add(doc.type);
      sheet.addRow({
        manufacturer: input.manufacturer.canonicalName,
        catalogNumber: result.catalogNumber,
        documentReady: documentReadyStatus(doc),
        cleanExportLink: { text: "Open", hyperlink: internalSheetHyperlink("Clean Export", itemIndex + 2), tooltip: "Open matching Clean Export row" },
        priority: documentSummaryRank(doc),
        primary: primary ? "Yes" : "No",
        type: documentTypeLabel(doc.type),
        label: cleanText(doc.label) || doc.url || doc.localPath,
        url: doc.url,
        localPath: doc.localPath,
        downloadStatus: doc.downloadStatus,
        parseStatus: doc.parseStatus,
        sourceType: doc.sourceType,
        sourceUrl: doc.sourceUrl
      });
    }
  }
}

function populateFieldCoverageSheet(sheet: ExcelJS.Worksheet, items: RunItemRecord[], productRows: ProductExportRow[]) {
  sheet.columns = [
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Status", key: "status", width: 12 },
    { header: "Coverage Score", key: "coverageScore", width: 16, style: { numFmt: "0%" } },
    { header: "Present Fields", key: "presentFields", width: 16 },
    { header: "Total Fields", key: "totalFields", width: 14 },
    { header: "Missing Key Fields", key: "missingKeyFields", width: 54 },
    { header: "Primary Datasheet URL", key: "primaryDatasheetUrl", width: 64 },
    { header: "Image Count", key: "imageCount", width: 12 },
    { header: "Datasheet Count", key: "datasheetCount", width: 16 },
    { header: "Manual Count", key: "manualCount", width: 14 },
    { header: "CAD Count", key: "cadCount", width: 12 },
    { header: "Certificate Count", key: "certificateCount", width: 18 },
    { header: "Product URL", key: "productUrl", width: 14 },
    { header: "Image", key: "image", width: 12 },
    { header: "Datasheet", key: "datasheet", width: 12 },
    { header: "Product Type", key: "productType", width: 14 },
    { header: "Weight", key: "weight", width: 12 },
    { header: "Dimensions", key: "dimensions", width: 14 },
    { header: "Material", key: "material", width: 12 },
    { header: "Voltage", key: "voltage", width: 12 },
    { header: "Current", key: "current", width: 12 },
    { header: "Protection / IP", key: "protection", width: 16 },
    { header: "Certificates", key: "certificates", width: 14 },
    { header: "Review Reason", key: "reviewReason", width: 54 }
  ];

  for (const [index, row] of productRows.entries()) {
    const result = items[index]?.result;
    const documents = documentsForExport(result);
    const documentCounts = documentCountsByType(documents);
    const lookup = lookupRow(row, result);
    const coverage = fieldCoverageForRow(row);
    sheet.addRow({
      catalogNumber: row.catalogNumber,
      status: row.status,
      coverageScore: coverage.score,
      presentFields: coverage.presentCount,
      totalFields: coverage.totalCount,
      missingKeyFields: coverage.missing.join("; ") || undefined,
      primaryDatasheetUrl: lookup.primaryDatasheetUrl,
      imageCount: documentCounts.get("image") || undefined,
      datasheetCount: documentCounts.get("datasheet") || undefined,
      manualCount: documentCounts.get("manual") || undefined,
      cadCount: documentCounts.get("cad") || undefined,
      certificateCount: documentCounts.get("certificate") || undefined,
      productUrl: coverage.statusByField.get("Product URL"),
      image: coverage.statusByField.get("Image"),
      datasheet: coverage.statusByField.get("Datasheet"),
      productType: coverage.statusByField.get("Product Type"),
      weight: coverage.statusByField.get("Weight"),
      dimensions: coverage.statusByField.get("Dimensions"),
      material: coverage.statusByField.get("Material"),
      voltage: coverage.statusByField.get("Voltage"),
      current: coverage.statusByField.get("Current"),
      protection: coverage.statusByField.get("Protection / IP"),
      certificates: coverage.statusByField.get("Certificates"),
      reviewReason: reviewReason(row)
    });
  }
}

function populateSpecMatrixSheet(sheet: ExcelJS.Worksheet, items: RunItemRecord[], productRows: ProductExportRow[]) {
  sheet.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Status", key: "status", width: 12 },
    { header: "Review Priority", key: "reviewPriority", width: 16 },
    { header: "Coverage Score", key: "coverageScore", width: 16, style: { numFmt: "0%" } },
    { header: "Product Type", key: "productType", width: 34 },
    { header: "Title", key: "title", width: 46 },
    { header: "Product URL", key: "productUrl", width: 60 },
    { header: "Datasheet URL", key: "datasheetUrl", width: 64 },
    { header: "Image URL", key: "imageUrl", width: 60 },
    { header: "Connection 1", key: "connection1", width: 38 },
    { header: "Connection 2", key: "connection2", width: 38 },
    { header: "Connection", key: "connection", width: 38 },
    { header: "Cable", key: "cable", width: 42 },
    { header: "Cable Length", key: "cableLength", width: 18 },
    { header: "Operating Voltage Ub", key: "operatingVoltageUb", width: 26 },
    { header: "Voltage", key: "voltage", width: 22 },
    { header: "Rated Current", key: "ratedCurrent", width: 20 },
    { header: "Current", key: "current", width: 22 },
    { header: "Current Sum US", key: "currentSumUs", width: 20 },
    { header: "Current Sum UA", key: "currentSumUa", width: 20 },
    { header: "Interface", key: "interface", width: 32 },
    { header: "Output Function", key: "outputFunction", width: 30 },
    { header: "Output Characteristic", key: "outputCharacteristic", width: 30 },
    { header: "IP Rating", key: "ipRating", width: 16 },
    { header: "Protection", key: "protection", width: 24 },
    { header: "Material", key: "material", width: 30 },
    { header: "Housing Material", key: "housingMaterial", width: 30 },
    { header: "Dimensions", key: "dimensions", width: 28 },
    { header: "Weight (kg)", key: "weightKg", width: 14, style: { numFmt: "0.#########" } },
    { header: "Ambient Temperature", key: "ambientTemperature", width: 28 },
    { header: "Approval/Conformity", key: "approvalConformity", width: 34 },
    { header: "Certificates", key: "certificates", width: 34 },
    { header: "ECLASS", key: "eclass", width: 18 },
    { header: "ETIM", key: "etim", width: 18 },
    { header: "UNSPSC", key: "unspsc", width: 18 },
    { header: "Tariff Code (HS)", key: "tariffCode", width: 18 },
    { header: "Country of Origin", key: "countryOfOrigin", width: 22 },
    { header: "Product Status", key: "productStatus", width: 22 },
    { header: "Recommended Alternative", key: "recommendedAlternative", width: 34 },
    { header: "Missing Key Fields", key: "missingKeyFields", width: 48 }
  ];

  for (const [index, row] of productRows.entries()) {
    const result = items[index]?.result;
    const attributes = result?.attributes ?? [];
    const lookup = lookupRow(row, result);
    const coverage = fieldCoverageForRow(row);
    const priorityScore = reviewPriorityScore(row);
    sheet.addRow({
      manufacturer: row.manufacturer,
      catalogNumber: row.catalogNumber,
      status: row.status,
      reviewPriority: reviewReason(row) ? reviewPriorityLabel(priorityScore) : undefined,
      coverageScore: coverage.score,
      productType: row.productType,
      title: row.title,
      productUrl: row.productUrlEn ?? row.productUrl,
      datasheetUrl: lookup.primaryDatasheetUrl,
      imageUrl: row.imageUrl,
      connection1: matrixAttribute(attributes, [/^connection 1$/i]),
      connection2: matrixAttribute(attributes, [/^connection 2$/i]),
      connection: matrixAttribute(attributes, [/^connection$/i, /^electrical connection$/i, /^connector(?: type| design)?$/i]),
      cable: matrixAttribute(attributes, [/^cable$/i, /^cable type$/i]),
      cableLength: matrixAttribute(attributes, [/^cable length(?: l)?$/i], row.lengthMm !== undefined ? `${row.lengthMm} mm` : undefined),
      operatingVoltageUb: matrixAttribute(attributes, [/^operating voltage(?: ub| ur)?$/i, /^supply voltage/i], row.operatingVoltageUb),
      voltage: row.voltage,
      ratedCurrent: matrixAttribute(attributes, [/^rated current/i, /^rated operating current/i], row.ratedCurrent),
      current: row.current,
      currentSumUs: matrixAttribute(attributes, [/^current sum us/i], row.currentSumUs),
      currentSumUa: matrixAttribute(attributes, [/^current sum ua/i], row.currentSumUa),
      interface: matrixAttribute(attributes, [/^interface$/i, /^auxiliary interfaces$/i]),
      outputFunction: matrixAttribute(attributes, [/^output function$/i, /^switching output$/i]),
      outputCharacteristic: matrixAttribute(attributes, [/^output characteristic$/i, /^discrete output function$/i]),
      ipRating: row.ipRating,
      protection: row.protection,
      material: row.material,
      housingMaterial: matrixAttribute(attributes, [/^housing material$/i, /^material housing$/i]),
      dimensions: matrixAttribute(attributes, [/^dimension$/i, /^dimensions?$/i], row.heightMm !== undefined && row.widthMm !== undefined ? `${row.heightMm} x ${row.widthMm}${row.depthMm !== undefined ? ` x ${row.depthMm}` : ""} mm` : undefined),
      weightKg: row.weightKg,
      ambientTemperature: matrixAttribute(attributes, [/^ambient temperature$/i, /^operating temperature$/i, /^temperature range$/i], row.operatingTemperature),
      approvalConformity: matrixAttribute(attributes, [/^approval\/conformity$/i, /^approvals?$/i, /^certifications?$/i]),
      certificates: row.certificates,
      eclass: matrixAttribute(attributes, [/^eclass/i]),
      etim: matrixAttribute(attributes, [/^etim/i]),
      unspsc: matrixAttribute(attributes, [/^unspsc/i]),
      tariffCode: matrixAttribute(attributes, [/^tariff code/i, /^hs code$/i], row.tariffCode),
      countryOfOrigin: matrixAttribute(attributes, [/^country of origin$/i], row.countryOfOrigin),
      productStatus: matrixAttribute(attributes, [/^product status$/i, /^product sales status$/i, /^lifecycle status$/i]),
      recommendedAlternative: matrixAttribute(attributes, [/^recommended alternative$/i, /^replacement product$/i]),
      missingKeyFields: coverage.missing.join("; ") || undefined
    });
  }
}

function populateChecksSheet(sheet: ExcelJS.Worksheet, productRows: ProductExportRow[]) {
  sheet.columns = [
    { header: "Severity", key: "severity", width: 12 },
    { header: "Check", key: "check", width: 28 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Status", key: "status", width: 12 },
    { header: "Details", key: "details", width: 68 },
    { header: "Suggested Action", key: "suggestedAction", width: 46 },
    { header: "Product URL", key: "productUrl", width: 60 }
  ];

  for (const [catalogNumber, rows] of duplicateCatalogRows(productRows)) {
    for (const row of rows) {
      sheet.addRow({
        severity: "High",
        check: "Duplicate catalog number",
        catalogNumber,
        status: row.status,
        details: `${rows.length} rows use this catalog number.`,
        suggestedAction: "Confirm whether this is intended before importing/exporting.",
        productUrl: row.productUrlEn ?? row.productUrl
      });
    }
  }

  for (const row of productRows) {
    const coverage = fieldCoverageForRow(row);
    addCheckRow(sheet, row, row.status === "failed", "High", "Failed scrape", row.error ?? "No usable product result.", "Open source URL or rerun with final retry enabled.");
    addCheckRow(sheet, row, row.status === "partial", "Medium", "Partial scrape", row.error ?? "Product result is incomplete.", "Review product page, documents, and missing fields.");
    addCheckRow(sheet, row, Boolean(row.error), "High", "Scrape error", row.error, "Inspect run log and source page.");
    addCheckRow(sheet, row, coverage.score < 0.6, "Medium", "Low coverage", `${Math.round(coverage.score * 100)}% coverage. Missing: ${coverage.missing.join("; ")}`, "Review missing fields or confirm not published.");
    addCheckRow(sheet, row, Boolean(row.missingRequiredFields), "Medium", "Missing required fields", row.missingRequiredFields, "Fill manually or confirm not applicable.");
    addCheckRow(sheet, row, row.qualityPassed === false, "Medium", "Quality gate failed", row.qualityMissing, "Review quality missing fields.");
    addCheckRow(sheet, row, !row.productUrlEn && !row.productUrl, "High", "Missing product URL", "No source product URL exported.", "Check source discovery and localized URL mapping.");
    addCheckRow(sheet, row, !hasDocumentSummaryType(row.downloads, "Datasheet"), "Medium", "Missing datasheet", "No datasheet document found.", "Check Downloads or manufacturer document portal.");
    addCheckRow(sheet, row, !row.imageUrl, "Low", "Missing image", "No product image URL found.", "Check image-only run or source page media.");
  }

  if (sheet.rowCount === 1) {
    sheet.addRow({
      severity: "Info",
      check: "No issues",
      details: "No duplicate catalog numbers, failed rows, low coverage rows, missing datasheets, or missing images were detected."
    });
  }
}

function matrixAttribute(attributes: ProductResult["attributes"], namePatterns: RegExp[], fallback?: string): string | undefined {
  return firstAttributeValue(attributes, namePatterns, 500) ?? compactSpecValue(fallback, 500);
}

function duplicateCatalogRows(productRows: ProductExportRow[]): Map<string, ProductExportRow[]> {
  const byCatalog = new Map<string, ProductExportRow[]>();
  for (const row of productRows) {
    const key = cleanText(row.catalogNumber).toUpperCase();
    if (!key) continue;
    byCatalog.set(key, [...(byCatalog.get(key) ?? []), row]);
  }
  return new Map([...byCatalog.entries()].filter(([, rows]) => rows.length > 1));
}

function addCheckRow(
  sheet: ExcelJS.Worksheet,
  row: ProductExportRow,
  condition: boolean,
  severity: "High" | "Medium" | "Low",
  check: string,
  details: string | undefined,
  suggestedAction: string
) {
  if (!condition) return;
  sheet.addRow({
    severity,
    check,
    catalogNumber: row.catalogNumber,
    status: row.status,
    details,
    suggestedAction,
    productUrl: row.productUrlEn ?? row.productUrl
  });
}

function reviewReason(row: ProductExportRow): string | undefined {
  const confidence = Number(row.confidence ?? 0);
  const coverage = fieldCoverageForRow(row);
  const reasons = [
    row.status === "failed" ? "Failed scrape" : undefined,
    row.status === "partial" ? "Partial scrape" : undefined,
    confidence > 0 && confidence < 0.65 ? `Low confidence: ${confidence}` : undefined,
    coverage.score < 0.6 ? `Low coverage: ${Math.round(coverage.score * 100)}%` : undefined,
    row.qualityPassed === false ? "Quality gate failed" : undefined,
    row.attributeCount === 0 ? "No attributes" : undefined,
    row.documentCount === 0 ? "No documents" : undefined,
    !row.productUrlEn ? "Missing product URL" : undefined,
    !row.imageUrl ? "Missing image" : undefined,
    !hasDocumentSummaryType(row.downloads, "Datasheet") ? "Missing datasheet" : undefined,
    row.missingRequiredFields ? `Missing: ${row.missingRequiredFields}` : undefined,
    row.error ? "Has error" : undefined
  ].filter((value): value is string => Boolean(value));
  return reasons.join("; ") || undefined;
}

function reviewPriorityScore(row: ProductExportRow): number {
  const confidence = Number(row.confidence ?? 0);
  const coverage = fieldCoverageForRow(row);
  let score = 0;
  if (row.status === "failed") score += 100;
  if (row.status === "partial") score += 70;
  if (row.error) score += 60;
  if (row.qualityPassed === false) score += 45;
  if (row.missingRequiredFields) score += 35;
  if (coverage.score < 0.6) score += 30;
  if (confidence > 0 && confidence < 0.65) score += 20;
  if (row.attributeCount === 0) score += 15;
  if (row.documentCount === 0) score += 12;
  if (!row.productUrlEn) score += 10;
  if (!hasDocumentSummaryType(row.downloads, "Datasheet")) score += 8;
  if (!row.imageUrl) score += 5;
  return score;
}

function reviewPriorityLabel(score: number): "High" | "Medium" | "Low" {
  if (score >= 70) return "High";
  if (score >= 30) return "Medium";
  return "Low";
}

function exportDecision(row: ProductExportRow): "Import" | "Review" | "Exclude" {
  const status = cleanText(String(row.status ?? "")).toLowerCase();
  if (status === "failed" || status === "cancelled") return "Exclude";
  return reviewReason(row) ? "Review" : "Import";
}

function qualityTier(score: number): "Complete" | "Good" | "Usable" | "Sparse" | "No data" {
  if (score >= 0.9) return "Complete";
  if (score >= 0.75) return "Good";
  if (score >= 0.6) return "Usable";
  if (score > 0) return "Sparse";
  return "No data";
}

interface IssueSummaryRow {
  issueType: string;
  severity: "High" | "Medium" | "Low" | "Info";
  rows: number;
  highPriorityRows: number;
  mediumPriorityRows: number;
  lowPriorityRows: number;
  catalogNumbers: string;
  suggestedAction: string;
  firstReviewRow: number;
  sheetRow: number;
}

function issueSummaryRows(productRows: ProductExportRow[]): IssueSummaryRow[] {
  const reviewRows = reviewRowByProductIndex(productRows);
  const byIssue = new Map<
    string,
    {
      catalogs: string[];
      highPriorityRows: number;
      mediumPriorityRows: number;
      lowPriorityRows: number;
      firstReviewRow: number;
    }
  >();

  for (const [index, row] of productRows.entries()) {
    const issues = splitReviewIssueTypes(reviewIssueType(row));
    if (!issues.length) continue;
    const priority = reviewPriorityLabel(reviewPriorityScore(row));
    const reviewRow = reviewRows.get(index) ?? 2;
    for (const issue of issues) {
      const entry = byIssue.get(issue) ?? {
        catalogs: [],
        highPriorityRows: 0,
        mediumPriorityRows: 0,
        lowPriorityRows: 0,
        firstReviewRow: reviewRow
      };
      entry.catalogs.push(row.catalogNumber);
      if (priority === "High") entry.highPriorityRows += 1;
      if (priority === "Medium") entry.mediumPriorityRows += 1;
      if (priority === "Low") entry.lowPriorityRows += 1;
      entry.firstReviewRow = Math.min(entry.firstReviewRow, reviewRow);
      byIssue.set(issue, entry);
    }
  }

  return [...byIssue.entries()]
    .map(([issueType, entry]) => {
      const severity: IssueSummaryRow["severity"] = entry.highPriorityRows ? "High" : entry.mediumPriorityRows ? "Medium" : entry.lowPriorityRows ? "Low" : "Info";
      return {
        issueType,
        severity,
        rows: entry.catalogs.length,
        highPriorityRows: entry.highPriorityRows,
        mediumPriorityRows: entry.mediumPriorityRows,
        lowPriorityRows: entry.lowPriorityRows,
        catalogNumbers: compactCatalogList(uniqueStrings(entry.catalogs), 25),
        suggestedAction: suggestedActionForIssueType(issueType),
        firstReviewRow: entry.firstReviewRow,
        sheetRow: 0
      };
    })
    .sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || right.rows - left.rows || left.issueType.localeCompare(right.issueType, undefined, { sensitivity: "base" }))
    .map((issue, index) => ({ ...issue, sheetRow: index + 2 }));
}

function splitReviewIssueTypes(value: string | undefined): string[] {
  return uniqueStrings(
    cleanText(value)
      .split(/\s*;\s*/)
      .map((issue) => cleanText(issue))
      .filter(Boolean)
  );
}

function severityRank(value: "High" | "Medium" | "Low" | "Info"): number {
  return value === "High" ? 1 : value === "Medium" ? 2 : value === "Low" ? 3 : 4;
}

function compactCatalogList(values: string[], maxItems: number): string {
  if (values.length <= maxItems) return values.join("; ");
  return `${values.slice(0, maxItems).join("; ")}; +${values.length - maxItems} more`;
}

function suggestedActionForIssueType(issueType: string): string {
  const normalized = issueType.toLowerCase();
  if (normalized === "failed scrape") return "Rerun failed rows or inspect source URLs and run logs.";
  if (normalized === "partial scrape") return "Review source pages and fill missing product fields before import.";
  if (normalized === "scrape error") return "Inspect run logs, source pages, and connector parsing for affected rows.";
  if (normalized === "missing required fields") return "Fill required fields manually or confirm they are not applicable.";
  if (normalized === "low coverage") return "Open Field Coverage and prioritize high-value missing fields.";
  if (normalized === "quality gate") return "Review quality missing fields and source evidence.";
  if (normalized === "low confidence") return "Verify catalog/product match against the official product page.";
  if (normalized === "no attributes") return "Check extraction rules and source page structure for missing specs.";
  if (normalized === "no documents") return "Search manufacturer document portals and add relevant URLs.";
  if (normalized === "missing product url") return "Find and confirm official product URLs.";
  if (normalized === "missing datasheet") return "Add a datasheet URL or confirm no datasheet is published.";
  if (normalized === "missing image") return "Add a product image URL/file or confirm image is not required.";
  return "Open Needs Review and resolve affected rows before import.";
}

interface ReviewQueueItem {
  row: ProductExportRow;
  index: number;
  reason: string;
  coverage: FieldCoverage;
  priorityScore: number;
  priorityLabel: "High" | "Medium" | "Low";
}

function reviewQueueItems(productRows: ProductExportRow[]): ReviewQueueItem[] {
  return productRows
    .map((row, index) => {
      const reason = reviewReason(row);
      const priorityScore = reviewPriorityScore(row);
      return {
        row,
        index,
        reason,
        coverage: fieldCoverageForRow(row),
        priorityScore,
        priorityLabel: reviewPriorityLabel(priorityScore)
      };
    })
    .filter((item): item is ReviewQueueItem => Boolean(item.reason))
    .sort((left, right) => right.priorityScore - left.priorityScore || left.row.catalogNumber.localeCompare(right.row.catalogNumber, undefined, { sensitivity: "base" }));
}

interface WorkbookReadiness {
  status: string;
  detail: string;
  nextStep: string;
  importReadyCount: number;
  totalRows: number;
  reviewDetail: string;
}

function workbookReadiness(productRows: ProductExportRow[], reviewQueue: ReviewQueueItem[]): WorkbookReadiness {
  const totalRows = productRows.length;
  const importReadyCount = totalRows - reviewQueue.length;
  const priorityCounts = countValues(reviewQueue.map((item) => item.priorityLabel));
  const high = priorityCounts.get("High") ?? 0;
  const medium = priorityCounts.get("Medium") ?? 0;
  const low = priorityCounts.get("Low") ?? 0;
  const reviewDetail = reviewQueue.length ? `High: ${high}; Medium: ${medium}; Low: ${low}` : "No review rows";

  if (!totalRows) {
    return {
      status: "No rows exported",
      detail: "The workbook structure is ready, but this run did not contain product rows.",
      nextStep: "Run the scraper with at least one catalog number.",
      importReadyCount,
      totalRows,
      reviewDetail
    };
  }

  if (high > 0) {
    return {
      status: "Needs review before import",
      detail: `${importReadyCount}/${totalRows} rows are import-ready. ${reviewDetail}.`,
      nextStep: "Open Needs Review and resolve high-priority rows first.",
      importReadyCount,
      totalRows,
      reviewDetail
    };
  }

  if (medium > 0) {
    return {
      status: "Review recommended",
      detail: `${importReadyCount}/${totalRows} rows are import-ready. ${reviewDetail}.`,
      nextStep: "Open Needs Review, clear medium-priority issues, then use Import Ready.",
      importReadyCount,
      totalRows,
      reviewDetail
    };
  }

  if (low > 0) {
    return {
      status: "Ready with minor notes",
      detail: `${importReadyCount}/${totalRows} rows are import-ready. ${reviewDetail}.`,
      nextStep: "Use Import Ready; optionally review low-priority notes.",
      importReadyCount,
      totalRows,
      reviewDetail
    };
  }

  return {
    status: "Ready for import",
    detail: `${importReadyCount}/${totalRows} rows are import-ready.`,
    nextStep: "Use Import Ready as the direct-import product export.",
    importReadyCount,
    totalRows,
    reviewDetail
  };
}

function reviewIssueType(row: ProductExportRow): string | undefined {
  const confidence = Number(row.confidence ?? 0);
  const coverage = fieldCoverageForRow(row);
  const issues = [
    row.status === "failed" ? "Failed scrape" : undefined,
    row.status === "partial" ? "Partial scrape" : undefined,
    row.error ? "Scrape error" : undefined,
    row.missingRequiredFields ? "Missing required fields" : undefined,
    coverage.score < 0.6 ? "Low coverage" : undefined,
    row.qualityPassed === false ? "Quality gate" : undefined,
    confidence > 0 && confidence < 0.65 ? "Low confidence" : undefined,
    row.attributeCount === 0 ? "No attributes" : undefined,
    row.documentCount === 0 ? "No documents" : undefined,
    !row.productUrlEn && !row.productUrl ? "Missing product URL" : undefined,
    !hasDocumentSummaryType(row.downloads, "Datasheet") ? "Missing datasheet" : undefined,
    !row.imageUrl ? "Missing image" : undefined
  ].filter((value): value is string => Boolean(value));
  return uniqueStrings(issues).slice(0, 5).join("; ") || undefined;
}

function reviewSuggestedAction(row: ProductExportRow): string | undefined {
  const confidence = Number(row.confidence ?? 0);
  const coverage = fieldCoverageForRow(row);
  if (row.status === "failed") return "Rerun this item or inspect the source URL and run log.";
  if (row.error) return "Inspect the run log and source page, then rerun or correct the row manually.";
  if (!row.productUrlEn && !row.productUrl) return "Find and confirm the official product URL.";
  if (row.missingRequiredFields) return `Fill or confirm required fields: ${row.missingRequiredFields}.`;
  if (row.qualityPassed === false) return "Review quality missing fields and source evidence.";
  if (coverage.score < 0.6) return "Open Field Coverage and fill the highest-value missing fields.";
  if (!hasDocumentSummaryType(row.downloads, "Datasheet")) return "Add a datasheet URL or confirm the manufacturer does not publish one.";
  if (!row.imageUrl) return "Add a product image URL/file or confirm image is not required.";
  if (row.documentCount === 0) return "Check the manufacturer document portal and add relevant document URLs.";
  if (row.attributeCount === 0) return "Check extraction and source page structure for missing specifications.";
  if (confidence > 0 && confidence < 0.65) return "Open the product page and verify the catalog match.";
  return undefined;
}

function reviewRowByProductIndex(productRows: ProductExportRow[]): Map<number, number> {
  const rows = new Map<number, number>();
  for (const [queueIndex, item] of reviewQueueItems(productRows).entries()) {
    rows.set(item.index, queueIndex + 2);
  }
  return rows;
}

function documentReadyStatus(doc: ProductResult["documents"][number]): "Yes" | "No" {
  if (doc.downloadStatus === "failed" || doc.parseStatus === "failed") return "No";
  return doc.url || doc.localPath || doc.candidateUrls?.length ? "Yes" : "No";
}

function documentCountsByType(documents: ProductResult["documents"]): Map<ProductResult["documents"][number]["type"], number> {
  const counts = new Map<ProductResult["documents"][number]["type"], number>();
  for (const doc of documents) {
    counts.set(doc.type, (counts.get(doc.type) ?? 0) + 1);
  }
  return counts;
}

function hasDocumentSummaryType(value: string | undefined, label: string): boolean {
  return new RegExp(`(?:^|\\n)${escapeRegExp(label)}:`, "i").test(value ?? "");
}

interface FieldCoverage {
  score: number;
  presentCount: number;
  totalCount: number;
  missing: string[];
  statusByField: Map<string, "OK" | "Missing">;
}

function fieldCoverageForRow(row: ProductExportRow): FieldCoverage {
  const checks: Array<[string, boolean]> = [
    ["Product URL", Boolean(row.productUrlEn || row.productUrl)],
    ["Image", Boolean(row.imageUrl)],
    ["Datasheet", hasDocumentSummaryType(row.downloads, "Datasheet")],
    ["Product Type", Boolean(row.productType)],
    ["Weight", row.weightKg !== undefined || row.weightLb !== undefined],
    ["Dimensions", [row.heightMm, row.widthMm, row.depthMm, row.lengthMm, row.heightIn, row.widthIn, row.depthIn, row.lengthIn].some((value) => value !== undefined)],
    ["Material", Boolean(row.material)],
    ["Voltage", Boolean(row.voltage)],
    ["Current", Boolean(row.current || row.ratedCurrent)],
    ["Protection / IP", Boolean(row.ipRating || row.protection)],
    ["Certificates", Boolean(row.certificates)]
  ];
  const missing = checks.filter(([, present]) => !present).map(([label]) => label);
  const presentCount = checks.length - missing.length;
  return {
    score: checks.length ? Number((presentCount / checks.length).toFixed(4)) : 0,
    presentCount,
    totalCount: checks.length,
    missing,
    statusByField: new Map(checks.map(([label, present]) => [label, present ? "OK" : "Missing"]))
  };
}

function cleanAttributesForExport(attributes: ProductResult["attributes"]): ProductResult["attributes"] {
  return sortAttributes(attributes).filter(isUserFacingAttribute);
}

function isUserFacingAttribute(attr: ProductResult["attributes"][number]): boolean {
  const name = cleanText(attr.name);
  const value = cleanText(attr.value);
  const group = cleanText(attr.group);
  if (!name || !value) return false;
  if (!usefulSummaryValue(value)) return false;
  if (name.length > 120 || value.length > 1000) return false;
  if (/^(?:@context|@type|url|image|images|thumbnail|thumbnail url|canonical url)$/i.test(name)) return false;
  if (/^(?:og:|twitter:)/i.test(name) && /\b(?:image|url|site_name|locale|type)\b/i.test(name)) return false;
  if (/^meta$/i.test(group) && /\b(?:image|url|site_name|locale|type)\b/i.test(name)) return false;
  if (/^(?:show more|show less|downloads?|classifications?|key features|digital product passport|contact request|retrieve data)$/i.test(name)) return false;
  if (/^https?:\/\/\S+$/i.test(value) && /\b(?:image|url|href|link)\b/i.test(name)) return false;
  if (/[{}]|var\(--|@media|display\s*:|calc\(/i.test(`${name} ${value}`)) return false;
  return true;
}

function cleanAttributeCategory(attr: ProductResult["attributes"][number]): string {
  const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
  if (/eclass|etim|unspsc|classification/.test(label)) return "Classification";
  if (/approval|conform|cert|standard|rohs|reach|weee|ul\b|csa\b|ce\b|ukca|compliance/.test(label)) return "Compliance";
  if (/voltage|current|power|frequency|interface|output|input|switching|io-link|port|supply/.test(label)) return "Electrical";
  if (/dimension|height|width|depth|length|weight|material|housing|mount|connection|cable|thread|temperature|ip rating|protection/.test(label)) return "Mechanical";
  if (/status|availability|replacement|alternative|price|tariff|country of origin|commercial|lifecycle|ean|gtin|upc/.test(label)) return "Commercial";
  if (/sku|mpn|catalog|part number|product id|alternate|product label|product variant|type|series|range|family|description/.test(label)) return "Identity";
  return "Other";
}


function addSummarySection(sheet: ExcelJS.Worksheet, row: number, title: string): number {
  sheet.mergeCells(row, 1, row, 4);
  const cell = sheet.getCell(row, 1);
  cell.value = title;
  cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
  cell.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(row).height = 22;
  return row + 1;
}

function addSummaryMetric(
  sheet: ExcelJS.Worksheet,
  row: number,
  metric: string,
  value: string | number | boolean | undefined,
  detail?: string,
  hyperlink?: string
): number {
  sheet.getCell(row, 1).value = metric;
  const valueCell = sheet.getCell(row, 2);
  const displayValue = value === undefined || value === "" ? "n/a" : value;
  valueCell.value = hyperlink ? { text: String(displayValue), hyperlink, tooltip: `Open ${metric}` } : displayValue;
  if (hyperlink) valueCell.font = { color: { argb: "FF2563EB" }, underline: true };
  sheet.getCell(row, 3).value = detail;
  return row + 1;
}

function internalSheetHyperlink(sheetName: string, row = 1, column = "A"): string {
  return `#'${sheetName.replace(/'/g, "''")}'!${column}${row}`;
}

function styleRunSummarySheet(sheet: ExcelJS.Worksheet) {
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 28;
  sheet.getRow(2).font = { italic: true, color: { argb: "FF475569" } };
  sheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: "top", wrapText: rowNumber !== 1 };
    if (rowNumber > 2 && rowNumber % 2 === 0 && !row.getCell(1).isMerged) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
  });
  sheet.getColumn(2).numFmt = "#,##0";
  styleRunSummaryReadiness(sheet);
}

function styleRunSummaryReadiness(sheet: ExcelJS.Worksheet) {
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    if (cleanText(String(sheet.getRow(rowNumber).getCell(1).value ?? "")) !== "Workbook status") continue;
    const cell = sheet.getRow(rowNumber).getCell(2);
    const value = cleanText(cell.text || String(cell.value ?? ""));
    const fill =
      value === "Ready for import"
        ? "FFDCFCE7"
        : value === "Ready with minor notes"
          ? "FFE0F2FE"
          : value === "Review recommended"
            ? "FFFEF3C7"
            : value === "Needs review before import"
              ? "FFFEE2E2"
              : "FFE2E8F0";
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  }
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values.map((item) => cleanText(item)).filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function sortedCountEntries(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], undefined, { sensitivity: "base" }));
}

function splitSummaryList(value: string | undefined): string[] {
  return cleanText(value)
    .split(/\s*;\s*/)
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function lookupRow(row: ReturnType<typeof productRow>, result?: ProductResult) {
  const documents = documentsForExport(result);
  return {
    ...row,
    description: singleLineForLookup(row.description),
    copySummary: singleLineForLookup(row.copySummary),
    keySpecifications: singleLineForLookup(row.keySpecifications),
    electricalRatings: singleLineForLookup(row.electricalRatings),
    mechanicalInstallation: singleLineForLookup(row.mechanicalInstallation),
    complianceStandards: singleLineForLookup(row.complianceStandards),
    lifecycleCommercial: singleLineForLookup(row.lifecycleCommercial),
    downloads: singleLineForLookup(row.downloads),
    allResources: singleLineForLookup(row.allResources),
    allSpecifications: singleLineForLookup(row.allSpecifications),
    primaryDatasheetUrl: primaryDocumentUrlForLookup(documents, "datasheet"),
    primaryManualUrl: primaryDocumentUrlForLookup(documents, "manual"),
    primaryCadUrl: primaryDocumentUrlForLookup(documents, "cad"),
    primaryCertificateUrl: primaryDocumentUrlForLookup(documents, "certificate"),
    primaryOtherUrl: primaryDocumentUrlForLookup(documents, "other"),
    datasheetUrls: documentUrlsForLookup(documents, "datasheet"),
    manualUrls: documentUrlsForLookup(documents, "manual"),
    cadUrls: documentUrlsForLookup(documents, "cad"),
    certificateUrls: documentUrlsForLookup(documents, "certificate"),
    otherUrls: documentUrlsForLookup(documents, "other"),
    allDocumentUrls: documentUrlsForLookup(documents)
  };
}

function primaryDocumentUrlForLookup(documents: ProductResult["documents"], type: ProductResult["documents"][number]["type"]): string | undefined {
  return documents
    .filter((doc) => doc.type === type && Boolean(doc.url))
    .sort((left, right) => documentSummaryRank(left) - documentSummaryRank(right) || cleanText(left.label).localeCompare(cleanText(right.label), undefined, { sensitivity: "base" }))[0]
    ?.url;
}

function documentUrlsForLookup(documents: ProductResult["documents"], type?: ProductResult["documents"][number]["type"]): string | undefined {
  const urls = documents
    .filter((doc) => !type || doc.type === type)
    .map((doc) => doc.url)
    .filter(Boolean);
  return singleLineForLookup([...new Set(urls)].join("; "));
}

function singleLineForLookup(value: unknown): string | undefined {
  const cleaned = cleanText(String(value ?? ""))
    .replace(/\s*\n+\s*/g, " | ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || undefined;
}

function productRow(manufacturer: ManufacturerConfig, item: RunItemRecord, result?: ProductResult) {
  const urls = {
    ...buildLocalizedProductUrls(manufacturer.id, item.catalogNumber, result?.productUrl ?? item.productUrl, manufacturer.localizedUrlTemplates),
    ...result?.localizedUrls
  };
  const productUrlDe = distinctGermanUrl(urls.de, urls.en, result?.productUrl ?? item.productUrl);
  const normalized = normalizedForExport(result);
  const measurements = measurementsForExport(result, normalized);
  const documents = documentsForExport(result);
  const summary = specificationSummaryForExport(result, normalized);
  const deviceType = classifyDeviceType(result);
  const technical = technicalHighlightsForExport(result?.attributes ?? [], normalized);
  const electrical = electricalSplitForExport(result?.attributes ?? [], normalized);
  const voltage = dedupePipeJoinedSpec(normalized.voltage);
  const current = dedupePipeJoinedSpec(normalized.current);
  const eclass = eclassForExport(result?.attributes ?? []);
  const row = {
    manufacturer,
    result,
    productUrlEn: urls.en,
    productUrlDe,
    ...measurements,
    material: normalized.material,
    finish: normalized.finish,
    color: normalized.color,
    certificates: normalized.certificates,
    voltage,
    current,
    primaryImage: primaryImageDocument(result)
  };

  return {
    manufacturer: manufacturer.canonicalName,
    shortName: manufacturer.shortName,
    catalogNumber: item.catalogNumber,
    status: result?.status ?? item.status,
    confidence: result?.confidence ?? item.confidence ?? 0,
    title: result?.title ?? item.title,
    description: result?.description ?? descriptionFromAttributes(result),
    productType: summary.productType,
    deviceType: deviceType.type,
    deviceTypeConfidence: deviceType.confidence,
    deviceTypeEvidence: deviceType.evidence,
    copySummary: copySummaryForExport({
      catalogNumber: item.catalogNumber,
      title: result?.title ?? item.title,
      productType: summary.productType,
      deviceType: deviceType.type,
      voltage,
      current,
      currentType: electrical.currentType,
      ratedCurrent: electrical.ratedCurrent,
      material: row.material,
      certificates: row.certificates,
      eclass,
      weight: normalized.weight,
      dimensions: normalized.dimensions,
      protection: normalized.protection,
      ipRating: technical.ipRating
    }),
    ean: summary.ean,
    allSpecifications: summary.allSpecifications,
    keySpecifications: summary.keySpecifications,
    electricalRatings: summary.electricalRatings,
    mechanicalInstallation: summary.mechanicalInstallation,
    complianceStandards: summary.complianceStandards,
    lifecycleCommercial: summary.lifecycleCommercial,
    accessoriesRelated: summary.accessoriesRelated,
    downloads: summary.downloads,
    allResources: summary.allResources,
    image: row.primaryImage?.localPath ? "Embedded" : row.primaryImage ? "Linked" : undefined,
    imageLocalPath: row.primaryImage?.localPath,
    imageUrl: row.primaryImage?.url,
    imageCount: documents.filter((doc) => doc.type === "image").length || undefined,
    allImageUrls: imageGalleryForExport(documents),
    productUrlEn: row.productUrlEn,
    productUrlDe: row.productUrlDe,
    productUrl: result?.productUrl ?? item.productUrl,
    weight: normalized.weight,
    weightLb: row.weightLb,
    weightKg: row.weightKg,
    dimensions: normalized.dimensions,
    heightIn: row.heightIn,
    widthIn: row.widthIn,
    depthIn: row.depthIn,
    lengthIn: row.lengthIn,
    heightMm: row.heightMm,
    widthMm: row.widthMm,
    depthMm: row.depthMm,
    lengthMm: row.lengthMm,
    material: row.material,
    wallThicknessIn: row.wallThicknessIn,
    wallThicknessMm: row.wallThicknessMm,
    finish: row.finish,
    color: row.color,
    voltage,
    voltageAc: electrical.voltageAc,
    voltageDc: electrical.voltageDc,
    voltageRange: electrical.voltageRange,
    operatingVoltageUb: electrical.operatingVoltageUb,
    current,
    currentAc: electrical.currentAc,
    currentDc: electrical.currentDc,
    currentType: electrical.currentType,
    ratedCurrent: electrical.ratedCurrent,
    currentSumUs: electrical.currentSumUs,
    currentSumUa: electrical.currentSumUa,
    standards: electrical.standards,
    productFamily: electrical.productFamily,
    suitableFor: electrical.suitableFor,
    replacedProductId: electrical.replacedProductId,
    tariffCode: electrical.tariffCode,
    countryOfOrigin: electrical.countryOfOrigin,
    protection: normalized.protection,
    ipRating: technical.ipRating,
    nemaRating: technical.nemaRating,
    ikRating: technical.ikRating,
    frequency: technical.frequency,
    phase: technical.phase,
    poles: technical.poles,
    terminalsConnection: technical.terminalsConnection,
    mounting: technical.mounting,
    operatingTemperature: technical.operatingTemperature,
    wireCableSize: technical.wireCableSize,
    threadSize: technical.threadSize,
    certificates: row.certificates,
    eclass,
    attributeCount: result?.attributes.length ?? 0,
    documentCount: documents.length,
    qualityPassed: result?.qualityGate?.passed,
    qualityScore: result?.qualityGate?.score,
    qualityMissing: result?.qualityGate?.missing.join("; "),
    fallbackStages: result?.diagnostics?.fallbackStages?.join("; "),
    finalCompletenessCheck: finalCompletenessCheck(result),
    missingRequiredFields: missingRequiredFields(row),
    unmappedSpecLabels: result?.diagnostics?.unmappedSpecLabels?.join("; "),
    error: result?.error ?? item.error
  };
}

function finalCompletenessCheck(result: ProductResult | undefined): string | undefined {
  const audit = result?.diagnostics?.finalCompleteness;
  if (!audit) return undefined;
  const importantRecords = (audit.records ?? []).filter((record) => record.status !== "present");
  if (importantRecords.length) {
    return importantRecords.map((record) => `${fieldLabel(record.field)}: ${finalAuditStatusLabel(record)}`).join("; ");
  }
  return [
    audit.retryMissing.length ? `Retried: ${audit.retryMissing.join(", ")}` : undefined,
    audit.afterMissing.length ? `Still missing: ${audit.afterMissing.join(", ")}` : "Complete",
    audit.notApplicable.length ? `Not applicable: ${audit.notApplicable.join(", ")}` : undefined
  ]
    .filter(Boolean)
    .join("; ");
}

function finalAuditStatusLabel(record: FinalCompletenessRecord): string {
  if (record.status === "not-applicable") return "not applicable";
  if (record.status === "not-published") return "not published";
  if (record.status === "retry-skipped") return "retry skipped";
  if (record.status === "found-after-repair") return "found after repair";
  if (record.status === "found-after-retry") return "found after retry";
  return record.status;
}

function fieldLabel(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (char) => char.toUpperCase());
}

function distinctGermanUrl(deUrl?: string, enUrl?: string, sourceUrl?: string): string | undefined {
  if (!deUrl) return undefined;
  if ([enUrl, sourceUrl].filter((url): url is string => Boolean(url)).some((url) => sameUrl(url, deUrl))) return undefined;
  return deUrl;
}

function sameUrl(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.origin.toLowerCase() === rightUrl.origin.toLowerCase() &&
      leftUrl.pathname.replace(/\/+$/, "").toLowerCase() === rightUrl.pathname.replace(/\/+$/, "").toLowerCase() &&
      leftUrl.searchParams.toString() === rightUrl.searchParams.toString()
    );
  } catch {
    return left.replace(/\/+$/, "").toLowerCase() === right.replace(/\/+$/, "").toLowerCase();
  }
}

interface ExportMeasurements {
  weightLb?: number;
  weightKg?: number;
  heightIn?: number;
  widthIn?: number;
  depthIn?: number;
  lengthIn?: number;
  heightMm?: number;
  widthMm?: number;
  depthMm?: number;
  lengthMm?: number;
  wallThicknessIn?: number;
  wallThicknessMm?: number;
}

interface LengthMeasurement {
  in?: number;
  mm?: number;
}

interface WeightMeasurement {
  lb?: number;
  kg?: number;
}

function measurementsForExport(result: ProductResult | undefined, normalized: ProductResult["normalized"]): ExportMeasurements {
  const attributes = result?.attributes ?? [];
  const weight = bestWeightMeasurement(attributes, normalized.weight);
  const dimensions = dimensionMeasurements(attributes, normalized.dimensions);
  const wallThickness = bestWallThicknessMeasurement(attributes, normalized.wallThickness);
  return {
    weightLb: measurementNumber(weight?.lb),
    weightKg: measurementNumber(weight?.kg),
    heightIn: measurementNumber(dimensions.height?.in),
    widthIn: measurementNumber(dimensions.width?.in),
    depthIn: measurementNumber(dimensions.depth?.in),
    lengthIn: measurementNumber(dimensions.length?.in),
    heightMm: measurementNumber(dimensions.height?.mm),
    widthMm: measurementNumber(dimensions.width?.mm),
    depthMm: measurementNumber(dimensions.depth?.mm),
    lengthMm: measurementNumber(dimensions.length?.mm),
    wallThicknessIn: measurementNumber(wallThickness?.in),
    wallThicknessMm: measurementNumber(wallThickness?.mm)
  };
}

function bestWeightMeasurement(attributes: ProductResult["attributes"], fallback?: string): WeightMeasurement | undefined {
  const candidates = attributes
    .filter((attr) => /weight|mass|gewicht|peso|te[zž]ina/i.test(`${attr.group ?? ""} ${attr.name}`))
    .map((attr) => ({ value: parseWeightMeasurement(attr.value), score: measurementAttributeScore(attr) }))
    .filter((candidate): candidate is { value: WeightMeasurement; score: number } => Boolean(candidate.value));
  const best = candidates.sort((left, right) => right.score - left.score)[0]?.value ?? parseWeightMeasurement(fallback);
  if (!best) return undefined;
  if (best.lb === undefined && best.kg !== undefined) best.lb = best.kg / POUND_TO_KILOGRAM;
  if (best.kg === undefined && best.lb !== undefined) best.kg = best.lb * POUND_TO_KILOGRAM;
  return best;
}

function parseWeightMeasurement(value: string | undefined): WeightMeasurement | undefined {
  const cleaned = cleanText(value);
  const match = cleaned.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|lb|lbs|pound|pounds|oz|ounce|ounces)\b/i);
  if (!match) return undefined;
  const number = Number(match[1].replace(",", "."));
  if (!Number.isFinite(number)) return undefined;
  const unit = match[2].toLowerCase();
  if (unit === "kg") return { kg: number, lb: number / POUND_TO_KILOGRAM };
  if (unit === "g") return { kg: number / 1000, lb: number / 1000 / POUND_TO_KILOGRAM };
  if (/^lb|pound/.test(unit)) return { lb: number, kg: number * POUND_TO_KILOGRAM };
  if (/^oz|ounce/.test(unit)) return { lb: number / 16, kg: number * 0.028349523125 };
  return undefined;
}

function dimensionMeasurements(
  attributes: ProductResult["attributes"],
  fallback?: string
): { height?: LengthMeasurement; width?: LengthMeasurement; depth?: LengthMeasurement; length?: LengthMeasurement } {
  const output: { height?: LengthMeasurement; width?: LengthMeasurement; depth?: LengthMeasurement; length?: LengthMeasurement } = {};
  for (const attr of [...attributes].sort((left, right) => measurementAttributeScore(right) - measurementAttributeScore(left))) {
    const label = `${attr.group ?? ""} ${attr.name}`;
    const depthLengthAlias = /\b(?:depth|length)\s*\/\s*(?:depth|length)\b/i.test(label);
    if (isPackagingMeasurementAttribute(attr)) continue;
    if (isNonPhysicalDimensionAttribute(label)) continue;
    if (!output.height && /\bheight\b|\bhöhe\b|\bhoehe\b|\baltezza\b/i.test(label)) output.height = parseLengthMeasurement(attr.value);
    if (!output.width && /\bwidth\b|\bbreite\b|\blarghezza\b/i.test(label)) output.width = parseLengthMeasurement(attr.value);
    if (!output.depth && /\bdepth\b|\btiefe\b|\bprofond/i.test(label)) output.depth = parseLengthMeasurement(attr.value);
    if (depthLengthAlias) continue;
    if (!output.length && /\blength\b|\blÃ¤nge\b|\blaenge\b|\blunghezza\b/i.test(label)) output.length = parseLengthMeasurement(attr.value);
  }

  const dimensionText = attributes
    .filter((attr) => !isPackagingMeasurementAttribute(attr) && /dimension|height|width|depth|length|abmess/i.test(`${attr.group ?? ""} ${attr.name}`))
    .sort((left, right) => measurementAttributeScore(right) - measurementAttributeScore(left))
    .map((attr) => attr.value)
    .find((value) => {
      const parsed = parseDimensionText(value);
      return parsed.height || parsed.width || parsed.depth || parsed.length;
    }) ?? fallback;
  const parsed = parseDimensionText(dimensionText);
  output.height ??= parsed.height;
  output.width ??= parsed.width;
  output.depth ??= parsed.depth;
  output.length ??= parsed.length;
  output.length ??= bestCableLengthMeasurement(attributes, fallback);
  return output;
}

function isPackagingMeasurementAttribute(attr: ProductResult["attributes"][number]): boolean {
  return /\b(?:package|packing|packaging)\b/i.test(`${attr.group ?? ""} ${attr.name}`);
}

function isNonPhysicalDimensionAttribute(label: string): boolean {
  return /\b(?:focal length|back focal|object distance|minimum object distance|angle of view|sensor size|lens|wire stripping|terminal|conductor|bus length|tap links length|communication distance|operating distance|pulse width|time delay|response time|process data|segment)\b/i.test(
    label
  );
}

function parseDimensionText(value: string | undefined): { height?: LengthMeasurement; width?: LengthMeasurement; depth?: LengthMeasurement; length?: LengthMeasurement } {
  const cleaned = cleanText(value);
  const output: { height?: LengthMeasurement; width?: LengthMeasurement; depth?: LengthMeasurement; length?: LengthMeasurement } = {};
  if (!cleaned) return output;

  for (const match of cleaned.matchAll(/\b([HWDL])\s*(\d+(?:[.,]\d+)?)\s*(in|inch|inches|"|mm|cm|m|ft|feet|foot)?\b/gi)) {
    const target = dimensionTarget(match[1]);
    if (target && !output[target]) output[target] = toLengthMeasurement(Number(match[2].replace(",", ".")), normalizeLengthUnit(match[3]) ?? "in");
  }
  for (const match of cleaned.matchAll(/\b(\d+(?:[.,]\d+)?)(?:\s*(in|inch|inches|"|mm|cm|m|ft|feet|foot))?\s*([HWDL])\b/gi)) {
    const target = dimensionTarget(match[3]);
    if (target && !output[target]) output[target] = toLengthMeasurement(Number(match[1].replace(",", ".")), normalizeLengthUnit(match[2]) ?? "in");
  }

  if (!output.height && !output.width) {
    const sequence = cleaned.match(/\b(\d+(?:[.,]\d+)?)\s*[xX*]\s*(\d+(?:[.,]\d+)?)\s*(?:[xX*]\s*(\d+(?:[.,]\d+)?)\s*)?(mm|cm|m|ft|feet|foot|in|inch|inches|")\b/i);
    if (sequence) {
      const unit = normalizeLengthUnit(sequence[4]);
      if (unit) {
        output.height = toLengthMeasurement(Number(sequence[1].replace(",", ".")), unit);
        output.width = toLengthMeasurement(Number(sequence[2].replace(",", ".")), unit);
        if (sequence[3]) output.depth = toLengthMeasurement(Number(sequence[3].replace(",", ".")), unit);
      }
    }
  }
  return output;
}

function bestCableLengthMeasurement(attributes: ProductResult["attributes"], fallback?: string): LengthMeasurement | undefined {
  const candidates = [
    ...attributes
      .filter((attr) => {
        const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
        if (/\b(?:focal|object distance|sensor size|mounting|thread|wire stripping|terminal)\b/.test(label)) return false;
        return /\bcable length\b/.test(label) || /^cable$/i.test(attr.name);
      })
      .sort((left, right) => measurementAttributeScore(right) - measurementAttributeScore(left))
      .map((attr) => parseSingleLengthMeasurement(attr.value)),
    /\bcable length\b/i.test(cleanText(fallback)) ? parseSingleLengthMeasurement(fallback) : undefined
  ].filter((value): value is LengthMeasurement => Boolean(value));
  return candidates[0];
}

function parseSingleLengthMeasurement(value: string | undefined): LengthMeasurement | undefined {
  const cleaned = cleanText(value);
  const match = cleaned.match(/\b(\d+(?:[.,]\d+)?)\s*(mm|cm|m|ft|feet|foot|in|inch|inches|")\b/i);
  if (!match) return undefined;
  const number = Number(match[1].replace(",", "."));
  const unit = normalizeLengthUnit(match[2]);
  if (!Number.isFinite(number) || !unit) return undefined;
  return toLengthMeasurement(number, unit);
}

function bestWallThicknessMeasurement(attributes: ProductResult["attributes"], fallback?: string): LengthMeasurement | undefined {
  const candidates = attributes
    .filter((attr) => {
      const text = `${attr.group ?? ""} ${attr.name} ${attr.value}`;
      if (/\brelated product\b/i.test(`${attr.group ?? ""} ${attr.name}`)) return false;
      if (/\b(?:wall\s+)?mounting\b/i.test(text) && !/\b(?:thick(?:ness)?|gauge|sheet|steel|stainless|aluminum|aluminium|body|door)\b/i.test(text)) return false;
      return /wall|thickness|gauge|construction|material|steel|aluminum|aluminium|body|door/i.test(text) && !/\b(height|width|depth|dimension)\b/i.test(attr.name);
    })
    .map((attr) => ({ value: parseLengthMeasurement(`${attr.name} ${attr.value}`), score: measurementAttributeScore(attr) }))
    .filter((candidate): candidate is { value: LengthMeasurement; score: number } => Boolean(candidate.value));
  return candidates.sort((left, right) => right.score - left.score)[0]?.value ?? parseLengthMeasurement(fallback);
}

function parseLengthMeasurement(value: string | undefined): LengthMeasurement | undefined {
  const cleaned = cleanText(value);
  const match = cleaned.match(/\b(\d+(?:[.,]\d+)?)\s*(in\.?|inch|inches|"|mm|cm|m|ft|feet|foot)\b/i);
  if (!match) return undefined;
  return toLengthMeasurement(Number(match[1].replace(",", ".")), normalizeLengthUnit(match[2]));
}

function toLengthMeasurement(value: number, unit: string | undefined): LengthMeasurement | undefined {
  if (!Number.isFinite(value) || !unit) return undefined;
  if (unit === "mm") return { mm: value, in: value / INCH_TO_MILLIMETER };
  if (unit === "cm") return { mm: value * 10, in: (value * 10) / INCH_TO_MILLIMETER };
  if (unit === "m") return { mm: value * 1000, in: (value * 1000) / INCH_TO_MILLIMETER };
  if (unit === "ft") return { in: value * 12, mm: value * 304.8 };
  return { in: value, mm: value * INCH_TO_MILLIMETER };
}

function normalizeLengthUnit(unit: string | undefined): string | undefined {
  if (!unit) return undefined;
  const lower = unit.toLowerCase();
  if (lower === `"` || lower.startsWith("in")) return "in";
  if (lower === "ft" || lower === "foot" || lower === "feet") return "ft";
  if (lower === "cm" || lower === "m" || lower === "mm") return lower;
  return undefined;
}

function dimensionTarget(label: string): "height" | "width" | "depth" | "length" | undefined {
  const clean = label.toUpperCase();
  if (clean === "H") return "height";
  if (clean === "W") return "width";
  if (clean === "D") return "depth";
  if (clean === "L") return "length";
  return undefined;
}

function measurementAttributeScore(attr: ProductResult["attributes"][number]): number {
  let score = 0;
  const group = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
  if (/product specifications|technical|dimensions|construction/.test(group)) score += 100;
  if (/pdf|manual|generated/.test(`${attr.sourceType ?? ""} ${attr.parser ?? ""} ${attr.stage ?? ""}`.toLowerCase())) score -= 40;
  if (attr.sourceType === "official" || attr.sourceType === "official-fallback") score += 30;
  return score;
}

function measurementNumber(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Number((value + Number.EPSILON).toFixed(9));
}

async function addProductThumbnail(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  row: ExcelJS.Row,
  result?: ProductResult
) {
  const image = primaryImageDocument(result);
  if (!image?.localPath || !fs.existsSync(image.localPath)) return;
  try {
    const buffer = await sharp(image.localPath)
      .resize(86, 86, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const imageId = workbook.addImage({ base64: buffer.toString("base64"), extension: "png" });
    const imageColumn = sheet.getColumn("image").number;
    row.height = Math.max(row.height || 15, 68);
    sheet.addImage(imageId, {
      tl: { col: imageColumn - 1 + 0.15, row: row.number - 1 + 0.15 },
      ext: { width: 86, height: 86 },
      editAs: "oneCell"
    });
  } catch {
    row.getCell("image").value = "Downloaded";
  }
}

function primaryImageDocument(result?: ProductResult) {
  const documents = documentsForExport(result);
  const catalogNumber = result?.catalogNumber.toLowerCase();
  const exactDownloaded = documents.find(
    (doc) =>
      doc.type === "image" &&
      doc.downloadStatus === "downloaded" &&
      doc.localPath &&
      (!catalogNumber || doc.url.toLowerCase().includes(catalogNumber))
  );
  return exactDownloaded ??
    documents.find((doc) => doc.type === "image" && doc.downloadStatus === "downloaded" && doc.localPath) ??
    documents.find((doc) => doc.type === "image");
}

function normalizedForExport(result?: ProductResult): ProductResult["normalized"] {
  if (!result) return {};
  const normalized = { ...result.normalized };
  const computed = normalizeFields(result.attributes, documentsForExport(result));
  for (const key of Object.keys(computed) as Array<keyof ProductResult["normalized"]>) {
    if (computed[key] && !normalized[key]) normalized[key] = computed[key];
  }
  return normalized;
}

interface SpecificationSummary {
  productType?: string;
  ean?: string;
  allSpecifications?: string;
  keySpecifications?: string;
  electricalRatings?: string;
  mechanicalInstallation?: string;
  complianceStandards?: string;
  lifecycleCommercial?: string;
  accessoriesRelated?: string;
  downloads?: string;
  allResources?: string;
}

interface TechnicalHighlights {
  ipRating?: string;
  nemaRating?: string;
  ikRating?: string;
  frequency?: string;
  phase?: string;
  poles?: string;
  terminalsConnection?: string;
  mounting?: string;
  operatingTemperature?: string;
  wireCableSize?: string;
  threadSize?: string;
}

function technicalHighlightsForExport(attributes: ProductResult["attributes"], normalized: ProductResult["normalized"]): TechnicalHighlights {
  return {
    ipRating: ipRatingForExport(attributes, normalized.protection),
    nemaRating: nemaRatingForExport(attributes, normalized.protection),
    ikRating: ikRatingForExport(attributes, normalized.protection),
    frequency: joinedAttributeSpecs(
      attributes,
      [
        /^nominal frequency$/i,
        /^frequency rating$/i,
        /^rated frequency$/i,
        /^frequency$/i,
        /^supply frequency$/i,
        /^input frequency range$/i,
        /^network frequency$/i,
        /^operating frequency$/i
      ],
      6
    ),
    phase: joinedAttributeSpecs(attributes, [/^phase$/i, /^network number of phases$/i, /^network type$/i], 4),
    poles: joinedAttributeSpecs(attributes, [/^number of (?:protected )?poles$/i, /^number of poles$/i, /^poles description$/i], 4),
    terminalsConnection: joinedAttributeSpecs(
      attributes,
      [
        /^terminals$/i,
        /^terminal type$/i,
        /^terminal capacity$/i,
        /^screw terminal type$/i,
        /^input connection$/i,
        /^output connection$/i,
        /^electrical connection$/i,
        /^connection \(supply voltage (?:in|out)\)$/i,
        /^connector(?: type| design)?$/i,
        /^side[ab] connector\d+$/i
      ],
      10
    ),
    mounting: joinedAttributeSpecs(
      attributes,
      [/^mounting method$/i, /^mounting type$/i, /^device mounting$/i, /^mounting$/i, /^mounting support$/i, /^mounting hardware$/i, /^mounting position$/i],
      8
    ),
    operatingTemperature: joinedAttributeSpecs(
      attributes,
      [
        /^ambient operating temperature/i,
        /^ambient temperature$/i,
        /^operating temperature$/i,
        /^operating temperature range$/i,
        /^temperature range$/i,
        /^storage temperature$/i,
        /^ambient storage temperature/i,
        /^media temperature$/i,
        /^temperature hysteresis$/i,
        /^high temperature alarm$/i
      ],
      8
    ),
    wireCableSize: joinedAttributeSpecs(
      attributes,
      [
        /^wire size$/i,
        /^wire diameter/i,
        /^cable outer diameter/i,
        /^cable diameter/i,
        /^cable length$/i,
        /^cable length range$/i,
        /^terminal capacity$/i,
        /^conductor cross section$/i,
        /^cross section$/i,
        /^wire stripping length$/i
      ],
      8
    ),
    threadSize: joinedAttributeSpecs(attributes, [/^thread size$/i, /^thread type$/i, /^thread$/i, /^connection thread/i], 6)
  };
}

function specificationSummaryForExport(result: ProductResult | undefined, normalized: ProductResult["normalized"]): SpecificationSummary {
  const attributes = result?.attributes ?? [];
  const documents = documentsForExport(result);
  const productType =
    firstAttributeValue(attributes, [/^extended product type$/i]) ??
    firstAttributeValue(attributes, [/^product main type$/i]) ??
    firstAttributeValue(attributes, [/^product or component type$/i]) ??
    firstAttributeValue(attributes, [/^sensor type$/i]) ??
    firstAttributeValue(attributes, [/^product type$/i]) ??
    firstAttributeValue(attributes, [/^alternateName$/i, /^product label$/i]) ??
    firstAttributeValue(attributes, [/^device short name$/i]) ??
    firstAttributeValue(attributes, [/^product family$/i]) ??
    firstAttributeValue(attributes, [/^product variant$/i]) ??
    firstAttributeValue(attributes, [/^type$/i]) ??
    firstAttributeValue(attributes, [/^model(?: code| number| no\.?)?$/i]) ??
    firstAttributeValue(attributes, [/^item name$/i]) ??
    firstAttributeValue(attributes, [/^product name$/i]) ??
    firstAttributeValue(attributes, [/^description$/i]);
  const ean = firstAttributeValue(attributes, [/^ean(?: code)?$/i, /^gtin(?:8|12|13|14)?$/i, /^package level 1 ean$/i]) ?? firstAttributeValue(attributes, [/^upc$/i]);

  return {
    productType,
    ean,
    allSpecifications: allSpecificationsForExport(attributes),
    keySpecifications: joinSpecLines([
      specLine("Catalog Number", firstAttributeValue(attributes, [/^catalog number$/i, /^part number$/i, /^sku$/i])),
      specLine("Article Number", firstAttributeValue(attributes, [/^article number$/i])),
      specLine("Item Name", firstAttributeValue(attributes, [/^item name$/i])),
      specLine("Bulletin Number", firstAttributeValue(attributes, [/^bulletin number$/i])),
      specLine("Product ID", firstAttributeValue(attributes, [/^product id$/i])),
      specLine("Product Type", productType),
      specLine("Description", firstAttributeValue(attributes, [/^description$/i])),
      ...attributeSpecLines(
        attributes,
        [
          /^range(?: of product)?$/i,
          /^product main type$/i,
          /^product type$/i,
          /^product or component type$/i,
          /^abb type designation$/i,
          /^global commercial alias$/i,
          /^display name$/i,
          /^product name$/i,
          /^item name$/i,
          /^products path$/i,
          /^classification path$/i,
          /^(?:coveo:)?product_brand$/i,
          /^(?:coveo:)?product_core_group$/i,
          /^(?:coveo:)?product_lines$/i,
          /^(?:coveo:)?product_regions$/i,
          /^device short name$/i,
          /^device application$/i,
          /^product specific application$/i,
          /^product destination$/i,
          /^sensor type$/i,
          /^sensor name$/i,
          /^sensor design$/i,
          /^\[sn\]\s*nominal sensing distance$/i,
          /^sensing range$/i,
          /^detector flush mounting acceptance$/i,
          /^type of output signal$/i,
          /^discrete output function$/i,
          /^discrete output type$/i,
          /^wiring technique$/i,
          /^output circuit type$/i,
          /^electrical connection$/i,
          /^detection face$/i,
          /^connector group$/i,
          /^connector$/i,
          /^connector type$/i,
          /^interface$/i,
          /^side[ab] connector\d+$/i,
          /^technology$/i,
          /^thread type$/i,
          /^thread size$/i,
          /^status led$/i,
          /^product group$/i,
          /^product category$/i,
          /^category$/i,
          /^variant$/i,
          /^global catalog$/i,
          /^model(?: code| number| no\.?)?$/i,
          /^model no\.?$/i,
          /^lumens?$/i,
          /^life expectancy$/i,
          /^series$/i,
          /^frame$/i,
          /^frame size$/i,
          /^class$/i,
          /^style$/i,
          /^style housing$/i,
          /^contact configuration$/i,
          /^operation$/i,
          /^actuator$/i,
          /^actuator function$/i,
          /^button color$/i,
          /^bezel$/i,
          /^illumination$/i,
          /^environmental rating$/i,
          /^enclosure$/i,
          /^nema rating$/i,
          /^fuse configuration$/i,
          /^number of wires$/i,
          /^number of circuits$/i,
          /^number of spaces$/i,
          /^number of modules$/i,
          /^number of rows$/i,
          /^phase$/i,
          /^box size$/i,
          /^cover$/i,
          /^main circuit breaker$/i,
          /^bus material$/i,
          /^wire size$/i,
          /^cable type$/i,
          /^cable length range$/i,
          /^gland type$/i,
          /^mounting method$/i,
          /^lug[/]connector type$/i,
          /^angle\b/i,
          /^area classification$/i,
          /^hazardous\??$/i,
          /^ground path type$/i,
          /^boiler sensor$/i,
          /^pipe sensor$/i,
          /^self diagnostic feature$/i,
          /^bulit-in ground fault protection$/i,
          /^built-in ground fault protection$/i
        ],
        12
      ),
      specLine("Catalog Description", firstAttributeValue(attributes, [/^catalog description$/i])),
      specLine("Long Description", firstAttributeValue(attributes, [/^long description$/i], 360)),
      ...attributeSpecLines(
        attributes,
        [
          /^suitable for\b/i,
          /^number of (?:protected )?poles$/i,
          /^number of poles$/i,
          /^poles description$/i,
          /^current transformer type$/i,
          /^current transformer ratio$/i,
          /^secondary current$/i,
          /^accuracy class$/i,
          /^connection to the vehicle$/i,
          /^earthing system$/i,
          /^protection type$/i,
          /^max power$/i,
          /^tripping characteristic$/i,
          /^trip unit technology$/i,
          /^trip unit rating$/i,
          /^trip type$/i,
          /^circuit breaker type$/i,
          /^circuit breaker frame type$/i,
          /^battery type$/i,
          /^receptacle$/i,
          /^package contents$/i,
          /^communication$/i,
          /^manufacturer$/i,
          /^protocol$/i,
          /^software$/i,
          /^clutch size$/i,
          /^torque rating$/i,
          /^input shaft size$/i,
          /^number of discs$/i,
          /^transmission type$/i,
          /^facing material$/i,
          /^portfolio rating$/i,
          /^hydraulic linkage$/i,
          /^vehicle classification group$/i,
          /^accessory\/spare part type$/i,
          /^used with$/i,
          /^special features$/i,
          /^country of origin$/i,
          /^function$/i,
          /^application$/i,
          /^additional features$/i,
          /^additional text$/i,
          /^version$/i,
          /^use$/i,
          /^component$/i,
          /^contacts type and composition$/i,
          /^operator profile$/i,
          /^type of operator$/i,
          /^shape of signaling unit head$/i,
          /^thermal protection adjustment range$/i,
          /^input function$/i,
          /^input$/i,
          /^number of inputs/i,
          /^number of outputs/i,
          /^diagnostics/i,
          /^operating principle$/i,
          /^principle of operation$/i,
          /^principle of optical operation$/i,
          /^measuring principle$/i,
          /^measuring axes$/i,
          /^beam characteristic$/i,
          /^beam angle$/i,
          /^light spot size$/i,
          /^light intensity$/i,
          /^color temperature$/i,
          /^illumination area$/i,
          /^sensitivity$/i,
          /^range$/i,
          /^range sn$/i,
          /^measuring range$/i,
          /^measuring length$/i,
          /^nominal stroke$/i,
          /^read distance$/i,
          /^reference signal$/i,
          /^resolution$/i,
          /^repeat accuracy$/i,
          /^linearity deviation$/i,
          /^non-linearity max\.$/i,
          /^accuracy$/i,
          /^vibration, frequency range$/i,
          /^vibration, number of measuring axes$/i,
          /^vibration, measuring range$/i,
          /^contact temperature, measuring range$/i,
          /^relative humidity, measuring range$/i,
          /^ambient pressure, measuring range$/i,
          /^image resolution$/i,
          /^sensor type vision$/i,
          /^focal length$/i,
          /^back focal length$/i,
          /^aperture$/i,
          /^distortion$/i,
          /^minimum object distance/i,
          /^angle of view/i,
          /^max\.?\s*sensor size$/i,
          /^lens mount$/i,
          /^segments, number max\.$/i,
          /^predefined colors$/i,
          /^function indicator$/i,
          /^volume max\.$/i,
          /^setting$/i,
          /^additional function$/i,
          /^supported rfid technologies$/i,
          /^supported io-link profiles$/i,
          /^product area$/i,
          /^performance level$/i,
          /^sil\b/i,
          /^sil cl\b/i,
          /^safety category/i,
          /^coding level/i,
          /^b10d\b/i,
          /^response time max\.$/i,
          /^no of contacts$/i,
          /^guard locking, principle$/i,
          /^holding force fzh$/i,
          /^auxiliary release$/i,
          /^axillary release$/i,
          /^escape release$/i,
          /^feature$/i,
          /^cover style$/i,
          /^options?$/i,
          /^notes?$/i
        ],
        28
      )
    ]),
    electricalRatings: joinSpecLines([
      specLine("Voltage", normalized.voltage),
      specLine("Current", normalized.current),
      ...attributeSpecLines(
        attributes,
        [
          /^rated operational voltage$/i,
          /^\[[^\]]+\]\s*rated operational voltage$/i,
          /^\[[^\]]+\]\s*rated supply voltage$/i,
          /^\[[^\]]+\]\s*rated insulation voltage$/i,
          /^\[[^\]]+\]\s*rated impulse withstand voltage$/i,
          /^volts?$/i,
          /^volt(?:s)?(?:\s*(?:ac|dc))?$/i,
          /^voltage rating/i,
          /^rated voltage$/i,
          /^operational voltage$/i,
          /^maximum operating voltage/i,
          /^rated supply voltage$/i,
          /^supply voltage/i,
          /^rated control circuit voltage$/i,
          /^control circuit voltage$/i,
          /^operating voltage(?: ub)?$/i,
          /^rated operating voltage/i,
          /^connection \(supply voltage in\)$/i,
          /^connection \(supply voltage out\)$/i,
          /^input voltage/i,
          /^input power$/i,
          /^power input$/i,
          /^output voltage$/i,
          /^nominal input voltage$/i,
          /^nominal output voltage$/i,
          /^input nominal voltage$/i,
          /^output nominal voltage$/i,
          /^input voltage range$/i,
          /^input frequency range$/i,
          /^output capacity max\.$/i,
          /^rated output voltage(?: dc)?$/i,
          /^rated output current$/i,
          /^coil$/i,
          /^coil voltage$/i,
          /^supply voltage at/i,
          /^nominal frequency$/i,
          /^hp rating/i,
          /^va rating$/i,
          /^watts?$/i,
          /^wattage$/i,
          /^power$/i,
          /^power consumption$/i,
          /^btu(?:\/hr\.?)?$/i,
          /^btu\/hr\.?$/i,
          /^cooling capacity$/i,
          /^air flow$/i,
          /^cfm$/i,
          /^alarm signal/i,
          /^rated current$/i,
          /^\[in\]\s*rated current/i,
          /^secondary current$/i,
          /^current transformer ratio$/i,
          /^accuracy class$/i,
          /^\[[^\]]+\]\s*rated operational current/i,
          /^\[[^\]]+\]\s*rated supply current/i,
          /^\[[^\]]+\]\s*rated output current/i,
          /^\[[^\]]+\]\s*conventional free air thermal current/i,
          /^\[[^\]]+\]\s+.*current/i,
          /^thermal protection adjustment range$/i,
          /^magnetic tripping current$/i,
          /^line current/i,
          /^continuous output current/i,
          /^continuous ampere rating$/i,
          /^maximum transient current/i,
          /^amperage rating$/i,
          /^amperage$/i,
          /^rated current \(40/i,
          /^ampere rating$/i,
          /^switch capacity$/i,
          /^maximum circuit breaker size$/i,
          /^max\.?\s*current$/i,
          /^interrupt rating/i,
          /^rated operational current/i,
          /^rated operating current/i,
          /^conventional .*current/i,
          /^current sum/i,
          /^total current max\.$/i,
          /^continuous current$/i,
          /^switching current$/i,
          /^output current/i,
          /^input current/i,
          /^current consumption/i,
          /^no-load current/i,
          /^rated .*short-circuit/i,
          /^short circuit capacity$/i,
          /^prospective line isc/i,
          /^interrupt rating/i,
          /^dielectric strength$/i,
          /^apparent power/i,
          /^supply voltage/i,
          /^operating voltage at/i,
          /^frequency rating$/i,
          /^voltage type/i,
          /^surge rating$/i,
          /^overvoltage category$/i,
          /^rated insulation voltage/i,
          /^rated switch current$/i,
          /^rated operation current/i,
          /^static heat dissipation/i,
          /^heat diss\./i,
          /^switching output$/i,
          /^output function$/i,
          /^output characteristic$/i,
          /^number of switching outputs$/i,
          /^interface$/i,
          /^auxiliary interfaces$/i,
          /^port-class$/i,
          /^io-link version$/i,
          /^safety hub support$/i,
          /^transfer rate$/i,
          /^process data/i,
          /^analog (?:input|output)s?$/i,
          /^digital (?:input|output)s?$/i,
          /^number of (?:analog|digital )?(?:inputs|outputs)/i,
          /^configurable inputs\/outputs$/i,
          /^rated frequency$/i,
          /^frequency$/i,
          /^supply frequency$/i,
          /^speed drive output frequency$/i,
          /^nominal switching frequency$/i,
          /^switching frequency$/i,
          /^limit frequency/i,
          /^sampling frequency/i,
          /^nominal voltage$/i,
          /^nominal voltage,?\s*iec$/i,
          /^voltage ac$/i,
          /^max current$/i,
          /^max current rating/i,
          /^maximum supply current$/i,
          /^short term withstand current/i,
          /^peak short circuit current/i,
          /^short circuit current rating/i,
          /^max working voltage/i,
          /^breaking capacity$/i,
          /^\[[^\]]+\]\s*rated service short-circuit breaking capacity/i,
          /^nominal power output\b/i,
          /^power output\b/i,
          /^max power$/i,
          /^motor power/i,
          /^power range/i,
          /^network (?:type|frequency)$/i,
          /^network number of phases$/i,
          /^utilisation category$/i,
          /^utilization category$/i,
          /^heating capacity$/i,
          /^thermostat range/i,
          /^set point range$/i,
          /^controller (?:cooling|heating) setpoint$/i,
          /^temperature hysteresis$/i,
          /^high temperature alarm$/i,
          /^operating temperature range$/i,
          /^refrigerant$/i,
          /^power supply type$/i,
          /^earthing system$/i,
          /^connection to the vehicle$/i,
          /^protection type$/i,
          /^power loss$/i,
          /^horsepower rating/i,
          /^input voltage type$/i,
          /^discrete input number$/i,
          /^discrete output number$/i,
          /^discrete output type$/i,
          /^analogue input number$/i,
          /^analogue output number$/i,
          /^output voltage limits$/i,
          /^switching capacity in mA$/i,
          /^current consumption$/i,
          /^voltage drop$/i,
          /^output circuit type$/i,
          /^supply$/i
        ],
        32
      )
    ]),
    mechanicalInstallation: joinSpecLines([
      specLine("Dimensions", normalized.dimensions),
      specLine("Weight", normalized.weight),
      specLine("Material", normalized.material),
      specLine("Protection", normalized.protection),
      ...attributeSpecLines(
        attributes,
        [
          /^product net (?:height|width|depth|weight)/i,
          /^product (?:height|width|length\/depth|diameter|weight)$/i,
          /^enclosure nominal (?:height|width|depth)$/i,
          /^external dimensions?$/i,
          /^height\b/i,
          /^width\b/i,
          /^depth\b/i,
          /^length\b/i,
          /^nominal (?:width|thickness|cable weight)$/i,
          /^dimensions? /i,
          /^ip degree of protection$/i,
          /^degree of protection$/i,
          /^construction detail$/i,
          /^application$/i,
          /^device mounting$/i,
          /^mounting method$/i,
          /^busbar thickness$/i,
          /^cross section$/i,
          /^lamella thickness$/i,
          /^enclosure material$/i,
          /^enclosure$/i,
          /^nema rating$/i,
          /^environmental rating$/i,
          /^box size$/i,
          /^housing material$/i,
          /^material quality$/i,
          /^material(?: housing)?$/i,
          /^material components$/i,
          /^surface finishing$/i,
          /^surface finish$/i,
          /^finish$/i,
          /^color$/i,
          /^colour$/i,
          /^handle color$/i,
          /^ral-number$/i,
          /^color code$/i,
          /^thickness/i,
          /^bezel material$/i,
          /^fixing collar material$/i,
          /^contacts material$/i,
          /^mounting diameter$/i,
          /^mounting/i,
          /^mounting support$/i,
          /^mounting hardware$/i,
          /^terminals$/i,
          /^terminal capacity$/i,
          /^connector design$/i,
          /^material sensing surface$/i,
          /^sensing surface$/i,
          /^sensor design$/i,
          /^size$/i,
          /^thread type$/i,
          /^thread size$/i,
          /^pressure range$/i,
          /^filter rating$/i,
          /^refrigerant$/i,
          /^controller (?:cooling|heating) setpoint$/i,
          /^temperature hysteresis$/i,
          /^high temperature alarm$/i,
          /^detection face$/i,
          /^front material$/i,
          /^cable composition$/i,
          /^wire insulation material$/i,
          /^differential travel$/i,
          /^\[sn\]\s*nominal sensing distance$/i,
          /^sensing range$/i,
          /^cable$/i,
          /^cable length/i,
          /^cable diameter/i,
          /^cable shielding$/i,
          /^cable outer diameter(?:\s*\(od\))?$/i,
          /^outer cable diameter$/i,
          /^outer sheath/i,
          /^cable sealing range$/i,
          /^gland size$/i,
          /^gland type$/i,
          /^sealing type$/i,
          /^cable jacket/i,
          /^power cord jacket/i,
          /^connection(?: \d)?$/i,
          /^connection \(com 1\)$/i,
          /^connection \(com 2\)$/i,
          /^connection slots$/i,
          /^connection for sensor$/i,
          /^connection \(supply voltage out\)$/i,
          /^input connection$/i,
          /^mechanical connection$/i,
          /^process connection$/i,
          /^process connection material$/i,
          /^gasket, material$/i,
          /^connection type$/i,
          /^connector/i,
          /^fork opening$/i,
          /^connecting capacity/i,
          /^terminal type$/i,
          /^screw terminal type$/i,
          /^wire stripping length$/i,
          /^mounting type$/i,
          /^mounting part$/i,
          /^installation$/i,
          /^antenna type$/i,
          /^housing style$/i,
          /^ambient temperature$/i,
          /^storage temperature$/i,
          /^ambient operating temperature/i,
          /^ambient storage temperature/i,
          /^operating temperature$/i,
          /^media temperature$/i,
          /^illumination area$/i,
          /^environmental conditions$/i,
          /^air pressure$/i,
          /^shock resistance$/i,
          /^vibration resistance$/i,
          /^drop and topple$/i,
          /^height of fall/i,
          /^mounting position$/i,
          /^mounting method$/i,
          /^max exposure temperature$/i,
          /^maximum operating temperature$/i,
          /^maximum exposure temperature$/i,
          /^max intermittent exposure temperature/i,
          /^max maintain or continuous exposure temperature/i,
          /^minimum installation temperature$/i,
          /^minimum bend radius$/i,
          /^pressure rating max\.$/i,
          /^overload pressure$/i,
          /^burst pressure$/i,
          /^display$/i,
          /^enclosure$/i,
          /^noise level$/i,
          /^temperature range$/i,
          /^relative humidity$/i,
          /^efficiency at max\. load$/i,
          /^adjuster$/i,
          /^scope of delivery$/i,
          /^number of switching positions$/i,
          /^approach direction$/i,
          /^approach speed$/i,
          /^procedure direction$/i,
          /^switch position spacing$/i,
          /^guard locking, principle$/i,
          /^holding force fzh$/i,
          /^auxiliary release$/i,
          /^axillary release$/i,
          /^escape release$/i,
          /^life expectancy mechanical$/i,
          /^handle type$/i,
          /^handle length$/i,
          /^neutral type$/i,
          /^door type$/i,
          /^door surface finishing$/i,
          /^cover plate type$/i,
          /^cover style$/i,
          /^closure type$/i,
          /^configuration type$/i,
          /^door opening side$/i,
          /^number of doors$/i,
          /^device composition$/i,
          /^removable parts$/i,
          /^cable gland plate type$/i,
          /^net weight$/i,
          /^unit weight$/i,
          /^hole size/i,
          /^conductor size/i,
          /^wire diameter/i,
          /^insulation thickness/i,
          /^number of stud connections/i,
          /^stud connection/i,
          /^connector material$/i,
          /^conductor material$/i,
          /^outer jacket material$/i,
          /^jacket material$/i,
          /^cable jacket, material$/i,
          /^cable jacket, color$/i,
          /^ral number$/i,
          /^impact resistance rating$/i
        ],
        32
      )
    ]),
    complianceStandards: joinSpecLines([
      specLine("Certificates", normalized.certificates),
      ...attributeSpecLines(
        attributes,
        [
          /^approval\/conformity$/i,
          /^performance level$/i,
          /^safety category/i,
          /^sil\b/i,
          /^sil cl\b/i,
          /^coding level/i,
          /^b10d\b/i,
          /^product certifications?$/i,
          /^certifications?$/i,
          /^certificates?$/i,
          /^declarations?$/i,
          /^declarations? of conformity$/i,
          /^conformity declarations?$/i,
          /^approvals?$/i,
          /^approval agency certificates?$/i,
          /^compliances?$/i,
          /^regulatory compliance$/i,
          /^environmental compliance$/i,
          /^standards?$/i,
          /^ul$/i,
          /^ul type$/i,
          /^ul file no\.?$/i,
          /^ul model number$/i,
          /^ul categorycontrol$/i,
          /^ul component recognized$/i,
          /^certification detail$/i,
          /^csa$/i,
          /^complies with$/i,
          /^industry standard/i,
          /^marking$/i,
          /^standardization body$/i,
          /^ip degree of protection$/i,
          /^ik degree of protection$/i,
          /^nema degree of protection$/i,
          /^enclosure type$/i,
          /^protective treatment$/i,
          /^rohs\b/i,
          /^eu rohs directive$/i,
          /^china rohs regulation$/i,
          /^reach\b/i,
          /^reach regulation$/i,
          /^weee category$/i,
          /^weee\b/i,
          /^sustainable offer status$/i,
          /^mercury free$/i,
          /^toxic heavy metal free$/i,
          /^halogen content performance$/i,
          /^california proposition 65$/i,
          /^halogen free rating$/i,
          /^low smoke rating$/i,
          /^mechanical resistance rating$/i,
          /^flammability rating$/i,
          /^uv resistance rating$/i,
          /^installation standard$/i,
          /^substances of concern$/i,
          /^disposal instructions$/i,
          /^energy consumption labeling$/i,
          /^environmental product declaration/i,
          /^total lifecycle carbon footprint$/i,
          /^carbon footprint/i,
          /^environmental disclosure$/i,
          /^conflict minerals reporting template/i,
          /^circularity profile$/i,
          /^take-back$/i,
          /^atex certificate$/i,
          /^csa certificate/i,
          /^vde certificate$/i,
          /^tariff code$/i,
          /^customs tariff number$/i,
          /^eclass\b/i,
          /^etim\b/i,
          /^unspsc\b/i
        ],
        32,
        compactComplianceSummaryValue
      )
    ]),
    lifecycleCommercial: joinSpecLines([
      ...attributeSpecLines(
        attributes,
        [
          /^product sales status$/i,
          /^product status$/i,
          /^product availability$/i,
          /^availability$/i,
          /^product availability class$/i,
          /^commercial message$/i,
          /^discontinued on$/i,
          /^recommended replacement/i,
          /^price$/i,
          /^price code$/i,
          /^list price$/i,
          /^catalog page$/i,
          /^minimum order quantity$/i,
          /^sale per indivisible quantity$/i,
          /^package level 1 units$/i,
          /^package level 1 ean$/i,
          /^standard packaging quantity$/i,
          /^packing quantity$/i,
          /^package quantity$/i,
          /^unit type of package/i,
          /^number of units in package/i,
          /^package \d+ (?:height|width|length|weight)$/i,
          /^country of origin$/i,
          /^upc$/i,
          /^ean$/i,
          /^warranty$/i,
          /^contractual warranty$/i,
          /^standard factory warranty$/i,
          /^extended service plans$/i,
          /^catalog notes$/i,
          /^customs tariff number$/i,
          /^tariff code$/i,
          /^object classification code$/i,
          /^replaced product id/i,
          /^sustainable offer status$/i
        ],
        20
      )
    ]),
    accessoriesRelated: joinSpecLines([
      ...attributeSpecLines(
        attributes,
        [
          /^included accessory$/i,
          /^optional accessory$/i,
          /^recommended alternative$/i,
          /^accessory$/i,
          /^related product$/i,
          /^related part$/i,
          /^spare part$/i,
          /^variant product$/i,
          /^alternative part$/i,
          /^similar part$/i,
          /^related purchase$/i,
          /^linked part$/i,
          /^used with$/i
        ],
        36
      )
    ]),
    downloads: joinSpecLines(documentSpecLines(documents, 28)),
    allResources: allResourcesForExport(documents)
  };
}

function specLine(label: string, value: string | undefined): string | undefined {
  const cleaned = compactSpecValue(value);
  return cleaned ? `${label}: ${cleaned}` : undefined;
}

function copySummaryForExport(input: {
  catalogNumber: string;
  title?: string;
  productType?: string;
  deviceType?: string;
  voltage?: string;
  current?: string;
  currentType?: string;
  ratedCurrent?: string;
  material?: string;
  certificates?: string;
  eclass?: string;
  weight?: string;
  dimensions?: string;
  protection?: string;
  ipRating?: string;
}): string | undefined {
  return joinSpecLines([
    specLine("Catalog Number", input.catalogNumber),
    specLine("Title", input.title),
    specLine("Product Type", input.productType),
    specLine("Device Type", input.deviceType),
    specLine("Voltage", input.voltage),
    specLine("Current", input.current),
    specLine("Current Type", input.currentType),
    specLine("Rated Current", input.ratedCurrent),
    specLine("Material", input.material),
    specLine("Certificates", input.certificates),
    specLine("ECLASS", eclassValueForCopy(input.eclass)),
    specLine("Weight", input.weight),
    specLine("Dimensions", input.dimensions),
    specLine("IP Rating", input.ipRating),
    specLine("Protection", input.protection)
  ]);
}

function eclassValueForCopy(value: string | undefined): string | undefined {
  return value?.replace(/^ECLASS(?:\s+\d+(?:\.\d+)*)?:\s*/i, "");
}

function joinSpecLines(lines: Array<string | undefined>): string | undefined {
  const joined = uniqueStrings(lines.filter((line): line is string => Boolean(line))).join("\n");
  return joined || undefined;
}

function attributeSpecLines(
  attributes: ProductResult["attributes"],
  namePatterns: RegExp[],
  maxLines: number,
  valueTransform: (value: string) => string | undefined = (value) => value
): string[] {
  const lines = attributes
    .filter((attr) => namePatterns.some((pattern) => pattern.test(attr.name)) && usefulSummaryValue(attr.value))
    .sort((left, right) => summaryAttributeScore(right) - summaryAttributeScore(left))
    .map((attr) => specLine(attr.name, valueTransform(attr.value)))
    .filter((line): line is string => Boolean(line));
  return uniqueStrings(lines).slice(0, maxLines);
}

function joinedAttributeSpecs(attributes: ProductResult["attributes"], namePatterns: RegExp[], maxLines: number): string | undefined {
  return joinSpecLines(attributeSpecLines(attributes, namePatterns, maxLines));
}

function eclassForExport(attributes: ProductResult["attributes"]): string | undefined {
  const candidates = attributes
    .filter((attr) => /^eclass(?:\s+\d+(?:\.\d+)*)?$/i.test(cleanText(attr.name)) && usefulSummaryValue(attr.value))
    .map((attr) => ({
      label: cleanText(attr.name).toUpperCase(),
      value: compactSpecValue(attr.value, 80),
      score: eclassVersionScore(attr.name) + summaryAttributeScore(attr)
    }))
    .filter((candidate): candidate is { label: string; value: string; score: number } => Boolean(candidate.value))
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  return best ? `${best.label}: ${best.value}` : undefined;
}

function eclassVersionScore(value: string): number {
  const version = cleanText(value).match(/\b(\d+(?:\.\d+)*)\b/)?.[1];
  if (!version) return 0;
  const [major = 0, minor = 0] = version.split(".").map((part) => Number(part));
  return (Number.isFinite(major) ? major : 0) * 100 + (Number.isFinite(minor) ? minor : 0);
}

interface ElectricalSplit {
  voltageAc?: string;
  voltageDc?: string;
  voltageRange?: string;
  operatingVoltageUb?: string;
  currentAc?: string;
  currentDc?: string;
  currentType?: string;
  ratedCurrent?: string;
  currentSumUs?: string;
  currentSumUa?: string;
  standards?: string;
  productFamily?: string;
  suitableFor?: string;
  replacedProductId?: string;
  tariffCode?: string;
  countryOfOrigin?: string;
}

function electricalSplitForExport(attributes: ProductResult["attributes"], normalized: ProductResult["normalized"]): ElectricalSplit {
  const voltageValues = collectElectricalValues(attributes, normalized.voltage, /voltage|spannung|tension/i, /\bV\b|VAC|VDC|\bV AC\b|\bV DC\b/i);
  const currentValues = collectElectricalValues(attributes, normalized.current, /current|strom|courant/i, /\bA\b|mA\b/i);

  return {
    voltageAc: pickElectricalSubset(voltageValues, /AC\b|alternating|wechsel/i).join("; ") || undefined,
    voltageDc: pickElectricalSubset(voltageValues, /DC\b|direct|gleich/i).join("; ") || undefined,
    voltageRange: pickElectricalSubset(voltageValues, /\.\.\.|to\b|-|–|—|min|max|range/i).join("; ") || undefined,
    operatingVoltageUb: dedupePipeJoinedSpec(
      joinedAttributeSpecs(
        attributes,
        [
          /^operating voltage(?:\s+ub)?$/i,
          /^betriebsspannung(?:\s+ub)?$/i,
          /^rated operating voltage(?:\s+ue)?$/i,
          /^supply voltage range$/i,
          /^rated voltage(?:\s*\(\s*u\s*r\s*\))?$/i,
          /^bemessungsspannung(?:\s*\(\s*u\s*r\s*\))?$/i,
          /^nominal voltage$/i
        ],
        3
      )
    ),
    currentAc: pickElectricalSubset(currentValues, /AC\b|alternating/i).join("; ") || undefined,
    currentDc: pickElectricalSubset(currentValues, /DC\b|direct/i).join("; ") || undefined,
    currentType: extractCurrentType(attributes, normalized),
    ratedCurrent: dedupePipeJoinedSpec(
      joinedAttributeSpecs(
        attributes,
        [/^rated current(?:\s*\(40\s*°?c\))?$/i, /^nennstrom(?:\s*\(40\s*°?c\))?$/i, /^\[in\]\s*rated current/i, /^continuous current$/i, /^current rating$/i],
        4
      )
    ),
    currentSumUs: dedupePipeJoinedSpec(
      joinedAttributeSpecs(
        attributes,
        [/^current sum us(?:,\s*sensor)?$/i, /^current sum us sensor$/i, /^summenstrom us(?:,\s*sensor)?$/i],
        2
      )
    ),
    currentSumUa: dedupePipeJoinedSpec(
      joinedAttributeSpecs(
        attributes,
        [/^current sum ua(?:,\s*actuator)?$/i, /^current sum ua actuator$/i, /^summenstrom ua(?:,\s*aktor)?$/i],
        2
      )
    ),
    standards: extractStandards(attributes),
    productFamily: dedupePipeJoinedSpec(
      joinedAttributeSpecs(
        attributes,
        [
          /^product main type$/i,
          /^product family$/i,
          /^suitable for product class$/i,
          /^product class$/i,
          /^product line$/i,
          /^series$/i,
          /^produktfamilie$/i
        ],
        3
      )
    ),
    suitableFor: dedupePipeJoinedSpec(
      joinedAttributeSpecs(attributes, [/^suitable for$/i, /^compatible with$/i, /^geeignet f[uü]r$/i, /^application$/i], 4)
    ),
    replacedProductId: dedupePipeJoinedSpec(
      joinedAttributeSpecs(
        attributes,
        [
          /^replaced product id(?:\s*\(old\))?$/i,
          /^replaces\b/i,
          /^superseded by$/i,
          /^old product id$/i,
          /^vorg[aä]ngerprodukt$/i,
          /^recommended alternative$/i
        ],
        3
      )
    ),
    tariffCode: dedupePipeJoinedSpec(
      joinedAttributeSpecs(
        attributes,
        [
          /^customs tariff number$/i,
          /^tariff code$/i,
          /^taric code$/i,
          /^taric-code$/i,
          /^hs code$/i,
          /^zolltarifnummer$/i,
          /^commodity code$/i
        ],
        2
      )
    ),
    countryOfOrigin: dedupePipeJoinedSpec(
      joinedAttributeSpecs(
        attributes,
        [/^country of origin$/i, /^herkunftsland$/i, /^origine$/i, /^made in$/i],
        2
      )
    )
  };
}

function extractCurrentType(attributes: ProductResult["attributes"], normalized: ProductResult["normalized"]): string | undefined {
  // 1) Explicit attribute (ABB "Current Type", Eaton "Current type", etc.)
  const direct = attributes.find((attr) => /^(?:current type|stromart|type de courant)$/i.test(attr.name));
  if (direct?.value) {
    const cleaned = cleanText(direct.value).toUpperCase().replace(/\s*\/\s*/g, "/");
    return /AC|DC/.test(cleaned) ? cleaned : cleanText(direct.value);
  }
  // 2) Infer from existing voltage/current strings (e.g. "110-220 V AC/DC", "250 V DC", "4 A AC").
  const haystacks = [normalized.voltage, normalized.current, ...attributes.filter((attr) => /voltage|current/i.test(attr.name)).map((attr) => attr.value)]
    .filter((value): value is string => Boolean(value))
    .map((value) => cleanText(value).toUpperCase());
  let hasAc = false;
  let hasDc = false;
  for (const value of haystacks) {
    if (/\bAC\/DC\b|\bAC-DC\b|\bVAC\/DC\b|\bV\s*AC\/DC\b/.test(value)) return "AC/DC";
    if (/\bAC\b|\bVAC\b|\bV\s*AC\b/.test(value)) hasAc = true;
    if (/\bDC\b|\bVDC\b|\bV\s*DC\b/.test(value)) hasDc = true;
  }
  if (hasAc && hasDc) return "AC/DC";
  if (hasAc) return "AC";
  if (hasDc) return "DC";
  return undefined;
}

function extractStandards(attributes: ProductResult["attributes"]): string | undefined {
  // Prefer explicit "Standards" attribute (ABB: "IEC/UL", Schneider: "EN 60947-2", etc.)
  const direct = attributes.filter((attr) => /^(standards?|applicable standards?|conforms to|normen|normes?)$/i.test(attr.name));
  const tokens = new Set<string>();
  for (const attr of direct) {
    for (const piece of cleanText(attr.value).split(/[;,\/\|]+/)) {
      const value = cleanText(piece);
      if (value && value.length < 60) tokens.add(value);
    }
  }
  // Also scan all attribute values for IEC/UL/EN/IEEE/DIN/ANSI standard codes.
  if (tokens.size === 0) {
    for (const attr of attributes) {
      const value = cleanText(attr.value);
      const matches = value.match(/\b(?:IEC|UL|EN|IEEE|DIN|ANSI|CSA|VDE|JIS)\s*\d+[A-Z0-9.\-/:]*\b/g);
      if (!matches) continue;
      for (const match of matches) tokens.add(cleanText(match));
      if (tokens.size >= 10) break;
    }
  }
  return tokens.size ? [...tokens].slice(0, 10).join("; ") : undefined;
}

function collectElectricalValues(
  attributes: ProductResult["attributes"],
  normalizedFallback: string | undefined,
  labelPattern: RegExp,
  unitPattern: RegExp
): string[] {
  const candidates: string[] = [];
  for (const attr of attributes) {
    const label = `${attr.group ?? ""} ${attr.name}`;
    if (!labelPattern.test(label)) continue;
    for (const piece of splitElectricalValue(attr.value)) {
      if (unitPattern.test(piece)) candidates.push(piece);
    }
  }
  if (normalizedFallback) {
    for (const piece of splitElectricalValue(normalizedFallback)) {
      if (unitPattern.test(piece)) candidates.push(piece);
    }
  }
  const seen = new Set<string>();
  return candidates.filter((value) => {
    const key = value.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitElectricalValue(value: string | undefined): string[] {
  if (!value) return [];
  return cleanText(value)
    .split(/\s*(?:\||;|,| or )\s*/)
    .map((piece) => cleanText(piece))
    .filter(Boolean);
}

function pickElectricalSubset(values: string[], pattern: RegExp): string[] {
  return values.filter((value) => pattern.test(value));
}

function dedupePipeJoinedSpec(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.includes("|")) return value;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const piece of value.split(/\s*\|\s*/)) {
    const trimmed = cleanText(piece);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(trimmed);
  }
  return parts.join(" | ") || undefined;
}

function ipRatingForExport(attributes: ProductResult["attributes"], protection: string | undefined): string | undefined {
  return joinedProtectionTokens(attributes, protection, /\bIP\s*\d{2}[A-Z]?\b/gi, (value) => value.toUpperCase().replace(/\s+/g, ""));
}

function ikRatingForExport(attributes: ProductResult["attributes"], protection: string | undefined): string | undefined {
  return joinedProtectionTokens(attributes, protection, /\bIK\s*\d{2}\b/gi, (value) => value.toUpperCase().replace(/\s+/g, ""));
}

function nemaRatingForExport(attributes: ProductResult["attributes"], protection: string | undefined): string | undefined {
  const values: string[] = [];
  for (const text of protectionTextsForExport(attributes, protection)) {
    for (const match of text.matchAll(/\bNEMA\s*(?:Type\s*)?([0-9][0-9A-Z]*(?:\s*,\s*[0-9][0-9A-Z]*)*)\b/gi)) {
      for (const rating of splitRatingList(match[1])) values.push(`NEMA ${rating}`);
    }
    if (/\b(?:nema|degree of protection|environmental rating|enclosure|protection)\b/i.test(text)) {
      for (const match of text.matchAll(/\b(?:UL\/CSA\s*)?Types?\s+([0-9][0-9A-Z]*(?:\s*,\s*[0-9][0-9A-Z]*)*)\b/gi)) {
        for (const rating of splitRatingList(match[1])) values.push(`Type ${rating}`);
      }
    }
  }
  return uniqueStrings(values).join("; ") || undefined;
}

function joinedProtectionTokens(
  attributes: ProductResult["attributes"],
  protection: string | undefined,
  pattern: RegExp,
  normalize: (value: string) => string
): string | undefined {
  const values = protectionTextsForExport(attributes, protection).flatMap((text) => [...text.matchAll(pattern)].map((match) => normalize(match[0])));
  return uniqueStrings(values).join("; ") || undefined;
}

function protectionTextsForExport(attributes: ProductResult["attributes"], protection: string | undefined): string[] {
  const protectionAttrs = attributes
    .filter((attr) => /(?:ip|ik|nema|degree of protection|environmental rating|enclosure|protection)/i.test(`${attr.group ?? ""} ${attr.name}`))
    .map((attr) => `${attr.name}: ${attr.value}`);
  return uniqueStrings([protection, ...protectionAttrs].filter((value): value is string => Boolean(value)));
}

function splitRatingList(value: string): string[] {
  return value
    .split(/\s*,\s*/)
    .map((item) =>
      cleanText(item)
        .replace(/^NEMA\s*(?:Type\s*)?/i, "")
        .replace(/^Type\s*/i, "")
        .replace(/\b(?:indoor|outdoor|only|use)\b.*$/i, "")
        .trim()
    )
    .filter((item) => /^[0-9A-Z]+$/i.test(item));
}

function documentSpecLines(documents: ProductResult["documents"], maxLines: number): string[] {
  const lines = [...documents]
    .filter((doc) => doc.type !== "image" && (usefulSummaryValue(doc.label) || usefulSummaryValue(doc.url)))
    .sort((left, right) => documentSummaryRank(left) - documentSummaryRank(right))
    .map((doc) => specLine(documentTypeLabel(doc.type), doc.label || doc.url))
    .filter((line): line is string => Boolean(line));
  return uniqueStrings(lines).slice(0, maxLines);
}

function imageGalleryForExport(documents: ProductResult["documents"]): string | undefined {
  const lines = [...documents]
    .filter((doc) => doc.type === "image")
    .sort((left, right) => documentSummaryRank(left) - documentSummaryRank(right) || left.label.localeCompare(right.label, undefined, { sensitivity: "base" }))
    .map((doc) => {
      const label = cleanText(doc.label) || "Product image";
      const candidates = doc.candidateUrls?.filter((url) => url !== doc.url).join("; ");
      return cleanText(`${label}: ${doc.url}${candidates ? ` (candidates: ${candidates})` : ""}`);
    });
  return truncateExcelCell(uniqueStrings(lines).join("\n"));
}

function allSpecificationsForExport(attributes: ProductResult["attributes"]): string | undefined {
  const grouped = new Map<string, string[]>();
  for (const attr of sortAttributes(attributes)) {
    if (!usefulSummaryValue(attr.value)) continue;
    const group = cleanText(attr.group) || "Specifications";
    const line = specLine(attr.name, attr.value);
    if (!line) continue;
    const lines = grouped.get(group) ?? [];
    lines.push(line);
    grouped.set(group, lines);
  }

  const sections = [...grouped.entries()]
    .map(([group, lines]) => `[${group}]\n${uniqueStrings(lines).join("\n")}`)
    .filter(Boolean);
  return truncateExcelCell(sections.join("\n\n"));
}

function allResourcesForExport(documents: ProductResult["documents"]): string | undefined {
  const lines = [...documents]
    .sort((left, right) => documentSummaryRank(left) - documentSummaryRank(right) || left.label.localeCompare(right.label, undefined, { sensitivity: "base" }))
    .map((doc) => {
      const label = cleanText(doc.label) || doc.url;
      const candidates = doc.candidateUrls?.filter((url) => url !== doc.url).join("; ");
      return cleanText(`${documentTypeLabel(doc.type)}: ${label} - ${doc.url}${candidates ? ` (candidates: ${candidates})` : ""}`);
    });
  return truncateExcelCell(uniqueStrings(lines).join("\n"));
}

function truncateExcelCell(value: string | undefined, maxLength = 32000): string | undefined {
  const cleaned = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 80).trimEnd()}\n... truncated; see Attributes sheet for complete raw specifications.`;
}

function documentSummaryRank(doc: ProductResult["documents"][number]): number {
  const ranks: Record<ProductResult["documents"][number]["type"], number> = {
    datasheet: 10,
    manual: 20,
    cad: 30,
    certificate: 40,
    image: 50,
    other: 60
  };
  return ranks[doc.type] ?? 99;
}

function documentTypeLabel(type: ProductResult["documents"][number]["type"]): string {
  if (type === "cad") return "CAD";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function firstAttributeValue(attributes: ProductResult["attributes"], namePatterns: RegExp[], maxLength = 260): string | undefined {
  const attr = attributes
    .filter((candidate) => namePatterns.some((pattern) => pattern.test(candidate.name)) && usefulSummaryValue(candidate.value))
    .sort((left, right) => summaryAttributeScore(right) - summaryAttributeScore(left))[0];
  return compactSpecValue(attr?.value, maxLength);
}

function usefulSummaryValue(value: string | undefined): boolean {
  const cleaned = cleanText(value);
  return Boolean(cleaned && cleaned !== "-" && !/^n\/?a$/i.test(cleaned));
}

function compactSpecValue(value: string | undefined, maxLength = 260): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned) return undefined;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3).trimEnd()}...` : cleaned;
}

function compactComplianceSummaryValue(value: string): string | undefined {
  const cleaned = cleanText(value);
  if (!/\d+(?:[.,]\d+)?\s*(?:KB|MB|GB)/i.test(cleaned)) return cleaned;
  const tokens = extractComplianceSummaryTokens(cleaned);
  if (tokens.length) return tokens.join("; ");
  const withoutResourceMetadata = cleaned
    .replace(/\s*\d+(?:[.,]\d+)?\s*(?:KB|MB|GB)\s*(?:English|German|Deutsch|French|Spanish|Italian|Dutch|Polish|Czech|Danish|Swedish|Norwegian|Finnish|Portuguese|Chinese|Japanese|Korean)?/gi, "")
    .replace(/\b(?:English|German|Deutsch|French|Spanish|Italian|Dutch|Polish|Czech|Danish|Swedish|Norwegian|Finnish|Portuguese|Chinese|Japanese|Korean)\b\s*$/i, "")
    .replace(/\s*[-,;:]\s*$/g, "")
    .trim();
  return withoutResourceMetadata || undefined;
}

function extractComplianceSummaryTokens(value: string): string[] {
  const readable = value.replace(
    /\d+(?:[.,]\d+)?\s*(?:KB|MB|GB)\s*(?:English|German|Deutsch|French|Spanish|Italian|Dutch|Polish|Czech|Danish|Swedish|Norwegian|Finnish|Portuguese|Chinese|Japanese|Korean)?(?=[A-Z])/gi,
    " "
  );
  return uniqueStrings([
    ...(readable.match(/\bUL\s+File(?:\s+No\.?)?\s+[A-Z]*\d[A-Z0-9_-]*/gi) ?? []),
    ...(readable.match(/\bCSA\s+File(?:\s+No\.?)?\s+[A-Z]*\d[A-Z0-9_-]*/gi) ?? []),
    ...(readable.match(/\bCSA\s+C22\.2\s+No\.?\s+\d+(?:\.\d+)*/gi) ?? []),
    ...(readable.match(/\bUL\s+\d+(?:\.\d+)*/gi) ?? []),
    ...(readable.match(/\bNEMA\s+BI\s+\d+/gi) ?? []),
    ...(readable.match(/\bIEC\s+\d+(?:[.-]\d+)*/g) ?? []),
    ...(readable.match(/\bFM\d+[A-Z0-9-]*/g) ?? []),
    ...(readable.match(/\bcULus\b/g) ?? []),
    ...(readable.match(/\bcUL\b/g) ?? []),
    ...(readable.match(/\bUKCA\b/g) ?? []),
    ...(readable.match(/\bRoHS\b/gi) ?? []),
    ...(readable.match(/\bREACH\b/gi) ?? []),
    ...(readable.match(/\bWEEE\b/gi) ?? []),
    ...(readable.match(/\bTSCA\b/gi) ?? []),
    ...(readable.match(/\bProp\s*65\b/gi) ?? []),
    ...(readable.match(/\bCSA\b/g) ?? []),
    ...(readable.match(/\bUL\b/g) ?? []),
    ...(readable.match(/\bCE\b/g) ?? [])
  ]).map((token) =>
    cleanText(token)
      .replace(/^reach$/i, "REACH")
      .replace(/^rohs$/i, "RoHS")
      .replace(/^weee$/i, "WEEE")
      .replace(/^prop\s*65$/i, "Prop 65")
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function summaryAttributeScore(attr: ProductResult["attributes"][number]): number {
  let score = 0;
  if (attr.sourceType === "official") score += 100;
  if (attr.sourceType === "official-fallback") score += 80;
  if (/abb product data/i.test(attr.group ?? "")) score += 40;
  if (/^abb\b/i.test(attr.group ?? "")) score += 35;
  if (/sce (?:product data|catalog inference)/i.test(attr.group ?? "")) score += 40;
  if (/schneider (?:product info|main|complementary|environment|ordering|packing|contractual|sustainability|selected variant|product hierarchy|description|commercial)/i.test(attr.group ?? "")) score += 45;
  if (/balluff (?:summary features|key features|classifications|component data)/i.test(attr.group ?? "")) score += 45;
  if (/^(?:embedded product table|embedded spec rows|product specifications|specifications|features|industry standards)$/i.test(attr.group ?? "")) score += 35;
  if (/^(general specifications|delivery program|general information|product specifications|technical data|technical information|performance ratings|physical attributes|miscellaneous)$/i.test(attr.group ?? "")) {
    score += 45;
  }
  if (/legacy|marker/i.test(attr.group ?? "")) score += 15;
  if (/plain text|meta|structured data/i.test(attr.group ?? "")) score -= 20;
  if (attr.confidence !== undefined) score += Math.round(attr.confidence * 10);
  return score;
}

function descriptionFromAttributes(result?: ProductResult): string | undefined {
  if (!result) return undefined;
  return result.attributes
    .filter((attr) => /description/i.test(`${attr.group ?? ""} ${attr.name}`))
    .map((attr) => cleanText(attr.value))
    .find(
      (candidate) =>
        Boolean(candidate) &&
        candidate !== result.title &&
        candidate !== result.catalogNumber &&
        candidate !== "Description" &&
        !/^[A-Z]{2,8}-[A-Z0-9-]+$/i.test(candidate)
    );
}

function documentsForExport(result?: ProductResult): ProductResult["documents"] {
  if (!result) return [];
  if (result.manufacturerId !== "sce") return result.documents;
  const catalogNumber = result.catalogNumber.toLowerCase();
  return result.documents.filter(
    (doc) =>
      doc.type !== "image" ||
      doc.url.toLowerCase().includes(catalogNumber) ||
      doc.label.toLowerCase().includes(catalogNumber) ||
      doc.candidateUrls?.some((url) => url.toLowerCase().includes(catalogNumber))
  );
}

function missingRequiredFields(row: {
  manufacturer: ManufacturerConfig;
  result?: ProductResult;
  productUrlEn?: string;
  productUrlDe?: string;
  weightLb?: number;
  weightKg?: number;
  heightIn?: number;
  widthIn?: number;
  depthIn?: number;
  lengthIn?: number;
  heightMm?: number;
  widthMm?: number;
  depthMm?: number;
  lengthMm?: number;
  material?: string;
  wallThicknessIn?: number;
  wallThicknessMm?: number;
  finish?: string;
  color?: string;
  voltage?: string;
  current?: string;
  certificates?: string;
}): string | undefined {
  const hasWeight = row.weightLb !== undefined || row.weightKg !== undefined;
  const hasDimensions = [row.heightIn, row.widthIn, row.depthIn, row.lengthIn, row.heightMm, row.widthMm, row.depthMm, row.lengthMm].some(
    (value) => value !== undefined
  );
  const classification = row.result ? classifyDeviceType(row.result) : undefined;
  const electricalFields = row.result
    ? requiredElectricalFields(row.result, {
        deviceType: classification?.type,
        deviceTypeConfidence: classification?.confidence,
        deviceTypeElectricalFields: electricalFieldsForDeviceType(classification?.type)
      })
    : [];
  const missing = [
    row.productUrlEn ? undefined : "English URL",
    row.productUrlDe || row.manufacturer.id === "sce" ? undefined : "German URL",
    hasWeight ? undefined : "Weight",
    hasDimensions ? undefined : "Dimensions",
    electricalFields.includes("voltage") && !row.voltage ? "Voltage" : undefined,
    electricalFields.includes("current") && !row.current ? "Current" : undefined,
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

function applyUsabilityFormatting(sheet: ExcelJS.Worksheet) {
  linkifyWorksheet(sheet);
  styleHyperlinkObjects(sheet);
  styleStatusColumn(sheet);
  styleExportDecisionColumn(sheet);
  styleReviewPriorityColumn(sheet);
  styleSeverityColumn(sheet);
  styleActionColumn(sheet, "Action Needed");
  styleActionColumn(sheet, "Suggested Action");
  applyReviewWorkflowFormatting(sheet);
  styleYesNoColumn(sheet, "Import Ready");
  styleYesNoColumn(sheet, "Document Ready");
  styleYesNoColumn(sheet, "Fix Needed");
  styleYesNoColumn(sheet, "Primary");
  styleBooleanColumn(sheet, "Quality Gate Passed");
  styleCoverageScoreColumn(sheet);
  styleConfidenceColumn(sheet);
  styleQualityTierColumn(sheet);
  styleOkMissingCells(sheet);
  styleImportantMissingFieldCells(sheet);
}

function applyWorkbookUsability(workbook: ExcelJS.Workbook) {
  workbook.eachSheet((sheet) => {
    const color = sheetTabColor(sheet.name);
    if (color) sheet.properties.tabColor = { argb: color };
  });
}

function sheetTabColor(sheetName: string): string | undefined {
  if (sheetName === "Run Summary") return "FF0F172A";
  if (sheetName === "Clean Export") return "FF166534";
  if (sheetName === "Import Ready") return "FF15803D";
  if (sheetName === AI_CLEANED_INPUT_SHEET) return "FF0EA5E9";
  if (sheetName === "Needs Review") return "FFB45309";
  if (sheetName === "Issue Summary") return "FFE11D48";
  if (sheetName === "Column Guide") return "FF0891B2";
  if (sheetName === "Checks" || sheetName === "Final Audit") return "FFB91C1C";
  if (sheetName.startsWith("Clean ")) return "FF2563EB";
  if (["Products", "Attributes", "Documents", "Sources", "Evidence", "Failures"].includes(sheetName)) return "FF64748B";
  if (sheetName === "XLOOKUP" || sheetName === "Field Coverage" || sheetName === "Spec Matrix") return "FF7C3AED";
  return undefined;
}

function styleHyperlinkObjects(sheet: ExcelJS.Worksheet) {
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      if (!cell.hyperlink) return;
      cell.font = { ...(cell.font ?? {}), color: { argb: "FF2563EB" }, underline: true };
    });
  });
}

function linkifyWorksheet(sheet: ExcelJS.Worksheet) {
  for (let columnNumber = 1; columnNumber <= sheet.columnCount; columnNumber += 1) {
    const header = cleanText(String(sheet.getRow(1).getCell(columnNumber).value ?? ""));
    if (!/\burl\b/i.test(header) && !/\blocal path\b/i.test(header)) continue;
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const cell = sheet.getRow(rowNumber).getCell(columnNumber);
      if (typeof cell.value !== "string") continue;
      const target = singleCellHyperlinkTarget(cell.value);
      if (!target) continue;
      const text = cell.value;
      cell.value = { text, hyperlink: target, tooltip: text };
      cell.font = { ...(cell.font ?? {}), color: { argb: "FF2563EB" }, underline: true };
    }
  }
}

function singleCellHyperlinkTarget(value: string): string | undefined {
  const text = value.trim();
  if (!text || /[\r\n;]/.test(text)) return undefined;
  if (/^https?:\/\/\S+$/i.test(text)) return text;
  if (/^[a-z]:[\\/]/i.test(text)) {
    try {
      return pathToFileURL(path.resolve(text)).toString();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function styleStatusColumn(sheet: ExcelJS.Worksheet) {
  const statusColumn = headerColumnNumber(sheet, "Status");
  if (!statusColumn) return;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cell = sheet.getRow(rowNumber).getCell(statusColumn);
    const status = cleanText(cell.text || String(cell.value ?? "")).toLowerCase();
    if (!status) continue;
    const color =
      status === "found" || status === "completed"
        ? "FFDCFCE7"
        : status === "partial" || status === "running"
          ? "FFFEF3C7"
          : status === "failed" || status === "cancelled"
            ? "FFFEE2E2"
            : undefined;
    if (!color) continue;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  }
}

function styleExportDecisionColumn(sheet: ExcelJS.Worksheet) {
  const columnNumber = headerColumnNumber(sheet, "Export Decision");
  if (!columnNumber) return;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cell = sheet.getRow(rowNumber).getCell(columnNumber);
    const value = cleanText(cell.text || String(cell.value ?? ""));
    const color = value === "Import" ? "FFDCFCE7" : value === "Review" ? "FFFEF3C7" : value === "Exclude" ? "FFFEE2E2" : undefined;
    if (!color) continue;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  }
}

function styleBooleanColumn(sheet: ExcelJS.Worksheet, headerName: string) {
  const columnNumber = headerColumnNumber(sheet, headerName);
  if (!columnNumber) return;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cell = sheet.getRow(rowNumber).getCell(columnNumber);
    if (cell.value !== true && cell.value !== false) continue;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cell.value ? "FFDCFCE7" : "FFFEE2E2" } };
    cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  }
}

function styleReviewPriorityColumn(sheet: ExcelJS.Worksheet) {
  const columnNumber = headerColumnNumber(sheet, "Review Priority");
  if (!columnNumber) return;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cell = sheet.getRow(rowNumber).getCell(columnNumber);
    const value = cleanText(cell.text || String(cell.value ?? ""));
    const color = value === "High" ? "FFFEE2E2" : value === "Medium" ? "FFFEF3C7" : value === "Low" ? "FFDCFCE7" : undefined;
    if (!color) continue;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  }
}

function styleYesNoColumn(sheet: ExcelJS.Worksheet, headerName: string) {
  const columnNumber = headerColumnNumber(sheet, headerName);
  if (!columnNumber) return;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cell = sheet.getRow(rowNumber).getCell(columnNumber);
    const value = cleanText(cell.text || String(cell.value ?? ""));
    if (value !== "Yes" && value !== "No") continue;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: value === "Yes" ? "FFDCFCE7" : "FFFEE2E2" } };
    cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  }
}

function styleSeverityColumn(sheet: ExcelJS.Worksheet) {
  const columnNumber = headerColumnNumber(sheet, "Severity");
  if (!columnNumber) return;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cell = sheet.getRow(rowNumber).getCell(columnNumber);
    const value = cleanText(cell.text || String(cell.value ?? ""));
    const color = value === "High" ? "FFFEE2E2" : value === "Medium" ? "FFFEF3C7" : value === "Low" ? "FFE0F2FE" : value === "Info" ? "FFE2E8F0" : undefined;
    if (!color) continue;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  }
}

function styleActionColumn(sheet: ExcelJS.Worksheet, headerName: string) {
  const columnNumber = headerColumnNumber(sheet, headerName);
  if (!columnNumber) return;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cell = sheet.getRow(rowNumber).getCell(columnNumber);
    const value = cleanText(cell.text || String(cell.value ?? ""));
    if (!value) continue;
    const ready = value === "Ready";
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ready ? "FFDCFCE7" : "FFFFF7ED" } };
    cell.font = { ...(cell.font ?? {}), color: { argb: "FF111827" }, bold: ready };
  }
}

function applyReviewWorkflowFormatting(sheet: ExcelJS.Worksheet) {
  const statusColumn = headerColumnNumber(sheet, "Review Status");
  const fixColumn = headerColumnNumber(sheet, "Fix Needed");
  const reviewerColumn = headerColumnNumber(sheet, "Reviewed By");
  const notesColumn = headerColumnNumber(sheet, "Review Notes");
  if (!statusColumn && !fixColumn && !reviewerColumn && !notesColumn) return;

  const lastRow = sheet.rowCount;
  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
    if (statusColumn) {
      const cell = sheet.getRow(rowNumber).getCell(statusColumn);
      cell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ['"Open,Checked,Needs manual lookup,Ignore"']
      };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
    if (fixColumn) {
      const cell = sheet.getRow(rowNumber).getCell(fixColumn);
      cell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ['"Yes,No,Maybe"']
      };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
    for (const columnNumber of [reviewerColumn, notesColumn].filter((value): value is number => Boolean(value))) {
      sheet.getRow(rowNumber).getCell(columnNumber).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
  }
}

function styleOkMissingCells(sheet: ExcelJS.Worksheet) {
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      const value = cleanText(cell.text || String(cell.value ?? ""));
      if (value !== "OK" && value !== "Missing") return;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: value === "OK" ? "FFDCFCE7" : "FFFEE2E2" } };
      cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
  });
}

function styleImportantMissingFieldCells(sheet: ExcelJS.Worksheet) {
  const fieldColumns = importantFieldColumns(sheet);
  if (!fieldColumns.length) return;
  const missingRequiredColumn = headerColumnNumber(sheet, "Missing Required Fields");
  const finalCompletenessColumn = headerColumnNumber(sheet, "Final Completeness Check");
  const missingKeyColumn = headerColumnNumber(sheet, "Missing Key Fields");

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const missing = importantMissingFields(
      cleanText(missingRequiredColumn ? row.getCell(missingRequiredColumn).text || String(row.getCell(missingRequiredColumn).value ?? "") : ""),
      cleanText(finalCompletenessColumn ? row.getCell(finalCompletenessColumn).text || String(row.getCell(finalCompletenessColumn).value ?? "") : ""),
      cleanText(missingKeyColumn ? row.getCell(missingKeyColumn).text || String(row.getCell(missingKeyColumn).value ?? "") : "")
    );
    if (!missing.size) continue;

    for (const { field, columns } of fieldColumns) {
      if (!missing.has(field)) continue;
      for (const column of columns) {
        const cell = row.getCell(column);
        if (cellHasUsefulValue(cell)) continue;
        markMissingImportantCell(cell);
      }
    }
  }
}

function importantFieldColumns(sheet: ExcelJS.Worksheet): Array<{ field: string; columns: number[] }> {
  const groups: Array<{ field: string; headers: string[] }> = [
    { field: "image", headers: ["Image", "Image URL", "Image Local Path"] },
    { field: "weight", headers: ["Weight", "Weight (kg)", "Weight (lb)"] },
    { field: "dimensions", headers: ["Dimensions", "Height (mm)", "Width (mm)", "Depth (mm)", "Length (mm)", "Height (in)", "Width (in)", "Depth (in)", "Length (in)"] },
    { field: "material", headers: ["Material"] },
    { field: "color", headers: ["Color"] },
    { field: "voltage", headers: ["Voltage", "Voltage AC", "Voltage DC", "Voltage Range", "Operating Voltage Ub / Ur"] },
    { field: "current", headers: ["Current", "Rated Current", "Current AC", "Current DC", "Current Sum US (sensor)", "Current Sum UA (actuator)", "Current Sum US", "Current Sum UA"] },
    { field: "protection", headers: ["Protection", "IP Rating", "NEMA / Type Rating"] },
    { field: "certificates", headers: ["Certificates", "Standards"] },
    { field: "operatingTemperature", headers: ["Operating Temperature"] },
    { field: "typeCode", headers: ["Product Type"] }
  ];

  return groups
    .map((group) => ({
      field: group.field,
      columns: group.headers.map((header) => headerColumnNumber(sheet, header)).filter((value): value is number => Boolean(value))
    }))
    .filter((group) => group.columns.length > 0);
}

function importantMissingFields(...texts: string[]): Set<string> {
  const fields = new Set<string>();
  for (const raw of texts) {
    const text = cleanText(raw);
    if (!text) continue;
    for (const part of text.split(/[;,]/).map((item) => cleanText(item)).filter(Boolean)) {
      const field = missingFieldKey(part);
      if (field && missingFieldPhraseIndicatesProblem(part)) fields.add(field);
    }
  }
  return fields;
}

function missingFieldPhraseIndicatesProblem(value: string): boolean {
  if (/not[-\s]?applicable|n\/a/i.test(value)) return false;
  if (/present|found|ok|passed/i.test(value) && !/missing|not published|retry skipped|skipped/i.test(value)) return false;
  return /missing|not published|retry skipped|skipped|^image$|^weight$|^dimensions$|^material$|^color$|^voltage$|^current$|^protection$|^certificates$|^operating temperature$|^type code$/i.test(value);
}

function missingFieldKey(value: string): string | undefined {
  const normalized = cleanText(value)
    .replace(/:.+$/i, "")
    .replace(/^normalized:/i, "")
    .trim()
    .toLowerCase();
  if (/^image$|product image/.test(normalized)) return "image";
  if (/^weight$|weight \(/.test(normalized)) return "weight";
  if (/^dimensions?$|height|width|depth|length/.test(normalized)) return "dimensions";
  if (/^material$/.test(normalized)) return "material";
  if (/^colou?r$/.test(normalized)) return "color";
  if (/^voltage$|operating voltage|supply voltage/.test(normalized)) return "voltage";
  if (/^current$|rated current/.test(normalized)) return "current";
  if (/^protection$|ip rating|nema/.test(normalized)) return "protection";
  if (/^certificates?$|standards?/.test(normalized)) return "certificates";
  if (/operating temperature|temperature/.test(normalized)) return "operatingTemperature";
  if (/type code|typecode|product type/.test(normalized)) return "typeCode";
  return undefined;
}

function cellHasUsefulValue(cell: ExcelJS.Cell): boolean {
  const value = cell.value;
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "object" && "text" in value) return Boolean(cleanText(String(value.text ?? "")));
  return Boolean(cleanText(cell.text || String(value)));
}

function markMissingImportantCell(cell: ExcelJS.Cell) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: MISSING_IMPORTANT_FILL } };
  cell.font = { ...(cell.font ?? {}), color: { argb: MISSING_IMPORTANT_FONT }, bold: true };
}

function styleCoverageScoreColumn(sheet: ExcelJS.Worksheet) {
  const columnNumber = headerColumnNumber(sheet, "Coverage Score");
  if (!columnNumber) return;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cell = sheet.getRow(rowNumber).getCell(columnNumber);
    const value = typeof cell.value === "number" ? cell.value : Number(cell.value);
    if (!Number.isFinite(value)) continue;
    const color = value >= 0.8 ? "FFDCFCE7" : value >= 0.6 ? "FFFEF3C7" : "FFFEE2E2";
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.numFmt = "0%";
  }
}

function styleConfidenceColumn(sheet: ExcelJS.Worksheet) {
  const columnNumber = headerColumnNumber(sheet, "Confidence");
  if (!columnNumber) return;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cell = sheet.getRow(rowNumber).getCell(columnNumber);
    const value = typeof cell.value === "number" ? cell.value : Number(cell.value);
    if (!Number.isFinite(value)) continue;
    const color = value >= 0.85 ? "FFDCFCE7" : value >= 0.65 ? "FFFEF3C7" : "FFFEE2E2";
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.numFmt = "0%";
  }
}

function styleQualityTierColumn(sheet: ExcelJS.Worksheet) {
  const columnNumber = headerColumnNumber(sheet, "Quality Tier");
  if (!columnNumber) return;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cell = sheet.getRow(rowNumber).getCell(columnNumber);
    const value = cleanText(cell.text || String(cell.value ?? ""));
    const color =
      value === "Complete" || value === "Good"
        ? "FFDCFCE7"
        : value === "Usable"
          ? "FFFEF3C7"
          : value === "Sparse"
            ? "FFFFEDD5"
            : value === "No data"
              ? "FFFEE2E2"
              : undefined;
    if (!color) continue;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  }
}

function headerColumnNumber(sheet: ExcelJS.Worksheet, headerName: string): number | undefined {
  const header = sheet.getRow(1);
  for (let columnNumber = 1; columnNumber <= sheet.columnCount; columnNumber += 1) {
    if (cleanText(String(header.getCell(columnNumber).value ?? "")).toLowerCase() === headerName.toLowerCase()) {
      return columnNumber;
    }
  }
  return undefined;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
