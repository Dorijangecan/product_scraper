import * as cheerio from "cheerio";
import type { AttributeRecord } from "../../shared/types.js";
import { compactCatalogNumber } from "./catalog-number.js";
import { isCatalogIdHeaderCell } from "./catalog-table-vocabulary.js";
import { cleanText } from "./normalizer.js";

/**
 * DOM-aware table reader for generic product pages.
 *
 * The old reader treated every `tr` as `first cell: all remaining cells`. That is safe for a
 * two-cell definition list, but destroys a comparison or configurator table: a colspan header
 * becomes one cell while its data still occupies several columns. Here the DOM gives us the
 * boundaries explicitly, so expand spans before deciding whether a table is row- or
 * column-oriented. The reader is deliberately conservative: a table that cannot identify one
 * selected variant is left to the ordinary row fallback, and an ambiguous selected variant is
 * suppressed rather than guessed.
 */

interface MatrixCell {
  text: string;
  /** Visible lines, retaining explicit `<br>` alignment inside a logical table cell. */
  lines: string[];
  id?: string;
  headers?: string;
  isHeader: boolean;
  hasInteractiveControl: boolean;
}

interface TableMatrix {
  rows: MatrixCell[][];
  headerRows: number[];
}

export interface HtmlTableReadResult {
  attributes: AttributeRecord[];
  /** Legacy flattened pairs that describe the same handled colspan/rowspan cells. */
  suppressedPairs: Array<{ name: string; value: string }>;
  /** Tables whose column-aware output replaces the broad fallback extractors. */
  handledTables: Set<unknown>;
  /** Replayable table inputs observed only after this reader selected a deterministic variant. */
  recipes: HtmlTableRecipe[];
}

export interface HtmlTableRecipe {
  selector: string;
  header: string;
  attributes: AttributeRecord[];
}

interface TableRead {
  attributes: AttributeRecord[];
  handled: boolean;
  suppressedPairs?: Array<{ name: string; value: string }>;
}

const EMPTY_CELL: MatrixCell = { text: "", lines: [], isHeader: false, hasInteractiveControl: false };

export function readHtmlTableAttributes($: cheerio.CheerioAPI, catalogNumber: string, sourceUrl: string): HtmlTableReadResult {
  const attributes: AttributeRecord[] = [];
  const suppressedPairs: Array<{ name: string; value: string }> = [];
  const handledTables = new Set<unknown>();
  const recipes: HtmlTableRecipe[] = [];

  $("table").slice(0, 300).each((_, table) => {
    const matrix = buildTableMatrix($, table);
    if (!matrix.rows.length) return;

    const group = tableGroup($, table);
    const read = readTable(matrix, catalogNumber, sourceUrl, group);
    attributes.push(...read.attributes);
    suppressedPairs.push(...(read.suppressedPairs ?? []));
    if (read.handled) {
      handledTables.add(table);
      const recipe = htmlTableRecipe(matrix, table, catalogNumber, read.attributes);
      if (recipe) recipes.push(recipe);
    }
  });

  return { attributes: dedupe(attributes), suppressedPairs, handledTables, recipes };
}

/**
 * Replay a previously observed table input only after the strict recipe parser in page-mining has
 * validated its selector and header. The reader still has to select the requested catalog number;
 * a changed table is therefore skipped rather than flattened or guessed.
 */
export function replayHtmlTableHeaderColumn(
  $: cheerio.CheerioAPI,
  catalogNumber: string,
  sourceUrl: string,
  selector: string,
  header: string
): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $(selector).slice(0, 4).each((_, table) => {
    const matrix = buildTableMatrix($, table);
    if (!matrix.rows.length) return;
    const headers = mergedHeaders(matrix, matrix.rows[0]?.length ?? 0);
    if (!headers.some((candidate) => headerKey(candidate) === headerKey(header))) return;
    const read = readTable(matrix, catalogNumber, sourceUrl, tableGroup($, table));
    if (read.handled) attributes.push(...read.attributes);
  });
  return dedupe(attributes);
}

