/**
 * Doepke "leftover data" export — every clean technical attribute the scraper finds that does NOT
 * currently reach a PDT column (weight/dimensions/material/voltage/current/protection/certificates/
 * temperature/power-loss/poles already do — see EXCLUDED_ONTOLOGY_KEYS). Most of what survives is
 * exactly the "Connection Point Information" sheet's domain (cross-section, AWG, tightening torque,
 * conductors per terminal, installation depth) plus mechanical/environmental facts with no PDT
 * column at all yet (endurance, altitude, climate/shock resistance, housing type, ...).
 *
 * Run: npx tsx scripts/export-doepke-unmapped-fields.ts [catalogListPath] [outputXlsxPath]
 * Reuses the shared CachedHttpClient (SQLite-backed), so re-running after a partial run or a crash
 * only re-fetches what wasn't already cached.
 */
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getManufacturerConfig, initializeManufacturerConfig } from "../src/server/config/manufacturers.js";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { GenericFallbackScraper } from "../src/server/scrapers/generic.js";
import { CachedHttpClient } from "../src/server/scrapers/http-client.js";
import { getConnector } from "../src/server/scrapers/index.js";
import { BrowserRenderSession } from "../src/server/scrapers/browser-renderer.js";
import { finalizeQualityGate } from "../src/server/scrapers/quality-gate.js";
import { enrichResultFromDownloadedDocuments } from "../src/server/scrapers/document-enrichment.js";
import { matchProperty } from "../src/server/scrapers/ontology.js";
import type { AttributeRecord } from "../src/shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const catalogListPath = path.resolve(rootDir, process.argv[2] ?? "Testing PDT/Doepke_popis uređaja.csv");
const outputPath = path.resolve(rootDir, process.argv[3] ?? "Testing PDT/Doepke_dodatni_podatci_za_Connection_Point_Info.xlsx");
const CONCURRENCY = 6;

// Ontology keys for facts that already land in the PDT today (Material Master Data +
// "contactor a. fuses" sheets) — see doepke-pdt-field-conventions memory. Anything NOT in this set
// (matched to a different key, or unmatched entirely) is "leftover" and goes into this export.
const EXCLUDED_ONTOLOGY_KEYS = new Set([
  "weight",
  "width",
  "height",
  "depth",
  "material",
  "ratedVoltage",
  "ratedCurrent",
  "protection",
  "certificates",
  "operatingTemperature",
  "storageTemperature",
  "powerLoss",
  "poles",
  "voltageType",
  "breakingCapacity",
  "typeCode"
]);

