# Phoenix Contact batch 04

Status: accepted after exact-PDP review, one repair iteration, image review, and final cold isolated run.

## Novelty and sample

The five catalog numbers were checked against prior Phoenix benchmark manifests, scraper database run history, product aliases, and page cache. No prior product/run/alias/cache match was found.

| Catalog number | Device type | Exact official product page |
| --- | --- | --- |
| 2320225 | UPS | [QUINT-UPS/24DC/24DC/10](https://www.phoenixcontact.com/en-us/products/uninterruptible-power-supply-quint-ups-24dc-24dc10-2320225) |
| 1460923 | Battery | [UPS-BAT/LI/24DC/284WH](https://www.phoenixcontact.com/en-us/products/battery-module-ups-bat-li-24dc-284wh-1460923) |
| 1438137 | PCB Terminal Block | [LPT 6/12-7,5-ZB](https://www.phoenixcontact.com/en-us/products/pcb-terminal-block-lpt-6-12-75-zb-1438137) |
| 1533232 | Safety Sensor | [PSR-MIS-C-S-NONO-M8-4P](https://www.phoenixcontact.com/en-us/products/safety-switch-sensor-psr-mis-c-s-nono-m8-4p-1533232) |
| 2909555 | Motor Starter | [ELR H3-IES-PT-24DC/500AC-9-P](https://www.phoenixcontact.com/en-us/products/hybrid-motor-starter-elr-h3-ies-pt-24dc500ac-9-p-2909555) |

## Per-product review

- **2320225 UPS:** 24 V DC input and output, 18–30 V DC input range, 10 A output, 130 × 35 × 125 mm, 513 g, IP20, and −25…70 °C operation. The normalized voltage keeps input, input range, and output distinct.
- **1460923 Battery:** 24 V DC nominal, 28.4 V DC end-of-charge, 284 Wh (the PDP also specifies 11.1 Ah), 45 A maximum output with derating to 40 A at −20…0 °C and 35 A at 50…60 °C, IP20, −20…60 °C discharge range, 199 × 197 × 119 mm, 4,608 g. Charge temperature is separate and was not substituted for discharge temperature.
- **1438137 PCB terminal block:** 41 A nominal current, 1000 V nominal voltage, 7.5 mm pitch, 12 positions, 27.85 × 91 × 24.3 mm, and 2.2 g net weight. The incorrect 40 A row from generic electrical text no longer overrides the exact nominal-current row.
- **1533232 Safety Sensor:** 2 N/O contacts, 0…28.8 V DC SELV/PELV, 0…100 mA, 28.1 mm diameter × 37 mm depth, 32 g, and −25…75 °C operation. IP65 is retained with the source condition that it applies with a suitable mating connector; rated insulation voltage is not treated as operating voltage.
- **2909555 Motor Starter:** motor output up to 9 A; 24 V DC control supply (19.2…30 V DC range, 60 mA control current); 500 V AC motor circuit; 107.5 × 22.5 × 114 mm, 306 g, IP20, and −25…70 °C operation. Control-circuit and motor-circuit ratings remain separate.

All five downloaded images were visually inspected and match their catalog items: `PHX.2320225.png`, `PHX.1460923.png`, `PHX.1438137.png`, `PHX.1533232.png`, and `PHX.2909555.png` in the final run output folder.

## Repairs

- Added explicit Phoenix UPS and ELR hybrid motor-starter type rules. The `UPS-BAT` title collision now resolves as Battery because the specific battery-module wording outranks the generic UPS token.
- Added contextual Phoenix PDP extraction for sensor voltage/current maxima, battery nominal voltage/capacity/output-current derating, and motor-starter control supply and motor output current.
- Kept UPS input range separate from its 24 V input/output; preserved battery nominal/end-of-charge and battery discharge conditions; selected PCB nominal current; and prevented the sensor's insulation rating from replacing its operating range.
- Added the safety sensor diameter to normalized dimensions and preserved its conditional IP rating.

## Verification and timing

- Final run: [`benchmark-report.manufacturer-phoenix.fixtureDir-benchmarks-phoenix-accuracy-speed-20261014-batch-04.isolatedStorage-1.tag-phoenix-batch-04-accepted.json`](../../benchmark-report.manufacturer-phoenix.fixtureDir-benchmarks-phoenix-accuracy-speed-20261014-batch-04.isolatedStorage-1.tag-phoenix-batch-04-accepted.json)
- `npx tsc --noEmit`: passed.
- Found, exact official URL, expected documents, device type, required normalized fields, and PDT audit: 5/5 each. Wrong products: 0. Unproven PDT writes and unexplained required-field issues: 0. Eleven controlled-enum values remained blank for review.
- Cold connector acquisition: 0.518–0.954 seconds/device; mean 0.693, median 0.683, maximum 0.954. Every device met the 2.5-second target.
- Complete benchmark time, including document and PDT processing: 4.356–17.563 seconds/device; mean 9.219, median 7.617, maximum 17.563. This broader time is reported separately from device acquisition.

Batch 04 completes Phoenix Contact's fourth accepted batch (20 products total). The next manufacturer can now begin.
