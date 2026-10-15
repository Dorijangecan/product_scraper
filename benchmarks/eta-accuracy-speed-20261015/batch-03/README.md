# E-T-A cold batch 03

This batch uses five model designations not present in the earlier E-T-A accuracy-speed manifests or cold-product fixtures. It spans a thermal-magnetic breaker, a PROFINET bus controller, a DIN-rail power distribution system, a mechanical power relay, and a three-phase 24 V power supply. `eta.json` records the exact official-page pattern, type, required documents, and source-backed attribute assertions for each case.

## Official source review

- `2210-S2`: [official E-T-A product page](https://www.e-t-a.com/products/circuit_protection_devices/thermal_magnetic_overcurrent_circuit_breakers/p/2210_s2/) identifies the thermal-magnetic circuit breaker family, ratings from 0.1 A to 25 A, AC 250 V / DC 65 V, and EN 60934 approval. The SKU is the exact model family shown on that page, not an inferred current/pole variant.
- `CPC20`: [official E-T-A CPC20 page](https://www.e-t-a.com/products/power_distribution_systems/intelligent_power_distribution_systems/controlplex_overview/controlplex_dinrail/bus_controllers/p/cpc20/) identifies the bus controller and links its PROFINET and EtherNet/IP datasheets. The published ratings include DC 24 V and 80 A.
- `Module 18plus`: [official E-T-A page](https://www.e-t-a.com/solutions/automation_process_control/car_production/p/modul_18plus/) describes a DIN-rail power distribution system. It publishes 100 A supply max-current rating and a separate 125 load-current rating without an explicit unit; the scraper preserves both source rows and normalizes only the stated 100 A rating. Its linked datasheet's 70 g mass is specifically for the 18plus EM submodule, not the complete system, so normalized weight stays blank. The official page links an exact 18plus product image.
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

The initial complete accuracy pass is recorded in `benchmark-report...tag-eta-batch03-accuracy-complete-cold-02.json`. It passed the then-current assertions, but a later review found that the datasheet's 18plus EM submodule mass had been misapplied to the complete power-distribution system. Treat that report as historical, not final acceptance. The corrected manifest now requires normalized system weight to remain blank; the component mass remains available only as raw source evidence.

## Cold speed rechecks and phase diagnosis

Three historical isolated full cold runs passed the then-current accuracy assertions 5/5, with zero wrong products and zero unproven PDT writes. Because they predate the new expected-blank weight assertion, they are retained as timing history and are not final accuracy acceptance. Their `scrapeElapsedMs` values were:

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

## Corrected weight gate and structured-table fast path

The corrected weight assertion passed in two full isolated cold runs before parser optimization. Core scrape times were 1,157 / 905 / 2,655 / 1,634 / 674 ms (mean 1,405 ms, max 2,655 ms) and 1,231 / 857 / 2,788 / 1,660 / 718 ms (mean 1,451 ms, max 2,788 ms). Both runs passed all five identity, official URL, document/image, device type, normalized field, source-attribute and PDT checks, including the required blank system weight.

For exact E-T-A pages with at least three labeled technical table rows, the parser now reads those tables first and skips broad duplicate scans while retaining identity confirmation, standards, documents, images, markers, and metadata. Pages without enough structured rows keep the full parser path. In the Module 18plus profile, parser time fell from 480–638 ms to 208 ms; other batch items measured 131–305 ms. This reduces parser work but does not control upstream page response latency.

Two full isolated cold passes after this optimization each passed all accuracy assertions 5/5 (including blank normalized system weight); there were zero wrong products and zero unproven PDT writes. Core `scrapeElapsedMs` values:

| Model | Structured fast path cold 01 | Structured fast path cold 02 |
| --- | ---: | ---: |
| `2210-S2` | 816 ms | 857 ms |
| `CPC20PN-T2` | 583 ms | 606 ms |
| `Module 18plus` | 5,775 ms | 5,640 ms |
| `MPR20` | 1,361 ms | 1,407 ms |
| `PFA10-T 40 A, DC 24 V` | 439 ms | 443 ms |
| **Mean / median / max** | **1,795 / 816 / 5,775 ms** | **1,791 / 857 / 5,640 ms** |

Those two runs were an intermediate result: the official `Module 18plus` request took about 5.6 seconds after got-scraping reached its configured timeout and the existing `curl` rescue finally returned the page. The parser fast path reduced CPU work, but the transport still spent the timeout before recovering. Reports: `benchmark-report.manufacturer-eta.limit-5.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-eta-batch03-structured-fastpath-cold-01.json` and `benchmark-report.manufacturer-eta.limit-5.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-eta-batch03-structured-fastpath-cold-02.json`.

## Bounded curl-first route and final cold passes

Four direct `curl.exe` probes of the exact official 18plus page returned HTTP 200, the requested product text, and its 100 A rating in 370–570 ms. In a full cold benchmark with phase logging, the existing got-scraping-first path spent 5,563 ms on 18plus before its internal curl rescue returned the page; the parser itself took 212 ms. This identified a wasted wait against the route's five-second timeout.

Learned ETA exact-PDP routes now try the existing bounded curl transport first, checking the same minimum-content threshold. If curl fails or returns too little content, the prior got-scraping/fallback path remains available. The parser still requires the exact requested catalog number and all existing quality gates. The change applies to learned ETA routes as a group, not to one SKU.

Two isolated full cold runs after this transport change passed all five accuracy gates, including exact official URLs, documents and images, device type, normalized fields, source assertions and PDT audit. Wrong products: 0; unproven PDT writes: 0. Every core scrape was below 2.5 seconds:

| Model | Curl-first cold 01 | Curl-first cold 02 |
| --- | ---: | ---: |
| `2210-S2` | 920 ms | 869 ms |
| `CPC20PN-T2` | 840 ms | 687 ms |
| `Module 18plus` | 1,305 ms | 1,829 ms |
| `MPR20` | 690 ms | 671 ms |
| `PFA10-T 40 A, DC 24 V` | 657 ms | 650 ms |
| **Mean / median / max** | **882 / 840 / 1,305 ms** | **941 / 687 / 1,829 ms** |

The final core-scrape means are 38.2% and 34.1% below the 1,428 ms mean of the two weight-corrected pre-transport passes, respectively; all five devices also meet the per-device ceiling on both final passes. The complete benchmark still takes longer because it includes PDF/image downloads, enrichment and export. Reports: `benchmark-report.manufacturer-eta.limit-5.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-eta-batch03-curl-primary-cold-01.json`, `benchmark-report.manufacturer-eta.limit-5.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-eta-batch03-curl-primary-cold-02.json`, and phase trace `benchmark-report.manufacturer-eta.limit-5.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-eta-batch03-http-phases-cold-01.json`.
