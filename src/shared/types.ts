export type ManufacturerId = string;

export type RunStatus = "queued" | "running" | "pausing" | "paused" | "cancelling" | "cancelled" | "completed" | "failed";
export type ItemStatus = "pending" | "processing" | "found" | "partial" | "failed" | "cancelled";

export interface ManufacturerConfig {
  id: ManufacturerId;
  canonicalName: string;
  shortName: string;
  rateLimitMs: number;
  /** Concurrent items to process from this manufacturer. Defaults to 3. Set to 1 for strict-throttled sites. */
  concurrency?: number;
  officialBaseUrls: string[];
  /** Vendor's main product webpage, used for the PDT MANUFACTURER_URL field. */
  homepageUrl?: string;
  fallbackSources: FallbackSourceConfig[];
  localizedUrlTemplates?: LocalizedUrlTemplate[];
  match?: MatchPolicyConfig;
  fetchPolicy?: FetchPolicyConfig;
  markerRules?: MarkerExtractionRule[];
  scrapeRecipe?: ScrapeRecipeConfig;
  /**
   * User-defined coverage tiles shown next to the built-in ones (Weight/Material/…)
   * in the run dashboard. Each entry is reported as present/missing per item based on
   * whether any attribute name on the parsed product matches the pattern.
   */
  customCoverageFields?: CustomCoverageField[];
  origin?: "built-in" | "custom" | "override";
  isBuiltIn?: boolean;
  hasOverride?: boolean;
}

export interface CustomCoverageField {
  /** Url-safe slug, unique within the manufacturer (e.g. "ip-rating"). */
  id: string;
  /** Display label shown on the coverage tile (e.g. "IP Rating"). */
  label: string;
  /**
   * Case-insensitive regular expression matched against attribute names on the parsed
   * product. The field is "present" when any attribute name matches. Plain words work
   * too — they are treated as substring patterns by the regex engine.
   */
  pattern: string;
}

export interface ManufacturerInspectRequest {
  canonicalName?: string;
  shortName?: string;
  websiteUrl: string;
  sampleCatalogNumbers: string[];
  allowDistributorFallback?: boolean;
}

export interface ManufacturerInspectResult {
  suggested: ManufacturerConfig;
  attemptedUrls: string[];
  discoveredProductUrls: string[];
  directUrlTemplates: string[];
  searchUrlTemplates: string[];
  sitemapUrls: string[];
  reasons: string[];
  warnings: string[];
}

export interface ManufacturerTestRequest {
  manufacturer: ManufacturerConfig;
  sampleCatalogNumbers: string[];
}

export interface ManufacturerTestSampleResult {
  catalogNumber: string;
  status: ProductResult["status"] | "error";
  passed: boolean;
  identityConfirmed: boolean;
  productUrl?: string;
  title?: string;
  confidence: number;
  attributes: number;
  documents: number;
  evidence: number;
  missing: string[];
  attemptedUrls: string[];
  reason: string;
}

export interface ManufacturerTestResult {
  passed: boolean;
  foundCount: number;
  sampleCount: number;
  samples: ManufacturerTestSampleResult[];
  warnings: string[];
}

export interface FallbackSourceConfig {
  id: string;
  label: string;
  enabled: boolean;
  sourceType: "official-fallback" | "distributor";
  directUrlTemplates: string[];
  match?: MatchPolicyConfig;
  fetchPolicy?: FetchPolicyConfig;
  confidence?: number;
  markerRules?: MarkerExtractionRule[];
}

export interface LocalizedUrlTemplate {
  locale: "en" | "de" | "zh";
  urlTemplate: string;
}

export interface MatchPolicyConfig {
  aliases?: string[];
  ignoreCase?: boolean;
  compact?: boolean;
  afterColon?: boolean;
  requireCatalogNumber?: boolean;
}

export interface FetchPolicyConfig {
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  userAgent?: string;
  acceptLanguage?: string;
  referer?: string;
  fallbackUserAgents?: string[];
  minContentLength?: number;
}

export interface MarkerExtractionRule {
  name: string;
  start: string;
  end?: string;
  group?: string;
  documentType?: DocumentRecord["type"];
  urlPrefix?: string;
  urlSuffix?: string;
  caseSensitive?: boolean;
}

