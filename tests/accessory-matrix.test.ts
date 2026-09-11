import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import path from "node:path";
import {
  accessoryMatrixCatalogNumbers,
  buildAccessoryMatrixPlan,
  accessoryMatrixMainPartsNotInRun,
  parseAccessoryMatrixBuffer,
  loadAccessoryMatrix,
  pointVariantIndex,
  readAccessoryMatrixSheet,
  type AccessoryMatrixPlan,
  type AccessoryMatrixSource
} from "../src/server/pdt/accessory-matrix.js";
import { cellText } from "../src/server/pdt/sheet-descriptor.js";

/**
 * `fixtures/_assets/accessory-matrix-example.xlsx` holds **dummy** part numbers and descriptions,
 * but it is a real input/output pair of the VBA macro this module replaces: its first sheet is the
 * input, and its "final" / "conn point" / "Condition" sheets are what the macro produced from it.
 * The golden tests below therefore pin the *transformation rules*, not the data — nothing in the
 * parser knows anything about this file. "shape independence" below proves that on a matrix of a
 * completely different size, naming and cell type.
 */
const EXAMPLE_PATH = path.resolve("fixtures", "_assets", "accessory-matrix-example.xlsx");

type ExpectedAccessoryRow =
  | { kind: "separator" }
  | { kind: "accessory"; mainPart: string; point: string; accessory: string; relation: string; variantIndex: string };

type ExpectedConnectionPointRow =
  | { kind: "separator" }
  | { kind: "point"; mainPart: string; point: string; supplementaryLabel: string; description: string };

function planFromSource(source: AccessoryMatrixSource): AccessoryMatrixPlan {
  return buildAccessoryMatrixPlan(source);
}

function sourceFromGrid(grid: string[][]): AccessoryMatrixSource {
  const ws = new ExcelJS.Workbook().addWorksheet("Matrix");
  grid.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      if (value) ws.getCell(rowIndex + 1, colIndex + 1).value = value;
    });
  });
  return readAccessoryMatrixSheet(ws);
}

/** The macro's "final" sheet: Main Part | Point | Accessory | _ | Value1 | ... | Value2. */
function expectedAccessoryRows(ws: ExcelJS.Worksheet): ExpectedAccessoryRow[] {
  const rows: ExpectedAccessoryRow[] = [];
  const lastRow = lastUsedRow(ws, [1, 2, 3, 5, 9], 2);
  for (let row = 2; row <= lastRow; row++) {
    const mainPart = cellText(ws.getCell(row, 1).value);
    if (!mainPart) {
      rows.push({ kind: "separator" });
      continue;
    }
    rows.push({
      kind: "accessory",
      mainPart,
      point: cellText(ws.getCell(row, 2).value),
      accessory: cellText(ws.getCell(row, 3).value),
      relation: cellText(ws.getCell(row, 5).value),
      variantIndex: cellText(ws.getCell(row, 9).value)
    });
  }
  return rows;
}

/** The macro's "conn point" sheet: data starts at row 3, columns C/D/G/I/U/AF/AG/AJ/AP. */
function expectedConnectionPointRows(ws: ExcelJS.Worksheet): ExpectedConnectionPointRow[] {
  const rows: ExpectedConnectionPointRow[] = [];
  const lastRow = lastUsedRow(ws, [3, 4, 7, 9, 21, 32, 33, 36, 42], 3);
  for (let row = 3; row <= lastRow; row++) {
    const mainPart = cellText(ws.getCell(row, 3).value);
    if (!mainPart) {
      rows.push({ kind: "separator" });
      continue;
    }
    rows.push({
      kind: "point",
      mainPart,
      point: cellText(ws.getCell(row, 4).value),
      supplementaryLabel: cellText(ws.getCell(row, 7).value),
      description: cellText(ws.getCell(row, 9).value)
    });
  }
  return rows;
}

function lastUsedRow(ws: ExcelJS.Worksheet, columns: number[], firstRow: number): number {
  let last = firstRow - 1;
  for (let row = firstRow; row <= (ws.rowCount || 0); row++) {
    if (columns.some((col) => cellText(ws.getCell(row, col).value))) last = row;
  }
  return last;
}

