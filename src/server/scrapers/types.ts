import type { DocumentRecord, FallbackSourceConfig, LearnedEndpointRecord, ManufacturerConfig, ProductResult } from "../../shared/types.js";
import type { CachedHttpClient } from "./http-client.js";
import type { BrowserRenderSession } from "./browser-renderer.js";

export interface ScrapeContext {
  http: CachedHttpClient;
  manufacturer: ManufacturerConfig;
  runDir: string;
  documentsDir: string;
  signal?: AbortSignal;
  browserRenderer?: BrowserRenderSession;
  learnedEndpoints?: {
    list: (manufacturerId: string, limit?: number) => LearnedEndpointRecord[];
    upsert: (endpoint: Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">) => void;
  };
  downloadDocument: (doc: DocumentRecord) => Promise<DocumentRecord>;
  fallback: {
    scrape: (catalogNumber: string, sources: FallbackSourceConfig[]) => Promise<ProductResult | undefined>;
  };
}

export interface ManufacturerConnector {
  id: string;
  scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult>;
}