export type DynamicFramework =
  | "generic"
  | "json-ld"
  | "embedded-json"
  | "next"
  | "nuxt"
  | "astro"
  | "livewire"
  | "api";

export interface ScrapeRecipeConfig {
  searchUrlTemplates?: string[];
  canonicalParamDenylist?: string[];
  requiredSections?: string[];
  requiredAttributes?: string[];
  requiredDocuments?: Array<DocumentRecord["type"] | string>;
  minAttributes?: number;
  minDocuments?: number;
  expandSelectors?: string[];
  dynamicFramework?: DynamicFramework | DynamicFramework[];
  discoveryPolicy?: DiscoveryPolicyConfig;
  interactionPolicy?: InteractionPolicyConfig;
  extractionPolicy?: ExtractionPolicyConfig;
  qualityPolicy?: QualityPolicyConfig;
  fallbackPolicy?: FallbackPolicyConfig;
  confidenceRules?: ConfidenceRulesConfig;
}

export interface DiscoveryPolicyConfig {
  searchUrlTemplates?: string[];
  sitemapUrls?: string[];
  enableRobotsSitemaps?: boolean;
  urlVariants?: Array<"part" | "partUpper" | "partLower" | "partCompact" | "partSnake" | "partDash" | "partAfterColon" | "partAfterColonCompact">;
  allowedOfficialDomains?: string[];
  maxCandidates?: number;
}

export interface InteractionPolicyConfig {
  closeOverlaySelectors?: string[];
  expandSelectors?: string[];
  localeSelectors?: string[];
  tabSelectors?: string[];
  paginationSelectors?: string[];
  downloadSectionSelectors?: string[];
  waitForSelectors?: string[];
  maxClicks?: number;
  scrollPasses?: number;
  networkIdleTimeoutMs?: number;
  gotoTimeoutMs?: number;
  gotoWaitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  blockResourceTypes?: Array<"image" | "media" | "font" | "stylesheet" | "websocket" | "script">;
}

export interface ExtractionPolicyConfig {
  labelAliases?: Record<string, string>;
  requiredSections?: string[];
  documentUrlPatterns?: string[];
  ignoredDocumentUrlPatterns?: string[];
  ignoredImageUrlPatterns?: string[];
  embeddedProductTableNames?: string[];
  embeddedResourceTableNames?: string[];
  maxRawAttributes?: number;
  maxDocuments?: number;
}

export interface QualityPolicyConfig {
  requiredNormalizedFields?: Array<keyof NormalizedProductFields>;
  requiredFinalFields?: FinalCompletenessPolicyField[];
  preferredFinalFields?: FinalCompletenessPolicyField[];
  typeCodeFallback?: "catalogNumber";
  rationales?: Partial<Record<"requiredFinalFields" | "preferredFinalFields" | "typeCodeFallback", string>>;
  minRawAttributes?: number;
  requiredDocumentTypes?: DocumentRecord["type"][];
  officialSourceConfidenceFloor?: number;
  partialConfidenceCap?: number;
  distributorConfidenceCap?: number;
}

export type FinalCompletenessPolicyField =
  | "image"
  | "operatingTemperature"
  | "typeCode"
  | keyof Pick<
    NormalizedProductFields,
    "weight" | "dimensions" | "material" | "certificates" | "voltage" | "current" | "color" | "protection"
  >;

export interface FallbackPolicyConfig {
  officialFirst?: boolean;
  readerOnQualityFailure?: boolean;
  browserOnQualityFailure?: boolean;
  documentDownloadProfile?: DocumentDownloadProfile;
  skipPreferredFinalCompletenessRetry?: boolean;
  rationales?: Partial<Record<"documentDownloadProfile" | "skipPreferredFinalCompletenessRetry", string>>;
  distributorFallback?: boolean;
  distributorConfidenceCap?: number;
  maxReaderAttempts?: number;
  maxBrowserAttempts?: number;
}

export type DocumentDownloadProfile = "full" | "quality" | "images-only";

export interface ConfidenceRulesConfig {
  foundMinScore?: number;
  partialMaxConfidence?: number;
  distributorMaxConfidence?: number;
  officialDocumentBonus?: number;
  browserPenalty?: number;
  readerPenalty?: number;
}

