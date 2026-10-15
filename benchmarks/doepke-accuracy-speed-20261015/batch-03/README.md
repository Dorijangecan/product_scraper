# Doepke batch 03 — exact Dupline sensing and control devices

**Status: accepted.** The same five new articles passed two isolated cold runs after accuracy repairs and a targeted long-manual optimization. Each run passed exact identity, official product URL, required document, device type, normalized field values, expected source attributes, and PDT audit for 5/5 products. Wrong products: 0; unproven PDT writes: 0. Unsupported controlled-enum values remained blank.

## Products and reviewed evidence

| Article | Device type | Evidence-backed facts reviewed |
| --- | --- | --- |
| `09501110` — DLUX | Light Sensor | Official product page describes a Dupline light-value sensor. Its exact datasheet gives bus signal supply, 750 µA bus consumption (710–790 µA), 83 × 40 × 43 mm, Lexan resin, IP44, and −10…60 °C. Normalized current is 0.75 mA; device supply voltage stays blank. |
| `09501112` — DTS 1 | Temperature Sensor | Exact datasheet gives bus signal supply, 800 µA consumption, 68 × 35 × 15 mm, polycarbonate, IP67, and −30…60 °C. The product image itself identifies DTS 1 and IP67. |
| `09501150` — DRD 2 | Smoke Detector | Exact product page describes a smoke and fire detector. The linked, article-specific operating manual identifies order number 09501150 and provides optical/Tyndall detection, two Dupline channels, maximum 60 m² monitored area, 6 m installation height, 200 µA minimum / 1 mA maximum bus input, polycarbonate, and +5…40 °C. No datasheet is linked on the exact product page. The manual's protection-class text is malformed/ambiguous, so protection and physical dimensions remain blank. |
| `09501171` — DRT 1 | Thermostat | Exact datasheet gives room thermostat function, bus signal supply, maximum 2,500 µA consumption, 14…28 °C sensor range, 0.5 °C hysteresis, 84 × 84 × 34 mm, ABS resin, IP20, and −30…60 °C. |
| `09501197` — DWS 1 | Water Sensor | Exact datasheet gives water-stop sensing, bus signal supply, 1,300 µA consumption, 40 × 70 × 16 mm, ABS resin, IP67, and −20…50 °C. Its separately labeled maximum 8 V sensor input is retained as an attribute and excluded from normalized device supply voltage. |

The five official image URLs include their exact article numbers. All five images were visually checked against the devices in the initial run; SHA-256 hashes match between the final accuracy/speed run and its cold repeat.

## Repairs

- Added precise shared classifications for light sensors, smoke detectors, water sensors, and thermostats. Each maps to the closest existing PDT sheet; Doepke Dupline bus-powered devices are allowed to omit standalone voltage.
- Added exact-document extraction for the five Dupline device families. It records bus supply source and converts µA consumption to mA without turning sensor/contact voltage into the device supply.
- Corrected DWS 1's `max. 8 V` input limit so it is not emitted as normalized device voltage. Removed the ambiguous DRD 2 `IIP 42` protection fragment from normalized protection while retaining the source text.
- The DRD 2 exact article page links its operating manual rather than a datasheet. Its manual contains the model's technical-data table, so the exact manual is accepted as its required technical document; the family-wide Dupline planning guide is excluded.
- Long Doepke operating manuals now extract the front page and final five technical pages when the manual exceeds eight pages. The exact article number must still appear in the extracted text. After the custom exact parser captures those rows, generic PDF mining is skipped for that manual to avoid re-reading its full 12 pages and risking unrelated text.

## Before and after

The initial baseline and final runs use the same five products. `scrapeElapsedMs` is connector acquisition. `elapsedMs` includes document handling and per-item workbook/PDT export.

| Metric | Initial baseline | Final cold 01 | Final cold repeat |
| --- | ---: | ---: | ---: |
| Found / exact official URL / required document | 4/5 / 5/5 / 4/5 | 5/5 / 5/5 / 5/5 | 5/5 / 5/5 / 5/5 |
| Expected device type | 1/5 | 5/5 | 5/5 |
| Expected normalized fields / exact source attributes | 0/5 / 0/5* | 5/5 / 5/5 | 5/5 / 5/5 |
| PDT audit / wrong products / unproven writes | 5/5 / 0 / 0 | 5/5 / 0 / 0 | 5/5 / 0 / 0 |
| Core scrape mean / median | 185 / 135 ms | 193 / 121 ms | 181 / 123 ms |
| Core scrape maximum | 323 ms | 343 ms | 322 ms |
| Full fixture mean / median | 3.893 / 3.442 s | 2.353 / 2.270 s | 2.391 / 2.301 s |
| Full fixture range | 2.595–7.083 s | 1.560–3.358 s | 1.683–3.222 s |

\* The initial exploratory manifest had no expected-value or attribute assertions. Re-evaluating its saved results against the final manifest's assertions gives 0/5 for both. This reflects the actual type, evidence, bus-current, and DWS 1 voltage defects; it is not a same-run report field.

The core scrape was already comfortably below the 2.5-second target in the baseline and remains below 0.35 seconds for every device. The accuracy repairs keep that speed. The long-manual optimization cut DRD 2 full time from 7.083 seconds initially (5.832 seconds in the pre-optimization accepted accuracy run) to 1.560 seconds, with a 1.683-second cold repeat. Full-fixture time for the other devices still includes document retrieval and export; those stages are reported separately from core acquisition.

## Reports

- Initial baseline: `../../benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-doepke-batch-03-initial-cold-01.json`
- Accepted accuracy run before speed repair: `../../benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-doepke-batch-03-accuracy-repair-06.json`
- Final cold 01: `../../benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-doepke-batch-03-speed-02.json`
- Final cold repeat: `../../benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-doepke-batch-03-final-cold-repeat-01.json`

`npx tsc --noEmit` passed before both final cold runs. No test suite was run.
