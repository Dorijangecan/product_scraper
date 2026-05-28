import type { ManufacturerConfig, RunItemRecord } from "../../shared/types.js";
import { classifyDeviceType } from "../scrapers/device-type.js";
import { deviceSheetsFor } from "./device-sheet-map.js";
import { maxUnitNumber, splitTemperatureRange } from "./unit-cleanup.js";

export interface PdtRepair {
  catalogNumber: string;
  eclassCode?: string;
  eclassSystemVersion?: string;
  controlVoltage?: string;
  voltageMax?: string;
  ratedCurrent?: string;
  currentMax?: string;
  powerLossPerPole?: string;
  voltageType?: "AC" | "AC/DC" | "DC";
  operatingTemperatureMin?: string;
  operatingTemperatureMax?: string;
  shortDescription?: string;
  longDescription?: string;
}

export interface PdtCleanupProductAudit {
  catalogNumber: string;
  sourceValues: PdtCleanupSourceValues;
  heuristicFields: string[];
  qwenFields: string[];
  acceptedFields: string[];
  rejectedFields: string[];
  notes: string[];
  finalValues: Partial<Omit<PdtRepair, "catalogNumber">>;
  /** Classified device type for the product (undefined when classifier has no confident match). */
  deviceType?: string;
  /** Classifier confidence (0..1) — values below 0.78 indicate the row needs human review. */
  deviceTypeConfidence?: number;
  /** Short text describing what evidence drove the classification ("Title: …", "Product Type: …"). */
  deviceTypeEvidence?: string;
  /** Device-specific PDT tab(s) the product will be written to (empty when nothing fit). */
  deviceTabs: string[];
  /** Next-best candidate device types (up to 2), with score and channels that voted for them. */
  deviceTypeAlternatives?: Array<{ type: string; score: number; channels: string[] }>;
  /** Difference in score between winner and runner-up — small margin means classifier was unsure. */
  deviceTypeScoreMargin?: number;
  /** Sanity-check warnings ("classified Contactor but no pole number found"). */
  deviceTypeWarnings?: string[];
}

export interface PdtCleanupSourceValues {
  title?: string;
  catalogDescription?: string;
  longDescription?: string;
  normalizedVoltage?: string;
  normalizedCurrent?: string;
  eclass?: string;
  ratedControlCircuitVoltage?: string;
  ratedOperationalCurrentAc1?: string;
  powerLoss?: string;
  operatingTemperature?: string;
  ambientTemperature?: string;
  temperatureRange?: string;
}

export interface PdtCleanupAudit {
  status: "disabled" | "qwen_unavailable" | "qwen_no_valid_output" | "qwen_reviewed" | "qwen_applied";
  host: string;
  model: string;
  itemCount: number;
  qwenPatchCount: number;
  acceptedFieldCount: number;
  rejectedFieldCount: number;
  message: string;
  products: PdtCleanupProductAudit[];
}

export interface PdtRepairResult {
  repairs: Map<number, PdtRepair>;
  audit: PdtCleanupAudit;
}

export interface PdtRepairOptions {
  /** Run local Ollama/Qwen cleanup and include accepted suggestions in the returned repair map. */
  aiCleanup?: boolean;
  onProgress?: (progress: PdtCleanupProgress) => void | Promise<void>;
}

type PdtRepairPatch = Partial<PdtRepair> & { catalogNumber?: string };

export interface PdtCleanupProgress {
  stage: "disabled" | "health-check" | "unavailable" | "qwen-batch" | "reviewing" | "done";
  message: string;
  batchIndex?: number;
  batchCount?: number;
  itemCount: number;
  model?: string;
}

const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "qwen3:4b";
const DEFAULT_OLLAMA_HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_OLLAMA_GENERATE_TIMEOUT_MS = 180000;
const DEFAULT_QWEN_BATCH_SIZE = 4;
const REPAIR_FIELDS = [
  "eclassCode",
  "eclassSystemVersion",
  "controlVoltage",
  "voltageMax",
  "ratedCurrent",
  "currentMax",
  "powerLossPerPole",
  "voltageType",
  "operatingTemperatureMin",
  "operatingTemperatureMax",
  "shortDescription",
  "longDescription"
] as const satisfies ReadonlyArray<keyof Omit<PdtRepair, "catalogNumber">>;

export async function buildPdtRepairMap(
  items: RunItemRecord[],
  manufacturer: ManufacturerConfig,
  options: PdtRepairOptions = {}
): Promise<Map<number, PdtRepair>> {
  return (await buildPdtRepairResult(items, manufacturer, options)).repairs;
}

