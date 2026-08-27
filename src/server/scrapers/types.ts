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
import type { ProductDiscoveryResult } from "./discovery.js";

export interface ScrapeContext {
  http: CachedHttpClient;
  manufacturer: ManufacturerConfig;
  runDir: string;
  documentsDir: string;
  signal?: AbortSignal;
  browserRenderer?: BrowserRenderSession;
  /**
   * The item's time budget — a SOFT target and a HARD ceiling, per DISCOVERY-SPEED-PLAN §4 option (B).
   *
   * The distinction is the whole point, and it is deliberate: the hard ceiling is the existing
   * per-item abort (nothing that finishes today gets killed), while the soft target only stops work
   * that is SPECULATIVE — trying another URL guess, opening a browser for a page nobody has evidence
   * for. Work that is on its way to evidence is never cut by the soft target, because the project's
   * original complaint is "the data is missing or wrong", and a hard cut that drops data to save
   * seconds works against that.
   *
   * Absent for callers with no budget (wizard validation, tests): then nothing is skipped.
   */
  deadline?: {
    /** Milliseconds until the hard per-item abort. Clamp expensive timeouts to this. */
    remainingMs: () => number;
    /** Has the soft target passed? If so, stop speculating — but keep chasing evidence. */
    softTargetPassed: () => boolean;
    /** For diagnostics: how long this item has been running. */
    elapsedMs: () => number;
  };
  /** Per-item discovery is shared between a connector's fallback and later deterministic retries.
   * The run manager creates this map once per catalog so a second stage reuses the same evidence
   * instead of repeating search/form/sitemap requests. */
  discoveryMemo?: Map<string, Promise<ProductDiscoveryResult>>;
  learnedEndpoints?: {
    list: (manufacturerId: string, limit?: number) => LearnedEndpointRecord[];
    upsert: (endpoint: Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">) => void;
    recordFailure?: (manufacturerId: string, method: "GET" | "POST", urlTemplate: string) => void;
  };
  learnedExtractors?: {
    list: (manufacturerId: string, host: string, limit?: number) => LearnedExtractorRecord[];
    /** Normal runs persist a demonstrated recipe; wizard validation can collect it for human review. */
    upsert?: (extractor: Omit<LearnedExtractorRecord, "id" | "successCount" | "lastSuccessAt">) => void;
    propose?: (extractor: Omit<LearnedExtractorRecord, "id" | "successCount" | "lastSuccessAt">) => void;
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