// The bare "PDF datasheet" group (no " - <Section>" suffix) is consistently the generic
// Function/Features marketing prose mis-split into fake label:value pairs — every example checked
// across multiple catalog numbers was noise. Its named sub-groups ("- Technical Data", "-
// Dimensions", ...) are a genuine mix: the *same* real fact (e.g. "Climate resistance...") can land
// under either sub-group name depending on subtle per-PDF text layout, so sub-groups can't be
// allow/deny-listed by name — `looksLikeRealSpecValue` below does the real filtering.
const EXCLUDED_GROUP_PATTERN = /^pdf datasheet$/i;
const ALLOWED_GROUP_PATTERN = /^(?:doepke features|pdf datasheet(?:\s*-.*)?|doepke product data)$/i;
// "Technical Data"/"General data" are section HEADINGS misread as a field name (their "value" is
// really the next real field's content); "Model" only ever showed up as a vague one-off fragment
// across the full 394-catalog run. Names starting with a standards-body prefix followed by a
// number ("DIN EN 50628...", "VDE 0100-420...") are a mis-split fragment of the
// certificates/standards line, not a distinct field.
const NOISE_NAME_PATTERN = /^(?:feature|parsed document|catalog number|technical data|general data|model)$/i;
const NOISE_NAME_PREFIX_PATTERN = /^\(|^(?:DIN|EN|VDE|IEC|ISO|[ÖO]VE|UL|CSA)\b.*\d/i;
const MAX_VALUE_LENGTH = 150;

/**
 * Real Doepke spec values are either quantified ("1.5 mm² ... 50 mm²", "2.5 Nm ... 3 Nm", "69 mm")
 * or short enum-like words ("left", "optional", "gG", "type B"). The Function/Features prose that
 * leaks through as fake attributes is long and often a mid-sentence fragment: truncated word ending
 * in "-", starting mid-quote from a quoted list like "on", "off", ..., or starting with a lowercase
 * grammatical connector ("is therefore not provided...") — the last case can still contain a digit
 * further into the sentence, so the digit check alone isn't enough to accept it.
 */
function looksLikeRealSpecValue(value: string): boolean {
  const trimmed = value.trim();
  if (/-$/.test(trimmed)) return false;
  if (/^["']/.test(trimmed)) return false;
  if (/^(?:is|the|of|and|with|in|on|for|or|was|are|to|a|an|this|that|which|therefore|however|since|because)\b/i.test(trimmed)) return false;
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount > 12) return false;
  if (/\d/.test(trimmed)) return true;
  return wordCount <= 4;
}

// Canonicalize field-name variants produced by the PDF line-splitting heuristics (e.g. "Cross
// section solid 1-wire" keeps a units-table fragment in the name) so the same physical fact lands
// in the same spreadsheet column across every catalog number, regardless of which exact line shape
// a given datasheet happened to produce.
const NAME_CANONICALIZATION: Array<[RegExp, string]> = [
  [/^cross section solid.*$/i, "Cross section solid"],
  [/^cross section stranded.*$/i, "Cross section stranded"],
  [/^connecting capacity flexible.*$/i, "Connecting capacity flexible"],
  [/^cross section awg,?\s*solid.*$/i, "Cross section AWG, solid"],
  [/^cross section awg,?\s*stranded.*$/i, "Cross section AWG, stranded"],
  [/^cross section awg,?\s*flexible with ferrule.*$/i, "Cross section AWG, flexible with ferrule"],
  [/^cross section awg,?\s*flexible.*$/i, "Cross section AWG, flexible"],
  [/^protection$/i, "Protection against direct contact"],
  [/^max\.?\s*connection c1 number of conductors.*$/i, "max. Connection C1 Number of conductors per terminal"],
  [/^number of conductors.*$/i, "max. Connection C1 Number of conductors per terminal"],
  [/^rated residual current(\s+i[δd]n)?$/i, "Rated residual current (IΔn)"],
  [/^min\.?\s*operating voltage range of test circuit$/i, null as unknown as string], // dropped below
  [/^max\.?\s*operating voltage range of test circuit$/i, null as unknown as string]
];

function canonicalFieldName(rawName: string): string | undefined {
  const name = rawName.trim();
  for (const [pattern, replacement] of NAME_CANONICALIZATION) {
    if (pattern.test(name)) return replacement ?? undefined;
  }
  return name;
}

/** Strips a label fragment the line-splitter left stuck to the front of the value (the label
 * itself already says this, so repeating it in the cell is just noise: "Protection" / "against
 * direct contact DGUV..." → column "Protection against direct contact" / value "DGUV...". */
function canonicalFieldValue(canonicalName: string, rawValue: string): string {
  const value = rawValue.trim();
  if (canonicalName === "Protection against direct contact") {
    return value.replace(/^against direct contact\s*/i, "");
  }
  if (canonicalName === "Rated residual current (IΔn)") {
    return value.replace(/^i[δd]n\s*/i, "");
  }
  return value;
}

function isLeftoverAttribute(attr: AttributeRecord): boolean {
  const group = (attr.group ?? "").trim();
  const name = (attr.name ?? "").trim();
  const value = (attr.value ?? "").trim();
  if (!name || !value) return false;
  if (!ALLOWED_GROUP_PATTERN.test(group) || EXCLUDED_GROUP_PATTERN.test(group)) return false;
  if (NOISE_NAME_PATTERN.test(name) || NOISE_NAME_PREFIX_PATTERN.test(name)) return false;
  if (value.length > MAX_VALUE_LENGTH) return false;
  if (!looksLikeRealSpecValue(value)) return false;
  const ontologyKey = matchProperty(`${group} ${name}`)?.key;
  if (ontologyKey && EXCLUDED_ONTOLOGY_KEYS.has(ontologyKey)) return false;
  return true;
}

async function main() {
  const appPaths = createAppPaths(rootDir);
  initializeManufacturerConfig(appPaths.dataDir);
  const manufacturerOrUndefined = getManufacturerConfig("doepke");
  if (!manufacturerOrUndefined) throw new Error("Doepke manufacturer not configured");
  const manufacturer = manufacturerOrUndefined;

  const catalogNumbers = (await fs.readFile(catalogListPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  console.log(`Loaded ${catalogNumbers.length} catalog numbers from ${catalogListPath}`);

  const db = new ScraperDb(appPaths);
  const http = new CachedHttpClient(db, appPaths.cacheDir);
  http.setHostMinIntervalMs(Math.max(100, Math.floor(manufacturer.rateLimitMs / (manufacturer.concurrency ?? 3))));
  const browserRenderer = new BrowserRenderSession();
  const fallback = new GenericFallbackScraper(manufacturer.id, http, manufacturer);
  const connector = getConnector(manufacturer.id);
  const tempDir = path.join(rootDir, "tmp", "export-doepke-unmapped");

  const rows = new Map<string, { title?: string; productUrl?: string; status: string; fields: Map<string, string> }>();
  const columnOrder: string[] = [];
  const failures: Array<{ catalogNumber: string; error: string }> = [];
  let processed = 0;

  async function processCatalog(catalogNumber: string) {
    try {
      const scraped = await connector.scrape(catalogNumber, {
        http,
        manufacturer,
        runDir: rootDir,
        documentsDir: tempDir,
        signal: undefined,
        browserRenderer,
        learnedEndpoints: {
          list: (id, limit) => db.listLearnedEndpoints(id, limit),
          upsert: (endpoint) => db.upsertLearnedEndpoint(endpoint)
        },
        fallback: { scrape: (cn, sources) => fallback.scrape(cn, sources) },
        downloadDocument: async (doc) => doc
      });

      const documents = await Promise.all(
        scraped.documents.map(async (doc) => {
          if (doc.type === "image") return doc;
          try {
            const localPath = await http.downloadFile(doc.url, tempDir);
            return { ...doc, localPath, downloadStatus: "downloaded" as const };
          } catch {
            return { ...doc, downloadStatus: "failed" as const };
          }
        })
      );

      const enriched = await enrichResultFromDownloadedDocuments({ ...scraped, documents });
      const result = finalizeQualityGate(enriched, manufacturer);

      const fields = new Map<string, string>();
      for (const attr of result.attributes) {
        if (!isLeftoverAttribute(attr)) continue;
        const canonicalName = canonicalFieldName(attr.name);
        if (!canonicalName) continue;
        if (!fields.has(canonicalName)) {
          fields.set(canonicalName, canonicalFieldValue(canonicalName, attr.value));
          if (!columnOrder.includes(canonicalName)) columnOrder.push(canonicalName);
        }
      }

      if (process.env.DEBUG_GROUPS) {
        for (const attr of result.attributes) {
          console.log(`  [${catalogNumber}] group="${attr.group}" name="${attr.name}" value="${attr.value}"`);
        }
      }

      rows.set(catalogNumber, { title: result.title, productUrl: result.productUrl, status: result.status, fields });
    } catch (error) {
      failures.push({ catalogNumber, error: error instanceof Error ? error.message : String(error) });
      rows.set(catalogNumber, { status: "error", fields: new Map() });
    } finally {
      processed += 1;
      if (processed % 20 === 0 || processed === catalogNumbers.length) {
        console.log(`  ${processed}/${catalogNumbers.length} processed...`);
      }
    }
  }

  // Bounded concurrency: CachedHttpClient's per-host throttle already serializes the actual network
  // calls, so this mainly overlaps PDF parsing / documents-not-yet-cached latency.
  let cursor = 0;
  async function worker() {
    while (cursor < catalogNumbers.length) {
      const index = cursor++;
      await processCatalog(catalogNumbers[index]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  await browserRenderer.close();
  db.close();

  console.log(`\nDone. ${failures.length} failures.`);
  if (failures.length > 0) {
    console.log("Failures:");
    for (const f of failures.slice(0, 30)) console.log(`  ${f.catalogNumber}: ${f.error}`);
    if (failures.length > 30) console.log(`  ... and ${failures.length - 30} more`);
  }

  columnOrder.sort();
  console.log(`\n${columnOrder.length} leftover fields found across all catalogs:`);
  for (const col of columnOrder) console.log(`  - ${col}`);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Connection Point Info - Doepke");
  const headerRow = ["Catalog Number", "Title", "Status", "Product URL", ...columnOrder];
  sheet.addRow(headerRow);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1, xSplit: 1 }];

  for (const catalogNumber of catalogNumbers) {
    const row = rows.get(catalogNumber);
    if (!row) continue;
    const values = [catalogNumber, row.title ?? "", row.status, row.productUrl ?? "", ...columnOrder.map((col) => row.fields.get(col) ?? "")];
    sheet.addRow(values);
  }

  sheet.columns.forEach((column, index) => {
    const header = headerRow[index] ?? "";
    column.width = Math.min(50, Math.max(12, header.length + 2));
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
  console.log(`\nWrote ${outputPath}`);
}

await main();
