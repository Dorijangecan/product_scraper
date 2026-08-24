/**
 * Read-only inventory of PDF pages that need OCR according to the production gate.
 *
 * This does not invent an OCR recipe. It identifies the only documents that could
 * justify one: unique PDFs with sparse/glyph-noisy native pages, alongside a short
 * native-text sample which lets a reviewer see whether the page actually carries a
 * target SKU/table rather than being a cover, drawing, or blank page.
 *
 * Usage:
 *   npx tsx scripts/audit-ocr-corpus.ts
 *   npx tsx scripts/audit-ocr-corpus.ts --limit 20 --json tmp/ocr-corpus.json
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { pdfPagesNeedingOcr } from "../src/server/scrapers/pdf-ocr.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRoot = path.join(repoRoot, "benchmarks", "output");

interface Options {
  help?: boolean;
  limit?: number;
  jsonPath?: string;
}

interface SparsePage {
  page: number;
  nativeSample: string;
}

interface OcrCorpusCandidate {
  path: string;
  pageCount: number;
  sparsePages: SparsePage[];
}

interface OcrCorpusReport {
  scannedFiles: number;
  uniquePdfs: number;
  unreadableFiles: number;
  sparsePdfCount: number;
  candidates: OcrCorpusCandidate[];
}

export function parseOcrCorpusOptions(argv: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--help" || argv[index] === "-h") {
      options.help = true;
    } else if (argv[index] === "--limit") {
      const value = Number(argv[++index]);
      if (Number.isInteger(value) && value > 0) options.limit = value;
    } else if (argv[index] === "--json") {
      const output = argv[++index];
      if (output) options.jsonPath = path.resolve(output);
    }
  }
  return options;
}

async function walkPdfCandidates(directory: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkPdfCandidates(fullPath, files);
    } else if (entry.isFile() && /\.(?:pdf|download)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
}

async function uniquePdfFiles(root: string): Promise<{ files: string[]; scannedFiles: number }> {
  const candidates: string[] = [];
  await walkPdfCandidates(root, candidates);
  const hashes = new Set<string>();
  const files: string[] = [];
  for (const file of candidates) {
    const data = await fs.readFile(file);
    if (data.subarray(0, 4).toString() !== "%PDF") continue;
    const hash = createHash("sha256").update(data).digest("hex");
    if (hashes.has(hash)) continue;
    hashes.add(hash);
    files.push(file);
  }
  return { files, scannedFiles: candidates.length };
}

async function inspectPdf(file: string): Promise<OcrCorpusCandidate | undefined> {
  const parser = new PDFParse({ data: await fs.readFile(file) });
  try {
    const parsed = await parser.getText();
    const sparse = new Set(pdfPagesNeedingOcr(parsed.pages.map((page) => ({ num: page.num, text: page.text }))));
    if (!sparse.size) return undefined;
    return {
      path: path.relative(repoRoot, file),
      pageCount: parsed.pages.length,
      sparsePages: parsed.pages
        .filter((page) => sparse.has(page.num))
        .map((page) => ({ page: page.num, nativeSample: page.text.trim().replace(/\s+/g, " ").slice(0, 240) }))
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const options = parseOcrCorpusOptions(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npx tsx scripts/audit-ocr-corpus.ts [--limit <n>] [--json <report-path>]");
    console.log("Read-only native-text inventory for possible OCR fixture candidates; --help does not scan the corpus.");
    return;
  }
  const { files, scannedFiles } = await uniquePdfFiles(defaultRoot);
  const candidates: OcrCorpusCandidate[] = [];
  let unreadableFiles = 0;
  for (const file of files.slice(0, options.limit)) {
    try {
      const candidate = await inspectPdf(file);
      if (candidate) candidates.push(candidate);
    } catch {
      unreadableFiles += 1;
    }
  }
  const report: OcrCorpusReport = {
    scannedFiles,
    uniquePdfs: Math.min(files.length, options.limit ?? files.length),
    unreadableFiles,
    sparsePdfCount: candidates.length,
    candidates
  };
  console.log(`OCR corpus: ${report.uniquePdfs}/${scannedFiles} unique PDF files inspected; ${report.sparsePdfCount} have sparse native page(s); ${report.unreadableFiles} unreadable.`);
  for (const candidate of candidates) {
    console.log(`  ${candidate.path}`);
    for (const page of candidate.sparsePages) console.log(`    p.${page.page}: ${page.nativeSample || "[no native text]"}`);
  }
  if (options.jsonPath) {
    await fs.writeFile(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`JSON report: ${options.jsonPath}`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
