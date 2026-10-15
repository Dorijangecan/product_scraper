# Rockwell accuracy and speed — batch 04

Status: **product, source, document, normalized-value, device-type, and PDT checks accepted; exact image coverage is 0/5.** Five new SKUs from five distinct device types were checked against Rockwell's exact pages and source documents. The scraper does not return any exact product image for this batch, so all five image fields remain empty.

## Products and evidence reviewed

| Catalog number | Device type | Official source | Key evidence checked |
|---|---|---|---|
| `1734-IB8` | I/O Module | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.1734-IB8.html) | Active POINT I/O, 8-channel 24 V DC sinking input module; exact page temperature rating −20…55 °C; installation instructions and user manual. Normalized 10…28.8 V DC and 2 mA are retained as the module's published electrical input context. |
| `700-HK36Z24` | Relay | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.700-HK36Z24.html) | 24 V DC rated control supply; 16 A nominal/thermal rating applies to relay contacts. IP20; exact technical-data publication 700-TD552. Supply current remains blank because the PDP does not publish it. |
| `440G-LZS21UPLH` | Lock / Interlock | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.440G-LZS21UPLH.html) | Active Guardmaster 440G-LZ, power-to-lock, 24 V DC solenoid, RFID unique actuator, 2 × PNP safety/aux outputs (0.2 A max each) and lock-status output. Those output currents are not supply current. Manual 440G-UM001 and installation instructions 440G-IN011. |
| `1492-SPM2D250` | Miniature Circuit Breaker (supplementary protector) | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.1492-SPM2D250.html) | Active, 25 A, 2-pole, trip curve D, no neutral; official 1492-TD019 / 1492-SPM specifications. Its 250/500 V DC values remain labeled in the source contexts rather than being collapsed into one unsupported rating. |
| `800FM-KL34` | Selector Switch | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.800FM-KL34.html) | Active 22 mm 3-position metal key selector; spring-return from left; key removal in center; 10 A contact-block thermal rating; IP66 / Type 4/13; −25…55 °C from official 800-UM001. Contact current and values from neighboring electronic operators are not treated as device supply ratings. |

## Initial cold baseline and final cold audit

| Product | Initial core scrape | Final core scrape | Final full benchmark |
|---|---:|---:|---:|
| `1734-IB8` | 1.789 s | 1.972 s | 11.004 s |
| `700-HK36Z24` | 3.440 s | 1.421 s | 31.890 s |
| `440G-LZS21UPLH` | 3.700 s | 0.993 s | 21.153 s |
| `1492-SPM2D250` | 2.854 s | 0.949 s | 7.510 s |
| `800FM-KL34` | 2.731 s | 2.023 s | 12.288 s |
| **Mean** | **2.903 s** | **1.472 s** | **16.769 s** |

Core acquisition improved by **49.3%** by mean. The maximum fell from **3.700 s to 2.023 s**, and all five final core scrapes meet the 2.5-second target. Full benchmark time includes document/PDF enrichment and workbook/PDT processing; it is separately reported and is not the core scrape target.

Initial report: `../../benchmark-report.fixtureDir-benchmarks-rockwell-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-rockwell-batch-04-initial.json`.

Final accepted cold report: `../../benchmark-report.fixtureDir-benchmarks-rockwell-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-rockwell-batch-04-final-cold-01.json`.

## Corrections and acceptance

- Rockwell's 440G-LZ guard-lock switches now classify as `Lock / Interlock`; they no longer fall under the broad safety-sensor family.
- 800FM/800FP selector operators classify as `Selector Switch` ahead of the broader 800F pushbutton family.
- 700-HK normalization uses its exact rated DC control supply and leaves contact ratings out of device supply current.
- Mechanical 800FM/800FP selector operators no longer inherit supply voltage or current from other electronic operators. The exact user-manual temperature range retains °C units.
- `npx tsc --noEmit` passed.
- Final product gates: exact found 5/5; official URL 5/5; required documents 5/5; expected device type 5/5; expected normalized values 5/5; expected source attributes 5/5; PDT audit 5/5. Wrong products 0; unproven PDT writes 0; unexplained required-field issues 0.
- The benchmark's broader PDT sheet coverage is 3/41 and therefore `Coverage accepted: no`; the five-product quality result is `Quality accepted: yes`. These are separate gates.
