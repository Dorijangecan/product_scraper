/**
 * Value-level PDT comparison (workstream A — eval).
 *
 * The existing manual-PDT parity tool measures COVERAGE (how many cells we fill vs the
 * human gold). That can't catch a cell we filled with a WRONG value. This module adds
 * PRECISION: for cells that BOTH the human gold and our output populate, do the values
 * agree? Mismatches are the prime "did we write something wrong?" signal, and manual-only
 * cells are what we still miss. generated-only cells are us correctly exceeding the (often
 * incomplete) human fill, so they are counted but not flagged.
 *
 * Pure + dependency-free so it can be unit-tested without a workbook or a network scrape.
 */

export interface PdtValueCell {
  article: string;
  sheet: string;
  /** Canonical column identity — the ECLASS PropertyId, else the PropertyName. */
  column: string;
  value: string;
}

export type PdtComparisonStatus = "match" | "mismatch" | "generated-only" | "manual-only";

export interface PdtCellDiff {
  article: string;
  sheet: string;
  column: string;
  manual?: string;
  generated?: string;
  status: PdtComparisonStatus;
}

export interface PdtComparisonSummary {
  /** Cells where both sides have a value (match + mismatch). */
  comparable: number;
  match: number;
  mismatch: number;
  /** We filled it, the human gold did not — exceeding the (lazy) manual fill. */
  generatedOnly: number;
  /** Human gold filled it, we did not — what we still miss. */
  manualOnly: number;
  /** match / comparable (1 when nothing is comparable). */
  precision: number;
  /** The actionable cells: mismatches first, then manual-only misses. */
  diffs: PdtCellDiff[];
}

function canon(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A value that is a single number, optionally with a trailing unit ("0.10 kg", "230 V"). */
function pureNumber(value: string): number {
  const cleaned = canon(value).replace(",", ".");
  if (!/^[-+]?\d+(?:\.\d+)?(?:\s*[a-z°%/]+)?$/.test(cleaned)) return Number.NaN;
  const match = cleaned.match(/^[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function unifyRanges(value: string): string {
  return canon(value)
    .replace(/\s*(?:\.{2,3}|…|\bto\b|\bbis\b|\bdo\b|–|—|-)\s*/g, "-")
    .replace(/\+/g, "");
}

/** Treat trivially-different renderings of the same value as equal (numbers, range separators). */
export function valuesEquivalent(a: string, b: string): boolean {
  const ca = canon(a);
  const cb = canon(b);
  if (!ca || !cb) return ca === cb;
  if (ca === cb) return true;
  const na = pureNumber(a);
  const nb = pureNumber(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  const dateA = excelDateDecimal(a);
  const dateB = excelDateDecimal(b);
  if (dateA !== undefined && Number.isFinite(nb)) return dateA === nb;
  if (dateB !== undefined && Number.isFinite(na)) return dateB === na;
  return unifyRanges(a) === unifyRanges(b);
}

function excelDateDecimal(value: string): number | undefined {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T00:00:00\.000Z$/);
  if (!match) return undefined;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return Number(`${day}.${month}`);
}

function articleKey(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

function cellKey(cell: PdtValueCell): string {
  return `${articleKey(cell.article)}|${canon(cell.sheet)}|${canon(cell.column)}`;
}

function toMap(cells: PdtValueCell[]): Map<string, PdtValueCell> {
  const map = new Map<string, PdtValueCell>();
  for (const cell of cells) {
    if (!cell.value || !cell.value.trim()) continue;
    map.set(cellKey(cell), cell);
  }
  return map;
}

export function comparePdtValues(manual: PdtValueCell[], generated: PdtValueCell[]): PdtComparisonSummary {
  const manualMap = toMap(manual);
  const generatedMap = toMap(generated);
  const keys = new Set<string>([...manualMap.keys(), ...generatedMap.keys()]);

  let match = 0;
  let mismatch = 0;
  let generatedOnly = 0;
  let manualOnly = 0;
  const mismatches: PdtCellDiff[] = [];
  const misses: PdtCellDiff[] = [];

  for (const key of keys) {
    const manualCell = manualMap.get(key);
    const generatedCell = generatedMap.get(key);
    const reference = manualCell ?? generatedCell!;
    const base = { article: reference.article, sheet: reference.sheet, column: reference.column };
    if (manualCell && generatedCell) {
      if (valuesEquivalent(manualCell.value, generatedCell.value)) {
        match += 1;
      } else {
        mismatch += 1;
        mismatches.push({ ...base, manual: manualCell.value, generated: generatedCell.value, status: "mismatch" });
      }
    } else if (generatedCell) {
      generatedOnly += 1;
    } else if (manualCell) {
      manualOnly += 1;
      misses.push({ ...base, manual: manualCell.value, status: "manual-only" });
    }
  }

  const comparable = match + mismatch;
  return {
    comparable,
    match,
    mismatch,
    generatedOnly,
    manualOnly,
    precision: comparable === 0 ? 1 : match / comparable,
    diffs: [...mismatches, ...misses]
  };
}
