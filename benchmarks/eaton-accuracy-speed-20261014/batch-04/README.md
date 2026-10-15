# Eaton batch 04 review

## Scope

Five new Eaton products across five device types were run in isolated storage. The candidates were checked against earlier manifests, scrape history, aliases, and page-cache URLs before selection.

| SKU | Device type | Exact Eaton page |
|---|---|---|
| `197211` | Control relay | [PDP](https://www.eaton.com/us/en-us/skuPage.197211.html) |
| `166426` | Molded case circuit breaker | [PDP](https://www.eaton.com/us/en-us/skuPage.166426.html) |
| `038873` | Disconnect switch / main switch | [PDP](https://www.eaton.com/us/en-us/skuPage.038873.html) |
| `113140` | Residual current device (RCCB) | [PDP](https://www.eaton.com/us/en-us/skuPage.113140.html) |
| `134928` | Soft starter | [PDP](https://www.eaton.com/us/en-us/skuPage.134928.html) |

## Product-by-product review

- **197211 / EASY-E4-UC-12RC1:** The PDP confirms a control relay with 8 digital inputs (4 usable as analog), 4 relay outputs, 12/24 V DC or 24 V AC power supply, 8 A switching current, 58 mm product depth, 90 mm height, 72 mm width, and 0.25 kg. The normalized field now keeps all three supply options and uses the switching-current row instead of the separate thermal-current rating. The exact `197211_C` product image was downloaded and visually checked.
- **166426 / NZMN2-A160-KCO:** The PDP confirms a 3-pole NZM2 molded-case breaker, 160 A, 690 V, 149 × 184 × 105 mm, and 2.5 kg. The page gallery asset uses a generic content ID rather than an exact-SKU asset identifier, so the scraper does not claim it as a proven exact image. No downloaded image is included for this SKU.
- **038873 / T0-2-1/EA/SVB:** The PDP confirms a 3-pole main switch, 20 A rated uninterrupted current, 690 V, 111 × 74 × 65 mm, and 0.142 kg. The 20 A main-contact value is preferred over the distinct 16 A UL general-use value. The legacy exact asset `y7-38873_C` was matched to SKU `038873` and visually checked.
- **113140 / PFIM-40/4/003-A/110:** The PDP confirms a 4-pole, 40 A, 30 mA, Type A RCCB and publishes both 110 V AC and 190 V AC. Its ambient range is −25 to +60 °C; dimensions are 76 × 80 × 70 mm and weight is 0.32 kg. The normalized voltage retains both published options rather than selecting the separate 110 V Ue maximum. The exact `113140_C` image was downloaded and visually checked against the product page and label.
- **134928 / DS7-342SX009N0-N:** The PDP confirms a 3-phase 9 A soft starter with 200–480 V AC mains, separate 110–230 V AC control voltage, 94 × 130 × 45 mm, 0.35 kg, and −5 to +40 °C operating temperature. The normalized supply voltage now comes from the mains-voltage bounds, not the distinct 230 V Ue minimum or control-voltage row. Eaton labels its gallery photo representative, so the image is omitted.

## Shared corrections

- Exact PDP evidence identifies the 197211 switching-current and multi-mode supply rows, the 038873 main-switch rated-current rows, the 113140 RCCB voltage options and ambient range, and the 134928 soft-starter AC-53 current and main-circuit voltage. Separate auxiliary/control or unrelated ratings are not substituted.
- A specific molded-case breaker product title suppresses the broader generic circuit-breaker classifier signal.
- The Eaton legacy `Y7-38873` image asset is accepted for the zero-padded catalog number `038873`; the mapping is constrained to the exact legacy asset pattern.
- Images stay omitted when Eaton's asset does not establish the exact SKU or the page explicitly calls the image representative.

## Final isolated cold run

Report: [`benchmark-report.manufacturer-eaton.fixtureDir-benchmarks-eaton-accuracy-speed-20261014-batch-04.isolatedStorage-1.json`](../../benchmark-report.manufacturer-eaton.fixtureDir-benchmarks-eaton-accuracy-speed-20261014-batch-04.isolatedStorage-1.json)

| SKU | Acquisition (`scrapeElapsedMs`) | Full fixture (`elapsedMs`) |
|---|---:|---:|
| `197211` | 0.642 s | 11.372 s |
| `166426` | 0.329 s | 5.848 s |
| `038873` | 0.200 s | 11.774 s |
| `113140` | 0.158 s | 14.216 s |
| `134928` | 0.179 s | 8.704 s |
| **Mean** | **0.302 s** | **10.383 s** |
| **Median** | **0.200 s** | **11.372 s** |
| **Maximum** | **0.642 s** | **14.216 s** |

All five passed exact identity, official URL, expected device type, required-document, required-normalized-field, and PDT audit gates. The batch had no wrong products, no unproven PDT writes, and no unexplained required-field issues. Six PDT values outside the controlled enums were left blank. Three exact images were downloaded and reviewed; the two omitted images were not represented as exact-SKU evidence. Acquisition is below the 2.5-second target on all five; full fixture time also includes document handling and workbook/PDT export.

## Verification

- `npx tsc --noEmit` passed.
- The final isolated cold benchmark passed all built-in gates.
- No test suite was run.
