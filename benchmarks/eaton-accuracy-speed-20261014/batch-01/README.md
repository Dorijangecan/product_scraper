# Eaton batch 01 review

## Selection and novelty

The batch contains five new products across five device types. Before selection, every SKU was checked against Eaton run history, page cache, aliases, and previous benchmark artifacts; all five were absent.

| SKU | Device type | Official Eaton PDP |
|---|---|---|
| SL2MNM65E3C3A | Luminaire | [Eaton product page](https://www.eaton.com/us/en-us/skuPage.SL2MNM65E3C3A.html) |
| 116308 | Communication Gateway | [Eaton product page](https://www.eaton.com/us/en-us/skuPage.116308.html) |
| 10-6380-2 | Terminal Block | [Eaton product page](https://www.eaton.com/us/en-us/skuPage.10-6380-2.html) |
| PDG23M0015MRAJ | Motor Circuit Breaker | [Eaton product page](https://www.eaton.com/us/en-us/skuPage.PDG23M0015MRAJ.html) |
| E51ALT16PU | Inductive Proximity Sensor | [Eaton product page](https://www.eaton.com/us/en-us/skuPage.E51ALT16PU.html) |

## Accuracy review

All five products resolved to their exact Eaton pages and expected device types. The required documents, normalized fields, and PDT audits matched the manifest on every item. There were no wrong products, unproven PDT writes, or unexplained required-field issues.

| SKU | Important verified facts |
|---|---|
| SL2MNM65E3C3A | 49 x 119 x 270 mm; 0.662 kg; 220–240 V; IP65; 5–40 °C. |
| 116308 | EU5C-SWD-DP PROFIBUS-DP gateway; 90 x 35 x 127 mm; 0.157 kg; 24 V DC; IP20; -25–55 °C. Eaton separately lists rated operational current (Ie) of 0.7 A and maximum supply current of 0.7 mA. These are different named quantities; normalization now uses the explicit Ie rating for the general current field. |
| 10-6380-2 | The exact page's Type row says Terminal block; 5.5 x 5.5 x 6 in; 1 lb. The broader Product Type says motor control accessory and does not override that specific classification. |
| PDG23M0015MRAJ | 5.7 x 6.3 x 8 in; 5 lb; 600 V AC; 15 A. The page gallery exposed a sibling PDG model image, so no image was returned. The exact-SKU datasheet was retained. |
| E51ALT16PU | 5 x 2 x 1.6 in; 1.19 lb; 20–264 V AC; 500 mA; NEMA/IP68; -25–70 °C. Eaton marks the PDP photograph as representative, so no image was returned. |

The three downloaded images were inspected visually and show the SafeLite luminaire, EU5C PROFIBUS gateway, and three-pole terminal block. The rejected/omitted images for PDG23M0015MRAJ and E51ALT16PU remain absent by design.

## Shared corrections

- Eaton's direct-page type classifier now lets a specific Type or Product Category field refine a generic Product Type such as “motor control accessory.” This correctly classifies 10-6380-2 as a Terminal Block.
- When the canonical Eaton US page proves exact SKU identity, an exact device type, sufficient technical attributes, and all required ratings, the connector returns without waiting on other locales. Incomplete or ambiguous pages retain the existing locale merge and fallback paths.
- Eaton normalization now prefers an exact PDP's Rated operational current (Ie) over a separate maximum supply-current row. A focused regression test covers the 116308 distinction.

## Final cold run

The accepted run used the checked-in manifest in isolated storage. Acquisition time is the connector scrape; end-to-end time also includes enrichment, document handling, and workbook/PDT exports.

| SKU | Acquisition | End-to-end |
|---|---:|---:|
| SL2MNM65E3C3A | 0.658 s | 15.603 s |
| 116308 | 0.340 s | 4.863 s |
| 10-6380-2 | 0.108 s | 4.419 s |
| PDG23M0015MRAJ | 0.166 s | 18.574 s |
| E51ALT16PU | 0.124 s | 7.548 s |
| **Mean** | **0.279 s** | **10.201 s** |
| **Median** | **0.166 s** | **7.548 s** |
| **Maximum** | **0.658 s** | **18.574 s** |

All five acquisition times are below the 2.5-second target. End-to-end times remain separately visible because document and export work add substantial time for some devices.

Final report: ../../benchmark-report.manufacturer-eaton.fixtureDir-benchmarks-eaton-accuracy-speed-20261014-batch-01.isolatedStorage-1.json.

## PDT, verification, and status

- Device type, official URL, expected document, normalized-field, and PDT audit gates passed on all five.
- PDT controlled-enum skips: 8, left blank. Unproven written values: 0. Unexplained required-field issues: 0.
- Focused Eaton parser and EAN regressions passed; Eaton rated-current normalizer regression passed; npx tsc --noEmit passed.
- Images were reviewed from the final isolated output. Exact-page representative and sibling images were excluded.

**Status: accuracy accepted; acquisition-speed target met.** This is Eaton's first completed five-product batch. Continue with Eaton batch 02 before moving to another manufacturer.