export async function buildPdtRepairResult(
  items: RunItemRecord[],
  manufacturer: ManufacturerConfig,
  options: PdtRepairOptions = {}
): Promise<PdtRepairResult> {
  const repairs = new Map<number, PdtRepair>();
  const auditProducts = new Map<number, PdtCleanupProductAudit>();
  for (const item of items) {
    const repair = heuristicRepair(item, manufacturer);
    repairs.set(item.id, repair);
    const classification = classifyDeviceType(item.result);
    const deviceTabs = deviceSheetsFor(classification.type);
    auditProducts.set(item.id, {
      catalogNumber: item.catalogNumber,
      sourceValues: sourceValues(item),
      heuristicFields: presentRepairFields(repair),
      qwenFields: [],
      acceptedFields: [],
      rejectedFields: [],
      notes: repairNotes(item, repair, classification, deviceTabs),
      finalValues: repairValues(repair),
      deviceType: classification.type,
      deviceTypeConfidence: classification.confidence,
      deviceTypeEvidence: classification.evidence,
      deviceTabs,
      deviceTypeAlternatives: classification.alternatives,
      deviceTypeScoreMargin: classification.scoreMargin,
      deviceTypeWarnings: classification.warnings
    });
  }

  const model = process.env.PDT_AI_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
  const host = (process.env.OLLAMA_HOST?.trim() || DEFAULT_OLLAMA_HOST).replace(/\/+$/, "");
  const healthTimeoutMs = envTimeoutMs("PDT_AI_HEALTH_TIMEOUT_MS", DEFAULT_OLLAMA_HEALTH_TIMEOUT_MS);
  const generateTimeoutMs = envTimeoutMs("PDT_AI_GENERATE_TIMEOUT_MS", DEFAULT_OLLAMA_GENERATE_TIMEOUT_MS);
  const batchSize = envNumber("PDT_AI_BATCH_SIZE", DEFAULT_QWEN_BATCH_SIZE, 1, 8);
  const aiCleanupEnabled =
    options.aiCleanup !== false &&
    !((process.env.VITEST && process.env.PDT_AI_CLEANUP !== "1") || process.env.PDT_AI_CLEANUP === "0");
  if (!aiCleanupEnabled) {
    await options.onProgress?.({
      stage: "disabled",
      message: "AI cleanup disabled; using deterministic scraped-data cleanup.",
      itemCount: items.length,
      model
    });
    return {
      repairs,
      audit: cleanupAudit(
        "disabled",
        host,
        model,
        items.length,
        0,
        auditProducts,
        "Qwen cleanup disabled; deterministic scraped-data cleanup was used."
      )
    };
  }

  await options.onProgress?.({
    stage: "health-check",
    message: `Checking local Qwen model ${model}.`,
    itemCount: items.length,
    model
  });
  const modelCheck = await hasOllamaModel(host, model, healthTimeoutMs);
  if (!modelCheck.available) {
    await options.onProgress?.({
      stage: "unavailable",
      message: modelCheck.message ?? "Qwen/Ollama was not reachable; using deterministic scraped-data cleanup.",
      itemCount: items.length,
      model
    });
    return {
      repairs,
      audit: cleanupAudit(
        "qwen_unavailable",
        host,
        model,
        items.length,
        0,
        auditProducts,
        modelCheck.message ?? "Qwen/Ollama was not reachable; deterministic scraped-data cleanup was used."
      )
    };
  }

  let patchCount = 0;
  const errors: string[] = [];
  const batches = chunks(items, batchSize);
  for (const [index, chunk] of batches.entries()) {
    await options.onProgress?.({
      stage: "qwen-batch",
      message: `Qwen cleanup batch ${index + 1}/${batches.length} (${chunk.length} products).`,
      batchIndex: index + 1,
      batchCount: batches.length,
      itemCount: items.length,
      model
    });
    const { patches, error } = await qwenRepairBatch(host, model, manufacturer, chunk, generateTimeoutMs);
    if (error) errors.push(error);
    patchCount += patches.length;
    for (const patch of patches) {
      const item = chunk.find((candidate) => candidate.catalogNumber === patch.catalogNumber);
      if (!item) continue;
      const before = repairs.get(item.id) ?? heuristicRepair(item, manufacturer);
      const merged = mergeRepair(before, patch, item, manufacturer);
      repairs.set(item.id, merged);
      const productAudit = auditProducts.get(item.id);
      if (productAudit) {
        recordPatchAudit(productAudit, before, merged, patch);
        productAudit.notes = repairNotes(
          item,
          merged,
          { type: productAudit.deviceType, confidence: productAudit.deviceTypeConfidence, evidence: productAudit.deviceTypeEvidence },
          productAudit.deviceTabs
        );
        productAudit.finalValues = repairValues(merged);
      }
    }
  }

  await options.onProgress?.({
    stage: "reviewing",
    message: "Reviewing Qwen suggestions against scraped evidence.",
    batchCount: batches.length,
    itemCount: items.length,
    model
  });
  const acceptedCount = [...auditProducts.values()].reduce((sum, entry) => sum + entry.acceptedFields.length, 0);
  const status = acceptedCount > 0 ? "qwen_applied" : patchCount === 0 && errors.length === 0 ? "qwen_reviewed" : "qwen_no_valid_output";
  await options.onProgress?.({
    stage: "done",
    message:
      status === "qwen_applied"
        ? "Qwen cleanup complete; accepted source-backed fields."
        : status === "qwen_reviewed"
          ? "Qwen review complete; deterministic values kept."
          : "Qwen cleanup complete; no evidence-backed changes accepted.",
    batchCount: batches.length,
    itemCount: items.length,
    model
  });
  return {
    repairs,
    audit: cleanupAudit(
      status,
      host,
      model,
      items.length,
      patchCount,
      auditProducts,
      status === "qwen_applied"
        ? "Qwen prepared the scraped Excel sheet; only source-backed fields were accepted."
        : status === "qwen_reviewed"
          ? "Qwen reviewed the scraped input; deterministic prepared values were kept."
          : `Qwen responded but no evidence-backed changes were accepted; deterministic scraped-data cleanup was used.${errors.length ? ` Errors: ${errors.join("; ")}` : ""}`
    )
  };
}

