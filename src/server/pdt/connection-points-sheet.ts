import type ExcelJS from "exceljs";
import type { ProductResult, RunItemRecord } from "../../shared/types.js";
import { classifyDeviceType } from "../scrapers/device-type.js";
import { cellText, describeSheet, type PdtColumn } from "./sheet-descriptor.js";

interface ConnectionPointRow {
  article: string;
  pointName: string;
  connectionName?: string;
  description?: string;
  designation?: string;
  removable?: string;
  connectionType?: string;
  direction?: string;
  symbol?: string;
  functionName?: string;
  protocol?: string;
  mountingName?: string;
  mountingDescription?: string;
  mountingLink?: string;
  connectionGroup?: string;
  connectionFunction?: string;
  ratedVoltage?: string;
  ratedCurrent?: string;
  crossSectionMin?: string;
  crossSectionMax?: string;
  crossSectionTotal?: string;
  awgMin?: string;
  awgMax?: string;
  maxWireCount?: string;
  stripLength?: string;
  socketSize?: string;
  torqueMin?: string;
  torqueMax?: string;
  associatedMounting?: string;
  drillingName?: string;
  drillingType?: string;
  drillingDimension1?: string;
  barredLength?: string;
  barredWidth?: string;
  barredHeight?: string;
  barredType?: string;
  barredTranslateX?: string;
  barredTranslateY?: string;
  barredTranslateZ?: string;
}

interface ConnectionPointColumns {
  article?: number;
  pointName?: number;
  connectionName?: number;
  descriptionDe?: number;
  descriptionEn?: number;
  designation?: number;
  removable?: number;
  connectionType?: number;
  direction?: number;
  symbol?: number;
  functionName?: number;
  protocol?: number;
  mountingName?: number;
  mountingDescription?: number;
  mountingLink?: number;
  connectionGroup?: number;
  connectionFunction?: number;
  connectionPointIds: number[];
  ratedVoltage?: number;
  ratedCurrent?: number;
  crossSectionMin?: number;
  crossSectionMax?: number;
  crossSectionTotal?: number;
  awgMin?: number;
  awgMax?: number;
  awgTotal?: number;
  maxWireCount?: number;
  stripLength?: number;
  socketSize?: number;
  torqueMin?: number;
  torqueMax?: number;
  associatedMounting?: number;
  drillingName?: number;
  drillingType?: number;
  drillingDimension1?: number;
  barredLength?: number;
  barredWidth?: number;
  barredHeight?: number;
  barredType?: number;
  barredTranslateX?: number;
  barredTranslateY?: number;
  barredTranslateZ?: number;
}

export function writeConnectionPointsSheet(ws: ExcelJS.Worksheet, items: RunItemRecord[]): number {
  const descriptor = describeSheet(ws);
  if (!descriptor) return 0;
  const columns = connectionPointColumns(descriptor.columns);
  if (!columns.article || !columns.pointName) return 0;

  const firstDataRow = firstConnectionDataRow(ws, descriptor.firstBodyRow);
  clearConnectionBody(ws, descriptor.firstBodyRow);

  let rowIndex = firstDataRow;
  let written = 0;
  for (const item of items) {
    const rows = connectionRowsFor(item);
    for (const row of rows) {
      writeConnectionRow(ws, rowIndex, columns, row);
      rowIndex += 1;
      written += 1;
    }
    if (rows.length) rowIndex += 1;
  }
  return written;
}

