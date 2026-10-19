# Schmersal accuracy and speed — batch 04

Status: **accepted on two isolated cold runs.** Each run passed exact product identity, official PDP, image, type, expected source attributes, expected normalized fields, and per-item PDT audit. Both runs had zero wrong products and zero unproven PDT writes.

## Products and official PDPs

| Article | Device kind | Exact official page |
|---|---|---|
| 153031612 | Two-sided pull-wire emergency stop switch | [RS655-Z22](https://products.schmersal.com/en_IN/rs655-z22-153031612) |
| 103056630 | Safety controller | [PSC1-C-10](https://products.schmersal.com/en_CH/psc1-c-10-103056630) |
| 101197191 | Key transfer switch | [SVE1/100-24VDC](https://products.schmersal.com/en_IO/sve1100-24vdc-101197191) |
| 151155141 | Safety hinge switch | [TV8S 335-11Z-M20](https://products.schmersal.com/en_IO/tv8s-335-11z-m20-151155141) |
| 103037576 | Ex-zone 2 safety relay | [SRB101EXi-1A](https://products.schmersal.com/en_IN/srb101exi-1a-103037576) |

The five cover pull-wire emergency stop, programmable safety control, key-transfer interlock, hinge safety switch, and Ex-rated safety relay.

## Root causes and reusable repairs

- The exact Schmersal pages embed their technical tables in `dataTabGroups`; the generic HTML parser did not extract those rows. The connector now converts every named value in those groups into evidence-bearing attributes tied to the exact PDP, variant scope, and exact catalog match. This recovers the PSC1 performance level and Category 4 without relying on slow datasheet enrichment.
- Schmersal's ETIM code describes the PSC1 as a generic PLC. Exact PSC1 family and product evidence now takes precedence over that broad taxonomy.
- The TV8S page has an ECLASS limit/position-switch code that previously outweighed its exact TV8S hinge-switch family. Exact TV8S identity now suppresses the generic Sensor/Limit Switch result.
- Pull-wire travel is not product envelope dimensions. The RS655 retains the 2 × 100 m wire specification as an attribute and leaves normalized device dimensions blank.
- Supply draw and output/contact ratings are separate values. For SRB101EXi, the normalized current remains the exact PDP's 57 mA current consumption, not its 2 A contact rating.
- The exact SVE PDP reports both IP20 and IP65. Both remain present in normalized protection instead of choosing one and discarding exact-page evidence.

## Cold-run results

Reports: `benchmark-report.fixtureDir-benchmarks-schmersal-accuracy-speed-20261014-batch-04.isolatedStorage-1.tag-schmersal-batch-04-data-tabs-final-cold-01.json` and `...final-cold-02.json` in `benchmarks/`.

| Article | Type | Connector run 1 | Connector run 2 | Full run 1 | Full run 2 |
|---|---|---:|---:|---:|---:|
| 153031612 | Pull-wire Emergency Stop Switch | 2,184 ms | 1,588 ms | 4,632 ms | 3,413 ms |
| 103056630 | Safety Controller | 1,656 ms | 2,217 ms | 3,390 ms | 3,994 ms |
| 101197191 | Key Transfer Switch | 1,147 ms | 1,491 ms | 12,458 ms | 14,872 ms |
| 151155141 | Safety Hinge Switch | 1,057 ms | 1,599 ms | 7,445 ms | 8,331 ms |
| 103037576 | Safety Relay | 1,363 ms | 1,767 ms | 3,845 ms | 4,028 ms |
| **Mean** |  | **1,481 ms** | **1,732 ms** | **6,354 ms** | **6,928 ms** |
| **Median / max** |  | **1,363 / 2,184 ms** | **1,767 / 2,217 ms** | **4,632 / 12,458 ms** | **4,028 / 14,872 ms** |

All connector times met the 2.5-second target. Full run includes document download/enrichment and workbook/PDT export; SVE document processing is the main remaining end-to-end latency. The benchmark's global fixture-coverage summary remains incomplete by design because it covers all device sheets; all five items in this batch passed their own PDT audits. The five saved product images were visually checked against the exact product models.

Focused tests and `npx tsc --noEmit` passed. No broad test suite was run.
