# Rittal accuracy and speed — batch 02

Five new Rittal device types were validated against their exact official variant pages. Each benchmark used isolated storage, with no prior product-page, document, or image cache. The batch was rerun after source-field fixes; the three accepted cold runs all passed the accuracy and PDT gates.

## Products and official evidence

| SKU | Device type | Exact official product page |
| --- | --- | --- |
| 7240510 | Socket Strip | [Rittal 7240510](https://www.rittal.com/com-en/products/PG20231215ITI101/PG20240403ITI201/PG20240913ITI001/PG20240925ZUB103/PRO13817?variantId=7240510) |
| 3124400 | Temperature Sensor | [Rittal 3124400](https://www.rittal.com/com-en/products/PG20231215KLI101/PG20231215KLI1008/PG20240123KLI204/PRO61055?variantId=3124400) |
| 3110000 | Thermostat | [Rittal 3110000](https://www.rittal.com/com-en/products/PG20231215KLI101/PG20231215KLI1008/PG20240123KLI204/PRO12215?variantId=3110000) |
| 9677875 | Current Transformer | [Rittal 9677875](https://www.rittal.com/com-en/products/PG20231215POW101/PG20240417STR201/PG20241204STR101/PG20241204STR107/PRO42049?variantId=9677875) |
| 3361140 | Cooling Unit | [Rittal 3361140](https://www.rittal.com/com-en/products/PG20231215KLI101/PG20231215KLI103/PRO34396?variantId=3361140) |

## Before and after

| Measure | Initial cold run | Accepted cold 03 | Accepted cold 04 | Accepted cold 05 |
| --- | ---: | ---: | ---: | ---: |
| Found / exact official URL | 4/5 / 5/5 | 5/5 / 5/5 | 5/5 / 5/5 | 5/5 / 5/5 |
| Correct device types | 3/5 (60%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| Expected normalized fields | 4/5 (80%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| Expected exact source attributes | 4/5 (80%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| Required saved evidence | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| PDT item audit | 5/5 | 5/5 | 5/5 | 5/5 |
| Wrong products / unproven PDT writes | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Full item time, average / maximum | 9.93 s / 18.27 s | 2.15 s / 2.44 s | 2.49 s / 3.82 s | 2.14 s / 2.48 s | 2.14 s / 2.46 s |
| Core connector scrape, average / maximum | 0.70 s / 1.01 s | 0.68 s / 0.95 s | 0.67 s / 1.00 s | 0.70 s / 0.95 s | 0.68 s / 0.94 s |

The accepted cold-run mean was 2.23 seconds per item across all 20 observations; core connector scraping averaged 0.68 seconds. Full item time includes image retrieval and PDT/workbook handling and varies with those steps; one cold-run item took 3.82 seconds while the other three run maxima were 2.48 seconds or less. The isolated first run's full-item mean was 9.93 seconds.

## Findings and source locations learned

- **Socket strip:** the exact page's `Product description` has the external LHD envelope. LHD is length × height × depth, so normalize it to height × length × depth; do not use `Length of connection cable` or `Mounting dimensions` as the product envelope. `Rated operating voltage`, `Rated current (max.)`, `Sockets`, `Material`, and `Net weight` provide the required facts. The material row names both the anodized aluminium section and polycarbonate socket inserts.
- **Temperature sensor:** `Supply includes` identifies the external NTC sensor and 2.5 m cable; `Net weight` is 0.05 kg. The page does not publish device dimensions or electrical ratings, so those remain blank.
- **Thermostat:** `Technical specifications` lists the bimetal controller, contact load, and switching difference; `Setting range`, `Rated operating voltage`, `Dimensions`, and `Net weight` provide the remaining facts. Adjacent `<dd>` rows under one `<dt>` must all be retained.
- **Current transformer:** `Primary current`, `Secondary current`, `Accuracy class`, `Rated frequency`, `Material`, and `Net weight` describe the device. Keep primary 400 A and secondary 5 A explicitly distinguished.
- **Cooling unit:** `Total cooling output`, `Rated operating voltage`, `Rated current max.`, `Air throughput`, `Dimensions`, `Material`, `Protection category to IEC`, and `Net weight` are the relevant exact-PDP rows. Preserve both 1.2 A at 50 Hz and 1.4 A at 60 Hz; `Start-up current max.` is a separate 3.1/3.3 A rating and must not enter operating current.
- Rittal SK order prefixes are broad. Prefer explicit exact-title classes such as Thermostat or Temperature Sensor over the generic SK thermal-management family.
- If the exact variant's identity, source rows, and official image are verified, use the images-only document path. This avoids spending time downloading duplicate regional manuals and technical catalogues.

## Verification

- Accepted reports: `...tag-rittal-batch-02-accuracy-cold-03.json`, `...tag-rittal-batch-02-final-cold-04.json`, `...tag-rittal-batch-02-final-cold-05.json`, and `...tag-rittal-batch-02-final-cold-06.json`.
- Initial report: `...tag-rittal-batch-02-baseline-cold-01.json`.
- Targeted tests: `npx vitest run tests/device-type.test.ts tests/rittal.test.ts tests/run-manager.test.ts` — focused Rittal/type cases passed.
- Type check: `npx tsc --noEmit` — passed.

Batch 02 is accepted. Continue with another five new Rittal device types for batch 03 before switching manufacturers.
