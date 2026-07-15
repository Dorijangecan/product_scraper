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

  it("recovers the LAST column's own value when it overflows onto bare continuation lines below the row (Rockwell 1606-XLB480E)", () => {
    // Same real layout as above: "540 g" (2nd column) is missing its "(1.19 lb)" suffix on the row
    // itself, and the 3rd column's whole value ("810 g (1.79 lb)") is bare-line-only. The first bare
    // line completes the 2nd column (dropped, since we don't need it); only the remaining bare lines
    // belong to our own (3rd) column.
    const text = [
      "Catalog Number \t1606-XLB120E \t1606-XLB240E \t1606-XLB480E",
      "Output Power \t120 W \t240 W \t480 W",
      "Weight \t370 g (0.82 lb) \t540 g",
      "(1.19 lb)",
      "810 g",
      "(1.79 lb)",
      "DC OK Relay Contact \tYes \tYes \tYes"
    ].join("\n");

    const out = buildVariantColumnContext(text, "1606-XLB480E");
    expect(out).toContain("Weight: 810 g (1.79 lb)");
    expect(out).not.toContain("(1.19 lb) 810 g");
  });

  it("finds the header column for a catalog whose name never appears tab-separated, only as its own bare line below a bare 'Catalog Number' label (Rockwell 1606-XLB 7-model table)", () => {
    // Real layout: only the first 2 catalog names share a tab-separated line with "Catalog Number";
    // the other 5 spill one per bare line before the data rows start. Near-identical siblings that
    // differ only by a trailing suffix letter ("...60E" vs "...60EH") share one printed data column.
    const text = [
      "Catalog Number \t1606-XLB60BH \t1606-XLB36EH",
      "1606-XLB60EH",
      "1606-XLB60E",
      "1606-XLB90EH",
      "1606-XLB90E",
      "1606-XLB90EQ",
      "Output Voltage, Nom \t12V \t24V \t24V \t24V",
      "Weight \t225 g (0.50 lb) \t140 g (0.31 lb) \t220 g (0.49 lb) \t270 g (0.60 lb)"
    ].join("\n");

    const bh = buildVariantColumnContext(text, "1606-XLB60BH");
    expect(bh).toContain("Weight: 225 g (0.50 lb)");
    const eh = buildVariantColumnContext(text, "1606-XLB60EH");
    expect(eh).toContain("Weight: 220 g (0.49 lb)");
    const e = buildVariantColumnContext(text, "1606-XLB60E");
    expect(e).toContain("Weight: 220 g (0.49 lb)");
    const ninetyQ = buildVariantColumnContext(text, "1606-XLB90EQ");
    expect(ninetyQ).toContain("Weight: 270 g (0.60 lb)");
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

  it("anchors on a bare 'Catalog Number' label line and absorbs every following all-variant line regardless of how many names are on each one (Rockwell 1606-XLE480FP family)", () => {
    // Real layout: the header label line itself carries only ONE name (not the 2+ the old
    // per-line detection required), so it never qualified as a header candidate on its own —
    // sending the search past the whole table looking for a LATER one that mentioned the catalog,
    // which occasionally matched a wrong table instead.
    const text = [
      "Catalog Number \t1606-XLE120F",
      "1606-XLE260F",
      "1606-XLE480FP",
      "Output Voltage, Nom \t48V \t48V \t48V",
      "Weight \t600 g \t700 g \t830 g"
    ].join("\n");

    const out = buildVariantColumnContext(text, "1606-XLE480FP");
    expect(out).toContain("Weight: 830 g");
  });

  it("refuses to guess a merged-column table it can't reliably reconstruct instead of returning a plausible-looking wrong value", () => {
    // Real bug: 1606-XLE120B/192BM/192BDM/80E/120E/120EC/120EL/120EH/120ED/120EN/120EE (11 names)
    // print as only 6 real data columns in Rockwell's 1606-td002 — and some of the real merges
    // (e.g. "...192BM" / "...192BDM") don't share a compact prefix at all, so tokensShareColumn's
    // heuristic can't resolve them and produces the wrong number of slots. Silence is safer than a
    // value that looks plausible but belongs to the wrong catalog.
    const text = [
      "Catalog Number \t1606-XLE120B",
      "1606-XLE192BM",
      "1606-XLE192BDM \t1606-XLE80E",
      "1606-XLE120E",
      "1606-XLE120EC",
      "1606-XLE120EL",
      "1606-XLE120EH",
      "1606-XLE120ED \t1606-XLE120EN \t1606-XLE120EE",
      "Output Voltage, Nom \t12V \t12V \t24V \t24V \t24V \t24V",
      "Weight \t600 g \t430 g \t440 g \t500 g \t500 g \t500 g"
    ].join("\n");

    expect(buildVariantColumnContext(text, "1606-XLE120EL")).toBeUndefined();
    expect(buildVariantColumnContext(text, "1606-XLE192BDM")).toBeUndefined();
  });

  it("does not return concatenated garbage for the LAST column of a merged-adjacent-value row (Rockwell 1606-XLS480G/240F/240F-D/480F/960F/960FE)", () => {
    // Real bug: this table's real datasheet rows sometimes render two adjacent columns' IDENTICAL
    // value as a single spanning cell during PDF layout (not a naming quirk like the tests above —
    // the VALUES themselves collapse), producing one fewer tab-separated cell than there are real
    // columns. "Output Voltage, Nom" below has only 5 values for 6 columns. For 1606-XLS960FE (the
    // LAST/rightmost column), buildVariantColumnContext must not fabricate a value by reading past
    // the row's real cells or gluing fragments together — silence is the correct, safe outcome here
    // (the positioned-table reader in pdf-positioned-table.ts, which works from real X coordinates
    // instead of sequential cell counting, is immune to this and is what document-enrichment.ts's
    // extractPositionedWeightDimensionsSafely now falls back to for Voltage/Current).
    const text = [
      "Catalog Number \t1606-XLS480G \t1606-XLS240F \t1606-XLS240F-D \t1606-XLS480F \t1606-XLS960F \t1606-XLS960FE",
      "Output Power \t120 W \t240 W \t240 W \t480 W \t960 W \t960 W",
      "Output Voltage, Nom \t36V \t48V \t48V \t48V \t48V",
      "Weight \t1200g \t900g \t1200g \t1900g \t1800g"
    ].join("\n");

    const out = buildVariantColumnContext(text, "1606-XLS960FE");
    expect(out).toContain("Output Power: 960 W");
    // No fabricated/duplicated Voltage or Weight value for the merged-away last column, and
    // critically no concatenation of another column's or another row's text into one garbled value.
    expect(out).not.toMatch(/Output Voltage, Nom:.*Output Voltage, Nom:/);
    expect(out).not.toMatch(/Weight:.*Weight:/);
    if (out?.includes("Output Voltage, Nom:")) {
      expect(out).not.toMatch(/Output Voltage, Nom:\s*48V\s*48V/);
    }
  });

  it("does not let an unreconstructable table's failure send the search into a later, wrong table via loose substring matching", () => {
    // Real bug: once the ambiguous 1606-XLE120E-family table (above) gave up on "1606-XLE120E",
    // the search used to keep scanning and land on a LATER table's "1606-XLE120E-2" column via the
    // loose substring fallback ("1606-XLE120E" is a substring of "1606-XLE120E-2") — a different,
    // real sibling product with different specs entirely.
    const text = [
      "Catalog Number \t1606-XLE120B",
      "1606-XLE192BM",
      "1606-XLE192BDM \t1606-XLE80E",
      "1606-XLE120E",
      "1606-XLE120EC",
      "1606-XLE120EL",
      "1606-XLE120EH",
      "1606-XLE120ED \t1606-XLE120EN \t1606-XLE120EE",
      "Output Voltage, Nom \t12V \t12V \t24V \t24V \t24V \t24V",
      "Catalog Number \t1606-XLE96B-2 \t1606-XLE120E-2 \t1606-XLE240E-3",
      "Output Voltage, Nom \t12V \t24V \t24V",
      "Weight \t900 g \t950 g \t1000 g"
    ].join("\n");

    expect(buildVariantColumnContext(text, "1606-XLE120E")).toBeUndefined();
  });

  it("reaches a table's shared header past several sibling rows that each name a DIFFERENT catalog (Rockwell 1606-XLS 'Battery Modules' table)", () => {
    // Real bug: a simple one-catalog-per-row ordering table (unlike the multi-column comparison
    // tables above) has EVERY intervening row mention its own, different catalog number — which
    // normally makes the backward window stop right after the first sibling, long before reaching
    // the header several rows further up (1606-XLSBATSEN sits 13 lines below its table's header).
    const text = [
      "Battery Modules for DC-UPS",
      "Description \tDimensions \tCatalog Number",
      "12V, 5 Ah battery replacement for 1606-XLS240-UPSC \t90 x 106 x 70 mm \t1606-XLSBAT5",
      "12V, 7 Ah battery replacement for 1606-XLSBATASSY1 \t151 x 98 x 65 mm \t1606-XLSBAT1",
      "12V, 7 Ah battery module for 1606-XLS2408-UPS_ \t155 x 124 x 112 mm \t1606-XLSBATASSY1",
      "12V, 7 Ah battery module \t158 x 132 x 98 mm \t1606-XLSBATASSY1W",
      "12V, 26 Ah battery module for 1606-XLS240-UPS_ \t214 x 179 x 158 mm \t1606-XLSBATASSY2",
      "24V, 7 Ah battery module for 1606-XLS480-UPS_ \t137 x 186 x 143 mm \t1606-XLSBATASSY3",
      "24V, 12 Ah battery module for 1606-XLS480-UPS_ \t203 x 186 x 143 mm \t1606-XLSBATASSY4",
      "Same as 1606-XLSBATASSY1 battery module but without battery \t155 x 124 x 112 mm \t1606-XLSBATBR1",
      "Sensor board with PT1000 temperature sensor \t23 x 15 x 110.5 mm \t1606-XLSBATSEN"
    ].join("\n");

    const out = buildTightContextForCatalog(text, "1606-XLSBATSEN");
    expect(out).toContain("Description \tDimensions \tCatalog Number");
    expect(out).toContain("1606-XLSBATSEN");
  });
});
