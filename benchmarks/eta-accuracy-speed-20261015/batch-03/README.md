# E-T-A cold batch 03

This batch uses five model designations not present in the earlier E-T-A accuracy-speed manifests or cold-product fixtures. It spans a thermal-magnetic breaker, a PROFINET bus controller, a DIN-rail power distribution system, a mechanical power relay, and a three-phase 24 V power supply. `eta.json` records the exact official-page pattern, type, required documents, and source-backed attribute assertions for each case.

## Official source review

- `2210-S2`: [official E-T-A product page](https://www.e-t-a.com/products/circuit_protection_devices/thermal_magnetic_overcurrent_circuit_breakers/p/2210_s2/) identifies the thermal-magnetic circuit breaker family, ratings from 0.1 A to 25 A, AC 250 V / DC 65 V, and EN 60934 approval. The SKU is the exact model family shown on that page, not an inferred current/pole variant.
- `CPC20`: [official E-T-A CPC20 page](https://www.e-t-a.com/products/power_distribution_systems/intelligent_power_distribution_systems/controlplex_overview/controlplex_dinrail/bus_controllers/p/cpc20/) identifies the bus controller and links its PROFINET and EtherNet/IP datasheets. The published ratings include DC 24 V and 80 A.
- `Module 18plus`: [official E-T-A page](https://www.e-t-a.com/solutions/automation_process_control/car_production/p/modul_18plus/) describes a DIN-rail power distribution system. It publishes 100 A supply max-current rating and a separate 125 load-current rating without an explicit unit; the scraper preserves both source rows and normalizes only the stated 100 A rating. The official page links an exact 18plus product image.
- `MPR20`: [official E-T-A product page](https://www.e-t-a.com/products/relays_solid_state_remote_power_controllers/power_relays/p/mpr20/) describes a monostable mechanical power relay, 12/24/48 V variants, 100/200/300 A current variants, and a -40 to +85 °C range. The model designation does not select one voltage/current variant, so the raw variant ratings must not be collapsed into a guessed single value.
- `PFA10-T 40 A, DC 24 V`: [official E-T-A product page](https://global.e-t-a.com/products/switch_mode_power_supply_units/3_phase_switch_mode_power_supplies/p/pfa10_t_40_a_dc_24_v/) states 40 A output, DC 24 V output, AC 400–480 V rated input, and the 150% short-time overload reserve.

The first isolated run found the 2210-S2 page and downloaded a composite 18plus/ESS30/ESX10/2210 image; visual inspection showed that this asset is not an exact standalone breaker photo. The other four models timed out in generic ETA discovery after 60 seconds. The route and image-evidence changes address these shared causes; the same five inputs are being rerun before any speed tuning.

## Initial isolated cold run

Report: `benchmark-report.manufacturer-eta.limit-5.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-eta-batch03-initial-cold-01.json`.

| Model | Result | Core scrape | Evidence / issue |
| --- | --- | ---: | --- |
| `2210-S2` | Found; exact PDP, type, datasheet and PDT passed | 4,365 ms | Voltage normalized as only `65 V DC` despite the page also publishing AC 250 V and 3 AC 433 V; downloaded composite system image rejected during visual audit; expected EN 60934 attribute was not emitted. |
| `CPC20` | Timed out | 0 ms | Generic discovery timeout after 60 s; no product evidence. |
| `Module 18plus` | Timed out | 0 ms | Generic discovery timeout after 60 s; no product evidence. |
| `MPR20` | Timed out | 0 ms | Generic discovery timeout after 60 s; no product evidence. |
| `PFA10-T 40 A, DC 24 V` | Timed out | 0 ms | Generic discovery timeout after 60 s; no product evidence. |

Overall gates: found 20%, exact official URL 20%, required documents 20%, device type 20%, normalized assertions 20%, source-attribute assertions 0%, PDT audit 20%. The timeout rows are not accepted; fix and rerun all five before optimizing.

## Current accuracy rerun

Report: `../../benchmark-report.manufacturer-eta.limit-5.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-03.isolatedStorage-1.json`.

| Model | Core scrape | Identity / page | Docs | Type | Normalized fields | Source assertions | PDT | Current finding |
| --- | ---: |---|---|---|---|---|---|---|
| `2210-S2` | 1,245 ms | Pass | Pass | Pass | Pass | Pass | Pass | Exact standalone image is used; normalized ratings preserve 3 AC 433 V / AC 250 V / DC 65 V. The official PDP standards extractor records EN 60934. |
| `CPC20PN-T2` | 850 ms | Pass | Pass | Pass | Pass | Pass | Pass | Exact variant is supported by the linked PN-T2 datasheet and image. |
| `Module 18plus` | 6,187 ms | Pass | Pass | Pass | Pass | Pass | Pass | Exact official image found and visually checked. 100 A supply rating and unitless 125 load rating remain separate. Core scrape needs optimization. |
| `MPR20` | 1,650 ms | Pass | Pass | Pass | Pass | Pass | Pass | Classification resolves to Relay; published 12/24/48 V variants are preserved. |
| `PFA10-T 40 A, DC 24 V` | 703 ms | Pass | Pass | Pass | Pass | Pass | Pass | Exact English PDP, image and datasheet resolve; normalized voltage/current are the rated 24 V DC output and 40 A output current. |

The complete accuracy pass is recorded in `benchmark-report...tag-eta-batch03-accuracy-complete-cold-02.json`. All five pass exact identity, official URL, image/datasheet, device type, normalized fields, expected source attributes and PDT checks. The exact product images were visually reviewed. Core times were 1,245 / 850 / 6,187 / 1,650 / 703 ms; Module 18plus is the remaining speed outlier.

## Cold speed rechecks and phase diagnosis

Three additional isolated full cold runs passed all accuracy gates 5/5, with zero wrong products and zero unproven PDT writes. Their `scrapeElapsedMs` values were:

| Model | Speed cold 01 | Speed cold 02 | Final cold 03 |
| --- | ---: | ---: | ---: |
| `2210-S2` | 1,194 ms | 1,259 ms | 1,214 ms |
| `CPC20PN-T2` | 938 ms | 894 ms | 871 ms |
| `Module 18plus` | 2,610 ms | 6,030 ms | 2,868 ms |
| `MPR20` | 1,777 ms | 1,589 ms | 1,674 ms |
| `PFA10-T 40 A, DC 24 V` | 791 ms | 699 ms | 1,669 ms |
| **Mean / median / max** | **1,462 / 1,194 / 2,610 ms** | **2,094 / 1,259 / 6,030 ms** | **1,659 / 1,669 / 2,868 ms** |

The core-scrape mean is below 2.5 seconds in all three runs, but Module 18plus is not reliably below the per-device target, so this batch is not yet accepted for speed. Isolated Module 18plus cold profiles measured 1,171 ms and 1,182 ms in two other runs. Phase logs show parsing takes 480–638 ms; full-run page fetches ranged from about 0.54 seconds to 5.55 seconds. In final cold 03, the page fetch took 2,365 ms (1,073 ms wait, 1,226 ms to first byte, 56 ms download); the full core scrape took 2,868 ms. A fast HTTP sample spent about 538 ms on the same fetch (367 ms to first byte, 46 ms downloading). The remaining variation is in HTTP response timing, not the generic parser. No evidence supports weakening exact identity, source, or document checks to hide that variation.

`DEBUG_HTTP_TIMINGS=1` now exposes got-scraping wait/first-byte/download phases for diagnosing slow official responses. It is disabled by default and does not change fetch or acceptance behavior. The full speed reports are `benchmark-report...tag-eta-batch03-speed-verification-cold-01.json`, `benchmark-report...tag-eta-batch03-speed-verification-cold-02.json`, and `benchmark-report...tag-eta-batch03-final-cold-03.json`; the isolated phase reports are `benchmark-report...tag-eta-batch03-18plus-phase-trace-01.json` and `benchmark-report...tag-eta-batch03-18plus-http-phase-cold-01.json`.
