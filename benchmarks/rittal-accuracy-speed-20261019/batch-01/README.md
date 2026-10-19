# Rittal accuracy and speed — batch 01

Validated the first five new Rittal device types against the exact official variant PDPs. The cold runs use isolated storage so prior page/document caches do not improve the measured times.

## Products and official evidence

| SKU | Device type | Exact official product page |
| --- | --- | --- |
| 3244700 | Filter Fan | [Rittal 3244700](https://www.rittal.com/com-en/products/PG20231215KLI101/PG20231215KLI102/PG20240718KLI001/PRO136517?variantId=3244700) |
| 7859000 | Luminaire | [Rittal 7859000](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240403ZUB001/PRO71035?variantId=7859000) |
| 3105320 | Heater | [Rittal 3105320](https://www.rittal.com/com-en/products/PG20231215KLI101/PG20231215KLI1007/PRO0307?variantId=3105320) |
| 9635000 | Busbar | [Rittal 9635000](https://www.rittal.com/us-en_US/products/PG20231215POW101/PG20240417STR201/PG20240418STR201/PRO69235?variantId=9635000) |
| 1180000 | Enclosure | [Rittal 1180000](https://www.rittal.com/com-en/products/PG20231215SCH101/PG20231512SCH301/PRO70743?variantId=1180000) |

The batch manifest is `rittal.json`. The Rittal PDP exposes the technical specifications and document URLs. When its exact SKU, dimensions, type-specific fields, weight, protection rating, and official image are all verified, the run now downloads the image only; linked PDF URLs remain in the product evidence. This avoids downloading many duplicate language/regional manuals and datasheets whose fields are already on the exact PDP.

## Before and after

| Measure | Initial cold run | Accepted cold 03 | Accepted cold 04 |
| --- | ---: | ---: | ---: |
| Found / exact official URL | 5/5 / 5/5 | 5/5 / 5/5 | 5/5 / 5/5 |
| Correct device types | 3/5 (60%) | 5/5 (100%) | 5/5 (100%) |
| Expected normalized fields | 3/5 (60%) | 5/5 (100%) | 5/5 (100%) |
| Expected exact source attributes | 4/5 (80%) | 5/5 (100%) | 5/5 (100%) |
| Required saved evidence | 4/5 (80%) | 5/5 (100%) | 5/5 (100%) |
| PDT item audit | 5/5 | 5/5 | 5/5 |
| Wrong products / unproven PDT writes | 0 / 0 | 0 / 0 | 0 / 0 |
| Full item time, average / maximum | 18.22 s / 49.72 s | 2.06 s / 2.76 s | 2.28 s / 3.21 s |
| Core connector scrape, average / maximum | 0.89 s / 1.30 s | 0.78 s / 1.18 s | 0.80 s / 1.33 s |

The average full item time improved by about 88% on the two final accepted cold runs. Core scraping is below the 2.5-second target for all five products. The full item average is also below 2.5 seconds; the filter fan's full item time varies above that mark because image retrieval and workbook/PDT work are included in that broader timer.

## Findings and scraper changes

- The exact filter-fan PDP describes the exterior as `WHD 323 x 323 x 156 mm`; a generic axis matcher had mistaken 136 mm installation depth for the product depth. The normalizer now prefers the exact `Depth` axis and retains 323 × 323 × 156 mm.
- Rittal technical lists may place one `<dt>` label before multiple `<dd>` values. The generic parser previously kept only the first value. It now joins all adjacent values for Rittal labels, preserving the filter fan's IP/NEMA variants and the enclosure's NEMA 1/3R/4/12 ratings.
- Fan current values are normalized as `0.51 A; 0.68 A`; the RiLine board's primary current remains 125 A while the separate 100 A UL rating remains in source attributes.
- The exact enclosure body thickness is 1.5 mm; the 2 mm door and 2.5 mm mounting plate values no longer override it.
- The RiLine material list is normalized as `Polyamide; Polycarbonate; E-Cu`, and the enclosure's exact primary material is `Sheet steel`.
- The IT LED system light is classified as `Luminaire`. Its exact PDP does not publish rated voltage or current, so those fields remain blank rather than being inferred from linked documents.
- The document fast path now recognizes Rittal's actual PDP evidence patterns, including WHD product descriptions and separate Height/Width/Depth rows. It is gated by exact SKU URL, passed identity/quality checks, official source attributes for required type-specific facts, and the exact PDP image.

## Learned source locations

- **Filter fan:** `Product description` contains the exact external WHD envelope; `Rated operating voltage` and `Rated current` carry electrical ratings; multiple IP/NEMA variants are repeated `<dd>` rows under one protection label; `Net weight` is the product weight.
- **IT luminaire:** `Luminous flux`, `Light color`, `IP protection category`, `Material`, `Dimensions` (Width/Height/Depth), and `Net weight` hold the page-backed requirements. The PDP's explicit `Rated operating voltage: null` yields no normalized voltage or current.
- **Enclosure heater:** `Continuous thermal output at 10 °C`, `Rated operating voltage`, `IP protection category`, `Dimensions`, `Material`, and `Net weight` give the exact heater facts; the installation fuse is not its operating current.
- **RiLine board:** use `Rated current max.` for the primary current; keep `Rated current (UL)` as a separate application-specific rating. `Rated operating voltage` and `Material` each contain multiple `<dd>` rows; the primary page reports polyamide, polycarbonate, and E-Cu.
- **AX enclosure:** use `Basic material` for the base substrate; `Material thickness - enclosure` is the enclosure-body wall, while `Material thickness - door` and mounting-plate thickness are separate. `Protection category NEMA` and IP/IK labels contain multiple exact PDP rows.

## Verification

- Accepted cold runs: `...tag-rittal-batch-01-accepted-cold-04.json` and `...tag-rittal-batch-01-accepted-cold-05.json`.
- Targeted regression suite: `npx vitest run tests/rittal.test.ts tests/run-manager.test.ts` — 71/71 passed.
- Type check: `npx tsc --noEmit` — passed.

Batch 01 is accepted. Continue with five new Rittal device types, repeat source/value verification, and optimize that batch before moving to another manufacturer.