function connectionPointColumns(columns: PdtColumn[]): ConnectionPointColumns {
  const find = (...patterns: RegExp[]) =>
    columns.find((column) => patterns.some((pattern) => pattern.test(`${column.code} ${column.propName} ${column.description}`)))?.col;
  const findAll = (...patterns: RegExp[]) =>
    columns
      .filter((column) => patterns.some((pattern) => pattern.test(`${column.code} ${column.propName} ${column.description}`)))
      .map((column) => column.col);
  return {
    article: find(/\bAAO676\b/i, /\barticle(?:number)?\b/i),
    pointName: find(/\bOnly Classification\b/i, /\bconnection point name pins\b/i),
    connectionName: find(/\bAAC342\b/i, /\bconnection name\b/i),
    descriptionDe: find(/\bAAN342\b/i, /\bconnection description \(DE\)/i),
    descriptionEn: find(/\bCNS_CONNECTION_DESCRIPTION\b/i, /\bconnection description \(EN\)/i),
    designation: find(/\bAAN341\b/i, /\bconnection designation\b/i),
    removable: find(/\bAAN497\b/i, /\bremov/i),
    connectionType: find(/\bAAM734\b/i, /\bconnection type\b/i),
    direction: find(/\bAAN496\b/i, /\bconnection direction\b/i),
    symbol: find(/\bAAB754\b/i, /\bsymbolnumber\b/i),
    functionName: find(/\bAAC338\b/i, /\bfunction name\b/i),
    protocol: find(/\bAAM479\b/i, /\bsupported protocol\b/i),
    mountingName: find(/\bAAS191\b/i, /\bname of fixing variant\b/i),
    mountingDescription: find(/\bCNS_SIM_DESCRIPTION\b/i, /\btype of mounting\b/i),
    mountingLink: find(/\bLink MD\b/i, /\blink mounting description\b/i),
    connectionGroup: find(/\bAAC313\b/i, /\bconnection group\b/i),
    connectionFunction: find(/\bAAN413\b/i, /\bconnection function\b/i),
    connectionPointIds: findAll(/\bCNS_PARENT_CLS_ID_INST_ID\b/i, /\bConnection Point ID\b/i),
    ratedVoltage: find(/\bBAH005\b/i, /\bCNS_RATED_VOLTAGE\b/i),
    ratedCurrent: find(/\bAAB485\b/i, /\bCNS_RATED_CURRENT\b/i),
    crossSectionMin: find(/\bCROSSSECTION_MIN\b/i, /\bCROSSSMIN\b/i),
    crossSectionMax: find(/\bCROSSSECTION_MAX\b/i, /\bCROSSSMAX\b/i),
    crossSectionTotal: find(/\bAAS444\b/i, /\bTotal max\.? cross section\b/i),
    awgMin: find(/\bCROSSSECTION_MIN_AWG\b/i),
    awgMax: find(/\bCROSSSECTION_MAX_AWG\b/i),
    awgTotal: find(/\bAAC384\b/i, /\bTotal max cross section AWG\b/i),
    maxWireCount: find(/\bMAX_WIRE_COUNT\b/i, /\bMAXWC\b/i),
    stripLength: find(/\bAAB202\b/i, /\bStrip length\b/i),
    socketSize: find(/\bAAG644\b/i, /\bCNS_SOCKET_SIZE\b/i),
    torqueMin: find(/\bAAS447_MIN\b/i, /\b00005E001\b/i),
    torqueMax: find(/\bAAS447_MAX\b/i, /\b00005G001\b/i),
    associatedMounting: find(/\b00004D001\b/i, /\bassociated mounting description\b/i),
    drillingName: find(/\bAAS449\b/i, /\bdrilling name\b/i),
    drillingType: find(/\bAAN476\b/i, /\bdrilling type\b/i),
    drillingDimension1: find(/\bCNS_DRILLING_DIMENSION1\b/i, /\bBAA561\b/i),
    barredLength: find(/\bbarred\/restricted Area, Length\b/i, /\bCNSLENGTH\b/i),
    barredWidth: find(/\bbarred\/restricted Area, Width\b/i, /\bCNSWIDTH\b/i),
    barredHeight: find(/\bbarred\/restricted Area, Height\b/i, /\bCNSHEIGHT\b/i),
    barredType: find(/\bAAM654\b/i, /\bCNS_TYPE_OF_BARRED_AREA\b/i),
    barredTranslateX: find(/\bbarred\/restricted Area, Translate X\b/i, /\bCNSTRANSX\b/i),
    barredTranslateY: find(/\bbarred\/restricted Area, Translate Y\b/i, /\bCNSTRANSY\b/i),
    barredTranslateZ: find(/\bbarred\/restricted Area, Translate Z\b/i, /\bCNSTRANSZ\b/i)
  };
}

function firstConnectionDataRow(ws: ExcelJS.Worksheet, describedBodyRow: number): number {
  return /^body$/i.test(cellText(ws.getCell(describedBodyRow, 1).value)) ? describedBodyRow + 1 : describedBodyRow;
}

function clearConnectionBody(ws: ExcelJS.Worksheet, firstDataRow: number): void {
  for (let row = firstDataRow; row <= ws.rowCount; row += 1) {
    for (let col = 2; col <= ws.columnCount; col += 1) {
      ws.getCell(row, col).value = null;
    }
  }
}

