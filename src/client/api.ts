import type {
  CsvPreview,
  FieldCoverageMatrixResponse,
  LearnedExtractorApprovalRequest,
  ManufacturerConfig,
  ManufacturerInspectRequest,
  ManufacturerInspectResult,
  ManufacturerOperationalSummary,
  ManufacturerTestRequest,
  ManufacturerTestResult,
  RunItemRecord,
  RunRecord
} from "../shared/types.js";

export async function getManufacturers(): Promise<ManufacturerConfig[]> {
  return request("/api/manufacturers");
}

export async function getManufacturerOperationalSummary(id: string): Promise<ManufacturerOperationalSummary> {
  return request(`/api/manufacturers/${encodeURIComponent(id)}/operational-summary`);
}

export async function getFieldCoverageMatrix(): Promise<FieldCoverageMatrixResponse> {
  return request("/api/field-coverage-matrix");
}

export async function saveManufacturer(input: ManufacturerConfig): Promise<{ manufacturer: ManufacturerConfig; manufacturers: ManufacturerConfig[] }> {
  return request("/api/manufacturers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function inspectManufacturer(input: ManufacturerInspectRequest): Promise<ManufacturerInspectResult> {
  return request("/api/manufacturers/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function testManufacturer(input: ManufacturerTestRequest): Promise<ManufacturerTestResult> {
  return request("/api/manufacturers/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function approveLearnedExtractor(input: LearnedExtractorApprovalRequest): Promise<void> {
  await request(`/api/manufacturers/${encodeURIComponent(input.manufacturerId)}/learned-extractors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function resetManufacturerOverride(id: string): Promise<{ manufacturer: ManufacturerConfig; manufacturers: ManufacturerConfig[] }> {
  return request(`/api/manufacturers/${encodeURIComponent(id)}/reset-override`, { method: "POST" });
}

export async function previewCsv(file: File): Promise<CsvPreview> {
  const form = new FormData();
  form.append("file", file);
  return request("/api/csv/preview", { method: "POST", body: form });
}

export async function startRun(input: {
  /**
   * Catalog CSV/XLSX. Optional when `accessoryMatrix` is given: the matrix's main parts are then
   * the catalog numbers to scrape.
   */
  file?: File;
  manufacturerId: string;
  columnName?: string;
  downloadDocuments: boolean;
  downloadPdfs?: boolean;
  downloadCad?: boolean;
  downloadImages: boolean;
  generateExcel: boolean;
  generateLinksFile?: boolean;
  /**
   * Per-run override of the coverage tiles. Pass `undefined` to use the manufacturer
   * defaults; pass an array (including empty `[]`) to override for this single run.
   */
  customCoverageFields?: Array<{ id: string; label: string; pattern: string }>;
  hiddenCoverageFields?: string[];
  forceFinalRetry?: boolean;
  /**
   * Customer-provided documents (PDFs, DOCs, XLSX, CSVs). Data extracted from these
   * files overrides anything scraped from the manufacturer website for the catalog
   * numbers they mention.
   */
  customerDocuments?: File[];
  /**
   * Operator-authored accessory matrix workbook: which accessory sits on which connection point
   * of which main product. Fills the PDT's Product Accessory and Connection Point Information
   * tabs, and adds an "Accessory Conditions" sheet to the products workbook.
   */
  accessoryMatrix?: File;
}): Promise<RunRecord> {
  const form = new FormData();
  if (input.file) form.append("file", input.file);
  form.append("manufacturerId", input.manufacturerId);
  if (input.columnName) form.append("columnName", input.columnName);
  form.append("downloadDocuments", String(input.downloadDocuments));
  form.append("downloadPdfs", String(input.downloadPdfs ?? input.downloadDocuments));
  form.append("downloadCad", String(input.downloadCad ?? input.downloadDocuments));
  form.append("downloadImages", String(input.downloadImages));
  form.append("generateExcel", String(input.generateExcel));
  form.append("generateLinksFile", String(input.generateLinksFile ?? false));
  if (input.customCoverageFields !== undefined) {
    form.append("customCoverageFields", JSON.stringify(input.customCoverageFields));
  }
  if (input.hiddenCoverageFields !== undefined) {
    form.append("hiddenCoverageFields", JSON.stringify(input.hiddenCoverageFields));
  }
  form.append("forceFinalRetry", String(input.forceFinalRetry ?? false));
  for (const customerDocument of input.customerDocuments ?? []) {
    form.append("customerDocuments", customerDocument);
  }
  if (input.accessoryMatrix) form.append("accessoryMatrix", input.accessoryMatrix);
  return request("/api/runs", { method: "POST", body: form });
}

export async function listRuns(): Promise<RunRecord[]> {
  return request("/api/runs");
}

export async function getRun(id: string, options: { summary?: boolean } = {}): Promise<{ run: RunRecord; items: RunItemRecord[] }> {
  return request(`/api/runs/${id}${options.summary ? "?summary=1" : ""}`);
}

export async function getRunItem(runId: string, itemId: number): Promise<RunItemRecord> {
  return request(`/api/runs/${runId}/items/${itemId}`);
}

export async function cancelRun(id: string): Promise<RunRecord> {
  return request(`/api/runs/${id}/cancel`, { method: "POST" });
}

export async function pauseRun(id: string): Promise<RunRecord> {
  return request(`/api/runs/${id}/pause`, { method: "POST" });
}

export async function resumeRun(id: string): Promise<RunRecord> {
  return request(`/api/runs/${id}/resume`, { method: "POST" });
}

export async function openRunWorkbook(id: string): Promise<{ ok: true; path: string }> {
  return request(`/api/runs/${id}/files/result/open`, { method: "POST" });
}

export async function openRunOutputFolder(id: string): Promise<{ ok: true; path: string }> {
  return request(`/api/runs/${id}/files/folder/open`, { method: "POST" });
}

export interface PdtImportStats {
  outputPath: string;
  productCount: number;
  documentRows: number;
  filledSheets: Record<string, number>;
  missingSheets: string[];
  unmappedDeviceTypes: string[];
  unclassifiedCatalogNumbers: string[];
  writeIssues: PdtWriteIssue[];
  requiredFieldIssues: PdtRequiredFieldIssue[];
  keptSheets: string[];
  removedSheetCount: number;
  cleanedInputPath?: string;
  pdtAuditPath?: string;
  /** Saginaw only: companion workbook with the page's verbatim inch/lbs values. */
  saginawWeightDimensionPath?: string;
  /** Present when an accessory matrix was applied to this export. */
  accessoryMatrix?: {
    fileName?: string;
    accessoryRows: number;
    connectionPointRows: number;
    pointCount: number;
    mainPartCount: number;
    mainPartsNotInRun: string[];
    conditionCount: number;
    conditionsPath?: string;
    warnings: string[];
  };
  cellAudit?: {
    auditPath?: string;
    written: number;
    blank: number;
    skipped: number;
    unprovenSkipped: number;
  };
  cleanup?: {
    status: "disabled" | "qwen_unavailable" | "qwen_no_valid_output" | "qwen_reviewed" | "qwen_applied";
    host: string;
    model: string;
    itemCount: number;
    qwenPatchCount: number;
    acceptedFieldCount: number;
    rejectedFieldCount: number;
    message: string;
    productRows: number;
  };
}

export interface PdtWriteIssue {
  sheetName: string;
  catalogNumber: string;
  code: string;
  propName: string;
  description: string;
  value: string;
  reason: "enum-unmatched";
}

export interface PdtRequiredFieldIssue {
  sheetName: string;
  catalogNumber: string;
  code: string;
  propName: string;
  description: string;
  priority: string;
  reason: "required-missing";
}

export async function importRunPdt(
  id: string,
  options: { templatePath?: string; aiCleanup?: boolean; sheetOverrides?: import("../shared/types.js").PdtSheetOverrides } = {}
): Promise<{ ok: true; path: string; stats: PdtImportStats }> {
  return request(`/api/runs/${id}/pdt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      templatePath: options.templatePath,
      aiCleanup: options.aiCleanup ?? false,
      sheetOverrides: options.sheetOverrides
    })
  });
}

