# Eaton batch 03 review

## Scope and novelty

Five new products of five different device types were cold-scraped in isolated storage:

| SKU | Device type | Official Eaton product page |
|---|---|---|
| `SP1-480Y` | Surge protective device | [PDP](https://www.eaton.com/us/en-us/skuPage.SP1-480Y.html) |
| `276867` | Contactor | [PDP](https://www.eaton.com/us/en-us/skuPage.276867.html) |
| `191796` | Safety relay | [PDP](https://www.eaton.com/us/en-us/skuPage.191796.html) |
| `EP-401364` | HMI | [PDP](https://www.eaton.com/us/en-us/skuPage.EP-401364.html) |
| `DC1-1D5D8NB-A6SCE1` | Variable speed drive | [PDP](https://www.eaton.com/us/en-us/skuPage.DC1-1D5D8NB-A6SCE1.html) |

The manifest was checked against prior benchmark fixtures/reports, aliases, database history, and cached product URLs before the run. No prior product record was found for any SKU.

## Field and source review

- **SP1-480Y:** Exact PDP confirms a three-phase 277/480 V wye surge protective device, 50 kAIC, 2.5 × 4.8 × 2.9 in, and 1.25 lb. The product-specific Eaton specification sheet supports the 20 kA nominal discharge current. The 20 kA value is not 50 kAIC and is not an impulse-discharge 10/350 rating; those unrelated PDT fields are left blank. The PDP image asset resolves to `SP1-208Y_C`, a different model, so it was rejected.
- **276867:** Exact model `DILM12-01(400V50HZ,440V60HZ)`, 3 poles, one NC contact, and 75 × 68 × 45 mm / 0.24 kg. Ratings are kept contextual: AC-3 12 A at 380/400/415 V, AC-1 22 A at those voltages, and 7 A at 660/690 V. The exact coil supply is 400 V at 50 Hz and 440 V at 60 Hz. Breaking capacity at 220/230 V is not reused for conditional short-circuit ratings. The official PDP product image was visually inspected and matches the 276867 DILM12 model.
- **191796:** Exact model `ESR5-NO-31-UC`, 24–230 V AC/DC supply, 3 non-delayed enabling paths, 6 A N/O limiting continuous current, 5 A DC-13 at 24 V, 114.5 × 113 × 22.5 mm / 0.17 kg, and -40 to +55 °C. The DC minimum remains 24 V; an AC maximum is not reused as a minimum control voltage. The official PDP image was visually inspected; the front label reads `ESR5-NO-31-UC`.
- **EP-401364:** Exact model `XV-303-70-C00-A00-2C`, 7-inch display, 24 VDC nominal, 19.2–30 VDC supply range, two Ethernet plus RS232/RS485/CAN, Linux, 196 × 51 × 135 mm / 0.78 kg. The minimum and maximum supply values are kept in their correct cells. Eaton marks the page image as representative, so no image was attached or treated as exact.
- **DC1-1D5D8NB-A6SCE1:** Exact PDP description supports 115 V single-phase input, 230 V three-phase output, 1.5 HP and 5.8 A; dimensions are 10.2 × 15.3 × 9.6 in and weight 7.4 lb. Input and output voltage remain separate. Eaton marks the page image as representative, so it was omitted.

## Corrections and shared rules

- Keep drive input and output voltages directional through normalization and PDT export.
- Resolve Eaton contactor AC-3 current from the exact AC-3 380/400/415 V row. Keep the AC-1 value and other voltage/current rows separate.
- Use exact control-voltage rows for contactor 50/60 Hz coil values; do not use generic frequency or voltage facts in coil columns.
- Require explicit conditional short-circuit-current evidence before filling those fields. Do not copy ordinary rated breaking capacity or impulse voltage into them.
- Keep SPD nominal discharge current distinct from interrupt rating and 10/350 impulse fields.
- Require semantically matching evidence for Eaton static power loss and minimum control-voltage cells; leave unsupported cells blank.
- The exact-SPD-page fast path now returns when the exact page establishes identity, product type, core physical fields, voltage, and links the exact SKU datasheet. The datasheet is still downloaded and enriched; the 20 kA value remains document-backed.

## Final cold isolated run

Report: [`benchmark-report...final-accuracy-speed.json`](../../benchmark-report.manufacturer-eaton.fixtureDir-benchmarks-eaton-accuracy-speed-20261014-batch-03.isolatedStorage-1.tag-final-accuracy-speed.json)

| SKU | Acquisition (`scrapeElapsedMs`) | Full fixture (`elapsedMs`) |
|---|---:|---:|
| `SP1-480Y` | 0.478 s | 5.771 s |
| `276867` | 0.435 s | 29.453 s |
| `191796` | 0.214 s | 14.174 s |
| `EP-401364` | 0.190 s | 18.575 s |
| `DC1-1D5D8NB-A6SCE1` | 0.117 s | 4.236 s |
| **Mean** | **0.287 s** | **14.442 s** |
| **Median** | **0.214 s** | **14.174 s** |
| **Maximum** | **0.478 s** | **29.453 s** |

All five results have exact identity, official URL, expected type, expected datasheet, expected normalized fields, and passing PDT audits. Batch summary: 100% found/official URL/documents/type/PDT; zero wrong products; zero unproven PDT writes; zero unexplained required-field issues. Eleven enum values were rejected and left blank rather than forced into a nearby option. The 2.5-second target is met by acquisition for every product. Full fixture time is reported separately because it includes document handling and workbook/PDT export.

The source tree already contained unrelated dirty changes before this batch. Changes for this work remain unstaged and were limited to the Eaton scraper/normalizer and shared PDT fact/resolver/export paths. No structural project change was made. `tsc --noEmit` and the final cold benchmark completed successfully; no test suite was run.

## Status

**Accuracy and acquisition-speed gates passed.** Eaton has three completed batches (15 products); continue with five new Eaton products in batch 04.