export interface ScrapeAttemptRecord {
  stage: string;
  url?: string;
  status: "passed" | "partial" | "failed" | "skipped";
  score?: number;
  missing?: string[];
  reason?: string;
  sourceType?: SourceRecord["sourceType"];
  parser?: string;
  statusCode?: number;
  attributeCount?: number;
  documentCount?: number;
  sectionAttributeCounts?: Record<string, number>;
  error?: string;
}

export interface QualityGateResult {
  passed: boolean;
  identityConfirmed: boolean;
  score: number;
  missing: string[];
  reason: string;
  attempts: ScrapeAttemptRecord[];
}

export interface ScrapeDiagnostics {
  attemptedUrls?: string[];
  chosenUrl?: string;
  discoveredCandidates?: Array<{ url: string; score: number; reason: string; stage?: string; sourceType?: SourceRecord["sourceType"] }>;
  rejectedLinks?: Array<{ url: string; score?: number; reason: string }>;
  fallbackStages?: string[];
  finalCompleteness?: FinalCompletenessDiagnostics;
  browserNetwork?: BrowserNetworkRecord[];
  suggestedApiEndpoints?: string[];
  documentCandidates?: DocumentCandidateDiagnostic[];
  documentProcessing?: DocumentProcessingDiagnostic[];
  documentParseFailures?: string[];
  sectionAttributeCounts?: Record<string, number>;
  /** Self-diagnosis: spec labels with a recognizable value but no known meaning — knowledge-base gaps to teach, not guess. */
  unmappedSpecLabels?: string[];
  fieldHealth?: FieldHealthRecord[];
  pageMining?: PageMiningRecord[];
  pageIntelligence?: PageIntelligenceDiagnostic[];
  fieldCandidates?: FieldCandidateRecord[];
  fieldResolutions?: FieldResolutionRecord[];
  targetHealth?: TargetHealthRecord;
  drift?: DriftDiagnostic;
  notes?: string[];
}

export interface PageMiningRecord {
  stage: string;
  url: string;
  method: "static-html" | "rendered-dom" | "browser-network" | "learned-extractor";
  attributeCount: number;
  documentCount: number;
  candidateCount?: number;
  usefulAttributeCount?: number;
  usefulDocumentCount?: number;
  signals?: string[];
  elapsedMs?: number;
  reason?: string;
}

export interface PageIntelligenceDiagnostic {
  stage: string;
  url?: string;
  action: "mined" | "skipped" | "failed" | "learned" | "replayed";
  reason: string;
  attributeCount?: number;
  documentCount?: number;
  scoreBefore?: number;
  scoreAfter?: number;
}

export interface FieldCandidateRecord {
  field: string;
  label: string;
  value: string;
  sourceUrl?: string;
  sourceType?: SourceRecord["sourceType"];
  parser?: string;
  stage?: string;
  confidence?: number;
  priority: number;
  priorityReason: string;
  selected?: boolean;
}

export interface FieldResolutionRecord {
  field: string;
  label: string;
  selectedValue?: string;
  selectedSourceUrl?: string;
  selectedParser?: string;
  selectedStage?: string;
  confidence?: number;
  candidateCount: number;
  conflictCount: number;
  reason: string;
}

export interface LearnedExtractorRecord {
  id?: number;
  manufacturerId: ManufacturerId;
  host: string;
  kind: "dom-pattern" | "json-path" | "network-payload" | "interaction" | "document-pattern";
  pattern: string;
  sourceUrl: string;
  parserKind: string;
  successCount: number;
  lastSuccessAt: string;
}

export interface TargetHealthRecord {
  manufacturerId: ManufacturerId;
  host?: string;
  stage?: string;
  sampleCount: number;
  successRate: number;
  avgQualityScore?: number;
  avgAttributeCount?: number;
  avgDocumentCount?: number;
  driftSuspected?: boolean;
  reason?: string;
}

export interface DriftDiagnostic {
  suspected: boolean;
  reason: string;
  manufacturerId?: ManufacturerId;
  stage?: string;
  successRate?: number;
  avgQualityScore?: number;
}

