# Schneider Electric batch 01

Status: accepted for the current exact-source and normalized-value gates. This is the first of the planned three or four Schneider batches.

## Scope and novelty

Five previously unprocessed catalog numbers cover five distinct device types: surge protective device, safety relay, residual-current circuit breaker, photoelectric emitter, and power supply. The SKUs and expected normalized-value patterns are in `schneider.json`. Each run used isolated storage; the final report below is a cold rerun after repairs.

## Per-product review

| SKU | Type | Verified facts and review |
| --- | --- | --- |
| A9L1C325 | Surge Protective Device | Exact 3P Type 1+2 SPD. Exact SKU datasheet lists `[Ue]` 400 V AC, `Uc` 275 V, nominal discharge 25 kA, `Iimp` 25 kA, maximum discharge 65 kA, 105 × 54 × 86 mm, 508 g, IP20, and −40…85 °C. Generic operating `current` is left blank. The PDP's narrative description says 240 V AC for `[Ue]`; the exact SKU datasheet's labeled electrical table is used for the normalized field, and the prose discrepancy is retained as a source conflict. Official [PDP](https://www.se.com/uk/en/product/A9L1C325/surge-arrester-with-pluggable-cartridge-acti9-iprd1-c25r-3p-25ka-type-1+2-compact-with-remote-monitoring/) and [exact datasheet](https://www.se.com/uk/en/product/download-pdf/A9L1C325?filename=Schneider+Electric_Modular-Surge-Arrester-iPRF1-125r-PRD1_A9L1C325.pdf). |
| XPSUAF13AP | Safety Relay | Exact Preventa XPSU safety relay; 24 V AC/DC supply, category 4, and 5 A rated operational contact current retained with its source label. Official [PDP](https://www.se.com/us/en/product/XPSUAF13AP/safety-module-preventa-xpsu-24v-acdc-3-safety-outputs-1-solid-state-output-category-4/). |
| A9R22291 | Residual Current Device | Exact Acti9 iID RCCB; 2P, 100 A, 100 mA, Type A, 230…240 V AC. The exact SKU datasheet specifies height 85 mm, width 36 mm, depth 69 mm; normalized dimensions are 85 × 36 × 69 mm. The PDP narrative says height 96 mm, so the specifically labeled exact-SKU datasheet dimensions are used. Official [PDP](https://www.se.com/uk/en/product/A9R22291/residual-current-circuit-breaker-rccb-acti9-iid-2p-100a-a-type-100ma/) and [exact datasheet](https://www.se.com/uk/en/product/download-pdf/A9R22291?filename=Schneider+Electric_iID-RCCB_A9R22291.pdf). |
| XUB2AKSNM12T | Photoelectric Sensor | Exact Telemecanique Sensors emitter; 12…24 V DC, 35 mA no-load, ≤100 mA switching capacity, >5…15 m sensing range, cylindrical M18 body, M12 connector. The image is the official asset attached to this exact article page and was visually reviewed. Official [PDP and source specifications](https://www.telemecaniquesensors.com/global/en/product/reference/XUB2AKSNM12T). |
| ABL8RPS24050 | Power Supply | Exact Phaseo ABL8 supply; 100…120 V AC phase-neutral or 200…500 V AC phase-phase input, 24 V DC / 5 A / 120 W output, and −25…60 °C operation. The output-voltage field is explicitly asserted as 24 V DC. Official [PDP](https://www.se.com/us/en/product/ABL8RPS24050/universal-power-supply-phaseo-1-or-2-phase-100-to-500-v-24-v-5-a/) and [exact datasheet](https://iportal.se.com/Contents/docs/SQD-ABL8RPS24050.PDF). |

All five image files in the final benchmark output were visually checked against the official product pages. Each required datasheet and image downloaded; no image was substituted from a sibling SKU.

## Repairs and learned rules

- Added Telemecanique Sensors to Schneider's official-host allowlist and routed XU catalog numbers to the exact Telemecanique product pages. For an exact Schneider PDP with datasheet and image already found, removed an unnecessary external-reader round trip.
- Preserved Schneider AC/DC supply modes in full, including the XPSUAF13AP 24 V AC/DC rating.
- For regulated Schneider power supplies, selected the normalized voltage from explicit output evidence. The exact ABL8 description states 24 V DC beside rated output current, which disambiguates a PDF text artifact that had mislabeled the 100/500 V AC input as "Output Voltage".
- For Schneider surge arresters, removed generic `current` assignments sourced from discharge/impulse ratings. Updated PDT mappings to use the corresponding exact surge ratings and leave unrelated fields blank.
- Parsed the complete operating-temperature envelope when a datasheet splits normal and derated ranges across lines.
- Added `expectedNormalizedPatterns` to online benchmark fixtures so a populated-but-wrong normalized value fails. This batch asserts voltage/current, ABL8 temperature limits, and A9R22291 dimensions.

## Before and after

| Metric | Initial cold run | Final verified cold run |
| --- | ---: | ---: |
| Found | 4/5 (80%) | 5/5 (100%) |
| Exact official URL | 4/5 (80%) | 5/5 (100%) |
| Required documents, type, source attributes, normalized-value assertions, PDT audit | Initially had one partial source result and the ABL8 output-voltage error was not caught by the old presence-only assertion | 5/5 (100%) |
| Core connector acquisition, mean | 11.677 s/device | 0.696 s/device |
| Core connector acquisition, median / maximum | — | 0.303 / 1.853 s/device |
| Full isolated benchmark, mean | 35.493 s/device | 11.875 s/device |

The connector target of 2.5 seconds was met by all five in the final run. Full benchmark time includes documents, enrichment, and exports and is reported separately. Full-run latency remains variable, especially for the legacy photoelectric sensor.

Initial report: `../../benchmark-report.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-01.isolatedStorage-1.tag-schneider-batch-01-initial-02.json`.

Final report: `../../benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-01.isolatedStorage-1.tag-schneider-batch-01-verified-final.json`.

Final output and image evidence: `../../output/20261015053433/`.

Final quality summary: found, exact official URL, required documents, device type, normalized-value checks, source-attribute checks, and PDT audit are all 100%; wrong products, unproven PDT writes, and unexplained required-field issues are zero. Eleven PDT enum values remain blank as controlled skips.

TypeScript validation: `npx tsc --noEmit` passed before the final cold rerun.
