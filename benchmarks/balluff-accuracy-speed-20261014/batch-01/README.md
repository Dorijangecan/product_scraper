# Balluff cold batch 01

Five new Balluff products were checked against benchmark history, the run-item database, product aliases, and cached page URLs before selection. Each product resolves to its exact official Balluff page and a distinct device type. The final isolated cold report passed all five identity, official URL, document, device-type, required-field, and PDT gates. No wrong products or unproven PDT writes were reported.

## Product review

| Catalog number | Verified type | Official product evidence and important facts |
| --- | --- | --- |
| `BFF0001` | Flow Sensor | Thermal flow sensor BFF T7031-HA001-D06A2A-S4. Flow range 1–150 cm/s in aqueous media and 3–300 cm/s in oil; 20–28 V DC; PNP output; current draw max. 70 mA, distinct from its 400 mA switching-current limit; G 1/2 process connection; probe diameter 7.3 mm and installation length 31 mm; 1.4571 stainless-steel connection, IP67, 100 bar maximum, −20…80 °C. [Official product page](https://www.balluff.com/en-gb/products/BFF0001) |
| `BTS0003` | Temperature Sensor | Contactless infrared temperature sensor BTS M30E0-PSB-H0001-S04G. 250–1250 °C measurement range; 10–30 V DC; analog 4–20 mA and PNP NO/NC switching outputs; 100 mA rated operating current; 30 × 190 mm; stainless steel and aluminum housing with black anodized finish; IP65/IP67, −5…65 °C. [Official product page](https://www.balluff.com/en-gb/products/BTS0003) |
| `BIS018K` | RFID Device | BIS V multi-frequency RFID processor. Four connectable read/write heads; LF/HF/UHF support; Ethernet (MQTT/REST API/Balluff 007) and USB; 24 V DC SELV/PELV; max. 5.2 A at 24 V DC; 48 × 62 × 172 mm; zinc die-cast housing; IP65 with connector, 0…60 °C. [Official product page](https://www.balluff.com/en-gb/products/BIS018K) |
| `BAE0007` | Power Supply | PS-XA-3Y-24-050-009. Three-phase 400–500 V AC input; rated output 24 V DC, 5 A; 74.3 × 124 × 111.9 mm; 0.80 kg; metal housing, DIN-rail mount, IP20, −40…70 °C. [Official product page](https://www.balluff.com/en-gb/products/BAE0007) |
| `BNI006A` | I/O Module | BNI EIP-508-105-Z015 EtherNet/IP IO-Link master. Eight IO-Link ports; 18–30.2 V DC; max. 2 A output, with separate 9 A sensor and actuator current sums; 68 × 37.9 × 224 mm; nickel-plated zinc die-cast housing; IP67 when threaded in; −5…70 °C. [Official product page](https://www.balluff.com/en-gb/products/BNI006A) |

All five final product images were opened and visually checked. The image for each showed the expected device form and Balluff/model labeling: thermal flow probe, infrared sensor, BIS V processor with four head connections, BAE0007 power supply, and BNI006A I/O master. The final image files are in `../../output/20261014120651/images/`. SHA-256 checks confirmed the final images are byte-identical to the five visually reviewed images.

## Shared corrections

- Balluff temperature classification now recognizes plural official wording such as `Temperature Sensors`, so BTS0003 resolves as `Temperature Sensor`.
- For Balluff, normalized current draw now prefers a published `Current draw`/`Current consumption` row. The rule accepts official Balluff pages and exact-match rows from Balluff's official PDF table extractor; it does not mistake BFF0001's 400 mA switching-current limit for the 70 mA maximum draw.
- Housing material can be normalized from the exact `Housing material` label on Balluff's official product page, including pages whose parser does not set `sourceType` explicitly. An unrelated source URL does not qualify.
- BFF0001's dimensions combine its exact PDF probe diameter with the official page's installation length, instead of duplicating the 31 mm length as both depth and length.
- Finish extraction for Balluff uses a labeled finish or an explicit finish phrase in the official housing-material value. BTS0003 now yields `black anodized`, without carrying the following aluminum alloy text into the finish field.
- The analog 4–20 mA signal on BTS0003 is excluded from normalized device current. Its exact datasheet row `Rated operating current Ie` supplies 100 mA instead.
- The scraper parses a matched static-page datasheet before making the readable-page and reader fallback requests. The exact page and matched PDF still supply the profile's core fields; fallbacks remain available when a source gap remains.
- Balluff's repeated section-token work now uses a precomputed, length-sorted field-label matcher instead of sorting and canonicalizing the entire label list for every text token.

## Accuracy and speed result

Final report: `../../benchmark-report.manufacturer-balluff.fixtureDir-benchmarks-balluff-accuracy-speed-20261014-batch-01.isolatedStorage-1.tag-connector-time-metric-verified.json`

| Catalog number | Connector scrape ms | Complete benchmark ms |
| --- | ---: | ---: |
| `BFF0001` | 1,245 | 5,568 |
| `BTS0003` | 1,052 | 5,692 |
| `BIS018K` | 936 | 4,680 |
| `BAE0007` | 1,044 | 6,307 |
| `BNI006A` | 1,262 | 7,178 |

Connector scrape averaged 1,108 ms per device (median 1,052 ms, maximum 1,262 ms), meeting the 2.5-second connector target on this cold run. The complete benchmark averaged 5,885 ms (median 5,692 ms, maximum 7,178 ms); it includes document download/enrichment and workbook/PDT exports. Those stages remain visible because they still contribute to actual end-to-end time. Earlier `scrapeElapsedMs` reports included document work and are not comparable; the benchmark now times only `connector.scrape()` in that field. If the 2.5-second goal is intended to include downloads and exports, this batch still needs more work. Keep the same five products until that scope is settled by the measured workflow.

The PDT audit reported 10 skipped enum values and zero unproven writes. These values remained blank where they did not match a controlled PDT legend. The quality gate passed; the enum skips do not represent fabricated values or wrong product identities.

## Verification

- Six focused checks passed for plural Balluff temperature classification, official housing material, PDF-based maximum current draw, separation of signal and rated current, probe/installation dimensions, and finish extraction.
- `npx tsc --noEmit` passed after the shared normalization changes.
- Debug profiling found section parsing spent about 1,048 ms matching the 569-token Classifications section because it resorted the complete labels per token. Precomputing the matchers reduced that section to about 96 ms and the complete BAE0007 page parse from 1,932 ms to 552 ms in the measured debug runs.
- A one-product debug run before the static-page fast path recorded BAE0007's page fetch at 847 ms and first matched datasheet enrichment at 1,931 ms. The static-page path now leaves that enrichment to the shared download stage, which preserves the final normalized fields while keeping connector time low.
- The benchmark now measures `connector.scrape()` separately from document downloads/enrichment and exports; prior reports had started the scrape timer before the document stages. The final cold connector measurements are the comparable values above.
- The Balluff-filtered parser, normalizer, and device-type run passed 80 selected tests (649 unrelated cases skipped by the filter). Two stale rounded-weight expectations were updated to the existing exact conversions (`0.516 kg` and `0.235 kg`).
- The run wrote isolated benchmark outputs; it did not use the shared product database for its saved run state.
