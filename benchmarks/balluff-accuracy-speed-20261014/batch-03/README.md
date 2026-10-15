# Balluff cold batch 03

## Novelty and source checks

The five catalog numbers were screened against prior benchmark manifests/reports, aliases, run history, cached product URLs, and source files. They were new to the records checked and represent five distinct product types. The isolated cold run used the exact official Balluff product page and downloaded/parsed a datasheet for each product.

## Product review

| SKU | Verified type | Important exact-product facts reviewed |
| --- | --- | --- |
| `BMF00PA` | Magnetic Field Sensor | Magnetic-field sensor, cylindrical stainless-steel housing; 10–30 V DC; IP67; 1.4404 stainless steel; 8 × 32 mm; −25…85 °C. [Official page](https://www.balluff.com/en-gb/products/BMF00PA) |
| `BSP00Y4` | Pressure Sensor | Digital pressure sensor with display; 0…10 bar; ±0.5% FSO; 18–30 V DC; selectable IO-Link/4–20 mA/0–10 V; 2× PNP/NPN; G 1/4; IP67 when threaded; current draw max. 50 mA. [Official page](https://www.balluff.com/en-gb/products/BSP00Y4) |
| `BVS01ZC` | Vision Sensor | Balluff vision sensor with integrated illumination; 18–30 V DC; 18…30 V; max. 1.6 A; IP67; 56 × 56 × 59 mm; aluminium die-cast painted housing; 0…55 °C. [Official page](https://www.balluff.com/en-gb/products/BVS01ZC) |
| `BCM0002` | Condition Monitoring Sensor | Condition-monitoring sensor for vibration, temperature, humidity and ambient pressure; 18–30 V DC; max. 10 mA; IP67; 1.4404 stainless steel with ePTFE membrane; 20 × 10 × 32 mm; −25…70 °C. [Official page](https://www.balluff.com/en-gb/products/BCM0002) |
| `BRS0002` | Radar Sensor | 122 GHz radar sensor for object detection/distance measurement; 15–30 V DC; max. 60 mA; IP69K; 1.4404 stainless steel/PEEK; 30 × 30 × 94 mm; −25…70 °C. [Official page](https://www.balluff.com/en-gb/products/BRS0002) |

All five downloaded product images were opened and visually checked. Each image shows the expected product form; none is labeled a similar illustration. Datasheets were downloaded and parsed for all five. Official pages and exact catalog identities were checked independently of device-type classification.

## Shared corrections

- Added shared classification and Balluff family coverage for pressure, condition-monitoring, and radar sensors; mapped the latter two to the electronic-sensor PDT profile.
- Balluff pressure detection now handles plural/category wording on product pages.
- Protection normalization now prefers exact-model Balluff datasheet evidence over sibling/comparison rows. This removed unsupported IP68/IP69K values from BMF00PA; its exact datasheet value is IP67.
- Current consumption and current output remain separate: BSP00Y4's current draw is 50 mA; its output-current maximum (150 mA) is not treated as supply draw.

## PDT exception

The `sensor - fluid` sheet marks `AAB485` (“Rated current”) as a must field for BSP00Y4. The exact source labels the supported value “Current draw max. 50 mA,” not “rated current.” The normalized product data retains the sourced current-draw value, but the PDT cell remains blank rather than treating two distinct labels as equivalent without a validated mapping. Audit: one required-field issue, explicitly classified as explained; zero unproven written values. Enum mismatches also remain blank.

## Cold accuracy and speed result

Final report: `../../benchmark-report.manufacturer-balluff.fixtureDir-benchmarks-balluff-accuracy-speed-20261014-batch-03.isolatedStorage-1.tag-cold-accuracy-after-shared-fixes.json`

| SKU | Connector scrape ms | Complete benchmark ms |
| --- | ---: | ---: |
| `BMF00PA` | 1,326 | 8,461 |
| `BSP00Y4` | 1,612 | 6,246 |
| `BVS01ZC` | 2,302 | 6,753 |
| `BCM0002` | 966 | 4,944 |
| `BRS0002` | 1,990 | 6,140 |

Connector acquisition averaged **1,639 ms** per device (median **1,612 ms**, maximum **2,302 ms**), within the ~2.5-second target. The complete benchmark averaged **6,509 ms** (median **6,246 ms**, maximum **8,461 ms**), including document download/enrichment and workbook/PDT export.

## Verification

- Final isolated cold benchmark: 5/5 found; 100% exact official URLs, required documents, device types, and PDT audit matches; zero wrong products; zero unproven PDT writes. The BSP00Y4 required-field exception above remains visible.
- Image review: all five downloaded product images visually checked against their product types.
- Focused classification and normalization tests: 37 passed (387 unrelated tests filtered); `npx tsc --noEmit` passed.
- The report records 20 PDT write issues/skips, primarily controlled-enum values. Unsupported values stayed blank.
- Batch meets the connector-stage time target; full benchmark time remains longer because it includes document processing and export.
