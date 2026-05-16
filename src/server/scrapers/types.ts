import type { DocumentRecord, FallbackSourceConfig, ManufacturerConfig, ProductResult } from "../../shared/types.js";
import type { CachedHttpClient } from "./http-client.js";

export interface ScrapeContext {
  http: CachedHttpClient;
  manufacturer: ManufacturerConfig;
  runDir: string;
  documentsDir: string;
  signal?: AbortSignal;
  downloadDocument: (doc: DocumentRecord) => Promise<DocumentRecord>;
  fallback: {
    scrape: (catalogNumber: string, sources: FallbackSourceConfig[]) => Promise<ProductResult | undefined>;
  };
}

export interface ManufacturerConnector {
  id: string;
  scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult>;
}
