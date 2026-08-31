# SCAME cold-start audit — 2026-08-31

These ten SCAME catalog numbers were selected after checking the existing fixtures,
cache references and benchmark reports; neither prior control number (`512.3306`,
`214.1636`) is included. Each article was confirmed from an official SCAME PDP or
official techsheet before scraping. The final run below is ten isolated processes after
the classifier repair.

| Catalog number | Official family / expected type | Extracted identity / type | Official source | Manually checked key data | Documents / image | Final duration | Result / fix |
| --- | --- | --- | --- | --- | --- | ---: | --- |
| 110.3100 | QUICK French/German plug / Connector | 2P+E 16 A plug / Connector | https://www.scame.com/web/scame-global/p/110.3100 | IP44; rubber; black; 0.057 kg | Techsheet, drawing, image | 4,659 ms | PASS |
| 218.1634 | OPTIMA plug / Connector | 3P+E 16 A plug / Connector | https://techsheet.scame.com/infodata/en/218.1634.pdf | 200–250 V; 16 A; 9h; IP66/IP67/IP69; thermoplastic | Official techsheet PDF, drawing, image | 5,069 ms | PASS |
| 214.1633 | XENIA plug / Connector | 2P+E 16 A plug / Connector | https://www.scame.com/web/scame-middle-east/p/214.1633 | 200–250 V; 16 A; 6h; IP44/IP54; thermoplastic | Techsheet, drawing, image | 4,650 ms | PASS |
| 146.361 | BLUELINE one-way adaptor / Connector | One-way adaptor / Connector | https://www.scame.com/web/scame-global/p/146.361 | 2P+E 16 A; engineering plastic; white; 0.038 kg | Official product sheet, image | 4,755 ms | PASS |
| 160.5013 | BLUELINE multi-socket / Connector | Multi socket for desk / Connector | https://www.scame.com/web/scame-global/p/160.5013 | 250 V; 16 A; three outlets; 2 m H05VV-F; engineering plastic | Product sheet, image | 2,932 ms | PASS |
| 218.16365 | OPTIMA plug / Connector | 3P+E 16 A plug / Connector | https://www.scame.com/web/scame-middle-east/p/218.16365 | 440–460 V; 16 A; 11h; IP66/IP67/IP69; thermoplastic | Techsheet, drawing, image | 4,689 ms | PASS |
| 413.1664 | OPTIMA flush-mount socket / Connector | 3P+E 16 A flush socket / Connector | https://www.scame.com/web/scame-uk/p/413.1664 | 200–250 V; 16 A; 9h; IP44/IP54; 70×87 mm flange | Techsheet, drawing, image | 4,796 ms | PASS |
| 500.3270 | OMNIA interlocked socket / Connector | 2P+E 32 A interlocked socket / Connector | https://www.scame.com/web/scame-uk/p/500.3270 | 100–130 V; 32 A; 4h; IP44; mechanical interlock; 0.638 kg | Manual, drawing, certificates, image | 5,001 ms | PASS; SCAME socket vocabulary now outranks generic lock/interlock |
| 213.3237 | OPTIMA plug / Connector | 3P+N+E 32 A plug / Connector | https://www.scame.com/web/scame-uk/p/213.3237 | 346–415 V; 32 A; 6h; IP44/IP54; thermoplastic | Techsheet, drawing, image | 4,882 ms | PASS |
| 318.3247 | OPTIMA connector / Connector | 3P+N+E 32 A connector / Connector | https://www.scame.com/web/scame-uk/p/318.3247 | 346–415 V; 32 A; 6h; IP66/IP67/IP69; thermoplastic; 0.396 kg | Techsheet, drawing, certificates, image | 4,634 ms | PASS |

## Gate evidence

The post-fix isolated rerun passed all ten rows: found 10/10, official URL 10/10,
identity 10/10, documents 10/10, expected device type 10/10, PDT audit 10/10,
quality accepted for every row, wrong products 0, and no timeout. The initial run
reproduced the missing-type/Lock-interlock errors; the only code change was a bounded
SCAME vocabulary rule for plug/socket/adaptor product nouns.