function writeConnectionRow(ws: ExcelJS.Worksheet, rowIndex: number, columns: ConnectionPointColumns, row: ConnectionPointRow): void {
  const set = (col: number | undefined, value: string | undefined) => {
    if (col && value) ws.getCell(rowIndex, col).value = value;
  };
  set(columns.article, row.article);
  set(columns.pointName, row.pointName);
  set(columns.connectionName, row.connectionName);
  set(columns.descriptionDe, row.description);
  set(columns.descriptionEn, row.description);
  set(columns.designation, row.designation);
  set(columns.removable, row.removable);
  set(columns.connectionType, row.connectionType);
  set(columns.direction, row.direction);
  set(columns.symbol, row.symbol);
  set(columns.functionName, row.functionName);
  set(columns.protocol, row.protocol);
  set(columns.mountingName, row.mountingName);
  set(columns.mountingDescription, row.mountingDescription);
  set(columns.mountingLink, row.mountingLink);
  set(columns.connectionGroup, row.connectionGroup);
  set(columns.connectionFunction, row.connectionFunction);
  for (const col of columns.connectionPointIds) set(col, row.pointName.startsWith("ECP_") ? row.pointName : undefined);
  set(columns.ratedVoltage, row.ratedVoltage);
  set(columns.ratedCurrent, row.ratedCurrent);
  set(columns.crossSectionMin, row.crossSectionMin);
  set(columns.crossSectionMax, row.crossSectionMax);
  set(columns.crossSectionTotal, row.crossSectionTotal);
  set(columns.awgMin, row.awgMin);
  set(columns.awgMax, row.awgMax);
  set(columns.awgTotal, row.awgMax);
  set(columns.maxWireCount, row.maxWireCount);
  set(columns.stripLength, row.stripLength);
  set(columns.socketSize, row.socketSize);
  set(columns.torqueMin, row.torqueMin);
  set(columns.torqueMax, row.torqueMax);
  set(columns.associatedMounting, row.associatedMounting);
  set(columns.drillingName, row.drillingName);
  set(columns.drillingType, row.drillingType);
  set(columns.drillingDimension1, row.drillingDimension1);
  set(columns.barredLength, row.barredLength);
  set(columns.barredWidth, row.barredWidth);
  set(columns.barredHeight, row.barredHeight);
  set(columns.barredType, row.barredType);
  set(columns.barredTranslateX, row.barredTranslateX);
  set(columns.barredTranslateY, row.barredTranslateY);
  set(columns.barredTranslateZ, row.barredTranslateZ);
}

function connectionRowsFor(item: RunItemRecord): ConnectionPointRow[] {
  const result = item.result;
  if (!result) return [];
  const deviceType = classifyDeviceType(result).type;
  if (deviceType === "Cable" || deviceType === "Wire Marker") return [];

  const familyRows = rockwellConnectionRows(item, result);
  if (familyRows.length) return familyRows;
  const abbRows = abbConnectionRows(item, result);
  if (abbRows.length) return abbRows;
  const eatonRows = eatonConnectionRows(item, result);
  if (eatonRows.length) return eatonRows;

  const rows: ConnectionPointRow[] = [];
  rows.push(...powerRows(item, result));
  rows.push(...channelRows(item, result, "input"));
  rows.push(...channelRows(item, result, "output"));
  if (!rows.length && shouldHaveElectricalConnection(result, deviceType)) {
    rows.push(electricalRow(item.catalogNumber, 1, "1", "MAIN1"));
    rows.push(electricalRow(item.catalogNumber, 2, "2", "MAIN2"));
  }

  const mounting = mountingDescription(result);
  if (mounting) {
    rows.push({
      article: item.catalogNumber,
      pointName: "MD",
      mountingName: mounting,
      mountingDescription: mounting,
      mountingLink: "LINK_MD"
    });
  }

  return rows.slice(0, 80);
}

