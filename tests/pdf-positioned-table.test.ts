import { describe, expect, it } from "vitest";
import { extractPositionedOrderingRow, extractPositionedTableRows, extractPositionedWeightAndDimensions, mergePositionedTableRowSets, positionedItemOrientationFromTransform, type PositionedTextItem } from "../src/server/scrapers/pdf-positioned-table.js";

/**
 * Coordinates below mirror the real 1606-XLE120E-family table on page 21 of Rockwell's
 * 1606-td002 datasheet (confirmed via a raw positioned-text dump against the actual PDF):
 * 6 real data columns (120B / {192BM,192BDM} / 80E / {120E,120EC,120EL,120EH,120ED} / 120EN /
 * 120EE) squeezed from 11 catalog names, several of which don't share any compact text prefix
 * ("...192BM" vs "...192BDM" diverge one character before the end) — unresolvable by any
 * text/tab heuristic, but unambiguous by x position.
 */
const HEADER_ITEMS: PositionedTextItem[] = [
  { text: "Catalog Number", x: 47, y: 615 },
  { text: "1606-XLE120B", x: 124, y: 615 },
  { text: "1606-XLE192BM", x: 194, y: 623 },
  { text: "1606-XLE192BDM", x: 192, y: 615 },
  { text: "1606-XLE80E", x: 270, y: 615 },
  { text: "1606-XLE120E", x: 361, y: 647 },
  { text: "1606-XLE120EC", x: 359, y: 639 },
  { text: "1606-XLE120EL", x: 359, y: 631 },
  { text: "1606-XLE120EH", x: 359, y: 623 },
  { text: "1606-XLE120ED", x: 359, y: 615 },
  { text: "1606-XLE120EN", x: 452, y: 615 },
  { text: "1606-XLE120EE", x: 516, y: 615 }
];

const DIMENSIONS_ROW: PositionedTextItem[] = [
  { text: "W x H x D", x: 47, y: 212 },
  { text: "32 x 124 x 102 mm", x: 125, y: 216 },
  { text: "(1.26 x 4.88 x 4.02 in.)", x: 115, y: 212 },
  { text: "39 x 124 x 117 mm", x: 197, y: 216 },
  { text: "(1.54 x 4.88 x 4.61 in.)", x: 188, y: 212 },
  { text: "32 x 124 x 102 mm", x: 269, y: 216 },
  { text: "(1.26 x 4.88 x 4.02 in.)", x: 260, y: 212 },
  { text: "32 x 124 x 102 mm", x: 362, y: 216 },
  { text: "(1.26 x 4.88 x 4.02 in.)", x: 352, y: 212 },
  { text: "32 x 124 x 117 mm", x: 455, y: 216 },
  { text: "(1.26 x 4.88 x 4.61 in.)", x: 445, y: 212 },
  { text: "32 x 124 x 117 mm", x: 519, y: 216 },
  { text: "(1.26 x 4.88 x 4.61 in.)", x: 510, y: 212 }
];

const WEIGHT_ROW: PositionedTextItem[] = [
  { text: "Weight", x: 47, y: 184 },
  { text: "440 g (0.97 lb)", x: 125, y: 192 },
  { text: "600 g (1.32 lb)", x: 197, y: 192 },
  { text: "430 g (0.95 lb)", x: 269, y: 192 },
  { text: "440 g (0.97 lb)", x: 362, y: 192 },
  { text: "500 g (1.10 lb)", x: 455, y: 192 },
  { text: "500 g (1.10 lb)", x: 519, y: 192 }
];

const ALL_ITEMS = [...HEADER_ITEMS, ...DIMENSIONS_ROW, ...WEIGHT_ROW];

