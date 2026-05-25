import fs from "node:fs/promises";
import path from "node:path";
import type { ManufacturerConfig, RunRecord } from "../shared/types.js";

export interface RunOutputLayout {
  manufacturerDir: string;
  inputDir: string;
  runDir: string;
  excelDir: string;
  documentsDir: string;
  imagesDir: string;
  logsDir: string;
  logPath: string;
  debugJsonPath: string;
}

type RunLayoutInput = Pick<RunRecord, "id" | "createdAt" | "inputFileName" | "outputPath"> | string;

export function buildRunOutputLayout(outputRoot: string, manufacturer: ManufacturerConfig, runInput: RunLayoutInput): RunOutputLayout {
  const manufacturerDir = path.join(outputRoot, safeOutputPart(manufacturer.shortName));
  const inputDir = typeof runInput === "string"
    ? manufacturerDir
    : path.join(manufacturerDir, safeOutputPart(inputFolderName(runInput), "manual-input", 96));
  const runDir = typeof runInput === "string"
    ? path.join(inputDir, safeOutputPart(runInput))
    : path.join(inputDir, safeOutputPart(runFolderName(runInput), safeOutputPart(runInput.id), 120));
  const excelDir = path.join(runDir, "excel");
  const documentsDir = path.join(runDir, "documents");
  const imagesDir = path.join(runDir, "images");
  const logsDir = path.join(runDir, "logs");
  return {
    manufacturerDir,
    inputDir,
    runDir,
    excelDir,
    documentsDir,
    imagesDir,
    logsDir,
    logPath: path.join(logsDir, "run-log.txt"),
    debugJsonPath: path.join(logsDir, "run-debug.json")
  };
}

export async function ensureRunOutputLayout(layout: RunOutputLayout) {
  await Promise.all([
    fs.mkdir(layout.excelDir, { recursive: true }),
    fs.mkdir(layout.documentsDir, { recursive: true }),
    fs.mkdir(layout.imagesDir, { recursive: true }),
    fs.mkdir(layout.logsDir, { recursive: true })
  ]);
}

export function getAllowedRunOutputRoots(outputRoot: string, manufacturer: ManufacturerConfig, runInput: RunLayoutInput): string[] {
  const layout = buildRunOutputLayout(outputRoot, manufacturer, runInput);
  const runId = typeof runInput === "string" ? runInput : runInput.id;
  const outputPathRoot = typeof runInput === "string" ? undefined : runRootFromOutputPath(runInput.outputPath);
  return [
    layout.runDir,
    path.join(outputRoot, safeOutputPart(manufacturer.shortName), safeOutputPart(runId)),
    path.join(outputRoot, safeOutputPart(runId)),
    outputPathRoot
  ]
    .filter(Boolean)
    .map((dir) => path.resolve(dir as string));
}

export function isPathInsideAny(candidatePath: string, roots: string[]): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  return roots.some((root) => isPathInsideRoot(resolvedCandidate, root));
}

export function findRunLogPath(outputRoot: string, manufacturer: ManufacturerConfig, run: RunRecord): string | undefined {
  const layout = buildRunOutputLayout(outputRoot, manufacturer, run);
  const outputPathRoot = runRootFromOutputPath(run.outputPath);
  const candidates = [
    layout.logPath,
    path.join(outputRoot, safeOutputPart(manufacturer.shortName), safeOutputPart(run.id), "logs", "run-log.txt"),
    path.join(outputRoot, safeOutputPart(run.id), "logs", "run-log.txt"),
    outputPathRoot ? path.join(outputPathRoot, "logs", "run-log.txt") : undefined
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => isPathInsideAny(candidate, getAllowedRunOutputRoots(outputRoot, manufacturer, run)));
}

export function runRootFromOutputPath(outputPath: string | undefined): string | undefined {
  if (!outputPath) return undefined;
  const parent = path.dirname(outputPath);
  return path.basename(parent).toLowerCase() === "excel" ? path.dirname(parent) : parent;
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function inputFolderName(run: Pick<RunRecord, "inputFileName">): string {
  const inputFileName = run.inputFileName?.trim();
  return inputFileName ? path.basename(inputFileName) : "manual-input";
}

function runFolderName(run: Pick<RunRecord, "id" | "createdAt">): string {
  return `${datePart(run.createdAt)}_${run.id}`;
}

function datePart(value: string): string {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    const parts = [
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds()
    ].map((part) => String(part).padStart(2, "0"));
    return `${parts[0]}-${parts[1]}-${parts[2]}_${parts[3]}-${parts[4]}-${parts[5]}`;
  }
  const runIdStamp = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)?.slice(1);
  if (runIdStamp?.length === 6) {
    return `${runIdStamp[0]}-${runIdStamp[1]}-${runIdStamp[2]}_${runIdStamp[3]}-${runIdStamp[4]}-${runIdStamp[5]}`;
  }
  return "undated";
}

function safeOutputPart(value: string, fallback = "unknown", maxLength = 80): string {
  return (
    value
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLength)
      .replace(/[.\s-]+$/g, "") || fallback
  );
}
