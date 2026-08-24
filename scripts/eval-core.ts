/**
 * Offline extraction eval — the comparison core.
 *
 * Why this exists: `scripts/benchmark.ts` needs 14 live vendor sites and asserts only
 * `Boolean(result.normalized[field])`, so the entire class of bug this project keeps hitting —
 * a value that is PRESENT but WRONG (a sibling variant's weight, °F read as °C, "1,050" read as
 * 1.05, packaging dimensions instead of product dimensions) — is invisible to it by construction.
 *
 * This module compares extraction output against recorded fixtures at VALUE level, offline:
 *   - `normalized` / `attributesInclude` assert what the value must BE
 *   - `mustNotContain` asserts what must NEVER appear anywhere in the output — this is the
 *     contamination detector, and it is the reason the harness exists at all. In a family
 *     catalog a sibling's part number or rating showing up in our row is the failure, and no
 *     presence-based assertion can see it.
 *
 * Pure functions only (no fs, no network) so `tests/eval-core.test.ts` can cover them; the CLI
 * that loads fixtures and drives the real extractors is `scripts/eval.ts`.
 */
import type { DocumentRecord, ProductResult, SourceRecord } from "../src/shared/types.js";

export interface EvalCaseDocument {
  /** Repo-relative path. Big PDFs already in the repo are referenced, never copied. */
  path: string;
  url?: string;
  type?: DocumentRecord["type"];
  label?: string;
  /** Mirrors DocumentRecord.enrichable — lets a fixture pin the "do not mine this PDF" contract. */
  enrichable?: boolean;
}

export interface EvalCasePage {
  /** Repo-relative path to a recorded HTML page. */
  path: string;
  url?: string;
  sourceType?: SourceRecord["sourceType"];
}

export interface EvalCase {
  id: string;
  manufacturerId: string;
  catalogNumber: string;
  /** Free text: what this fixture is guarding against. Shown in failure output. */
  note?: string;
  documents?: EvalCaseDocument[];
  pages?: EvalCasePage[];
}

/**
 * A string is an exact (whitespace/case-insensitive) match. The object forms exist because some
 * values are legitimately format-unstable across code paths:
 *   {contains}          — substring, for long composite values
 *   {number, tolerance} — numeric compare, so "1.5 kg" / "1,5 kg" / "1.50 kg" all pass but 1500 fails
 *   {absent: true}      — the field MUST stay empty (a value here means we started guessing)
 */
export type ExpectedValue =
  | string
  | { contains: string }
  | { number: number; unit?: string; tolerance?: number }
  | { absent: true };

export interface EvalExpectation {
  /** Expected source page granularity, when it is directly visible in the recorded HTML. */
  pageLevel?: "product" | "family";
  normalized?: Record<string, ExpectedValue>;
  attributesInclude?: Array<{ name: string; valueContains: string }>;
  /** Tokens that must not appear in ANY emitted value (sibling codes, known-bad readings). */
  mustNotContain?: string[];
  /**
   * Fields we know this source genuinely does not publish. Reported as informational, never a
   * failure — keeps "the vendor doesn't say" distinct from "we failed to read it".
   */
  allowMissing?: string[];
  /**
   * Assertions that encode ground truth we CANNOT extract yet (an open item in the cold-start
   * plan). Listed by finding field — "normalized:voltage", "attribute:Rated voltage Un".
   *
   * They do not fail the run, so the harness stays a trustworthy regression signal while a fix is
   * in flight. But when a known gap starts passing the run says so and asks for promotion — which
   * is what stops a closed gap from silently regressing later. Ground truth belongs in
   * `expected.json` the moment it is known; only our ability to read it is provisional.
   */
  knownGaps?: string[];
}

export type EvalFindingKind =
  | "mismatch"
  | "missing"
  | "unexpected-value"
  | "attribute-missing"
  | "contaminated";

export interface EvalFinding {
  kind: EvalFindingKind;
  field: string;
  expected?: string;
  actual?: string;
  detail?: string;
}

