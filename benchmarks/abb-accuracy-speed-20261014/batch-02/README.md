# ABB cold batch 02

Five new catalog numbers were selected across residual-current protection, an HMI panel, a safety sensor, a PLC CPU, and a DC power supply. The IDs were checked against the historical ABB benchmark inventory and batch 01. Every item matched its exact ABB product identity; all five official product images were downloaded and visually matched.

## Accuracy review

| Catalog number | Device type | Verified product-specific facts |
| --- | --- | --- |
| `2CSF204101R2400` | Residual current device | F204 A, 4 poles, 40 A, 100 mA residual current, 230/400 V AC, IP20 terminals / IP40 housing, 360 g, 85 × 70 × 69 mm. Exact ABB page lists the technical sheet and manual. |
| `1SAP520100R0001` | HMI | CP620, 4.3-inch TFT touchscreen, 480 × 272 pixels, 24 V nominal / 18–30 V DC supply, front IP66 / housing IP20, 0.88 kg, 107 × 147 × 56 mm. ABB's CP620 sheet includes this exact order code. |
| `2TLA020051R5100` | Safety sensor | Adam DYN-Info M12-5, 24 V DC, 15 mm rated operating distance, IP67/IP69K, PBT housing with epoxy moulding, 26 g, 75.2 × 30 × 12 mm. ABB page links datasheets, manual, and CAD drawing. |
| `1SAP123400R0172` | Programmable logic controller | PM5032-T-ETH, 24 V DC supply (20.4–28.8 V), 12 digital inputs, 8 transistor outputs, 2 configurable I/O, 2 MB program memory, 253 g, 135 × 82 × 74 mm. ABB Help's PM50xx table gives maximum power-supply current of 340 mA for the PM5032 transistor version; the parser matches the PM5032 and transistor columns before normalizing it. |
| `1SVR320561R1000` | Power supply | CP-S.1 24/5.0, 100–240 V AC / 100–250 V DC input, 24 V DC / 5 A output, 120 W, IP20, 0.69 kg, 129.4 × 35.5 × 127 mm. Exact ABB page lists its datasheet, manual, and wiring diagram. |

The first run exposed two gaps: CP620's official `Power Supply` attribute was kept raw but not normalized to voltage, and the PM5032 product page did not expose its current consumption. The ABB normalizer now extracts the CP620's published 18–30 V range. The connector also reads ABB Help's model-column table for PM50xx CPUs, records the exact official source, and does not substitute a neighboring CPU's value. The matching test covers both output variants and rejects a missing model column.

The CP620 and PM50xx family datasheets are kept as official links. Their family scope is labeled; CP620's multi-model sheet is excluded from field enrichment, while PM5032 current is taken from the official technical-data table with its exact model/output-version match.

## Final cold run

Report: `../../benchmark-report.manufacturer-abb.fixtureDir-benchmarks-abb-accuracy-speed-20261014-batch-02.isolatedStorage-1.tag-final-accuracy-speed.json`

All 5/5 passed exact identity, official URL, expected device type, required document link, expected normalized-field, and PDT checks. No wrong products or unproven written fields. Manufacturer-scoped coverage is accepted; the run covers five of the 41 global PDT sheets by design.

| Device | Acquisition ms | Total benchmark ms |
| --- | ---: | ---: |
| RCCB | 2,318 | 3,327 |
| CP620 HMI | 1,593 | 2,531 |
| Eden safety sensor | 2,090 | 2,904 |
| PM5032 PLC | 1,710 | 2,564 |
| CP-S.1 supply | 1,462 | 2,845 |

Acquisition median is 1,710 ms (mean 1,835 ms); each device's acquisition is below the approximately 2.5-second target. The benchmark's total also includes workbook and PDT generation: total median is 2,845 ms (mean 2,834 ms), so that downstream-inclusive measure remains above target and is tracked separately from scraper acquisition.
