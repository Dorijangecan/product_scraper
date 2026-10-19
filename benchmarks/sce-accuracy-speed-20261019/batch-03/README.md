# SCE batch 03 — consoles and mechanical accessories

Five previously unseen SCE SKUs were checked read-only against `run_items` and `product_aliases` (158 prior SCE runs; zero exact SKU or alias hits). Each item represents a different functional kind. Exact official pages and their SKU-linked images were checked; all five images were downloaded and visually inspected. The EXDLK kit image shows a parts set, consistent with SCE's linked mechanical-interlock installation guide, which says the kit includes the parts needed for installation.

| SKU | Product kind / accepted type | Key facts checked on exact SCE source |
| --- | --- | --- |
| `SCE-466019DC` | Dual-access console enclosure / Enclosure | 46.25 × 59.88 × 18.50 in; 240 lb shipping weight; 0.075 in carbon steel; ANSI-61 gray powder coat; NEMA 3R/12/13, UL and CSA listings, IP55; sloped top and enclosure features |
| `SCE-SAFC` | Fixed HMI suspension coupling / Suspension System Component | 1.85 × 5.08 × 5.08 in; 3 lb; cast-aluminum coupling; fixed-position mounting base; the PDP cautions that this is not for use on an HMI enclosure |
| `SCE-ELJHINGE` | ELJ hinge / Hinge | One piece; 2 × 2 × 0.75 in; 0.04 lb; standard SCE enclosure hinge component |
| `SCE-LPD2` | Four leveling pads / Leveling Foot | 6 × 4 × 3 in; 1 lb; zinc-plated pads with plastic bases; mounting hardware included |
| `SCE-EXDLK` | Left-disconnect mechanical interlock kit / Mechanical Interlock Kit | 22 × 6 × 6 in; 7.8 lb; for EXD enclosures with left disconnect handle; interlocks the main and external disconnect enclosure while powered |

## First-run problems and reusable fixes

The first cold scrape found all five pages and exact SKU-linked images, but classified only one device correctly (20%). The console enclosure was demoted to `Cover / Door Accessory` because its title mentioned two doors; the fixed coupling and leveling pads were `unknown` because their descriptions did not match the classifier's noun order or singular-only patterns; and EXDLK was classified as an `Enclosure` because its interlock description also mentioned enclosures. Two source-fact checks failed because fixture patterns treated literal parentheses as regex syntax. The scraper also reduced the leveling-pad material to only `zinc`, losing the explicitly stated plastic base.

Reusable changes:

- Added shared rules for console enclosures, reversed/plural leveling-pad wording, and fixed suspension couplings; those rules produce the functional device classes ahead of generic door/enclosure fallback terms.
- Added `Suspension System Component` and `Mechanical Interlock Kit` PDT profiles. Both route passive hardware to `cabinet.mechanical` and carry no electrical-field requirements.
- Kept enclosure consoles in the enclosure profile even when the exact title includes door-count/access phrasing.
- Preserved SCE's exact “zinc plated with a plastic base” fact as `zinc-plated with plastic base` in normalized material, with a unit test to prevent the base from being dropped again.
- Fixed literal-parenthesis fixture patterns so source checks verify the actual SKU description.

The exact EXDLK page links the official [mechanical interlock installation guide](https://www.saginawcontrol.com/instman/mech-interlock.pdf). The quality-mode benchmark intentionally downloads images only after an exact SCE page already satisfies its data gate, so the manual remains a linked source and was checked independently; its installation diagram is not treated as a catalog-specification field.

## Measurements

“Core” is connector scrape time; “full item” includes document/image work and workbook/PDT export. The first cold run's printed full-item times were 4.856, 2.261, 2.269, 2.490 and 1.886 s. It found 100% of products, but reached only 20% device-type accuracy and 60% expected-source-fact coverage. Its first-run benchmark report was replaced by a later untagged diagnostic run, so the initial per-item core timings are not available and are not estimated here.

| Run | Found / official PDP / image | Device type | Expected source facts | Expected normalized fields and values | PDT audit | Core mean / range | Full-item mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Repair cold 02 | 100% | 100% | 100% | 100% | 100% | 0.997 s / 0.766–1.793 s | 2.747 s |
| Accepted cold 01 | 100% | 100% | 100% | 100% | 100% | 0.976 s / 0.757–1.769 s | 2.826 s |
| Accepted cold 02 | 100% | 100% | 100% | 100% | 100% | 1.068 s / 0.776–1.737 s | 2.901 s |

Every connector scrape in all three accepted-quality runs stayed below the 2.5 s/device target. Full-item wall time sometimes exceeds 2.5 s because it includes network requests and workbook/PDT export. The two final independent cold runs had no wrong products and no unproven PDT writes. Three PDT enum values were skipped because the template had no proven matching enum; no substitute values were guessed. The batch exercises two of 41 PDT sheets, so its acceptance is limited to these five SKUs.

## Reports

- [Repair cold 01](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-03.isolatedStorage-1.tag-sce-batch-03-repair-cold-01.json)
- [Repair cold 02](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-03.isolatedStorage-1.tag-sce-batch-03-repair-cold-02.json)
- [Accepted cold 01](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-03.isolatedStorage-1.tag-sce-batch-03-final-cold-01.json)
- [Accepted cold 02](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-03.isolatedStorage-1.tag-sce-batch-03-final-cold-02.json)

## Exact official product sources

- [SCE-466019DC](https://www.saginawcontrol.com/partnumber_info/?n=SCE-466019DC)
- [SCE-SAFC](https://www.saginawcontrol.com/partnumber_info/?n=SCE-SAFC)
- [SCE-ELJHINGE](https://www.saginawcontrol.com/partnumber_info/?n=SCE-ELJHINGE)
- [SCE-LPD2](https://www.saginawcontrol.com/partnumber_info/?n=SCE-LPD2)
- [SCE-EXDLK](https://www.saginawcontrol.com/partnumber_info/?n=SCE-EXDLK)
