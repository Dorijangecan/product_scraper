import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  History,
  Layers3,
  ListChecks,
  Loader2,
  Pencil,
  Play,
  Plus,
  Save,
  Search,
  Settings2,
  Trash2,
  Upload,
  XCircle
} from "lucide-react";
import type { CsvPreview, FallbackSourceConfig, ManufacturerConfig, RunItemRecord, RunRecord } from "../shared/types.js";
import { cancelRun, getManufacturers, getRun, listRuns, previewCsv, saveManufacturer, startRun } from "./api.js";

interface SourceDraft {
  id: string;
  label: string;
  enabled: boolean;
  sourceType: FallbackSourceConfig["sourceType"];
  directUrlTemplatesText: string;
}

interface ManufacturerDraft {
  id: string;
  canonicalName: string;
  shortName: string;
  rateLimitMs: string;
  officialBaseUrlsText: string;
  fallbackSources: SourceDraft[];
}

const REQUIRED_COVERAGE_FIELDS = [
  { key: "enUrl", label: "EN link" },
  { key: "deUrl", label: "DE link" },
  { key: "weight", label: "Weight" },
  { key: "certificates", label: "Certificates" },
  { key: "dimensions", label: "Dimensions" },
  { key: "material", label: "Material" }
] as const;

type CoverageKey = (typeof REQUIRED_COVERAGE_FIELDS)[number]["key"];