export interface EvalCaseReport {
  id: string;
  note?: string;
  passed: boolean;
  /** Number of assertions actually evaluated — a case with 0 checks is a corpus gap, not a pass. */
  checks: number;
  findings: EvalFinding[];
  /** Findings suppressed by `knownGaps` — shown, but they do not fail the run. */
  knownGapFindings: EvalFinding[];
  /** knownGaps that now pass and should be promoted out of the list. */
  closedGaps: string[];
  /** Everything the extractors produced, for `--write-actual` review and for failure context. */
  extracted: Record<string, string>;
  attributeCount: number;
  informational: string[];
  elapsedMs?: number;
  error?: string;
}

const NUMBER_TOLERANCE_DEFAULT = 0.01;

/** Case/whitespace-insensitive comparison key. Deliberately keeps punctuation: "1.5" != "15". */
export function normalizeForCompare(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Leading numeric value of a measurement string, separator-aware.
 * "1,5 kg" → 1.5 · "1.5 kg" → 1.5 · "1,050.00 lbs" → 1050 · "120 x 80" → 120
 * A comma is a decimal separator only when it is followed by 1-2 digits AND no dot follows it,
 * which is the same rule `normalizeNumberSeparators` uses — see the number-separator memory:
 * a blanket comma→dot turns "1,050.00" into 1.05.
 */
export function leadingNumber(value: string): number | undefined {
  const match = /-?\d[\d.,]*/.exec(value);
  if (!match) return undefined;
  let token = match[0];
  const hasDot = token.includes(".");
  if (token.includes(",")) {
    token = hasDot ? token.replace(/,/g, "") : token.replace(/,(\d{1,2})(?!\d)/, ".$1").replace(/,/g, "");
  }
  const parsed = Number.parseFloat(token);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface ValueMatch {
  matched: boolean;
  detail?: string;
}

export function matchesExpectedValue(actual: string | undefined, expected: ExpectedValue): ValueMatch {
  const present = typeof actual === "string" && actual.trim().length > 0;

  if (typeof expected === "object" && "absent" in expected) {
    return present
      ? { matched: false, detail: "expected the field to stay empty" }
      : { matched: true };
  }
  if (!present) return { matched: false, detail: "no value extracted" };
  const value = actual as string;

  if (typeof expected === "string") {
    if (normalizeForCompare(value) === normalizeForCompare(expected)) return { matched: true };
    return { matched: false, detail: "exact value differs" };
  }
  if ("contains" in expected) {
    return normalizeForCompare(value).includes(normalizeForCompare(expected.contains))
      ? { matched: true }
      : { matched: false, detail: `expected to contain "${expected.contains}"` };
  }

  const actualNumber = leadingNumber(value);
  if (actualNumber === undefined) return { matched: false, detail: "value has no parsable number" };
  const tolerance = expected.tolerance ?? NUMBER_TOLERANCE_DEFAULT;
  if (Math.abs(actualNumber - expected.number) > tolerance) {
    return { matched: false, detail: `expected ${expected.number} ±${tolerance}, parsed ${actualNumber}` };
  }
  if (expected.unit && !normalizeForCompare(value).includes(normalizeForCompare(expected.unit))) {
    return { matched: false, detail: `expected unit "${expected.unit}"` };
  }
  return { matched: true };
}

export function describeExpected(expected: ExpectedValue): string {
  if (typeof expected === "string") return expected;
  if ("absent" in expected) return "(empty)";
  if ("contains" in expected) return `contains "${expected.contains}"`;
  return `${expected.number}${expected.unit ? ` ${expected.unit}` : ""} ±${expected.tolerance ?? NUMBER_TOLERANCE_DEFAULT}`;
}

export interface EmittedValue {
  origin: "normalized" | "attribute" | "title" | "description";
  name: string;
  value: string;
}

/**
 * Every value the pipeline is willing to show a user. `mustNotContain` scans this, so it must
 * include the raw attribute list too — contamination that never reaches `normalized` still ships
 * to the Attributes worksheet and to PDT.
 */
export function collectEmittedValues(result: ProductResult): EmittedValue[] {
  const values: EmittedValue[] = [];
  if (result.title) values.push({ origin: "title", name: "title", value: result.title });
  if (result.description) values.push({ origin: "description", name: "description", value: result.description });
  for (const [name, value] of Object.entries(result.normalized ?? {})) {
    if (typeof value === "string" && value.trim()) values.push({ origin: "normalized", name, value });
  }
  for (const attribute of result.attributes ?? []) {
    if (typeof attribute.value === "string" && attribute.value.trim()) {
      values.push({ origin: "attribute", name: attribute.name, value: attribute.value });
    }
  }
  return values;
}

/** Characters whose presence in a token means it is meant literally, not as a catalog code. */
const LITERAL_INTENT_CHARS = /[<>="'{}();!]/;

/**
 * Contamination scan. Matching is case-insensitive substring over the raw value, and the token is
 * compared against a separator-stripped form of the value too — a sibling catalog number bleeds in
 * as "CBE 03637" or "cbe-03637" just as often as verbatim.
 */
export function findContamination(values: EmittedValue[], tokens: string[]): EvalFinding[] {
  const findings: EvalFinding[] = [];
  for (const token of tokens) {
    const needle = normalizeForCompare(token);
    // Separator-insensitive matching exists for CATALOG CODES ("CBE03320" vs "cbe 03320"). It must not
    // apply to a token whose punctuation is the point: asserting `<details` is forbidden should not fire
    // on the legitimate warranty text "1 year See details", which is what stripping the "<" caused.
    const compactNeedle = LITERAL_INTENT_CHARS.test(token) ? "" : needle.replace(/[^a-z0-9]/g, "");
    if (!needle) continue;
    for (const emitted of values) {
      const haystack = normalizeForCompare(emitted.value);
      const compactHaystack = haystack.replace(/[^a-z0-9]/g, "");
      const hit = haystack.includes(needle) || (compactNeedle.length >= 4 && compactHaystack.includes(compactNeedle));
      if (!hit) continue;
      findings.push({
        kind: "contaminated",
        field: `${emitted.origin}:${emitted.name}`,
        expected: `must not contain "${token}"`,
        actual: emitted.value
      });
      break; // one finding per token is enough to fail and to point at the culprit
    }
  }
  return findings;
}

export function evaluateCase(
  evalCase: Pick<EvalCase, "id" | "note">,
  expectation: EvalExpectation,
  result: ProductResult
): EvalCaseReport {
  const findings: EvalFinding[] = [];
  const informational: string[] = [];
  let checks = 0;

  const emitted = collectEmittedValues(result);
  const extracted: Record<string, string> = {};
  for (const value of emitted) {
    if (value.origin === "normalized" || value.origin === "title") extracted[value.name] = value.value;
  }

  const allowMissing = new Set((expectation.allowMissing ?? []).map((field) => field.trim()));

  for (const [field, expected] of Object.entries(expectation.normalized ?? {})) {
    checks += 1;
    const actual = (result.normalized as Record<string, unknown> | undefined)?.[field];
    const actualText = typeof actual === "string" ? actual : undefined;
    const match = matchesExpectedValue(actualText, expected);
    if (match.matched) continue;
    const isMissing = !actualText || !actualText.trim();
    if (isMissing && allowMissing.has(field)) {
      informational.push(`${field}: not published by this source (allowMissing)`);
      continue;
    }
    findings.push({
      kind: isMissing ? "missing" : typeof expected === "object" && "absent" in expected ? "unexpected-value" : "mismatch",
      field: `normalized:${field}`,
      expected: describeExpected(expected),
      actual: actualText,
      detail: match.detail
    });
  }

  for (const wanted of expectation.attributesInclude ?? []) {
    checks += 1;
    const needleName = normalizeForCompare(wanted.name);
    const needleValue = normalizeForCompare(wanted.valueContains);
    const hit = (result.attributes ?? []).some(
      (attribute) =>
        normalizeForCompare(attribute.name).includes(needleName) &&
        normalizeForCompare(String(attribute.value ?? "")).includes(needleValue)
    );
    if (!hit) {
      findings.push({
        kind: "attribute-missing",
        field: `attribute:${wanted.name}`,
        expected: `contains "${wanted.valueContains}"`
      });
    }
  }

  if (expectation.pageLevel !== undefined) {
    checks += 1;
    if (result.pageLevel !== expectation.pageLevel) {
      findings.push({
        kind: "mismatch",
        field: "pageLevel",
        expected: expectation.pageLevel,
        actual: result.pageLevel ?? "(missing)",
        detail: "Recorded HTML page level did not match."
      });
    }
  }

  const contamination = findContamination(emitted, expectation.mustNotContain ?? []);
  checks += (expectation.mustNotContain ?? []).length;
  findings.push(...contamination);

  const knownGaps = new Set(expectation.knownGaps ?? []);
  const hardFindings = findings.filter((finding) => !knownGaps.has(finding.field));
  const knownGapFindings = findings.filter((finding) => knownGaps.has(finding.field));
  const stillFailing = new Set(knownGapFindings.map((finding) => finding.field));
  const closedGaps = [...knownGaps].filter((field) => !stillFailing.has(field));

  return {
    id: evalCase.id,
    note: evalCase.note,
    passed: hardFindings.length === 0,
    checks,
    findings: hardFindings,
    knownGapFindings,
    closedGaps,
    extracted,
    attributeCount: result.attributes?.length ?? 0,
    informational
  };
}

export interface EvalSummary {
  cases: number;
  passed: number;
  failed: number;
  errored: number;
  checks: number;
  /** Cases with zero assertions — corpus gaps, reported so the harness can't look green while empty. */
  emptyCases: string[];
  contaminationFindings: number;
  openGaps: number;
  /** knownGaps that started passing — promote them into hard assertions. */
  closedGaps: string[];
}

export function summarizeEval(reports: EvalCaseReport[]): EvalSummary {
  return {
    cases: reports.length,
    passed: reports.filter((report) => report.passed && !report.error).length,
    failed: reports.filter((report) => !report.passed && !report.error).length,
    errored: reports.filter((report) => Boolean(report.error)).length,
    checks: reports.reduce((total, report) => total + report.checks, 0),
    emptyCases: reports.filter((report) => report.checks === 0 && !report.error).map((report) => report.id),
    contaminationFindings: reports.reduce(
      (total, report) => total + report.findings.filter((finding) => finding.kind === "contaminated").length,
      0
    ),
    openGaps: reports.reduce((total, report) => total + (report.knownGapFindings?.length ?? 0), 0),
    closedGaps: reports.flatMap((report) => (report.closedGaps ?? []).map((field) => `${report.id} → ${field}`))
  };
}

export function formatEvalReport(reports: EvalCaseReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    const status = report.error ? "ERROR" : report.passed ? "PASS " : "FAIL ";
    const timing = report.elapsedMs === undefined ? "" : ` ${(report.elapsedMs / 1000).toFixed(1)}s`;
    lines.push(`${status} ${report.id}  (${report.checks} checks, ${report.attributeCount} attrs${timing})`);
    if (report.error) {
      lines.push(`        error: ${report.error}`);
      continue;
    }
    if (report.note && !report.passed) lines.push(`        guards: ${report.note}`);
    for (const finding of report.findings) {
      const parts = [`      ${finding.kind.toUpperCase()} ${finding.field}`];
      if (finding.expected !== undefined) parts.push(`expected ${finding.expected}`);
      if (finding.actual !== undefined) parts.push(`got "${truncate(finding.actual, 90)}"`);
      if (finding.detail) parts.push(`(${finding.detail})`);
      lines.push(parts.join(" · "));
    }
    for (const finding of report.knownGapFindings ?? []) {
      const parts = [`      gap   ${finding.field}`];
      if (finding.expected !== undefined) parts.push(`want ${finding.expected}`);
      if (finding.actual !== undefined) parts.push(`got "${truncate(finding.actual, 60)}"`);
      lines.push(parts.join(" · "));
    }
    for (const note of report.informational) lines.push(`      info  ${note}`);
  }

  const summary = summarizeEval(reports);
  lines.push("");
  lines.push(
    `${summary.passed}/${summary.cases} cases passed · ${summary.checks} checks · ` +
      `${summary.failed} failed · ${summary.errored} errored · ${summary.contaminationFindings} contamination hits · ` +
      `${summary.openGaps} open gaps`
  );
  if (summary.closedGaps.length) {
    lines.push(`GAP CLOSED — promote out of knownGaps: ${summary.closedGaps.join(", ")}`);
  }
  if (summary.emptyCases.length) {
    lines.push(`WARNING: ${summary.emptyCases.length} case(s) assert nothing: ${summary.emptyCases.join(", ")}`);
  }
  return lines.join("\n");
}

export function evalExitCode(reports: EvalCaseReport[]): number {
  const summary = summarizeEval(reports);
  // An assertion-free case counts as failure: a green harness that checks nothing is worse than red.
  return summary.failed > 0 || summary.errored > 0 || summary.emptyCases.length > 0 ? 1 : 0;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