function htmlTableRecipe(
  matrix: TableMatrix,
  table: Parameters<cheerio.CheerioAPI>[0],
  catalogNumber: string,
  attributes: AttributeRecord[]
): HtmlTableRecipe | undefined {
  if (!attributes.length) return undefined;
  const selector = stableTableSelector(table);
  if (!selector) return undefined;
  const headers = mergedHeaders(matrix, matrix.rows[0]?.length ?? 0);
  const exactCatalogHeader = headers.find((header) => compactCatalogNumber(header) === compactCatalogNumber(catalogNumber));
  const catalogHeader = headers.find((header) => isCatalogIdHeaderCell(header));
  const header = exactCatalogHeader ?? catalogHeader;
  return header ? { selector, header, attributes } : undefined;
}

function stableTableSelector(table: Parameters<cheerio.CheerioAPI>[0]): string | undefined {
  const attrs = (table as { attribs?: Record<string, string> }).attribs ?? {};
  const id = cleanText(attrs.id ?? "");
  if (/^[A-Za-z][\w-]{0,79}$/.test(id)) return `table#${id}`;
  const classes = cleanText(attrs.class ?? "")
    .split(/\s+/)
    .filter((value) => /^[A-Za-z_-][\w-]{0,79}$/.test(value))
    .slice(0, 2);
  return classes.length ? `table.${classes.join(".")}` : undefined;
}

function headerKey(value: string): string {
  return cleanText(value).toLocaleLowerCase().replace(/\s+/g, " ");
}

/** Expand HTML colspan/rowspan into a rectangular coordinate matrix. */
function buildTableMatrix($: cheerio.CheerioAPI, table: Parameters<cheerio.CheerioAPI>[0]): TableMatrix {
  const rows: MatrixCell[][] = [];
  const headerRows: number[] = [];
  const carry: Array<{ cell: MatrixCell; remaining: number } | undefined> = [];

  $(table)
    .find("tr")
    .filter((_, row) => $(row).closest("table").get(0) === table)
    .slice(0, 160)
    .each((rowIndex, row) => {
      const cells: MatrixCell[] = [];
      for (let column = 0; column < carry.length; column += 1) {
        const pending = carry[column];
        if (!pending) continue;
        cells[column] = pending.cell;
        pending.remaining -= 1;
        if (pending.remaining <= 0) carry[column] = undefined;
      }

      const directCells = $(row).children("th,td").toArray();
      for (const element of directCells) {
        while (cells.length && cells[cells.length - 1] === undefined) cells.push(EMPTY_CELL);
        let column = 0;
        while (cells[column] !== undefined) column += 1;

        const cell: MatrixCell = {
          text: cleanText($(element).text()),
          lines: tableCellLines($, element),
          id: cleanText($(element).attr("id")),
          headers: cleanText($(element).attr("headers")),
          isHeader: String(element.tagName ?? "").toLowerCase() === "th",
          hasInteractiveControl: $(element).find("input,select,textarea,button").length > 0
        };
        const colspan = positiveSpan($(element).attr("colspan"));
        const rowspan = positiveSpan($(element).attr("rowspan"));
        for (let offset = 0; offset < colspan; offset += 1) {
          cells[column + offset] = cell;
          if (rowspan > 1) carry[column + offset] = { cell, remaining: rowspan - 1 };
        }
      }

      if (!cells.some((cell) => Boolean(cell?.text))) return;
      rows.push(cells);
      if (directCells.length && directCells.every((cell) => String(cell.tagName ?? "").toLowerCase() === "th")) {
        headerRows.push(rowIndex);
      }
    });

  const width = Math.max(0, ...rows.map((row) => row.length));
  for (const row of rows) {
    while (row.length < width) row.push(EMPTY_CELL);
  }
  // A table may put its first header row in <thead> and a second one in <tbody>; accept only
  // leading all-header rows as header context, so a data row with a single <th> is never lost.
  const leadingHeaders: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (!headerRows.includes(index)) break;
    leadingHeaders.push(index);
  }
  return { rows, headerRows: leadingHeaders };
}

