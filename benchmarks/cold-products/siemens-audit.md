# Siemens cold-start audit — 2026-08-31

The ten references below were new relative to the existing fixtures, cache and benchmark reports (the previously covered 6ES7155-6AU01-0BN0 and 3RT2026-1BB40 were excluded). Each MLFB, product family, type and key values was checked against Siemens Industry Mall/SiePortal pages or the official MMP data endpoint before scraping.

| MLFB | Family / official type | Expected → extracted | Official evidence | Checked key data | Docs/image | Time | Result / repair |
|---|---|---|---|---|---|---:|---|
| 6ES7132-6BH01-0BA0 | SIMATIC ET 200SP digital output | I/O Module → I/O Module | [Industry Mall](https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb=6ES7132-6BH01-0BA0) | 16×24 V DC, 0.5 A | datasheet + image | 6.2 s | PASS |
| 6EP1332-1SH71 | SIMATIC S7-1200 PM1207 power module | Power Supply → Power Supply | [Industry Mall](https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb=6EP1332-1SH71) | 120/230 V AC in, 24 V DC / 2.5 A out | datasheet + image | 7.0 s | PASS |
| 3RV2011-1JA10 | SIRIUS 3RV2 motor starter protector | Motor Circuit Breaker → Motor Circuit Breaker | [Industry Mall](https://mall.industry.siemens.com/mall/en/powertecownsy/Catalog/Product/3RV2011-1JA10) | 7–10 A release, 130 A N release | datasheet + image | 7.1 s | PASS |
| 3SU1150-0AB20-1CA0 | SIRIUS ACT metal pushbutton | Pushbutton / Operator → Pushbutton / Operator | [Industry Mall](https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb=3SU1150-0AB20-1CA0) | 22 mm, red, 1 NC, screw terminal | datasheet + image | 6.9 s | PASS |
| 3RW4026-1BB04 | SIRIUS 3RW40 soft starter | Soft Starter → Soft Starter | [Industry Mall](https://mall.industry.siemens.com/mall/es/es/Catalog/Product/3RW40261BB04) | 25 A, 11 kW/400 V, 200–480 V AC, 24 V AC/DC | datasheet + image | 6.5 s | PASS |
| 6GK5005-0BA00-1AB2 | SCALANCE XB005 unmanaged Ethernet switch | Switch → Switch | [MMP data](https://mall.industry.siemens.com/goos/catalog/Pages/mmpdata.ashx?MLFB1=6GK5005-0BA00-1AB2&lang=en) | 5×RJ45, 24 V AC/DC, IP20 | datasheet + image | 7.0 s | PASS; numeric SCALANCE mapping |
| 6ES7214-1AG40-0XB0 | SIMATIC S7-1200 CPU 1214C | Programmable Logic Controller → Programmable Logic Controller | [Industry Mall](https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb=6ES7214-1AG40-0XB0) | 14 DI/10 DO/2 AI, 20.4–28.8 V DC | datasheet + image | 7.4 s | PASS |
| 3SK1111-1AB30 | SIRIUS 3SK1 safety relay | Safety Relay → Safety Relay | [MMP data](https://mall.industry.siemens.com/goos/catalog/Pages/mmpdata.ashx?MLFB1=3SK1111-1AB30&lang=en) | 3 NO enabling + 1 NC signalling, 24 V AC/DC | datasheet + image | 7.1 s | PASS |
| 6AV2124-0MC01-0AX0 | SIMATIC HMI TP1200 Comfort | HMI → HMI | [SiePortal](https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb=6AV2124-0MC01-0AX0) | 12-inch panel, PROFINET, MPI/PROFIBUS DP | datasheet + image | 7.0 s | PASS |
| 6ES7134-6GD01-0BA1 | SIMATIC ET 200SP analog input | I/O Module → I/O Module | [MMP data](https://mall.industry.siemens.com/goos/catalog/Pages/mmpdata.ashx?MLFB1=6ES7134-6GD01-0BA1&lang=en) | 4×I, 2-/4-wire, 24 V DC supply, 37 mA max | datasheet + image | 6.4 s | PASS; numeric ET 200SP mapping |

Final isolated rerun after the two taxonomy fixes: **10/10 quality accepted** with identity, official URL, documents/image, type, normalized fields and PDT gates passing.