describe("extractPositionedWeightAndDimensions", () => {
  it("finds the right column for a catalog whose header name sits alone in the anchor row", () => {
    expect(extractPositionedWeightAndDimensions(ALL_ITEMS, "1606-XLE120B")).toEqual({
      weight: "440 g (0.97 lb)",
      dimensions: "32 x 124 x 102 mm (1.26 x 4.88 x 4.02 in.)"
    });
  });

  it("merges catalog names stacked at the same x even when their compact names share no prefix", () => {
    // "1606-XLE192BM" and "1606-XLE192BDM" diverge one character before the end ("...b-m" vs
    // "...b-d-m") — no text-based prefix heuristic can group them, but they sit at the same x.
    expect(extractPositionedWeightAndDimensions(ALL_ITEMS, "1606-XLE192BM")).toEqual({
      weight: "600 g (1.32 lb)",
      dimensions: "39 x 124 x 117 mm (1.54 x 4.88 x 4.61 in.)"
    });
    expect(extractPositionedWeightAndDimensions(ALL_ITEMS, "1606-XLE192BDM")).toEqual({
      weight: "600 g (1.32 lb)",
      dimensions: "39 x 124 x 117 mm (1.54 x 4.88 x 4.61 in.)"
    });
  });

  it("merges 5 catalog names stacked in one column, matching every one of them to the same value", () => {
    const shared = {
      weight: "440 g (0.97 lb)",
      dimensions: "32 x 124 x 102 mm (1.26 x 4.88 x 4.02 in.)"
    };
    for (const catalog of ["1606-XLE120E", "1606-XLE120EC", "1606-XLE120EL", "1606-XLE120EH", "1606-XLE120ED"]) {
      expect(extractPositionedWeightAndDimensions(ALL_ITEMS, catalog)).toEqual(shared);
    }
  });

  it("does not confuse two adjacent, genuinely distinct columns", () => {
    expect(extractPositionedWeightAndDimensions(ALL_ITEMS, "1606-XLE120EN")).toEqual({
      weight: "500 g (1.10 lb)",
      dimensions: "32 x 124 x 117 mm (1.26 x 4.88 x 4.61 in.)"
    });
    expect(extractPositionedWeightAndDimensions(ALL_ITEMS, "1606-XLE120EE")).toEqual({
      weight: "500 g (1.10 lb)",
      dimensions: "32 x 124 x 117 mm (1.26 x 4.88 x 4.61 in.)"
    });
  });

  it("returns undefined when the catalog isn't mentioned in this table at all", () => {
    expect(extractPositionedWeightAndDimensions(ALL_ITEMS, "1606-XLB60E")).toBeUndefined();
  });
});

// Coordinates below mirror the real 1606-XLB90E/90EH/90EQ table (1606-td002.pdf) — a merged
// column (90EH/90E/90EQ share electrical specs) whose Connection Terminals row is the one place
// they genuinely differ, distinguished only by a per-name footnote in the printed value itself.
const FOOTNOTE_HEADER: PositionedTextItem[] = [
  { text: "Catalog Number", x: 47, y: 400 },
  { text: "1606-XLB60BH", x: 124, y: 400 },
  { text: "1606-XLB90EH", x: 280, y: 408 },
  { text: "1606-XLB90E", x: 280, y: 400 },
  { text: "1606-XLB90EQ", x: 280, y: 392 }
];
const FOOTNOTE_ROWS: PositionedTextItem[] = [
  { text: "Output Voltage, Nom", x: 47, y: 380 },
  { text: "12V", x: 139, y: 384 },
  { text: "24V", x: 283, y: 384 },
  { text: "Connection Terminals", x: 47, y: 320 },
  { text: "Push-in", x: 139, y: 316 },
  { text: "Push-in (-XLB90EH)", x: 283, y: 316 },
  { text: "Screw (-XLB90E, -XLB90EQ)", x: 283, y: 312 }
];
const FOOTNOTE_ITEMS = [...FOOTNOTE_HEADER, ...FOOTNOTE_ROWS];

