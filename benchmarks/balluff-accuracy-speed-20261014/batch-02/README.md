# Balluff cold batch 02

The five selected catalog numbers were checked against benchmark/source files, prior run history, aliases, and cached product URLs. All five were new to those records. The initial five were BES01M2, BCS009E, BOS02AH, BTL0W9F, and BUS000N. Manual image review showed that Balluff marks BUS000N artwork as a similar illustration and the image appears to depict a different model, so BUS000N was excluded and replaced with unseen BUS005L before the final run.

## Product review

| Catalog number | Verified type | Exact product evidence and important facts |
| --- | --- | --- |
| `BES01M2` | Inductive Proximity Sensor | BES 516-383-EO-C-05; Ø8 x 45 mm; non-flush M8; 2.5 mm switching range; PNP NO, 5 kHz; 10–30 V DC; rated operating current 200 mA; stainless-steel housing, IP68, −40…85 °C. [Official page](https://www.balluff.com/en-gb/products/BES01M2) |
| `BCS009E` | Capacitive Sensor | BCS S20TT01-POLFAG-ET02 capacitive level sensor; Ø7 x 51.5 mm; Smart Level 15 with foam/residue compensation; PNP NC, 10 Hz; 10–30 V DC; rated operating current 50 mA; PTFE housing/sensing face; IP68, IP66 at cable exit; 5…100 °C. Balluff publishes an end-of-life announcement for this SKU. [Official page](https://www.balluff.com/en-gb/products/BCS009E) |
| `BOS02AH` | Photoelectric Sensor | BOS R090K-PU-ID10-S75 diffuse broad-beam photoelectric sensor; 10.7 x 43.5 x 19.5 mm; infrared light, 0…100 mm; PNP NO/NC; 10–30 V DC; IP67; −30…55 °C. [Official page](https://www.balluff.com/en-gb/products/BOS02AH) |
| `BTL0W9F` | Linear Position Sensor | BTL7-A510-M0457-Z-KA05 magnetostrictive rod position sensor; 457 mm measuring range; selectable 0…10 V / 10…0 V analog output; 10–30 V DC; max. current consumption 150 mA at 24 V DC; ±50 µm non-linearity; ±10 µm repeatability; aluminum, IP68, −40…85 °C. The actual physical dimensions were not published in the extracted exact sources and remain blank; the 5 m cable length remains a separate attribute. [Official page](https://www.balluff.com/en-gb/products/BTL0W9F) |
| `BUS005L` | Ultrasonic Sensor | BUS M30E1-XC-07/035-S92K; Ø30 mm cylindrical ultrasonic sensor; 65…600 mm range; analog 0…10 V / 4…20 mA; 9…30 V DC; max. current draw 80 mA; 30 x 94.5 mm; stainless steel/PBT/TPU; IP67, −25…70 °C. [Official page](https://www.balluff.com/en-gb/products/BUS005L) |

All five final product images were opened and visually checked against the expected sensor form. Their downloaded bytes and SHA-256 values are in the final isolated output: `../../output/20261014121612/images/`. Datasheets were downloaded and parsed for all five. Exact product identity, official URL, document, type, normalized-field, and PDT audits passed. PDT audit recorded 18 controlled-enum write issues/skips across the batch; unsupported values were left blank, with zero unproven writes and zero required-field issues.

## Shared corrections

- Added the shared `Linear Position Sensor` classification and Balluff BTL family mapping. BTL position transducers are not generic encoders; the profile maps them to the electronic-sensor PDT sheet.
- Physical dimension extraction now excludes PDF-miner aliases of `Measuring length` and does not replace missing housing dimensions with the cable length for sensors that publish a separate measuring length. BTL0W9F's 457 mm sensing range and 5 m cable are preserved as their own attributes; normalized physical dimensions remain blank.
- The benchmark expected-image requirement was retained for the final five only after replacing the mismatched BUS000N illustration with BUS005L's product image.

## Cold accuracy and speed result

Final report: `../../benchmark-report.manufacturer-balluff.fixtureDir-benchmarks-balluff-accuracy-speed-20261014-batch-02.isolatedStorage-1.tag-cold-accuracy-final-verified.json`

| Catalog number | Connector scrape ms | Complete benchmark ms |
| --- | ---: | ---: |
| `BES01M2` | 1,477 | 9,636 |
| `BCS009E` | 2,348 | 6,251 |
| `BOS02AH` | 1,775 | 7,592 |
| `BTL0W9F` | 1,019 | 4,684 |
| `BUS005L` | 978 | 7,107 |

Connector acquisition averaged 1,519 ms per device (median 1,477 ms, maximum 2,348 ms), meeting the 2.5-second target on this final cold run. The complete benchmark averaged 7,054 ms (median 7,107 ms, maximum 9,636 ms), including document download/enrichment and workbook/PDT export. Keep both metrics visible.

## Verification

- Final isolated cold benchmark: 5/5 found, 100% exact official URLs, documents, device types, and PDT audit; zero wrong products; zero unproven PDT writes; zero required-field issues.
- Focused Balluff normalization and device-type checks: 34 passed; unrelated cases filtered. `npx tsc --noEmit` passed.
- Five downloaded product images were visually reviewed; the final batch uses BUS005L rather than BUS000N because the latter's official artwork is labeled as a similar illustration.
- Prior optimization work was not needed for the connector-stage target: every final connector scrape was below 2.5 seconds. Complete benchmark time remains longer due to downloads, document enrichment, and export.
