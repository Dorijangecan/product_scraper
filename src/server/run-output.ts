import fs from "node:fs/promises";
import path from "node:path";
import type { ManufacturerConfig, RunRecord } from "../shared/types.js";

export interface RunOutputLayout {
  manufacturerDir: string;
  runDir: string;
  excelDir: string;
  documentsDir: string;
  imagesDir: string;
  logsDir: string;
  logPath: string;
  debugJsonPath: string;
}

export function buildRunOutputLayout(outputRoot: string, manufacturer: ManufacturerConfig, runId: string): RunOutputLayout {
  const manufacturerDir = path.join(outputRoot, safeOutputPart(manufacturer.shortName));
  const runDir = path.join(manufacturerDir, runId);
  const excelDir = path.join(runDir, "excel");
  const documentsDir = path.join(runDir, "documents");
  const imagesDir = path.join(runDir, "images");
  const logsDir = path.join(runDir, "logs");
  return {
    manufacturerDir,
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

export function getAllowedRunOutputRoots(outputRoot: string, manufacturer: ManufacturerConfig, runId: string): string[] {
  const layout = buildRunOutputLayout(outputRoot, manufacturer, runId);
  return [layout.runDir, path.join(outputRoot, runId)].map((dir) => path.resolve(dir));
}

export function isPathInsideAny(candidatePath: string, roots: string[]): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  return roots.some((root) => isPathInsideRoot(resolvedCandidate, root));
}

export function findRunLogPath(outputRoot: string, manufacturer: ManufacturerConfig, run: RunRecord): string | undefined {
  const layout = buildRunOutputLayout(outputRoot, manufacturer, run.id);
  const candidates = [
    layout.logPath,
    path.join(outputRoot, run.id, "logs", "run-log.txt"),
    run.outputPath ? path.join(path.dirname(path.dirname(run.outputPath)), "logs", "run-log.txt") : undefined
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => isPathInsideAny(candidate, getAllowedRunOutputRoots(outputRoot, manufacturer, run.id)));
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeOutputPart(value: string): string {
  return (
    value
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}
