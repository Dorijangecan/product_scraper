export type ManufacturerId = string;

export type RunStatus = "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";
export type ItemStatus = "pending" | "processing" | "found" | "partial" | "failed" | "cancelled";

export interface ManufacturerConfig {
  id: ManufacturerId;
  canonicalName: string;
  shortName: string;
  rateLimitMs: number;
  officialBaseUrls: string[];
  fallbackSources: FallbackSourceConfig[];
}

export interface FallbackSourceConfig {
  id: string;
  label: string;
  enabled: boolean;
  sourceType: "official-fallback" | "distributor";
  directUrlTemplates: string[];
}

export interface AttributeRecord {
  group?: string;
  name: string;
  value: string;
  unit?: string;
  sourceUrl?: string;
}

export interface DocumentRecord {
  type: "datasheet" | "certificate" | "manual" | "cad" | "image" | "other";
  label: string;
  url: string;
  localPath?: string;
  sourceUrl?: string;
}

export interface SourceRecord {
  url: string;
  sourceType: "official" | "official-fallback" | "distributor" | "cache" | "generated";
  parser: string;
  fetchedAt: string;
  statusCode?: number;
}

export interface NormalizedProductFields {
  weight?: string;
  dimensions?: string;
  material?: string;
  voltage?: string;
  current?: string;
  protection?: string;
  certificates?: string;
}

export interface LocalizedProductUrls {
  en?: string;
  de?: string;
}

export interface ProductResult {
  manufacturerId: ManufacturerId;
  catalogNumber: string;
  status: Exclude<ItemStatus, "pending" | "processing" | "cancelled">;
  confidence: number;
  productUrl?: string;
  localizedUrls?: LocalizedProductUrls;
  title?: string;
  description?: string;
  normalized: NormalizedProductFields;
  attributes: AttributeRecord[];
  documents: DocumentRecord[];
  sources: SourceRecord[];
  error?: string;
}

export interface RunRecord {
  id: string;
  manufacturerId: ManufacturerId;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  inputFileName?: string;
  total: number;
  processed: number;
  found: number;
  partial: number;
  failed: number;
  outputPath?: string;
  error?: string;
}

export interface RunItemRecord {
  id: number;
  runId: string;
  rowIndex: number;
  catalogNumber: string;
  status: ItemStatus;
  title?: string;
  productUrl?: string;
  confidence?: number;
  error?: string;
  result?: ProductResult;
  updatedAt: string;
}

export interface CsvPreview {
  columns: string[];
  detectedColumn?: string;
  rowCount: number;
  previewRows: Record<string, string>[];
  warnings: string[];
}
