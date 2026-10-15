# Doepke batch 04 — residual-current, shutter, and Dupline devices

**Status: accuracy accepted in two isolated cold runs.** All five products passed exact identity, official URL, required datasheet, device-type, normalized-value, source-attribute, and PDT checks in both runs. Wrong products: 0; unproven PDT writes: 0. The five exact product images were visually reviewed.

## Products and reviewed evidence

| Article | Device type | Evidence-backed facts reviewed |
| --- | --- | --- |
| `09352050` — DRCA-1-Set | Residual Current Analyzer | Measurement system, 10 Hz–100 kHz, maximum residual-current measurement amplitude 10 A, DC immunity up to 3 A, transformer bore 70 mm, 3 m cable, 345 × 420 × 120 mm, 3.149 kg, PC, 0…45 °C. The manual identifies USB +5 V; no device supply-current rating is published, so normalized current stays blank. |
| `09340110` — DRP | Residual Current Monitoring Relay | MRCD, Type A, selected control voltages 230/400/500 V, adjustable residual-current thresholds 0.03/0.1/0.3/0.5/1 A, 30–150 ms response delay, 2 A at 500 V AC contact rating, 65 × 110 × 119 mm, 0.575 kg, IP53, −25…40 °C. Threshold settings and contact rating remain distinct source attributes; normalized supply current stays blank. |
| `09500170` — SIRO-SL | Roller Shutter Controller | 24 V DC supply (21.5–26.5 V), 12 mA AC consumption, 230 V/2 A motor load capacity, 85 × 35 × 65 mm, PC, IP20, −10…45 °C. The 2 A output load is not normalized as supply consumption. |
| `09501116` — DSI 1 | Communication Interface | Dupline–Modbus I-RTU, RS-485, 5 V DC, 10 µA bus consumption, 70 × 55 × 16 mm, PC, IP20, −20…60 °C. |
| `09501244` — DSU 8plus | I/O Module | Eight opto-isolated AC/DC inputs, 0–230 V input range, 24 V DC supply (21.5–26.5 V), 17 mA supply draw, 0.9 mA bus consumption, 85 × 72 × 65 mm, PC, IP20, −10…45 °C. The separate 58 mm installation depth is not used as the outside case depth. |

All five final image assets show the named Doepke device/product. The DRP image's printed IP50 marking is not used to overwrite the exact datasheet's IP53 value.

## Repairs

- Added precise device classifications and PDT profiles for residual-current analysis systems, MRCD relays, roller-shutter controllers, and Dupline communication/I/O modules.
- Added exact-article datasheet discovery for SIRO-SL when its legacy page links only the manual; the fallback accepts the datasheet only when its PDF text contains the requested article number.
- Separated supply draw from measurement range, adjustable trip thresholds, relay-contact ratings, and motor load capacity. Those ratings remain available under their exact source labels.
- Corrected DSU 8plus outside depth to 65 mm and retained 58 mm as installation depth.
- Kept the DSU switching signal ranges, threshold values, supply current, and Dupline bus consumption as distinct attributes.

## First measurement and final cold runs

The first baseline already had fast connector acquisition, but it classified 0/5 products correctly and found only 4/5 required datasheets. Its field checks verified presence, not the expected values and source attributes added during repair. Both final runs use the same five products and the final value/source assertions.

| Metric | Initial cold | Final cold 01 | Final cold 02 |
| --- | ---: | ---: | ---: |
| Found / official URL / required datasheet | 5/5 / 5/5 / 4/5 | 5/5 / 5/5 / 5/5 | 5/5 / 5/5 / 5/5 |
| Expected device type | 0/5 | 5/5 | 5/5 |
| Expected normalized values / expected source attributes | Presence-only check; not comparable | 5/5 / 5/5 | 5/5 / 5/5 |
| PDT audit / wrong products / unproven writes | 5/5 / 0 / 0 | 5/5 / 0 / 0 | 5/5 / 0 / 0 |
| Connector acquisition mean / median / maximum | 189 / 115 / 386 ms | 178 / 108 / 347 ms | 188 / 118 / 342 ms |
| Full benchmark mean / median / maximum | 4.255 / 3.082 / 10.067 s | 4.158 / 2.969 / 9.383 s | 4.148 / 2.739 / 9.441 s |

`scrapeElapsedMs` is connector acquisition and is below 2.5 seconds for all five devices in both final runs. Full benchmark time also includes document download/PDF processing plus workbook and PDT export, so the full-operation median and DRCA-1-Set outlier remain above 2.5 seconds. A stage trace for DRCA-1-Set measured 346 ms connector scrape, 924 ms vendor-document enrichment, 1,188 ms document download, 5,309 ms shared PDF enrichment, 383 ms workbook output, and 802 ms PDT output. These stages are kept separate from the connector target.

Reports:

- Initial: [`doepke-batch-04-initial-cold-01`](../../benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-doepke-batch-04-initial-cold-01.json)
- Final cold 01: [`doepke-batch-04-final-cold-01`](../../benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-doepke-batch-04-final-cold-01.json)
- Final cold 02: [`doepke-batch-04-final-cold-02`](../../benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-doepke-batch-04-final-cold-02.json)
- DRCA-1-Set stage timing: [`doepke-batch-04-drca-stage-timing`](../../benchmark-report.manufacturer-doepke.limit-1.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-doepke-batch-04-drca-stage-timing.json)
