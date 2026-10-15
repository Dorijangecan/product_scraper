# Turck accuracy and speed — batch 03

Status: **accepted after two isolated cold passes.** Five new product types passed the exact-product, official URL, required-document, device-type, normalized-field, expected-source-attribute, and PDT checks. Every final core scrape was below 2.5 seconds; no wrong products or unproven PDT writes were recorded. Five exact product images were visually reviewed, and the images in both accepted output folders have matching SHA-256 hashes.

## Products reviewed

| Catalog number | Device type | Source-backed review |
| --- | --- | --- |
| `SLLP23-1540P88` | Safety Light Curtain | Official Turck PDP and exact EDB `3089707`: Type 4, Category 4, PL e, SIL 3; scan field 1540 mm, resolution 23 mm, 88 beams; 45 × 36 × 1545 mm; 20.4–27.6 V DC, ≤135 mA. The 500 mA safe-output rating remains a separate source attribute and is not normalized as device current. |
| `BIM-EM12E-AP6X-H1141/S1751` | Magnetic Field Sensor | Exact EDB `100001278`: M12 × 1 thread, 46 mm thread length, 10–30 V DC, 15 mA no-load current, ≤200 mA rated operating current, IP67, −25…70 °C. Overall dimensions stay blank because only thread length is published. |
| `B2NF85H-QR20-IOLX3-H1141` | Inclinometer | Exact Turck PDP/EDB: two axes, −85…+85°, gyroscope and accelerometer principle; 71.6 × 62.6 × 20 mm, 18–30 V DC, <50 mA, IP68/IP69K, −40…85 °C. |
| `100054866` (`CMVT-M8TA1D-LI28-H1141`) | Vibration Sensor | Exact Turck PDP `/shop/others/100054866`: 72.5 × 23.8 mm, stainless steel, IP66/IP67, −40…80 °C, 18–30 V DC, <100 mA. The 4–20 mA signal is retained as output evidence, not supply current. |
| `7030424` (`TNSLR-Q42TWD-H1147`) | RFID Device | Exact Turck PDP/EDB: 19.2–28.8 V DC, ≤110 mA, 67.7 × 42.5 × 42.5 mm, IP68/IP69K, −25…70 °C, maximum read/write distance 215 mm. |

## Accuracy repair

The first evidence-backed rerun passed expected normalized fields but only **4/5 expected source-attribute checks**. The exact German EDB contained the safety curtain's explicit classification in prose, which the generic PDF table reader did not expose as attributes. The new reader records Type 4, Category 4, PL e, and SIL 3 only when the Turck source PDP's numeric article ID matches the EDB ID and the PDF text matches the requested catalog number. The same five-item cold report then passed all five attribute assertions.

The EDB's thread length is no longer treated as the magnetic sensor's overall dimensions. Turck's `DC rated operational current` label is recognized without confusing a safety output rating or RFID inrush with device operating current. The CMVT article-ID path uses Turck's exact `/shop/others/{id}` PDP when the generic `/shop/p/{id}` route returns the homepage.

## Isolated cold acquisition

Final reports:

- [`type4-isolated-cold-01`](../../benchmark-report.manufacturer-turck.limit-5.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-turck-batch-03-type4-isolated-cold-01.json)
- [`single-locale-numeric-search-cold-01`](../../benchmark-report.manufacturer-turck.limit-5.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-turck-batch-03-single-locale-numeric-search-cold-01.json)
- [`final-cold-repeat-02`](../../benchmark-report.manufacturer-turck.limit-5.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-turck-batch-03-final-cold-repeat-02.json)

| Catalog number | Accuracy/speed pass (ms) | Cold repeat (ms) |
| --- | ---: | ---: |
| `SLLP23-1540P88` | 1,944 | 1,789 |
| `BIM-EM12E-AP6X-H1141/S1751` | 1,620 | 1,786 |
| `B2NF85H-QR20-IOLX3-H1141` | 1,830 | 1,507 |
| `100054866` | 2,245 | 2,432 |
| `7030424` | 2,234 | 1,547 |
| **Mean / median / max** | **1,975 / 1,944 / 2,245** | **1,812 / 1,786 / 2,432** |

The measured field is `scrapeElapsedMs` for the connector acquisition. Full benchmark wall time also includes document retrieval/enrichment, image download, and workbook/PDT export and is reported separately in the JSON reports. Numeric article IDs use one primary-locale search before the exact official order-ID routes; if those routes fail, the shared discovery fallback retains the full localized search set.

Focused validation passed: `npx vitest run tests/document-enrichment.test.ts -t 'extractTurckSafetyClassification'`, `npx vitest run tests/discovery.test.ts -t 'Turck numeric fallback'`, and `npx tsc --noEmit`.
