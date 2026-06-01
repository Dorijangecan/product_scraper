// Dump each sheet of a workbook: header row, first 3 data rows, and fill-rate per column.
// Usage: node scripts/dump-pdt-stats.cjs <file1.xlsx> [file2.xlsx ...]
const ExcelJS = require('exceljs');
const path = require('path');

async function dump(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  console.log('\n========================================');
  console.log('FILE:', file);
  console.log('========================================');
  wb.worksheets.forEach(ws => {
    const rowCount = ws.actualRowCount;
    const colCount = ws.actualColumnCount;
    console.log(`\n--- Sheet: "${ws.name}"  rows=${rowCount}  cols=${colCount}`);
    if (rowCount === 0) return;
    // Find header row (first non-empty row)
    let headerRowIdx = 1;
    for (let r = 1; r <= Math.min(10, rowCount); r++) {
      const row = ws.getRow(r);
      const vals = row.values.filter(v => v != null && String(v).trim() !== '');
      if (vals.length >= 2) { headerRowIdx = r; break; }
    }
    const headerRow = ws.getRow(headerRowIdx);
    const headers = [];
    for (let c = 1; c <= colCount; c++) {
      const v = headerRow.getCell(c).value;
      headers.push(v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
    }
    console.log('  HeaderRow:', headerRowIdx);
    console.log('  Headers:', JSON.stringify(headers));

    // Fill stats: count non-empty cells per column over rows below header
    const fills = new Array(colCount).fill(0);
    let dataRows = 0;
    for (let r = headerRowIdx + 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      let any = false;
      for (let c = 1; c <= colCount; c++) {
        let v = row.getCell(c).value;
        if (v && typeof v === 'object' && 'text' in v) v = v.text;
        if (v && typeof v === 'object' && 'richText' in v) v = v.richText.map(p => p.text).join('');
        if (v && typeof v === 'object' && 'result' in v) v = v.result;
        if (v != null && String(v).trim() !== '') { fills[c - 1]++; any = true; }
      }
      if (any) dataRows++;
    }
    console.log('  DataRows:', dataRows);
    const fillReport = headers.map((h, i) => ({
      col: i + 1,
      header: h.slice(0, 40),
      filled: fills[i],
      pct: dataRows ? Math.round((fills[i] / dataRows) * 100) : 0
    }));
    console.log('  FillRate:');
    fillReport.forEach(f => {
      console.log(`    col ${String(f.col).padStart(3)}  ${String(f.pct).padStart(3)}%  (${f.filled}/${dataRows})  ${f.header}`);
    });

    // Print first 3 data rows truncated
    console.log('  Sample rows (header + first 3):');
    for (let r = headerRowIdx + 1; r <= Math.min(headerRowIdx + 3, rowCount); r++) {
      const row = ws.getRow(r);
      const vals = [];
      for (let c = 1; c <= Math.min(colCount, 18); c++) {
        let v = row.getCell(c).value;
        if (v && typeof v === 'object' && 'text' in v) v = v.text;
        if (v && typeof v === 'object' && 'richText' in v) v = v.richText.map(p => p.text).join('');
        if (v && typeof v === 'object' && 'result' in v) v = v.result;
        vals.push(v == null ? '' : String(v).slice(0, 30).replace(/\s+/g, ' '));
      }
      console.log(`    r${r}: ${vals.map(v => v || '·').join(' | ')}`);
    }
  });
}

(async () => {
  for (const f of process.argv.slice(2)) {
    try { await dump(f); }
    catch (e) { console.error('ERR', f, e.message); }
  }
})();