function heuristicRepair(item: RunItemRecord, manufacturer: ManufacturerConfig): PdtRepair {
  const result = item.result;
  return sanitizeRepair({
    catalogNumber: item.catalogNumber,
    eclassCode: eclassCode(item),
    eclassSystemVersion: manufacturer.id === "abb" || result?.manufacturerId === "abb" ? "14" : undefined,
    controlVoltage: controlVoltageRange(item),
    voltageMax: voltageMaxValue(item),
    ratedCurrent: firstAmpereValue(attr(item, /\brated operational current AC-1\b/i)),
    currentMax: currentMaxValue(item),
    powerLossPerPole: numberWithUnit(attr(item, /\bpower loss\b/i), "W"),
    voltageType: controlVoltageType(item),
    operatingTemperatureMin: explicitTemperatureRange(item).min,
    operatingTemperatureMax: explicitTemperatureRange(item).max,
    shortDescription: normalizedShortDescription(item),
    longDescription: normalizedLongDescription(item)
  });
}

async function qwenRepairBatch(
  host: string,
  model: string,
  manufacturer: ManufacturerConfig,
  items: RunItemRecord[],
  timeoutMs: number
): Promise<{ patches: PdtRepairPatch[]; error?: string }> {
  try {
    const data = (await fetchJson(
      `${host}/api/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          think: false,
          options: { temperature: 0, num_predict: Math.max(768, Math.min(2048, items.length * 512)) },
          prompt: repairPrompt(manufacturer, items)
        })
      },
      timeoutMs
    )) as { response?: string };
    const parsed = JSON.parse(extractJson(data.response ?? "{}")) as { products?: PdtRepairPatch[] };
    const patches = Array.isArray(parsed.products) ? parsed.products.filter(isUsableRepairPatch) : [];
    return { patches };
  } catch (error) {
    return { patches: [], error: error instanceof Error ? error.message : "Qwen batch failed." };
  }
}

async function hasOllamaModel(host: string, model: string, timeoutMs: number): Promise<{ available: boolean; message?: string }> {
  try {
    const data = (await fetchJson(`${host}/api/tags`, undefined, timeoutMs)) as { models?: Array<{ name?: string; model?: string }> };
    const found = Boolean(data.models?.some((entry) => entry.name === model || entry.model === model));
    return found
      ? { available: true }
      : { available: false, message: `Ollama responded, but model ${model} was not listed.` };
  } catch (error) {
    return {
      available: false,
      message: `Ollama/Qwen unavailable at ${host}: ${error instanceof Error ? error.message : "request failed"}.`
    };
  }
}

function cleanupAudit(
  status: PdtCleanupAudit["status"],
  host: string,
  model: string,
  itemCount: number,
  qwenPatchCount: number,
  products: Map<number, PdtCleanupProductAudit>,
  message: string
): PdtCleanupAudit {
  const productRows = [...products.values()];
  return {
    status,
    host,
    model,
    itemCount,
    qwenPatchCount,
    acceptedFieldCount: productRows.reduce((sum, entry) => sum + entry.acceptedFields.length, 0),
    rejectedFieldCount: productRows.reduce((sum, entry) => sum + entry.rejectedFields.length, 0),
    message,
    products: productRows
  };
}

function presentRepairFields(repair: PdtRepair): string[] {
  return REPAIR_FIELDS.filter((field) => repair[field] !== undefined && repair[field] !== "");
}

function repairValues(repair: PdtRepair): Partial<Omit<PdtRepair, "catalogNumber">> {
  return {
    eclassCode: repair.eclassCode,
    eclassSystemVersion: repair.eclassSystemVersion,
    controlVoltage: repair.controlVoltage,
    voltageMax: repair.voltageMax,
    ratedCurrent: repair.ratedCurrent,
    currentMax: repair.currentMax,
    powerLossPerPole: repair.powerLossPerPole,
    voltageType: repair.voltageType,
    operatingTemperatureMin: repair.operatingTemperatureMin,
    operatingTemperatureMax: repair.operatingTemperatureMax,
    shortDescription: repair.shortDescription,
    longDescription: repair.longDescription
  };
}

function sourceValues(item: RunItemRecord): PdtCleanupSourceValues {
  return {
    title: item.result?.title,
    catalogDescription: attr(item, /\bcatalog description\b/i),
    longDescription: attr(item, /\blong description\b/i) ?? item.result?.description,
    normalizedVoltage: item.result?.normalized.voltage,
    normalizedCurrent: item.result?.normalized.current,
    eclass: attr(item, /\beclass\b/i),
    ratedControlCircuitVoltage: attr(item, /\brated control circuit voltage\b/i),
    ratedOperationalCurrentAc1: attr(item, /\brated operational current AC-1\b/i),
    powerLoss: attr(item, /\bpower loss\b/i),
    operatingTemperature: attr(item, /\boperating temperature\b/i),
    ambientTemperature: attr(item, /\bambient temperature\b/i) ?? attr(item, /\bamb(?:ient)?\s+air\s+tem(?:p(?:erature)?)?\b/i),
    temperatureRange: attr(item, /\btemperature range\b/i)
  };
}

function repairNotes(
  item: RunItemRecord,
  repair: PdtRepair,
  classification?: { type?: string; confidence?: number; evidence?: string },
  deviceTabs?: string[]
): string[] {
  const notes: string[] = [];
  if (!repair.operatingTemperatureMin && !repair.operatingTemperatureMax) {
    const currentDerating = attr(item, /\brated operational current AC-1\b/i);
    if (currentDerating && /[\u00b0\u00c2]|\b[4-9]\d\s*C\b/i.test(currentDerating)) {
      notes.push("Temperature left blank: source only has current derating temperatures, not operating/ambient temperature.");
    }
  }
  if (repair.shortDescription) notes.push("Short description normalized from catalog/title evidence.");
  if (repair.longDescription) notes.push("Long description normalized from vendor evidence.");
  if (classification) {
    if (!classification.type) {
      notes.push("Device type could not be classified \u2014 only Material Master Data + Additional Documents will be filled.");
    } else if ((classification.confidence ?? 0) < 0.78) {
      notes.push(
        `Device type "${classification.type}" classified with low confidence (${((classification.confidence ?? 0) * 100).toFixed(0)}%) \u2014 please verify.`
      );
    }
    if (classification.type && (!deviceTabs || deviceTabs.length === 0)) {
      notes.push(
        `Device type "${classification.type}" has no Master PDT device tab mapping \u2014 only the constant tabs will be filled.`
      );
    }
  }
  return notes;
}

function recordPatchAudit(
  audit: PdtCleanupProductAudit,
  before: PdtRepair,
  after: PdtRepair,
  patch: PdtRepairPatch
): void {
  const candidate = sanitizeRepair({ ...patch, catalogNumber: before.catalogNumber });
  for (const field of REPAIR_FIELDS) {
    if (candidate[field] === undefined || candidate[field] === "") continue;
    pushUnique(audit.qwenFields, field);
    if (after[field] === candidate[field]) {
      pushUnique(audit.acceptedFields, field);
    } else {
      pushUnique(audit.rejectedFields, field);
    }
  }
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function repairPrompt(manufacturer: ManufacturerConfig, items: RunItemRecord[]): string {
  return [
    "You prepare scraped electrical product data for a human-reviewed Excel cleanup sheet.",
    "Return JSON only: {\"products\":[...]}",
    "Return one product object per input product.",
    "For each product return only fields that are explicit in the scraped input or directly cleaned from scraped text.",
    "Fields: catalogNumber, eclassCode, eclassSystemVersion, controlVoltage, voltageMax, ratedCurrent, currentMax, powerLossPerPole, voltageType, operatingTemperatureMin, operatingTemperatureMax, shortDescription, longDescription.",
    "Do not include scraped, deterministicCleanup, notes, explanations, markdown, or nested objects in the output.",
    "Rules:",
    "- controlVoltage must be a cleaned voltage range like 24-60 from Rated Control Circuit Voltage or catalog description. Never use values from current derating text such as 40 C 70 A.",
    "- voltageMax is the highest voltage value from an explicit voltage/range, as a plain number. Example: 60-80 V -> 80.",
    "- ratedCurrent is the first ampere value from Rated Operational Current AC-1, as a plain number.",
    "- currentMax is the highest ampere value from an explicit current/range, as a plain number. Example: 6-10 A -> 10.",
    "- powerLossPerPole is the AC-1 per pole W value, as a plain number.",
    "- voltageType is AC, DC, or AC/DC.",
    "- operating temperatures are only from explicit operating/ambient temperature range fields. Do not use temperatures embedded in rated-current rows.",
    "- operatingTemperatureMin and operatingTemperatureMax are plain numbers. Example: 40 to 120 C -> 40 and 120.",
    "- eclassSystemVersion for ABB PDT device tabs is usually 14 when the ECLASS code is present.",
    "- shortDescription is a concise cleaned product description from title/catalog description.",
    "- longDescription is the best cleaned vendor description; if no longer text exists, use the cleaned catalog description.",
    "- Use deterministicCleanup values when they are already correct.",
    `Manufacturer: ${manufacturer.canonicalName}`,
    JSON.stringify({
      products: items.map((item) => ({
        catalogNumber: item.catalogNumber,
        scraped: compactSourceValues(item),
        deterministicCleanup: qwenBaselineValues(heuristicRepair(item, manufacturer))
      }))
    })
  ].join("\n");
}

function isUsableRepairPatch(patch: PdtRepairPatch): boolean {
  return typeof patch.catalogNumber === "string" && REPAIR_FIELDS.some((field) => patch[field] !== undefined && patch[field] !== "");
}

function qwenBaselineValues(repair: PdtRepair): Partial<Omit<PdtRepair, "catalogNumber">> {
  return {
    eclassCode: repair.eclassCode,
    eclassSystemVersion: repair.eclassSystemVersion,
    controlVoltage: repair.controlVoltage,
    voltageMax: repair.voltageMax,
    ratedCurrent: repair.ratedCurrent,
    currentMax: repair.currentMax,
    powerLossPerPole: repair.powerLossPerPole,
    voltageType: repair.voltageType,
    operatingTemperatureMin: repair.operatingTemperatureMin,
    operatingTemperatureMax: repair.operatingTemperatureMax,
    shortDescription: repair.shortDescription,
    longDescription: repair.longDescription
  };
}

function compactSourceValues(item: RunItemRecord): PdtCleanupSourceValues {
  const source = sourceValues(item);
  return {
    title: limitText(source.title, 140),
    catalogDescription: limitText(source.catalogDescription, 260),
    longDescription: limitText(source.longDescription, 500),
    normalizedVoltage: limitText(source.normalizedVoltage, 220),
    normalizedCurrent: limitText(source.normalizedCurrent, 220),
    eclass: limitText(source.eclass, 80),
    ratedControlCircuitVoltage: limitText(source.ratedControlCircuitVoltage, 220),
    ratedOperationalCurrentAc1: limitText(source.ratedOperationalCurrentAc1, 220),
    powerLoss: limitText(source.powerLoss, 160),
    operatingTemperature: limitText(source.operatingTemperature, 120),
    ambientTemperature: limitText(source.ambientTemperature, 120),
    temperatureRange: limitText(source.temperatureRange, 120)
  };
}

function limitText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}...` : value;
}

function mergeRepair(base: PdtRepair, patch: PdtRepairPatch, item: RunItemRecord, manufacturer: ManufacturerConfig): PdtRepair {
  const candidate = sanitizeRepair({ ...patch, catalogNumber: base.catalogNumber });
  return {
    ...base,
    eclassCode: acceptsEclassCode(item, candidate.eclassCode) ? candidate.eclassCode : base.eclassCode,
    eclassSystemVersion: acceptsEclassSystemVersion(item, manufacturer, candidate.eclassSystemVersion)
      ? candidate.eclassSystemVersion
      : base.eclassSystemVersion,
    controlVoltage: acceptsControlVoltage(item, candidate.controlVoltage) ? candidate.controlVoltage : base.controlVoltage,
    voltageMax: acceptsVoltageMax(item, candidate.voltageMax) ? candidate.voltageMax : base.voltageMax,
    ratedCurrent: acceptsRatedCurrent(item, candidate.ratedCurrent) ? candidate.ratedCurrent : base.ratedCurrent,
    currentMax: acceptsCurrentMax(item, candidate.currentMax) ? candidate.currentMax : base.currentMax,
    powerLossPerPole: acceptsPowerLoss(item, candidate.powerLossPerPole) ? candidate.powerLossPerPole : base.powerLossPerPole,
    voltageType: acceptsVoltageType(item, candidate.voltageType) ? candidate.voltageType : base.voltageType,
    operatingTemperatureMin: acceptsTemperature(item, candidate.operatingTemperatureMin, "min")
      ? candidate.operatingTemperatureMin
      : base.operatingTemperatureMin,
    operatingTemperatureMax: acceptsTemperature(item, candidate.operatingTemperatureMax, "max")
      ? candidate.operatingTemperatureMax
      : base.operatingTemperatureMax,
    shortDescription: acceptsDescription(item, candidate.shortDescription) ? candidate.shortDescription : base.shortDescription,
    longDescription: acceptsDescription(item, candidate.longDescription) ? candidate.longDescription : base.longDescription
  };
}

function sanitizeRepair(input: PdtRepairPatch & { catalogNumber: string }): PdtRepair {
  const repair: PdtRepair = { catalogNumber: input.catalogNumber };
  repair.eclassCode = cleanCode(input.eclassCode);
  repair.eclassSystemVersion = cleanNumber(input.eclassSystemVersion);
  repair.controlVoltage = cleanVoltageRange(input.controlVoltage);
  repair.voltageMax = cleanNumber(input.voltageMax);
  repair.ratedCurrent = cleanNumber(input.ratedCurrent);
  repair.currentMax = cleanNumber(input.currentMax);
  repair.powerLossPerPole = cleanNumber(input.powerLossPerPole);
  repair.voltageType = cleanVoltageType(input.voltageType);
  repair.operatingTemperatureMin = cleanNumber(input.operatingTemperatureMin);
  repair.operatingTemperatureMax = cleanNumber(input.operatingTemperatureMax);
  repair.shortDescription = cleanText(input.shortDescription, 220);
  repair.longDescription = cleanText(input.longDescription, 1200);
  return repair;
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function cleanNumber(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const match = value.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return match ? String(Number(match[0])) : undefined;
}

function cleanCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value !== "string") return undefined;
  return value.match(/\d{6,8}|\d{2}(?:[-.]?\d{2}){1,3}/)?.[0];
}

function cleanVoltageRange(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/[\u00b0\u00c2]|(?:\d\s*A\b)/i.test(value)) return undefined;
  const match = value.replace(",", ".").match(/(\d+(?:\.\d+)?)\s*(?:\.\.\.|\.{2}|-|to)\s*(\d+(?:\.\d+)?)/i);
  if (!match) return undefined;
  return `${Number(match[1])}-${Number(match[2])}`;
}

function cleanVoltageType(value: unknown): PdtRepair["voltageType"] {
  if (typeof value !== "string") return undefined;
  const normalized = value.toUpperCase().replace(/\s+/g, "");
  if (normalized === "AC/DC" || normalized === "ACDC") return "AC/DC";
  if (normalized === "AC") return "AC";
  if (normalized === "DC") return "DC";
  return undefined;
}

function attr(item: RunItemRecord, pattern: RegExp, rejectPattern?: RegExp): string | undefined {
  const matches = (item.result?.attributes ?? []).filter((attribute) =>
    pattern.test([attribute.group ?? "", attribute.name].join(" ")) &&
    (!rejectPattern || !rejectPattern.test([attribute.group ?? "", attribute.name, attribute.value].join(" "))) &&
    attribute.value?.trim()
  );
  matches.sort((left, right) => sourceRank(right.sourceType) - sourceRank(left.sourceType));
  return matches[0]?.value.replace(/\s+/g, " ").trim();
}

function sourceRank(sourceType: string | undefined): number {
  if (sourceType === "official") return 3;
  if (sourceType === "official-fallback") return 2;
  if (sourceType === "cache") return 1;
  if (sourceType === "distributor") return -1;
  return 0;
}

function eclassCode(item: RunItemRecord): string | undefined {
  return cleanCode(attr(item, /\beclass\b/i));
}

function controlVoltageRange(item: RunItemRecord): string | undefined {
  const value = attr(item, /\brated control circuit voltage\b/i) ?? attr(item, /\bcontrol voltage\b/i);
  const acPart = value?.split(";").find((part) => /\b(?:50|60)\s*hz\b/i.test(part)) ?? value;
  return cleanVoltageRange(acPart);
}

function voltageMaxValue(item: RunItemRecord): string | undefined {
  const candidates = [
    attr(item, /\brated control circuit voltage\b/i),
    attr(item, /\bcontrol voltage\b/i),
    attr(item, /\brated operational voltage\b/i),
    attr(item, /\boperating voltage\b/i),
    attr(item, /\brated voltage\b/i),
    item.result?.normalized.voltage,
    attr(item, /\bcatalog description\b/i),
    item.result?.title
  ].flatMap((value) => (value ? voltageNumberCandidates(value) : []));
  return maxNumericString(candidates);
}

function controlVoltageType(item: RunItemRecord): PdtRepair["voltageType"] {
  const value = attr(item, /\brated control circuit voltage\b/i) ?? attr(item, /\bcontrol voltage\b/i);
  if (!value) return undefined;
  if (/\bAC\s*(?:\/|-|\s)\s*DC\b/i.test(value)) return "AC/DC";
  const hasAc = /\b(?:50|60)\s*hz\b|\bAC\b/i.test(value);
  const hasDc = /\bDC\b/i.test(value);
  if (hasAc && hasDc) return undefined;
  if (hasAc) return "AC";
  if (hasDc) return "DC";
  return undefined;
}

function normalizedShortDescription(item: RunItemRecord): string | undefined {
  const raw = attr(item, /\bcatalog description\b/i) ?? item.result?.title;
  const text = cleanText(raw, 220);
  if (!text) return undefined;
  return normalizeElectricalDescription(text);
}

function normalizedLongDescription(item: RunItemRecord): string | undefined {
  return cleanText(attr(item, /\blong description\b/i) ?? item.result?.description, 1200);
}

function normalizeElectricalDescription(value: string): string {
  return value
    .replace(/\b(\d+)RT-(\d+)\s*V/gi, "$1-$2 V")
    .replace(/\b(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*V\s*50\s*\/\s*60\s*HZ\b/gi, "$1-$2 V 50/60 Hz")
    .replace(/\b(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*VDC\b/gi, "$1-$2 V DC")
    .replace(/\b(\d+(?:\.\d+)?)\s*VDC\b/gi, "$1 V DC")
    .replace(/\bHZ\b/g, "Hz")
    .replace(/\s*-\s*DC\b/gi, " DC")
    .replace(/\s+/g, " ")
    .trim();
}

function explicitTemperatureRange(item: RunItemRecord): { min?: string; max?: string } {
  const values = [
    attr(item, /\boperating\b.*\btemperature\b/i),
    attr(item, /\bambient\b.*\btemperature\b/i),
    attr(item, /\bsurrounding\b.*\btemperature\b/i),
    attr(item, /\bamb(?:ient)?\s+air\s+tem(?:p(?:erature)?)?\b/i),
    attr(item, /\btemperature range\b/i),
    attr(item, /\bservice temperature\b/i),
    attr(item, /\bstorage temperature\b/i, /\btemporary\b/i)
  ];
  for (const value of values) {
    const range = splitTemperatureRange(preferOperatingTemperatureSegment(value));
    if (range.min !== undefined || range.max !== undefined) return range;
  }
  return {};
}

function preferOperatingTemperatureSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const segments = value.split(";").map((segment) => segment.trim()).filter(Boolean);
  return (
    segments.find((segment) => /-?\d/.test(segment) && /\b(?:operat|ambient|amb\s+air|close to contactor|without thermal|fitted with thermal)\b/i.test(segment) && !/\bstorage\b/i.test(segment)) ??
    segments.find((segment) => /-?\d/.test(segment) && !/\bstorage\b/i.test(segment)) ??
    value
  );
}

function temperatureRangeFromText(value: string | undefined): { min?: string; max?: string } {
  if (!value || /\brated operational current\b/i.test(value)) return {};
  const normalized = value.replace(",", ".");
  const range = normalized.match(
    /(-?\d+(?:\.\d+)?)\s*(?:\.\.\.|\.{2}|-|to)\s*\+?(-?\d+(?:\.\d+)?)\s*(?:°?\s*C|℃|degrees?\s*C?)?\b/i
  );
  if (range) return { min: String(Number(range[1])), max: String(Number(range[2])) };
  const celsiusValues = [...normalized.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:°\s*)?C\b/gi)].map((match) => String(Number(match[1])));
  if (celsiusValues.length >= 2) return { min: celsiusValues[0], max: celsiusValues[celsiusValues.length - 1] };
  return {};
}

