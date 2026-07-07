import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  Download,
  FileCheck2,
  FileOutput,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  History,
  Layers3,
  ListChecks,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Save,
  Search,
  Settings2,
  Trash2,
  Upload,
  X,
  XCircle
} from "lucide-react";
import type {
  CsvPreview,
  FallbackSourceConfig,
  ManufacturerConfig,
  ManufacturerInspectResult,
  ManufacturerTestResult,
  MarkerExtractionRule,
  ItemStatus,
  PdtRoutingPreview,
  RunItemRecord,
  RunRecord,
  ScrapeRecipeConfig
} from "../shared/types.js";
import { Dropdown } from "./Dropdown.js";
import { requiredElectricalFields } from "../shared/product-requirements.js";
import {
  cancelRun,
  getManufacturers,
  getRun,
  getRunItem,
  inspectManufacturer,
  listRuns,
  openRunOutputFolder,
  pauseRun,
  updateRunCoverageFields,
  openRunWorkbook,
  importRunPdt,
  openRunPdt,
  getRunPdtRoutingPreview,
  previewCsv,
  resetManufacturerOverride,
  resumeRun,
  saveManufacturer,
  startRun,
  testManufacturer,
  type PdtImportStats
} from "./api.js";

interface SourceDraft {
  id: string;
  label: string;
  enabled: boolean;
  sourceType: FallbackSourceConfig["sourceType"];
  directUrlTemplatesText: string;
  aliasesText: string;
  markerRulesText: string;
  confidence: string;
  fetchTimeoutMs: string;
  cacheTtlMs: string;
  maxAttempts: string;
  retryBackoffMs: string;
  minContentLength: string;
  userAgent: string;
  acceptLanguage: string;
  referer: string;
  fallbackUserAgentsText: string;
}

interface ManufacturerDraft {
  id: string;
  canonicalName: string;
  shortName: string;
  rateLimitMs: string;
  officialBaseUrlsText: string;
  localizedUrlTemplatesText: string;
  aliasesText: string;
  markerRulesText: string;
  fetchTimeoutMs: string;
  cacheTtlMs: string;
  maxAttempts: string;
  retryBackoffMs: string;
  minContentLength: string;
  userAgent: string;
  acceptLanguage: string;
  referer: string;
  fallbackUserAgentsText: string;
  scrapeRecipeJson: string;
  fallbackSources: SourceDraft[];
  customCoverageFields: CustomCoverageFieldDraft[];
}

interface CustomCoverageFieldDraft {
  id: string;
  label: string;
  pattern: string;
}

const REQUIRED_COVERAGE_FIELDS = [
  { key: "enUrl", label: "EN link" },
  { key: "deUrl", label: "DE link" },
  { key: "image", label: "Images" },
  { key: "weight", label: "Weight" },
  { key: "certificates", label: "Certificates" },
  { key: "dimensions", label: "Dimensions" },
  { key: "material", label: "Material" },
  { key: "voltage", label: "Voltage" },
  { key: "current", label: "Current" }
] as const;