function abbConnectionRows(item: RunItemRecord, result: ProductResult): ConnectionPointRow[] {
  if (result.manufacturerId !== "abb") return [];
  const catalog = item.catalogNumber.toUpperCase();
  // Contactor (1SBL*) — coil + 3-phase main contacts + aux contacts.
  if (/^1SBL/i.test(catalog)) {
    const terminalNames = ["A1", "A2", "1L1", "2T1", "3L2", "4T2", "5L3", "6T3", "13NO", "14NO", "21NC", "22NC"];
    return [
      ...terminalNames.map((name, index) => electricalRow(item.catalogNumber, index + 1, name, abbConnectionFunction(name), abbElectricalDefaults(result))),
      operationRow(item.catalogNumber),
      mountingRow(item.catalogNumber, "MD", abbMountingDescription(result)),
      drillRow(item.catalogNumber, 1, "MD"),
      drillRow(item.catalogNumber, 2, "MD"),
      drillRow(item.catalogNumber, 3, "MD")
    ];
  }
  // For all other ABB articles (accessories like 1SDA*, drives, robotics, etc.) the manual PDT
  // typically lists only an operation point (OP) and a mounting description (MD). We previously
  // emitted a 12-row motor terminal template for everything that wasn't 1SBL, which polluted the
  // CP sheet for E-MAX accessories where the manual operator wrote only OP+MD per article.
  return [
    operationRow(item.catalogNumber),
    mountingRow(item.catalogNumber, "MD", abbMountingDescription(result))
  ];
}

function abbConnectionFunction(name: string): string {
  if (/^(?:A1|A2)$/i.test(name)) return "COIL";
  if (/^(?:1L1|2T1|3L2|4T2|5L3|6T3)$/i.test(name)) return "MAIN";
  if (/^(?:13NO|14NO|21NC|22NC)$/i.test(name)) return "AUX";
  return name;
}

function abbElectricalDefaults(result: ProductResult): Partial<ConnectionPointRow> {
  return {
    ...electricalDefaults(result),
    connectionType: "10",
    crossSectionMin: "0.14",
    crossSectionMax: "1.5",
    crossSectionTotal: "1.5",
    awgMin: "26",
    awgMax: "16",
    maxWireCount: "1",
    stripLength: "8",
    socketSize: "3.5x0.6",
    torqueMin: "0.22",
    torqueMax: "0.25"
  };
}

function abbMountingDescription(result: ProductResult): string {
  return mountingDescription(result) ?? "Screw mounting";
}

function eatonConnectionRows(item: RunItemRecord, result: ProductResult): ConnectionPointRow[] {
  if (result.manufacturerId !== "eaton") return [];
  if (/^CBE\d+$/i.test(item.catalogNumber)) {
    return [
      ...numberedElectricalRows(item, result, 12),
      operationRow(item.catalogNumber),
      mountingRow(item.catalogNumber, "MD", "DIN rail mounting")
    ];
  }
  const model = attr(result, /\b(?:model code|modellcode|type code|typecode)\b/i) ?? "";
  if (/^PSN-FP\/?S?-NZM/i.test(model)) {
    return [
      operationRow(item.catalogNumber),
      mountingRow(item.catalogNumber, "MD", "Front Plate"),
      mountingPointRow(item.catalogNumber, "MP_PA_1", "Mounting surface"),
      mountingPointRow(item.catalogNumber, "MP_PA_2", "Mounting surface NC front"),
      areaRow(item.catalogNumber, "ARES_1", "1"),
      areaRow(item.catalogNumber, "ARES_2", "1"),
      areaRow(item.catalogNumber, "ARES_3", "1"),
      areaRow(item.catalogNumber, "ARES_4", "1"),
      areaRow(item.catalogNumber, "BAR_1", "4"),
      areaRow(item.catalogNumber, "BAR_2", "4"),
      areaRow(item.catalogNumber, "BAR_3", "4"),
      areaRow(item.catalogNumber, "BAR_4", "4")
    ];
  }
  if (!/^PSN-PIP-BN/i.test(model)) return [];
  const compact = model.toUpperCase();
  const hasMiddlePanel = !/(?:400\/300-BL|1000\/500-BL)\b/i.test(compact);
  return [
    operationRow(item.catalogNumber),
    mountingRow(item.catalogNumber, "MD", "Mounted"),
    mountingPointRow(item.catalogNumber, "MP_PA_1", "Mounting surface"),
    mountingPointRow(item.catalogNumber, "MP_PA_2", "Mounting surface NC front"),
    areaRow(item.catalogNumber, "ARES_1", "1"),
    areaRow(item.catalogNumber, "ARES_2", "1"),
    areaRow(item.catalogNumber, "ARES_3", "1"),
    areaRow(item.catalogNumber, "ARES_4", "1"),
    ...(hasMiddlePanel ? [areaRow(item.catalogNumber, "ARES_5", "1")] : []),
    areaRow(item.catalogNumber, "BAR_1", "4"),
    areaRow(item.catalogNumber, "BAR_2", "4"),
    ...(hasMiddlePanel ? [areaRow(item.catalogNumber, "BAR_3", "4")] : []),
    mountingPointRow(item.catalogNumber, "MP_1", "Mounting point"),
    mountingPointRow(item.catalogNumber, "MP_2", "Mounting point")
  ];
}

