import { describe, expect, it } from "vitest";
import { buildTightContextForCatalog, buildVariantColumnContext } from "../src/server/scrapers/tight-context.js";

const VARIANT_TABLE = [
  "Technical data",
  "Catalog Number    EIS-40/1    EIS-40/2    EIS-40/3",
  "Poles    1    2    3",
  "Weight (kg)    0.08    0.16    0.24",
  "Rated current AC-1    40    40    40",
  "Operating temperature    -25 to 60 C    -25 to 60 C    -25 to 60 C"
].join("\n");

describe("multi-variant datasheet column selection", () => {
  it("picks the column that matches the target variant", () => {
    const out = buildVariantColumnContext(VARIANT_TABLE, "EIS-40/2");
    expect(out).toBeDefined();
    expect(out).toContain("Weight (kg): 0.16");
    expect(out).toContain("Poles: 2");
    expect(out).not.toContain("0.08");
    expect(out).not.toContain("0.24");
  });

  it("picks a different column for a different variant", () => {
    const out = buildVariantColumnContext(VARIANT_TABLE, "EIS-40/1");
    expect(out).toContain("Weight (kg): 0.08");
    expect(out).not.toContain("0.16");
  });

  it("returns undefined when the table has no header listing the target variant", () => {
    expect(buildVariantColumnContext(VARIANT_TABLE, "EIS-99/9")).toBeUndefined();
  });

  it("returns undefined for non-tabular single-product text", () => {
    const single = "Weight 0.08 kg\nRated current 40 A\nOperating temperature -25 to 60 C";
    expect(buildVariantColumnContext(single, "EIS-40/1")).toBeUndefined();
  });

  it("still picks up a row whose OTHER columns wrapped onto extra lines (Rockwell 1606-XLB datasheet)", () => {
    // Real layout from Rockwell's 1606-td002 family datasheet: "Weight" only has 3 tab cells on its
    // own line because the 3rd variant's value ("810 g") overflowed onto the next line — a strict
    // "row cell count must equal header cell count" rule used to drop this row for every variant.
    const text = [
      "Catalog Number \t1606-XLB120E \t1606-XLB240E \t1606-XLB480E",
      "Output Power \t120 W \t240 W \t480 W",
      "Weight \t370 g (0.82 lb) \t540 g",
      "(1.19 lb)",
      "810 g",
      "(1.79 lb)",
      "DC OK Relay Contact \tYes \tYes \tYes"
    ].join("\n");

    const first = buildVariantColumnContext(text, "1606-XLB120E");
    expect(first).toContain("Weight: 370 g (0.82 lb)");
    const second = buildVariantColumnContext(text, "1606-XLB240E");
    expect(second).toContain("Weight: 540 g");
  });

  it("reassembles a label whose value never fit the header row into evenly-sized per-column chunks", () => {
    // Real layout: "Dimensions" / "W x H x D" prints as a bare 2-line label, followed by one
    // metric+imperial line pair per variant column in column order, with no tabs at all.
    const text = [
      "Catalog Number \t1606-XLB120E \t1606-XLB240E \t1606-XLB480E",
      "Dimensions",
      "W x H x D",
      "39 x 124 x 124 mm",
      "(1.54 x 4.88 x 4.88 in.)",
      "49 x 124 x 124 mm",
      "(1.93 x 4.88 x 4.88 in.)",
      "59 x 124 x 127 mm",
      "(2.32 x 4.88 x 5 in.)",
      "DC OK Relay Contact \tYes \tYes \tYes"
    ].join("\n");

    const first = buildVariantColumnContext(text, "1606-XLB120E");
    expect(first).toContain("Dimensions W x H x D: 39 x 124 x 124 mm (1.54 x 4.88 x 4.88 in.)");
    expect(first).not.toContain("49 x 124 x 124 mm");

    const third = buildVariantColumnContext(text, "1606-XLB480E");
    expect(third).toContain("Dimensions W x H x D: 59 x 124 x 127 mm (2.32 x 4.88 x 5 in.)");
    expect(third).not.toContain("39 x 124 x 124 mm");
  });

  it("stops at the next comparison table's own header instead of absorbing it as more data", () => {
    // Real bug: a later table's header row ("Catalog Number \t1606-XLB120E \t...") has the same or
    // more cells as ours, so the old code's "does this row reach our column" check accepted it as
    // an ordinary data row (reading "Catalog Number: 1606-XLB240E" as if that were a real label:value
    // pair) and kept scanning straight through the rest of the document.
    const text = [
      "Catalog Number \t1606-XLB60BH \t1606-XLB36EH",
      "Weight \t225 g \t140 g",
      "DC OK Relay Contact \t— \t—",
      "Catalog Number \t1606-XLB120E \t1606-XLB240E \t1606-XLB480E",
      "Weight \t370 g \t540 g \t810 g"
    ].join("\n");

    const out = buildVariantColumnContext(text, "1606-XLB36EH");
    expect(out).toContain("Weight: 140 g");
    expect(out).not.toContain("Catalog Number");
    expect(out).not.toContain("370 g");
    expect(out).not.toContain("540 g");
  });

  it("does not mistake an ordinary hyphenated word (not a real catalog code) for a new table header", () => {
    // "Push-in" repeated across columns matches the same catalog-code-shaped regex a real model
    // number would (word-dash-word) but has no digit, unlike an actual catalog number — it must
    // NOT be treated as the start of a different comparison table.
    const text = [
      "Catalog Number \t1606-XLB60BH \t1606-XLB36EH",
      "Connection Terminals \tPush-in \tPush-in",
      "Weight \t225 g \t140 g"
    ].join("\n");

    const out = buildVariantColumnContext(text, "1606-XLB36EH");
    expect(out).toContain("Connection Terminals: Push-in");
    expect(out).toContain("Weight: 140 g");
  });

  it("does not mistake a decimal measurement-with-unit repeated across columns for a new table header", () => {
    // Real bug: "22.5V" matches CATALOG_LIKE_TOKEN_PATTERN's shape (digits, a "." separator, then
    // an alnum suffix) just like a real catalog code does, and it has a digit too — so the digit
    // requirement alone doesn't rule it out. Confirmed on Rockwell's 1606-td002 "Buffer Modules /
    // DC-UPS with Capacitor Storage" table: this row ends the scan early and drops Dimensions/Weight
    // (several rows further down) for every column.
    const text = [
      "Catalog Number \t1606-XLSCAP24-6 \t1606-XLSCAP24-12",
      "Buffer Current Max \t15 A \t15 A",
      "Voltage in Buffer-mode \t22.5V \t22.5V",
      "Dimensions, W x H x D \t126 x 124 x 117 mm \t198 x 124 x 117 mm",
      "Weight \t1150 g \t1720 g"
    ].join("\n");

    const out = buildVariantColumnContext(text, "1606-XLSCAP24-12");
    expect(out).toContain("Voltage in Buffer-mode: 22.5V");
    expect(out).toContain("Weight: 1720 g");
    expect(out).not.toContain("1150 g");
  });

  it("flushes a completed bare-continuation block before starting the next bare label with no row in between", () => {
    // Real bug: Rockwell's 1606-XLE480FP-D table prints "Weight" as a bare label (no tabs, no
    // value on its own line) immediately after a completed 2-line-per-column "Dimensions" block —
    // with no tab-separated row between them to signal the switch. The old code kept
    // "collecting" mode on, so "Weight" itself got swallowed as more Dimensions data and the real
    // Weight values were lost entirely.
    const text = [
      "Catalog Number \t1606-XLE120F \t1606-XLE480FP",
      "Output Power \t120 W \t480 W",
      "Dimensions",
      "W x H x D",
      "32 x 124 x 102 mm",
      "(1.26 x 4.88 x 4.02 in.)",
      "48 x 124 x 127 mm",
      "(2.56 x 4.88 x 5 in.)",
      "Weight",
      "440 g",
      "(0.97 lb)",
      "830 g",
      "(2.20 lb)",
      "DC-OK Relay Contact \tYes \tYes"
    ].join("\n");

    const out = buildVariantColumnContext(text, "1606-XLE480FP");
    expect(out).toContain("Dimensions W x H x D: 48 x 124 x 127 mm (2.56 x 4.88 x 5 in.)");
    expect(out).toContain("Weight: 830 g (2.20 lb)");
    expect(out).not.toContain("440 g");
  });

  it("matches the EXACT catalog column, not the first sibling whose name is a prefix of it", () => {
    // Real bug: "1606-XLE480FP" is a strict prefix of "1606-XLE480FP-D" (a different, real sibling
    // column in the same table). The header-matching scan used to stop at the first substring hit
    // in column order, so a query for "-D" silently reused the "480FP" column's values instead.
    const text = [
      "Catalog Number \t1606-XLE480FP \t1606-XLE480FP-D",
      "Output Power \t480 W \t480 W",
      "Weight \t830 g \t940 g"
    ].join("\n");

    const out = buildVariantColumnContext(text, "1606-XLE480FP-D");
    expect(out).toContain("Weight: 940 g");
    expect(out).not.toContain("830 g");
  });

  it("drops an orphaned continuation fragment instead of corrupting the next label's value block", () => {
    // Real bug: a footnote-style wrapped continuation with no label of its own ("Screw (-XLB60E)"
    // clarifying which earlier column uses screw vs push-in terminals) used to flip on "collecting"
    // mode with no pending label, and that stuck state then swallowed the NEXT real label
    // ("Dimensions") as if it were more of the same orphaned block, corrupting its per-column count.
    const text = [
      "Catalog Number \t1606-XLB60BH \t1606-XLB36EH",
      "Connection Terminals \tPush-in \tPush-in",
      "Screw (-XLB60E)",
      "Dimensions",
      "W x H x D",
      "36 x 90 x 91 mm",
      "(1.42 x 3.54 x 3.58 in.)",
      "22.5 x 90 x 91 mm",
      "(0.89 x 3.54 x 3.58 in.)",
      "Weight \t225 g \t140 g"
    ].join("\n");

    const first = buildVariantColumnContext(text, "1606-XLB60BH");
    expect(first).toContain("Dimensions W x H x D: 36 x 90 x 91 mm (1.42 x 3.54 x 3.58 in.)");
    const second = buildVariantColumnContext(text, "1606-XLB36EH");
    expect(second).toContain("Dimensions W x H x D: 22.5 x 90 x 91 mm (0.89 x 3.54 x 3.58 in.)");
  });

  it("uses a data row's real cell count when the header row itself under-counts columns", () => {
    // Real bug: pdf-parse's own tab-insertion for the HEADER row can produce fewer cells than the
    // data rows below it (confirmed on Rockwell's 1606-td002: a 4-model header line only split into
    // 2 catalog cells). Column count for chunking a wrapped label's continuation-line run must come
    // from an actual data row's cell count, not blindly from the (possibly under-counted) header.
    const text = [
      // Only 2 of the real 3 columns appear as separate header cells.
      "Catalog Number \t1606-XLB60BH \t1606-XLB36EH",
      "Output Voltage, Nom \t12V \t24V \t24V",
      "Dimensions",
      "W x H x D",
      "36 x 90 x 91 mm",
      "22.5 x 90 x 91 mm",
      "20 x 90 x 91 mm",
      "Weight \t225 g \t140 g \t130 g"
    ].join("\n");

    const out = buildVariantColumnContext(text, "1606-XLB36EH");
    expect(out).toContain("Dimensions W x H x D: 22.5 x 90 x 91 mm");
    expect(out).not.toContain("36 x 90 x 91 mm");
    expect(out).not.toContain("20 x 90 x 91 mm");
  });

  it("keeps the ordering row immediately above a matched catalog row", () => {
    const text = [
      "Rated current",
      "(A)",
      "Rated power",
      "(kW)",
      "4DI/2DO 3 \t0.75 \t- \tRASP5G-0420A31-4120000S1-000 \tRASP5G-0420A31-412R000S1-000",
      "CDVRL00073 \tCDVRL00001",
      "DC180V \tRASP5G-0421A31-4120000S1-000 \tRASP5G-0421A31-412R000S1-000",
      "CDVRL00079 \tCDVRL00007"
    ].join("\n");

    const out = buildTightContextForCatalog(text, "CDVRL00001");

    expect(out).toContain("4DI/2DO 3");
    expect(out).toContain("0.75");
    expect(out).toContain("CDVRL00001");
  });
});
