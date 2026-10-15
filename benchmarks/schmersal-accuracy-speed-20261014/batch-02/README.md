# Schmersal accuracy and speed — batch 02

Status: **accuracy accepted; cold speed retested after parallel document enrichment.**

## Selected products and official evidence

| Article | Kind | Exact official product page | Novelty check |
|---|---|---|---|
| 101160101 | TQ 441 pull-wire switch | [TQ 441-01/01Y-UE-M20](https://products.schmersal.com/en_US/tq-441-0101y-ue-m20-101160101) | Not present in Schmersal run history, aliases, page cache, benchmark fixtures, reports or existing deterministic mappings. |
| 103039599 | SLC 440 safety light curtain | [SLC440-ER-1930-14-H1](https://products.schmersal.com/en_IO/slc440-er-1930-14-h1-103039599) | Same checks clear; exact article and live PDP verified. |
| 103005740 | TESK hinge safety switch | [TESK-SA-11L1-3M](https://products.schmersal.com/en_IO/tesk-sa-11l1-3m-103005740) | Same checks clear; exact article and PDP verified. |
| 131058472 | MV8H roller-lever position switch | [MV8H 015-11Y](https://products.schmersal.com/en_US/mv8h-015-11y-131058472) | Same checks clear; page identifies 131058472 as the current article and 101058472 as its predecessor. |
| 103040526 | BDF200 control panel | [BDF200-LT-11-LT-SWS20-LT-2875](https://products.schmersal.com/en_IO/bdf200-lt-11-lt-sws20-lt-2875-103040526) | Same checks clear; exact article, populated button layout and official page image verified. |

The five items cover distinct functions: cable-pull emergency stopping, optoelectronic safety guarding, hinge monitoring, mechanical position switching and a multi-element control panel. Before selection, all five catalog numbers were checked against the current SQLite run history and aliases, all benchmark inputs/reports, the Schmersal connector's deterministic SKU map and exact-number page-cache entries. No matches were found.

## Source facts to check against each scrape

- **101160101:** 670 g, 22 mm mounting hole, IP65, −30…+90 °C, 380 V AC rated operating voltage, 4 A operating current, two NC contacts, max. 25 m one-sided wire. Do not infer a product envelope from the mounting-hole value.
- **103039599:** safety type 4; 14 mm detection; 1,930 mm protective-field height; 3–10 m range; 192 beams; max. 28 ms response; 24 V DC; emitter 200 mA and receiver 700 mA; IP67; −25…+50 °C. The exact PDP does not publish gross weight, so do not expect or infer one.
- **103005740:** 440 g; 20 × 78 × 116 mm; 3 m cable; one NO and one NC contact; AC-15 230 V / 2 A and DC-13 24 V / 1 A; IP65; −25…+65 °C.
- **131058472:** 385 g; sensor dimensions 43 × 67 × 126 mm; one NO and one NC; AC-15 400 V / 2.5 A; IP65; −30…+90 °C. The page states predecessor article 101058472; do not substitute the predecessor's identity.
- **103040526:** 280 g; 40 × 60 × 249 mm; four configured positions (illuminated pushbuttons and key selector); 24 V DC operating voltage; AC-15 24 V / 2 A and DC-13 24 V / 1 A; IP65; −25…+65 °C; 16 cable wires. Keep the 24 V DC supply distinct from the AC-15 switching rating.

## Final accuracy and speed audit

The final isolated cold run passed all five products: found 100%, exact official PDP 100%, required documents 100%, device type 100%, normalized field audit 100%, wrong products 0, PDT audit 100%, and unproven PDT writes 0. All five exact PDP images were downloaded and visually reviewed. Twelve PDT values were skipped by enum/ontology mapping; no unproven value was written. The accepted report is `benchmark-report.manufacturer-schmersal.fixtureDir-benchmarks-schmersal-accuracy-speed-20261014-batch-02.isolatedStorage-1.json`.

| Article | Scrape connector | Full run (docs + extraction + exports) |
|---|---:|---:|
| 101160101 | 1,537 ms | 8,586 ms |
| 103039599 | 1,635 ms | 7,544 ms |
| 103005740 | 1,074 ms | 9,699 ms |
| 131058472 | 1,507 ms | 7,417 ms |
| 103040526 | 1,959 ms | 8,647 ms |
| **Mean** | **1,542 ms** | **8,379 ms** |

The connector met the 2.5-second target for each product. The full pipeline did not: vendor-document generation/download, PDF processing and PDT/workbook export add time outside the connector. Datasheet generation and manual lookup are independent, so they now run concurrently; the cold rerun preserved the 100% quality gate. The official Schmersal datasheet-generation endpoint returns HTTP 404 (`PRODUCT_NOT_FOUND`) for BDF200; its exact official manual and product image were retrieved and satisfy the document requirement for this item.

Core audited facts include TQ: 670 g, two NC contacts, 380 VAC, 4 A, IP65; SLC: 192 beams, 14 mm detection, 1,930 mm protective field, 24 VDC, IP67 (gross weight unpublished); TESK: 440 g, one NO/one NC, 3 m cable, IP65 (no device supply voltage normalized from contact ratings); MV8H: current article 131058472, 385 g, 43 × 67 × 126 mm sensor envelope, one NO/one NC; BDF200: 280 g, 40 × 60 × 249 mm, 24 VDC supply, four populated positions, 16-wire cable. Contact ratings and subsystem dimensions/currents remain distinct from device supply and envelope fields.