function readTable(matrix: TableMatrix, catalogNumber: string, sourceUrl: string, group: string): TableRead {
  const columnRead = readColumnOrientedTable(matrix, catalogNumber, sourceUrl, group);
  if (columnRead) return columnRead;
  const optionLookupRead = readOptionLookupTable(matrix, catalogNumber, sourceUrl, group);
  if (optionLookupRead) return optionLookupRead;
  const configuratorRead = readInteractiveConfiguratorTable(matrix, catalogNumber, sourceUrl, group);
  if (configuratorRead) return configuratorRead;
  return { attributes: readRowOrientedTable(matrix, catalogNumber, sourceUrl, group), handled: false };
}

/**
 * A two-cell lookup table beneath an option heading maps ordering-code fragments to their human
 * labels. It is not a list of attributes for every sibling: retaining K5 and S025 for a requested
 * K2 changes the product. Only select when one first-column code is an exact catalog segment.
 */
function readOptionLookupTable(matrix: TableMatrix, catalogNumber: string, sourceUrl: string, group: string): TableRead | undefined {
  if (matrix.headerRows.length || matrix.rows.length < 2) return undefined;
  const rows = matrix.rows.filter((row) => !isInteractiveRow(row));
  if (rows.length < 2 || !rows.every((row) => row.filter((cell) => cleanText(cell.text)).length === 2)) return undefined;
  const catalogSegments = catalogSegmentKeys(catalogNumber);
  const matchingRows = rows.filter((row) => {
    const code = valueKey(row[0]?.text);
    return code.length >= 2 && catalogSegments.has(code);
  });
  if (matchingRows.length !== 1) return undefined;
  const row = matchingRows[0];
  const name = cleanText(row[0]?.text);
  const value = cleanText(row[1]?.text);
  if (!name || !value) return undefined;
  return { attributes: [{ group, name, value, sourceUrl, scope: "variant-option" }], handled: true };
}

/**
 * A filtered configurator can have property headers and exactly one selected data row without
 * printing the complete catalog number anywhere in the table. Ganter's recorded priority table is
 * one such case: `K2` selects the `d` column while `S025` is a sibling connection option. The old
 * row fallback reversed that shape into `19 … = 6 | 5 | 22`.
 *
 * We accept this weaker identity proof only when the table itself carries an interactive filter and
 * exactly one non-interactive row contains an ordering-code segment. Columns with code-like header
 * tokens are variant options; retain only those mentioning the requested catalog. Unmarked columns
 * remain shared facts for the selected row. Anything less specific falls through to the ordinary
 * conservative reader.
 */
function readInteractiveConfiguratorTable(
  matrix: TableMatrix,
  catalogNumber: string,
  sourceUrl: string,
  group: string
): TableRead | undefined {
  if (!matrix.headerRows.length || !matrix.rows.some(isInteractiveRow)) return undefined;
  const width = matrix.rows[0]?.length ?? 0;
  if (width < 2) return undefined;
  const headers = mergedHeaders(matrix, width);
  if (headers.filter(Boolean).length < 2) return undefined;
  const dataRows = matrix.rows.slice(matrix.headerRows.length).filter((row) => !isInteractiveRow(row));
  if (dataRows.length !== 1) return undefined;
  const catalogSegments = catalogSegmentKeys(catalogNumber);
  const row = dataRows[0];
  if (!row.some((cell) => cellContainsCatalogSegment(cell.text, catalogSegments))) return undefined;

  const attributes: AttributeRecord[] = [];
  for (let column = 0; column < headers.length; column += 1) {
    const name = cleanText(headers[column]);
    const value = valueWithHeaderUnit(name, cleanText(row[column]?.text));
    if (!name || !value) continue;
    const optionCodes = headerOptionCodes(name);
    if (optionCodes.length && !optionCodes.some((code) => catalogSegments.has(valueKey(code)))) continue;
    attributes.push({ group, name, value, sourceUrl, scope: "variant" });
  }
  if (!attributes.length) return undefined;
  return { attributes: dedupe(attributes), handled: true };
}