function rockwellConnectionRows(item: RunItemRecord, result: ProductResult): ConnectionPointRow[] {
  if (result.manufacturerId !== "rockwell") return [];
  const catalog = item.catalogNumber.toUpperCase();
  if (/^2080-LC20-20/.test(catalog)) return micro820Rows(item, result);
  if (/^2198-DSD/.test(catalog)) {
    return [
      ...numberedElectricalRows(item, result, 59),
      operationRow(item.catalogNumber),
      mountingRow(item.catalogNumber, "MD", mountingDescription(result) ?? "Mounted")
    ];
  }
  if (/^1756-L9/.test(catalog)) {
    return [
      electricalRow(item.catalogNumber, 1, "ETH_1", "ETH1", electricalDefaults(result)),
      electricalRow(item.catalogNumber, 2, "ETH_2", "ETH2", electricalDefaults(result)),
      electricalRow(item.catalogNumber, 3, "USB", "USB", electricalDefaults(result)),
      operationRow(item.catalogNumber),
      mountingRow(item.catalogNumber, "MD", mountingDescription(result) ?? "Mounted")
    ];
  }
  if (/^1492-PD/.test(catalog)) {
    const ecpCount = /183\b/.test(catalog) ? 10 : 5;
    return [
      ...numberedElectricalRows(item, result, ecpCount),
      operationRow(item.catalogNumber),
      mountingRow(item.catalogNumber, "MD_1", "DIN rail mounting"),
      mountingRow(item.catalogNumber, "MD_2", "Mounted"),
      drillRow(item.catalogNumber, 1, "MD_2"),
      drillRow(item.catalogNumber, 2, "MD_2")
    ];
  }
  return [];
}

function micro820Rows(item: RunItemRecord, result: ProductResult): ConnectionPointRow[] {
  const names = [
    "+DC10",
    "-DC24-1",
    "I-00",
    "I-01",
    "I-02",
    "I-03",
    "COM0",
    "I-04",
    "I-05",
    "I-06",
    "I-07",
    "I-08",
    "I-09",
    "I-10",
    "I-11",
    "NU1",
    "+DC24",
    "-DC24-2",
    "-DC24-3",
    "VO-0",
    "NU2",
    "CM0",
    "O-00",
    "CM1",
    "O-01",
    "CM2",
    "O-02",
    "O-03",
    "CM3",
    "O-04",
    "O-05",
    "O-06",
    "D+",
    "D-",
    "GND1",
    "RX",
    "TX",
    "GND2",
    "ETH"
  ];
  return [
    ...names.map((name, index) => electricalRow(item.catalogNumber, index + 1, name, `CH${index + 1}`, electricalDefaults(result))),
    operationRow(item.catalogNumber),
    mountingRow(item.catalogNumber, "MD_1", "DIN rail mounting"),
    mountingRow(item.catalogNumber, "MD_2", "Mounted"),
    drillRow(item.catalogNumber, 1, "MD_2"),
    drillRow(item.catalogNumber, 2, "MD_2"),
    drillRow(item.catalogNumber, 3, "MD_2"),
    drillRow(item.catalogNumber, 4, "MD_2")
  ];
}

function numberedElectricalRows(
  item: RunItemRecord,
  result: ProductResult,
  count: number
): ConnectionPointRow[] {
  const defaults = electricalDefaults(result);
  // Only PLC / I/O / Communication-Gateway / HMI devices have logical channel names ("CHn") in
  // the manual PDTs. For circuit breakers, terminal blocks, disconnect switches, etc. the
  // channel-name column is left blank — emitting "CH1..CHn" there is pollution.
  const deviceType = classifyDeviceType(result).type ?? "";
  const usesChannelNames = /\b(PLC|I\/O|Communication Gateway|Programmable Logic|HMI)\b/i.test(deviceType);
  return Array.from({ length: count }, (_, index) =>
    electricalRow(
      item.catalogNumber,
      index + 1,
      String(index + 1),
      usesChannelNames ? `CH${index + 1}` : "",
      defaults
    )
  );
}

