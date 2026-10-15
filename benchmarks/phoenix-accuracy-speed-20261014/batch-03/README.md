# Phoenix Contact accuracy and speed batch 03

Five novel Phoenix Contact products across five further device types were scraped, compared with their exact official product pages, and rerun after shared parser/classifier repairs. The fixture set is `phoenix.json`; the final isolated cold report is `../../benchmark-report.manufacturer-phoenix.fixtureDir-benchmarks-phoenix-accuracy-speed-20261014-batch-03.isolatedStorage-1.tag-phoenix-batch-03-verified.json`.

## Results

- All five products passed exact identity, official PDP URL, device type, image, required normalized-field, and PDT audit checks. Wrong products: 0; unproven writes: 0; unexplained required-field issues: 0. Two controlled PDT enum skips remained blank.
- All five downloaded official product images were visually inspected and matched the listed item.
- Cold connector acquisition was 0.471–4.232 s/device (mean 1.311 s, median 0.560 s). A separate isolated cold rerun of 1118021 measured 0.963 s for the connector scrape. Full benchmark time was 1.786–38.290 s/device (mean 11.129 s, median 6.132 s); the larger total includes document work and exports.

## Products and verified source details

| Article | Type | Source details retained |
| --- | --- | --- |
| 2404267 | Programmable Logic Controller | AXC F 2152; 24 V DC nominal and 19.2–30 V DC supply range; 200 mA typical current consumption without I/O; 126.93 × 45 × 75 mm normalized H × W × D; IP20. [Exact PDP](https://www.phoenixcontact.com/en-us/products/controller-axc-f-2152-2404267) |
| 1650122 | HMI | WP 6156-WHPR; 24 V DC ±20%; front plate W × H × D = 410 × 287 × 66 mm (normalized H × W × D); 4,960 g net; IP66 front / IP20 rear; −30…65 °C. [Exact PDP](https://www.phoenixcontact.com/en-us/products/web-panel-wp-6156-whpr-1650122) |
| 2702233 | Communication Gateway | GW PL ETH/UNI-BUS; supply 19.2–30 V DC; maximum current consumption 63 mA at 24 V DC; 99 × 22.5 × 114.5 mm normalized H × W × D; 216.9 g net; IP20; −40…70 °C. [Exact PDP](https://www.phoenixcontact.com/en-us/products/gatewaysproxies-gw-pl-ethuni-bus-2702233) |
| 1532597 | Connector | VS-08-RJ45-5-Q/IP67 GP; 48 V nominal and 72 V rated under III/3; 1.75 A rated; 38.4 × 22.8 × 80 mm W × H × L (normalized H × W × L); 27.466 g net; IP67; −20…70 °C. [Exact PDP](https://www.phoenixcontact.com/en-us/products/rj45-connector-vs-08-rj45-5-q-ip67-bp-1532597) |
| 1118021 | Luminaire | PLD M 140 W 195/D35/SC; 24 V DC nominal, 22–26 V DC supply range; 0.208 A current consumption; 195 × 35 × 38.5 mm L × W × H (normalized H × W × L); 203 g net; IP54; 0…50 °C. [Exact PDP](https://www.phoenixcontact.com/en-us/products/light-pld-m-140-w-195d35sc-1118021) |

## Shared corrections

- Added Phoenix extraction for HMI PDPs that publish front-plate dimensions as a single `Width / Height / Depth` row and voltage as `Power supply unit`.
- Added shared type recognition for web panels and HART multiplexers, plus exact Phoenix family overrides for WP panels, GW PL gateways, and VS-08-RJ45 connectors (preventing a false `Optical Connector` classification).
- Phoenix supply voltage normalization now preserves both nominal and published range when both are present. It preserves nominal and rated contexts for the connector instead of collapsing 48 V nominal and 72 V rated into one value.
- Material/finish normalization now emits `Aluminum` and `natural anodized` without page-label fragments.

`npx tsc --noEmit` passed before the verified run. No test suite was run. The cross-project PDT sheet-coverage indicator is 5/41 and is not a batch acceptance gate. Phoenix has three accepted batches; continue with five more novel device types.
