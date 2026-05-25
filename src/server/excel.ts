import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { FinalCompletenessRecord, ManufacturerConfig, ProductResult, RunItemRecord, RunRecord } from "../shared/types.js";
import { requiredElectricalFields } from "../shared/product-requirements.js";
import { buildLocalizedProductUrls } from "./scrapers/localized-urls.js";
import { cleanText, normalizeFields } from "./scrapers/normalizer.js";

const POUND_TO_KILOGRAM = 0.45359237;
const INCH_TO_MILLIMETER = 25.4;

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
  const evidence = workbook.addWorksheet("Evidence", { views: [{ state: "frozen", ySplit: 1 }] });
  const finalAudit = workbook.addWorksheet("Final Audit", { views: [{ state: "frozen", ySplit: 1 }] });
  const failures = workbook.addWorksheet("Failures", { views: [{ state: "frozen", ySplit: 1 }] });

  products.columns = [
    { header: "Manufacturer", key: "manufacturer", width: 18 },
    { header: "Short Name", key: "shortName", width: 12 },
    { header: "Catalog Number", key: "catalogNumber", width: 24 },
    { header: "Status", key: "status", width: 12 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Title", key: "title", width: 42 },
    { header: "Description", key: "description", width: 56 },
    { header: "Product Type", key: "productType", width: 30 },
    { header: "EAN / GTIN", key: "ean", width: 20 },
    { header: "All Specifications", key: "allSpecifications", width: 100 },
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
    { header: "Weight (lb)", key: "weightLb", width: 14, style: { numFmt: "0.#########" } },
    { header: "Weight (kg)", key: "weightKg", width: 14, style: { numFmt: "0.#########" } },
    { header: "Height (in)", key: "heightIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Width (in)", key: "widthIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Depth (in)", key: "depthIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Length (in)", key: "lengthIn", width: 14, style: { numFmt: "0.#########" } },
    { header: "Height (mm)", key: "heightMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Width (mm)", key: "widthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Depth (mm)", key: "depthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Length (mm)", key: "lengthMm", width: 14, style: { numFmt: "0.#########" } },
    { header: "Material", key: "material", width: 28 },
    { header: "Wall Thickness (in)", key: "wallThicknessIn", width: 20, style: { numFmt: "0.#########" } },
    { header: "Wall Thickness (mm)", key: "wallThicknessMm", width: 20, style: { numFmt: "0.#########" } },
    { header: "Finish", key: "finish", width: 46 },
    { header: "Color", key: "color", width: 28 },
    { header: "Voltage", key: "voltage", width: 20 },
    { header: "Voltage AC", key: "voltageAc", width: 18 },
    { header: "Voltage DC", key: "voltageDc", width: 18 },
    { header: "Voltage Range", key: "voltageRange", width: 22 },
    { header: "Operating Voltage Ub / Ur", key: "operatingVoltageUb", width: 26 },
    { header: "Current", key: "current", width: 20 },
    { header: "Current AC", key: "currentAc", width: 18 },
    { header: "Current DC", key: "currentDc", width: 18 },
    { header: "Current Type", key: "currentType", width: 14 },
    { header: "Rated Current", key: "ratedCurrent", width: 18 },
    { header: "Current Sum US (sensor)", key: "currentSumUs", width: 24 },
    { header: "Current Sum UA (actuator)", key: "currentSumUa", width: 26 },
    { header: "Standards", key: "standards", width: 28 },
    { header: "Product Family / Class", key: "productFamily", width: 36 },
    { header: "Suitable For", key: "suitableFor", width: 36 },
    { header: "Replaced Product ID", key: "replacedProductId", width: 24 },
    { header: "Tariff Code (HS)", key: "tariffCode", width: 18 },
    { header: "Country of Origin", key: "countryOfOrigin", width: 18 },
    { header: "Protection", key: "protection", width: 28 },
    { header: "IP Rating", key: "ipRating", width: 18 },
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
    { header: "Certificates", key: "certificates", width: 36 },
    { header: "Page Attribute Count", key: "attributeCount", width: 18 },
    { header: "Document Count", key: "documentCount", width: 14 },
    { header: "Quality Gate Passed", key: "qualityPassed", width: 18 },
    { header: "Quality Score", key: "qualityScore", width: 14 },
    { header: "Quality Missing", key: "qualityMissing", width: 48 },
    { header: "Fallback Stages", key: "fallbackStages", width: 32 },
    { header: "Final Completeness Check", key: "finalCompletenessCheck", width: 56 },
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
    { header: "Source Type", key: "sourceType", width: 18 },
    { header: "Parser", key: "parser", width: 26 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Source URL", key: "sourceUrl", width: 60 }
  ];

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

  for (const item of input.items) {
    const result = item.result;
    const productExcelRow = products.addRow(productRow(input.manufacturer, item, result));
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

  for (const sheet of [products, attributes, documents, sources, evidence, finalAudit, failures]) {
    styleSheet(sheet);
  }

  const inputNamePart = input.run.inputFileName ? safeWorkbookPart(path.parse(input.run.inputFileName).name) : "";
  const outputName = [
    safeWorkbookPart(input.manufacturer.shortName),
    inputNamePart,
    `product-scrape-${input.run.id}`
  ].filter(Boolean).join(".");
  const outputPath = path.join(input.outputDir, `${outputName}.xlsx`);
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
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
  const technical = technicalHighlightsForExport(result?.attributes ?? [], normalized);
  const electrical = electricalSplitForExport(result?.attributes ?? [], normalized);
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
    voltage: normalized.voltage,
    current: normalized.current,
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
    weightLb: row.weightLb,
    weightKg: row.weightKg,
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
    voltage: dedupePipeJoinedSpec(normalized.voltage),
    voltageAc: electrical.voltageAc,
    voltageDc: electrical.voltageDc,
    voltageRange: electrical.voltageRange,
    operatingVoltageUb: electrical.operatingVoltageUb,
    current: dedupePipeJoinedSpec(normalized.current),
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
    attributeCount: result?.attributes.length ?? 0,
    documentCount: documents.length,
    qualityPassed: result?.qualityGate?.passed,
    qualityScore: result?.qualityGate?.score,
    qualityMissing: result?.qualityGate?.missing.join("; "),
    fallbackStages: result?.diagnostics?.fallbackStages?.join("; "),
    finalCompletenessCheck: finalCompletenessCheck(result),
    missingRequiredFields: missingRequiredFields(row),
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
  const electricalFields = row.result ? requiredElectricalFields(row.result) : [];
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

function safeWorkbookPart(value: string): string {
  return (
    value
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "") || "product"
  );
}