function powerRows(item: RunItemRecord, result: ProductResult): ConnectionPointRow[] {
  const voltageText = attr(result, /\b(?:supply|input|operating|rated).*voltage\b/i) ?? result.normalized.voltage ?? "";
  if (!voltageText) return [];
  if (/\bDC\b/i.test(voltageText)) {
    const voltage = voltageText.match(/\b(12|24|48|60|110|125)\b/)?.[1] ?? "DC";
    return [
      electricalRow(item.catalogNumber, 1, `+DC${voltage}`, "MAIN1"),
      electricalRow(item.catalogNumber, 2, `-DC${voltage}`, "MAIN2")
    ];
  }
  if (/\bAC\b|\b(?:120|230|240|400|480)\s*V\b/i.test(voltageText)) {
    return [
      electricalRow(item.catalogNumber, 1, "L", "MAIN1"),
      electricalRow(item.catalogNumber, 2, "N", "MAIN2"),
      electricalRow(item.catalogNumber, 3, "PE", "PE")
    ];
  }
  return [];
}

function channelRows(item: RunItemRecord, result: ProductResult, kind: "input" | "output"): ConnectionPointRow[] {
  const count = channelCount(result, kind);
  if (!count) return [];
  const prefix = kind === "input" ? "I" : "O";
  return Array.from({ length: Math.min(count, 64) }, (_, index) =>
    electricalRow(item.catalogNumber, index + 1, `${prefix}-${String(index).padStart(2, "0")}`, `CH${index + 1}`)
  );
}

function channelCount(result: ProductResult, kind: "input" | "output"): number | undefined {
  const pattern = kind === "input"
    ? /\b(?:digital|analog)?\s*inputs?\b|\binputs?\s*(?:digital|analog)?\b/i
    : /\b(?:digital|analog|relay)?\s*outputs?\b|\boutputs?\s*(?:digital|analog|relay)?\b/i;
  const candidates = result.attributes
    .filter((attribute) => pattern.test(`${attribute.group ?? ""} ${attribute.name}`) && /\d/.test(attribute.value))
    .map((attribute) => Number(attribute.value.match(/\d+/)?.[0]))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 256);
  return candidates.length ? Math.max(...candidates) : undefined;
}

function electricalRow(
  article: string,
  index: number,
  name: string,
  functionName: string,
  defaults: Partial<ConnectionPointRow> = {}
): ConnectionPointRow {
  return {
    article,
    pointName: `ECP_${index}`,
    connectionName: name,
    designation: name,
    removable: "2",
    connectionType: "13",
    direction: "2",
    symbol: symbolNumber(name, index),
    functionName,
    connectionFunction: "18",
    ...defaults
  };
}

function symbolNumber(name: string, index: number): string {
  if (/^(?:I-|O-|ETH|USB|RX|TX|D[+-]|GND|COM|CM|NU|VO)/i.test(name)) return `CNS012502-0003||${index}||1`;
  if (/^-/.test(name)) return `CNS012503-0002||${index}||1`;
  return `CNS012503-0001||${index}||1`;
}

function operationRow(article: string): ConnectionPointRow {
  return { article, pointName: "OP" };
}

function mountingRow(article: string, pointName: string, description: string): ConnectionPointRow {
  return {
    article,
    pointName,
    mountingName: description,
    mountingDescription: description,
    mountingLink: "LINK_MD"
  };
}

function mountingPointRow(article: string, pointName: string, description: string): ConnectionPointRow {
  return {
    article,
    pointName,
    mountingName: description,
    mountingDescription: description,
    mountingLink: "LINK_MD"
  };
}

function areaRow(article: string, pointName: string, barredType: string): ConnectionPointRow {
  return {
    article,
    pointName,
    barredLength: "10",
    barredWidth: "10",
    barredHeight: "10",
    barredType,
    barredTranslateX: "0",
    barredTranslateY: "0",
    barredTranslateZ: "0"
  };
}

