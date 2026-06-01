// Print rows for a single article from a PDT sheet so we can see WHICH fields are filled.
// Usage: node scripts/dump-pdt-rows.cjs <file.xlsx> <sheetName> <articleNumber>
const ExcelJS = require('exceljs');

function cell(v) {
  if (v && typeof v === 'object' && 'text' in v) v = v.text;
  if (v && typeof v === 'object' && 'richText' in v) v = v.richText.map(p => p.text).join('');
  if (v && typeof v === 'object' && 'result' in v) v = v.result;
  if (v && typeof v === 'object' && 'hyperlink' in v) v = v.text || v.hyperlink;
  return v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
}

(async () => {
  const [, , file, sheetName, article] = process.argv;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) { console.error('No such sheet:', sheetName); process.exit(1); }
  console.log(`FILE: ${file}\nSHEET: ${sheetName}\nARTICLE: ${article}`);
  // Find article column (usually column with article numbers — try a few)
  const rowCount = ws.actualRowCount;
  const colCount = ws.actualColumnCount;
  // Find header label row (look for "Articlenumber" or "Material Master Data")
  let headerLabelRow = 0;
  for (let r = 1; r <= Math.min(15, rowCount); r++) {
    for (let c = 1; c <= colCount; c++) {
      const v = cell(ws.getRow(r).getCell(c).value).toLowerCase();
      if (v === 'articlenumber' || v === 'article number') { headerLabelRow = r; break; }
    }
    if (headerLabelRow) break;
  }
  const labels = [];
  if (headerLabelRow) {
    for (let c = 1; c <= colCount; c++) {
      labels[c] = cell(ws.getRow(headerLabelRow).getCell(c).value);
    }
  }
  // Find rows matching article in any column
  const matches = [];
  for (let r = (headerLabelRow || 1) + 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= colCount; c++) {
      if (cell(row.getCell(c).value) === article) { matches.push(r); break; }
    }
  }
  console.log(`Header label row: ${headerLabelRow}, matched data rows: ${matches.length}`);
  matches.slice(0, 25).forEach(r => {
    const row = ws.getRow(r);
    console.log(`\n-- Row ${r} --`);
    for (let c = 1; c <= colCount; c++) {
      const v = cell(row.getCell(c).value);
      if (v) console.log(`  [${c}] ${labels[c] || ''} : ${v.slice(0, 120)}`);
    }
  });
})();
