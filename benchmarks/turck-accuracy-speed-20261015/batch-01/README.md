# Turck accuracy and speed — batch 01

**Status: accepted for product accuracy and core scrape speed.** Two final isolated cold runs passed all five devices. Each core connector scrape was below 2.5 seconds in both runs.

## Products reviewed

| Catalog number | Device type | Exact official product page | Evidence reviewed |
| --- | --- | --- | --- |
| `BI10U-M18-AP6X-H1141` | Inductive proximity sensor | [Turck 1644830](https://www.turck.com/de/en/shop/sensors/inductive-sensors/1644830) | 10 mm switching distance; 10–30 V DC; 25 mA no-load current; 36 × 36 mm; IP68; −25…70 °C. |
| `TBEN-S2-4IOL` | I/O module | [Turck 6814024](https://www.turck.com/de/en/shop/fieldbus-technology/i/o-modules/6814024) | 24 V DC nominal, admissible 18–30 V DC; 50–110 mA; four IO-Link masters; 144 × 32 × 32 mm; IP65/IP67/IP69K; −40…70 °C. |
| `RI360P0-EQR24M0-INCRX2-H1181` | Encoder | [Turck 1590912](https://www.turck.com/de/en/shop/sensors/encoders/1590912) | 1024 ppr default, configurable from 1–5000 ppr; 10–30 V DC; under 100 mA; 81 × 78 × 24 mm; IP68/IP69K; −25…85 °C. |
| `PS400R-505-2UPN8X-H1141` | Pressure sensor | [Turck 6832702](https://www.turck.com/de/en/shop/others/6832702) | Relative 0–400 bar; 18–30 V DC; two switching outputs; 0.2 A rated output; IP67/IP69K; ambient −40…80 °C. Media temperature is kept separate. |
| `LRS510-10-51-2UPN8-H1141/EU` | Radar sensor | [Turck 100048855](https://www.turck.com/de/en/shop/sensors/radar-sensors/100048855) | 350–10,000 mm range; 17–33 V DC; 100 mA no-load current; 132.3 × 38 × 50.2 mm; IP67/IP69K; −25…65 °C; G 3/4 process connection. |

The product identity, exact official URL, document, device type, expected normalized values, expected source attributes, and PDT audit were checked per product. Each run passed all of these gates 5/5; wrong products and unproven PDT writes were zero. Certification data is linked to Turck's exact-order-ID certificate register; the legacy Turck product page is retained as a separate official enrichment source. Unsupported PDT enum values stay blank.

All five downloaded assets from the final run were opened and visually checked. The inductive sensor, I/O module, encoder, and radar assets depict the corresponding device. Turck provides a dimensional product drawing for the pressure sensor rather than a photograph; it is retained as an official visual asset and is not described as a photo.

## Accuracy repair and speed optimization

- The initial baseline found all five products and their official URLs/documents, but only 3/5 device types and 0/5 expected normalized fields/source attributes passed. Four product image transform URLs returned HTTP 429 and increased shared host throttling for later requests.
- Turck image URLs are now unwrapped only when the official Turck transform points to the recognized Turck Azure CDN asset path. This avoids repeated transform-host 429s while preserving the exact official image asset.
- Turck's search and exact PDP remain in the core path. The exact certificate register and legacy ordering-data page now run in the existing post-scrape enrichment stage; their data, sources, documents and total benchmark time are retained.
- A failed search-card shortcut was removed because its page did not contain the required temperature evidence. Product-card data is not used to skip exact PDP verification.

## Cold measurements

`Core scrape` is the connector acquisition time (`scrapeElapsedMs`). `Full fixture` also includes post-scrape enrichment, documents, and workbook/PDT processing (`elapsedMs`).

| Metric | First baseline | Final cold 01 | Final cold 02 |
| --- | ---: | ---: | ---: |
| Core mean | 43.575 s | 1.842 s | 1.963 s |
| Core median | 52.329 s | 1.839 s | 1.892 s |
| Core range | 8.430–52.427 s | 1.619–2.075 s | 1.844–2.119 s |
| Devices at or below 2.5 s | 0/5 | 5/5 | 5/5 |
| Full fixture mean | 62.843 s | 11.631 s | 9.675 s |
| Accuracy gates passed | No: type 3/5, fields/attributes 0/5 | Yes: all 5/5 | Yes: all 5/5 |

The final cold 02 core mean is 95.5% lower than the initial baseline. The final accepted run also passed the exact URL, document, device type, expected normalized field/value, source-attribute, and PDT gates 5/5. Benchmark PDT-sheet coverage is 3/41; this five-product batch does not claim full workbook sheet coverage.

Reports:

- Initial: [`benchmark-report.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-01.isolatedStorage-1.tag-turck-batch-01-initial.json`](../../benchmark-report.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-01.isolatedStorage-1.tag-turck-batch-01-initial.json)
- Final cold 01: [`benchmark-report.manufacturer-turck.limit-5.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-01.isolatedStorage-1.tag-turck-batch-01-trace-cold-01.json`](../../benchmark-report.manufacturer-turck.limit-5.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-01.isolatedStorage-1.tag-turck-batch-01-trace-cold-01.json)
- Final cold 02: [`benchmark-report.manufacturer-turck.limit-5.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-01.isolatedStorage-1.tag-turck-batch-01-accepted-cold-02.json`](../../benchmark-report.manufacturer-turck.limit-5.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-01.isolatedStorage-1.tag-turck-batch-01-accepted-cold-02.json)
