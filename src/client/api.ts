import type { CsvPreview, ManufacturerConfig, RunItemRecord, RunRecord } from "../shared/types.js";

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

export async function previewCsv(file: File): Promise<CsvPreview> {
  const form = new FormData();
  form.append("file", file);
  return request("/api/csv/preview", { method: "POST", body: form });
}

export async function startRun(input: { file: File; manufacturerId: string; columnName: string }): Promise<RunRecord> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("manufacturerId", input.manufacturerId);
  form.append("columnName", input.columnName);
  return request("/api/runs", { method: "POST", body: form });
}

export async function listRuns(): Promise<RunRecord[]> {
  return request("/api/runs");
}

export async function getRun(id: string): Promise<{ run: RunRecord; items: RunItemRecord[] }> {
  return request(`/api/runs/${id}`);
}

export async function cancelRun(id: string): Promise<RunRecord> {
  return request(`/api/runs/${id}/cancel`, { method: "POST" });
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
