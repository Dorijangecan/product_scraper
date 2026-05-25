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

export async function startRun(input: { file: File; manufacturerId: string; columnName: string; downloadDocuments: boolean }): Promise<RunRecord> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("manufacturerId", input.manufacturerId);
  form.append("columnName", input.columnName);
  form.append("downloadDocuments", String(input.downloadDocuments));
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

export async function openRunWorkbook(id: string): Promise<{ ok: true; path: string }> {
  return request(`/api/runs/${id}/files/result/open`, { method: "POST" });
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
