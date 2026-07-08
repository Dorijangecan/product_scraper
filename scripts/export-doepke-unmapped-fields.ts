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
import { cleanText, normalizeNumberSeparators } from "../src/server/text-util.js";
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

// The bare "PDF datasheet" group (no " - <Section>" suffix) holds whatever landed in the
// catalog-proximity "tight context" window (page 1's title/intro block, or the tail of a page that
// also carries the next page's footer) rather than the keyword-anchored "global technical" context —
// it is NOT purely marketing prose: real per-article facts (Rated voltage/current, Cross section
// solid/stranded/AWG, Tightening torque, dimensions, Certifications, ...) land here whenever their
// PDF line happens to sit inside that proximity window instead of matching `isGlobalTechnicalLine`.
// An earlier version of this script excluded the whole bare group as "100% noise," which silently
// dropped Cross section/AWG (and other) facts for every catalog where they happened to fall in this
// group — same fact, same shape, correctly kept when the identical line landed in a "- Technical
// Data"-suffixed group for a different catalog. Its unsplit marketing-prose lines are already caught
// by `NOISE_NAME_PATTERN` (name="Feature") and `looksLikeRealSpecValue` below, so no group-level
// exclusion is needed — do NOT reintroduce one without re-auditing a full run's bare-group dump.
// "PDF Terminal Data"/"PDF Environmental Data" are the dedicated wrapped-label extractors in
// document-enrichment.ts (extractWrappedLabelValueAttributes) — the only source for facts whose
// wrap point varies enough per catalog that the generic "PDF datasheet..." line splitters miss
// them entirely for some catalogs (confirmed: 09146931's "Connection C1 Maximum" / "number of
// conductors per" / "terminal" wrap shape ONLY produces this fact via that extractor — excluding
// its group silently dropped the value for exactly the catalogs that most needed it).
const ALLOWED_GROUP_PATTERN = /^(?:doepke features|pdf datasheet(?:\s*-.*)?|doepke product data|pdf terminal data|pdf environmental data)$/i;
// "Technical Data"/"General data" are section HEADINGS misread as a field name (their "value" is
// really the next real field's content); "Model" only ever showed up as a vague one-off fragment
// across the full 394-catalog run. "Article number" duplicates the "Catalog Number" column already
// added from the HTML page. Names starting with a standards-body prefix followed by a number ("DIN
// EN 50628...", "VDE 0100-420...") are a mis-split fragment of the certificates/standards line, not a
// distinct field.
const NOISE_NAME_PATTERN = /^(?:feature|parsed document|catalog number|article number|technical data|general data|model)$/i;
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
  // "per terminal" is the wrapped second half of the label above, registered as its own known-label
  // alias only so the PDF-text parser skips past it and lands on the real value (see
  // technical-attribute-aliases.ts) — that same recognition also makes it match as an independent
  // "label" in its own right, producing a redundant second attribute with the identical value. Drop
  // it rather than let it appear as a spurious own column.
  [/^per terminal$/i, null as unknown as string],
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

// --- Range/unit splitting: turn "15 ... 1" or "2.5 Nm ... 3 Nm" into separate plain-number
// min/max columns with the unit folded into the header, so the sheet pastes straight into a
// numeric target column without any manual parsing. ---

interface RangeFieldSplitter {
  // Fixed, ordered output column suffixes for this field (independent of any one catalog's
  // value) — used to keep column order (min before max, 1-wire before 2-wire) stable regardless
  // of which catalog a worker happens to process first.
  suffixes: string[];
  // Returns a partial map of suffix -> plain numeric string, or undefined if the value doesn't
  // match this field's expected shape at all (caller then falls back to the original raw text so
  // nothing is silently lost).
  parse(value: string): Record<string, string> | undefined;
}

const UNIT_TO_BASE: Record<string, { base: string; factor: number }> = {
  hz: { base: "Hz", factor: 1 },
  khz: { base: "Hz", factor: 1000 },
  a: { base: "A", factor: 1 },
  ma: { base: "A", factor: 0.001 },
  ka: { base: "A", factor: 1000 },
  w: { base: "W", factor: 1 },
  kw: { base: "W", factor: 1000 },
  v: { base: "V", factor: 1 },
  kv: { base: "V", factor: 1000 }
};

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1e6) / 1e6);
}

function parseNumberToken(token: string): { value: number; unit?: string } | undefined {
  const match = cleanText(token).match(/^(-?[\d.,]+)\s*([a-zA-Zµ°%/²]*)$/);
  if (!match) return undefined;
  const value = Number(normalizeNumberSeparators(match[1]));
  if (Number.isNaN(value)) return undefined;
  return { value, unit: match[2] || undefined };
}

