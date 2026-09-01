import Database from "better-sqlite3";
const db = new Database("data/scraper.db", { readonly: true });
const nums = ["1756-L83E","1769-L33ER","1734-OB8S","5069-IF8","2080-L50E-24QBB","700-HK32Z24","440K-T11129","855T-B24SA2","2711R-T7T","1732E-IB16M12R","42JT-D2LAT1-A2","872C-D5NE18-D4","193-ECM-60-30","100S-C09ZJ23","700-HJ32Z24"];
for (const n of nums) {
  const row = db.prepare("select count(*) as c from run_items where catalog_number = ? or catalog_number like ?").get(n, n) ?? { c: 0 };
  console.log(`${n}\t${row.c === 0 ? "NEW" : `SEEN:${row.c}`}`);
}
db.close();
