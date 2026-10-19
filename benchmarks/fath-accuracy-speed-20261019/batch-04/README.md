# FATH accuracy and speed — batch 04

Status: **accepted for all five new device types** in [`fath.json`](fath.json). Both final isolated cold runs passed exact product identity, official PDP, device type, normalized weight/material, required source facts, exact-SKU image and PDT audit gates. No wrong products or unproven PDT writes were reported.

## What failed and why

The first cold run found all five exact official pages and downloaded their SKU-specific images, but classified all five devices as `unknown`. It only normalized weight/material for three of five and matched source facts for three of five. The issue came from several source/parser assumptions:

1. These are workstation products rather than common enclosure hardware, and the shared classifier had no functional types for bottle holders, tool trays, broom holders, bag cutters or monitor mounts.
2. FATH publishes composite material lists that can exceed 240 characters. The scraper treated the length as page noise, silently dropping the exact `Material` field for three products.
3. The monitor-mount variant table appends a `New` badge next to the linked part number. The parser compared the entire cell text to the SKU, so it discarded the exact variant row and missed `Fmax = 42 N` and slot 8/10.
4. With the bag cutter unclassified, the quality gate incorrectly applied an electrical voltage/current requirement and launched generic discovery. Its initial end-to-end item time was 124.6 seconds; the fallback also contributed unrelated material (`Aluminum`) to the merged result. A type-based mechanical classification removed that irrelevant retry path.

## General repairs

- Added type-based classification and mechanical PDT routing for Bottle Holder, Tool Tray, Broom Holder, Bag Cutter and Monitor Mount.
- Kept long, multi-component FATH `Material` and `Surface` values up to 1,500 characters while retaining the 240-character limit for other free-form fields.
- Matched selected FATH variants by the exact linked SKU in the part-number cell, even when Shopware appends a localized status badge such as `New`.
- Added connector regression coverage for bold field labels, long material lists, sibling-variant isolation and the status badge.

No SKU-specific rules were added. These rules use product type, source field, exact linked identity and the manufacturer's shared page structure.

## Accepted articles and official source facts

| Article | Device type | Official PDP | Verified source facts |
|---|---|---|---|
| 6TM840ND100S01 | Bottle Holder | [FATH PDP](https://www.fath24.com/en/Bottle-Holder-FX-for-Profiles-40-45-Slot-8-10/6TM840ND100S01) | 360° turnable, slot 8/10, PA glass-ball-reinforced holder, SS304 wire, 186.2 g |
| 6TM840NV12591S01 | Tool Tray | [FATH PDP](https://www.fath24.com/en/Tool-Tray-PARABOL-FX-for-Profiles-40-45-Slot-8-10-Set/6TM840NV12591S01) | 360° turnable, five-way tilt adjustment, suited to heavy tools/nutrunners, PA/TPE materials, set of two, 226 g |
| 6TM840NX2030S01 | Broom Holder | [FATH PDP](https://www.fath24.com/en/Broom-Holder-FLEX-FX-20-30-for-Profiles-40-45-Slot-8-10/6TM840NX2030S01) | Holds tools with Ø20–30 mm, 360° turnable, PA holder and TPE retaining strap, 113 g |
| 6TM840NF91S01 | Bag Cutter | [FATH PDP](https://www.fath24.com/en/Bag-Cutter-FX-for-Profiles-40-45-Slot-8-10/6TM840NF91S01) | Replaceable trapezoidal blade, 360° turnable, carbon-steel blade, slot 8/10, 98.2 g |
| 6TM840FR7510091 | Monitor Mount | [FATH PDP](https://www.fath24.com/en/Monitor-Mount-FX-for-Profiles-40-45-Slot-8-10/6TM840FR7510091) | VESA MIS-D 75/100, horizontal/vertical adjustment, 360° rotation, Fmax 42 N, 325 g |

The five downloaded image filenames contain the exact requested SKU, and each image was visually inspected against its listed product.

## Before and after

| Run | Type / normalized fields / source facts | Core scrape | Full per-item pipeline |
|---|---|---:|---:|
| First cold 01 | 0% / 60% / 60%; not accepted | 567–987 ms (mean 681 ms) | 1.4–124.6 s (mean 26.4 s) |
| Final cold 04 | 100% / 100% / 100%; 5/5 accepted | 366–810 ms (mean 463 ms) | 1.2–2.0 s (mean 1.397 s) |
| Final cold 05 | 100% / 100% / 100%; 5/5 accepted | 345–774 ms (mean 456 ms) | 1.2–1.9 s (mean 1.381 s) |

The core scraper is far below the 2.5 s/device target, and every complete per-item pipeline time in both accepted runs is also below 2.5 s. The first-run 124.6 s fallback outlier is now 1.2–1.3 s end to end for the same bag cutter.

Fixture-wide PDT sheet coverage is reported separately as 1/41 because this five-item batch covers only the mechanical profile; all per-item PDT audits passed.

Reports:

- Initial failure: [`first-cold-01`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-04.isolatedStorage-1.tag-fath-batch-04-first-cold-01.json)
- After type/material fixes, before variant-row repair: [`repair-cold-03`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-04.isolatedStorage-1.tag-fath-batch-04-repair-cold-03.json)
- Accepted cold run: [`final-cold-04`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-04.isolatedStorage-1.tag-fath-batch-04-final-cold-04.json)
- Accepted repeat cold run: [`final-cold-05`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-04.isolatedStorage-1.tag-fath-batch-04-final-cold-05.json)
