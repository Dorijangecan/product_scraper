import { describe, expect, it } from "vitest";
import { extractPositionedWeightAndDimensions, type PositionedTextItem } from "../src/server/scrapers/pdf-positioned-table.js";

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