function firstAmpereValue(value: string | undefined): string | undefined {
  return cleanNumber(maxUnitNumber(value, "A"));
}

function currentMaxValue(item: RunItemRecord): string | undefined {
  const candidates = [
    attr(item, /\brated operational current AC-1\b/i),
    attr(item, /\brated current\b/i),
    attr(item, /\boperating current\b/i)
  ].flatMap((value) => (value ? currentNumberCandidates(value) : []));
  return maxNumericString(candidates);
}

function numberWithUnit(value: string | undefined, unit: string): string | undefined {
  return cleanNumber(value?.match(new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*${unit}\\b`, "i"))?.[1]);
}

function maxNumericString(values: string[]): string | undefined {
  const numbers = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!numbers.length) return undefined;
  return String(Math.max(...numbers));
}

function acceptsEclassCode(item: RunItemRecord, value: string | undefined): boolean {
  return Boolean(value && eclassCode(item) === value);
}

function acceptsEclassSystemVersion(item: RunItemRecord, manufacturer: ManufacturerConfig, value: string | undefined): boolean {
  if (!value) return false;
  if ((manufacturer.id === "abb" || item.result?.manufacturerId === "abb") && value === "14" && eclassCode(item)) return true;
  const evidence = attr(item, /\beclass\b/i);
  return Boolean(evidence && new RegExp(`\\b${escapeRegExp(value)}\\b`).test(evidence));
}

function acceptsControlVoltage(item: RunItemRecord, value: string | undefined): boolean {
  if (!value) return false;
  const evidence = [
    attr(item, /\brated control circuit voltage\b/i),
    attr(item, /\bcontrol voltage\b/i),
    attr(item, /\bcatalog description\b/i),
    attr(item, /\blong description\b/i),
    item.result?.description
  ];
  return evidence.some((entry) => entry && voltageRangeCandidates(entry).includes(value));
}

function acceptsVoltageMax(item: RunItemRecord, value: string | undefined): boolean {
  return Boolean(value && voltageMaxValue(item) === value);
}

function acceptsRatedCurrent(item: RunItemRecord, value: string | undefined): boolean {
  const evidence = attr(item, /\brated operational current AC-1\b/i);
  return Boolean(value && evidence && ampereCandidates(evidence).includes(value));
}

function acceptsCurrentMax(item: RunItemRecord, value: string | undefined): boolean {
  return Boolean(value && currentMaxValue(item) === value);
}

function acceptsPowerLoss(item: RunItemRecord, value: string | undefined): boolean {
  const evidence = attr(item, /\bpower loss\b/i);
  return Boolean(value && evidence && numberUnitCandidates(evidence, "W").includes(value));
}

function acceptsVoltageType(item: RunItemRecord, value: PdtRepair["voltageType"]): boolean {
  return Boolean(value && controlVoltageType(item) === value);
}

function acceptsTemperature(item: RunItemRecord, value: string | undefined, side: "min" | "max"): boolean {
  if (!value) return false;
  const range = explicitTemperatureRange(item);
  return side === "min" ? range.min === value : range.max === value;
}

function acceptsDescription(item: RunItemRecord, value: string | undefined): boolean {
  if (!value) return false;
  const evidence = [
    item.result?.title,
    item.result?.description,
    attr(item, /\bcatalog description\b/i),
    attr(item, /\blong description\b/i),
    attr(item, /\bextended product type\b/i)
  ].filter((entry): entry is string => Boolean(entry));
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) return false;
  return evidence.some((entry) => {
    const normalizedEntry = normalizeText(`${entry} ${normalizeElectricalDescription(entry)}`);
    if (!normalizedEntry) return false;
    if (normalizedEntry.includes(normalizedValue)) return true;
    const valueTokens = meaningfulTokens(normalizedValue);
    if (valueTokens.length < 3) return normalizedEntry === normalizedValue;
    const sourceTokens = new Set(meaningfulTokens(normalizedEntry));
    const covered = valueTokens.filter((token) => sourceTokens.has(token)).length;
    return covered / valueTokens.length >= 0.9;
  });
}

function voltageRangeCandidates(value: string): string[] {
  if (/[\u00b0\u00c2]/.test(value)) return [];
  return [...value.replace(",", ".").matchAll(/(\d+(?:\.\d+)?)\s*(?:\.\.\.|\.{2}|-|to)\s*(\d+(?:\.\d+)?)\s*V?\b/gi)].map(
    (match) => `${Number(match[1])}-${Number(match[2])}`
  );
}

function voltageNumberCandidates(value: string): string[] {
  if (/(?:\d\s*A\b)|[\u00b0\u00c2]/i.test(value)) return [];
  const normalized = value.replace(/\b(\d+(?:\.\d+)?)RT-(\d+(?:\.\d+)?)\s*V/gi, "$1-$2 V");
  const maxVoltage = maxUnitNumber(normalized, "V");
  return maxVoltage ? [maxVoltage] : [];
}

function ampereCandidates(value: string): string[] {
  const maxCurrent = maxUnitNumber(value, "A");
  return maxCurrent ? [maxCurrent] : [];
}

function currentNumberCandidates(value: string): string[] {
  return ampereCandidates(value);
}

function numberUnitCandidates(value: string, unit: string): string[] {
  const normalized = maxUnitNumber(value, unit);
  return normalized ? [normalized] : [];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function meaningfulTokens(value: string): string[] {
  return value.split(/\s+/).filter((token) => token.length > 2 || /\d/.test(token));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function envTimeoutMs(name: string, fallback: number): number {
  return envNumber(name, fallback, 1, Number.MAX_SAFE_INTEGER);
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? Math.min(max, value) : fallback;
}

async function fetchJson(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}