export interface AccessoryMatrixPreview {
  fileName: string;
  /** Main part numbers in column A — the catalog numbers a matrix-only run scrapes. */
  mainParts: string[];
  points: string[];
  accessoryRows: number;
  conditionCount: number;
  warnings: string[];
}

/** Read an accessory matrix before a run exists, to preview the main parts it would scrape. */
export async function previewAccessoryMatrix(file: File): Promise<AccessoryMatrixPreview> {
  const form = new FormData();
  form.append("file", file);
  return request("/api/accessory-matrix/preview", { method: "POST", body: form });
}

export interface AccessoryMatrixSummary {
  fileName: string;
  mainPartCount: number;
  pointCount: number;
  accessoryRows: number;
  connectionPointRows: number;
  conditionCount: number;
  mainPartsNotInRun: string[];
  warnings: string[];
}

/** Attach (or replace) the accessory matrix used by this run's next PDT export. */
export async function uploadRunAccessoryMatrix(
  id: string,
  file: File
): Promise<{ ok: true; accessoryMatrix: AccessoryMatrixSummary }> {
  const form = new FormData();
  form.append("file", file);
  return request(`/api/runs/${id}/accessory-matrix`, { method: "POST", body: form });
}

export async function clearRunAccessoryMatrix(id: string): Promise<{ ok: true }> {
  return request(`/api/runs/${id}/accessory-matrix`, { method: "DELETE" });
}

export async function getRunPdtRoutingPreview(id: string): Promise<import("../shared/types.js").PdtRoutingPreview> {
  return request(`/api/runs/${id}/pdt-routing-preview`);
}

export async function openRunPdt(id: string): Promise<{ ok: true; path: string }> {
  return request(`/api/runs/${id}/files/pdt/open`, { method: "POST" });
}

export async function updateRunCoverageFields(
  id: string,
  customCoverageFields: Array<{ id: string; label: string; pattern: string }>,
  hiddenCoverageFields?: string[]
): Promise<RunRecord> {
  const payload: { customCoverageFields: typeof customCoverageFields; hiddenCoverageFields?: string[] } = {
    customCoverageFields
  };
  if (hiddenCoverageFields !== undefined) payload.hiddenCoverageFields = hiddenCoverageFields;
  return request(`/api/runs/${id}/coverage-fields`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `Request failed with HTTP ${response.status}`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Keep generic message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}