describe("accessory matrix — golden comparison against the VBA macro's own output", () => {
  it("reproduces the macro's Product Accessory rows", async () => {
    const plan = await loadAccessoryMatrix(EXAMPLE_PATH);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(EXAMPLE_PATH);
    const expected = expectedAccessoryRows(workbook.getWorksheet("final")!);

    const actual: ExpectedAccessoryRow[] = plan.accessoryRows.map((row) =>
      row.kind === "separator"
        ? { kind: "separator" }
        : {
            kind: "accessory",
            mainPart: row.mainPart,
            point: row.point,
            accessory: row.accessory,
            relation: String(row.relation),
            variantIndex: String(row.variantIndex)
          }
    );

    expect(expected.length).toBeGreaterThan(100);
    expect(actual).toEqual(expected);
  });

  it("reproduces the macro's Connection Point Information rows", async () => {
    const plan = await loadAccessoryMatrix(EXAMPLE_PATH);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(EXAMPLE_PATH);
    const expected = expectedConnectionPointRows(workbook.getWorksheet("conn point")!);

    const actual: ExpectedConnectionPointRow[] = plan.connectionPointRows.map((row) =>
      row.kind === "separator"
        ? { kind: "separator" }
        : {
            kind: "point",
            mainPart: row.mainPart,
            point: row.point,
            supplementaryLabel: row.supplementaryLabel,
            description: row.description
          }
    );

    expect(expected.length).toBeGreaterThan(100);
    expect(actual).toEqual(expected);
  });

  it("reproduces the macro's INLIST conditions", async () => {
    const plan = await loadAccessoryMatrix(EXAMPLE_PATH);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(EXAMPLE_PATH);
    const ws = workbook.getWorksheet("Condition")!;
    const expected: Array<{ point: string; condition: string }> = [];
    for (let row = 2; row <= (ws.rowCount || 0); row++) {
      const point = cellText(ws.getCell(row, 1).value);
      if (!point) continue;
      expected.push({ point, condition: cellText(ws.getCell(row, 2).value) });
    }

    expect(expected.length).toBeGreaterThan(0);
    expect(plan.conditions).toEqual(expected);
    expect(plan.warnings).toEqual([]);
  });
});