/** Same physical unit on both sides -> pass through; convertible SI-prefixed pair (Hz/kHz,
 * A/kA/mA, W/kW, V/kV) -> convert both to the shared base unit; anything else -> refuse rather
 * than guess (caller keeps the original text). */
function reconcileUnits(
  min: { value: number; unit?: string },
  max: { value: number; unit?: string }
): { min: number; max: number; unit: string } | undefined {
  const minUnit = (min.unit ?? "").toLowerCase();
  const maxUnit = (max.unit ?? "").toLowerCase();
  if (minUnit === maxUnit) return { min: min.value, max: max.value, unit: min.unit ?? "" };
  const minConv = UNIT_TO_BASE[minUnit];
  const maxConv = UNIT_TO_BASE[maxUnit];
  if (!minConv || !maxConv || minConv.base !== maxConv.base) return undefined;
  return { min: min.value * minConv.factor, max: max.value * maxConv.factor, unit: minConv.base };
}

/** Handles "15 ... 1" (no unit, AWG), "2.5 Nm ... 3 Nm", "-25 °C ... 40 °C", "0 Hz ... 150 kHz"
 * (mixed-prefix units reconciled to one base), and the single-sided "max. 3 Nm" / "min. 0.8 Nm"
 * shape some catalogs use when only one bound is stated. */
function plainRangeSplitter(unitLabel: string): RangeFieldSplitter {
  const minKey = `min (${unitLabel})`;
  const maxKey = `max (${unitLabel})`;
  return {
    suffixes: [minKey, maxKey],
    parse(rawValue) {
      const value = rawValue.trim();
      const rangeMatch = value.match(/^(-?[\d.,]+)\s*([a-zA-Zµ°%/²]*)\s*\.\.\.\s*(-?[\d.,]+)\s*([a-zA-Zµ°%/²]*)$/);
      if (rangeMatch) {
        const min = parseNumberToken(`${rangeMatch[1]}${rangeMatch[2] ? ` ${rangeMatch[2]}` : ""}`);
        const max = parseNumberToken(`${rangeMatch[3]}${rangeMatch[4] ? ` ${rangeMatch[4]}` : ""}`);
        if (!min || !max) return undefined;
        const reconciled = reconcileUnits(min, max);
        if (!reconciled) return undefined;
        return { [minKey]: formatNumber(reconciled.min), [maxKey]: formatNumber(reconciled.max) };
      }
      const singleMatch = value.match(/^(min\.?|max\.?)\s+(-?[\d.,]+)\s*([a-zA-Zµ°%/²]*)$/i);
      if (singleMatch) {
        const parsed = parseNumberToken(`${singleMatch[2]}${singleMatch[3] ? ` ${singleMatch[3]}` : ""}`);
        if (!parsed) return undefined;
        return { [/^max/i.test(singleMatch[1]) ? maxKey : minKey]: formatNumber(parsed.value) };
      }
      return undefined;
    }
  };
}

/** "1-wire: 1.5 mm² ... 50 mm²; 2-wire: 1.5 mm² ... 16 mm²" -> 4 plain-number mm² columns. The
 * leading "1-wire:" is optional in the match because the generic PDF line-splitter sometimes
 * absorbs it into the attribute NAME instead of leaving it in the value ("Cross section solid
 * 1-wire" -> canonicalized down to "Cross section solid", value left as just "1.5 mm² ... 50 mm²;
 * 2-wire: ..." with no leading "1-wire:") depending on subtle per-catalog line-splitting — same
 * physical fact, two different raw shapes. */
function wireVariantMmSplitter(): RangeFieldSplitter {
  const keys = ["1-wire min (mm²)", "1-wire max (mm²)", "2-wire min (mm²)", "2-wire max (mm²)"];
  return {
    suffixes: keys,
    parse(rawValue) {
      const match = rawValue
        .trim()
        .match(/^(?:1-wire:\s*)?(-?[\d.,]+)\s*mm²\s*\.\.\.\s*(-?[\d.,]+)\s*mm²;\s*2-wire:\s*(-?[\d.,]+)\s*mm²\s*\.\.\.\s*(-?[\d.,]+)\s*mm²/i);
      if (!match) return undefined;
      return {
        [keys[0]]: formatNumber(Number(normalizeNumberSeparators(match[1]))),
        [keys[1]]: formatNumber(Number(normalizeNumberSeparators(match[2]))),
        [keys[2]]: formatNumber(Number(normalizeNumberSeparators(match[3]))),
        [keys[3]]: formatNumber(Number(normalizeNumberSeparators(match[4])))
      };
    }
  };
}

