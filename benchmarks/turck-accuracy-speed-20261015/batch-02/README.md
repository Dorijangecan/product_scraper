# Turck accuracy and speed — batch 02

**Status: accepted for product accuracy and core acquisition speed.** The final two isolated cold runs passed all five devices. The manifest requires an exact official product page, a datasheet and an image for every device; all identity, type, normalized-value, source-attribute and PDT checks passed 5/5.

## Products and evidence reviewed

| Catalog number | Verified type | Exact Turck product page | Source-backed facts checked |
|---|---|---|---|
| `RU40U-Q12S-UP8X-V1141` | Ultrasonic Sensor | [Turck order 100005610](https://www.turck.com/de/en/shop/sensors/ultrasonic-sensors/100005610) | 400 mm range; 82 × 12 × 12 mm; IP67; −25…70 °C; 18…30 V DC; 40 mA no-load current; IO-Link and 1 cm resolution. |
| `UC15-S18-IOL` | Capacitive Sensor | [Turck order 100050168](https://www.turck.com/de/en/shop/sensors/capacitive-sensors/100050168) | Capacitive M18 sensor; IP67; −40…60 °C ambient; media up to 85 °C; 10…30 V DC; IO-Link. The published `DC rated operational current ≤200 mA` is an output-load limit, not sensor draw, so normalized current stays blank. The 2 m cable length remains explicitly qualified as cable length. |
| `FCMI-15D12DYA4P-LIUP8X-H1141` | Flow Sensor | [Turck order 6870601](https://www.turck.com/de/en/shop/sensors/flow-sensors/flow-meters/6870601) | 0…80 l/min; IP65; 0…60 °C ambient; 21.6…26.4 V DC; ≤100 mA current consumption; separate 4…20 mA analog current output; 15 × 1.5 mm process connection. |
| `TP-206A-CF-H1141-L200` | Temperature Sensor | [Turck order 9910477](https://www.turck.com/de/en/shop/sensors/temperature-sensors/9910477) | Passive Pt100 resistance probe; −50…500 °C measuring range; −40…120 °C ambient; 200 mm immersion depth; 6 mm outer probe diameter; IP67. Supply voltage and current remain blank because this probe has no active electrical supply. |
| `LI700P1-Q25LM4-LIU5X3-H1151` | Linear Position Sensor | [Turck order 1590246](https://www.turck.com/de/en/shop/sensors/linear-position-sensors/1590246) | Inductive 700 mm measuring range; 758 × 35 × 25 mm; IP67; −25…70 °C; 15…30 V DC; <50 mA current consumption; separate 4…20 mA analog output. |

The downloaded images were opened and visually checked against the exact products. RU40, UC15, TP-206A and LI700 show the corresponding device. Turck's returned FCMI asset is an official dimension drawing of the exact flow sensor, not a photograph; no exact-product photograph was established by this run. Image hashes matched across the final cold outputs.

## Corrections

- Added Turck family mappings for `TP-2`/`TP-5` temperature probes and `LI` inductive linear position sensors. The shared text classifier now recognizes the published “flow rate measurement” and “linear position sensor” categories.
- Turck EDB datasheets are parsed as complete product documents only when the PDF's numeric EDB order ID matches the exact official PDP order ID and the PDF itself contains the exact requested type designation. This preserves source scope while recovering nearby rows that the narrow catalog window omitted.
- The FCMI PDF's `Current consumption ≤100 mA` is now extracted separately from `Current output 4…20 mA`. Mixed decimal separators around an ellipsis range are normalized per number, so the voltage remains 21.6…26.4 V rather than becoming a false 21626.4 V attribute.
- Passive resistance temperature probes do not trigger a voltage/current fallback. Capacitive sensors with only a published DC rated output-load current retain a blank normalized current instead of mislabeling that limit as device consumption.
- The manifest now checks the LI700 supply voltage and consumption current as normalized fields and requires a datasheet plus image for all five products.

## Before and after

The first exploratory cold run timed out while processing the passive temperature probe; it did not finish all five devices. The last complete pre-final run found all products and documents, but passed only 3/5 device-type checks and 4/5 normalized-field and source-attribute checks. Its core acquisition mean was 2.873 s/device (median 2.707 s, range 1.702–5.049 s).

The final runs use isolated cold storage and the same five-product set. The last manifest update also asserts the LI700 voltage and current values. Core acquisition is `scrapeElapsedMs`; complete fixture time also includes document parsing/enrichment and workbook/PDT export.

| Metric | Pre-final complete run | Final cold 03 | Final acceptance cold 04 |
|---|---:|---:|---:|
| Correct device type | 3/5 | 5/5 | 5/5 |
| Expected normalized fields / source attributes | 4/5 / 4/5 | 5/5 / 5/5 | 5/5 / 5/5 |
| Exact identity / official URL / required datasheet and image | 5/5 / 5/5 / not image-gated | 5/5 / 5/5 / 5/5 | 5/5 / 5/5 / 5/5 |
| PDT audit / wrong products / unproven writes | 5/5 / 0 / 0 | 5/5 / 0 / 0 | 5/5 / 0 / 0 |
| Core acquisition mean | 2.873 s | 1.683 s | 1.663 s |
| Core acquisition median / range | 2.707 s / 1.702–5.049 s | 1.704 s / 1.536–1.794 s | 1.577 s / 1.566–1.824 s |
| Devices at or below 2.5 s | 3/5 | 5/5 | 5/5 |

Both final cold runs pass every product gate and keep every core scrape below 2.5 seconds. The final acceptance run's complete fixture times are 6.958–14.366 s/device because it includes PDF work and exports; this is reported separately from core acquisition. Twenty-five unsupported PDT enum values stayed blank; there were no unproven written values.

## Reports and verification

- Initial exploratory timeout: `../../benchmark-report.manufacturer-turck.limit-5.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-02.isolatedStorage-1.tag-turck-batch-02-initial.json`
- Last complete pre-final run: `../../benchmark-report.manufacturer-turck.limit-5.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-02.isolatedStorage-1.tag-turck-batch-02-accuracy-fix-02.json`
- Final cold 03: `../../benchmark-report.manufacturer-turck.limit-5.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-02.isolatedStorage-1.tag-turck-batch-02-image-gated-final-cold-03.json`
- Final acceptance cold 04: `../../benchmark-report.manufacturer-turck.limit-5.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-02.isolatedStorage-1.tag-turck-batch-02-final-acceptance-cold-04.json`
- `npx tsc --noEmit`: passed.
- Focused quantity and document-enrichment suites: 216 tests passed. The broader device-type file had 116/120 passing; the four remaining failures concern unrelated Condition Monitoring and Limit Switch expectations, while the new linear/magnetic position-label case passes.