describe("accessory matrix parsing", () => {
  it("derives the accessory variant index from the point name suffix", () => {
    expect(pointVariantIndex("MP_PS_3")).toBe(3);
    expect(pointVariantIndex("MP_PS")).toBe(1);
    expect(pointVariantIndex("MP_PS_fix")).toBe(1);
    expect(pointVariantIndex("MP_PS_")).toBe(1);
    expect(pointVariantIndex("MP")).toBe(1);
    expect(pointVariantIndex("MP_B_12")).toBe(12);
  });

  it("skips blank main-part rows and empty accessory cells", () => {
    const plan = planFromSource(
      sourceFromGrid([
        ["MAIN", "ACC", "ACC"],
        ["", "MP_A_1", "MP_B_2"],
        ["", "left", "right"],
        ["P1", "ACC1", ""],
        ["", "", ""],
        ["P2", "", "ACC2"]
      ])
    );

    expect(plan.accessoryRows).toEqual([
      { kind: "accessory", mainPart: "P1", point: "MP_A_1", accessory: "ACC1", relation: 1, variantIndex: 1 },
      { kind: "separator" },
      { kind: "accessory", mainPart: "P2", point: "MP_B_2", accessory: "ACC2", relation: 1, variantIndex: 2 }
    ]);
    expect(plan.connectionPointRows).toEqual([
      { kind: "point", mainPart: "P1", point: "MP_A_1", description: "left", supplementaryLabel: "User supplementary point 1" },
      { kind: "separator" },
      { kind: "point", mainPart: "P2", point: "MP_B_2", description: "right", supplementaryLabel: "User supplementary point 1" }
    ]);
    expect(plan.conditions).toEqual([
      { point: "MP_A_1", condition: "INLIST('P1', PN)" },
      { point: "MP_B_2", condition: "INLIST('P2', PN)" }
    ]);
    expect(plan.mainParts).toEqual(["P1", "P2"]);
  });

  it("lists a connection point once per main part even across repeated rows", () => {
    const plan = planFromSource(
      sourceFromGrid([
        ["MAIN", "ACC", "ACC"],
        ["", "MP_A_1", "MP_A_1"],
        ["", "desc", "desc"],
        ["P1", "ACC1", "ACC2"]
      ])
    );

    expect(plan.accessoryRows).toHaveLength(2);
    expect(plan.connectionPointRows).toEqual([
      { kind: "point", mainPart: "P1", point: "MP_A_1", description: "desc", supplementaryLabel: "User supplementary point 1" }
    ]);
    expect(plan.conditions).toEqual([{ point: "MP_A_1", condition: "INLIST('P1', PN)" }]);
  });

  it("warns when a main part reappears in a later block", () => {
    const plan = planFromSource(
      sourceFromGrid([
        ["MAIN", "ACC"],
        ["", "MP_A_1"],
        ["", "desc"],
        ["P1", "ACC1"],
        ["P2", "ACC2"],
        ["P1", "ACC3"]
      ])
    );

    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("P1");
    // The main part is still listed once, and its condition entry is not duplicated.
    expect(plan.mainParts).toEqual(["P1", "P2"]);
    expect(plan.conditions).toEqual([{ point: "MP_A_1", condition: "INLIST('P1,P2', PN)" }]);
  });

  it("skips point columns with no name but warns when they hold accessories", () => {
    const plan = planFromSource(
      sourceFromGrid([
        ["MAIN", "ACC", "ACC"],
        ["", "", "MP_B_1"],
        ["", "nameless", "named"],
        ["P1", "ACC1", "ACC2"]
      ])
    );

    expect(plan.accessoryRows).toEqual([
      { kind: "accessory", mainPart: "P1", point: "MP_B_1", accessory: "ACC2", relation: 1, variantIndex: 1 }
    ]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("no point name");
  });

  it("rejects a sheet without point names or without main parts", () => {
    expect(() =>
      sourceFromGrid([
        ["MAIN", "ACC"],
        ["", ""],
        ["", "desc"],
        ["P1", "ACC1"]
      ])
    ).toThrow(/no connection point names in row 2/i);

    expect(() =>
      sourceFromGrid([
        ["MAIN", "ACC"],
        ["", "MP_A_1"],
        ["", "desc"]
      ])
    ).toThrow(/no main part numbers in column A/i);
  });

  it("derives scrapable catalog numbers from the main parts", async () => {
    const plan = await loadAccessoryMatrix(EXAMPLE_PATH);
    expect(accessoryMatrixCatalogNumbers(plan)).toEqual(plan.mainParts);
    expect(accessoryMatrixCatalogNumbers(plan)[0]).toBe("A444GSC");

    // Normalized exactly like the CSV path: collapsed whitespace, case-insensitive de-dup.
    const messy = planFromSource(
      sourceFromGrid([
        ["MAIN", "ACC"],
        ["", "MP_A_1"],
        ["", "desc"],
        ["A 444  GSC", "ACC1"],
        ["a 444 gsc", "ACC2"],
        ["B100", "ACC3"]
      ])
    );
    expect(accessoryMatrixCatalogNumbers(messy)).toEqual(["A 444 GSC", "B100"]);
    // The rows themselves keep the verbatim spelling from the sheet.
    expect(messy.accessoryRows.filter((row) => row.kind === "accessory").map((row) => (row as { mainPart: string }).mainPart)).toEqual([
      "A 444  GSC",
      "a 444 gsc",
      "B100"
    ]);
  });

  it("parses an in-memory upload the same way as a file on disk", async () => {
    const fs = await import("node:fs/promises");
    const fromDisk = await loadAccessoryMatrix(EXAMPLE_PATH);
    const fromBuffer = await parseAccessoryMatrixBuffer(await fs.readFile(EXAMPLE_PATH));
    expect(fromBuffer.mainParts).toEqual(fromDisk.mainParts);
    expect(fromBuffer.accessoryRows).toEqual(fromDisk.accessoryRows);
    expect(fromBuffer.conditions).toEqual(fromDisk.conditions);
  });

  it("reports matrix main parts that were not scraped in the run", async () => {
    const plan = await loadAccessoryMatrix(EXAMPLE_PATH);
    expect(accessoryMatrixMainPartsNotInRun(plan, ["a444gsc", " A664GSC "])).not.toContain("A444GSC");
    expect(accessoryMatrixMainPartsNotInRun(plan, ["A444GSC"])).toContain("A664GSC");
    expect(accessoryMatrixMainPartsNotInRun(plan, plan.mainParts)).toEqual([]);
  });
});

describe("accessory matrix - shape independence", () => {
  /**
   * A matrix that shares nothing with the sample: a differently named first sheet, nine points
   * with mixed suffix styles, prose descriptions, numeric main parts, ragged rows, and a point
   * only one product uses.
   */
  function differentlyShapedWorkbook(): ExcelJS.Workbook {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Tabelle1");
    // A second sheet on purpose: the parser must take the FIRST sheet, whatever it is called.
    workbook.addWorksheet("Matrix").getCell(1, 1).value = "decoy sheet, must be ignored";

    const points: Array<[string, string]> = [
      ["TOP_PLATE", "Montageplatte oben, Ø8 mm"],
      ["TOP_PLATE_2", "Montageplatte oben, zweite Position"],
      ["SIDE_L", "Seitenwand links"],
      ["SIDE_R", "Seitenwand rechts"],
      ["DIN_RAIL_10", "DIN rail, position 10"],
      ["DOOR", "Door, inside"],
      ["BASE", "Base plate"],
      ["GLAND_PLATE_3", "Gland plate, cut-out 3"],
      ["EARTH", "Earthing stud, M6 x 12"]
    ];
    ws.getCell(1, 1).value = "MAIN";
    points.forEach(([name, description], index) => {
      ws.getCell(1, index + 2).value = "ACC";
      ws.getCell(2, index + 2).value = name;
      ws.getCell(3, index + 2).value = description;
    });

    // Numeric main parts (Excel stores them as numbers), a blank row, uneven accessory counts.
    const rows: Array<[number | string, Array<[number, string]>]> = [
      [900110, [[2, "ACC-TP"], [3, "ACC-TP"], [10, "ACC-EARTH"]]],
      [900120, [[4, "ACC-SIDE"], [5, "ACC-SIDE"], [6, "ACC-DIN"]]],
      ["", []],
      ["GLAND-ONLY", [[9, "ACC-GLAND"]]],
      [900130, [[2, "ACC-TP"], [7, "ACC-DOOR"], [8, "ACC-BASE"], [10, "ACC-EARTH"]]]
    ];
    rows.forEach(([mainPart, accessories], index) => {
      const row = 4 + index;
      if (mainPart !== "") ws.getCell(row, 1).value = mainPart;
      for (const [col, accessory] of accessories) ws.getCell(row, col).value = accessory;
    });
    return workbook;
  }

  it("reads any number of points and rows from the first sheet, whatever it is named", async () => {
    const buffer = await differentlyShapedWorkbook().xlsx.writeBuffer();
    const plan = await parseAccessoryMatrixBuffer(new Uint8Array(buffer));

    expect(plan.points.map((point) => point.name)).toEqual([
      "TOP_PLATE",
      "TOP_PLATE_2",
      "SIDE_L",
      "SIDE_R",
      "DIN_RAIL_10",
      "DOOR",
      "BASE",
      "GLAND_PLATE_3",
      "EARTH"
    ]);
    // Numeric cells become plain catalog numbers; the decoy sheet contributed nothing.
    expect(plan.mainParts).toEqual(["900110", "900120", "GLAND-ONLY", "900130"]);
    expect(accessoryMatrixCatalogNumbers(plan)).toEqual(["900110", "900120", "GLAND-ONLY", "900130"]);

    const accessories = plan.accessoryRows.filter((row) => row.kind === "accessory") as Array<{
      point: string;
      variantIndex: number;
    }>;
    expect(accessories).toHaveLength(11);
    // The suffix rule holds for names that look nothing like the sample's.
    expect(accessories.map((row) => row.variantIndex)).toEqual([1, 2, 1, 1, 1, 10, 3, 1, 1, 1, 1]);
    // One separator per main-part change; the blank row does not add one of its own.
    expect(plan.accessoryRows.filter((row) => row.kind === "separator")).toHaveLength(3);

    // Descriptions are copied verbatim, punctuation and non-ASCII included.
    expect(plan.connectionPointRows.find((row) => row.kind === "point")).toMatchObject({
      mainPart: "900110",
      point: "TOP_PLATE",
      description: "Montageplatte oben, Ø8 mm",
      supplementaryLabel: "User supplementary point 1"
    });

    // Numbering restarts per main part and counts only that part's own points.
    const labelsByPart = new Map<string, string[]>();
    for (const row of plan.connectionPointRows) {
      if (row.kind !== "point") continue;
      labelsByPart.set(row.mainPart, [...(labelsByPart.get(row.mainPart) ?? []), row.supplementaryLabel]);
    }
    expect(labelsByPart.get("900110")).toEqual([
      "User supplementary point 1",
      "User supplementary point 2",
      "User supplementary point 3"
    ]);
    expect(labelsByPart.get("GLAND-ONLY")).toEqual(["User supplementary point 1"]);
    expect(labelsByPart.get("900130")).toHaveLength(4);

    // Conditions list every product that uses a point, in first-seen order, unused points absent.
    expect(plan.conditions).toEqual([
      { point: "TOP_PLATE", condition: "INLIST('900110,900130', PN)" },
      { point: "TOP_PLATE_2", condition: "INLIST('900110', PN)" },
      { point: "EARTH", condition: "INLIST('900110,900130', PN)" },
      { point: "SIDE_L", condition: "INLIST('900120', PN)" },
      { point: "SIDE_R", condition: "INLIST('900120', PN)" },
      { point: "DIN_RAIL_10", condition: "INLIST('900120', PN)" },
      { point: "GLAND_PLATE_3", condition: "INLIST('GLAND-ONLY', PN)" },
      { point: "DOOR", condition: "INLIST('900130', PN)" },
      { point: "BASE", condition: "INLIST('900130', PN)" }
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("handles a single product with a single point and no description row", async () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("whatever");
    ws.getCell(2, 2).value = "ONLY_POINT";
    ws.getCell(4, 1).value = "SOLO-1";
    ws.getCell(4, 2).value = "ACC-1";
    const plan = await parseAccessoryMatrixBuffer(new Uint8Array(await workbook.xlsx.writeBuffer()));

    expect(plan.mainParts).toEqual(["SOLO-1"]);
    expect(plan.accessoryRows).toEqual([
      { kind: "accessory", mainPart: "SOLO-1", point: "ONLY_POINT", accessory: "ACC-1", relation: 1, variantIndex: 1 }
    ]);
    // A missing description row is fine: those PDT cells simply stay blank.
    expect(plan.connectionPointRows).toEqual([
      { kind: "point", mainPart: "SOLO-1", point: "ONLY_POINT", description: "", supplementaryLabel: "User supplementary point 1" }
    ]);
    expect(plan.conditions).toEqual([{ point: "ONLY_POINT", condition: "INLIST('SOLO-1', PN)" }]);
  });

  it("reads formula and rich-text cells and trims stray whitespace", async () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("s");
    ws.getCell(2, 2).value = { richText: [{ text: "RICH" }, { text: "_2" }] } as never;
    ws.getCell(3, 2).value = "  padded description  ";
    ws.getCell(4, 1).value = { formula: 'CONCATENATE("PART","-42")', result: "PART-42" } as never;
    ws.getCell(4, 2).value = "  ACC-42  ";
    const plan = await parseAccessoryMatrixBuffer(new Uint8Array(await workbook.xlsx.writeBuffer()));

    expect(plan.points[0]).toMatchObject({ name: "RICH_2", description: "padded description" });
    expect(plan.accessoryRows).toEqual([
      { kind: "accessory", mainPart: "PART-42", point: "RICH_2", accessory: "ACC-42", relation: 1, variantIndex: 2 }
    ]);
  });
});