const RANGE_FIELD_SPLITTERS: Record<string, RangeFieldSplitter> = {
  "Cross section AWG, solid": plainRangeSplitter("AWG"),
  "Cross section AWG, stranded": plainRangeSplitter("AWG"),
  "Cross section AWG, flexible": plainRangeSplitter("AWG"),
  "Cross section AWG, flexible with ferrule": plainRangeSplitter("AWG"),
  "Tightening torque": plainRangeSplitter("Nm"),
  "Storage temperature": plainRangeSplitter("°C"),
  "Ambient temperature": plainRangeSplitter("°C"),
  "Tripping frequency": plainRangeSplitter("Hz"),
  "Cross section solid": wireVariantMmSplitter(),
  "Cross section stranded": wireVariantMmSplitter(),
  "Connecting capacity flexible": wireVariantMmSplitter()
};

// Keeps min-before-max / 1-wire-before-2-wire / terminal-1-before-terminal-2 column order stable
// no matter which catalog a concurrent worker happens to finish first — sort key, not display
// text. Fields not listed here (i.e. everything not split into min/max) sort after these,
// alphabetically.
const PREFERRED_FIELD_ORDER = [
  "Cross section AWG, solid",
  "Cross section AWG, stranded",
  "Cross section AWG, flexible",
  "Cross section AWG, flexible with ferrule",
  "Cross section solid",
  "Cross section stranded",
  "Connecting capacity flexible",
  "Tightening torque",
  "Storage temperature",
  "Ambient temperature",
  "Tripping frequency"
];

function preferredFieldOrderIndex(name: string): number {
  const index = PREFERRED_FIELD_ORDER.indexOf(name);
  return index === -1 ? PREFERRED_FIELD_ORDER.length : index;
}

interface ColumnMeta {
  fieldOrder: number;
  terminalIndex: number;
  suffixIndex: number;
}

/** A field's `" | "`-joined part count varies per catalog (most have one terminal block, a few
 * have two) — deciding the "(terminal N)" suffix from that ROW's own part count would put the
 * exact same fact in "Tightening torque - min (Nm)" for most catalogs and "...min (Nm) (terminal
 * 1)" for others, splitting one physical column into two. Compute the max part count seen for
 * each range-splittable field ACROSS THE WHOLE DATASET first, so every catalog uses the same
 * column set for that field (rows with fewer parts just leave the extra terminal's cells blank). */
function computeMaxPartsByField(allRawFields: Iterable<Map<string, string>>): Map<string, number> {
  const maxParts = new Map<string, number>();
  for (const rawFields of allRawFields) {
    for (const [name, value] of rawFields) {
      if (!RANGE_FIELD_SPLITTERS[name]) continue;
      const partCount = value.split(" | ").length;
      maxParts.set(name, Math.max(maxParts.get(name) ?? 1, partCount));
    }
  }
  return maxParts;
}

/** Splits every RANGE_FIELD_SPLITTERS-registered field's value into its plain-number sub-columns
 * (handling "|"-joined multi-terminal-block values by emitting one column set per block, using
 * `maxPartsByField` so the same field always uses the same column set — see above), and passes
 * every other field through unchanged. Records each column's sort position in `columnMeta` the
 * first time it's seen so the final sheet can order columns deterministically. */
function expandRangeFields(
  rawFields: Map<string, string>,
  columnMeta: Map<string, ColumnMeta>,
  maxPartsByField: Map<string, number>
): Map<string, string> {
  const expanded = new Map<string, string>();
  const registerPassthrough = (name: string) => {
    if (!columnMeta.has(name)) columnMeta.set(name, { fieldOrder: preferredFieldOrderIndex(name), terminalIndex: 0, suffixIndex: 0 });
  };

  for (const [name, value] of rawFields) {
    const splitter = RANGE_FIELD_SPLITTERS[name];
    if (!splitter) {
      expanded.set(name, value);
      registerPassthrough(name);
      continue;
    }

    const parts = value.split(" | ").map((part) => part.trim());
    const parsedParts = parts.map((part) => splitter.parse(part));
    if (parsedParts.some((parsed) => !parsed)) {
      // At least one terminal block's value didn't match the expected shape — don't guess at a
      // split, keep the original raw text so nothing is silently lost.
      expanded.set(name, value);
      registerPassthrough(name);
      continue;
    }

    const useTerminalSuffix = (maxPartsByField.get(name) ?? 1) > 1;
    parsedParts.forEach((parsed, partIndex) => {
      const terminalSuffix = useTerminalSuffix ? ` (terminal ${partIndex + 1})` : "";
      splitter.suffixes.forEach((suffix, suffixIndex) => {
        const cellValue = parsed![suffix];
        if (cellValue === undefined) return; // this occurrence only stated one bound (e.g. "max. 3 Nm")
        const columnName = `${name} - ${suffix}${terminalSuffix}`;
        expanded.set(columnName, cellValue);
        if (!columnMeta.has(columnName)) {
          columnMeta.set(columnName, { fieldOrder: preferredFieldOrderIndex(name), terminalIndex: partIndex, suffixIndex });
        }
      });
    });
  }
  return expanded;
}

