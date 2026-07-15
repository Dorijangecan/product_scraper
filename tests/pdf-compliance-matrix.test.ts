import { describe, expect, it } from "vitest";
import {
  extractComplianceMatrixHeaderItems,
  matchComplianceMatrixCertificates,
  textHasComplianceMatrixGlyphs,
  type PositionedTextItem
} from "../src/server/scrapers/pdf-compliance-matrix.js";

// U+F0FC — the exact Private-Use-Area codepoint the checkmark glyph uses on Rockwell's real
// 1606-td002 "Standards Compliance and Certifications" datasheet page (confirmed via raw codepoint
// dump against the actual PDF). Coordinates below mirror that real page's layout.
const CHECK = "";

const HEADERS: PositionedTextItem[] = [
  { text: "Catalog Number", x: 54.2, y: 643.7 },
  { text: "CE", x: 141.6, y: 647.0 },
  { text: "UL 61010-2-201", x: 168.1, y: 647.0 },
  { text: "IECEx", x: 193.4, y: 647.0 },
  { text: "ATEX", x: 216.7, y: 647.0 },
  { text: "Class I Div. 2 HazLoc", x: 239.9, y: 647.0 },
  { text: "DNV GL Marine", x: 263.1, y: 647.0 },
  { text: "EAC Registration", x: 286.3, y: 647.0 },
  { text: "NEC Class 2", x: 309.5, y: 647.0 }
];

function row(catalogNumber: string, y: number, checkXs: number[]): PositionedTextItem[] {
  return [
    { text: catalogNumber, x: 53.0, y },
    ...checkXs.map((x) => ({ text: CHECK, x, y: y - 2.6 }))
  ];
}

describe("matchComplianceMatrixCertificates", () => {
  it("matches the real 1606-XLB120E row and orders results left-to-right by column", () => {
    // Real checkmark X positions from the source PDF for this row.
    const items = [...HEADERS, ...row("1606-XLB120E", 434.2, [135.4, 159.6, 280.0])];
    expect(matchComplianceMatrixCertificates(items, "1606-XLB120E")).toEqual([
      "CE",
      "UL 61010-2-201",
      "EAC Registration"
    ]);
  });

  it("does not confuse a sibling catalog number that is a prefix of another (60E vs 60EH)", () => {
    const items = [
      ...HEADERS,
      ...row("1606-XLB60E", 486.6, [134.1, 159.7, 280.0, 303.2]),
      ...row("1606-XLB60EH", 499.7, [134.1, 159.7, 280.0])
    ];
    expect(matchComplianceMatrixCertificates(items, "1606-XLB60E")).toEqual([
      "CE",
      "UL 61010-2-201",
      "EAC Registration",
      "NEC Class 2"
    ]);
    expect(matchComplianceMatrixCertificates(items, "1606-XLB60EH")).toEqual([
      "CE",
      "UL 61010-2-201",
      "EAC Registration"
    ]);
  });

  it("returns an empty array when the row is found but has no checked columns", () => {
    // Another row on the same page has checkmarks (so the page is recognized as a compliance
    // matrix at all) but our target row has none of its own.
    const items = [...HEADERS, ...row("1606-XLB120E", 434.2, [135.4]), { text: "1606-XLB000X", x: 53.0, y: 400 }];
    expect(matchComplianceMatrixCertificates(items, "1606-XLB000X")).toEqual([]);
  });

  it("returns undefined when the catalog number isn't on this page at all", () => {
    const items = [...HEADERS, ...row("1606-XLB120E", 434.2, [135.4])];
    expect(matchComplianceMatrixCertificates(items, "1606-XLB999Z")).toBeUndefined();
  });

  it("returns undefined for a page with no checkmark glyphs (not a compliance matrix)", () => {
    const items: PositionedTextItem[] = [{ text: "1606-XLB120E", x: 53.0, y: 434.2 }, { text: "Some prose", x: 100, y: 400 }];
    expect(matchComplianceMatrixCertificates(items, "1606-XLB120E")).toBeUndefined();
  });

  it("ignores a header row that hasn't been reached yet by only requiring y strictly above the checkmarks", () => {
    // Two separate tables stacked on one page (like the XLP and XLB sections) — each catalog
    // should only ever match against the header immediately above its own checkmark band.
    const items = [...HEADERS, ...row("1606-XLB480E", 538.9, [135.3, 161.8, 280.0])];
    expect(matchComplianceMatrixCertificates(items, "1606-XLB480E")).toEqual(["CE", "UL 61010-2-201", "EAC Registration"]);
  });

  it("uses a carried-forward header row for a continuation page that has no header of its own", () => {
    // Real layout: Rockwell's 1606-td002 "Standards Compliance and Certifications" section prints
    // its column headers ONCE at the top of the whole multi-page table — continuation pages just
    // keep listing more catalog rows with no header text at all. A page with checkmarks but no
    // header row must still resolve using the PREVIOUS page's header (matched purely on X, which
    // is stable across pages of the same table), not silently return undefined.
    const continuationPageItems = row("1606-XLB120E", 434.2, [135.4, 159.6, 280.0]);
    expect(matchComplianceMatrixCertificates(continuationPageItems, "1606-XLB120E")).toBeUndefined();
    expect(matchComplianceMatrixCertificates(continuationPageItems, "1606-XLB120E", HEADERS)).toEqual([
      "CE",
      "UL 61010-2-201",
      "EAC Registration"
    ]);
  });

  it("prefers a page's OWN header row over a carried one when both are present", () => {
    const ownHeaders: PositionedTextItem[] = [
      { text: "Catalog Number", x: 54.2, y: 643.7 },
      { text: "CE", x: 141.6, y: 647.0 },
      { text: "IECEx", x: 168.1, y: 647.0 }
    ];
    const items = [...ownHeaders, ...row("1606-XLB120E", 434.2, [135.4, 159.6])];
    expect(matchComplianceMatrixCertificates(items, "1606-XLB120E", HEADERS)).toEqual(["CE", "IECEx"]);
  });
});

describe("extractComplianceMatrixHeaderItems", () => {
  it("returns this page's own header items when present", () => {
    const items = [...HEADERS, ...row("1606-XLB120E", 434.2, [135.4])];
    expect(extractComplianceMatrixHeaderItems(items).map((item) => item.text)).toEqual(
      expect.arrayContaining(["CE", "UL 61010-2-201", "IECEx", "ATEX", "Class I Div. 2 HazLoc", "DNV GL Marine", "EAC Registration", "NEC Class 2"])
    );
  });

  it("returns an empty array for a continuation page with checkmarks but no header row", () => {
    const items = row("1606-XLB120E", 434.2, [135.4]);
    expect(extractComplianceMatrixHeaderItems(items)).toEqual([]);
  });
});

describe("textHasComplianceMatrixGlyphs", () => {
  it("detects a Private-Use-Area checkmark glyph in plain text", () => {
    expect(textHasComplianceMatrixGlyphs(`1606-XLB120E \t${CHECK} \t${CHECK}`)).toBe(true);
  });

  it("returns false for ordinary text with no PUA glyphs", () => {
    expect(textHasComplianceMatrixGlyphs("1606-XLB120E: Basic Power Supply, 24-28V DC, 120 W")).toBe(false);
  });
});
