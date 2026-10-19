# SCE batch 04 — cabinet components and thermal management

Five cold SKUs with zero prior SCE run or alias matches were checked against their exact official SCE product pages. Each is a different product type, and each page's exact SKU image was downloaded and inspected.

| SKU | Product type | Exact-source facts checked |
| --- | --- | --- |
| `SCE-GP08` | Gland Plate | IMS plate; 10 × 11 × 0.25 in; 2 lb; cable-entry cutouts; removable plate; oil/water-resistant gasket; RAL 7035 |
| `SCE-P010605` | Plinth Base | Bolt-together IMS base; 3.94 × 23.62 × 18 in; 26 lb; black textured powder coat; stackable; cable entry from below |
| `SCE-KBH` | Keyboard Housing | 7 × 21.91 × 22.38 in; 35 lb; keyboard shelf with slides; powder-coated white |
| `SCE-WSCC` | Control Compartment | 8 × 24.25 × 14.5 in; 23 lb; sloped 20°; carbon-steel version distinguished from the stainless-steel option |
| `SCE-FA66` | Fan Assembly | 7.61 × 8.88 × 3.75 in; 4 lb; exact model manual confirms 185 CFM, 31 W, 115 V/60 Hz, 0.25 A rated current, and 0.43 A locked-rotor current |

## What was wrong and how the scraper learned it

The initial cold scrape misclassified the gland plate as a cable gland, did not recognize the plinth base, keyboard housing, or control compartment, and did not classify the fan housing as a fan assembly. It also required electrical ratings from passive cabinet parts and did not require current for a fan. The generic thermal-management class therefore failed to trigger the exact fan-package manual.

Reusable repairs add high-specificity type rules for those five types, passive mechanical PDT profiles for the four cabinet parts, and an air-conditioning profile for the fan with voltage and current requirements. The fan manual parser matches the exact SCE model row, distinguishes rated current from locked-rotor current, and supports both observed manual table layouts. A targeted exact-manual path avoids running the broad PDF mining pipeline when this document is encountered.

The fan manual is [SCE's official Fan & Grille Kit guide](https://www.saginawcontrol.com/instman/fan-and-grille-kit.pdf). Ratings are taken from the exact `FA66` row; the locked-rotor value is preserved separately and is not mistaken for operating current.

## Measurements

The benchmark's `scrapeElapsedMs` measures the connector/core scrape. `elapsedMs` includes document work and workbook/PDT export. Both final cold runs passed every fixture gate: found product, exact official PDP, exact image, device type, source facts, normalized fields and values, and PDT audit. Neither run produced a wrong product, unproven PDT write, or unexplained required-field issue. Five enum values were skipped where the template had no proven matching enum.

| Run | Accuracy gates | Core mean / range | Full-item mean | FA66 core / full |
| --- | --- | ---: | ---: | ---: |
| Fast-path cold 01 | 100% | 1.213 s / 0.780–1.868 s | 6.173 s | 0.784 / 18.250 s |
| Fast-path cold 02 (diagnostic outlier) | 100% | 1.531 s / 0.752–3.923 s | 4.286 s | 0.840 / 8.829 s |
| Accepted repeat, cold 03 | 100% | 0.980 s / 0.773–1.758 s | 3.358 s | 0.788 / 7.508 s |

The two accepted cold runs met the 2.5 s core target for all five SKUs. The intervening diagnostic run had one GP08 outlier at 3.923 s; its accepted repeat was 1.758 s. Full-item time varies with document and image network latency; the exact FA66 manual path is correct, but its fetch and downstream full-item work still dominate FA66 wall time. The acceptance claim is limited to these five SKUs and two PDT sheets (`cabinet.mechanical`, `cabinet.airconditioning`).

## Reports

- [Fast-path cold 01](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-04.isolatedStorage-1.tag-sce-batch-04-final-fastpath-cold-01.json)
- [Diagnostic cold 02 with GP08 timing outlier](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-04.isolatedStorage-1.tag-sce-batch-04-final-fastpath-cold-02.json)
- [Accepted cold 03 repeat](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-04.isolatedStorage-1.tag-sce-batch-04-final-fastpath-cold-03.json)
- [Initial diagnostic](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-04.isolatedStorage-1.tag-sce-batch-04-initial-cold-01.json)

## Exact official product pages

- [SCE-GP08](https://www.saginawcontrol.com/partnumber_info/?n=SCE-GP08)
- [SCE-P010605](https://www.saginawcontrol.com/partnumber_info/?n=SCE-P010605)
- [SCE-KBH](https://www.saginawcontrol.com/partnumber_info/?n=SCE-KBH)
- [SCE-WSCC](https://www.saginawcontrol.com/partnumber_info/?n=SCE-WSCC)
- [SCE-FA66](https://www.saginawcontrol.com/partnumber_info/?n=SCE-FA66)