function isLeftoverAttribute(attr: AttributeRecord): boolean {
  const group = (attr.group ?? "").trim();
  const name = (attr.name ?? "").trim();
  const value = (attr.value ?? "").trim();
  if (!name || !value) return false;
  if (!ALLOWED_GROUP_PATTERN.test(group)) return false;
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

  const rows = new Map<string, { title?: string; productUrl?: string; status: string; rawFields: Map<string, string> }>();
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

      // Some datasheets (e.g. RCBOs with a load circuit AND an auxiliary/trip switch circuit)
      // repeat the same field name for TWO distinct physical terminal blocks with different values
      // ("Cross section AWG, solid  15 ... 1" for the load circuit, then again "17 ... 16" for the
      // auxiliary switch). Keeping only the first occurrence silently dropped the second terminal's
      // values — append every distinct value for the same canonical name into one cell instead of
      // discarding repeats.
      const rawFields = new Map<string, string>();
      for (const attr of result.attributes) {
        if (!isLeftoverAttribute(attr)) continue;
        const canonicalName = canonicalFieldName(attr.name);
        if (!canonicalName) continue;
        const value = canonicalFieldValue(canonicalName, attr.value);
        if (!value) continue;
        const existing = rawFields.get(canonicalName);
        if (!existing) {
          rawFields.set(canonicalName, value);
        } else {
          // Same fact can reach this canonical name from two different sources (HTML feature row
          // vs. PDF datasheet line) that render the identical quantity with a different decimal
          // separator ("0,03 A" vs "0.03 A") — compare on a normalized key so that doesn't look like
          // a second, distinct terminal-block value.
          const existingParts = existing.split(" | ");
          const isDuplicate = existingParts.some((part) => normalizeNumberSeparators(part) === normalizeNumberSeparators(value));
          if (!isDuplicate) rawFields.set(canonicalName, `${existing} | ${value}`);
        }
      }
      if (process.env.DEBUG_GROUPS) {
        for (const attr of result.attributes) {
          console.log(`  [${catalogNumber}] group="${attr.group}" name="${attr.name}" value="${attr.value}"`);
        }
      }

      rows.set(catalogNumber, { title: result.title, productUrl: result.productUrl, status: result.status, rawFields });
    } catch (error) {
      failures.push({ catalogNumber, error: error instanceof Error ? error.message : String(error) });
      rows.set(catalogNumber, { status: "error", rawFields: new Map() });
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

  // Every catalog must expand against the SAME max terminal-block count per field (computed
  // across the whole dataset first) — deciding it per-row would put the same physical fact in
  // "Tightening torque - min (Nm)" for single-block catalogs and "...min (Nm) (terminal 1)" for
  // two-block ones, splitting one column into two.
  const maxPartsByField = computeMaxPartsByField([...rows.values()].map((row) => row.rawFields));
  const columnMeta = new Map<string, ColumnMeta>();
  const expandedRows = new Map<string, { title?: string; productUrl?: string; status: string; fields: Map<string, string> }>();
  for (const [catalogNumber, row] of rows) {
    expandedRows.set(catalogNumber, { ...row, fields: expandRangeFields(row.rawFields, columnMeta, maxPartsByField) });
  }

  // Deterministic order: min-before-max / 1-wire-before-2-wire / terminal-1-before-terminal-2 for
  // the split range fields (see PREFERRED_FIELD_ORDER), everything else alphabetically after them
  // — independent of which catalog a concurrent worker happened to finish first.
  const columnOrder = [...columnMeta.keys()].sort((left, right) => {
    const metaLeft = columnMeta.get(left)!;
    const metaRight = columnMeta.get(right)!;
    if (metaLeft.fieldOrder !== metaRight.fieldOrder) return metaLeft.fieldOrder - metaRight.fieldOrder;
    if (metaLeft.terminalIndex !== metaRight.terminalIndex) return metaLeft.terminalIndex - metaRight.terminalIndex;
    if (metaLeft.suffixIndex !== metaRight.suffixIndex) return metaLeft.suffixIndex - metaRight.suffixIndex;
    return left.localeCompare(right);
  });
  console.log(`\n${columnOrder.length} leftover fields found across all catalogs:`);
  for (const col of columnOrder) console.log(`  - ${col}`);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Connection Point Info - Doepke");
  const headerRow = ["Catalog Number", "Title", "Status", "Product URL", ...columnOrder];
  sheet.addRow(headerRow);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1, xSplit: 1 }];

  for (const catalogNumber of catalogNumbers) {
    const row = expandedRows.get(catalogNumber);
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
