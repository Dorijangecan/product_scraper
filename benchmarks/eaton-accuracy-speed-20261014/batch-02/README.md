# Eaton batch 02 review

## Selection and novelty

The five SKUs span five device types: miniature circuit breaker, power supply, pushbutton operator, overload relay, and UPS. Before selection, the set was checked against earlier benchmark manifests and reports, Eaton aliases, database run history, and cached product URLs; none had prior scraper results.

| SKU | Device type | Exact Eaton PDP |
|---|---|---|
| 278561 | Miniature Circuit Breaker | [Eaton product page](https://www.eaton.com/us/en-us/skuPage.278561.html) |
| PSG120E24RM | Power Supply | [Eaton product page](https://www.eaton.com/us/en-us/skuPage.PSG120E24RM.html) |
| M22-D-G-K10 | Pushbutton / Operator | [Eaton product page](https://www.eaton.com/us/en-us/skuPage.M22-D-G-K10.html) |
| 278431 | Overload Relay | [Eaton product page](https://www.eaton.com/us/en-us/skuPage.278431.html) |
| 5SC1000 | UPS | [Eaton product page](https://www.eaton.com/us/en-us/skuPage.5SC1000.html) |

## Accuracy review

All five cold scrapes found the exact Eaton PDP, matched the expected type, retained the required official datasheet, passed the normalized-field manifest, and passed PDT audit. No wrong product was returned.

| SKU | Verified model-specific details |
|---|---|
| 278561 | FAZ-C16/1 miniature circuit breaker; 16 A C-curve; 240/415 V AC; 75.5 × 17.7 × 80 mm; 0.11 kg; IP20, with IP40 when fitted; -25 to +75 °C. The 0.8–2 mm PDP attribute is busbar material thickness, not device wall thickness, so `wallThickness` is left blank. Eaton marks its product image representative, so no image was returned. |
| PSG120E24RM | 120 W, single-phase 100–240 V AC input, 24 V DC / 5 A output; exact Volume 7 table column gives 121 × 50 × 123.1 mm, 0.72 kg, and -20 to +80 °C. The PDP's 1.59 g and 76.2 × 50 × 98 mm physical values were rejected as inconsistent with the exact model table. The official image is representative and was omitted. |
| M22-D-G-K10 | Green, flush, momentary operator; exact PDP lists a 1 NO contact configuration, 5 million operations, 1 × 2 × 2 in, 0.05 lb, and NEMA 4X / 13. The source does not establish a nominal circuit voltage or material for this operator SKU; those PDT fields remain blank. Eaton marks the image representative, so no image was returned. |
| 278431 | ZB12 thermal overload relay; exact adjustable range 0.1–0.16 A; 1 NO + 1 NC contacts; 67 × 45 × 88 mm; 0.141 kg; 690 V maximum; -25 to +55 °C. PDP degree-of-protection `IP00` conflicts with its exact product description's `IP20`; normalized protection is blank pending authoritative resolution. The downloaded Eaton PDP image was visually checked and shows the overload-relay product. |
| 5SC1000 | 1000 VA / 700 W UPS; input 96–144 V AC; output 100/110/120 V; 8 × 5-15R outputs; 8.2 × 5.9 × 13.4 in; 25.6 lb. The downloaded image visibly identifies the unit as 5SC 1000. |

Exact source references include the [Eaton Volume 7 power-supplies catalog](https://www.eaton.com/content/dam/eaton/products/industrialcontrols-drives-automation-sensors/power-supplies-v7-t6-ca08100008e.pdf) and the [Eaton 5SC technical specifications](https://www.eaton.com/content/dam/eaton/products/backup-power-ups-surge-it-power-distribution/backup-power-ups/eaton-5sc-ups/eaton-5sc-ups-technical-specifications-tn153004en.pdf). The PSG catalog parser selects the exact SKU's tabular column and fails closed when it cannot prove that column; it does not transfer neighboring model values.

## Shared corrections

- Eaton Volume 7 power-supply catalog is retained as a third targeted datasheet in addition to the SKU PDF and line card. Both the normal download path and isolated benchmark harness now allow this targeted source through their document limits.
- A shared exact-column parser extracts PSG input/output ratings, physical dimensions, weight, and operating-temperature range from the tab-separated model matrix. Exact catalog evidence now outranks a contradictory PDP physical value through normalization and field-candidate resolution.
- For power supplies, implausible sub-10 g PDP masses are filtered before weight arbitration so they cannot suppress an exact catalog weight.
- Eaton busbar-thickness evidence is excluded from the enclosure `wallThickness` field, including during later field-candidate resolution.
- The batch's other corrections preserve separate input/output voltage context, prefer an MCB's direct voltage rating, use the overload relay's adjustable current range, and leave conflicting protection evidence blank.

## Final cold run

Run: `benchmark-report.manufacturer-eaton.fixtureDir-benchmarks-eaton-accuracy-speed-20261014-batch-02.isolatedStorage-1.tag-accepted-final4.json`. The manifest was run in isolated storage. Acquisition is connector scrape time; full benchmark time also includes document parsing, workbook/PDT export, and audit.

| SKU | Acquisition | Full benchmark |
|---|---:|---:|
| 278561 | 0.583 s | 25.385 s |
| PSG120E24RM | 0.369 s | 9.750 s |
| M22-D-G-K10 | 0.137 s | 4.132 s |
| 278431 | 0.187 s | 7.625 s |
| 5SC1000 | 0.147 s | 3.819 s |
| **Mean** | **0.285 s** | **10.142 s** |
| **Median** | **0.187 s** | **7.625 s** |
| **Maximum** | **0.583 s** | **25.385 s** |

All five connector acquisition times are below the 2.5-second target. The complete benchmark remains reported separately; the MCB's document and export work accounts for its longer full-run time.

## PDT and verification

- Exact identity, official URL, expected document, device type, normalized-field manifest, and PDT audit passed for 5/5 products.
- Six controlled-enum skips remained blank. Unproven written values: 0. Unexplained required-field issues: 0.
- Nine required-field audit entries remain blank: two ECLASS classification fields for 278561, six material/nominal-voltage/type fields for M22-D-G-K10 that the exact SKU source does not establish, and one optional secondary-current field for 5SC1000. No value was guessed to clear these entries.
- Three representative PDP images were omitted (278561, PSG120E24RM, M22-D-G-K10). The downloaded 278431 and 5SC1000 images were visually reviewed.
- `npx tsc --noEmit` passed. No test suite was run.

**Status: accuracy accepted; acquisition-speed target met.** This is Eaton's second completed five-product batch. Continue with Eaton batch 03; keep Eaton active through at least one more batch before considering a manufacturer change.
