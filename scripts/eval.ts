/**
 * Offline extraction eval — CLI.  `npm run eval`
 *
 * Runs the REAL extractors (`parseGenericProductPage`, `enrichResultFromDownloadedDocuments`) over
 * recorded fixtures and compares the output at value level. No network, no live vendor sites, so it
 * can run in CI and on a plane — unlike `npm run benchmark`, which needs 14 live sites and only
 * asserts that a field is truthy.
 *
 * Deliberately calls the same functions `run-manager.ts` calls, in the same order (page parse →
 * document enrichment). Per the document-enrichment memory: verify with the real function, never a
 * hand-rolled simulation — a simulation drifts and then certifies bugs as fixed.
 *
 * Usage:
 *   npx tsx scripts/eval.ts                      # run every fixture
 *   npx tsx scripts/eval.ts --case eaton-cbe      # substring filter on case id
 *   npx tsx scripts/eval.ts --write-actual        # dump actual.json per case (to grow expected.json)
 *   npx tsx scripts/eval.ts --json report.json    # machine-readable report
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DocumentRecord, ProductResult } from "../src/shared/types.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";
import { enrichResultFromDownloadedDocuments } from "../src/server/scrapers/document-enrichment.js";
import { classifyDocument, mergeResults } from "../src/server/scrapers/normalizer.js";
import {
  evalExitCode,
  evaluateCase,
  formatEvalReport,
  summarizeEval,
  type EvalCase,
  type EvalCaseReport,
  type EvalExpectation
} from "./eval-core.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface CliOptions {
  fixturesDir: string;
  caseFilter?: string;
  writeActual: boolean;
  jsonPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { fixturesDir: path.join(repoRoot, "fixtures"), writeActual: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixtures") options.fixturesDir = path.resolve(argv[++index] ?? options.fixturesDir);
    else if (arg === "--case") options.caseFilter = argv[++index];
    else if (arg === "--write-actual") options.writeActual = true;
    else if (arg === "--json") options.jsonPath = path.resolve(argv[++index] ?? "eval-report.json");
  }
  return options;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${path.relative(repoRoot, filePath)} is not valid JSON: ${describeError(error)}`);
  }
}

interface LoadedCase {
  dir: string;
  evalCase: EvalCase;
  expectation: EvalExpectation;
}

async function loadCases(options: CliOptions): Promise<LoadedCase[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(options.fixturesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new Error(`No fixtures directory at ${path.relative(repoRoot, options.fixturesDir)}. See fixtures/README.md.`);
  }

  const cases: LoadedCase[] = [];
  for (const name of entries) {
    const dir = path.join(options.fixturesDir, name);
    const casePath = path.join(dir, "case.json");
    try {
      await fs.access(casePath);
    } catch {
      continue; // not a fixture folder (e.g. shared assets)
    }
    const evalCase = await readJsonFile<EvalCase>(casePath);
    evalCase.id ||= name;
    if (options.caseFilter && !evalCase.id.includes(options.caseFilter)) continue;
    const expectation = await readJsonFile<EvalExpectation>(path.join(dir, "expected.json")).catch(() => ({}) as EvalExpectation);
    cases.push({ dir, evalCase, expectation });
  }
  return cases;
}

/** Resolve a fixture path: relative to the case folder first, then to the repo root. */
async function resolveFixtureFile(dir: string, relative: string): Promise<string> {
  const candidates = [path.resolve(dir, relative), path.resolve(repoRoot, relative)];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(`fixture file not found: ${relative}`);
}

interface CaseRun {
  report: EvalCaseReport;
  /** Present only when the extractors ran; consumed by --write-actual. */
  actual?: Record<string, unknown>;
}

async function runCase(loaded: LoadedCase): Promise<CaseRun> {
  const { dir, evalCase, expectation } = loaded;
  const started = Date.now();
  try {
    let result: ProductResult = {
      manufacturerId: evalCase.manufacturerId,
      catalogNumber: evalCase.catalogNumber,
      status: "partial",
      confidence: 0,
      normalized: {},
      attributes: [],
      documents: [],
      sources: []
    };

    for (const page of evalCase.pages ?? []) {
      const filePath = await resolveFixtureFile(dir, page.path);
      const html = await fs.readFile(filePath, "utf8");
      const url = page.url ?? pathToFileURL(filePath).href;
      const fetched: FetchedText = {
        requestedUrl: url,
        effectiveUrl: url,
        statusCode: 200,
        contentType: "text/html; charset=utf-8",
        text: html,
        fetchedAt: new Date(0).toISOString(),
        fromCache: true
      };
      const parsed = parseGenericProductPage(
        evalCase.manufacturerId,
        evalCase.catalogNumber,
        fetched,
        page.sourceType ?? "official",
        "generic"
      );
      result = mergeResults(parsed, result);
    }

    const documents: DocumentRecord[] = [];
    for (const doc of evalCase.documents ?? []) {
      const filePath = await resolveFixtureFile(dir, doc.path);
      const url = doc.url ?? pathToFileURL(filePath).href;
      const label = doc.label ?? path.basename(doc.path);
      documents.push({
        type: doc.type ?? classifyDocument(label, url),
        label,
        url,
        localPath: filePath,
        downloadStatus: "downloaded",
        ...(doc.enrichable === undefined ? {} : { enrichable: doc.enrichable })
      });
    }
    if (documents.length) {
      result = await enrichResultFromDownloadedDocuments({ ...result, documents: [...result.documents, ...documents] });
    }

    const report = evaluateCase(evalCase, expectation, result);
    report.elapsedMs = Date.now() - started;
    if (Object.keys(expectation).length === 0) {
      report.informational.push("expected.json is missing or empty — run with --write-actual and promote real values into it");
    }
    return { report, actual: buildActual(result) };
  } catch (error) {
    return {
      report: {
        id: evalCase.id,
        note: evalCase.note,
        passed: false,
        checks: 0,
        findings: [],
        knownGapFindings: [],
        closedGaps: [],
        extracted: {},
        attributeCount: 0,
        informational: [],
        elapsedMs: Date.now() - started,
        error: describeError(error)
      }
    };
  }
}

/** What `--write-actual` dumps: enough to hand-promote values into expected.json, nothing more. */
function buildActual(result: ProductResult): Record<string, unknown> {
  return {
    status: result.status,
    title: result.title,
    normalized: result.normalized,
    attributes: (result.attributes ?? []).map((attribute) => ({
      group: attribute.group,
      name: attribute.name,
      value: attribute.value,
      parser: attribute.parser,
      confidence: attribute.confidence
    })),
    documentProcessing: result.diagnostics?.documentProcessing
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cases = await loadCases(options);
  if (!cases.length) {
    console.error(`No fixtures matched${options.caseFilter ? ` filter "${options.caseFilter}"` : ""}.`);
    process.exit(1);
  }

  const reports: EvalCaseReport[] = [];
  for (const loaded of cases) {
    const { report, actual } = await runCase(loaded);
    if (options.writeActual && actual) {
      await fs.writeFile(path.join(loaded.dir, "actual.json"), `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    }
    reports.push(report);
    process.stdout.write(report.passed && !report.error ? "." : "x");
  }
  process.stdout.write("\n\n");

  console.log(formatEvalReport(reports));
  if (options.jsonPath) {
    await fs.writeFile(options.jsonPath, `${JSON.stringify({ summary: summarizeEval(reports), reports }, null, 2)}\n`, "utf8");
    console.log(`\nJSON report: ${path.relative(repoRoot, options.jsonPath)}`);
  }
  process.exit(evalExitCode(reports));
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