export interface DocumentProcessingDiagnostic {
  url: string;
  label?: string;
  type?: DocumentRecord["type"];
  action: "parsed" | "skipped" | "failed";
  stage: "downloaded-document-enrichment" | "remote-document-enrichment" | "customer-document-enrichment";
  reason: string;
  attributeCount?: number;
  normalizedFields?: string[];
  pageCount?: number;
  elapsedMs?: number;
  localPath?: string;
  sourceUrl?: string;
  parseError?: string;
}

export interface DocumentCandidateDiagnostic {
  url: string;
  label?: string;
  type?: DocumentRecord["type"];
  status: "accepted" | "rejected";
  reason: string;
  sourceUrl?: string;
}

export interface FieldHealthRecord {
  field: string;
  label: string;
  status: "found" | "missing" | "low-confidence" | "conflicting";
  value?: string;
  confidence?: number;
  sourceUrls?: string[];
  conflicts?: Array<{
    value: string;
    sourceUrls: string[];
    confidence?: number;
    sourceTypes?: SourceRecord["sourceType"][];
    parsers?: string[];
    stages?: string[];
    priority?: number;
    priorityReason?: string;
    selected?: boolean;
  }>;
  reason?: string;
  resolution?: string;
}

export interface FinalCompletenessDiagnostics {
  checkedAt: string;
  beforeMissing: string[];
  retryMissing: string[];
  afterMissing: string[];
  notApplicable: string[];
  repairedFields?: string[];
  networkRetry?: {
    attempted: boolean;
    fields: string[];
    reason?: string;
    triedStages?: string[];
    untriedStages?: string[];
  };
  records?: FinalCompletenessRecord[];
}

export interface FinalCompletenessRecord {
  field: string;
  status: "present" | "found-after-repair" | "found-after-retry" | "missing" | "not-published" | "retry-skipped" | "not-applicable";
  requirement: "required" | "preferred" | "not-applicable";
  beforeValue?: string;
  afterValue?: string;
  action?: string;
  reason?: string;
}

export interface BrowserNetworkRecord {
  url: string;
  statusCode?: number;
  contentType?: string;
  category: "product-api" | "search-api" | "document-api" | "asset-api" | "html" | "text" | "other";
}

export interface LearnedEndpointRecord {
  id?: number;
  manufacturerId: ManufacturerId;
  host: string;
  method: "GET" | "POST";
  urlTemplate: string;
  bodyTemplate?: string;
  headers?: Record<string, string>;
  discoveredFromUrl: string;
  parserKind: string;
  successCount: number;
  lastSuccessAt: string;
}

export interface EvidenceRecord {
  kind: "attribute" | "document" | "source" | "normalized" | "technical-attribute";
  name: string;
  value?: string;
  url?: string;
  sourceUrl?: string;
  sourceType?: SourceRecord["sourceType"];
  parser?: string;
  stage?: string;
  confidence?: number;
  reason?: string;
}

export interface TechnicalAttributeQuantity {
  kind: string;
  unit?: string;
  value?: number;
  min?: number;
  max?: number;
  values?: number[];
  qualifier?: string;
  currentType?: "AC" | "DC" | "AC/DC";
  condition?: string;
  raw: string;
}

export interface TechnicalAttributeRecord {
  manufacturerId: ManufacturerId;
  canonicalKey: string;
  canonicalLabel: string;
  unitKind?: string;
  matchType?:
    | "manufacturer_alias"
    | "global_alias"
    | "ontology"
    | "fuzzy_manufacturer_alias"
    | "fuzzy_global_alias"
    | "fuzzy_cross_manufacturer_alias"
    | "unit_inference";
  matchedAlias?: string;
  matchedAliasManufacturerId?: string;
  matchScore?: number;
  originalGroup?: string;
  originalName: string;
  originalValue: string;
  originalUnit?: string;
  quantities?: TechnicalAttributeQuantity[];
  sourceUrl?: string;
  sourceType?: SourceRecord["sourceType"];
  parser?: string;
  stage?: string;
  confidence: number;
  reason: string;
}

export interface AttributeRecord {
  group?: string;
  name: string;
  value: string;
  unit?: string;
  sourceUrl?: string;
  sourceType?: SourceRecord["sourceType"];
  parser?: string;
  stage?: string;
  confidence?: number;
}

