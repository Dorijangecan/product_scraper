# Balluff batch 04 review

## Selection and novelty

The five-product batch covers a color sensor, mechanical limit switch, photoelectric distance sensor, magnetic position sensor, and incremental linear encoder. Before selection, each exact SKU was checked against Balluff run history, aliases, cached product pages, and prior batch artifacts. The chosen SKUs were absent from those sources.

`BFB0001` was initially considered as a fiber-optic sensor. Its downloaded catalog artwork visibly carried the `BFB0003` label, so that image was rejected and the product was removed from the batch. `BMP0008` replaced it; the final five are `BFS000L`, `BNS002R`, `BOD0024`, `BMP0008`, and `BML09N6`.

## Accuracy review

Every item resolves to its exact official Balluff product page and correct device type. The actual downloaded product images were visually inspected; image presence alone was not used as proof. Every item has its expected image and datasheet, exact identity, matched required normalized fields, and a successful PDT audit.

| SKU | Device type | Official source | Important verified facts |
|---|---|---|---|
| BFS000L | Color Sensor | [Balluff BFS000L](https://www.balluff.com/en-gb/products/BFS000L) | 21 x 58.3 x 74 mm; 21.6–26.4 V; max. 40 mA; IP54; 10–55 °C. |
| BNS002R | Limit Switch | [Balluff BNS002R](https://www.balluff.com/en-gb/products/BNS002R) | 74 x 28 x 61 mm; 250 V AC; 6 A; IP67; -5–85 °C; mechanical roller actuator. |
| BOD0024 | Photoelectric Distance Sensor | [Balluff BOD0024](https://www.balluff.com/en-gb/products/BOD0024) | 50 x 21 x 50 mm; 18–30 V; no-load current max. 180 mA; IP67; -20–50 °C; red-light triangulation sensor. |
| BMP0008 | Magnetic Position Sensor | [Balluff BMP0008](https://www.balluff.com/en-gb/products/BMP0008) | 32 mm range; 17.5 x 9.6 x 42 mm; selectable 0–10 V / 4–20 mA analog output and IO-Link 1.1; 15–30 V; no-load current max. 25 mA; IP67; -25–85 °C. |
| BML09N6 | Encoder | [Balluff BML09N6](https://www.balluff.com/en-gb/products/BML09N6) | 10 x 25 x 35 mm; incremental linear measurement; 10 µm resolution; RS-422; 10–30 V; max. 80 mA at 24 V DC; IP67; -20–80 °C. |

The exact datasheets were used for detailed electrical and mechanical facts. For `BMP0008`, the datasheet separates `Output current max. (Analog V) = 5 mA` from `No-load current Io max. at Ue = 25 mA` and SIO output load capacity. The first cold result had normalized the analog output as the product's current. The shared Balluff normalizer now prefers official current-draw/current-consumption and no-load-current labels over output-current rows, while preserving rated operating current as a fallback. A regression case proves that the `BMP0008` current field resolves to max. 25 mA rather than 5 mA.

The batch also carries forward two shared corrections: a complete combined dimension vector beats a partial single-axis PDF ontology value, and the Balluff fast path can leave protection extraction to the shared exact-datasheet enrichment step. This reduced duplicate/early extraction work without dropping the datasheet or final protection field.

## Final cold run

The accepted run is isolated and cache-cold, using the checked-in five-product manifest. The acquisition metric is the connector scrape time; end-to-end time includes enrichment, document handling, and PDT/workbook output.

| SKU | Acquisition | End-to-end |
|---|---:|---:|
| BFS000L | 1.214 s | 7.454 s |
| BNS002R | 1.083 s | 4.345 s |
| BOD0024 | 1.157 s | 8.593 s |
| BMP0008 | 1.133 s | 6.873 s |
| BML09N6 | 1.013 s | 4.977 s |
| **Mean** | **1.120 s** | **6.448 s** |
| **Median** | **1.133 s** | **6.873 s** |
| **Maximum** | **1.214 s** | **8.593 s** |

The five products meet the approximately 2.5-second acquisition target. End-to-end time remains separately visible because document parsing and exports contribute several seconds beyond acquisition.

Final report: `../../benchmark-report.fixtureDir-benchmarks-balluff-accuracy-speed-20261014-batch-04.isolatedStorage-1.tag-balluff-batch04-final.json`.

## PDT, tests, and limitations

- All five PDT audits matched; there were 26 controlled-enum write skips. The unsupported enum values stayed blank. Unproven written values: 0. Unexplained required-field issues: 0.
- Focused regression test for Balluff no-load current passed. `npx tsc --noEmit` passed.
- The broader `tests/normalizer.test.ts` run had three unrelated precision expectation failures for weight and wall-thickness formatting (235 passed, 3 failed). Those expectations were not changed as part of this batch.
- Benchmark reports `Quality accepted: yes`; its process exits nonzero because the general PDT sheet-coverage gate requires a much broader multi-manufacturer fixture set (3/41 device sheets represented here). This manufacturer-specific batch makes no claim that the global sheet-coverage gate is met.

**Status: accuracy accepted; acquisition-speed target met.** Balluff now has four completed five-product batches (20 products overall), so the next manufacturer can begin under the agreed sequence.