type CoverageKey = (typeof REQUIRED_COVERAGE_FIELDS)[number]["key"];
// `key` is a CoverageKey for built-in tiles, or `custom:<id>` for a custom coverage tile.
interface CoverageFocus {
  key: string;
  label: string;
  state: "missing" | "not-applicable";
}
type RunItemFilter = "all" | "needs-check" | ItemStatus;
type OpenFilePicker = (options: {
  id?: string;
  multiple?: boolean;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<Array<{ getFile(): Promise<File> }>>;

const RUN_ITEM_FILTERS: Array<{ key: RunItemFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "needs-check", label: "Needs check" },
  { key: "found", label: "Found" },
  { key: "partial", label: "Partial" },
  { key: "failed", label: "Failed" },
  { key: "pending", label: "Pending" },
  { key: "processing", label: "Running" },
  { key: "cancelled", label: "Cancelled" }
];

const RUN_ITEM_PAGE_SIZES = [25, 50, 100, 250, "all"] as const;
type RunItemPageSize = (typeof RUN_ITEM_PAGE_SIZES)[number];

const RUN_STATUS_LABELS: Record<RunRecord["status"], string> = {
  queued: "Queued",
  running: "Running",
  pausing: "Pausing",
  paused: "Paused",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed"
};

function pdtImportWarning(stats: PdtImportStats): string | null {
  const warnings: string[] = [];
  if (stats.missingSheets.length > 0) warnings.push(`missing sheets: ${formatShortList(stats.missingSheets)}`);
  if (stats.unmappedDeviceTypes.length > 0) warnings.push(`unmapped device types: ${formatShortList(stats.unmappedDeviceTypes)}`);
  if (stats.unclassifiedCatalogNumbers.length > 0) {
    warnings.push(`unclassified catalogs: ${formatShortList(stats.unclassifiedCatalogNumbers)}`);
  }
  if (stats.writeIssues.length > 0) {
    const examples = stats.writeIssues.map((issue) => `${issue.catalogNumber}/${issue.sheetName}/${issue.code}`);
    warnings.push(`enum write issues: ${stats.writeIssues.length} (${formatShortList(examples, 3)})`);
  }
  if (stats.requiredFieldIssues?.length > 0) {
    const examples = stats.requiredFieldIssues.map((issue) => `${issue.catalogNumber}/${issue.sheetName}/${issue.code || issue.propName}`);
    warnings.push(`missing required PDT fields: ${stats.requiredFieldIssues.length} (${formatShortList(examples, 3)})`);
  }
  if ((stats.cellAudit?.unprovenSkipped ?? 0) > 0) {
    warnings.push(`unproven PDT values skipped: ${stats.cellAudit!.unprovenSkipped}`);
  }
  return warnings.length ? `PDT generated with warnings: ${warnings.join("; ")}.` : null;
}

function formatShortList(values: string[], max = 8): string {
  const shown = values.slice(0, max).join(", ");
  const remaining = values.length - max;
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

export function App() {
  const [manufacturers, setManufacturers] = useState<ManufacturerConfig[]>([]);
  const [manufacturerId, setManufacturerId] = useState("abb");
  const [file, setFile] = useState<File | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const customerInputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [columnName, setColumnName] = useState("");
  const [uploadDragActive, setUploadDragActive] = useState(false);
  // Customer-provided documents (PDFs, DOCs, XLSX, CSVs). Data parsed from these
  // overrides anything scraped from the manufacturer website — the customer is the
  // authoritative source. Drag-drop works across every manufacturer config.
  const [customerDocuments, setCustomerDocuments] = useState<File[]>([]);
  const [customerDragActive, setCustomerDragActive] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [items, setItems] = useState<RunItemRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [openWorkbookBusy, setOpenWorkbookBusy] = useState(false);
  const [openOutputFolderBusy, setOpenOutputFolderBusy] = useState(false);
  const [pdtBusy, setPdtBusy] = useState(false);
  const [manufacturerEditorOpen, setManufacturerEditorOpen] = useState(false);
  const [manufacturerDraft, setManufacturerDraft] = useState<ManufacturerDraft>(() => emptyManufacturerDraft());
  const [manufacturerSaveBusy, setManufacturerSaveBusy] = useState(false);
  const [editorMode, setEditorMode] = useState<"simple" | "advanced">("simple");
  const [wizardWebsiteUrl, setWizardWebsiteUrl] = useState("");
  const [wizardSamplesText, setWizardSamplesText] = useState("");
  const [wizardAllowDistributor, setWizardAllowDistributor] = useState(false);
  const [wizardInspectResult, setWizardInspectResult] = useState<ManufacturerInspectResult | null>(null);
  const [wizardTestResult, setWizardTestResult] = useState<ManufacturerTestResult | null>(null);
  const [wizardBusy, setWizardBusy] = useState<"inspect" | "test" | "reset" | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [selectedItemDetail, setSelectedItemDetail] = useState<RunItemRecord | null>(null);
  const [runItemQuery, setRunItemQuery] = useState("");
  const [runItemFilter, setRunItemFilter] = useState<RunItemFilter>("all");
  // Set by clicking a coverage tile (e.g. "Weight") — narrows the run-items list to items where
  // that field is missing, or not-applicable. Combines (AND) with the text search and status filter.
  const [coverageFocus, setCoverageFocus] = useState<CoverageFocus | null>(null);
  const [runItemPageSize, setRunItemPageSize] = useState<RunItemPageSize>(50);
  const [runItemPage, setRunItemPage] = useState(1);
  const [catalogListMessage, setCatalogListMessage] = useState("");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [downloadPdfs, setDownloadPdfs] = useState(false);
  const [downloadCad, setDownloadCad] = useState(false);
  const [downloadImages, setDownloadImages] = useState(true);
  const [generateExcel, setGenerateExcel] = useState(true);
  const [generateLinksFile, setGenerateLinksFile] = useState(false);
  const [forceFinalRetry, setForceFinalRetry] = useState(false);
  const [pdtAiCleanup, setPdtAiCleanup] = useState(false);
  const downloadDocuments = downloadPdfs || downloadCad;
  const setDownloadDocuments = (enabled: boolean) => {
    setDownloadPdfs(enabled);
    setDownloadCad(enabled);
  };
  // PDT routing review modal — opens when "Import to PDT" is clicked, lets user reassign sheets.
  const [pdtRoutingPreview, setPdtRoutingPreview] = useState<PdtRoutingPreview | null>(null);
  const [pdtRoutingOverrides, setPdtRoutingOverrides] = useState<Record<number, string>>({});
  const [pdtRoutingSelected, setPdtRoutingSelected] = useState<Set<number>>(new Set());
  const [pdtRoutingBulkSheet, setPdtRoutingBulkSheet] = useState<string>("");
  const [pdtRoutingLoading, setPdtRoutingLoading] = useState(false);
  // Per-run coverage tiles. `null` means "use the manufacturer default verbatim" — the moment
  // the user types into the editor we copy the manufacturer's list and switch to a concrete
  // array so subsequent edits persist for that run.
  const [runCoverageFields, setRunCoverageFields] = useState<CustomCoverageFieldDraft[] | null>(null);
  const [runHiddenCoverageFields, setRunHiddenCoverageFields] = useState<string[]>([]);
  const [runCoverageExpanded, setRunCoverageExpanded] = useState(false);
  // Dashboard editor state — toggled by the "Edit" button on the coverage panel header.
  // Stays separate from the sidebar editor because it patches the live run's options.
  const [dashboardCoverageEditOpen, setDashboardCoverageEditOpen] = useState(false);
  const [dashboardCoverageDraft, setDashboardCoverageDraft] = useState<CustomCoverageFieldDraft[]>([]);
  const [dashboardHiddenDraft, setDashboardHiddenDraft] = useState<string[]>([]);
  const [dashboardCoverageBusy, setDashboardCoverageBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const selectedManufacturer = useMemo(
    () => manufacturers.find((manufacturer) => manufacturer.id === manufacturerId),
    [manufacturers, manufacturerId]
  );

  const customCoverageDefaults = selectedManufacturer?.customCoverageFields ?? [];
  // What the per-run editor renders. Falls back to a fresh copy of the manufacturer default
  // when the user hasn't overridden anything yet — so they always see what's about to run.
  const effectiveRunCoverageFields: CustomCoverageFieldDraft[] =
    runCoverageFields ??
    customCoverageDefaults.map((field) => ({ id: field.id, label: field.label, pattern: field.pattern }));

  // Switching the manufacturer must clear any per-run override; otherwise the user picks
  // ABB and silently keeps Balluff's IP-rating tile from the previous edit.
  useEffect(() => {
    setRunCoverageFields(null);
    setRunHiddenCoverageFields([]);
  }, [manufacturerId]);

  useEffect(() => {
    void refreshBootstrap();
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    void refreshSelectedRun(selectedRunId);
  }, [selectedRunId]);

  useEffect(() => {
    setRunItemQuery("");
    setRunItemFilter("all");
    setCoverageFocus(null);
    setRunItemPage(1);
    setSelectedItemId(null);
    setSelectedItemDetail(null);
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || !selectedItemId) {
      setSelectedItemDetail(null);
      return;
    }
    let ignore = false;
    getRunItem(selectedRunId, selectedItemId)
      .then((item) => {
        if (ignore) return;
        if (item.result) {
          setSelectedItemDetail(item);
          return;
        }
        setSelectedItemDetail(null);
        setSelectedItemId(null);
      })
      .catch((err) => {
        if (!ignore) setError(errorMessage(err));
      });
    return () => {
      ignore = true;
    };
  }, [selectedItemId, selectedRunId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshRuns();
      if (selectedRunId) void refreshSelectedRun(selectedRunId);
    }, selectedRun?.status === "running" || selectedRun?.status === "queued" || selectedRun?.status === "pausing" || selectedRun?.status === "cancelling" ? 750 : 4000);
    return () => window.clearInterval(timer);
  }, [selectedRunId, selectedRun?.status]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  async function refreshBootstrap() {
    try {
      const [manufacturerData, runData] = await Promise.all([getManufacturers(), listRuns()]);
      setManufacturers(manufacturerData);
      setRuns(runData);
      if (runData[0]) setSelectedRunId(runData[0].id);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function refreshRuns() {
    try {
      setRuns(await listRuns());
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function refreshSelectedRun(id: string) {
    try {
      const data = await getRun(id, { summary: true });
      setSelectedRun(data.run);
      setItems(data.items);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleFile(nextFile: File | null) {
    setFile(nextFile);
    setPreview(null);
    setColumnName("");
    setError(null);
    if (!nextFile) return;
    void rememberDesktopFolder("catalogInput", nextFile);
    setBusy(true);
    try {
      const data = await previewCsv(nextFile);
      setPreview(data);
      setColumnName(data.detectedColumn ?? data.columns[0] ?? "");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function pickCatalogFile() {
    const desktopFiles = await pickDesktopFiles({
      kind: "catalogInput",
      title: "Select catalog input",
      multiple: false,
      filters: [{ name: "Catalog input", extensions: ["csv", "xlsx", "xls"] }]
    });
    if (desktopFiles !== null) {
      if (desktopFiles.length === 0) return;
      await handleFile(desktopFiles[0] ?? null);
      return;
    }

    const picker = (window as Window & { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;
    if (!picker) {
      uploadInputRef.current?.click();
      return;
    }
    try {
      const handles = await picker({
        id: "product-scraper-catalog-source",
        multiple: false,
        types: [
          {
            description: "Catalog input",
            accept: {
              "text/csv": [".csv"],
              "application/vnd.ms-excel": [".xls"],
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"]
            }
          }
        ]
      });
      const nextFile = handles[0] ? await handles[0].getFile() : null;
      await handleFile(nextFile);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(errorMessage(err));
    }
  }

  async function pickCustomerDocuments() {
    const desktopFiles = await pickDesktopFiles({
      kind: "customerDocuments",
      title: "Select customer documents",
      multiple: true,
      filters: [{ name: "Customer documents", extensions: ["pdf", "doc", "docx", "xls", "xlsx", "csv", "tsv", "txt"] }]
    });
    if (desktopFiles !== null) {
      if (desktopFiles.length === 0) return;
      addCustomerDocuments(desktopFiles);
      return;
    }

    const picker = (window as Window & { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;
    if (!picker) {
      customerInputRef.current?.click();
      return;
    }
    try {
      const handles = await picker({
        id: "product-scraper-customer-documents",
        multiple: true,
        types: [
          {
            description: "Customer documents",
            accept: {
              "application/pdf": [".pdf"],
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx", ".doc"],
              "application/vnd.ms-excel": [".xls"],
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
              "text/csv": [".csv"],
              "text/tab-separated-values": [".tsv"],
              "text/plain": [".txt"]
            }
          }
        ]
      });
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      addCustomerDocuments(files);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // showOpenFilePicker threw (e.g. browser rejected a MIME type) — fall back to native input.
      customerInputRef.current?.click();
    }
  }

  async function pickDesktopFiles(options: Parameters<ProductScraperDesktopApi["pickFiles"]>[0]): Promise<File[] | null> {
    if (!window.productScraperDesktop) return null;
    try {
      const pickedFiles = await window.productScraperDesktop.pickFiles(options);
      return pickedFiles.map(desktopPickedFileToFile);
    } catch (err) {
      setError(errorMessage(err));
      return [];
    }
  }

  function desktopPickedFileToFile(pickedFile: ProductScraperDesktopPickedFile): File {
    const data =
      pickedFile.data instanceof ArrayBuffer
        ? pickedFile.data
        : new Uint8Array(pickedFile.data).buffer;
    return new File([data], pickedFile.name, { type: pickedFile.type || undefined });
  }

  async function rememberDesktopFolder(kind: "catalogInput" | "customerDocuments", file: File) {
    try {
      await window.productScraperDesktop?.rememberFileFolder(kind, file);
    } catch {
      // Folder memory is a desktop convenience; uploads should keep working if it is unavailable.
    }
  }

  function hasDraggedFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleUploadDragEnter(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setUploadDragActive(true);
  }

  function handleUploadDragOver(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setUploadDragActive(true);
  }

  function handleUploadDragLeave(event: DragEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setUploadDragActive(false);
  }

  function handleUploadDrop(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setUploadDragActive(false);
    void handleFile(event.dataTransfer.files?.[0] ?? null);
  }

  function addCustomerDocuments(incoming: FileList | File[] | null | undefined) {
    if (!incoming) return;
    const files = Array.from(incoming);
    if (!files.length) return;
    void rememberDesktopFolder("customerDocuments", files[files.length - 1]);
    setCustomerDocuments((current) => {
      const existingKeys = new Set(current.map((file) => `${file.name}|${file.size}`));
      const merged = [...current];
      for (const file of files) {
        const key = `${file.name}|${file.size}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        merged.push(file);
      }
      return merged;
    });
  }

  function removeCustomerDocument(index: number) {
    setCustomerDocuments((current) => current.filter((_, idx) => idx !== index));
  }

  function handleCustomerDragEnter(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setCustomerDragActive(true);
  }

  function handleCustomerDragOver(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setCustomerDragActive(true);
  }

  function handleCustomerDragLeave(event: DragEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setCustomerDragActive(false);
  }

  function handleCustomerDrop(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setCustomerDragActive(false);
    addCustomerDocuments(event.dataTransfer.files);
  }

  async function handleStart() {
    if (!file || !columnName) return;
    setBusy(true);
    setError(null);
    try {
      // Only send the override when the user touched it; `null` keeps the manufacturer
      // default (the server falls back to manufacturer.customCoverageFields in that case).
      const customCoverageFields =
        runCoverageFields === null
          ? undefined
          : runCoverageFields
              .map((field) => ({ id: field.id, label: field.label.trim(), pattern: field.pattern.trim() }))
              .filter((field) => field.label && field.pattern);
      const run = await startRun({
        file,
        manufacturerId,
        columnName,
        downloadDocuments: downloadPdfs || downloadCad,
        downloadPdfs,
        downloadCad,
        downloadImages,
        generateExcel,
        generateLinksFile,
        customCoverageFields,
        hiddenCoverageFields: runHiddenCoverageFields.length > 0 ? runHiddenCoverageFields : undefined,
        forceFinalRetry,
        customerDocuments: customerDocuments.length > 0 ? customerDocuments : undefined
      });
      setSelectedRunId(run.id);
      // Reset the override after each run so the next one re-inherits the (possibly updated)
      // manufacturer default.
      setRunCoverageFields(null);
      setRunHiddenCoverageFields([]);
      // Clear customer documents — they're now persisted in the run folder. The next run
      // starts fresh and the user re-attaches whatever's needed.
      setCustomerDocuments([]);
      await refreshRuns();
      await refreshSelectedRun(run.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!selectedRun) return;
    setCancelBusy(true);
    setError(null);
    try {
      const run = await cancelRun(selectedRun.id);
      setSelectedRun(run);
      await refreshRuns();
      await refreshSelectedRun(run.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCancelBusy(false);
    }
  }

  async function handlePause() {
    if (!selectedRun) return;
    setPauseBusy(true);
    setError(null);
    try {
      const run = await pauseRun(selectedRun.id);
      setSelectedRun(run);
      await refreshRuns();
      await refreshSelectedRun(run.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPauseBusy(false);
    }
  }

  async function handleResume() {
    if (!selectedRun) return;
    setResumeBusy(true);
    setError(null);
    try {
      const run = await resumeRun(selectedRun.id);
      setSelectedRun(run);
      await refreshRuns();
      await refreshSelectedRun(run.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setResumeBusy(false);
    }
  }

  async function handleOpenWorkbook() {
    if (!selectedRun) return;
    setOpenWorkbookBusy(true);
    setError(null);
    try {
      await openRunWorkbook(selectedRun.id);
    } catch (err) {
      setError(errorMessage(err));
      window.location.href = `/api/runs/${selectedRun.id}/files/result`;
    } finally {
      setOpenWorkbookBusy(false);
    }
  }

  async function handleOpenOutputFolder() {
    if (!selectedRun) return;
    setOpenOutputFolderBusy(true);
    setError(null);
    try {
      await openRunOutputFolder(selectedRun.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setOpenOutputFolderBusy(false);
    }
  }

  async function handleImportPdt() {
    if (!selectedRun) return;
    setError(null);
    setPdtRoutingLoading(true);
    try {
      const preview = await getRunPdtRoutingPreview(selectedRun.id);
      // Seed overrides with auto-suggested sheet (first one) so the dropdown always has a value.
      const seeded: Record<number, string> = {};
      for (const it of preview.items) {
        if (it.suggestedSheets.length > 0) seeded[it.itemId] = it.suggestedSheets[0];
      }
      setPdtRoutingOverrides(seeded);
      setPdtRoutingSelected(new Set());
      setPdtRoutingBulkSheet("");
      setPdtRoutingPreview(preview);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPdtRoutingLoading(false);
    }
  }

  async function handleConfirmPdtRouting() {
    if (!selectedRun || !pdtRoutingPreview) return;
    const preview = pdtRoutingPreview;
    setPdtRoutingPreview(null);
    setPdtRoutingSelected(new Set());
    setPdtRoutingBulkSheet("");
    setPdtBusy(true);
    setError(null);
    try {
      // Build the override payload: one chosen sheet per item, but only when it differs from the
      // auto-suggestion (keeps payload small and lets the server skip unnecessary work).
      const payload: Record<number, string[]> = {};
      for (const it of preview.items) {
        const chosen = pdtRoutingOverrides[it.itemId];
        if (!chosen) continue;
        const auto = it.suggestedSheets[0];
        if (chosen !== auto) payload[it.itemId] = [chosen];
      }
      const result = await importRunPdt(selectedRun.id, {
        aiCleanup: pdtAiCleanup,
        sheetOverrides: Object.keys(payload).length > 0 ? payload : undefined
      });
      await refreshSelectedRun(selectedRun.id);
      const warnings = [pdtImportWarning(result.stats)].filter(Boolean) as string[];
      if (result.stats.cleanup && ["qwen_unavailable", "qwen_no_valid_output"].includes(result.stats.cleanup.status)) {
        warnings.push(`PDT AI cleanup: ${result.stats.cleanup.message}`);
      }
      if (warnings.length > 0) setError(warnings.join(" "));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPdtBusy(false);
    }
  }

  async function handleOpenPdt() {
    if (!selectedRun) return;
    setPdtBusy(true);
    setError(null);
    try {
      await openRunPdt(selectedRun.id);
    } catch (err) {
      setError(errorMessage(err));
      window.location.href = `/api/runs/${selectedRun.id}/files/pdt`;
    } finally {
      setPdtBusy(false);
    }
  }

  function openDashboardCoverageEditor() {
    setDashboardCoverageDraft(
      activeCustomCoverageFields.map((field) => ({ id: field.id, label: field.label, pattern: field.pattern }))
    );
    setDashboardHiddenDraft([...activeHiddenCoverageFields]);
    setDashboardCoverageEditOpen(true);
  }

  async function saveDashboardCoverageEditor() {
    if (!selectedRun) return;
    setDashboardCoverageBusy(true);
    setError(null);
    try {
      const fields = dashboardCoverageDraft
        .map((field) => ({
          id: field.id,
          label: field.label.trim(),
          pattern: field.pattern.trim()
        }))
        .filter((field) => field.label && field.pattern);
      await updateRunCoverageFields(selectedRun.id, fields, dashboardHiddenDraft);
      setDashboardCoverageEditOpen(false);
      await refreshSelectedRun(selectedRun.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDashboardCoverageBusy(false);
    }
  }

  function toggleHiddenBuiltIn(key: string) {
    setDashboardHiddenDraft((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]
    );
  }

  function openEditManufacturer() {
    if (!selectedManufacturer) return;
    setManufacturerDraft(toManufacturerDraft(selectedManufacturer));
    setEditorMode("simple");
    setWizardWebsiteUrl(selectedManufacturer.officialBaseUrls[0] ?? "");
    setWizardSamplesText("");
    setWizardAllowDistributor(selectedManufacturer.scrapeRecipe?.fallbackPolicy?.distributorFallback === true);
    setWizardInspectResult(null);
    setWizardTestResult(null);
    setManufacturerEditorOpen(true);
  }

  function openNewManufacturer() {
    setManufacturerDraft(emptyManufacturerDraft());
    setEditorMode("simple");
    setWizardWebsiteUrl("");
    setWizardSamplesText("");
    setWizardAllowDistributor(false);
    setWizardInspectResult(null);
    setWizardTestResult(null);
    setManufacturerEditorOpen(true);
  }

  function updateManufacturerDraft(patch: Partial<ManufacturerDraft>) {
    setManufacturerDraft((current) => ({ ...current, ...patch }));
    setWizardTestResult(null);
  }

  function updateSourceDraft(index: number, patch: Partial<SourceDraft>) {
    setManufacturerDraft((current) => ({
      ...current,
      fallbackSources: current.fallbackSources.map((source, sourceIndex) => (sourceIndex === index ? { ...source, ...patch } : source))
    }));
    setWizardTestResult(null);
  }

  function updateRecipeDraft(patch: ScrapeRecipeConfig) {
    setManufacturerDraft((current) => {
      const existing = parseRecipeJsonLoose(current.scrapeRecipeJson);
      return {
        ...current,
        scrapeRecipeJson: formatJson(mergeRecipeConfig(existing, patch))
      };
    });
    setWizardTestResult(null);
  }

  function handleSimpleNameChange(value: string) {
    const oldAutoShort = shortNameFromName(manufacturerDraft.canonicalName);
    const oldAutoId = slugify(manufacturerDraft.canonicalName);
    const patch: Partial<ManufacturerDraft> = { canonicalName: value };
    if (!manufacturerDraft.shortName.trim() || manufacturerDraft.shortName === oldAutoShort) patch.shortName = shortNameFromName(value);
    if (!manufacturerDraft.id.trim() || manufacturerDraft.id === oldAutoId) patch.id = slugify(value);
    updateManufacturerDraft(patch);
  }

  function handleSimpleWebsiteChange(value: string) {
    setWizardWebsiteUrl(value);
    setManufacturerDraft((current) => ({
      ...current,
      officialBaseUrlsText: value.trim()
    }));
    setWizardInspectResult(null);
    setWizardTestResult(null);
  }

  function handleSimpleSamplesChange(value: string) {
    setWizardSamplesText(value);
    setWizardInspectResult(null);
    setWizardTestResult(null);
  }

  function handleRunItemQueryChange(value: string) {
    setRunItemQuery(value);
    setRunItemPage(1);
  }

  function handleRunItemFilterChange(value: RunItemFilter) {
    setRunItemFilter(value);
    setRunItemPage(1);
  }

  function handleCoverageFocusChange(value: CoverageFocus | null) {
    setCoverageFocus(value);
    setRunItemPage(1);
  }

  function handleRunItemPageSizeChange(value: string) {
    if (value === "all") {
      setRunItemPageSize("all");
      setRunItemPage(1);
      return;
    }
    const nextSize = Number(value);
    if (!RUN_ITEM_PAGE_SIZES.includes(nextSize as RunItemPageSize)) return;
    setRunItemPageSize(nextSize as RunItemPageSize);
    setRunItemPage(1);
  }

  async function handleCatalogListExport(label: string, sourceItems: RunItemRecord[]) {
    const catalogNumbers = uniqueCatalogNumbers(sourceItems);
    const body = catalogNumbers.join("\n");
    const fileName = `${slugify(label)}-catalogs.txt`;
    try {
      if (!body) throw new Error("No catalog numbers in this list.");
      const copied = await copyTextToClipboard(body);
      if (!copied) downloadTextFile(fileName, body);
      setCatalogListMessage(`${catalogNumbers.length} ${copied ? "copied" : "saved"}`);
    } catch {
      if (body) downloadTextFile(fileName, body);
      setCatalogListMessage(body ? `${catalogNumbers.length} saved` : "No rows");
    }
  }

  function handleDistributorFallbackToggle(checked: boolean) {
    setWizardAllowDistributor(checked);
    setWizardTestResult(null);
    setManufacturerDraft((current) => {
      const existing = parseRecipeJsonLoose(current.scrapeRecipeJson);
      return {
        ...current,
        scrapeRecipeJson: formatJson(mergeRecipeConfig(existing, {
          fallbackPolicy: {
            ...(existing.fallbackPolicy ?? {}),
            distributorFallback: checked,
            distributorConfidenceCap: 0.45
          }
        }))
      };
    });
  }

  function addSourceDraft() {
    setManufacturerDraft((current) => ({
      ...current,
      fallbackSources: [...current.fallbackSources, emptySourceDraft(current.fallbackSources.length + 1)]
    }));
  }

  function removeSourceDraft(index: number) {
    setManufacturerDraft((current) => ({
      ...current,
      fallbackSources: current.fallbackSources.filter((_, sourceIndex) => sourceIndex !== index)
    }));
  }

  async function handleSaveManufacturer() {
    if (!wizardTestResult?.passed) {
      setError("Run Test samples first. At least one sample must find an official product before saving.");
      return;
    }
    setManufacturerSaveBusy(true);
    setError(null);
    try {
      const payload = manufacturerDraftToConfig(manufacturerDraft);
      const data = await saveManufacturer(payload);
      setManufacturers(data.manufacturers);
      setManufacturerId(data.manufacturer.id);
      setManufacturerEditorOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setManufacturerSaveBusy(false);
    }
  }

  async function handleInspectManufacturer() {
    setWizardBusy("inspect");
    setError(null);
    setWizardTestResult(null);
    try {
      const result = await inspectManufacturer({
        canonicalName: manufacturerDraft.canonicalName,
        shortName: manufacturerDraft.shortName,
        websiteUrl: wizardWebsiteUrl,
        sampleCatalogNumbers: splitFlexibleList(wizardSamplesText),
        allowDistributorFallback: wizardAllowDistributor
      });
      setWizardInspectResult(result);
      setManufacturerDraft(toManufacturerDraft(result.suggested));
      setWizardWebsiteUrl(result.suggested.officialBaseUrls[0] ?? wizardWebsiteUrl);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setWizardBusy(null);
    }
  }

  async function handleTestManufacturer() {
    setWizardBusy("test");
    setError(null);
    try {
      const manufacturer = manufacturerDraftToConfig(manufacturerDraft);
      const result = await testManufacturer({
        manufacturer,
        sampleCatalogNumbers: splitFlexibleList(wizardSamplesText)
      });
      setWizardTestResult(result);
      if (!result.passed) setError(result.warnings[0] ?? "No sample found an official product yet.");
    } catch (err) {
      setError(errorMessage(err));
      setWizardTestResult(null);
    } finally {
      setWizardBusy(null);
    }
  }

  async function handleResetOverride() {
    const targetId = manufacturerDraft.id || selectedManufacturer?.id;
    if (!targetId) return;
    setWizardBusy("reset");
    setError(null);
    try {
      const data = await resetManufacturerOverride(targetId);
      setManufacturers(data.manufacturers);
      setManufacturerId(data.manufacturer.id);
      setManufacturerDraft(toManufacturerDraft(data.manufacturer));
      setWizardWebsiteUrl(data.manufacturer.officialBaseUrls[0] ?? "");
      setWizardInspectResult(null);
      setWizardTestResult(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setWizardBusy(null);
    }
  }

  const hasSelectedOutput = generateExcel || downloadImages || downloadPdfs || downloadCad || generateLinksFile;
  const readyToRun = Boolean(file && preview && columnName && selectedManufacturer && hasSelectedOutput);
  const canPause = selectedRun?.status === "queued" || selectedRun?.status === "running";
  const canResume = selectedRun?.status === "paused" || selectedRun?.status === "pausing";
  const canCancel =
    selectedRun?.status === "queued" ||
    selectedRun?.status === "running" ||
    selectedRun?.status === "pausing" ||
    selectedRun?.status === "paused" ||
    selectedRun?.status === "cancelling";
  const runFinished = selectedRun?.status === "completed" || selectedRun?.status === "cancelled";
  // "Images only" runs never produce an .xlsx, so the Excel button must hide; the run's
  // outputPath is the cleanest signal that a workbook actually exists on disk.
  const hasWorkbook = runFinished && Boolean(selectedRun?.outputPath);
  const hasPdt = runFinished && Boolean(selectedRun?.pdtPath);
  const hasOutputFolder = runFinished;
  const historyCount = runs.length;
  const activeRunCount = runs.filter((run) => ["queued", "running", "pausing"].includes(run.status)).length;
  const manufacturerSourceCount = selectedManufacturer?.fallbackSources.filter((source) => source.enabled).length ?? 0;
  const activeManufacturer = useMemo(
    () =>
      selectedRun
        ? manufacturers.find((manufacturer) => manufacturer.id === selectedRun.manufacturerId)
        : selectedManufacturer,
    [manufacturers, selectedManufacturer, selectedRun]
  );
  // Custom tiles come from the run override when set, otherwise from the manufacturer default
  // — same fallback chain the server uses. Lets the dashboard editor edit per-run state
  // without losing the manufacturer-level defaults.
  const activeCustomCoverageFields =
    selectedRun?.options?.customCoverageFields ?? activeManufacturer?.customCoverageFields ?? [];
  const activeHiddenCoverageFields = selectedRun?.options?.hiddenCoverageFields ?? [];
  const coverage = useMemo(
    () => {
      const rows = buildCoverage(items, activeCustomCoverageFields);
      if (!activeHiddenCoverageFields.length) return rows;
      const hidden = new Set(activeHiddenCoverageFields);
      // Custom rows are keyed `custom:<id>` in buildCoverage. Match both forms so the user
      // can hide either a built-in (key === "weight") or a custom tile by its id.
      return rows.filter((row) => !hidden.has(row.key) && !hidden.has(row.key.replace(/^custom:/, "")));
    },
    [items, activeCustomCoverageFields, activeHiddenCoverageFields]
  );
  const coverageTotal = items.filter((item) => item.result || item.coverage).length;
  const runTiming = useMemo(() => buildRunTiming(selectedRun, items, nowMs), [items, nowMs, selectedRun]);
  const progress = runTiming.progressPercent;
  const runItemFilterCounts = useMemo(() => buildRunItemFilterCounts(items), [items]);
  const filteredItems = useMemo(
    () => filterRunItems(items, runItemQuery, runItemFilter, coverageFocus),
    [items, runItemQuery, runItemFilter, coverageFocus]
  );
  const failedListItems = useMemo(() => items.filter((item) => item.status === "failed"), [items]);
  const missingImageListItems = useMemo(
    () => items.filter((item) => item.status !== "pending" && item.status !== "processing" && coverageState(item, "image") === "missing"),
    [items]
  );
  const runItemQueryImpact = useMemo(
    () => buildRunItemQueryImpact(items, runItemQuery, runItemFilter),
    [items, runItemFilter, runItemQuery]
  );
  const effectiveRunItemPageSize = runItemPageSize === "all" ? Math.max(filteredItems.length, 1) : runItemPageSize;
  const runItemPageCount = runItemPageSize === "all" ? 1 : Math.max(1, Math.ceil(filteredItems.length / effectiveRunItemPageSize));
  const safeRunItemPage = Math.min(runItemPage, runItemPageCount);
  const runItemStartIndex = filteredItems.length ? (safeRunItemPage - 1) * effectiveRunItemPageSize : 0;
  const runItemPageItems = useMemo(
    () => filteredItems.slice(runItemStartIndex, runItemStartIndex + effectiveRunItemPageSize),
    [effectiveRunItemPageSize, filteredItems, runItemStartIndex]
  );
  const runItemEndIndex = Math.min(runItemStartIndex + runItemPageItems.length, filteredItems.length);
  const selectedHistoryRun = selectedRun ?? runs[0] ?? null;
  const selectedItem = selectedItemDetail?.result ? selectedItemDetail : null;
  const recipeDraft = useMemo(() => parseRecipeJsonLoose(manufacturerDraft.scrapeRecipeJson), [manufacturerDraft.scrapeRecipeJson]);
  const editorManufacturer = useMemo(
    () => manufacturers.find((manufacturer) => manufacturer.id === manufacturerDraft.id) ?? null,
    [manufacturers, manufacturerDraft.id]
  );
  const sampleCatalogNumbers = splitFlexibleList(wizardSamplesText);
  const canInspectManufacturer = Boolean(wizardWebsiteUrl.trim() && sampleCatalogNumbers.length > 0 && manufacturerDraft.canonicalName.trim());
  const canTestManufacturer = Boolean(sampleCatalogNumbers.length > 0 && manufacturerDraft.officialBaseUrlsText.trim());
  const canSaveManufacturer = Boolean(wizardTestResult?.passed);
  const overrideActive = editorManufacturer?.origin === "override" || editorManufacturer?.hasOverride;

  useEffect(() => {
    setRunItemPage((current) => Math.min(Math.max(current, 1), runItemPageCount));
  }, [runItemPageCount]);

  useEffect(() => {
    if (!catalogListMessage) return;
    const timer = window.setTimeout(() => setCatalogListMessage(""), 2500);
    return () => window.clearTimeout(timer);
  }, [catalogListMessage]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">
            <Database size={22} />
          </div>
          <div>
            <div className="brand-line">Product Scraper</div>
            <h1>Product Data Terminal</h1>
            <p>Local runs. Excel, images, documents and logs per manufacturer.</p>
          </div>
        </div>
        <div className="topbar-actions">
          <TopStat icon={<Activity size={15} />} label="Mode" value="Local" />
          <TopStat icon={<Layers3 size={15} />} label="Manufacturers" value={manufacturers.length} />
          <TopStat icon={<History size={15} />} label="Runs" value={historyCount} />
          <TopStat icon={<Clock3 size={15} />} label="Active" value={activeRunCount} tone={activeRunCount ? "hot" : "calm"} />
        </div>
      </header>

      {error && (
        <div className="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <section className="workspace">
        <aside className="setup-panel">
          <PanelTitle icon={<Settings2 size={18} />} title="Run setup" meta={readyToRun ? "Ready" : "Waiting"} />

          <div className="workflow-steps" aria-label="Run setup steps">
            <StepState done={Boolean(selectedManufacturer)} label="Manufacturer" index="01" />
            <StepState done={Boolean(preview)} label="Input file" index="02" />
            <StepState done={readyToRun} label="Run" index="03" />
          </div>

          <label className="field tight-field">
            <span>Manufacturer</span>
            <Dropdown
              ariaLabel="Manufacturer"
              value={manufacturerId}
              onChange={(next) => setManufacturerId(next)}
              options={manufacturers.map((manufacturer) => ({
                value: manufacturer.id,
                label: `${manufacturer.shortName} - ${manufacturer.canonicalName}`
              }))}
            />
          </label>
          {selectedManufacturer && (
            <div className="manufacturer-card">
              <div className="manufacturer-logo">{selectedManufacturer.shortName}</div>
              <div>
                <strong>{selectedManufacturer.canonicalName}</strong>
                <span>
                  {manufacturerSourceCount} enabled sources - {selectedManufacturer.rateLimitMs} ms rate limit
                </span>
              </div>
            </div>
          )}
          <div className="manufacturer-actions">
            <button type="button" className="secondary-action" onClick={openEditManufacturer} disabled={!selectedManufacturer}>
              <Pencil size={15} />
              Edit
            </button>
            <button type="button" className="secondary-action" onClick={openNewManufacturer}>
              <Plus size={15} />
              New
            </button>
          </div>

          <div
            className={`upload-zone${uploadDragActive ? " is-dragging" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => void pickCatalogFile()}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              void pickCatalogFile();
            }}
            onDragEnter={handleUploadDragEnter}
            onDragOver={handleUploadDragOver}
            onDragLeave={handleUploadDragLeave}
            onDrop={handleUploadDrop}
          >
            <span className="upload-icon">
              <Upload size={25} />
            </span>
            <strong>{file ? file.name : "Drop or select CSV/XLSX"}</strong>
            <span>{file ? "File loaded for preview" : "One catalog-number column"}</span>
            <input
              ref={uploadInputRef}
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => void handleFile(event.currentTarget.files?.[0] ?? null)}
            />
          </div>

          {preview && (
            <>
              <label className="field">
                <span>Catalog column</span>
                <Dropdown
                  ariaLabel="Catalog column"
                  value={columnName}
                  onChange={(next) => setColumnName(next)}
                  options={preview.columns.map((column) => ({ value: column, label: column }))}
                />
              </label>
              <div className="mini-summary">
                <div>
                  <strong>{preview.rowCount}</strong>
                  <span>Rows</span>
                </div>
                <div>
                  <strong>{preview.detectedColumn ?? "Manual"}</strong>
                  <span>Detected column</span>
                </div>
              </div>
              {preview.warnings.map((warning) => (
                <p className="warning" key={warning}>
                  {warning}
                </p>
              ))}
            </>
          )}

          <div
            className={`upload-zone customer-doc-zone${customerDragActive ? " is-dragging" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => void pickCustomerDocuments()}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              void pickCustomerDocuments();
            }}
            onDragEnter={handleCustomerDragEnter}
            onDragOver={handleCustomerDragOver}
            onDragLeave={handleCustomerDragLeave}
            onDrop={handleCustomerDrop}
          >
            <span className="upload-icon">
              <FileText size={22} />
            </span>
            <strong>
              {customerDocuments.length
                ? `${customerDocuments.length} customer document${customerDocuments.length === 1 ? "" : "s"} attached`
                : "Customer documents (optional)"}
            </strong>
            <span>
              Drop PDFs, DOCs, XLSX or CSVs. Data extracted from these files overrides
              the website scrape — use this when the customer hands you their own source.
            </span>
            <input
              ref={customerInputRef}
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.tsv,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                addCustomerDocuments(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </div>
          {customerDocuments.length > 0 && (
            <ul className="customer-doc-list">
              {customerDocuments.map((doc, index) => (
                <li key={`${doc.name}-${index}`}>
                  <span>
                    <FileCheck2 size={14} />
                    <strong>{doc.name}</strong>
                    <small>{formatFileSize(doc.size)}</small>
                  </span>
                  <button
                    type="button"
                    className="cancel-button compact-action"
                    onClick={() => removeCustomerDocument(index)}
                    aria-label={`Remove ${doc.name}`}
                  >
                    <XCircle size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <fieldset className="run-option-group">
            <legend>Outputs</legend>
            <div className="run-checkbox-grid">
              <label className={`run-checkbox-card${generateExcel ? " is-selected" : ""}`}>
                <input type="checkbox" checked={generateExcel} onChange={(event) => setGenerateExcel(event.target.checked)} />
                <span>
                  <strong>Excel</strong>
                  <small>Workbook with scraped product data.</small>
                </span>
              </label>
              <label className={`run-checkbox-card${downloadImages ? " is-selected" : ""}`}>
                <input type="checkbox" checked={downloadImages} onChange={(event) => setDownloadImages(event.target.checked)} />
                <span>
                  <strong>Images</strong>
                  <small>Save product images to the images folder.</small>
                </span>
              </label>
              <label className={`run-checkbox-card${downloadPdfs ? " is-selected" : ""}`}>
                <input type="checkbox" checked={downloadPdfs} onChange={(event) => setDownloadPdfs(event.target.checked)} />
                <span>
                  <strong>PDFs</strong>
                  <small>Datasheets, manuals and certificates.</small>
                </span>
              </label>
              <label className={`run-checkbox-card${downloadCad ? " is-selected" : ""}`}>
                <input type="checkbox" checked={downloadCad} onChange={(event) => setDownloadCad(event.target.checked)} />
                <span>
                  <strong>CAD</strong>
                  <small>CAD files in a separate cad folder.</small>
                </span>
              </label>
              <label className={`run-checkbox-card${generateLinksFile ? " is-selected" : ""}`}>
                <input type="checkbox" checked={generateLinksFile} onChange={(event) => setGenerateLinksFile(event.target.checked)} />
                <span>
                  <strong>Device links</strong>
                  <small>Separate CSV with product URLs.</small>
                </span>
              </label>
            </div>
            {false && (
              [
                {
                  id: "excel-images",
                  title: "Excel + images",
                  hint: "Default. Workbook with product data and downloaded images.",
                  docs: false,
                  images: true,
                  excel: true
                },
                {
                  id: "excel-only",
                  title: "Excel only",
                  hint: "Workbook only. Image URLs stay in cells but no PNGs are saved.",
                  docs: false,
                  images: false,
                  excel: true
                },
                {
                  id: "images-only",
                  title: "Images only",
                  hint: "Just the PNG files on disk — no Excel workbook is created.",
                  docs: false,
                  images: true,
                  excel: false
                },
                {
                  id: "full",
                  title: "Excel + images + PDFs/CAD",
                  hint: "Everything: workbook, images, datasheets, manuals and CAD models.",
                  docs: true,
                  images: true,
                  excel: true
                }
              ] as const
            ).map((preset) => {
              const checked =
                downloadDocuments === preset.docs &&
                downloadImages === preset.images &&
                generateExcel === preset.excel;
              return (
                <label key={preset.id} className={`run-option-card${checked ? " is-selected" : ""}`}>
                  <input
                    type="radio"
                    name="download-mode"
                    checked={checked}
                    onChange={() => {
                      setDownloadDocuments(preset.docs);
                      setDownloadImages(preset.images);
                      setGenerateExcel(preset.excel);
                    }}
                  />
                  <span>
                    <strong>{preset.title}</strong>
                    <small>{preset.hint}</small>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <details
            className="run-coverage-editor"
            open={runCoverageExpanded}
            onToggle={(event) => setRunCoverageExpanded((event.target as HTMLDetailsElement).open)}
          >
            <summary>
              <span>
                <strong>Coverage tiles for this run</strong>
                <small>
                  {effectiveRunCoverageFields.length === 0
                    ? "Built-in only (Weight, Material, …)"
                    : `Built-in + ${effectiveRunCoverageFields.length} custom`}
                  {runCoverageFields !== null && customCoverageDefaults.length !== effectiveRunCoverageFields.length
                    ? " · overridden for this run"
                    : ""}
                </small>
              </span>
              <ChevronDown size={16} />
            </summary>
            <div className="run-coverage-editor-body">
              <p className="muted-note">
                Click a built-in tile to hide it. Add custom tiles below — each matches by attribute
                name (regex, case-insensitive). Manufacturer default loaded; edits apply to this run only.
              </p>
              <div className="coverage-builtin-toggles" role="group" aria-label="Built-in coverage tiles">
                {REQUIRED_COVERAGE_FIELDS.map((field) => {
                  const hidden = runHiddenCoverageFields.includes(field.key);
                  return (
                    <button
                      key={field.key}
                      type="button"
                      className={`coverage-toggle-chip${hidden ? " is-off" : ""}`}
                      onClick={() =>
                        setRunHiddenCoverageFields((current) =>
                          current.includes(field.key)
                            ? current.filter((entry) => entry !== field.key)
                            : [...current, field.key]
                        )
                      }
                      aria-pressed={!hidden}
                    >
                      {hidden ? "✕ " : "✓ "}
                      {field.label}
                    </button>
                  );
                })}
              </div>
              <p className="muted-note">Custom tiles</p>
              {effectiveRunCoverageFields.map((field, index) => (
                <div key={index} className="coverage-editor-row">
                  <label className="field">
                    <span>Label</span>
                    <input
                      value={field.label}
                      placeholder="IP Rating"
                      onChange={(event) => {
                        const next = effectiveRunCoverageFields.map((current, idx) =>
                          idx === index ? { ...current, label: event.target.value } : current
                        );
                        setRunCoverageFields(next);
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>Match pattern (regex)</span>
                    <input
                      value={field.pattern}
                      placeholder="ip rating|ingress"
                      onChange={(event) => {
                        const next = effectiveRunCoverageFields.map((current, idx) =>
                          idx === index ? { ...current, pattern: event.target.value } : current
                        );
                        setRunCoverageFields(next);
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="cancel-button compact-action"
                    onClick={() => setRunCoverageFields(effectiveRunCoverageFields.filter((_, idx) => idx !== index))}
                    aria-label={`Remove ${field.label || "custom field"}`}
                  >
                    <XCircle size={16} />
                  </button>
                </div>
              ))}
              <div className="run-coverage-editor-actions">
                <button
                  type="button"
                  className="secondary-action compact-action"
                  onClick={() =>
                    setRunCoverageFields([
                      ...effectiveRunCoverageFields,
                      { id: "", label: "", pattern: "" }
                    ])
                  }
                >
                  <Plus size={16} />
                  Add field
                </button>
                {runCoverageFields !== null && (
                  <button
                    type="button"
                    className="text-link-button"
                    onClick={() => setRunCoverageFields(null)}
                  >
                    Reset to manufacturer default
                  </button>
                )}
              </div>
            </div>
          </details>

          <label className="run-option-card">
            <input
              type="checkbox"
              checked={forceFinalRetry}
              onChange={(event) => setForceFinalRetry(event.target.checked)}
            />
            <span>
              <strong>Force final retry</strong>
              <small>
                Re-attempts the final network retry for catalog numbers that were previously
                confirmed as having no published value (weight, dimensions, material). Slower —
                use only when you suspect the source has been updated.
              </small>
            </span>
          </label>

          <button className="primary-action" disabled={!readyToRun || busy} onClick={() => void handleStart()}>
            {busy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            {busy ? "Preparing run" : "Start scrape"}
          </button>

          <div className="source-policy">
            <Search size={17} />
            <p>
              Official source first. Fallback only fills missing data.
            </p>
          </div>
        </aside>

        <section className="main-panel">
          <div className="run-header">
            <PanelTitle icon={<FileSpreadsheet size={18} />} title="Current run" meta={selectedRun?.id ?? "No run"} />
            <div className="run-actions">
              {canPause && selectedRun && (
                <button className="pause-button" disabled={pauseBusy} onClick={() => void handlePause()}>
                  {pauseBusy ? <Loader2 className="spin" size={16} /> : <Pause size={16} />}
                  {pauseBusy ? "Pausing" : "Pause"}
                </button>
              )}
              {canResume && selectedRun && (
                <button className="download-button" disabled={resumeBusy} onClick={() => void handleResume()}>
                  {resumeBusy ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                  {resumeBusy ? "Resuming" : "Resume"}
                </button>
              )}
              {canCancel && (
                <button className="cancel-button" disabled={cancelBusy || selectedRun.status === "cancelling"} onClick={() => void handleCancel()}>
                  {cancelBusy ? <Loader2 className="spin" size={16} /> : <XCircle size={16} />}
                  {selectedRun.status === "cancelling" ? "Cancelling" : "Cancel"}
                </button>
              )}
              {hasWorkbook && (
                <button type="button" className="download-button" onClick={() => void handleOpenWorkbook()} disabled={openWorkbookBusy}>
                  {openWorkbookBusy ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                  {openWorkbookBusy ? "Opening" : "Excel"}
                </button>
              )}
              {hasWorkbook && (
                <label className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={pdtAiCleanup}
                    onChange={(event) => setPdtAiCleanup(event.target.checked)}
                    disabled={pdtBusy}
                  />
                  AI clean
                </label>
              )}
              {hasWorkbook && (
                <button
                  type="button"
                  className="download-button secondary"
                  onClick={() => void handleImportPdt()}
                  disabled={pdtBusy || pdtRoutingLoading}
                >
                  {pdtBusy || pdtRoutingLoading ? <Loader2 className="spin" size={16} /> : <FileOutput size={16} />}
                  {pdtBusy ? "Importing" : pdtRoutingLoading ? "Loading" : "Import to PDT"}
                </button>
              )}
              {hasPdt && (
                <button type="button" className="download-button secondary" onClick={() => void handleOpenPdt()} disabled={pdtBusy}>
                  {pdtBusy ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                  PDT
                </button>
              )}
              {hasOutputFolder && (
                <button type="button" className="download-button secondary" onClick={() => void handleOpenOutputFolder()} disabled={openOutputFolderBusy}>
                  {openOutputFolderBusy ? <Loader2 className="spin" size={16} /> : <FolderOpen size={16} />}
                  {openOutputFolderBusy ? "Opening" : "Folder"}
                </button>
              )}
              {selectedRun && !["queued", "running", "pausing", "cancelling"].includes(selectedRun.status) && (
                <a className="download-button secondary" href={`/api/runs/${selectedRun.id}/files/log`}>
                  <FileText size={16} />
                  Log
                </a>
              )}
            </div>
          </div>

          {selectedRun ? (
            <>
              <div className="progress-block">
                <div className="progress-meta">
                  <div>
                    <span className="section-label">Run progress</span>
                    <strong className="progress-percent">{progress}%</strong>
                    <span className="run-file-name">{selectedRun.inputFileName ?? "CSV import"}</span>
                  </div>
                  <StatusBadge status={selectedRun.status} />
                </div>
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div style={{ width: `${progress}%` }} />
                </div>
                <div className="progress-scale">
                  <span>0%</span>
                  <span>{selectedRun.processed} / {selectedRun.total} processed</span>
                  <span>100%</span>
                </div>
                <div className="eta-grid">
                  <Metric label="Elapsed" value={runTiming.elapsed} />
                  <Metric label="Finish" value={runTiming.eta} />
                  <Metric label="Remaining" value={runTiming.remaining} />
                  <Metric label="Avg/item" value={runTiming.avgPerItem} />
                </div>
                <div className="activity-panel">
                  <div className="activity-copy">
                    <span className="section-label">Current activity</span>
                    <strong>{runTiming.activityTitle}</strong>
                    <p>{runTiming.activityDetail}</p>
                  </div>
                  <div className="activity-meta">
                    <span className="stage-pill">{runTiming.stage}</span>
                    <span>{runTiming.stageElapsed}</span>
                  </div>
                </div>
                <div className="stat-row">
                  <Metric label="Processed" value={`${selectedRun.processed}/${selectedRun.total}`} />
                  <Metric label="Found" value={selectedRun.found} />
                  <Metric label="Partial" value={selectedRun.partial} />
                  <Metric label="Failed" value={selectedRun.failed} />
                </div>
              </div>

              <div className="coverage-panel">
                <div className="coverage-head">
                  <div>
                    <ListChecks size={17} />
                    <strong>Required data coverage</strong>
                  </div>
                  <div className="coverage-head-actions">
                    <span>{coverageTotal} parsed products</span>
                    {selectedRun && (
                      <button
                        type="button"
                        className="text-link-button"
                        onClick={() => (dashboardCoverageEditOpen ? setDashboardCoverageEditOpen(false) : openDashboardCoverageEditor())}
                      >
                        <Pencil size={14} />
                        {dashboardCoverageEditOpen ? "Close editor" : "Edit tiles"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="coverage-grid">
                  {coverage.map((row) => {
                    const isFocusedMissing = coverageFocus?.key === row.key && coverageFocus.state === "missing";
                    const isFocusedNotApplicable = coverageFocus?.key === row.key && coverageFocus.state === "not-applicable";
                    const isActive = isFocusedMissing || isFocusedNotApplicable;
                    return (
                      <div
                        key={row.key}
                        className={`coverage-item${row.missing ? " coverage-item--missing" : ""}${row.notApplicable && !row.total ? " coverage-item--na" : ""}${row.isCustom ? " coverage-item--custom" : ""}${isActive ? " coverage-item--active" : ""}`}
                      >
                        <span>{row.label}</span>
                        <strong>{row.total ? `${row.count}/${row.total}` : row.notApplicable ? "N/A OK" : "0/0"}</strong>
                        <div className="coverage-item-chips">
                          {row.missing > 0 && (
                            <button
                              type="button"
                              aria-pressed={isFocusedMissing}
                              title={isFocusedMissing ? "Click to clear this filter" : `Show ${row.missing} item${row.missing === 1 ? "" : "s"} missing ${row.label}`}
                              className={`coverage-chip coverage-chip--missing${isFocusedMissing ? " is-active" : ""}`}
                              onClick={() =>
                                handleCoverageFocusChange(
                                  isFocusedMissing ? null : { key: row.key, label: row.label, state: "missing" }
                                )
                              }
                            >
                              {row.missing} missing
                            </button>
                          )}
                          {row.notApplicable > 0 && (
                            <button
                              type="button"
                              aria-pressed={isFocusedNotApplicable}
                              title={isFocusedNotApplicable ? "Click to clear this filter" : `Show ${row.notApplicable} item${row.notApplicable === 1 ? "" : "s"} where ${row.label} is not applicable`}
                              className={`coverage-chip coverage-chip--na${isFocusedNotApplicable ? " is-active" : ""}`}
                              onClick={() =>
                                handleCoverageFocusChange(
                                  isFocusedNotApplicable ? null : { key: row.key, label: row.label, state: "not-applicable" }
                                )
                              }
                            >
                              {row.notApplicable} not applicable
                            </button>
                          )}
                          {!row.missing && !row.notApplicable && <small>Complete</small>}
                        </div>
                        <div className="mini-track" aria-hidden="true">
                          <i style={{ width: `${row.percent}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {dashboardCoverageEditOpen && (
                  <div className="coverage-dashboard-editor">
                    <p className="muted-note">
                      Click a built-in tile below to hide it on this dashboard. Add custom tiles
                      with regex patterns matched against attribute names. Saving re-evaluates
                      existing attributes — no re-scrape needed.
                    </p>
                    <div className="coverage-builtin-toggles" role="group" aria-label="Built-in coverage tiles">
                      {REQUIRED_COVERAGE_FIELDS.map((field) => {
                        const hidden = dashboardHiddenDraft.includes(field.key);
                        return (
                          <button
                            key={field.key}
                            type="button"
                            className={`coverage-toggle-chip${hidden ? " is-off" : ""}`}
                            onClick={() => toggleHiddenBuiltIn(field.key)}
                            aria-pressed={!hidden}
                          >
                            {hidden ? "✕ " : "✓ "}
                            {field.label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="muted-note">Custom tiles</p>
                    {dashboardCoverageDraft.length === 0 && (
                      <p className="muted-note">No custom tiles yet.</p>
                    )}
                    {dashboardCoverageDraft.map((field, index) => (
                      <div key={index} className="coverage-editor-row">
                        <label className="field">
                          <span>Label</span>
                          <input
                            value={field.label}
                            placeholder="IP Rating"
                            onChange={(event) => {
                              setDashboardCoverageDraft((current) =>
                                current.map((existing, idx) =>
                                  idx === index ? { ...existing, label: event.target.value } : existing
                                )
                              );
                            }}
                          />
                        </label>
                        <label className="field">
                          <span>Match pattern (regex)</span>
                          <input
                            value={field.pattern}
                            placeholder="ip rating|ingress"
                            onChange={(event) => {
                              setDashboardCoverageDraft((current) =>
                                current.map((existing, idx) =>
                                  idx === index ? { ...existing, pattern: event.target.value } : existing
                                )
                              );
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="cancel-button compact-action"
                          onClick={() =>
                            setDashboardCoverageDraft((current) => current.filter((_, idx) => idx !== index))
                          }
                          aria-label={`Remove ${field.label || "custom tile"}`}
                        >
                          <XCircle size={16} />
                        </button>
                      </div>
                    ))}
                    <div className="coverage-dashboard-editor-actions">
                      <button
                        type="button"
                        className="secondary-action compact-action"
                        onClick={() =>
                          setDashboardCoverageDraft((current) => [...current, { id: "", label: "", pattern: "" }])
                        }
                      >
                        <Plus size={16} />
                        Add tile
                      </button>
                      <button
                        type="button"
                        className="primary-action compact-action"
                        onClick={() => void saveDashboardCoverageEditor()}
                        disabled={dashboardCoverageBusy}
                      >
                        {dashboardCoverageBusy ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
                        Save tiles
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="run-items-panel">
                <div className="run-items-toolbar">
                  {coverageFocus && (
                    <div className="coverage-focus-group">
                      <button type="button" className="coverage-focus-chip" onClick={() => handleCoverageFocusChange(null)}>
                        {coverageFocus.label} is {coverageFocus.state === "missing" ? "missing" : "not applicable"}
                        <X size={13} />
                      </button>
                      <button
                        type="button"
                        className="coverage-focus-copy"
                        title="Copy the catalog numbers for this filtered list"
                        disabled={filteredItems.length === 0}
                        onClick={() => void handleCatalogListExport(`${coverageFocus.label}-${coverageFocus.state}`, filteredItems)}
                      >
                        <Copy size={13} />
                        Copy list
                        <strong>{uniqueCatalogNumbers(filteredItems).length}</strong>
                      </button>
                    </div>
                  )}
                  <label className="run-search-field">
                    <Search size={16} />
                    <input
                      value={runItemQuery}
                      placeholder="Search catalog, title, reason..."
                      onChange={(event) => handleRunItemQueryChange(event.target.value)}
                    />
                  </label>
                  <label className="page-size-field">
                    <span>Rows</span>
                    <Dropdown
                      ariaLabel="Rows per page"
                      value={String(runItemPageSize)}
                      onChange={(next) => handleRunItemPageSizeChange(next)}
                      options={RUN_ITEM_PAGE_SIZES.map((size) => ({
                        value: String(size),
                        label: size === "all" ? "All" : String(size)
                      }))}
                    />
                  </label>
                  <div className="catalog-list-actions" aria-label="Catalog list actions">
                    <button
                      type="button"
                      className="secondary-action compact-action"
                      onClick={() => void handleCatalogListExport("failed", failedListItems)}
                      disabled={failedListItems.length === 0}
                    >
                      <XCircle size={14} />
                      Failed
                      <strong>{uniqueCatalogNumbers(failedListItems).length}</strong>
                    </button>
                    <button
                      type="button"
                      className="secondary-action compact-action"
                      onClick={() => void handleCatalogListExport("missing-images", missingImageListItems)}
                      disabled={missingImageListItems.length === 0}
                    >
                      <FileOutput size={14} />
                      Missing images
                      <strong>{uniqueCatalogNumbers(missingImageListItems).length}</strong>
                    </button>
                    <button
                      type="button"
                      className="primary-action compact-action"
                      onClick={() => void handleCatalogListExport("current-filter", filteredItems)}
                      disabled={filteredItems.length === 0}
                    >
                      <ListChecks size={14} />
                      Current list
                      <strong>{uniqueCatalogNumbers(filteredItems).length}</strong>
                    </button>
                    {catalogListMessage && <span className="catalog-list-message">{catalogListMessage}</span>}
                  </div>
                </div>

                <div className="run-filter-strip" aria-label="Filter run items">
                  {RUN_ITEM_FILTERS.map((filter) => (
                    <button
                      key={filter.key}
                      type="button"
                      className={runItemFilter === filter.key ? "filter-chip active" : "filter-chip"}
                      onClick={() => handleRunItemFilterChange(filter.key)}
                    >
                      <span>{filter.label}</span>
                      <strong>{runItemFilterCounts[filter.key] ?? 0}</strong>
                    </button>
                  ))}
                </div>

                <div className="table-nav">
                  <span>
                    {filteredItems.length
                      ? `${runItemStartIndex + 1}-${runItemEndIndex} of ${filteredItems.length}`
                      : "0 results"}
                    {filteredItems.length !== items.length ? ` filtered from ${items.length}` : ""}
                  </span>
                  {runItemQueryImpact && (
                    <span className="query-impact">
                      Problem affects <strong>{runItemQueryImpact.count}</strong> {runItemQueryImpact.count === 1 ? "item" : "items"}
                    </span>
                  )}
                  <div className="pager" aria-label="Run item pages">
                    <button type="button" className="pager-button" onClick={() => setRunItemPage(1)} disabled={safeRunItemPage <= 1}>
                      <ChevronsLeft size={15} />
                    </button>
                    <button type="button" className="pager-button" onClick={() => setRunItemPage((page) => Math.max(1, page - 1))} disabled={safeRunItemPage <= 1}>
                      <ChevronLeft size={15} />
                    </button>
                    <label className="page-jump">
                      <span>Page</span>
                      <input
                        type="number"
                        min={1}
                        max={runItemPageCount}
                        value={safeRunItemPage}
                        onChange={(event) => setRunItemPage(clampPage(Number(event.target.value), runItemPageCount))}
                      />
                      <strong>/ {runItemPageCount}</strong>
                    </label>
                    <button
                      type="button"
                      className="pager-button"
                      onClick={() => setRunItemPage((page) => Math.min(runItemPageCount, page + 1))}
                      disabled={safeRunItemPage >= runItemPageCount}
                    >
                      <ChevronRight size={15} />
                    </button>
                    <button
                      type="button"
                      className="pager-button"
                      onClick={() => setRunItemPage(runItemPageCount)}
                      disabled={safeRunItemPage >= runItemPageCount}
                    >
                      <ChevronsRight size={15} />
                    </button>
                  </div>
                </div>

                <div className="table-wrap run-items-table-wrap">
                <table className="run-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Catalog number</th>
                      <th>Status</th>
                      <th>Link</th>
                      <th>Source</th>
                      <th>Activity</th>
                      <th>Title</th>
                      <th>Reason</th>
                      <th>Confidence</th>
                      <th>Debug</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runItemPageItems.map((item) => (
                      <tr key={item.id} className={selectedItemId === item.id ? "active-row" : ""}>
                        <td>{item.rowIndex}</td>
                        <td className="mono">{item.catalogNumber}</td>
                        <td>
                          <ItemBadge status={item.status} />
                        </td>
                        <td>
                          {item.productUrl ? (
                            <a className="source-link" href={item.productUrl} target="_blank" rel="noreferrer">
                              Source
                              <ArrowUpRight size={13} />
                            </a>
                          ) : null}
                        </td>
                        <td>
                          <SourceBadge item={item} />
                        </td>
                        <td>
                          <StageCell item={item} />
                        </td>
                        <td>{item.title ?? item.error ?? ""}</td>
                        <td>{itemReason(item)}</td>
                        <td>{item.confidence ? `${Math.round(item.confidence * 100)}%` : ""}</td>
                        <td>
                          {item.result || item.coverage ? (
                            <button type="button" className="icon-button" title="Open run item diagnostics" onClick={() => setSelectedItemId(item.id)}>
                              <FileText size={14} />
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                  {runItemPageItems.length === 0 && (
                    <div className="table-empty">
                      <Search size={17} />
                      <span>No matching catalog rows.</span>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <EmptyState />
          )}
        </section>

        <aside className={historyExpanded ? "history-panel expanded" : "history-panel collapsed"}>
          <div className="history-title-row">
            <PanelTitle icon={<History size={18} />} title="Run history" meta={`${runs.length} total`} />
            <button
              type="button"
              className="history-toggle"
              aria-expanded={historyExpanded}
              onClick={() => setHistoryExpanded((expanded) => !expanded)}
            >
              {historyExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              {historyExpanded ? "Hide" : "Show"}
            </button>
          </div>

          <div className="history-overview">
            <Metric label="Complete" value={runs.filter((run) => run.status === "completed").length} />
            <Metric label="Needs check" value={runs.filter((run) => run.status === "failed" || run.partial > 0).length} />
          </div>

          {!historyExpanded && selectedHistoryRun && (
            <div className="history-current">
              <span>Selected run</span>
              <HistoryRunButton
                run={selectedHistoryRun}
                runShortName={manufacturers.find((manufacturer) => manufacturer.id === selectedHistoryRun.manufacturerId)?.shortName ?? selectedHistoryRun.manufacturerId.toUpperCase()}
                active
                compact
                onSelect={() => setSelectedRunId(selectedHistoryRun.id)}
              />
            </div>
          )}

          {historyExpanded && (
            <div className="history-list">
              {runs.map((run) => (
                <HistoryRunButton
                  key={run.id}
                  run={run}
                  runShortName={manufacturers.find((manufacturer) => manufacturer.id === run.manufacturerId)?.shortName ?? run.manufacturerId.toUpperCase()}
                  active={run.id === selectedRunId}
                  onSelect={() => setSelectedRunId(run.id)}
                />
              ))}
              {runs.length === 0 && <p className="muted">No runs yet.</p>}
            </div>
          )}

          {hasOutputFolder && (
            <div className="output-box">
              <FolderOpen size={18} />
              <div>
                <strong>
                  {hasWorkbook
                    ? selectedRun.status === "cancelled"
                      ? "Partial workbook ready"
                      : "Workbook ready"
                    : "Files ready"}
                </strong>
                {hasWorkbook && (
                  <button type="button" className="text-link-button" onClick={() => void handleOpenWorkbook()} disabled={openWorkbookBusy}>
                    Open result XLSX
                  </button>
                )}
                <button type="button" className="text-link-button" onClick={() => void handleOpenOutputFolder()} disabled={openOutputFolderBusy}>
                  Open output folder
                </button>
                <a href={`/api/runs/${selectedRun.id}/files/log`}>Download run log</a>
              </div>
            </div>
          )}
        </aside>
      </section>

      {selectedItem && <RunItemDrawer item={selectedItem} onClose={() => setSelectedItemId(null)} />}

      {manufacturerEditorOpen && (
        <section className="manufacturer-panel">
          <div className="config-header">
            <div>
              <PanelTitle icon={<Settings2 size={18} />} title={manufacturerDraft.id ? "Edit manufacturer" : "Add manufacturer"} meta={manufacturerDraft.shortName || "Draft"} />
              <div className="origin-row">
                <span className={overrideActive ? "origin-pill active" : "origin-pill"}>
                  {overrideActive ? "Local override active" : editorManufacturer?.isBuiltIn ? "Built-in safe edit" : "Custom draft"}
                </span>
                <span>Simple wizard first. Advanced stays available for power tuning.</span>
              </div>
            </div>
            <div className="run-actions manufacturer-editor-actions">
              {overrideActive && (
                <button type="button" className="secondary-action" onClick={() => void handleResetOverride()} disabled={wizardBusy === "reset"}>
                  {wizardBusy === "reset" ? <Loader2 className="spin" size={16} /> : <History size={16} />}
                  Reset override
                </button>
              )}
              <div className="mode-switch" role="tablist" aria-label="Manufacturer editor mode">
                <button type="button" className={editorMode === "simple" ? "active" : ""} onClick={() => setEditorMode("simple")}>
                  Simple
                </button>
                <button type="button" className={editorMode === "advanced" ? "active" : ""} onClick={() => setEditorMode("advanced")}>
                  Advanced
                </button>
              </div>
              <button type="button" className="cancel-button" onClick={() => setManufacturerEditorOpen(false)}>
                <XCircle size={16} />
                Close
              </button>
              <button type="button" className="primary-action compact-action" onClick={() => void handleSaveManufacturer()} disabled={manufacturerSaveBusy || !canSaveManufacturer}>
                {manufacturerSaveBusy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                {canSaveManufacturer ? "Save manufacturer" : "Test required"}
              </button>
            </div>
          </div>

          <section className="wizard-panel" aria-label="Simple manufacturer wizard">
            <div className="wizard-topline">
              <div>
                <span className="section-label">Paste URL wizard</span>
                <h3>Add a manufacturer without JSON</h3>
                <p>Paste the official website, add two or three catalog numbers, auto-detect, then test. Saving unlocks only after one official product is confirmed.</p>
              </div>
              <span className={canSaveManufacturer ? "save-guard ok" : "save-guard"}>
                {canSaveManufacturer ? "Ready to save" : "Sample test required"}
              </span>
            </div>

            <div className="wizard-progress">
              <span className={manufacturerDraft.canonicalName.trim() ? "done" : ""}>1 Name</span>
              <span className={wizardWebsiteUrl.trim() ? "done" : ""}>2 Website</span>
              <span className={sampleCatalogNumbers.length ? "done" : ""}>3 Samples</span>
              <span className={wizardInspectResult ? "done" : ""}>4 Auto-detect</span>
              <span className={wizardTestResult?.passed ? "done" : ""}>5 Save</span>
            </div>

            <div className="wizard-grid">
              <label className="field">
                <span>Manufacturer name</span>
                <input
                  value={manufacturerDraft.canonicalName}
                  placeholder="example: nVent Hoffman"
                  onChange={(event) => handleSimpleNameChange(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Short name</span>
                <input
                  value={manufacturerDraft.shortName}
                  placeholder="Auto"
                  onChange={(event) => updateManufacturerDraft({ shortName: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) })}
                />
              </label>
              <label className="field wide-field">
                <span>Official website or product URL</span>
                <input
                  value={wizardWebsiteUrl}
                  placeholder="https://www.company.com/products"
                  onChange={(event) => handleSimpleWebsiteChange(event.target.value)}
                />
              </label>
              <label className="field wide-field">
                <span>Sample catalog numbers</span>
                <textarea
                  rows={3}
                  value={wizardSamplesText}
                  placeholder={`One per line, for example:
A1B2C3
X-100-24V
ABC:12345`}
                  onChange={(event) => handleSimpleSamplesChange(event.target.value)}
                />
              </label>
              <label className="wizard-check wide-field">
                <input
                  type="checkbox"
                  checked={wizardAllowDistributor}
                  onChange={(event) => handleDistributorFallbackToggle(event.target.checked)}
                />
                <span>
                  Allow distributor fallback
                  <small>Off by default. Distributor data can fill gaps, but it cannot overwrite official data.</small>
                </span>
              </label>
            </div>

            <div className="wizard-actions">
              <button type="button" className="secondary-action" onClick={() => void handleInspectManufacturer()} disabled={!canInspectManufacturer || wizardBusy !== null}>
                {wizardBusy === "inspect" ? <Loader2 className="spin" size={16} /> : <Search size={16} />}
                Auto-detect
              </button>
              <button type="button" className="primary-action compact-action" onClick={() => void handleTestManufacturer()} disabled={!canTestManufacturer || wizardBusy !== null}>
                {wizardBusy === "test" ? <Loader2 className="spin" size={16} /> : <ListChecks size={16} />}
                Test samples
              </button>
            </div>

            <ManufacturerWizardPreview inspectResult={wizardInspectResult} testResult={wizardTestResult} />
          </section>

          <section className="coverage-editor" aria-label="Custom coverage tiles">
            <div className="coverage-editor-head">
              <div>
                <span className="section-label">Custom coverage</span>
                <h3>Extra fields to track on the dashboard</h3>
                <p>
                  Built-in tiles (Weight, Material, Dimensions, …) always run. Add your own —
                  each row matches by attribute name (regex, case-insensitive). Plain words work
                  too. Examples: <code>ip rating</code>, <code>operating temperature</code>,
                  <code>thread|connection</code>.
                </p>
              </div>
              <button
                type="button"
                className="secondary-action compact-action"
                onClick={() =>
                  updateManufacturerDraft({
                    customCoverageFields: [
                      ...manufacturerDraft.customCoverageFields,
                      { id: "", label: "", pattern: "" }
                    ]
                  })
                }
              >
                <Plus size={16} />
                Add field
              </button>
            </div>
            {manufacturerDraft.customCoverageFields.length === 0 ? (
              <p className="muted-note">No custom fields yet. Built-in tiles only.</p>
            ) : (
              <div className="coverage-editor-rows">
                {manufacturerDraft.customCoverageFields.map((field, index) => (
                  <div key={index} className="coverage-editor-row">
                    <label className="field">
                      <span>Label</span>
                      <input
                        value={field.label}
                        placeholder="IP Rating"
                        onChange={(event) => {
                          const next = manufacturerDraft.customCoverageFields.map((current, idx) =>
                            idx === index ? { ...current, label: event.target.value } : current
                          );
                          updateManufacturerDraft({ customCoverageFields: next });
                        }}
                      />
                    </label>
                    <label className="field">
                      <span>Match pattern (regex)</span>
                      <input
                        value={field.pattern}
                        placeholder="ip rating|ingress"
                        onChange={(event) => {
                          const next = manufacturerDraft.customCoverageFields.map((current, idx) =>
                            idx === index ? { ...current, pattern: event.target.value } : current
                          );
                          updateManufacturerDraft({ customCoverageFields: next });
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="cancel-button compact-action"
                      onClick={() =>
                        updateManufacturerDraft({
                          customCoverageFields: manufacturerDraft.customCoverageFields.filter((_, idx) => idx !== index)
                        })
                      }
                      aria-label={`Remove ${field.label || "custom field"}`}
                    >
                      <XCircle size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {editorMode === "advanced" && (
          <div className="advanced-config">
          <div className="config-grid">
            <label className="field">
              <span>ID</span>
              <input
                value={manufacturerDraft.id}
                placeholder="example: nvent"
                onChange={(event) => updateManufacturerDraft({ id: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Short name</span>
              <input
                value={manufacturerDraft.shortName}
                placeholder="example: NV"
                onChange={(event) => updateManufacturerDraft({ shortName: event.target.value.toUpperCase() })}
              />
            </label>
            <label className="field wide-field">
              <span>Company name</span>
              <input
                value={manufacturerDraft.canonicalName}
                placeholder="example: nVent Hoffman"
                onChange={(event) => updateManufacturerDraft({ canonicalName: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Rate limit ms</span>
              <input
                type="number"
                min="250"
                max="10000"
                value={manufacturerDraft.rateLimitMs}
                onChange={(event) => updateManufacturerDraft({ rateLimitMs: event.target.value })}
              />
            </label>
            <label className="field wide-field">
              <span>Official URL templates</span>
              <textarea
                rows={3}
                value={manufacturerDraft.officialBaseUrlsText}
                placeholder="https://www.company.com/products/{part}"
                onChange={(event) => updateManufacturerDraft({ officialBaseUrlsText: event.target.value })}
              />
            </label>
            <label className="field wide-field">
              <span>Localized URL templates</span>
              <textarea
                rows={3}
                value={manufacturerDraft.localizedUrlTemplatesText}
                placeholder={`en https://www.company.com/en/product/{part}
de https://www.company.com/de/product/{part}`}
                onChange={(event) => updateManufacturerDraft({ localizedUrlTemplatesText: event.target.value })}
              />
            </label>
            <label className="field wide-field">
              <span>Catalog aliases</span>
              <textarea
                rows={3}
                value={manufacturerDraft.aliasesText}
                placeholder="Optional alternate catalog tokens, one per line"
                onChange={(event) => updateManufacturerDraft({ aliasesText: event.target.value })}
              />
            </label>
            <label className="field wide-field">
              <span>Marker extraction rules</span>
              <textarea
                rows={3}
                value={manufacturerDraft.markerRulesText}
                placeholder="Field name|||start marker|||end marker"
                onChange={(event) => updateManufacturerDraft({ markerRulesText: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Fetch timeout ms</span>
              <input
                type="number"
                min="1000"
                max="180000"
                value={manufacturerDraft.fetchTimeoutMs}
                placeholder="15000"
                onChange={(event) => updateManufacturerDraft({ fetchTimeoutMs: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Cache TTL ms</span>
              <input
                type="number"
                min="0"
                max="2592000000"
                value={manufacturerDraft.cacheTtlMs}
                placeholder="86400000"
                onChange={(event) => updateManufacturerDraft({ cacheTtlMs: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Max attempts</span>
              <input
                type="number"
                min="1"
                max="5"
                value={manufacturerDraft.maxAttempts}
                placeholder="2"
                onChange={(event) => updateManufacturerDraft({ maxAttempts: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Retry backoff ms</span>
              <input
                type="number"
                min="100"
                max="10000"
                value={manufacturerDraft.retryBackoffMs}
                placeholder="750"
                onChange={(event) => updateManufacturerDraft({ retryBackoffMs: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Min content length</span>
              <input
                type="number"
                min="0"
                max="250000"
                value={manufacturerDraft.minContentLength}
                placeholder="1000"
                onChange={(event) => updateManufacturerDraft({ minContentLength: event.target.value })}
              />
            </label>
            <label className="field wide-field">
              <span>User agent</span>
              <input
                value={manufacturerDraft.userAgent}
                placeholder="Optional primary user agent"
                onChange={(event) => updateManufacturerDraft({ userAgent: event.target.value })}
              />
            </label>
            <label className="field wide-field">
              <span>Accept language</span>
              <input
                value={manufacturerDraft.acceptLanguage}
                placeholder="en-GB,en;q=0.9,en-US;q=0.8"
                onChange={(event) => updateManufacturerDraft({ acceptLanguage: event.target.value })}
              />
            </label>
            <label className="field wide-field">
              <span>Referer</span>
              <input
                value={manufacturerDraft.referer}
                placeholder="https://www.company.com/products"
                onChange={(event) => updateManufacturerDraft({ referer: event.target.value })}
              />
            </label>
            <label className="field wide-field">
              <span>Fallback user agents</span>
              <textarea
                rows={2}
                value={manufacturerDraft.fallbackUserAgentsText}
                placeholder="One user agent per line"
                onChange={(event) => updateManufacturerDraft({ fallbackUserAgentsText: event.target.value })}
              />
            </label>
            <div className="recipe-wizard wide-field">
              <div className="sources-header compact-header">
                <div>
                  <strong>Recipe builder</strong>
                  <span>Promote the common discovery, interaction, and quality rules into the JSON recipe.</span>
                </div>
              </div>
              <div className="config-grid source-grid">
                <label className="field wide-field">
                  <span>Search templates</span>
                  <textarea
                    rows={3}
                    value={(recipeDraft.discoveryPolicy?.searchUrlTemplates ?? recipeDraft.searchUrlTemplates ?? []).join("\n")}
                    placeholder="https://example.com/search?q={part}"
                    onChange={(event) =>
                      updateRecipeDraft({
                        discoveryPolicy: {
                          ...recipeDraft.discoveryPolicy,
                          searchUrlTemplates: splitLines(event.target.value)
                        }
                      })
                    }
                  />
                </label>
                <label className="field wide-field">
                  <span>Expand selectors</span>
                  <textarea
                    rows={3}
                    value={(recipeDraft.interactionPolicy?.expandSelectors ?? recipeDraft.expandSelectors ?? []).join("\n")}
                    placeholder="button[aria-expanded='false']"
                    onChange={(event) =>
                      updateRecipeDraft({
                        interactionPolicy: {
                          ...recipeDraft.interactionPolicy,
                          expandSelectors: splitLines(event.target.value)
                        }
                      })
                    }
                  />
                </label>
                <label className="field wide-field">
                  <span>Wait selectors</span>
                  <textarea
                    rows={2}
                    value={(recipeDraft.interactionPolicy?.waitForSelectors ?? []).join("\n")}
                    placeholder=".product-detail, [data-product]"
                    onChange={(event) =>
                      updateRecipeDraft({
                        interactionPolicy: {
                          ...recipeDraft.interactionPolicy,
                          waitForSelectors: splitLines(event.target.value)
                        }
                      })
                    }
                  />
                </label>
                <label className="field wide-field">
                  <span>Document URL patterns</span>
                  <textarea
                    rows={2}
                    value={(recipeDraft.extractionPolicy?.documentUrlPatterns ?? []).join("\n")}
                    placeholder="datasheet|technical|certificate"
                    onChange={(event) =>
                      updateRecipeDraft({
                        extractionPolicy: {
                          ...recipeDraft.extractionPolicy,
                          documentUrlPatterns: splitLines(event.target.value)
                        }
                      })
                    }
                  />
                </label>
                <div className="field wide-field">
                  <span>Required normalized fields</span>
                  <div className="toggle-grid">
                    {(["weight", "dimensions", "material", "voltage", "current", "protection", "certificates"] as const).map((field) => (
                      <label className="check-field" key={field}>
                        <input
                          type="checkbox"
                          checked={(recipeDraft.qualityPolicy?.requiredNormalizedFields ?? []).includes(field)}
                          onChange={(event) =>
                            updateRecipeDraft({
                              qualityPolicy: {
                                ...recipeDraft.qualityPolicy,
                                requiredNormalizedFields: toggleList(recipeDraft.qualityPolicy?.requiredNormalizedFields ?? [], field, event.target.checked)
                              }
                            })
                          }
                        />
                        {field}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="field wide-field">
                  <span>Required documents</span>
                  <div className="toggle-grid">
                    {(["datasheet", "certificate", "manual", "cad", "image"] as const).map((type) => (
                      <label className="check-field" key={type}>
                        <input
                          type="checkbox"
                          checked={(recipeDraft.qualityPolicy?.requiredDocumentTypes ?? []).includes(type)}
                          onChange={(event) =>
                            updateRecipeDraft({
                              qualityPolicy: {
                                ...recipeDraft.qualityPolicy,
                                requiredDocumentTypes: toggleList(recipeDraft.qualityPolicy?.requiredDocumentTypes ?? [], type, event.target.checked)
                              }
                            })
                          }
                        />
                        {type}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <label className="field wide-field">
              <span>Advanced scrape recipe JSON</span>
              <textarea
                rows={7}
                value={manufacturerDraft.scrapeRecipeJson}
                placeholder={`{
  "discoveryPolicy": { "enableRobotsSitemaps": true, "maxCandidates": 12 },
  "interactionPolicy": { "maxClicks": 50 },
  "qualityPolicy": { "requiredNormalizedFields": ["weight", "dimensions"] }
}`}
                onChange={(event) => updateManufacturerDraft({ scrapeRecipeJson: event.target.value })}
              />
            </label>
          </div>

          <div className="sources-header">
            <div>
              <strong>Source URL templates</strong>
              <span>
                Use placeholders: {"{part}"}, {"{partUpper}"}, {"{partLower}"}, {"{partCompact}"}, {"{partSnake}"}, {"{partDash}"}, {"{partAfterColonLower}"}.
              </span>
            </div>
            <button type="button" className="secondary-action" onClick={addSourceDraft}>
              <Plus size={15} />
              Add source
            </button>
          </div>

          <div className="source-editor-list">
            {manufacturerDraft.fallbackSources.map((source, index) => (
              <div className="source-editor-card" key={`${source.id}-${index}`}>
                <div className="source-card-top">
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={source.enabled}
                      onChange={(event) => updateSourceDraft(index, { enabled: event.target.checked })}
                    />
                    Enabled
                  </label>
                  <button type="button" className="icon-danger" onClick={() => removeSourceDraft(index)}>
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="config-grid source-grid">
                  <label className="field">
                    <span>Source ID</span>
                    <input value={source.id} onChange={(event) => updateSourceDraft(index, { id: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>Source type</span>
                    <Dropdown<SourceDraft["sourceType"]>
                      ariaLabel="Source type"
                      value={source.sourceType}
                      onChange={(next) => updateSourceDraft(index, { sourceType: next })}
                      options={[
                        { value: "official-fallback", label: "Official / fallback" },
                        { value: "distributor", label: "Distributor" }
                      ]}
                    />
                  </label>
                  <label className="field wide-field">
                    <span>Label</span>
                    <input value={source.label} onChange={(event) => updateSourceDraft(index, { label: event.target.value })} />
                  </label>
                  <label className="field wide-field">
                    <span>Direct URL templates</span>
                    <textarea
                      rows={3}
                      value={source.directUrlTemplatesText}
                      placeholder="https://example.com/products/{part}"
                      onChange={(event) => updateSourceDraft(index, { directUrlTemplatesText: event.target.value })}
                    />
                  </label>
                  <label className="field wide-field">
                    <span>Source aliases</span>
                    <textarea
                      rows={2}
                      value={source.aliasesText}
                      placeholder="Optional alternate catalog tokens for this source"
                      onChange={(event) => updateSourceDraft(index, { aliasesText: event.target.value })}
                    />
                  </label>
                  <label className="field wide-field">
                    <span>Source marker rules</span>
                    <textarea
                      rows={2}
                      value={source.markerRulesText}
                      placeholder="Field name|||start marker|||end marker"
                      onChange={(event) => updateSourceDraft(index, { markerRulesText: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Confidence</span>
                    <input
                      type="number"
                      min="0.05"
                      max="0.95"
                      step="0.05"
                      value={source.confidence}
                      placeholder="0.55"
                      onChange={(event) => updateSourceDraft(index, { confidence: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Timeout ms</span>
                    <input
                      type="number"
                      min="1000"
                      max="180000"
                      value={source.fetchTimeoutMs}
                      placeholder="15000"
                      onChange={(event) => updateSourceDraft(index, { fetchTimeoutMs: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Cache TTL ms</span>
                    <input
                      type="number"
                      min="0"
                      max="2592000000"
                      value={source.cacheTtlMs}
                      placeholder="86400000"
                      onChange={(event) => updateSourceDraft(index, { cacheTtlMs: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Max attempts</span>
                    <input
                      type="number"
                      min="1"
                      max="5"
                      value={source.maxAttempts}
                      placeholder="2"
                      onChange={(event) => updateSourceDraft(index, { maxAttempts: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Retry backoff ms</span>
                    <input
                      type="number"
                      min="100"
                      max="10000"
                      value={source.retryBackoffMs}
                      placeholder="750"
                      onChange={(event) => updateSourceDraft(index, { retryBackoffMs: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Min content length</span>
                    <input
                      type="number"
                      min="0"
                      max="250000"
                      value={source.minContentLength}
                      placeholder="1000"
                      onChange={(event) => updateSourceDraft(index, { minContentLength: event.target.value })}
                    />
                  </label>
                  <label className="field wide-field">
                    <span>User agent</span>
                    <input
                      value={source.userAgent}
                      placeholder="Optional primary user agent"
                      onChange={(event) => updateSourceDraft(index, { userAgent: event.target.value })}
                    />
                  </label>
                  <label className="field wide-field">
                    <span>Accept language</span>
                    <input
                      value={source.acceptLanguage}
                      placeholder="en-GB,en;q=0.9,en-US;q=0.8"
                      onChange={(event) => updateSourceDraft(index, { acceptLanguage: event.target.value })}
                    />
                  </label>
                  <label className="field wide-field">
                    <span>Referer</span>
                    <input
                      value={source.referer}
                      placeholder="https://www.company.com/products"
                      onChange={(event) => updateSourceDraft(index, { referer: event.target.value })}
                    />
                  </label>
                  <label className="field wide-field">
                    <span>Fallback user agents</span>
                    <textarea
                      rows={2}
                      value={source.fallbackUserAgentsText}
                      placeholder="One user agent per line"
                      onChange={(event) => updateSourceDraft(index, { fallbackUserAgentsText: event.target.value })}
                    />
                  </label>
                </div>
              </div>
            ))}
            {manufacturerDraft.fallbackSources.length === 0 && (
              <div className="empty-config">
                Add at least one direct URL template for custom manufacturers. Without a template, the scraper has nowhere deterministic to go.
              </div>
            )}
          </div>
          </div>
          )}
        </section>
      )}

      {preview && (
        <section className="preview-panel">
          <PanelTitle icon={<FileText size={18} />} title="CSV preview" meta={`${preview.previewRows.length} sample rows`} />
          <div className="table-wrap compact">
            <table className="preview-table">
              <thead>
                <tr>
                  {preview.columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.previewRows.map((row, index) => (
                  <tr key={index}>
                    {preview.columns.map((column) => (
                      <td key={column}>{row[column]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {pdtRoutingPreview && (
        <div className="pdt-routing-shell" role="dialog" aria-modal="true">
          <div className="pdt-routing-backdrop" onClick={() => !pdtBusy && setPdtRoutingPreview(null)} />
          <div className="pdt-routing-panel">
            <div className="pdt-routing-header">
              <div>
                <h2>PDT routing — review and adjust</h2>
                <p>
                  Each scraped article will be written into its suggested device sheet. Override below: select rows and reassign,
                  or change a single row's sheet directly. Material Master Data and Additional Documents are always filled.
                </p>
              </div>
              <button
                type="button"
                className="download-button secondary"
                onClick={() => setPdtRoutingPreview(null)}
                disabled={pdtBusy}
              >
                <XCircle size={16} />
                Close
              </button>
            </div>
            <div className="pdt-routing-bulk">
              <label>
                <input
                  type="checkbox"
                  checked={pdtRoutingSelected.size > 0 && pdtRoutingSelected.size === pdtRoutingPreview.items.length}
                  ref={(el) => {
                    if (el) el.indeterminate =
                      pdtRoutingSelected.size > 0 && pdtRoutingSelected.size < pdtRoutingPreview.items.length;
                  }}
                  onChange={(event) => {
                    if (event.target.checked) {
                      setPdtRoutingSelected(new Set(pdtRoutingPreview.items.map((it) => it.itemId)));
                    } else {
                      setPdtRoutingSelected(new Set());
                    }
                  }}
                />{" "}
                Select all ({pdtRoutingSelected.size}/{pdtRoutingPreview.items.length})
              </label>
              <span>→ Assign selected to sheet:</span>
              <select
                value={pdtRoutingBulkSheet}
                onChange={(event) => {
                  const next = event.target.value;
                  setPdtRoutingBulkSheet(next);
                  // Auto-apply on pick when there are already-selected rows. The Apply button
                  // still exists as a safety net, but most users miss the second click and
                  // expect the pick to take effect immediately — exactly what happens here.
                  if (next && pdtRoutingSelected.size > 0) {
                    setPdtRoutingOverrides((prev) => {
                      const updated = { ...prev };
                      for (const id of pdtRoutingSelected) updated[id] = next;
                      return updated;
                    });
                  }
                }}
              >
                <option value="">— pick sheet —</option>
                {pdtRoutingPreview.availableSheets.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="download-button secondary"
                disabled={!pdtRoutingBulkSheet || pdtRoutingSelected.size === 0 || pdtBusy}
                onClick={() => {
                  if (!pdtRoutingBulkSheet) return;
                  setPdtRoutingOverrides((prev) => {
                    const next = { ...prev };
                    for (const id of pdtRoutingSelected) next[id] = pdtRoutingBulkSheet;
                    return next;
                  });
                }}
              >
                Apply
              </button>
              <button
                type="button"
                className="download-button secondary"
                disabled={pdtBusy}
                onClick={() => {
                  // Reset every item back to its auto-suggested sheet (the seed we stored on open).
                  const seeded: Record<number, string> = {};
                  for (const it of pdtRoutingPreview.items) {
                    if (it.suggestedSheets.length > 0) seeded[it.itemId] = it.suggestedSheets[0];
                  }
                  setPdtRoutingOverrides(seeded);
                }}
              >
                Reset to auto
              </button>
            </div>
            <div className="pdt-routing-table-wrap">
              <table className="pdt-routing-table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}></th>
                    <th>Catalog #</th>
                    <th>Title</th>
                    <th>Detected type</th>
                    <th>Auto sheet</th>
                    <th>Final sheet</th>
                  </tr>
                </thead>
                <tbody>
                  {pdtRoutingPreview.items.map((it) => {
                    const auto = it.suggestedSheets[0] ?? "";
                    const chosen = pdtRoutingOverrides[it.itemId] ?? auto;
                    const changed = chosen !== auto;
                    const unassigned = !chosen;
                    const isSelected = pdtRoutingSelected.has(it.itemId);
                    return (
                      <tr key={it.itemId} className={`${changed ? "changed " : ""}${unassigned ? "unassigned" : ""}`.trim() || undefined}>
                        <td>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(event) => {
                              setPdtRoutingSelected((prev) => {
                                const next = new Set(prev);
                                if (event.target.checked) next.add(it.itemId);
                                else next.delete(it.itemId);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td><code>{it.catalogNumber}</code></td>
                        <td title={it.title}>{(it.title ?? "").slice(0, 70)}</td>
                        <td>{it.deviceType ?? <span style={{ color: "var(--muted)" }}>—</span>}</td>
                        <td>{auto || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                        <td>
                          <select
                            value={chosen}
                            className={unassigned ? "select-unassigned" : undefined}
                            onChange={(event) => {
                              const value = event.target.value;
                              setPdtRoutingOverrides((prev) => ({ ...prev, [it.itemId]: value }));
                            }}
                          >
                            {/* Explicit placeholder so an empty/unset row renders as a clearly-
                                unselected dropdown instead of silently defaulting to the first
                                option (which looked like "Busbar was chosen" and caused users to
                                click Generate without actually picking a sheet). */}
                            <option value="">— not assigned —</option>
                            {/* Include the auto-suggested sheet even when it isn't in the device list,
                                so the dropdown can always reflect the current value. */}
                            {auto && !pdtRoutingPreview.availableSheets.includes(auto) && (
                              <option value={auto}>{auto}</option>
                            )}
                            {pdtRoutingPreview.availableSheets.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pdt-routing-actions">
              {(() => {
                // Count items left without any sheet (no override AND no auto-suggestion) so we
                // can warn the user — these will only land in constant tabs (Material Master Data,
                // Additional Documents) and skip every device tab, which is almost always wrong.
                const unassignedCount = pdtRoutingPreview.items.filter(
                  (it) => !(pdtRoutingOverrides[it.itemId] ?? it.suggestedSheets[0])
                ).length;
                return unassignedCount > 0 ? (
                  <span className="pdt-routing-warning">
                    ⚠ {unassignedCount} row{unassignedCount === 1 ? "" : "s"} not assigned to a sheet — those products will only be written to Material Master Data and Additional Documents.
                  </span>
                ) : null;
              })()}
              <button
                type="button"
                className="download-button secondary"
                onClick={() => setPdtRoutingPreview(null)}
                disabled={pdtBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="download-button"
                onClick={() => void handleConfirmPdtRouting()}
                disabled={pdtBusy}
              >
                {pdtBusy ? <Loader2 className="spin" size={16} /> : <FileOutput size={16} />}
                {pdtBusy ? "Generating" : "Generate PDT"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function TopStat({ icon, label, value, tone = "calm" }: { icon: React.ReactNode; label: string; value: string | number; tone?: "calm" | "hot" }) {
  return (
    <span className={`top-stat ${tone}`}>
      {icon}
      <span>
        <strong>{value}</strong>
        <em>{label}</em>
      </span>
    </span>
  );
}

function PanelTitle({ icon, title, meta }: { icon: React.ReactNode; title: string; meta?: string }) {
  return (
    <div className="panel-title">
      <span>{icon}</span>
      <h2>{title}</h2>
      {meta && <small>{meta}</small>}
    </div>
  );
}

function StepState({ done, label, index }: { done: boolean; label: string; index: string }) {
  return (
    <div className={done ? "step-state done" : "step-state"}>
      <span>{done ? <CheckCircle2 size={14} /> : index}</span>
      <strong>{label}</strong>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: RunRecord["status"] }) {
  return <span className={`badge run-${status}`}>{RUN_STATUS_LABELS[status] ?? status}</span>;
}

function HistoryRunButton({
  run,
  runShortName,
  active,
  compact = false,
  onSelect
}: {
  run: RunRecord;
  runShortName: string;
  active: boolean;
  compact?: boolean;
  onSelect: () => void;
}) {
  const runProgress = run.total > 0 ? Math.round((run.processed / run.total) * 100) : 0;
  return (
    <button
      type="button"
      className={`${active ? "history-item active" : "history-item"}${compact ? " compact-history-item" : ""}`}
      onClick={onSelect}
    >
      <span className="history-line">
        <span className="history-main">
          <strong>{runShortName}</strong>
          <span>{new Date(run.createdAt).toLocaleString()}</span>
        </span>
        <span className="history-tail">
          <StatusBadge status={run.status} />
          <span>{run.processed}/{run.total}</span>
        </span>
      </span>
      <span className="history-progress">
        <span style={{ width: `${runProgress}%` }} />
      </span>
    </button>
  );
}

function ItemBadge({ status }: { status: RunItemRecord["status"] }) {
  const icon = status === "found" ? <CheckCircle2 size={14} /> : status === "processing" ? <Loader2 className="spin" size={14} /> : null;
  return <span className={`item-badge item-${status}`}>{icon}{status}</span>;
}

function StageCell({ item }: { item: RunItemRecord }) {
  const detail = item.stageMessage ?? itemReason(item) ?? "";
  return (
    <span className="activity-cell">
      <span className="stage-pill">{stageLabel(item.stage, item.status)}</span>
      {detail ? <small>{detail}</small> : null}
    </span>
  );
}

function SourceBadge({ item }: { item: RunItemRecord }) {
  // While the item is still running and we haven't got the full result yet, fall back to
  // the live stage — "customer-override" means the customer doc is being scanned right now.
  if (!item.result) {
    if (item.stage === "customer-override") {
      return <span className="source-badge source-badge--customer" title="Currently reading customer document">Customer doc</span>;
    }
    if (item.stage === "official-source") {
      return <span className="source-badge source-badge--web" title="Currently scraping manufacturer website">Website</span>;
    }
    return <span className="source-badge source-badge--idle">—</span>;
  }
  const customerCount = item.result.attributes.filter((attr) => attr.parser === "customer-document").length;
  const webCount = item.result.attributes.length - customerCount;
  if (customerCount > 0 && webCount === 0) {
    return (
      <span className="source-badge source-badge--customer" title={`${customerCount} attributes from customer document`}>
        Customer doc
      </span>
    );
  }
  if (customerCount > 0 && webCount > 0) {
    return (
      <span
        className="source-badge source-badge--mixed"
        title={`${customerCount} attrs from customer document override ${webCount} from website`}
      >
        Customer + web
      </span>
    );
  }
  if (webCount > 0) {
    return (
      <span className="source-badge source-badge--web" title={`${webCount} attributes from manufacturer website`}>
        Website
      </span>
    );
  }
  return <span className="source-badge source-badge--idle">—</span>;
}

function EmptyState() {
  return (
    <div className="empty-state">
      <FileCheck2 size={34} />
      <strong>No run selected</strong>
      <span>Upload a CSV and start a scrape to see progress here.</span>
    </div>
  );
}

interface RunTimingSummary {
  progressPercent: number;
  elapsed: string;
  eta: string;
  remaining: string;
  avgPerItem: string;
  activityTitle: string;
  activityDetail: string;
  stage: string;
  stageElapsed: string;
}

interface RunProgressEstimate {
  avgMs?: number;
  effectiveProcessed: number;
  estimatedRemainingMs?: number;
}

const FINISHED_ITEM_STATUSES = new Set<ItemStatus>(["found", "partial", "failed", "cancelled"]);
const RECENT_ITEM_SAMPLE_SIZE = 8;
const MIN_ITEM_AVG_MS = 1000;
const MAX_REASONABLE_ITEM_MS = 30 * 60 * 1000;

function buildRunTiming(run: RunRecord | null, items: RunItemRecord[], nowMs: number): RunTimingSummary {
  if (!run) {
    return {
      elapsed: "--",
      progressPercent: 0,
      eta: "--",
      remaining: "--",
      avgPerItem: "--",
      activityTitle: "No active run",
      activityDetail: "Select or start a run to see live activity.",
      stage: "Idle",
      stageElapsed: "--"
    };
  }

  const active = ["queued", "running", "pausing", "cancelling"].includes(run.status);
  const startMs = safeTime(run.createdAt) ?? nowMs;
  const endMs = active ? nowMs : safeTime(run.updatedAt) ?? nowMs;
  const elapsedMs = Math.max(0, endMs - startMs);
  const currentItem = items.find((item) => item.status === "processing");
  const nextItem = items.find((item) => item.status === "pending");
  const stageStartMs = currentItem ? safeTime(currentItem.stageStartedAt) : undefined;
  const runActivityStartMs = run.activityStartedAt ? safeTime(run.activityStartedAt) : undefined;
  const processed = Math.max(0, run.processed);
  const progress = estimateRunProgress(run, items, nowMs, startMs, elapsedMs, currentItem);
  const rawRemainingCount = Math.max(0, run.total - processed);
  const avgMs = progress.avgMs;
  const progressPercent = run.total > 0 ? clampPercent((progress.effectiveProcessed / run.total) * 100) : 0;
  let eta = "--";
  let remaining = "--";

  if (run.status === "completed") {
    eta = "Done";
    remaining = "0s";
  } else if (run.status === "failed") {
    eta = "Failed";
    remaining = "--";
  } else if (run.status === "cancelled") {
    eta = "Cancelled";
    remaining = "--";
  } else if (run.status === "paused") {
    eta = "Paused";
    remaining = "--";
  } else if (run.status === "pausing") {
    eta = "Pausing";
    remaining = "--";
  } else if (rawRemainingCount === 0) {
    eta = "Finalizing";
    remaining = "<1m";
  } else if (avgMs && progress.estimatedRemainingMs !== undefined) {
    const remainingMs = Math.max(0, progress.estimatedRemainingMs);
    eta = formatClock(nowMs + remainingMs);
    remaining = formatDuration(remainingMs);
  } else {
    eta = "After first row";
    remaining = "Measuring";
  }

  if (currentItem) {
    return {
      elapsed: formatDuration(elapsedMs),
      progressPercent,
      eta,
      remaining,
      avgPerItem: avgMs ? formatDuration(avgMs) : "--",
      activityTitle: `${currentItem.catalogNumber} (${currentItem.rowIndex}/${run.total})`,
      activityDetail: currentItem.stageMessage ?? "Processing catalog row",
      stage: stageLabel(currentItem.stage, currentItem.status),
      stageElapsed: stageStartMs ? `${formatDuration(nowMs - stageStartMs)} in stage` : "Live"
    };
  }

  if (run.status === "queued") {
    return {
      elapsed: formatDuration(elapsedMs),
      progressPercent,
      eta,
      remaining,
      avgPerItem: avgMs ? formatDuration(avgMs) : "--",
      activityTitle: "Queued",
      activityDetail: "Waiting for the run worker to start.",
      stage: "Queued",
      stageElapsed: active ? "Live" : "--"
    };
  }

  if (run.status === "cancelling") {
    return {
      elapsed: formatDuration(elapsedMs),
      progressPercent,
      eta,
      remaining,
      avgPerItem: avgMs ? formatDuration(avgMs) : "--",
      activityTitle: "Cancelling run",
      activityDetail: "Stopping active work and marking pending rows as cancelled.",
      stage: "Cancelling",
      stageElapsed: "Live"
    };
  }

  if (run.status === "pausing") {
    return {
      elapsed: formatDuration(elapsedMs),
      progressPercent,
      eta,
      remaining,
      avgPerItem: avgMs ? formatDuration(avgMs) : "--",
      activityTitle: "Pausing run",
      activityDetail: "Stopping active work without cancelling pending rows.",
      stage: "Pausing",
      stageElapsed: "Live"
    };
  }

  if (run.status === "paused") {
    return {
      elapsed: formatDuration(elapsedMs),
      progressPercent,
      eta,
      remaining,
      avgPerItem: avgMs ? formatDuration(avgMs) : "--",
      activityTitle: "Paused",
      activityDetail: "Start another run now, then resume this one from history when ready.",
      stage: "Paused",
      stageElapsed: formatClock(endMs)
    };
  }

  if (active && nextItem) {
    return {
      elapsed: formatDuration(elapsedMs),
      progressPercent,
      eta,
      remaining,
      avgPerItem: avgMs ? formatDuration(avgMs) : "--",
      activityTitle: `${nextItem.catalogNumber} (${nextItem.rowIndex}/${run.total})`,
      activityDetail: "Waiting for the next row to start.",
      stage: "Waiting",
      stageElapsed: "Live"
    };
  }

  if (run.status === "running" && run.activityStage) {
    return {
      elapsed: formatDuration(elapsedMs),
      progressPercent,
      eta,
      remaining,
      avgPerItem: avgMs ? formatDuration(avgMs) : "--",
      activityTitle: runActivityTitle(run.activityStage),
      activityDetail: run.activityMessage ?? "Finalizing output.",
      stage: runActivityTitle(run.activityStage),
      stageElapsed: runActivityStartMs ? `${formatDuration(nowMs - runActivityStartMs)} in stage` : "Live"
    };
  }

  const terminalItemStatus: RunItemRecord["status"] =
    run.status === "failed" ? "failed" : run.status === "cancelled" ? "cancelled" : "pending";
  return {
    elapsed: formatDuration(elapsedMs),
    progressPercent,
    eta,
    remaining,
    avgPerItem: avgMs ? formatDuration(avgMs) : "--",
    activityTitle: run.status === "running" ? "Finalizing output" : `Run ${run.status}`,
    activityDetail: run.error ?? (run.outputPath ? "Workbook and debug output are ready." : "No active item."),
    stage: run.status === "completed" ? "Complete" : stageLabel(undefined, terminalItemStatus),
    stageElapsed: active ? "Live" : formatClock(endMs)
  };
}

function runActivityTitle(stage: string): string {
  switch (stage) {
    case "workbook-build":
      return "Building workbook";
    case "cleaned-input":
      return "Preparing cleaned input";
    case "ai-cleanup":
    case "health-check":
      return "Preparing AI cleanup";
    case "qwen-cleanup":
      return "Running Qwen cleanup";
    case "reviewing":
    case "ai-cleanup-review":
      return "Reviewing AI cleanup";
    case "cleaned-input-review":
      return "Writing cleaned input";
    case "workbook-style":
      return "Styling workbook";
    case "workbook-write":
      return "Writing workbook";
    case "disabled":
      return "AI cleanup disabled";
    case "unavailable":
      return "AI unavailable";
    case "done":
      return "AI cleanup complete";
    default:
      return "Finalizing output";
  }
}

function estimateRunProgress(
  run: RunRecord,
  items: RunItemRecord[],
  nowMs: number,
  startMs: number,
  elapsedMs: number,
  currentItem: RunItemRecord | undefined
): RunProgressEstimate {
  const processed = Math.max(0, Math.min(run.total, run.processed));
  const completedItems = items
    .filter((item) => FINISHED_ITEM_STATUSES.has(item.status))
    .slice()
    .sort((a, b) => a.rowIndex - b.rowIndex);
  const completedTimes = completedItems
    .map((item) => safeTime(item.updatedAt))
    .filter((time): time is number => time !== undefined && time >= startMs && time <= nowMs + 60_000);
  const durations: number[] = [];
  let previousMs = startMs;

  for (const completedAtMs of completedTimes) {
    const durationMs = completedAtMs - previousMs;
    if (durationMs >= MIN_ITEM_AVG_MS / 4 && durationMs <= MAX_REASONABLE_ITEM_MS) {
      durations.push(durationMs);
    }
    if (completedAtMs > previousMs) {
      previousMs = completedAtMs;
    }
  }

  const recentAvgMs = averageMs(durations.slice(-RECENT_ITEM_SAMPLE_SIZE));
  const completedSpanMs = completedTimes.length > 0 ? Math.max(0, completedTimes[completedTimes.length - 1] - startMs) : 0;
  const completedCountForSpan = Math.max(1, Math.min(processed, completedTimes.length || processed));
  const overallAvgMs =
    processed > 0 && completedSpanMs > 0
      ? completedSpanMs / completedCountForSpan
      : processed > 0
        ? elapsedMs / processed
        : undefined;
  const avgMs = normalizeAvgMs(
    recentAvgMs !== undefined && overallAvgMs !== undefined
      ? recentAvgMs * 0.65 + overallAvgMs * 0.35
      : recentAvgMs ?? overallAvgMs
  );

  if (!avgMs) {
    return { avgMs, effectiveProcessed: processed };
  }

  const currentElapsedMs = currentItem ? estimateCurrentItemElapsedMs(currentItem, completedItems, startMs, nowMs) : 0;
  const currentRemainingMs = currentItem ? Math.max(0, avgMs - currentElapsedMs) : 0;
  const untouchedCount = Math.max(0, run.total - processed - (currentItem ? 1 : 0));
  const estimatedRemainingMs = currentRemainingMs + avgMs * untouchedCount;
  const effectiveProcessed = Math.max(0, Math.min(run.total, run.total - estimatedRemainingMs / avgMs));

  return { avgMs, effectiveProcessed, estimatedRemainingMs };
}

function estimateCurrentItemElapsedMs(
  currentItem: RunItemRecord,
  completedItems: RunItemRecord[],
  startMs: number,
  nowMs: number
): number {
  const previousCompletedAtMs = completedItems
    .filter((item) => item.rowIndex < currentItem.rowIndex)
    .map((item) => safeTime(item.updatedAt))
    .filter((time): time is number => time !== undefined)
    .at(-1);
  const itemStartMs = previousCompletedAtMs ?? safeTime(currentItem.stageStartedAt) ?? startMs;
  return Math.max(0, nowMs - itemStartMs);
}

function averageMs(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeAvgMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(MIN_ITEM_AVG_MS, value);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function stageLabel(stage: string | undefined, status: RunItemRecord["status"]): string {
  if (stage && STAGE_LABELS[stage]) return STAGE_LABELS[stage];
  if (status === "processing") return "Processing";
  if (status === "pending") return "Pending";
  if (status === "cancelled") return "Cancelled";
  if (status === "failed") return "Failed";
  if (status === "found" || status === "partial") return "Complete";
  return stage ?? status;
}

const STAGE_LABELS: Record<string, string> = {
  pending: "Pending",
  "customer-override": "Customer doc",
  "official-source": "Manufacturer website",
  "quality-gate": "Quality check",
  downloads: "Downloads",
  "document-enrichment": "Document parse",
  "quality-fallback": "Fallback",
  "final-audit": "Final audit",
  "final-field-repair": "Field repair",
  "final-network-retry": "Final retry",
  evidence: "Evidence",
  complete: "Complete",
  paused: "Paused",
  failed: "Failed",
  cancelled: "Cancelled"
};

function safeTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--";
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ManufacturerWizardPreview({ inspectResult, testResult }: { inspectResult: ManufacturerInspectResult | null; testResult: ManufacturerTestResult | null }) {
  if (!inspectResult && !testResult) {
    return (
      <div className="wizard-empty">
        <Search size={22} />
        <div>
          <strong>No test yet</strong>
          <span>Auto-detect will inspect the official site, robots/sitemaps, search forms, and possible product URL templates.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard-preview">
      {inspectResult && (
        <section className="wizard-card">
          <div className="wizard-card-head">
            <div>
              <span className="section-label">Auto-detect preview</span>
              <h4>{inspectResult.suggested.canonicalName}</h4>
            </div>
            <span className="origin-pill">{inspectResult.suggested.shortName}</span>
          </div>
          <div className="wizard-metrics">
            <Metric label="Direct templates" value={inspectResult.directUrlTemplates.length} />
            <Metric label="Search templates" value={inspectResult.searchUrlTemplates.length} />
            <Metric label="Sitemaps" value={inspectResult.sitemapUrls.length} />
            <Metric label="Product URLs" value={inspectResult.discoveredProductUrls.length} />
          </div>
          <WizardList title="Why I trust it" items={inspectResult.reasons} />
          <WizardList title="Warnings" items={inspectResult.warnings} tone="warn" />
          <WizardList title="Direct URL templates" items={inspectResult.directUrlTemplates} monospace />
          <WizardList title="Search templates" items={inspectResult.searchUrlTemplates} monospace />
          <WizardLinkList title="Discovered product URLs" items={inspectResult.discoveredProductUrls} />
        </section>
      )}

      {testResult && (
        <section className={testResult.passed ? "wizard-card pass" : "wizard-card fail"}>
          <div className="wizard-card-head">
            <div>
              <span className="section-label">Sample test</span>
              <h4>{testResult.passed ? "Ready to save" : "Needs one official match"}</h4>
            </div>
            <span className={testResult.passed ? "test-pill pass" : "test-pill fail"}>
              {testResult.foundCount}/{testResult.sampleCount} passed
            </span>
          </div>
          <WizardList title="Test warnings" items={testResult.warnings} tone="warn" />
          <div className="sample-results">
            {testResult.samples.map((sample) => (
              <div className={sample.passed ? "sample-result good" : "sample-result bad"} key={sample.catalogNumber}>
                <div className="sample-result-head">
                  <strong>{sample.catalogNumber}</strong>
                  <span>{sample.passed ? "Found official product" : sample.status}</span>
                </div>
                {sample.productUrl && (
                  <a href={sample.productUrl} target="_blank" rel="noreferrer">
                    {sample.productUrl}
                  </a>
                )}
                <div className="sample-stats">
                  <span>{sample.attributes} attributes</span>
                  <span>{sample.documents} documents</span>
                  <span>{sample.evidence} evidence</span>
                  <span>{sample.identityConfirmed ? "identity ok" : "identity missing"}</span>
                </div>
                <p>{sample.reason}</p>
                {sample.missing.length > 0 && <code>Missing: {sample.missing.slice(0, 8).join("; ")}</code>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function WizardList({ title, items, tone, monospace = false }: { title: string; items: string[]; tone?: "warn"; monospace?: boolean }) {
  if (!items.length) return null;
  return (
    <div className={tone === "warn" ? "wizard-list warn" : "wizard-list"}>
      <strong>{title}</strong>
      <div>
        {items.slice(0, 8).map((item, index) => (
          <code className={monospace ? "mono" : ""} key={`${item}-${index}`}>{item}</code>
        ))}
      </div>
    </div>
  );
}

function WizardLinkList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="wizard-list">
      <strong>{title}</strong>
      <div>
        {items.slice(0, 8).map((item) => (
          <a href={item} target="_blank" rel="noreferrer" key={item}>
            {item}
          </a>
        ))}
      </div>
    </div>
  );
}

function RunItemDrawer({ item, onClose }: { item: RunItemRecord; onClose: () => void }) {
  const result = item.result;
  if (!result) return null;
  const diagnostics = result.diagnostics;
  return (
    <section className="drawer-shell" aria-label="Run item diagnostics">
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer-panel">
        <div className="drawer-header">
          <div>
            <span className="section-label">Run item</span>
            <h2>{item.catalogNumber}</h2>
            <p>{itemReason(item)}</p>
          </div>
          <button type="button" className="icon-danger" onClick={onClose} title="Close diagnostics">
            <XCircle size={16} />
          </button>
        </div>

        <div className="drawer-metrics">
          <Metric label="Status" value={result.status} />
          <Metric label="Stage" value={stageLabel(item.stage, item.status)} />
          <Metric label="Quality" value={result.qualityGate?.score ?? 0} />
          <Metric label="Attributes" value={result.attributes.length} />
          <Metric label="Documents" value={result.documents.length} />
        </div>

        <DebugSection title="Quality missing" items={result.qualityGate?.missing ?? []} />
        <DebugSection title="Final missing after audit" items={diagnostics?.finalCompleteness?.afterMissing ?? []} />
        <DebugSection title="Final repaired fields" items={diagnostics?.finalCompleteness?.repairedFields ?? []} />
        <DebugObjectSection title="Final audit" items={diagnostics?.finalCompleteness?.records ?? []} defaultOpen />
        <DebugSection title="Attempted URLs" items={diagnostics?.attemptedUrls ?? []} />
        <DebugObjectSection title="Discovered candidates" items={diagnostics?.discoveredCandidates ?? []} />
        <DebugObjectSection title="Rejected links" items={diagnostics?.rejectedLinks ?? []} />
        <DebugObjectSection title="Browser network" items={diagnostics?.browserNetwork ?? []} />
        <DebugObjectSection title="Downloaded documents" items={result.documents.slice(0, 40)} />
        <DebugObjectSection title="Evidence" items={(result.evidence ?? []).slice(0, 80)} />
      </aside>
    </section>
  );
}

function DebugSection({ title, items }: { title: string; items: string[] }) {
  return (
    <details className="debug-section" open={items.length > 0}>
      <summary>{title}<span>{items.length}</span></summary>
      <div className="debug-list">
        {items.length ? items.slice(0, 80).map((item, index) => <code key={`${item}-${index}`}>{item}</code>) : <span className="muted">No records.</span>}
      </div>
    </details>
  );
}

function DebugObjectSection({ title, items, defaultOpen = false }: { title: string; items: unknown[]; defaultOpen?: boolean }) {
  return (
    <details className="debug-section" open={items.length > 0 && (defaultOpen || title === "Evidence")}>
      <summary>{title}<span>{items.length}</span></summary>
      <div className="debug-object-list">
        {items.length ? (
          items.slice(0, 80).map((item, index) => (
            <pre key={index}>{JSON.stringify(item, null, 2)}</pre>
          ))
        ) : (
          <span className="muted">No records.</span>
        )}
      </div>
    </details>
  );
}

function buildCoverage(
  items: RunItemRecord[],
  customFields: ReadonlyArray<{ id: string; label: string; pattern: string }>
) {
  const parsedItems = items.filter((item) => item.result || item.coverage);
  const builtIn = REQUIRED_COVERAGE_FIELDS.map((field) => {
    let count = 0;
    let missing = 0;
    let notApplicable = 0;
    for (const item of parsedItems) {
      const state = coverageState(item, field.key);
      if (state === "present") count += 1;
      if (state === "missing") missing += 1;
      if (state === "not-applicable") notApplicable += 1;
    }
    const total = count + missing;
    return {
      ...field,
      key: field.key as string,
      isCustom: false as const,
      count,
      missing,
      notApplicable,
      total,
      percent: total ? Math.round((count / total) * 100) : notApplicable ? 100 : 0
    };
  });

  const custom = customFields.map((field) => {
    let count = 0;
    let missing = 0;
    for (const item of parsedItems) {
      // Custom fields are evaluated server-side and arrive on `item.coverage.customFields`.
      // Items processed before the field was added simply won't have an entry; we exclude
      // them from the denominator so the bar reflects only items that knew about the field.
      const entry = item.coverage?.customFields?.find((custom) => custom.id === field.id);
      if (!entry) continue;
      if (entry.state === "present") count += 1;
      if (entry.state === "missing") missing += 1;
    }
    const total = count + missing;
    return {
      key: `custom:${field.id}`,
      label: field.label,
      isCustom: true as const,
      count,
      missing,
      notApplicable: 0,
      total,
      percent: total ? Math.round((count / total) * 100) : 0
    };
  });

  return [...builtIn, ...custom];
}

function buildRunItemFilterCounts(items: RunItemRecord[]): Record<RunItemFilter, number> {
  const counts: Record<RunItemFilter, number> = {
    all: items.length,
    "needs-check": 0,
    found: 0,
    partial: 0,
    failed: 0,
    pending: 0,
    processing: 0,
    cancelled: 0
  };
  for (const item of items) {
    counts[item.status] += 1;
    if (runItemNeedsCheck(item)) counts["needs-check"] += 1;
  }
  return counts;
}

function filterRunItems(
  items: RunItemRecord[],
  query: string,
  filter: RunItemFilter,
  coverageFocus: CoverageFocus | null
): RunItemRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery && filter === "all" && !coverageFocus) return items;
  return items.filter(
    (item) =>
      runItemMatchesFilter(item, filter) &&
      runItemMatchesQuery(item, normalizedQuery) &&
      matchesCoverageFocus(item, coverageFocus)
  );
}

function matchesCoverageFocus(item: RunItemRecord, focus: CoverageFocus | null): boolean {
  if (!focus) return true;
  if (focus.key.startsWith("custom:")) {
    // Custom coverage fields are only ever "present"/"missing" server-side (see buildCoverage) —
    // there's no "not-applicable" concept for them, so that state never matches.
    if (focus.state === "not-applicable") return false;
    const id = focus.key.slice("custom:".length);
    return item.coverage?.customFields?.find((custom) => custom.id === id)?.state === "missing";
  }
  return coverageState(item, focus.key as CoverageKey) === focus.state;
}

function uniqueCatalogNumbers(items: RunItemRecord[]): string[] {
  return [...new Set(items.map((item) => item.catalogNumber.trim()).filter(Boolean))];
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy path below.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function downloadTextFile(fileName: string, body: string) {
  const blob = new Blob([`${body}\n`], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "catalogs.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildRunItemQueryImpact(
  items: RunItemRecord[],
  query: string,
  filter: RunItemFilter
): { count: number } | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length < 2) return null;
  const count = items.filter((item) => runItemMatchesFilter(item, filter) && runItemProblemText(item).includes(normalizedQuery)).length;
  return count > 0 ? { count } : null;
}

function runItemMatchesFilter(item: RunItemRecord, filter: RunItemFilter): boolean {
  if (filter === "all") return true;
  if (filter === "needs-check") return runItemNeedsCheck(item);
  return item.status === filter;
}

function runItemNeedsCheck(item: RunItemRecord): boolean {
  return (
    item.status === "failed" ||
    item.status === "partial" ||
    item.coverage?.qualityPassed === false ||
    item.result?.qualityGate?.passed === false ||
    criticalMissingCoverage(item).length > 0
  );
}

function runItemMatchesQuery(item: RunItemRecord, query: string): boolean {
  if (!query) return true;
  return [
    item.rowIndex,
    item.catalogNumber,
    item.status,
    item.stage,
    item.stageMessage,
    item.title,
    item.error,
    item.productUrl,
    itemReason(item)
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function runItemProblemText(item: RunItemRecord): string {
  return [
    itemReason(item),
    item.coverage?.reason,
    ...(item.coverage?.qualityMissing ?? []),
    ...(item.coverage?.finalCompletenessAfterMissing ?? []),
    item.result?.qualityGate?.reason,
    ...(item.result?.qualityGate?.missing ?? []),
    item.error
  ]
    .join(" ")
    .toLowerCase();
}

function clampPage(value: number, pageCount: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.round(value), 1), pageCount);
}

function formatFileSize(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function hasCoverageValue(item: RunItemRecord, key: CoverageKey): boolean {
  if (item.coverage?.fields[key] === "present") return true;
  if (item.coverage?.fields[key] === "missing" || item.coverage?.fields[key] === "not-applicable") return false;
  const result = item.result;
  if (!result) return false;
  switch (key) {
    case "enUrl":
      return Boolean(result.localizedUrls?.en || result.productUrl);
    case "deUrl":
      return hasDistinctGermanUrl(result);
    case "image":
      return hasDownloadedImage(result);
    case "weight":
      return Boolean(result.normalized.weight);
    case "certificates":
      return Boolean(result.normalized.certificates);
    case "dimensions":
      return Boolean(result.normalized.dimensions);
    case "material":
      return Boolean(result.normalized.material);
    case "voltage":
      return Boolean(result.normalized.voltage);
    case "current":
      return Boolean(result.normalized.current);
  }
}

function coverageState(item: RunItemRecord, key: CoverageKey): "present" | "missing" | "not-applicable" {
  const summaryState = item.coverage?.fields[key];
  if (summaryState) return summaryState;
  if (hasCoverageValue(item, key)) return "present";
  const result = item.result;
  if (!result) return "missing";
  if (key === "deUrl" && !hasDistinctGermanUrl(result) && isGermanUrlNotApplicable(result)) return "not-applicable";
  if ((key === "voltage" || key === "current") && !requiredElectricalFields(result).includes(key)) return "not-applicable";
  return "missing";
}

function criticalMissingCoverage(item: RunItemRecord): string[] {
  if (item.coverage?.criticalMissing) return item.coverage.criticalMissing.map(coverageLabel);
  if (!item.result) return [];
  return (["image", "weight", "dimensions", "material", "voltage", "current"] as const)
    .filter((key) => coverageState(item, key) === "missing")
    .map(coverageLabel);
}

function coverageLabel(key: CoverageKey): string {
  return REQUIRED_COVERAGE_FIELDS.find((field) => field.key === key)?.label ?? key;
}

function hasDownloadedImage(result: NonNullable<RunItemRecord["result"]>): boolean {
  const images = result.documents.filter((doc) => doc.type === "image");
  if (!images.length) return false;
  return images.some((doc) => doc.localPath || doc.downloadStatus === "downloaded" || doc.downloadStatus === undefined);
}

function hasDistinctGermanUrl(result: NonNullable<RunItemRecord["result"]>): boolean {
  const germanUrl = result.localizedUrls?.de;
  if (!germanUrl) return false;
  return ![result.localizedUrls?.en, result.productUrl]
    .filter((url): url is string => Boolean(url))
    .some((url) => sameUrl(url, germanUrl));
}

function isGermanUrlNotApplicable(result: NonNullable<RunItemRecord["result"]>): boolean {
  if (result.manufacturerId === "sce") return true;
  const germanUrl = result.localizedUrls?.de;
  return Boolean(
    germanUrl &&
      [result.localizedUrls?.en, result.productUrl]
        .filter((url): url is string => Boolean(url))
        .some((url) => sameUrl(url, germanUrl))
  );
}

function sameUrl(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.origin.toLowerCase() === rightUrl.origin.toLowerCase() &&
      leftUrl.pathname.replace(/\/+$/, "").toLowerCase() === rightUrl.pathname.replace(/\/+$/, "").toLowerCase() &&
      leftUrl.searchParams.toString() === rightUrl.searchParams.toString()
    );
  } catch {
    return left.replace(/\/+$/, "").toLowerCase() === right.replace(/\/+$/, "").toLowerCase();
  }
}

function itemReason(item: RunItemRecord): string {
  const result = item.result;
  if (!result) {
    if (item.coverage?.reason) return item.coverage.reason;
    if (item.coverage?.qualityMissing?.length) return item.coverage.qualityMissing.slice(0, 4).join("; ");
    return item.stageMessage ?? item.error ?? "";
  }
  const missingCoverage = criticalMissingCoverage(item);
  if (missingCoverage.length) return `Missing ${missingCoverage.join(", ")}`;
  if (result.qualityGate?.passed) return "quality ok";
  if (result.qualityGate?.missing.length) return result.qualityGate.missing.slice(0, 4).join("; ");
  return result.error ?? item.error ?? result.qualityGate?.reason ?? "";
}

function emptyManufacturerDraft(): ManufacturerDraft {
  return {
    id: "",
    canonicalName: "",
    shortName: "",
    rateLimitMs: "1500",
    officialBaseUrlsText: "",
    localizedUrlTemplatesText: "",
    aliasesText: "",
    markerRulesText: "",
    fetchTimeoutMs: "",
    cacheTtlMs: "",
    maxAttempts: "",
    retryBackoffMs: "",
    minContentLength: "",
    userAgent: "",
    acceptLanguage: "",
    referer: "",
    fallbackUserAgentsText: "",
    scrapeRecipeJson: "",
    fallbackSources: [emptySourceDraft(1)],
    customCoverageFields: []
  };
}

function emptySourceDraft(index: number): SourceDraft {
  return {
    id: `source-${index}`,
    label: `Source ${index}`,
    enabled: true,
    sourceType: "distributor",
    directUrlTemplatesText: "",
    aliasesText: "",
    markerRulesText: "",
    confidence: "",
    fetchTimeoutMs: "",
    cacheTtlMs: "",
    maxAttempts: "",
    retryBackoffMs: "",
    minContentLength: "",
    userAgent: "",
    acceptLanguage: "",
    referer: "",
    fallbackUserAgentsText: ""
  };
}

function toManufacturerDraft(config: ManufacturerConfig): ManufacturerDraft {
  return {
    id: config.id,
    canonicalName: config.canonicalName,
    shortName: config.shortName,
    rateLimitMs: String(config.rateLimitMs),
    officialBaseUrlsText: config.officialBaseUrls.join("\n"),
    localizedUrlTemplatesText: formatLocalizedUrlTemplates(config.localizedUrlTemplates),
    aliasesText: (config.match?.aliases ?? []).join("\n"),
    markerRulesText: formatMarkerRules(config.markerRules),
    fetchTimeoutMs: config.fetchPolicy?.timeoutMs !== undefined ? String(config.fetchPolicy.timeoutMs) : "",
    cacheTtlMs: config.fetchPolicy?.cacheTtlMs !== undefined ? String(config.fetchPolicy.cacheTtlMs) : "",
    maxAttempts: config.fetchPolicy?.maxAttempts !== undefined ? String(config.fetchPolicy.maxAttempts) : "",
    retryBackoffMs: config.fetchPolicy?.retryBackoffMs !== undefined ? String(config.fetchPolicy.retryBackoffMs) : "",
    minContentLength: config.fetchPolicy?.minContentLength !== undefined ? String(config.fetchPolicy.minContentLength) : "",
    userAgent: config.fetchPolicy?.userAgent ?? "",
    acceptLanguage: config.fetchPolicy?.acceptLanguage ?? "",
    referer: config.fetchPolicy?.referer ?? "",
    fallbackUserAgentsText: (config.fetchPolicy?.fallbackUserAgents ?? []).join("\n"),
    scrapeRecipeJson: formatJson(config.scrapeRecipe),
    customCoverageFields: (config.customCoverageFields ?? []).map((field) => ({
      id: field.id,
      label: field.label,
      pattern: field.pattern
    })),
    fallbackSources: config.fallbackSources.length
      ? config.fallbackSources.map((source) => ({
          id: source.id,
          label: source.label,
          enabled: source.enabled,
          sourceType: source.sourceType,
          directUrlTemplatesText: source.directUrlTemplates.join("\n"),
          aliasesText: (source.match?.aliases ?? []).join("\n"),
          markerRulesText: formatMarkerRules(source.markerRules),
          confidence: source.confidence ? String(source.confidence) : "",
          fetchTimeoutMs: source.fetchPolicy?.timeoutMs !== undefined ? String(source.fetchPolicy.timeoutMs) : "",
          cacheTtlMs: source.fetchPolicy?.cacheTtlMs !== undefined ? String(source.fetchPolicy.cacheTtlMs) : "",
          maxAttempts: source.fetchPolicy?.maxAttempts !== undefined ? String(source.fetchPolicy.maxAttempts) : "",
          retryBackoffMs: source.fetchPolicy?.retryBackoffMs !== undefined ? String(source.fetchPolicy.retryBackoffMs) : "",
          minContentLength: source.fetchPolicy?.minContentLength !== undefined ? String(source.fetchPolicy.minContentLength) : "",
          userAgent: source.fetchPolicy?.userAgent ?? "",
          acceptLanguage: source.fetchPolicy?.acceptLanguage ?? "",
          referer: source.fetchPolicy?.referer ?? "",
          fallbackUserAgentsText: (source.fetchPolicy?.fallbackUserAgents ?? []).join("\n")
        }))
      : []
  };
}

function manufacturerDraftToConfig(draft: ManufacturerDraft): ManufacturerConfig {
  const id = slugify(draft.id || draft.shortName || draft.canonicalName);
  const shortName = draft.shortName.trim().toUpperCase();
  const canonicalName = draft.canonicalName.trim();
  if (!id || !shortName || !canonicalName) {
    throw new Error("Manufacturer needs ID, short name, and company name.");
  }

  const aliases = splitFlexibleList(draft.aliasesText);
  const markerRules = parseMarkerRules(draft.markerRulesText);
  const localizedUrlTemplates = parseLocalizedUrlTemplates(draft.localizedUrlTemplatesText);
  const scrapeRecipe = parseOptionalJson(draft.scrapeRecipeJson, "Advanced scrape recipe JSON");
  const fetchPolicy = compactObject({
    timeoutMs: optionalNumber(draft.fetchTimeoutMs),
    cacheTtlMs: optionalNumber(draft.cacheTtlMs),
    maxAttempts: optionalNumber(draft.maxAttempts),
    retryBackoffMs: optionalNumber(draft.retryBackoffMs),
    minContentLength: optionalNumber(draft.minContentLength),
    userAgent: optionalText(draft.userAgent),
    acceptLanguage: optionalText(draft.acceptLanguage),
    referer: optionalText(draft.referer),
    fallbackUserAgents: splitLines(draft.fallbackUserAgentsText)
  });

  return {
    id,
    canonicalName,
    shortName,
    rateLimitMs: Number(draft.rateLimitMs || 1500),
    officialBaseUrls: splitLines(draft.officialBaseUrlsText),
    ...(localizedUrlTemplates.length ? { localizedUrlTemplates } : {}),
    ...(aliases.length ? { match: { aliases } } : {}),
    ...(markerRules.length ? { markerRules } : {}),
    ...(fetchPolicy ? { fetchPolicy } : {}),
    ...(scrapeRecipe ? { scrapeRecipe } : {}),
    fallbackSources: draft.fallbackSources
      .map((source, index) => {
        const sourceAliases = splitFlexibleList(source.aliasesText);
        const sourceMarkerRules = parseMarkerRules(source.markerRulesText);
        const sourceFetchPolicy = compactObject({
          timeoutMs: optionalNumber(source.fetchTimeoutMs),
          cacheTtlMs: optionalNumber(source.cacheTtlMs),
          maxAttempts: optionalNumber(source.maxAttempts),
          retryBackoffMs: optionalNumber(source.retryBackoffMs),
          minContentLength: optionalNumber(source.minContentLength),
          userAgent: optionalText(source.userAgent),
          acceptLanguage: optionalText(source.acceptLanguage),
          referer: optionalText(source.referer),
          fallbackUserAgents: splitLines(source.fallbackUserAgentsText)
        });
        return {
          id: slugify(source.id || source.label || `source-${index + 1}`),
          label: source.label.trim() || `Source ${index + 1}`,
          enabled: source.enabled,
          sourceType: source.sourceType,
          directUrlTemplates: splitLines(source.directUrlTemplatesText),
          ...(sourceAliases.length ? { match: { aliases: sourceAliases } } : {}),
          ...(sourceMarkerRules.length ? { markerRules: sourceMarkerRules } : {}),
          ...(sourceFetchPolicy ? { fetchPolicy: sourceFetchPolicy } : {}),
          ...(optionalNumber(source.confidence) !== undefined ? { confidence: optionalNumber(source.confidence) } : {})
        };
      })
      .filter((source) => source.id && source.label && source.directUrlTemplates.length > 0),
    ...(draft.customCoverageFields.length
      ? {
          customCoverageFields: draft.customCoverageFields
            .map((field, index) => {
              const label = field.label.trim();
              const pattern = field.pattern.trim();
              const slug = slugify(field.id || label || `coverage-${index + 1}`);
              return { id: slug, label, pattern };
            })
            .filter((field) => field.id && field.label && field.pattern)
        }
      : {})
  };
}

function splitLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

function splitFlexibleList(value: string): string[] {
  return [...new Set(value.split(/[\r\n,;]+/).map((line) => line.trim()).filter(Boolean))];
}

function parseLocalizedUrlTemplates(value: string) {
  return splitLines(value)
    .map((line) => {
      const match = line.match(/^(en|de)\s*[:=,\s]\s*(.+)$/i);
      if (!match) return undefined;
      return {
        locale: match[1].toLowerCase() as "en" | "de",
        urlTemplate: match[2].trim()
      };
    })
    .filter((template): template is { locale: "en" | "de"; urlTemplate: string } => Boolean(template?.urlTemplate));
}

function formatLocalizedUrlTemplates(templates: ManufacturerConfig["localizedUrlTemplates"]): string {
  return (templates ?? []).map((template) => `${template.locale} ${template.urlTemplate}`).join("\n");
}

function parseMarkerRules(value: string): MarkerExtractionRule[] {
  return splitLines(value)
    .map((line) => {
      const parts = line.split("|||").map((part) => part.trim());
      const [name, start, end, ...options] = parts;
      if (!name || !start) return undefined;
      const rule: MarkerExtractionRule = {
        name,
        start,
        ...(end ? { end } : {})
      };
      if (/image\s*url|imageurldownload|product image/i.test(name)) rule.documentType = "image";
      for (const option of options.join(";").split(/[;,]+/).map((item) => item.trim()).filter(Boolean)) {
        const [rawKey, ...rawValue] = option.split("=");
        const key = rawKey.trim().toLowerCase();
        const optionValue = rawValue.join("=").trim();
        if (key === "group" && optionValue) rule.group = optionValue;
        if (key === "type" && isDocumentType(optionValue)) rule.documentType = optionValue;
        if (key === "prefix" && optionValue) rule.urlPrefix = optionValue;
        if (key === "suffix" && optionValue) rule.urlSuffix = optionValue;
        if (key === "case" && optionValue) rule.caseSensitive = optionValue.toLowerCase() === "sensitive";
      }
      return rule;
    })
    .filter((rule): rule is MarkerExtractionRule => Boolean(rule));
}

function formatMarkerRules(rules: ManufacturerConfig["markerRules"]): string {
  return (rules ?? [])
    .map((rule) => {
      const options = [
        rule.group ? `group=${rule.group}` : "",
        rule.documentType ? `type=${rule.documentType}` : "",
        rule.urlPrefix ? `prefix=${rule.urlPrefix}` : "",
        rule.urlSuffix ? `suffix=${rule.urlSuffix}` : "",
        rule.caseSensitive ? "case=sensitive" : ""
      ].filter(Boolean);
      return [rule.name, rule.start, rule.end ?? "", options.join("; ")].filter((part, index) => index < 3 || part).join("|||");
    })
    .join("\n");
}

function isDocumentType(value: string): value is NonNullable<MarkerExtractionRule["documentType"]> {
  return ["datasheet", "certificate", "manual", "cad", "image", "other"].includes(value);
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numberValue = Number(trimmed);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function formatJson(value: unknown): string {
  return value ? JSON.stringify(value, null, 2) : "";
}

function parseOptionalJson(value: string, label: string): ScrapeRecipeConfig | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object.`);
    }
    return parsed as ScrapeRecipeConfig;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must be")) throw error;
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseRecipeJsonLoose(value: string): ScrapeRecipeConfig {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ScrapeRecipeConfig : {};
  } catch {
    return {};
  }
}

function mergeRecipeConfig(existing: ScrapeRecipeConfig, patch: ScrapeRecipeConfig): ScrapeRecipeConfig {
  return {
    ...existing,
    ...patch,
    discoveryPolicy: patch.discoveryPolicy ? { ...existing.discoveryPolicy, ...patch.discoveryPolicy } : existing.discoveryPolicy,
    interactionPolicy: patch.interactionPolicy ? { ...existing.interactionPolicy, ...patch.interactionPolicy } : existing.interactionPolicy,
    extractionPolicy: patch.extractionPolicy ? { ...existing.extractionPolicy, ...patch.extractionPolicy } : existing.extractionPolicy,
    qualityPolicy: patch.qualityPolicy ? { ...existing.qualityPolicy, ...patch.qualityPolicy } : existing.qualityPolicy,
    fallbackPolicy: patch.fallbackPolicy ? { ...existing.fallbackPolicy, ...patch.fallbackPolicy } : existing.fallbackPolicy,
    confidenceRules: patch.confidenceRules ? { ...existing.confidenceRules, ...patch.confidenceRules } : existing.confidenceRules
  };
}

function toggleList<T extends string>(items: readonly T[], item: T, checked: boolean): T[] {
  const set = new Set(items);
  if (checked) set.add(item);
  else set.delete(item);
  return [...set];
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> | undefined {
  const entries = Object.entries(value).filter(([, entryValue]) => {
    if (Array.isArray(entryValue)) return entryValue.length > 0;
    return entryValue !== undefined && entryValue !== "";
  });
  return entries.length ? Object.fromEntries(entries) as Partial<T> : undefined;
}

function shortNameFromName(value: string): string {
  const words = value.split(/[^a-z0-9]+/i).filter(Boolean);
  if (!words.length) return "";
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  return words.map((word) => word[0]).join("").slice(0, 6).toUpperCase();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}