function cellContainsCatalogSegment(text: string, catalogSegments: Set<string>): boolean {
  const words = cleanText(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => word.length >= 2 && catalogSegments.has(valueKey(word)));
}

/** Ordering-option tokens such as K2, K5 or S025, deliberately excluding dimensional numbers. */
function headerOptionCodes(header: string): string[] {
  return cleanText(header)
    .match(/\b(?:[A-Za-z]+\d+[A-Za-z0-9]*|\d+[A-Za-z]+[A-Za-z0-9]*)\b/g)
    ?.filter((token) => /[A-Za-z]/.test(token) && /\d/.test(token)) ?? [];
}

/**
 * Read a header + data layout. Supports both common orientations:
 * - catalog in one data row → headers are properties;
 * - catalog/ordering option selects one of repeated header columns → choose only that column.
 */
function readColumnOrientedTable(matrix: TableMatrix, catalogNumber: string, sourceUrl: string, group: string): TableRead | undefined {
  if (!matrix.headerRows.length || matrix.rows.length <= matrix.headerRows.length) return undefined;
  const width = matrix.rows[0]?.length ?? 0;
  if (width < 2) return undefined;
  const headers = mergedHeaders(matrix, width);
  if (!headers.some(Boolean)) return undefined;
  const dataRows = matrix.rows.slice(matrix.headerRows.length).filter((row) => !isInteractiveRow(row));
  if (!dataRows.length) return undefined;

  const compactCatalog = compactCatalogNumber(catalogNumber);
  const headerCatalogColumns = headers
    .map((header, index) => (compactCatalogNumber(header) === compactCatalog ? index : -1))
    .filter((index) => index >= 0);
  // The same requested catalog printed in two real columns has no deterministic answer. Mark the
  // table handled so the old flattening fallback cannot glue both values back together.
  if (headerCatalogColumns.length > 1) return { attributes: [], handled: true };
  // Comparison tables commonly put the requested full catalog number in a column heading and
  // properties in the first column of each subsequent row. This is the transpose of the usual
  // catalog-in-row table: selecting the header column before flattening is what prevents
  // `Color = Red | Black` from leaking a sibling variant into the target result.
  if (headerCatalogColumns.length === 1) {
    const selectedColumn = headerCatalogColumns[0];
    const attributes = attributesForColumn(dataRows, selectedColumn, sourceUrl, group);
    const suppressedPairs = dataRows.flatMap((row) => {
      const name = cleanText(row[0]?.text);
      const values = unique(row.slice(1).map((cell) => cleanText(cell.text)));
      return name && values.length > 1 ? [{ name, value: values.join(" | ") }] : [];
    });
    return { attributes, handled: true, suppressedPairs };
  }

  const catalogColumns = headers
    .map((header, index) => (isCatalogIdHeaderCell(header) ? index : -1))
    .filter((index) => index >= 0);
  if (catalogColumns.length) {
    const matchingRows = dataRows.filter((row) => catalogColumns.some((column) => compactCatalogNumber(row[column]?.text) === compactCatalog));
    if (matchingRows.length > 1) return { attributes: [], handled: true };
    if (matchingRows.length === 1) return { attributes: attributesForRow(headers, matchingRows[0], sourceUrl, group, new Map()), handled: true };
  }

  // A colspan expands to repeated header labels. If exactly one of its values is an ordering-code
  // segment of our catalog, it is the selected variant. A missing or multiple match is deliberately
  // not flattened — the table is a family matrix and silence is safer than a sibling value.
  const repeatedHeaderColumns = groupedRepeatedHeaders(headers);
  if (!repeatedHeaderColumns.length) return undefined;
  const catalogSegments = catalogSegmentKeys(catalogNumber);
  const rowSelections = new Map<number, number>();
  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex += 1) {
    const row = dataRows[rowIndex];
    for (const columns of repeatedHeaderColumns) {
      const matches = columns.filter((column) => catalogSegments.has(valueKey(row[column]?.text)));
      if (matches.length > 1) return { attributes: [], handled: true };
      if (matches.length === 1) rowSelections.set(rowIndex, matches[0]);
    }
  }
  if (rowSelections.size !== 1) return undefined;
  const [rowIndex, selectedColumn] = [...rowSelections.entries()][0];
  const row = dataRows[rowIndex];
  const selections = new Map(repeatedHeaderColumns.map((columns) => [columns.join(","), selectedColumn]));
  const suppressedPairs = repeatedHeaderColumns.map((columns) => ({
    name: headers[columns[0]],
    value: unique(columns.map((column) => cleanText(row[column]?.text))).join(" ")
  }));
  return { attributes: attributesForRow(headers, row, sourceUrl, group, selections), handled: true, suppressedPairs };
}

