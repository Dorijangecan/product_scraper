export type ManufacturerId = string;

export type RunStatus = "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";
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
  locale: "en" | "de";
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
  maxRawAttributes?: number;
  maxDocuments?: number;
}

export interface QualityPolicyConfig {
  requiredNormalizedFields?: Array<keyof NormalizedProductFields>;
  minRawAttributes?: number;
  requiredDocumentTypes?: DocumentRecord["type"][];
  officialSourceConfidenceFloor?: number;
  partialConfidenceCap?: number;
  distributorConfidenceCap?: number;
}

export interface FallbackPolicyConfig {
  officialFirst?: boolean;
  readerOnQualityFailure?: boolean;
  browserOnQualityFailure?: boolean;
  distributorFallback?: boolean;
  distributorConfidenceCap?: number;
  maxReaderAttempts?: number;
  maxBrowserAttempts?: number;
}

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
  documentParseFailures?: string[];
  sectionAttributeCounts?: Record<string, number>;
  notes?: string[];
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
  status: "present" | "found-after-repair" | "found-after-retry" | "missing" | "not-published" | "not-applicable";
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
  kind: "attribute" | "document" | "source" | "normalized";
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
  qualityGate?: QualityGateResult;
  diagnostics?: ScrapeDiagnostics;
  evidence?: EvidenceRecord[];
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

export interface CsvPreview {
  columns: string[];
  detectedColumn?: string;
  rowCount: number;
  previewRows: Record<string, string>[];
  warnings: string[];
}