function drillRow(article: string, index: number, associatedMounting: string): ConnectionPointRow {
  return {
    article,
    pointName: `DRILL_${index}`,
    associatedMounting,
    drillingName: `DRILL_${index}`,
    drillingType: "1",
    drillingDimension1: "5"
  };
}

function electricalDefaults(result: ProductResult): Partial<ConnectionPointRow> {
  return {
    ratedVoltage: voltageNumber(result) ?? "24",
    ratedCurrent: currentNumber(result) ?? "0.016",
    crossSectionMin: crossSectionBound(result, "min") ?? "0.2",
    crossSectionMax: crossSectionBound(result, "max") ?? "2.5",
    crossSectionTotal: crossSectionBound(result, "max") ?? "2.5",
    awgMin: awgBound(result, "min") ?? "24",
    awgMax: awgBound(result, "max") ?? "14",
    maxWireCount: "1",
    stripLength: numberAttr(result, /\bstrip length\b/i) ?? "7",
    socketSize: "0.6x3.5",
    torqueMin: torqueBound(result, "min") ?? "0.5",
    torqueMax: torqueBound(result, "max") ?? "0.6"
  };
}

function voltageNumber(result: ProductResult): string | undefined {
  return numberAttr(result, /\b(?:supply|input|operating|rated|nominal|power input).*voltage\b|\bpower input\b/i) ?? numberOf(result.normalized.voltage);
}

function currentNumber(result: ProductResult): string | undefined {
  return numberAttr(result, /\b(?:rated|permanent|nominal|operating).*current\b/i) ?? numberOf(result.normalized.current);
}

function crossSectionBound(result: ProductResult, bound: "min" | "max"): string | undefined {
  const value = attr(result, /\b(?:wire size|conductor cross|cross[-\s]?section|connection cross)\b/i);
  return numericBound(value, bound);
}

function awgBound(result: ProductResult, bound: "min" | "max"): string | undefined {
  const value = attr(result, /\b(?:wire size|conductor|cross[-\s]?section|AWG)\b/i);
  const values = [...(value ?? "").matchAll(/\b(\d{1,3})\s*AWG\b/gi)].map((match) => Number(match[1])).filter(Number.isFinite);
  if (!values.length) return undefined;
  return String(bound === "min" ? Math.min(...values) : Math.max(...values));
}

function torqueBound(result: ProductResult, bound: "min" | "max"): string | undefined {
  return numericBound(attr(result, /\b(?:screw torque|torque|tightening torque)\b/i), bound);
}

function numberAttr(result: ProductResult, pattern: RegExp): string | undefined {
  return numberOf(attr(result, pattern));
}

function numberOf(value: string | undefined): string | undefined {
  return value?.replace(/,/g, ".").match(/-?\d+(?:\.\d+)?/)?.[0];
}

function numericBound(value: string | undefined, bound: "min" | "max"): string | undefined {
  const values = [...(value ?? "").replace(/,/g, ".").matchAll(/-?\d+(?:\.\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter(Number.isFinite);
  if (!values.length) return undefined;
  return String(bound === "min" ? Math.min(...values) : Math.max(...values));
}

function shouldHaveElectricalConnection(result: ProductResult, deviceType: string | undefined): boolean {
  const text = [deviceType, result.title, result.description, result.normalized.voltage, result.normalized.current]
    .filter(Boolean)
    .join(" ");
  if (/\b(?:PLC|I\/O|HMI|contactor|relay|switch|pushbutton|operator|drive|power supply|sensor|terminal|connector|motor|breaker|fuse)\b/i.test(text)) return true;
  return Boolean(attr(result, /\b(?:terminal|connection|contact block|coil|supply voltage|rated current)\b/i));
}

function mountingDescription(result: ProductResult): string | undefined {
  const value = attr(result, /\b(?:mounting type|mounting method|mounting|installation)\b/i);
  if (!value) return undefined;
  if (/\bdin\b|\brail\b/i.test(value)) return "DIN Rail mounting";
  if (/\bscrew\b/i.test(value)) return "Screw mounting";
  if (/\bsnap\b/i.test(value)) return "Snap-on mounting";
  if (/\bpanel\b/i.test(value)) return "Panel mounting";
  return value.length <= 80 ? value : undefined;
}

function attr(result: ProductResult, pattern: RegExp): string | undefined {
  return result.attributes.find((attribute) => pattern.test(`${attribute.group ?? ""} ${attribute.name}`) && attribute.value.trim())?.value;
}
