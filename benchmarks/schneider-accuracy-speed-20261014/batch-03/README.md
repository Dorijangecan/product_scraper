# Schneider Electric accuracy and speed batch 03

## Scope and acceptance

Five previously unprocessed Schneider products from different device types were checked in isolated cold runs:

| Catalog number | Device type | Exact official product page |
| --- | --- | --- |
| `XPSMCMCP0802` | Safety controller | https://www.se.com/us/en/product/XPSMCMCP0802/safety-controller-modicon-mcm-8-inputs-2-outputs-monitors-expansion-modules-screw/ |
| `BMXNOC0401` | Ethernet communication module | https://www.se.com/us/en/product/BMXNOC0401/network-module-modicon-m340-ethernet-ip-and-modbus-tcp-4-x-rj45/ |
| `LXM32AD18M2` | Servo drive | https://www.se.com/us/en/product/LXM32AD18M2/motion-servo-drive-lexium-32-18a-single-phase-supply-voltage-115-to-230v-0-5-to-1kw-ip20/ |
| `XMLR010G0T26` | Pressure transmitter | https://telemecaniquesensors.com/global/en/product/reference/XMLR010G0T26 |
| `TM3DI16K` | Discrete input module | https://www.se.com/us/en/product/TM3DI16K/discrete-input-module-modicon-tm3-16-inputs-he10-24v-dc/ |

Novelty was checked against Schneider fixtures/reports, aliases, run history, and cached product URLs before selection. The initial report is `../../benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-03.isolatedStorage-1.tag-schneider-batch-03-initial.json`.

## Product review and shared repairs

- `XPSMCMCP0802`: the exact page and product documents identify a 24 VDC modular safety controller CPU with 8 safety inputs and 2 OSSD output pairs. The shared type classifier now distinguishes an exact safety-controller CPU from a safety relay and routes it to the PLC sheet. The 400 mA OSSD channel rating is not device supply current, and an IP54 cabinet-clearance sentence and USB cable length in the manual are not the controller's protection or dimensions. Exact PDP dimensions, mass, and IP20 are retained.
- `BMXNOC0401`: the exact M340 module has four RJ45 10/100 ports, Modbus TCP and EtherNet/IP services, and draws 555 mA at 3.3 V from the rack. A shared type rule now recognizes an Ethernet TCP/IP network module as a communication gateway instead of a PLC CPU.
- `LXM32AD18M2`: the official product description provides both 100–120 V and 200–240 V single-phase input ranges. Both are kept in normalized voltage. The 6 A continuous output current is distinct from the 18 A peak rating. The official description's 1.8 kg product mass overrides a sustainability carbon-footprint value that had been mistaken for weight.
- `XMLR010G0T26`: the exact Telemecanique product page supplies 10 bar range, 24 VDC SELV (17–33 V), consumption up to 50 mA, 4–20 mA analog output, 1/4-18 NPT female process connection, M12 4-pin connector, and IP65/IP67 ratings. The `XMLR` family now starts at its canonical Telemecanique URL.
- `TM3DI16K`: this is a 16-channel input module with 24 VDC signal inputs and internal bus power. Its signal voltage is not normalized as device supply voltage; 34 mA at 5 VDC remains the module's bus current consumption. The official PDP and extracted packing table conflict on mass (0.65 kg net versus 179 g package weight), so normalized weight is left blank.

All five downloaded images were visually checked against the exact catalog numbers. The XPS image is a rear view, but it is the exact safety-controller CPU rather than a related device. The Telemecanique sensor image shows the exact XMLR pressure transmitter.

## Before and after

The initial cold run found all five exact official products and documents, but only 3/5 device types and 2/5 expected normalized-field sets passed the final fixture checks. Both final cold runs pass all accuracy gates:

| Metric | Initial | Final cold 03 | Final cold 04 |
| --- | ---: | ---: | ---: |
| Found / exact official URL / documents | 100% / 100% / 100% | 100% / 100% / 100% | 100% / 100% / 100% |
| Device type / expected normalized fields / expected attributes | 60% / 40% / 100%* | 100% / 100% / 100% | 100% / 100% / 100% |
| Core scrape per-device mean | 3.236 s | 0.585 s | 0.581 s |
| Core scrape median / maximum | 3.465 / 4.595 s | 0.474 / 1.050 s | 0.441 / 1.083 s |
| Full benchmark per-device mean | See initial report | 12.433 s | 11.349 s |
| Full benchmark median / maximum | See initial report | 13.012 / 17.027 s | 12.090 / 15.935 s |

*The initial expected-attribute rate shown here is recomputed against the final, evidence-backed attribute patterns; the original initial report used earlier overly narrow patterns and reported 0%. Core scrape mean improved by about 82%. Every product was below the 2.5-second core target on both final cold runs. Full benchmark time, which includes document/PDT/export work, is reported separately.

Both final reports show zero wrong products, zero unproven PDT writes, and zero unexplained required-field issues. Twelve PDT controlled-enum values remain blank because the available values do not prove a valid enum mapping.

## Verification and report files

- Targeted regression tests: 8 passed, including device type, current/voltage context, exact-description dimensions/protection, carbon footprint exclusion, and conflicting package mass.
- `npx tsc --noEmit` passed.
- A broader run of `tests/device-type.test.ts`, `tests/field-candidates.test.ts`, and `tests/parsers.test.ts` earlier in the repair cycle had unrelated legacy failures; it is not claimed fully green.
- Final cold 03: `../../benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-03.isolatedStorage-1.tag-schneider-batch-03-final-cold-03.json`
- Final cold 04: `../../benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-03.isolatedStorage-1.tag-schneider-batch-03-final-cold-04.json`

**Status: accepted.** Continue with five new Schneider device types for batch 04.