describe("extractPositionedTableRows", () => {
  it("returns every labeled row for the matched column, mapping W x H x D through as its own key", () => {
    const rows = extractPositionedTableRows(ALL_ITEMS, "1606-XLE120EL");
    expect(rows).toMatchObject({
      Weight: "440 g (0.97 lb)",
      "W x H x D": "32 x 124 x 102 mm (1.26 x 4.88 x 4.02 in.)"
    });
  });

  it("keeps a footnoted value distinct per merged sibling instead of losing it to the shared column", () => {
    // 90EH/90E/90EQ share electrical specs (one merged column) but differ on Connection
    // Terminals, printed as a single cell containing both footnoted variants — the real value
    // for any one of them is the WHOLE cell text, footnotes and all, not a de-duplicated pick.
    const rows = extractPositionedTableRows(FOOTNOTE_ITEMS, "1606-XLB90E");
    expect(rows?.["Connection Terminals"]).toContain("Push-in (-XLB90EH)");
    expect(rows?.["Connection Terminals"]).toContain("Screw (-XLB90E, -XLB90EQ)");
    expect(rows?.["Output Voltage, Nom"]).toBe("24V");
  });

  it("returns undefined when the catalog isn't mentioned in this table at all", () => {
    expect(extractPositionedTableRows(ALL_ITEMS, "1606-XLB60E")).toBeUndefined();
  });

  it("keeps a table's row boundary when another table starts beside it on the same header line", () => {
    // Landscape datasheets often put independent comparison tables side-by-side. Both id labels
    // share y=500, so treating the next anchor as a vertical boundary would make the left table
    // have an empty data interval (y must be both <500 and >500).
    const sideBySide: PositionedTextItem[] = [
      { text: "Catalog Number", x: 40, y: 500 },
      { text: "LEFT-100", x: 150, y: 500 },
      { text: "LEFT-200", x: 250, y: 500 },
      { text: "Catalog Number", x: 420, y: 500 },
      { text: "RIGHT-100", x: 530, y: 500 },
      { text: "RIGHT-200", x: 630, y: 500 },
      { text: "Weight", x: 40, y: 460 },
      { text: "1 kg", x: 150, y: 460 },
      { text: "2 kg", x: 250, y: 460 },
      { text: "Weight", x: 420, y: 460 },
      { text: "3 kg", x: 530, y: 460 },
      { text: "4 kg", x: 630, y: 460 }
    ];

    expect(extractPositionedTableRows(sideBySide, "LEFT-200")).toEqual({ Weight: "2 kg" });
    expect(extractPositionedTableRows(sideBySide, "RIGHT-200")).toEqual({ Weight: "4 kg" });
  });

  it("normalizes a whole quarter-turn rotated comparison table before matching columns", () => {
    // Simulates PDF.js coordinates for the same table printed 90° clockwise: x=-originalY,
    // y=originalX and every glyph baseline's transform points vertically.
    const rotated = ALL_ITEMS.map((item) => ({ ...item, x: -item.y, y: item.x, orientation: 90 as const }));
    expect(extractPositionedWeightAndDimensions(rotated, "1606-XLE120EL")).toEqual({
      weight: "440 g (0.97 lb)",
      dimensions: "32 x 124 x 102 mm (1.26 x 4.88 x 4.02 in.)"
    });
    expect(positionedItemOrientationFromTransform([0, 9, -9, 0, 120, 240])).toBe(90);
    expect(positionedItemOrientationFromTransform([-9, 0, 0, -9, 120, 240])).toBe(180);
  });

  it("projects only a proven vertical SKU-header layer on an otherwise horizontal table", () => {
    const mixed = ALL_ITEMS.map((item, index) =>
      index < HEADER_ITEMS.length ? { ...item, x: -item.y, y: item.x, orientation: 90 as const } : item
    );
    expect(extractPositionedWeightAndDimensions(mixed, "1606-XLE120EL")).toEqual({
      weight: "440 g (0.97 lb)",
      dimensions: "32 x 124 x 102 mm (1.26 x 4.88 x 4.02 in.)"
    });
  });

  it("calibrates narrow SKU columns instead of merging neighboring values at Rockwell's x tolerance", () => {
    const narrow: PositionedTextItem[] = [
      { text: "Catalog Number", x: 10, y: 100 },
      { text: "NARROW-1", x: 50, y: 100 },
      { text: "NARROW-2", x: 70, y: 100 },
      { text: "NARROW-3", x: 90, y: 100 },
      { text: "Weight", x: 10, y: 80 },
      { text: "1 kg", x: 50, y: 80 },
      { text: "2 kg", x: 70, y: 80 },
      { text: "3 kg", x: 90, y: 80 }
    ];
    expect(extractPositionedTableRows(narrow, "NARROW-2")).toEqual({ Weight: "2 kg" });
  });
});

