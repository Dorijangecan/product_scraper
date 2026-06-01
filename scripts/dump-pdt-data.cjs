// Dump data rows of a sheet in CSV-ish form (label : value pairs per row).
// Usage: node scripts/dump-pdt-data.cjs <file.xlsx> <sheetName> [startRow] [endRow]
const ExcelJS = require('exceljs');

function cell(v) {
  if (v && typeof v === 'object' && 'text' in v) v = v.text;
  if (v && typeof v === 'object' && 'richText' in v) v = v.richText.map(p => p.text).join('');
  if (v && typeof v === 'object' && 'result' in v) v = v.result;
  if (v && typeof v === 'object' && 'hyperlink' in v) v = v.text || v.hyperlink;
  return v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
}

(async () => {
  const [, , file, sheetName, startArg, endArg] = process.argv;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) { console.error('No such sheet:', sheetName); process.exit(1); }
  const colCount = ws.actualColumnCount;
  const rowCount = ws.actualRowCount;
  // Find header label row
  let headerLabelRow = 0;
  for (let r = 1; r <= Math.min(15, rowCount); r++) {
    for (let c = 1; c <= colCount; c++) {
      const v = cell(ws.getRow(r).getCell(c).value).toLowerCase();
      if (v === 'articlenumber' || v === 'article number' || v.startsWith('aao677')) { headerLabelRow = r; break; }
    }
    if (headerLabelRow) break;
  }
  const labels = [];
  for (let c = 1; c <= colCount; c++) {
    labels[c] = headerLabelRow ? cell(ws.getRow(headerLabelRow).getCell(c).value) : `col${c}`;
  }
  const start = parseInt(startArg || (headerLabelRow + 1), 10);
  const end = parseInt(endArg || Math.min(start + 5, rowCount), 10);
  console.log(`FILE ${file}\nSHEET ${sheetName} headerLabelRow=${headerLabelRow} cols=${colCount} rows=${rowCount}`);
  console.log('Labels:', labels.slice(1).map((l, i) => `${i+1}=${l}`).join(' | '));
  for (let r = start; r <= end; r++) {
    const row = ws.getRow(r);
    console.log(`\n=== Row ${r} ===`);
    for (let c = 1; c <= colCount; c++) {
      const v = cell(row.getCell(c).value);
      if (v) console.log(`  ${labels[c] || c}: ${v.slice(0, 200)}`);
    }
  }
})();
