# ABB cold batch 01

Five previously unbenchmarked devices were selected across soft starters, molded-case circuit breakers, network analyzers, variable-speed drives, and monitoring relays. The manifest requires a datasheet for the first, second, third, and fifth devices.

For `3AXD50000038968` (ACS580-01-07A3-4+B056), ABB's exact product page provides product attributes and declarations but no downloadable datasheet. ABB's official ACS580-01 manuals list provides the applicable R1-R9 family hardware manual, document `3AXD50000044794`; the scraper records it explicitly as a family manual and excludes its multi-variant contents from field enrichment.

The M4M 20 product record exposed a malformed frequency value (`175 … 60 Hz`). ABB's M4M 20 manual (`2CSG445032D0201`) confirms `50-60 Hz`; the scraper removes the malformed value and records the corrected family-level evidence with that official source.

The relay `1SVR730884R4300` is `CM-MPS.43S`. Its ABB long description named `CM-MPN.43S`, a different variant, so the scraper suppresses that conflicting description while retaining the SKU-matched title and technical fields.

## Cold results

The full-document audit report is `../../benchmark-report.fixtureDir-benchmarks-abb-accuracy-speed-20261014-batch-01.isolatedStorage-1.tag-with-acs580-family-manual.json`. It confirms 5/5 exact identities, official product URLs, expected device types, required document references, normalized electrical fields, and PDT audits. All five product images were downloaded and visually matched to the device. The ABB links remain on each result even when PDF saving is disabled.

The optimized default profile report is `../../benchmark-report.fixtureDir-benchmarks-abb-accuracy-speed-20261014-batch-01.isolatedStorage-1.tag-default-image-only-optimized.json`. With PDF saving disabled, it downloads the product image and retains datasheet/manual links; it skips document downloads only when an exact official ABB page passes identity/quality checks, contains at least 20 official PIS attributes, and supplies normalized voltage and current. Explicit PDF saving remains on the full profile. The 5/5 accuracy and PDT gates remained green.

| Device | Full-document total ms | Optimized total ms | Optimized acquisition ms |
| --- | ---: | ---: | ---: |
| PSE soft starter | 15,232 | 5,019 | 3,895 |
| Tmax XT MCCB | 58,095 | 2,357 | 1,460 |
| M4M 20 meter | 17,936 | 1,930 | 1,086 |
| ACS580-01 drive | 10,016 | 2,454 | 1,557 |
| CM-MPS.43S relay | 18,577 | 2,456 | 1,594 |

The optimized total median is 2,454 ms (mean 2,843 ms); the acquisition median is 1,557 ms. A second isolated PSE run measured 2,860 ms acquisition / 4,025 ms including workbook and PDT export, indicating first-item variance remains above the approximate target and should be revisited before treating this optimization as fully settled. The MCCB stage trace showed 1,607 ms for the exact ABB scrape, 12,494 ms to download three documents, and 40,967 ms to enrich them in the full-document profile.