export interface DocumentRecord {
  type: "datasheet" | "certificate" | "manual" | "cad" | "image" | "other";
  label: string;
  url: string;
  candidateUrls?: string[];
  localPath?: string;
  downloadStatus?: "downloaded" | "failed" | "skipped";
  downloadError?: string;
  parseStatus?: "parsed" | "failed" | "skipped";
  parseError?: string;
  sourceUrl?: string;
  sourceType?: SourceRecord["sourceType"];
  parser?: string;
  stage?: string;
  confidence?: number;
  // When explicitly false, the PDF-mining enrichment stages (downloaded + remote) skip this
  // document entirely — the link is still recorded, downloaded and offered to the user, but no
  // attributes are extracted from it. Used for documents that are genuine per-product datasheets
  // in name only but whose content is a multi-variant / multi-language print catalog whose table
  // extraction produces cross-variant, cross-language noise that corrupts cleaner web-page facts
  // (e.g. Ganter Norm "standard sheets"). Undefined means "enrich as usual".
  enrichable?: boolean;
}

export interface SourceRecord {
  url: string;
  sourceType: "official" | "official-fallback" | "distributor" | "cache" | "generated";
  parser: string;
  parserVersion?: string;
  stage?: string;
  reason?: string;
  fetchedAt: string;
  statusCode?: number;
}

export interface NormalizedProductFields {
  weight?: string;
  dimensions?: string;
  material?: string;
  wallThickness?: string;
  finish?: string;
  color?: string;
  voltage?: string;
  current?: string;
  protection?: string;
  certificates?: string;
  /** Operating/ambient temperature lower bound in °C (plain number string), understood from a range. */
  operatingTemperatureMin?: string;
  /** Operating/ambient temperature upper bound in °C (plain number string), understood from a range. */
  operatingTemperatureMax?: string;
}

export interface LocalizedProductUrls {
  en?: string;
  de?: string;
}

export interface LocalizedDescription {
  title?: string;
  description?: string;
}

export interface LocalizedDescriptions {
  de?: LocalizedDescription;
}

export interface ProductResult {
  manufacturerId: ManufacturerId;
  catalogNumber: string;
  status: Exclude<ItemStatus, "pending" | "processing" | "cancelled">;
  confidence: number;
  productUrl?: string;
  localizedUrls?: LocalizedProductUrls;
  /** Per-locale title/description captured from non-English official pages. Currently only `de`. */
  localizedDescriptions?: LocalizedDescriptions;
  title?: string;
  description?: string;
  normalized: NormalizedProductFields;
  attributes: AttributeRecord[];
  documents: DocumentRecord[];
  sources: SourceRecord[];
  qualityGate?: QualityGateResult;
  diagnostics?: ScrapeDiagnostics;
  evidence?: EvidenceRecord[];
  /** Canonical technical attribute map: original manufacturer label/value plus what the ontology understands it to mean. */
  technicalAttributes?: TechnicalAttributeRecord[];
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
  /** Path to the generated PDT workbook, set on demand by the "Import to PDT" action. */
  pdtPath?: string;
  activityStage?: string;
  activityMessage?: string;
  activityStartedAt?: string;
  options?: RunOptions;
  error?: string;
}

export interface RunOptions {
  downloadDocuments?: boolean;
  /** Save PDF-like manufacturer documents such as datasheets, manuals and certificates. */
  downloadPdfs?: boolean;
  /** Save CAD/CAE files separately from PDF documents. */
  downloadCad?: boolean;
  /**
   * When false, skip saving product images to disk. URLs are still discovered and kept
   * in the workbook. Default true.
   */
  downloadImages?: boolean;
  /**
   * When false, skip generating the Excel workbook entirely. Used for the "Images only"
   * mode where the user just wants the PNG files. Default true.
   */
  generateExcel?: boolean;
  /**
   * Generate a separate CSV with catalog numbers and discovered manufacturer product URLs.
   * Can be used alone for a links-only run or together with other outputs.
   */
  generateLinksFile?: boolean;
  /**
   * Per-run override for the manufacturer's custom coverage tiles. When set (even to an
   * empty array, meaning "no custom tiles"), this replaces the manufacturer default for
   * this one run. When undefined, the manufacturer's `customCoverageFields` is used.
   */
  customCoverageFields?: CustomCoverageField[];
  /**
   * Built-in coverage tile keys the user has chosen to hide for this run (e.g. "weight",
   * "material"). Custom tiles use their own id when listed here. Default empty.
   */
  hiddenCoverageFields?: string[];
  /**
   * When true, ignore the persisted "exhausted fields" cache and re-attempt the final
   * network retry for every item even if a prior run determined the field is unpublished.
   * Default false: skip retry for catalog numbers previously confirmed empty.
   */
  forceFinalRetry?: boolean;
  /**
   * Customer-provided documents (PDFs, DOCs, XLSX, CSVs) attached to this run. Data
   * extracted from these files is treated as authoritative — it overrides anything
   * scraped from the manufacturer website, since the customer has handed us their own
   * source-of-truth.
   */
  customerDocuments?: CustomerDocumentRecord[];
}

