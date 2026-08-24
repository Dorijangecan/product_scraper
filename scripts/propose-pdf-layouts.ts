/**
 * Review-only local LLM helper for unknown PDF layouts.
 *
 * Usage:
 *   PRODUCT_SCRAPER_LLM_PDF_LAYOUT_PROPOSALS=1 npx tsx scripts/propose-pdf-layouts.ts --input layout-samples.json
 *
 * Input is a JSON array of PdfLayoutReviewEntry objects. Output is JSON on stdout; it is never
 * written back into a scraper recipe. A human must still run the proposed deterministic reader and
 * add a source-backed fixture before any extraction rule is changed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { proposePdfLayoutReviews, type PdfLayoutReviewEntry } from "../src/server/scrapers/llm-pdf-layout-proposals.js";

function inputPath(argv: string[]): string | undefined {
  const index = argv.indexOf("--input");
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const configured = inputPath(process.argv.slice(2));
  if (!configured) {
    console.error("Usage: npx tsx scripts/propose-pdf-layouts.ts --input layout-samples.json");
    process.exitCode = 1;
    return;
  }
  const filePath = path.resolve(configured);
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Input must be a JSON array of PDF layout review entries.");
  const entries = parsed.filter(isReviewEntry);
  if (entries.length !== parsed.length) throw new Error("Every input entry needs documentId, catalogNumber, pageCount and pageTextSamples.");
  const result = await proposePdfLayoutReviews(entries);
  console.log(JSON.stringify(result, null, 2));
}

function isReviewEntry(value: unknown): value is PdfLayoutReviewEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.documentId === "string" && typeof entry.catalogNumber === "string" &&
    typeof entry.pageCount === "number" && Array.isArray(entry.pageTextSamples) &&
    entry.pageTextSamples.every((sample) => typeof sample === "string");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
