import type {
  DocumentRecord,
  FallbackSourceConfig,
  LearnedEndpointRecord,
  LearnedExtractorRecord,
  ManufacturerConfig,
  ProductResult,
  TargetHealthRecord
} from "../../shared/types.js";
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
  learnedExtractors?: {
    list: (manufacturerId: string, host: string, limit?: number) => LearnedExtractorRecord[];
    upsert: (extractor: Omit<LearnedExtractorRecord, "id" | "successCount" | "lastSuccessAt">) => void;
  };
  targetHealth?: {
    record: (observation: {
      manufacturerId: string;
      host?: string;
      stage: string;
      status: "passed" | "partial" | "failed" | "skipped";
      qualityScore?: number;
      attributeCount?: number;
      documentCount?: number;
      elapsedMs?: number;
      error?: string;
    }) => void;
    get: (manufacturerId: string, stage?: string, host?: string) => TargetHealthRecord | undefined;
  };
  downloadDocument: (doc: DocumentRecord) => Promise<DocumentRecord>;
  fallback: {
    scrape: (catalogNumber: string, sources: FallbackSourceConfig[]) => Promise<ProductResult | undefined>;
  };
  // When false, the scraper should skip work that exists only to discover or fetch non-image
  // documents (PDFs, CAD, manuals). The run-manager already skips the actual download; this
  // lets scrapers avoid the upstream browser/network cost too.
  downloadDocuments?: boolean;
  // True only when the user asked to save the full document set. Some runs still download one
  // datasheet for Excel enrichment; scrapers can use this to skip expensive document discovery.
  saveDocuments?: boolean;
  /**
   * When true, the scraper should take the fastest possible path to a single product image:
   * skip lazy-loaded modal renders, skip supplemental enrichment fetches, and return as soon
   * as a usable image URL is in hand. Used by the "Images only" run mode.
   */
  imageOnly?: boolean;
}

export interface ManufacturerConnector {
  id: string;
  scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult>;
}
