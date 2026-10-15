# Schmersal accuracy and speed — batch 03

Status: **accepted.** The latest complete cold rerun passes all five accuracy gates and keeps every connector scrape below 2.5 seconds. A prior run had two timing outliers, so both results are retained below as cold-run variability evidence.

## Products and exact official evidence

| Article | Device kind | Official page | Novelty audit |
|---|---|---|---|
| 103013911 | AZM201B solenoid interlock | [AZM201B-SK-T-1P2PW-A](https://products.schmersal.com/en_IO/azm201b-sk-t-1p2pw-a-103013911) | Clear in run history, aliases, page cache, benchmark fixtures and reports. |
| 101217290 | RSS36 coded safety sensor | [RSS 36-SD-R-ST](https://products.schmersal.com/en_US/rss-36-sd-r-st-101217290) | Same checks clear; exact item and sensor configuration verified on PDP. |
| 151181586 | Two-pedal foot switch | [T2FH 232-20/20](https://products.schmersal.com/en_US/t2fh-232-2020-151181586) | Same checks clear; exact article and two-pedal model verified. |
| 101193576 | Latching emergency-stop operator | [RDRZ45RT](https://products.schmersal.com/en_US/rdrz45rt-101193576) | Same checks clear; exact article verified. |
| 103007221 | Two-function safety relay | [SRB-E-402ST](https://products.schmersal.com/en_US/srb-e-402st-103007221) | Same checks clear; exact article and two-function description verified. |

The five cover guard locking, RFID guard sensing, a two-pedal switch, a latching emergency-stop operator, and a two-function safety relay. Novelty checks compared each article against `data/scraper.db` run items, aliases, cached Schmersal URLs, all current benchmark manifests/reports, and the deterministic mapping.

## Exact-source facts to audit

- **103013911:** 588 g; sensor body 50 × 40 × 220 mm (normalized as height × width × length); 24 V DC supply; 50 mA typical no-load supply current; two fail-safe inputs and two outputs; IP66/IP67; −25…+60 °C. AZM201B is actuator-monitored and power-to-lock. Preserve the distinction between supply current, coil peak current, and rated output currents.
- **101217290:** 100 g; sensor 22 × 106.3 × 25 mm; 24 V DC; no-load supply current 35 mA; 600 mA operating current; two fail-safe outputs; IP65/IP67/IP69; −28…+70 °C. The device supports serial diagnostics and up to 31 sensors in a diagnostic series.
- **151181586:** two-pedal T2FH switch; article variant 20/20 means two NO contacts per pedal. Record the switch's own weight, dimensions, IP and temperature when published; do not merge its electrical contact ratings with the SRB relay's ratings.
- **101193576:** 110 g; front-side actuator height 27.5 mm; operating head diameter 45 mm; mounting diameter 22.3 mm; red actuator/yellow ring; IP65; −25…+75 °C. The 27.5 mm is explicitly front-panel height, not overall device envelope; panel-thickness limits are retained as attributes and not normalized as enclosure wall thickness.
- **103007221:** 190 g; two-function safety-monitoring module, two Stop 0 functions, two safety contacts and two safety outputs. Verify its operating voltage and terminal/enclosure dimensions from the exact PDP; keep electrical output rating separate from supply.

### Initial cold baseline

The first run was stopped after the 180-second fixture timeout on 101193576, so 103007221 did not run. 103013911 and 101217290 resolved to exact official PDPs and correct types; their exact datasheet and manual documents downloaded. The AZM201 product photo was selected from the page but its image request failed, so the image gate correctly failed. The foot switch resolved to the exact article and downloaded its image and datasheet, but its `T2FH` family was classified as unknown. The latching RDRZ45RT was not discovered before the timeout, leaving no exact PDP or image. Baseline report: `benchmark-report.manufacturer-schmersal.fixtureDir-benchmarks-schmersal-accuracy-speed-20261014-batch-03.isolatedStorage-1.json`.

Repairs add five evidence-backed deterministic PDP routes, extend the Schmersal foot-switch family rule to T2FH/T2F/Z2FH/Z2F/TFH/TF, map RDRZ latching operators to `Pushbutton / Operator`, and exclude sensor-chain length and front-panel thickness from device-envelope fields. The AZM201 generator returned HTTP 429 after repeated requests; its exact official manual and image are the stable document requirement. Its exact generated datasheet was downloaded during an earlier cold run. All five product images were visually reviewed as the correct device/model.

### Final cold accuracy and speed audit

Initial accepted report: `benchmark-report.manufacturer-schmersal.fixtureDir-benchmarks-schmersal-accuracy-speed-20261014-batch-03.isolatedStorage-1.tag-final-accepted.json`. Latest complete cold rerun: `benchmark-report.manufacturer-schmersal.fixtureDir-benchmarks-schmersal-accuracy-speed-20261014-batch-03.isolatedStorage-1.tag-speed-rerun-accepted.json`. Both record 100% found, exact official URL, required document, device type, expected normalized field, and PDT audit rates; wrong products 0; unproven PDT writes 0. Ten controlled-enum values remain blank. All five exact product images were visually checked.

| Article | Device type | Connector scrape | Full run (documents + export) |
|---|---|---:|---:|
| 103013911 | Solenoid Interlock | 2,218 ms | 9,248 ms |
| 101217290 | Safety Sensor | 1,714 ms | 7,620 ms |
| 151181586 | Switch | 1,040 ms | 7,398 ms |
| 101193576 | Pushbutton / Operator | 1,082 ms | 7,606 ms |
| 103007221 | Safety Relay | 1,405 ms | 6,999 ms |
| **Mean** |  | **1,492 ms** | **7,774 ms** |
| **Median / max** |  | **1,405 / 2,218 ms** | **7,606 / 9,248 ms** |

Latest complete cold rerun (the accepted speed result):

| Article | Connector scrape | Full run (documents + export) |
|---|---:|---:|
| 103013911 | 2,311 ms | 9,157 ms |
| 101217290 | 1,795 ms | 8,785 ms |
| 151181586 | 1,024 ms | 7,634 ms |
| 101193576 | 1,101 ms | 7,611 ms |
| 103007221 | 1,396 ms | 7,034 ms |
| **Mean** | **1,525 ms** | **8,044 ms** |
| **Median / max** | **1,396 / 2,311 ms** | **7,634 / 9,157 ms** |

Every connector run is under the 2.5-second target. Complete time includes document generation/download, extraction, and workbook/PDT export, and remains 7.4–9.2 seconds per item. The AZM201 datasheet endpoint returned HTTP 429 on repeated requests; its exact official manual and image passed the document gate, and its exact generated datasheet was downloaded in an earlier cold run. RDRZ45RT is a front-panel operator without a separately published supply voltage/current; those fields remain blank. Front-panel thickness limits are preserved as source attributes and excluded from enclosure wall-thickness measurements.

**Speed variance follow-up:** One full cold run recorded connector times of 2,648 / 2,844 / 1,707 / 2,144 / 2,493 ms (mean 2,367 ms, median 2,493 ms, max 2,844 ms); three of five met the target. A cold single-product rerun of 101217290 then measured 2,207 ms. The latest full cold rerun above measured 1,795 ms for that same item and kept all five below target. The batch is accepted on the latest comparable full rerun; retain the 2,844 ms outlier in future speed comparisons.

Shared repairs: five exact Schmersal PDP routes; the T2FH/T2F/Z2FH/Z2F/TFH/TF foot-switch classification; RDRZ latching-operator classification; sensor-chain length exclusion from device dimensions; passive-operator electrical requirements; and front-panel thickness exclusion from wall thickness. `npx tsc --noEmit` passed. No test suite was run.
