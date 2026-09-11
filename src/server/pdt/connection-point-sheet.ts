import type ExcelJS from "exceljs";
import type { AccessoryMatrixPlan } from "./accessory-matrix.js";
import { clearBody, describeSheet, firstDataRow, type PdtColumn, type SheetDescriptor } from "./sheet-descriptor.js";

/**
 * Connection Point Information — filled from an accessory matrix only.
 *
 * Without a matrix the tab stays an empty placeholder (connection point geometry is CAD data, not
 * something the scraper can derive). With one, each main part gets one row per distinct point that
 * carries an accessory, numbered "User supplementary point N" per main part.
 *
 * The nine target columns and the values written into them are a 1:1 port of the operator's VBA
 * macro (`Skripte_V2.txt`, part 2), which wrote columns C, D, G, I, U, AF, AG, AJ and AP of this
 * very tab. They are resolved by PDT property id rather than by position so a template that gains
 * or loses a column keeps working.
 */

interface ConnectionPointColumns {
  /** C — AAO676, article number of the main product. */
  mainPart: number;
  /** D — connection point / pin name. */
  point: number;
  /** G — AAC342, connection name. */
  connectionName: number;
  /** I — connection description (EN). */
  connectionDescription: number;
  /** U — mounting description. */
  mountingDescription: number;
  /** AF — AAN575, component receptacle designation. */
  receptacleDesignation: number;
  /** AG — components receptacle description. */
  receptacleDescription: number;
  /** AJ — AAN577, components receptacle variant description (EN). */
  receptacleVariantDescription: number;
  /** AP — mounting receptacle conture. */
  mountingReceptacleConture: number;
}

export function writeConnectionPointSheet(ws: ExcelJS.Worksheet, matrix: AccessoryMatrixPlan | undefined): number {
  const descriptor = describeSheet(ws);
  if (!descriptor) return 0;
  clearBody(ws, descriptor.firstBodyRow);
  if (!matrix) return 0;

  const columns = resolveConnectionPointColumns(descriptor);
  let rowNumber = firstDataRow(descriptor);
  let written = 0;
  for (const entry of matrix.connectionPointRows) {
    if (entry.kind === "separator") {
      // Mirror the manual sheet: one blank row between main-part groups.
      rowNumber += 1;
      continue;
    }
    ws.getCell(rowNumber, columns.mainPart).value = entry.mainPart;
    ws.getCell(rowNumber, columns.point).value = entry.point;
    ws.getCell(rowNumber, columns.connectionName).value = entry.supplementaryLabel;
    ws.getCell(rowNumber, columns.mountingReceptacleConture).value = entry.supplementaryLabel;
    if (entry.description) {
      for (const col of [
        columns.connectionDescription,
        columns.mountingDescription,
        columns.receptacleDesignation,
        columns.receptacleDescription,
        columns.receptacleVariantDescription
      ]) {
        ws.getCell(rowNumber, col).value = entry.description;
      }
    }
    rowNumber += 1;
    written += 1;
  }
  return written;
}

function resolveConnectionPointColumns(descriptor: SheetDescriptor): ConnectionPointColumns {
  const resolved = {
    mainPart: findColumn(descriptor, ["AAO676"], /^articlenumber$/),
    point: findColumn(descriptor, [], /^connection point name pins/),
    connectionName: findColumn(descriptor, ["AAC342"], /^connection name/),
    connectionDescription: findColumn(descriptor, ["AAN342", "CNS_CONNECTION_DESCRIPTION"], /^connection description \(en\)/, /\(en\)/),
    mountingDescription: findColumn(descriptor, ["MOUNTING DESCRIPTION"], /^type of mounting/),
    // Only AAN575: the template repeats the internal name CNS_ATTR_NAME on unrelated columns.
    receptacleDesignation: findColumn(descriptor, ["AAN575"], /^component receptacle designation/),
    receptacleDescription: findColumn(descriptor, ["00006A001"], /^components receptacle description/),
    // Only AAN577: CNS_SIM_DESCRIPTION is reused by the mounting-description and mounting-grid
    // columns, so matching on it would land on the wrong property.
    receptacleVariantDescription: findColumn(
      descriptor,
      ["AAN577"],
      /^components receptacle variants description \(en\)/,
      /\(en\)/
    ),
    mountingReceptacleConture: findColumn(descriptor, ["CNS_MOUNTING_RECEPTACLE_CONTURE"], /^mounting receptacle conture/)
  };

  const missing = Object.entries(resolved)
    .filter(([, col]) => !col)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `The PDT template's Connection Point Information tab is missing the accessory matrix target column(s): ${missing.join(", ")}.`
    );
  }
  return resolved as ConnectionPointColumns;
}

/**
 * First column whose property id/name is one of `codes`, else the first whose description matches.
 * `descriptionGuard` disambiguates properties the template repeats for two languages: the same
 * property id carries a "(DE)" and an "(EN)" column, and only the English one is written.
 */
function findColumn(
  descriptor: SheetDescriptor,
  codes: string[],
  description: RegExp,
  descriptionGuard?: RegExp
): number | undefined {
  const wanted = codes.map((code) => code.trim().toUpperCase());
  const byCode = descriptor.columns.find((column) => {
    const keys = [column.code, column.propName].map((key) => key.trim().toUpperCase());
    if (!wanted.some((code) => keys.includes(code))) return false;
    return descriptionGuard ? descriptionGuard.test(normalizedDescription(column)) : true;
  });
  if (byCode) return byCode.col;
  return descriptor.columns.find((column) => description.test(normalizedDescription(column)))?.col;
}

function normalizedDescription(column: PdtColumn): string {
  return column.description.replace(/\s+/g, " ").trim().toLowerCase();
}