describe("positioned table continuation pages", () => {
  it("keeps complementary rows but suppresses a conflicting label instead of trusting page order", () => {
    expect(mergePositionedTableRowSets([
      { Weight: "1 kg", Voltage: "24 V" },
      { Dimensions: "10 x 20 x 30 mm", Voltage: "48 V" },
      { Weight: "1 kg" }
    ])).toEqual({ Weight: "1 kg", Dimensions: "10 x 20 x 30 mm" });
  });

  it("uses the previous page's real header positions for a continuation page that repeats only data rows", () => {
    // Continuation pages of the recorded Rockwell comparison table retain the same x grid but not
    // the multi-model header. The target SKU is therefore known only from HEADER_ITEMS above.
    const continuation: PositionedTextItem[] = [
      { text: "Rated current", x: 47, y: 500 },
      { text: "5 A", x: 125, y: 500 },
      { text: "10 A", x: 197, y: 500 },
      { text: "8 A", x: 269, y: 500 },
      { text: "12 A", x: 362, y: 500 },
      { text: "16 A", x: 455, y: 500 },
      { text: "20 A", x: 519, y: 500 }
    ];

    expect(extractPositionedTableRows(continuation, "1606-XLE120EL", HEADER_ITEMS)).toEqual({
      "Rated current": "12 A"
    });
  });
});

// Row-oriented ordering-table shape: each catalog is one visual row, so the
// column-comparison reader above is intentionally inapplicable. Coordinates
// mirror the common PDF layout (headers and values have small independent y
// offsets due to font baselines).
const ROW_ORIENTED_ORDERING_TABLE: PositionedTextItem[] = [
  { text: "Catalog Number", x: 45, y: 500 },
  { text: "Rated current", x: 190, y: 501 },
  { text: "Rated power", x: 300, y: 500 },
  { text: "Control voltage", x: 410, y: 499 },
  { text: "ABC-100", x: 45, y: 480 },
  { text: "4 A", x: 190, y: 479 },
  { text: "0.75 kW", x: 300, y: 481 },
  { text: "24 V DC", x: 410, y: 480 },
  { text: "ABC-200", x: 45, y: 462 },
  { text: "8 A", x: 190, y: 461 },
  { text: "1.5 kW", x: 300, y: 463 },
  { text: "48 V DC", x: 410, y: 462 }
];

