// Audit ALL example PDTs: for every sheet, list every column that has data in any row.
// Output is grouped by (manufacturer, sheet) → list of (propertyId, header description, sample value).
// Use this to drive resolver coverage decisions.
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

function cell(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('text' in v) v = v.text;
    else if ('richText' in v) v = v.richText.map((p) => p.text).join('');
    else if ('result' in v) v = v.result;
    else if ('hyperlink' in v) v = v.text || v.hyperlink;
    else v = JSON.stringify(v);
  }
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

async function dumpFile(file, manufacturer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const findings = [];
  for (const ws of wb.worksheets) {
    if (ws.actualRowCount < 3) continue;
    // header row(s): try rows 1-8, find row that has "AAO676" or "ECLASS property" or starts with property codes
    let propIdRow = 0;
    let headerRow = 0;
    let unitsRow = 0;
    let dataStart = 0;
    for (let r = 1; r <= Math.min(15, ws.actualRowCount); r++) {
      for (let c = 1; c <= ws.actualColumnCount; c++) {
        const v = cell(ws.getRow(r).getCell(c).value);
        if (/^AAO676$/i.test(v) || /^Articlenumber$/i.test(v)) {
          if (!propIdRow) propIdRow = r;
        }
        if (/^ECLASS property$/i.test(v)) {
          // The header structure row precedes
        }
      }
    }
    // simplistic: assume row r=6 (propIds) and r=8 (descriptions) for ABB-style sheets
    // Just iterate rows and detect "data" rows = rows with at least 2 non-empty cells past row 8
    const cols = ws.actualColumnCount;
    const filled = new Map(); // colNum -> { propId, header, samples }
    for (let r = 1; r <= ws.actualRowCount; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= cols; c++) {
        const v = cell(row.getCell(c).value);
        if (!v || v === '-' || v === '*' || v === '·') continue;
        if (!filled.has(c)) filled.set(c, { count: 0, samples: [] });
        const entry = filled.get(c);
        entry.count++;
        if (entry.samples.length < 2 && v.length < 80) entry.samples.push(v);
      }
    }
    // Header rows: try to detect propId row by scanning for "AAO676" or "MANUFACTURER_URL"
    let propRowGuess = 0;
    for (let r = 1; r <= Math.min(15, ws.actualRowCount); r++) {
      let hits = 0;
      for (let c = 1; c <= cols; c++) {
        const v = cell(ws.getRow(r).getCell(c).value);
        if (/^(AAO676|AAO677|MANUFACTURER_URL|AAQ326|REFERENCE_FEATURE)/i.test(v)) hits++;
      }
      if (hits >= 2) { propRowGuess = r; break; }
    }
    // Description row often follows propId row
    const descRowGuess = propRowGuess ? propRowGuess + 2 : 0;
    const cols2 = [];
    for (const [c, info] of filled.entries()) {
      const propId = propRowGuess ? cell(ws.getRow(propRowGuess).getCell(c).value) : '';
      const desc = descRowGuess ? cell(ws.getRow(descRowGuess).getCell(c).value).slice(0, 60) : '';
      if (info.count >= 3) {
        cols2.push({ c, propId, desc, count: info.count, samples: info.samples });
      }
    }
    if (cols2.length) findings.push({ sheet: ws.name, cols: cols2 });
  }
  return findings;
}

async function main() {
  const root = 'primjeri PDTa';
  const groups = fs.readdirSync(root).filter((g) => fs.statSync(path.join(root, g)).isDirectory());
  for (const group of groups) {
    const files = fs.readdirSync(path.join(root, group)).filter((f) => f.endsWith('.xlsx') && !f.startsWith('~'));
    console.log(`\n\n############## ${group.toUpperCase()} (${files.length} files) ##############`);
    // Aggregate filled-col map across all files: propId -> { sheets, samples }
    const agg = new Map(); // sheetName::propId -> { count, samples }
    for (const f of files) {
      try {
        const findings = await dumpFile(path.join(root, group, f), group);
        for (const sheet of findings) {
          for (const col of sheet.cols) {
            const key = `${sheet.sheet}::${col.propId || `col${col.c}`}`;
            if (!agg.has(key)) agg.set(key, { count: 0, samples: [], desc: col.desc });
            const entry = agg.get(key);
            entry.count += col.count;
            for (const s of col.samples) if (entry.samples.length < 3 && !entry.samples.includes(s)) entry.samples.push(s);
          }
        }
      } catch (e) {
        console.error('ERR', f, e.message);
      }
    }
    // Print
    const bySheet = new Map();
    for (const [key, info] of agg.entries()) {
      const [sheet, prop] = key.split('::');
      if (!bySheet.has(sheet)) bySheet.set(sheet, []);
      bySheet.get(sheet).push({ prop, ...info });
    }
    for (const [sheet, props] of bySheet.entries()) {
      props.sort((a, b) => b.count - a.count);
      console.log(`\n--- Sheet: ${sheet} ---`);
      for (const p of props.slice(0, 50)) {
        const sample = p.samples[0] || '';
        console.log(`  ${(p.prop || '?').padEnd(28)} n=${String(p.count).padEnd(4)} ${p.desc.padEnd(40)} | ${sample.slice(0, 50)}`);
      }
    }
  }
}

main().catch((e) => console.error(e));
