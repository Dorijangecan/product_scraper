# Doepke accuracy and speed — batch 01

This isolated cold batch covers five distinct product types. Exact catalog pages, product documents, images, source attributes, normalized values, type classification, and PDT output were checked against the official Doepke product page and datasheet for each catalog number.

## Acceptance

| Catalog number | Type | Initial core ms | Final core ms | Final end-to-end ms |
|---|---|---:|---:|---:|
| 09500044 | Twilight Switch | 788 | 330 | 5,358 |
| 09921006 | Float Switch | 267 | 270 | 3,587 |
| 09980718 | Undervoltage Measuring Relay | 125 | 146 | 3,827 |
| 09980085 | Transformer | 117 | 118 | 3,202 |
| 09100112 | Automatic Reclosing Device | 122 | 122 | 4,616 |

Initial to final quality gates: exact official URL 5/5, required documents 5/5, expected source attributes 2/5 → 5/5, device type 3/5 → 5/5, expected normalized fields 2/5 → 5/5, PDT audit 5/5, wrong products 0, and unproven PDT writes 0. Both accepted final cold runs passed all quality gates. The final `scrapeElapsedMs` average is 197 ms (all devices under 2.5 seconds); the end-to-end average is 4.12 seconds because it also includes downloads, enrichment, and PDT export.

## Corrections learned from these devices

- **09500044 Dasy:** normalize the exact AC operating values as 115/230 V and 16 A; discard 207–253 V tolerance bounds as separate supply ratings.
- **09921006 Champ float switch:** classify it as a Float Switch and route it to the Switch PDT sheet. The official data does not publish a product supply voltage or current, so those fields remain blank. Keep IP68, 0.682 kg, 81 × 105 × 42 mm, 5 m cable, and 0–50 °C from its exact datasheet.
- **09980718 RUR 3:** classify it as an Undervoltage Measuring Relay and route it to electrical measurement devices. Normalize 230/400 V AC as operating voltage. Do not treat its 160–240 V switching threshold, 4 kV impulse withstand, or 5 A relay-contact rating as supply voltage/current. PDT writes now use 230/400 V for the min/max operating-voltage cells and leave current blank. The template's optional protection enum does not include IP20, so that cell is left blank while normalized protection remains IP20.
- **09980085 RK 3 U:** preserve 8/12 V AC secondary output and its 2 A secondary rating; do not pair 230 V mains input with the output current.
- **09100112 DFA 2-1:** classify it as an Automatic Reclosing Device; preserve 24 V AC/DC and datasheet current-consumption ranges. Do not use the paired RCCB's 63 A rating as actuator current.

## Reproducible reports

- Initial baseline: `benchmarks/benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-01.isolatedStorage-1.tag-doepke-batch-01-initial-cold-01.json`
- Final accepted cold run: `benchmarks/benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-01.isolatedStorage-1.tag-doepke-batch-01-accepted-final-cold-02.json`
- Exact-device fixture expectations: `fixtures.json`