describe("extractPositionedOrderingRow", () => {
  it("uses the page's measured line scale instead of merging dense data rows into the header", () => {
    // The source PDFs can use a much denser font than Rockwell's 18-point row spacing. Header
    // glyphs still share a 1-point baseline jitter, but the first data row begins only 3 points
    // below them. The old fixed 5-point grouping swallowed ABC-100 into the header cluster.
    const dense: PositionedTextItem[] = [
      { text: "Catalog Number", x: 10, y: 100 },
      { text: "Rated current", x: 120, y: 99 },
      { text: "ABC-100", x: 10, y: 96 },
      { text: "4 A", x: 120, y: 95 },
      { text: "ABC-200", x: 10, y: 91 },
      { text: "8 A", x: 120, y: 90 }
    ];

    expect(extractPositionedOrderingRow(dense, "ABC-100")).toEqual({ "Rated current": "4 A" });
  });

  it("maps the exact catalog's visual row onto its headers without inheriting a sibling", () => {
    expect(extractPositionedOrderingRow(ROW_ORIENTED_ORDERING_TABLE, "ABC-200")).toEqual({
      "Rated current": "8 A",
      "Rated power": "1.5 kW",
      "Control voltage": "48 V DC"
    });
  });

  it("does not use a strict-prefix sibling row as a match", () => {
    expect(extractPositionedOrderingRow(ROW_ORIENTED_ORDERING_TABLE, "ABC-20")).toBeUndefined();
  });

  it("maps an exact catalog from the final column onto property headers to its left", () => {
    const trailingCatalog: PositionedTextItem[] = [
      { text: "Dimensions", x: 40, y: 500 },
      { text: "Color", x: 210, y: 500 },
      { text: "Pkg Qty.", x: 300, y: 500 },
      { text: "Cat. No.", x: 390, y: 500 },
      { text: "8 x 56 x 47 mm", x: 40, y: 480 },
      { text: "Grey", x: 210, y: 480 },
      { text: "100", x: 300, y: 480 },
      { text: "1492-EAJ35", x: 390, y: 480 }
    ];

    expect(extractPositionedOrderingRow(trailingCatalog, "1492-EAJ35")).toEqual({
      Dimensions: "8 x 56 x 47 mm",
      Color: "Grey",
      "Pkg Qty.": "100"
    });
  });

  it("recognizes a 'PART #' id header instead of only 'Cat. No.'/'Part No.'", () => {
    // Coordinates mirror the real Saginaw/SCE floor-stand-hole-layout.pdf ordering table
    // (transcribed from a raw pdfjs-dist text-content dump of the actual PDF, see
    // fixtures/sce-fk0618-floor-stand-manual). The id column header is literally "PART #" — a
    // hash sign rather than "No."/"Number" — which isCatalogIdHeaderCell previously rejected, so
    // this whole table silently produced nothing for every catalog in it.
    const floorStandTable: PositionedTextItem[] = [
      { text: "PART #", x: 298.8, y: 618.8 },
      { text: "A", x: 364.2, y: 618.8 },
      { text: "B", x: 400.9, y: 618.8 },
      { text: "SCE-FK0618", x: 290.7, y: 569.4 },
      { text: "6.00", x: 358.8, y: 569.4 },
      { text: "18.00", x: 393.8, y: 569.4 },
      { text: "SCE-FK0624", x: 290.0, y: 557.5 },
      { text: "6.00", x: 358.8, y: 557.5 },
      { text: "24.00", x: 393.1, y: 557.5 }
    ];

    expect(extractPositionedOrderingRow(floorStandTable, "SCE-FK0618")).toEqual({ A: "6.00", B: "18.00" });
  });
});

// Coordinates below mirror TWO real tables from 1606-td002.pdf: an EARLIER, unrelated
// "100…240V AC/DC, Continued" table (page 22) whose header includes the shorter, genuinely
// DIFFERENT sibling catalog "1606-XLE240E", followed by the LATER "Power Supplies with Integrated
// Decoupling Function" table (page 25) where "1606-XLE240ERL" is its own exact header. Confirmed
// live: matching "1606-XLE240ERL" against these tables used to silently accept the wrong, earlier
// page's "1606-XLE240E" column via a boundary-unsafe substring fallback (compact "1606xle240e" is a
// literal string-prefix of compact "1606xle240erl") and return that column's WRONG values
// (Adjustment Range "24…28V" instead of the correct "Fixed") — a sibling-catalog collision of
// exactly the kind [[rockwell-sibling-catalog-collision]] already fixed in rockwell.ts, but not in
// this module's own header matcher.
const WRONG_EARLIER_TABLE: PositionedTextItem[] = [
  { text: "Catalog Number", x: 47, y: 700 },
  { text: "1606-XLE240E", x: 150, y: 700 },
  { text: "1606-XLE240EP", x: 148, y: 692 },
  { text: "Adjustment Range", x: 47, y: 660 },
  { text: "24…28V", x: 150, y: 656 }
];
const CORRECT_LATER_TABLE: PositionedTextItem[] = [
  { text: "Catalog Number", x: 47, y: 620 },
  { text: "1606-XLE240ERL", x: 150, y: 620 },
  { text: "1606-XLE480ERL", x: 300, y: 620 },
  { text: "Adjustment Range", x: 47, y: 580 },
  { text: "Fixed", x: 150, y: 576 },
  { text: "Fixed", x: 300, y: 576 }
];