/** Extract a spec-per-row / variant-per-column comparison table after an exact catalog header match. */
function attributesForColumn(rows: MatrixCell[][], selectedColumn: number, sourceUrl: string, group: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  for (const row of rows) {
    const name = cleanText(row[0]?.text);
    const value = valueWithHeaderUnit(name, cleanText(row[selectedColumn]?.text));
    if (!name || !value || compactCatalogNumber(name) === compactCatalogNumber(value)) continue;
    attributes.push({ group, name, value, sourceUrl, scope: "variant" });
  }
  return dedupe(attributes);
}

function mergedHeaders(matrix: TableMatrix, width: number): string[] {
  return Array.from({ length: width }, (_, column) => {
    const parts = matrix.headerRows.map((row) => matrix.rows[row][column]?.text).filter(Boolean);
    return unique(parts).join(" / ");
  });
}

function attributesForRow(headers: string[], row: MatrixCell[], sourceUrl: string, group: string, selections: Map<string, number>): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const duplicateGroups = groupedRepeatedHeaders(headers);
  const selectedByColumn = new Map<number, number>();
  for (const columns of duplicateGroups) {
    const selected = selections.get(columns.join(","));
    if (selected !== undefined) for (const column of columns) selectedByColumn.set(column, selected);
  }
  for (let column = 0; column < headers.length; column += 1) {
    const name = cleanText(headers[column]);
    const selected = selectedByColumn.get(column);
    if (selected !== undefined && selected !== column) continue;
    const value = valueWithHeaderUnit(name, cleanText(row[column]?.text));
    if (!name || !value || compactCatalogNumber(name) === compactCatalogNumber(value)) continue;
    // A selected data row or a selected option column is direct evidence for this catalog number.
    attributes.push({ group, name, value, sourceUrl, scope: "variant" });
  }
  return dedupe(attributes);
}

