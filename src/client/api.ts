import type {
  CsvPreview,
  ManufacturerConfig,
  ManufacturerInspectRequest,
  ManufacturerInspectResult,
  ManufacturerTestRequest,
  ManufacturerTestResult,
  RunItemRecord,
  RunRecord
} from "../shared/types.js";

export async function getManufacturers(): Promise<ManufacturerConfig[]> {
  return request("/api/manufacturers");
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

export async function resetManufacturerOverride(id: string): Promise<{ manufacturer: ManufacturerConfig; manufacturers: ManufacturerConfig[] }> {
  return request(`/api/manufacturers/${encodeURIComponent(id)}/reset-override`, { method: "POST" });
}

export async function previewCsv(file: File): Promise<CsvPreview> {
  const form = new FormData();
  form.append("file", file);
  return request("/api/csv/preview", { method: "POST", body: form });
}

export async function startRun(input: {
  file: File;
  manufacturerId: string;
  columnName: string;
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
}): Promise<RunRecord> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("manufacturerId", input.manufacturerId);
  form.append("columnName", input.columnName);
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