// A generic family/comparison table from a NON-Rockwell datasheet: no literal "Catalog Number"
// header at all — just a header row of two model codes and a left-hand row-label column. The
// generalized anchor (variant-token header row + leftmost label column) must handle this.
const GENERIC_NO_ID_LABEL: PositionedTextItem[] = [
  { text: "ABC-100", x: 150, y: 500 },
  { text: "ABC-200", x: 300, y: 500 },
  { text: "W x H x D", x: 47, y: 430 },
  { text: "10 x 20 x 30 mm", x: 150, y: 430 },
  { text: "40 x 50 x 60 mm", x: 300, y: 430 },
  { text: "Weight", x: 47, y: 460 },
  { text: "1.5 kg", x: 152, y: 462 },
  { text: "2.0 kg", x: 302, y: 462 }
];

// A German ordering table anchored on "Bestell-Nr." instead of "Catalog Number".
const GERMAN_ID_LABEL: PositionedTextItem[] = [
  { text: "Bestell-Nr.", x: 47, y: 500 },
  { text: "XYZ-1", x: 150, y: 500 },
  { text: "XYZ-2", x: 300, y: 500 },
  { text: "Gewicht", x: 47, y: 460 },
  { text: "0.5 kg", x: 150, y: 462 },
  { text: "0.9 kg", x: 300, y: 462 }
];

// Our exact catalog printed in TWO different columns of the same header — genuinely ambiguous.
const AMBIGUOUS_HEADER: PositionedTextItem[] = [
  { text: "DUP-1", x: 150, y: 500 },
  { text: "DUP-1", x: 300, y: 500 },
  { text: "Weight", x: 47, y: 460 },
  { text: "1.0 kg", x: 150, y: 462 },
  { text: "2.0 kg", x: 300, y: 462 }
];

// Rockwell 1606-TD002H p.25 prints the label in two horizontal fragments:
// `Output` at x=46.98 and `Current, Nom` at x=66.95, while the first target
// value starts at x=182.76. The latter is still label-column text, not a
// second column value. Keeping only the left-most fragment makes the
// positioned reader return `{ Output: "10 A" }`, which the normalizer cannot
// recognize as current and lets a generic `10 A / 20 A` sibling merge win.
const HORIZONTAL_LABEL_FRAGMENT: PositionedTextItem[] = [
  { text: "Catalog Number", x: 47, y: 700 },
  { text: "1606-XLE240ERL", x: 180, y: 700 },
  { text: "1606-XLE240ERZ", x: 250, y: 700 },
  { text: "Output", x: 47, y: 650 },
  { text: "Current, Nom", x: 67, y: 650 },
  { text: "10 A", x: 183, y: 653 },
  { text: "10 A", x: 252, y: 653 }
];