export interface CustomerDocumentRecord {
  id: string;
  originalName: string;
  storedPath: string;
  mimeType?: string;
  size?: number;
  uploadedAt: string;
}

export type RunCoverageField =
  | "enUrl"
  | "deUrl"
  | "image"
  | "weight"
  | "certificates"
  | "dimensions"
  | "material"
  | "voltage"
  | "current";

export type RunCoverageState = "present" | "missing" | "not-applicable";

export interface RunItemFieldHealthSummary {
  found: number;
  missing: number;
  lowConfidence: number;
  conflicting: number;
  reviewFields: string[];
}

export interface RunItemDocumentProcessingSummary {
  parsed: number;
  skipped: number;
  failed: number;
  attributeCount?: number;
  normalizedFields?: string[];
  reviewDocuments: string[];
}

export interface RunItemDiscoverySummary {
  attempted: number;
  discovered: number;
  rejected: number;
  documentCandidatesAccepted: number;
  documentCandidatesRejected: number;
  attemptedUrls: string[];
  topCandidates: string[];
  rejectedLinks: string[];
  rejectedDocuments: string[];
}

export interface RunItemPageMiningSummary {
  stages: number;
  attributes: number;
  documents: number;
  signals: string[];
  driftSuspected?: boolean;
}

export interface RunItemCoverageSummary {
  fields: Partial<Record<RunCoverageField, RunCoverageState>>;
  /**
   * User-defined coverage results, in the same order as the manufacturer's
   * `customCoverageFields`. Empty when no custom fields are configured.
   */
  customFields?: RunItemCustomCoverageResult[];
  criticalMissing: RunCoverageField[];
  reason?: string;
  qualityPassed?: boolean;
  qualityMissing?: string[];
  finalCompletenessAfterMissing?: string[];
  fieldHealth?: RunItemFieldHealthSummary;
  documentProcessing?: RunItemDocumentProcessingSummary;
  discovery?: RunItemDiscoverySummary;
  pageMining?: RunItemPageMiningSummary;
  attributeCount?: number;
  documentCount?: number;
  evidenceCount?: number;
}

export interface RunItemCustomCoverageResult {
  id: string;
  label: string;
  state: RunCoverageState;
  /** First matching attribute value, useful for tooltips. */
  matchedValue?: string;
}

export interface RunItemRecord {
  id: number;
  runId: string;
  rowIndex: number;
  catalogNumber: string;
  status: ItemStatus;
  stage?: string;
  stageMessage?: string;
  stageStartedAt?: string;
  title?: string;
  productUrl?: string;
  confidence?: number;
  error?: string;
  result?: ProductResult;
  coverage?: RunItemCoverageSummary;
  updatedAt: string;
}

/** One entry per scraped item — used to populate the PDT routing review modal. */
export interface PdtRoutingItemPreview {
  itemId: number;
  catalogNumber: string;
  title?: string;
  deviceType?: string;
  /** Sheets the exporter would route this item to right now (without user overrides). */
  suggestedSheets: string[];
}

export interface PdtRoutingPreview {
  runId: string;
  items: PdtRoutingItemPreview[];
  /** All device-specific sheets the user can pick from (constants like MMD are always written). */
  availableSheets: string[];
}

/** Map of itemId → chosen device sheet(s). If present for an item, replaces auto-suggestion. */
export type PdtSheetOverrides = Record<number, string[]>;

export interface CsvPreview {
  columns: string[];
  detectedColumn?: string;
  rowCount: number;
  previewRows: Record<string, string>[];
  warnings: string[];
}
