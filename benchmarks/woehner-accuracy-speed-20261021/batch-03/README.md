# Wöhner accuracy and speed, batch 03

Five previously unused official PIM articles: a CrossBoard 10 A AC/DC supply, a 10 × 85 cylindrical fuse holder, two longitudinal busbar terminals, and a universal 3-pole busbar support.

## Final acceptance

`batch-03-final-accuracy` passed all five articles for identity, official URL, type, expected normalized fields, expected exact-page attributes, document presence, and PDT audit. No wrong products or unproven writes. It was repeated after the corrections; the logged run and report are linked below.

| SKU | Type | Exact-page facts | Normalized evidence / documents |
| --- | --- | --- | --- |
| `36200 000A` | Power Supply | [PIM 1000188049](https://pim.woehner.de/EN/EN/marketing/1000188049): BROOME10 CrossBoard; 10 A; 380–480 V AC input / 24 V DC output; EAN 4021267362003. | 45 × 160 × 130 mm; 71.8 kg/100; IP30. Operation and installation instructions, 3D PDF/STP, DXF, dimensioned drawing, EU declaration. |
| `31555 000` | Fuse Holder | [PIM 1000051417](https://pim.woehner.de/EN/EN/Panel_fuse_bases_for_panel_mounted/Fuse_holders_for_cylindrical_fuses_according_to_IEC_EN/holder_for_cylindrical_fuses_10_x_85/1000051417): SECUR Panel; 10 × 85 / 1P; 32 A; 1500 V DC; EAN 4021267315559. IEC normalized voltage is separately 1000 V AC. | 22.5 × 130 × 65 mm; 9.2 kg/100; IP20; −25 °C minimum. 3D PDF/STP, DXF, dimensioned drawing, EU declaration. The “installation only above −5 °C” threshold is not stored as a maximum operating temperature. |
| `01202 000` | Busbar | [PIM 1000045644](https://pim.woehner.de/EN/EN/System/60Classic_630_A_%28800_A%29_2500_A/Connection_technology_and_covers/terminal_300_mm/1000045644): longitudinal terminal for 150–300 mm² cables and 25 × 5 mm busbars; 690 V AC; 13.4 kg/100; EAN 4021267012021. | 3D PDF/STP, DXF, dimensioned drawing, EU declaration. Unsupported normalized current/material fields stay blank. |
| `01500 000` | Busbar | [PIM 1000043905](https://pim.woehner.de/EN/EN/System/60Classic_630_A_%28800_A%29_2500_A/Busbar_supports_busbars_and_covers/3-pole_60mm_System_classic/1000043905): universal 3-pole support with external mounting holes; 12, 15, 20, 25, 30 × 5/10 mm busbars; 800 V AC; EAN 4021267015008. | 20 × 215 × 50 mm; 13.7 kg/100. 3D PDF/STP, DXF, dimensioned drawing, EU declaration. |
| `01201 000` | Busbar | [PIM 1000045593](https://pim.woehner.de/EN/EN/System/60Classic_630_A_%28800_A%29_2500_A/Connection_technology_and_covers/terminal_240_mm/1000045593): longitudinal terminal for 120–240 mm² cables and 20 × 5/10 mm busbars; 690 V AC; 11.0 kg/100; EAN 4021267012014. | 3D PDF/STP, DXF, dimensioned drawing, EU declaration. Unsupported normalized current/material fields stay blank. |

Image candidates are not counted as verified because these PIM pages warn that the picture may show a similar product. Document labels and exact article download URLs are retained; this benchmark checks link presence, not file contents.

## Repairs learned

- Added an exact-title `Fuse Holder` classification for “holder for cylindrical fuses”; it previously fell through to `Mounting Accessory`.
- Corrected the expected BROOME10 input voltage pattern to the published 380–480 V AC range while preserving 24 V DC output.
- Removed the incorrect 1500 V DC requirement from normalized voltage for 31555: normalized IEC AC voltage is 1000 V, while 1500 V DC remains in exact-page source attributes.
- Suppressed `operatingTemperatureMax` when an ambient-temperature note contains only an installation threshold (“installation only at temperatures > …”). The exact source supports −25 °C minimum, not −5 °C maximum.
- Kept unsupported busbar terminal current/material fields blank and retained exact article sources for all positive normalized fields.

## Comparable timing

| Run | Accuracy | Core scrape per SKU | Mean |
| --- | --- | --- | ---: |
| Initial, before corrections | 3/5 type and normalized checks | 6.869, 3.409, 2.705, 2.534, 2.559 s | 3.615 s |
| Final rerun | 5/5 accepted | 6.665, 2.983, 2.513, 2.428, 2.772 s | 3.472 s; warm mean 2.674 s |

Warm items are close to the 2.5 s goal; the cold first product remains slower. Timing values use report `scrapeElapsedMs` and exclude the separate PDT export. No further speed-only change was made after acceptance; preserve the identity and exact-article checks.

## Reports

- [Initial batch](../../benchmark-report.fixtureDir-benchmarks-woehner-accuracy-speed-20261021-batch-03.isolatedStorage-1.json)
- [Final accuracy rerun](../../benchmark-report.fixtureDir-benchmarks-woehner-accuracy-speed-20261021-batch-03.isolatedStorage-1.tag-batch-03-final-accuracy.json)
