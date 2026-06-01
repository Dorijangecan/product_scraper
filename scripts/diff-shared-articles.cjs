// For each shared article, compare cell-by-cell values in Material Master Data.
// Report how often example has a value but generated doesn't, and vice-versa.
const ExcelJS = require('exceljs');

function cell(v) {
  if (v && typeof v === 'object' && 'text' in v) v = v.text;
  if (v && typeof v === 'object' && 'richText' in v) v = v.richText.map(p => p.text).join('');
  if (v && typeof v === 'object' && 'result' in v) v = v.result;
  if (v && typeof v === 'object' && 'hyperlink' in v) v = v.text || v.hyperlink;
  return v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
}
function isEmpty(s) { return !s || s === '-' || s === '*'; }

async function loadByArticle(file, sheetName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return { labels: [], byArt: new Map() };
  // header label row
  const colCount = ws.actualColumnCount;
  let headerLabelRow = 0;
  for (let r = 1; r <= 15; r++) {
    for (let c = 1; c <= colCount; c++) {
      const v = cell(ws.getRow(r).getCell(c).value).toLowerCase();
      if (v === 'articlenumber' || v === 'article number') { headerLabelRow = r; break; }
    }
    if (headerLabelRow) break;
  }
  const labels = [];
  for (let c = 1; c <= colCount; c++) labels[c] = headerLabelRow ? cell(ws.getRow(headerLabelRow).getCell(c).value) : `col${c}`;
  const byArt = new Map();
  const articleCol = 5;
  for (let r = headerLabelRow + 1; r <= ws.actualRowCount; r++) {
    const row = ws.getRow(r);
    const art = cell(row.getCell(articleCol).value);
    if (!/^1SDA/i.test(art)) continue;
    const data = {};
    for (let c = 1; c <= colCount; c++) data[c] = cell(row.getCell(c).value);
    byArt.set(art, data);
  }
  return { labels, byArt };
}

(async () => {
  const ex = await loadByArticle('primjeri PDTa/abb/ABB EMAX3ACC-P2 - PDT.xlsx', 'Material Master Data');
  const gen = await loadByArticle('outputs/ABB/ABB-EMAX3ACC-P2---PDT.csv/2026-06-01_10-56-04_20260601085604-193cb2ae/excel/20260601085604-193cb2ae_PDT.xlsx', 'Material Master Data');
  const shared = [...ex.byArt.keys()].filter(a => gen.byArt.has(a));
  console.log('shared:', shared.length);
  const cols = Math.max(ex.labels.length, gen.labels.length);
  // For each column, count: ex has and gen doesn't / gen has and ex doesn't / both have but differ / both empty / both same
  const stats = [];
  for (let c = 1; c <= cols; c++) {
    let exOnly = 0, genOnly = 0, both = 0, differ = 0, bothEmpty = 0;
    const exSamples = [], genSamples = [];
    for (const art of shared) {
      const exV = ex.byArt.get(art)[c] || '';
      const genV = gen.byArt.get(art)[c] || '';
      const exE = isEmpty(exV), genE = isEmpty(genV);
      if (exE && genE) bothEmpty++;
      else if (!exE && genE) { exOnly++; if (exSamples.length < 3) exSamples.push(`${art}: ${exV}`); }
      else if (exE && !genE) { genOnly++; if (genSamples.length < 3) genSamples.push(`${art}: ${genV}`); }
      else { both++; if (exV !== genV) differ++; }
    }
    stats.push({ c, label: (ex.labels[c] || gen.labels[c] || '').slice(0,40), exOnly, genOnly, both, differ, bothEmpty, exSamples, genSamples });
  }
  // Print columns where EX has value but GEN doesn't (interesting gap)
  console.log('\n=== Columns where EXAMPLE filled but GENERATED missing (sorted) ===');
  stats.filter(s => s.exOnly >= 5).sort((a,b)=>b.exOnly-a.exOnly).forEach(s => {
    console.log(`col ${s.c} [${s.label}] EX-only=${s.exOnly} GEN-only=${s.genOnly} differ=${s.differ}/${s.both}`);
    s.exSamples.forEach(x => console.log('   EX:', x));
  });
  console.log('\n=== Columns where GENERATED filled but EXAMPLE missing (we exceed) ===');
  stats.filter(s => s.genOnly >= 5).sort((a,b)=>b.genOnly-a.genOnly).slice(0,20).forEach(s => {
    console.log(`col ${s.c} [${s.label}] GEN-only=${s.genOnly} EX-only=${s.exOnly}`);
  });
  console.log('\n=== Columns where both filled but values DIFFER ===');
  stats.filter(s => s.differ >= 5).sort((a,b)=>b.differ-a.differ).slice(0,20).forEach(s => {
    console.log(`col ${s.c} [${s.label}] differ=${s.differ}/${s.both}`);
    // sample
    for (const art of shared.slice(0,3)) {
      const exV = ex.byArt.get(art)[s.c] || '';
      const genV = gen.byArt.get(art)[s.c] || '';
      if (exV !== genV && !isEmpty(exV) && !isEmpty(genV)) {
        console.log(`   ${art}\n     EX:  ${exV.slice(0,120)}\n     GEN: ${genV.slice(0,120)}`);
      }
    }
  });
})();