/** A compact data cell commonly omits the unit printed in its column heading (`Rated voltage [V]`). */
function valueWithHeaderUnit(header: string, value: string): string {
  if (!value || !/\d/.test(value)) return value;
  const unit = header.match(/[\[(]\s*(mm|cm|m|kg|g|lb|oz|mV|kV|V|mA|kA|A|mW|kW|W|Hz|kHz|MHz|°C|°F|K|bar|psi|N|Nm)\s*[\])]/i)?.[1];
  if (!unit) return value;
  const unitPattern = new RegExp(`(?:^|\\s)${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "i");
  if (unitPattern.test(value)) return value;
  if (/\s+(?:AC|DC)$/i.test(value)) return value.replace(/\s+(AC|DC)$/i, ` ${unit} $1`);
  return `${value} ${unit}`;
}

function readRowOrientedTable(matrix: TableMatrix, catalogNumber: string, sourceUrl: string, group: string): AttributeRecord[] {
  const headerRows = new Set(matrix.headerRows);
  const attributes: AttributeRecord[] = [];
  for (let rowIndex = 0; rowIndex < matrix.rows.length; rowIndex += 1) {
    if (headerRows.has(rowIndex)) continue;
    const row = matrix.rows[rowIndex];
    if (isInteractiveRow(row)) continue;
    const cells = row.filter((cell) => Boolean(cleanText(cell.text)));
    const nameCell = cells[0];
    const name = cleanText(nameCell?.text);
    if (cells.length < 2 || cells.every((cell) => /^header\s+\d+$/i.test(cleanText(cell.text)))) continue;
    const valueCell = cells.find((cell) => cell !== nameCell);
    const logicalCellCount = new Set(cells).size;
    const optionBound = logicalCellCount === 2 && nameCell && valueCell
      ? optionBoundMultilineAttributes(nameCell, valueCell, catalogNumber, sourceUrl, group)
      : [];
    if (optionBound.length) {
      attributes.push(...optionBound);
      continue;
    }
    // Some manufacturer tables use a single row with aligned `<br>` lists in its label and value
    // cells. Collapsing them makes `Contact material Contact resistor = Silver alloy 25 mΩ`, which
    // cannot pass the spec gate and loses two published facts. Only split exactly two logical cells
    // with equal line counts; image/note side-columns and asymmetric lists stay on the old safe path.
    const aligned = logicalCellCount === 2 && nameCell && valueCell
      ? alignedMultilineAttributes(nameCell, valueCell, catalogNumber, sourceUrl, group)
      : [];
    if (aligned.length) {
      attributes.push(...aligned);
      continue;
    }
    // `buildTableMatrix` deliberately repeats the very same object for every column covered by a
    // colspan. The first logical cell names the row; its repeated matrix coordinates are layout,
    // not values (otherwise `Label = Label | value` leaks into the output).
    const values = unique(cells.slice(1).filter((cell) => cell !== nameCell).map((cell) => cleanText(cell.text)));
    if (values.length) attributes.push({ group, name, value: values.join(" | "), sourceUrl });
  }
  return dedupe(attributes);
}

/** Preserve only the clearly paired portions of an aligned multi-line row.
 *
 * A bold group heading can deliberately face an empty line and a combined label can cover more than
 * one value line. Pairing every non-empty token after collapsing blanks would shift every following
 * value. Keeping matrix positions instead lets simple published facts (e.g. material/resistor) through
 * while dubious or shape-incompatible lines remain silent. */
function alignedMultilineAttributes(
  nameCell: MatrixCell,
  valueCell: MatrixCell,
  catalogNumber: string,
  sourceUrl: string,
  group: string
): AttributeRecord[] {
  if (nameCell.lines.length < 3 || nameCell.lines.length !== valueCell.lines.length) return [];
  const attributes: AttributeRecord[] = [];
  for (let index = 0; index < nameCell.lines.length; index += 1) {
    const name = cleanText(nameCell.lines[index]);
    const value = cleanText(valueCell.lines[index]);
    if (!isSafeAlignedMultilinePair(name, value, catalogNumber)) continue;
    attributes.push({ group, name, value, sourceUrl });
  }
  return dedupe(attributes);
}

/** Select the matching option block when one wide label cell enumerates variants and the value cell
 * has one paragraph per option. The row is otherwise not a safe generic label/value pair. */
function optionBoundMultilineAttributes(
  nameCell: MatrixCell,
  valueCell: MatrixCell,
  catalogNumber: string,
  sourceUrl: string,
  group: string
): AttributeRecord[] {
  const optionLines = nameCell.lines
    .map((line, index) => ({ line: cleanText(line), index }))
    .filter(({ line }) => /^\([A-Za-z0-9]+(?:\s*\/\s*[A-Za-z0-9]+)*\)$/.test(line));
  const values = valueCell.lines.map(cleanText).filter(Boolean);
  if (optionLines.length < 2 || values.length !== optionLines.length) return [];
  const selected = optionLines
    .map(({ line, index }, optionIndex) => ({
      optionIndex,
      line,
      name: cleanText(nameCell.lines.slice(0, index + 1).filter((part) => cleanText(part).toLowerCase() !== "or").join(" "))
    }))
    .filter(({ line }) => line.slice(1, -1).split(/\s*\/\s*/).some((code) => catalogSegmentKeys(catalogNumber).has(valueKey(code))));
  if (selected.length !== 1) return [];
  const match = selected[0];
  return [{ group, name: match.name, value: values[match.optionIndex], sourceUrl }];
}

function isSafeAlignedMultilinePair(name: string, value: string, catalogNumber: string): boolean {
  if (!name || !value || name.length > 90 || value.length > 240) return false;
  if (!/[\p{L}]/u.test(name) || compactCatalogNumber(name) === compactCatalogNumber(value)) return false;
  // A multi-line electrical heading can occupy two value lines. If its following lifecycle label
  // would consequently face a voltage/current, leaving it empty is safer than shifting the value.
  if (/\b(?:lifespan|life\s*span|service\s+life|life\s*cycle)\b/i.test(name) &&
      !/\b(?:cycles?|switch(?:ing)?|operations?|hours?)\b/i.test(value)) return false;
  if (/\b(?:resist(?:or|ance))\b/i.test(name) && !/(?:Ω|ohm)/i.test(value)) return false;
  if (/\bmaterial\b/i.test(name) && !/[\p{L}]/u.test(value)) return false;
  // A family table can align separate `Cable (KU)` and `Plug (SU)` rows. The line structure is
  // sound, but the option code is variant identity: never export the sibling's value just because
  // it shares the same physical table. Single-letter units such as `(V)` are deliberately ignored.
  const optionCode = /\(([A-Za-z]{2,4}\d{0,3}|\d[A-Za-z]{1,3})\)/.exec(name)?.[1];
  if (optionCode && !catalogSegmentKeys(catalogNumber).has(valueKey(optionCode))) return false;
  return true;
}

function tableCellLines($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): string[] {
  const clone = $(element).clone();
  clone.find("p").each((_, paragraph) => {
    $(paragraph).append("\n");
  });
  clone.find("br").replaceWith("\n");
  return clone.text().split(/\r?\n/).map(cleanText);
}

function groupedRepeatedHeaders(headers: string[]): number[][] {
  const groups = new Map<string, number[]>();
  headers.forEach((header, index) => {
    const key = valueKey(header);
    if (!key) return;
    const columns = groups.get(key) ?? [];
    columns.push(index);
    groups.set(key, columns);
  });
  return [...groups.values()].filter((columns) => columns.length > 1);
}

function isInteractiveRow(row: MatrixCell[]): boolean {
  // In the Ganter layout a filter row echoes every available option. It must never be mistaken for
  // a product row; element text alone is insufficient, but these cells carry no useful header/data
  // distinction after Cheerio text extraction. The duplicate header selection below still acts on
  // the actual content row because the filter options contain no selected catalog-specific cell.
  return row.some((cell) => cell.hasInteractiveControl) || row.every((cell) => !cell.text) || row.filter((cell) => cell.text).length < 2;
}

function catalogSegmentKeys(catalogNumber: string): Set<string> {
  return new Set(
    cleanText(catalogNumber)
      .split(/[-/|;]/)
      .map(valueKey)
      .filter((value) => value.length >= 1)
  );
}

function valueKey(value: string | undefined): string {
  return cleanText(value).toLocaleLowerCase().replace(/\s+/g, "");
}

function positiveSpan(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 40) : 1;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = valueKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupe(attributes: AttributeRecord[]): AttributeRecord[] {
  const seen = new Set<string>();
  return attributes.filter((attribute) => {
    const key = `${valueKey(attribute.name)}\u0000${valueKey(String(attribute.value ?? ""))}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tableGroup($: cheerio.CheerioAPI, table: Parameters<cheerio.CheerioAPI>[0]): string {
  const heading = cleanText(
    $(table)
      .closest("details,section,article,div")
      .find("h2,h3,h4,[role='heading'],[class*='heading'],[class*='title']")
      .first()
      .text()
  );
  return heading && heading.length <= 90 ? heading : "Table";
}