describe("generalized anchor (works beyond Rockwell's 'Catalog Number' header)", () => {
  it("joins horizontal label fragments that end before the first data column", () => {
    expect(extractPositionedTableRows(HORIZONTAL_LABEL_FRAGMENT, "1606-XLE240ERL")).toEqual({
      "Output Current, Nom": "10 A"
    });
  });

  it("resolves a column with no id-label at all, via the variant-token header row + left label column", () => {
    expect(extractPositionedWeightAndDimensions(GENERIC_NO_ID_LABEL, "ABC-100")).toEqual({
      weight: "1.5 kg",
      dimensions: "10 x 20 x 30 mm"
    });
    expect(extractPositionedWeightAndDimensions(GENERIC_NO_ID_LABEL, "ABC-200")).toEqual({
      weight: "2.0 kg",
      dimensions: "40 x 50 x 60 mm"
    });
  });

  it("uses a headerless comparison grid above a lower explicit ordering table", () => {
    // Allen-Bradley 1492 p.12-8 first prints a J3/J4/J6 comparison grid and then an unrelated
    // Cat. No. ordering table lower on the same page. Returning early for any explicit header
    // used to skip the upper grid and let the text sweep concatenate J4/J6 currents into J3.
    const topComparisonThenOrdering: PositionedTextItem[] = [
      { text: "1492-J3", x: 210, y: 700 },
      { text: "1492-J4", x: 350, y: 700 },
      { text: "1492-J6", x: 478, y: 700 },
      // Repeated electrical notation looks delimiter-shaped but is not a catalog header.
      { text: "AC/DC", x: 184, y: 620 },
      { text: "AC/DC", x: 312, y: 620 },
      { text: "AC/DC", x: 454, y: 620 },
      { text: "Maximum Current", x: 50, y: 650 },
      { text: "25 A", x: 184, y: 650 },
      { text: "20 A", x: 215, y: 650 },
      { text: "24 A", x: 246, y: 650 },
      { text: "21 A", x: 279, y: 650 },
      { text: "35 A", x: 312, y: 650 },
      { text: "50 A", x: 454, y: 650 },
      { text: "Cat. No.", x: 210, y: 500 },
      { text: "1492-J3", x: 210, y: 490 },
      { text: "1492-J4", x: 350, y: 490 },
      { text: "1492-J6", x: 478, y: 490 }
    ];

    expect(extractPositionedTableRows(topComparisonThenOrdering, "1492-J3")).toEqual({
      "Maximum Current": "25 A 20 A 24 A 21 A"
    });
  });

  it("anchors on a German 'Bestell-Nr.' id label and returns rows keyed by their raw labels", () => {
    expect(extractPositionedTableRows(GERMAN_ID_LABEL, "XYZ-1")).toMatchObject({ Gewicht: "0.5 kg" });
    expect(extractPositionedTableRows(GERMAN_ID_LABEL, "XYZ-2")).toMatchObject({ Gewicht: "0.9 kg" });
  });

  it("refuses to guess when our catalog matches two genuinely different columns", () => {
    expect(extractPositionedWeightAndDimensions(AMBIGUOUS_HEADER, "DUP-1")).toBeUndefined();
    expect(extractPositionedTableRows(AMBIGUOUS_HEADER, "DUP-1")).toBeUndefined();
  });
});

describe("matchColumnForCatalog fallback (sibling-prefix collision safety)", () => {
  it("does not let a shorter sibling catalog's column (a strict text-prefix of the real one) match via the fuzzy fallback", () => {
    // The real reader would try the earlier table's page first and move on since no column of
    // ITS OWN matches "1606-XLE240ERL" there; simulated directly here against just that table's
    // items, matching extractPositionedTableRowsFromPdf's own per-page "first match wins" logic.
    expect(extractPositionedTableRows(WRONG_EARLIER_TABLE, "1606-XLE240ERL")).toBeUndefined();
  });

  it("still finds the catalog's own exact column once it legitimately appears as its own header", () => {
    expect(extractPositionedTableRows(CORRECT_LATER_TABLE, "1606-XLE240ERL")).toMatchObject({
      "Adjustment Range": "Fixed"
    });
  });
});

describe("comparison matrices with grouped catalog headers", () => {
  it("uses an Attribute anchor and keeps the fourth physical column when PB4 shares its header with PB4K", () => {
    const groupedHeader: PositionedTextItem[] = [
      { text: "Attribute", x: 47, y: 600 },
      { text: "1769-PA2, 1769-PA2K", x: 146, y: 600 },
      { text: "1769-PA4, 1769-PA4K", x: 274, y: 600 },
      { text: "1769-PB2, 1769-PB2K", x: 401, y: 600 },
      { text: "1769-PB4, 1769-PB4K", x: 485, y: 600 },
      { text: "Input voltage range", x: 47, y: 580 },
      { text: "85…265V AC", x: 146, y: 580 },
      { text: "85…265V AC", x: 274, y: 580 },
      { text: "19.2...31.2V DC", x: 401, y: 580 },
      { text: "Current capacity @ 5V", x: 47, y: 564 },
      { text: "2.0 A", x: 146, y: 564 },
      { text: "4.0 A", x: 274, y: 564 },
      { text: "2.0 A", x: 401, y: 564 },
      { text: "4.0 A", x: 485, y: 564 }
    ];

    expect(extractPositionedTableRows(groupedHeader, "1769-PB4")).toEqual({
      "Input voltage range": "19.2...31.2V DC",
      "Current capacity @ 5V": "4.0 A"
    });
  });
});
