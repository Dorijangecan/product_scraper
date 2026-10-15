# ETA batch 01: accuracy and speed

Batch manifest: `eta.json` (five distinct device types: overload relay, relay, communication gateway, power distribution unit, and power entry module).

## First cold run

Report tag: `eta-batch-01-direct-pdp-fastpath-cold-01`.

- Quality accepted: **no (3/5 reported as accepted; 0 wrong products)**.
- The accepted rows took 8.272 s (`2-6500`), 8.306 s (`E-1072-100`), and 13.465 s (`CPC12`).
- Manual image review found that the `CPC12` fixture was ambiguous: the image showed the orderable variant `CPC12PN`. The fixture was corrected to that exact catalog number and its exact product image and datasheet were checked.
- `SCS1000-16HS` and `X3130` failed. The first official SCS page named only the SCS1000 family; the X3130 result did not provide enough exact source evidence.

## Final cold batch after repairs and speed tuning

Report tag: `eta-batch01-post-throttle-optimization-cold-01`.

| Catalog number | Type | Official product page | Verified normalized ratings | Scrape time | Quality |
|---|---|---|---|---:|---|
| `2-6500` | Overload Relay | [ETA 2-6500](https://global.e-t-a.com/products/circuit_protection_devices/thermal_overcurrent_circuit_breakers/p/2_6500/) | 250 V AC / 28 V DC; 0.2–10 A | 1.984 s | Accepted |
| `E-1072-100` | Relay | [ETA E-1072-100](https://global.e-t-a.com/products/relays_ssrpcs/solid_state_remote_power_controllers/p/e_1072_100/) | 19.2–36 V DC; 3 A | 1.729 s | Accepted |
| `CPC12PN` | Communication Gateway | [ETA CPC12](https://global.e-t-a.com/products/power_distribution_systems/intelligent_power_distribution_systems/controlplex_overview/controlplex_dinrail/bus_controllers/p/cpc12/) | 18–30 V DC (24 V); 40 A | 2.637 s | Accepted |
| `SCS1000-16HS` | Power Distribution Unit | [ETA SCS1000](https://global.e-t-a.com/products/power_distribution_systems/intelligent_power_distribution_systems/scsr_smart_control_systems/scsr_smart_control_systems_products/p/scs1000/) | 12/24 V DC; 160 A total; 16 outputs, IP67 | 0.009 s | Accepted |
| `X3130` | Power Entry Module | [ETA X3130](https://global.e-t-a.com/products/circuit_protection_devices_thermal_thermal_magnetic_magnetic_high_performance_electronic/power_entry_modules/p/x3130/) | 250 V AC; 10 A | 2.552 s | Accepted |

The five cold rows passed exact identity, official URL, required document, expected normalized field, expected attribute, device type, and PDT checks. No wrong products were reported. The scrape-phase average was **1.782 s/device**. Independent cold repeats were 2.091 s for `CPC12PN` and 1.877 s for `X3130`; their two-run medians with the full batch were 2.364 s and 2.215 s, respectively. The 2.5 s target is the report's `scrapeElapsedMs` metric; whole benchmark item time also includes document processing and workbook/PDT export.

All five downloaded images were visually checked against the product. The CPC image visibly identifies `CPC12PN`; the SCS image is the official SCS1000 product image from its family page. The exact SCS1000-16HS identity, ratings, and mechanical attributes are supported by the [official ETA datasheet](https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/int_Stromverteilung/Smart_Control_System_SCS/2_en/D_SCS1000_en.pdf). It distinguishes rated 12/24 V from the 9–32 V input range. For X3130, the exact product page's 10 A rating wins over the broader 3130-family breaker range; terminal blade size and panel cutout thickness are not normalized as product dimensions.

## Repairs recorded

- Added exact official ETA PDP routes with bounded fetches and no broad retry when the learned route cannot prove the requested catalog number.
- Filtered CPC12 variant documents to the requested EC/EN/MB/PN model.
- Added the exact SCS1000-16HS datasheet mapping because the PDP names only the family; kept the official family image attached to that PDP.
- Preferenced exact ETA PDP voltage/current over broader family PDF values, and kept SCS rated voltage separate from input range.
- Prevented terminal and panel-mount cutout measurements from becoming X3130 product dimensions or wall thickness.
- Reduced ETA's per-host request interval from 1.5 s to 1.0 s after the accuracy batch passed; final cold accuracy stayed 5/5.

## Verification

- Focused ETA/manufacturer and normalizer tests: **6 passed**.
- `npx tsc --noEmit`: passed.
- Full Vitest suite: **2,595 passed, 42 failed** across 9 files. The failures concern existing non-ETA device-type, Saginaw precision, Eaton voltage, PDT, and connector expectations; the focused ETA tests passed.