export function App() {
  const [manufacturers, setManufacturers] = useState<ManufacturerConfig[]>([]);
  const [manufacturerId, setManufacturerId] = useState("abb");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [columnName, setColumnName] = useState("");
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [items, setItems] = useState<RunItemRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [manufacturerEditorOpen, setManufacturerEditorOpen] = useState(false);
  const [manufacturerDraft, setManufacturerDraft] = useState<ManufacturerDraft>(() => emptyManufacturerDraft());
  const [manufacturerSaveBusy, setManufacturerSaveBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedManufacturer = useMemo(
    () => manufacturers.find((manufacturer) => manufacturer.id === manufacturerId),
    [manufacturers, manufacturerId]
  );

  useEffect(() => {
    void refreshBootstrap();
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    void refreshSelectedRun(selectedRunId);
  }, [selectedRunId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshRuns();
      if (selectedRunId) void refreshSelectedRun(selectedRunId);
    }, selectedRun?.status === "running" || selectedRun?.status === "queued" || selectedRun?.status === "cancelling" ? 1200 : 4000);
    return () => window.clearInterval(timer);
  }, [selectedRunId, selectedRun?.status]);

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
      const data = await getRun(id);
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

  async function handleStart() {
    if (!file || !columnName) return;
    setBusy(true);
    setError(null);
    try {
      const run = await startRun({ file, manufacturerId, columnName });
      setSelectedRunId(run.id);
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

  function openEditManufacturer() {
    if (!selectedManufacturer) return;
    setManufacturerDraft(toManufacturerDraft(selectedManufacturer));
    setManufacturerEditorOpen(true);
  }

  function openNewManufacturer() {
    setManufacturerDraft(emptyManufacturerDraft());
    setManufacturerEditorOpen(true);
  }

  function updateManufacturerDraft(patch: Partial<ManufacturerDraft>) {
    setManufacturerDraft((current) => ({ ...current, ...patch }));
  }

  function updateSourceDraft(index: number, patch: Partial<SourceDraft>) {
    setManufacturerDraft((current) => ({
      ...current,
      fallbackSources: current.fallbackSources.map((source, sourceIndex) => (sourceIndex === index ? { ...source, ...patch } : source))
    }));
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

  const progress = selectedRun && selectedRun.total > 0 ? Math.round((selectedRun.processed / selectedRun.total) * 100) : 0;
  const readyToRun = Boolean(file && preview && columnName && selectedManufacturer);
  const canCancel = selectedRun?.status === "queued" || selectedRun?.status === "running" || selectedRun?.status === "cancelling";
  const hasWorkbook = selectedRun?.status === "completed" || selectedRun?.status === "cancelled";
  const historyCount = runs.length;
  const activeRunCount = runs.filter((run) => ["queued", "running", "cancelling"].includes(run.status)).length;
  const manufacturerSourceCount = selectedManufacturer?.fallbackSources.filter((source) => source.enabled).length ?? 0;
  const coverage = useMemo(() => buildCoverage(items), [items]);
  const coverageTotal = items.filter((item) => item.result).length;

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
            <select value={manufacturerId} onChange={(event) => setManufacturerId(event.target.value)}>
              {manufacturers.map((manufacturer) => (
                <option key={manufacturer.id} value={manufacturer.id}>
                  {manufacturer.shortName} - {manufacturer.canonicalName}
                </option>
              ))}
            </select>
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

          <label className="upload-zone">
            <span className="upload-icon">
              <Upload size={25} />
            </span>
            <strong>{file ? file.name : "Drop or select CSV/XLSX"}</strong>
            <span>{file ? "File loaded for preview" : "One catalog-number column"}</span>
            <input
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => void handleFile(event.currentTarget.files?.[0] ?? null)}
            />
          </label>

          {preview && (
            <>
              <label className="field">
                <span>Catalog column</span>
                <select value={columnName} onChange={(event) => setColumnName(event.target.value)}>
                  {preview.columns.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </select>
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
              {canCancel && (
                <button className="cancel-button" disabled={cancelBusy || selectedRun.status === "cancelling"} onClick={() => void handleCancel()}>
                  {cancelBusy ? <Loader2 className="spin" size={16} /> : <XCircle size={16} />}
                  {selectedRun.status === "cancelling" ? "Cancelling" : "Cancel"}
                </button>
              )}
              {hasWorkbook && (
                <a className="download-button" href={`/api/runs/${selectedRun.id}/files/result`}>
                  <Download size={16} />
                  Excel
                </a>
              )}
              {selectedRun && !["queued", "running", "cancelling"].includes(selectedRun.status) && (
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
                  <span>{coverageTotal} parsed products</span>
                </div>
                <div className="coverage-grid">
                  {coverage.map((row) => (
                    <div className="coverage-item" key={row.key}>
                      <span>{row.label}</span>
                      <strong>{row.total ? `${row.count}/${row.total}` : "0/0"}</strong>
                      <div className="mini-track" aria-hidden="true">
                        <i style={{ width: `${row.percent}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="table-wrap">
                <table className="run-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Catalog number</th>
                      <th>Status</th>
                      <th>Title</th>
                      <th>Confidence</th>
                      <th>Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td>{item.rowIndex}</td>
                        <td className="mono">{item.catalogNumber}</td>
                        <td>
                          <ItemBadge status={item.status} />
                        </td>
                        <td>{item.title ?? item.error ?? ""}</td>
                        <td>{item.confidence ? `${Math.round(item.confidence * 100)}%` : ""}</td>
                        <td>
                          {item.productUrl ? (
                            <a className="source-link" href={item.productUrl} target="_blank" rel="noreferrer">
                              Source
                              <ArrowUpRight size={13} />
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <EmptyState />
          )}
        </section>

        <aside className="history-panel">
          <PanelTitle icon={<History size={18} />} title="Run history" meta={`${runs.length} total`} />
          <div className="history-overview">
            <Metric label="Complete" value={runs.filter((run) => run.status === "completed").length} />
            <Metric label="Needs check" value={runs.filter((run) => run.status === "failed" || run.partial > 0).length} />
          </div>
          <div className="history-list">
            {runs.map((run) => {
              const runProgress = run.total > 0 ? Math.round((run.processed / run.total) * 100) : 0;
              const runManufacturer = manufacturers.find((manufacturer) => manufacturer.id === run.manufacturerId);
              const runShortName = runManufacturer?.shortName ?? run.manufacturerId.toUpperCase();

              return (
                <button
                  key={run.id}
                  className={run.id === selectedRunId ? "history-item active" : "history-item"}
                  onClick={() => setSelectedRunId(run.id)}
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
            })}
            {runs.length === 0 && <p className="muted">No runs yet.</p>}
          </div>

          {hasWorkbook && (
            <div className="output-box">
              <FolderOpen size={18} />
              <div>
                <strong>{selectedRun.status === "cancelled" ? "Partial workbook ready" : "Workbook ready"}</strong>
                <a href={`/api/runs/${selectedRun.id}/files/result`}>Download result XLSX</a>
                <a href={`/api/runs/${selectedRun.id}/files/log`}>Download run log</a>
              </div>
            </div>
          )}
        </aside>
      </section>

      {manufacturerEditorOpen && (
        <section className="manufacturer-panel">
          <div className="config-header">
            <PanelTitle icon={<Settings2 size={18} />} title="Manufacturer config" meta={manufacturerDraft.shortName || "Draft"} />
            <div className="run-actions">
              <button type="button" className="cancel-button" onClick={() => setManufacturerEditorOpen(false)}>
                <XCircle size={16} />
                Close
              </button>
              <button type="button" className="primary-action compact-action" onClick={() => void handleSaveManufacturer()} disabled={manufacturerSaveBusy}>
                {manufacturerSaveBusy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                Save manufacturer
              </button>
            </div>
          </div>

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
              <span>Official base URLs</span>
              <textarea
                rows={3}
                value={manufacturerDraft.officialBaseUrlsText}
                placeholder="https://www.company.com/products"
                onChange={(event) => updateManufacturerDraft({ officialBaseUrlsText: event.target.value })}
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
                    <select value={source.sourceType} onChange={(event) => updateSourceDraft(index, { sourceType: event.target.value as SourceDraft["sourceType"] })}>
                      <option value="official-fallback">Official / fallback</option>
                      <option value="distributor">Distributor</option>
                    </select>
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
                </div>
              </div>
            ))}
            {manufacturerDraft.fallbackSources.length === 0 && (
              <div className="empty-config">
                Add at least one direct URL template for custom manufacturers. Without a template, the scraper has nowhere deterministic to go.
              </div>
            )}
          </div>
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
  return <span className={`badge run-${status}`}>{status}</span>;
}

function ItemBadge({ status }: { status: RunItemRecord["status"] }) {
  const icon = status === "found" ? <CheckCircle2 size={14} /> : status === "processing" ? <Loader2 className="spin" size={14} /> : null;
  return <span className={`item-badge item-${status}`}>{icon}{status}</span>;
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

function buildCoverage(items: RunItemRecord[]) {
  const parsedItems = items.filter((item) => item.result);
  const total = parsedItems.length;
  return REQUIRED_COVERAGE_FIELDS.map((field) => {
    const count = parsedItems.filter((item) => hasCoverageValue(item, field.key)).length;
    return {
      ...field,
      count,
      total,
      percent: total ? Math.round((count / total) * 100) : 0
    };
  });
}

function hasCoverageValue(item: RunItemRecord, key: CoverageKey): boolean {
  const result = item.result;
  if (!result) return false;
  switch (key) {
    case "enUrl":
      return Boolean(result.localizedUrls?.en || result.productUrl);
    case "deUrl":
      return Boolean(result.localizedUrls?.de);
    case "weight":
      return Boolean(result.normalized.weight);
    case "certificates":
      return Boolean(result.normalized.certificates);
    case "dimensions":
      return Boolean(result.normalized.dimensions);
    case "material":
      return Boolean(result.normalized.material);
  }
}

function emptyManufacturerDraft(): ManufacturerDraft {
  return {
    id: "",
    canonicalName: "",
    shortName: "",
    rateLimitMs: "1500",
    officialBaseUrlsText: "",
    fallbackSources: [emptySourceDraft(1)]
  };
}

function emptySourceDraft(index: number): SourceDraft {
  return {
    id: `source-${index}`,
    label: `Source ${index}`,
    enabled: true,
    sourceType: "official-fallback",
    directUrlTemplatesText: ""
  };
}

function toManufacturerDraft(config: ManufacturerConfig): ManufacturerDraft {
  return {
    id: config.id,
    canonicalName: config.canonicalName,
    shortName: config.shortName,
    rateLimitMs: String(config.rateLimitMs),
    officialBaseUrlsText: config.officialBaseUrls.join("\n"),
    fallbackSources: config.fallbackSources.length
      ? config.fallbackSources.map((source) => ({
          id: source.id,
          label: source.label,
          enabled: source.enabled,
          sourceType: source.sourceType,
          directUrlTemplatesText: source.directUrlTemplates.join("\n")
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

  return {
    id,
    canonicalName,
    shortName,
    rateLimitMs: Number(draft.rateLimitMs || 1500),
    officialBaseUrls: splitLines(draft.officialBaseUrlsText),
    fallbackSources: draft.fallbackSources
      .map((source, index) => ({
        id: slugify(source.id || source.label || `source-${index + 1}`),
        label: source.label.trim() || `Source ${index + 1}`,
        enabled: source.enabled,
        sourceType: source.sourceType,
        directUrlTemplates: splitLines(source.directUrlTemplatesText)
      }))
      .filter((source) => source.id && source.label && source.directUrlTemplates.length > 0)
  };
}

function splitLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
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
