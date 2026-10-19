# SCE batch 02 — heating, heat exchange and enclosure hardware

This batch covers five new SCE part numbers from five distinct product kinds. Novelty was checked read-only against the SCE `run_items` history and `product_aliases`; none was present. Every exact official PDP and SKU-matched image was checked. Exact manuals were downloaded and parsed where the type-specific gate required technical ratings; for the passive accessories, the exact PDP already supplied the required facts.

| Catalog number | Product kind / device type | Important exact-source facts checked |
| --- | --- | --- |
| `SCE-H350` | DIN-rail enclosure heater / Heater | 350 W; supply 100–240 V, 50/60 Hz; integrated 24 V fan; 3.0 A heater current at the manual's 110 V test point; operating range −40…70 °C; 3.10 × 2.10 × 3.30 in; 0.33 lb shipping weight |
| `SCE-HE18W120V` | Air-to-air heat exchanger / Heat Exchanger | HE18; 120 V, 50/60 Hz; 1.40 A rated, 1.60 A starting, 150 W; 18 W/°F; operating range 23…131 °F (−5…55 °C); 29.66 × 10.24 × 5.95 in; 28.60 lb shipping weight and 26.5 lb manual weight; NEMA 3/3R/12, IP54 |
| `SCE-RH44` | Rain hood / Rain Hood | 8.09 × 7.62 × 4.50 in; 3.00 lb; galvannealed steel; UL Component Recognized Type 3R |
| `SCE-26POS` | Pull-out shelf / Pull-Out Shelf | 2.00 × 19.50 × 28.00 in; 18.00 lb; heavy-gauge steel, white powder coat; slides and mounting hardware included |
| `SCE-PWK53NF` | Window kit / Window Kit | 7.50 × 5.50 × 0.38 in; 1.50 lb; exact NF variant is carbon steel; 0.25 in UV-stable polycarbonate window; IP66 and listed enclosure applications |

## What failed and why

- The exact SCE pages use noun orderings missing from the shared classifier: `Exchanger, Heat`, `Hood, Rain`, `Shelf, Pull-Out`, and `Kit, Window`. The page was found, but four products had no useful device type; the window kit fell into generic `Accessory`.
- The classifier miss caused the rain hood to be treated like an electrical device, so the quality gate demanded voltage and current that do not apply to a passive metal accessory.
- SCE's H350 page publishes the universal supply range only in application prose. A linked exact-model manual states heater current at a nominal 110 V point, plus a separate 24 V fan circuit. Treating the manual's 110 V as the product's supply voltage was wrong; the PDP range now takes precedence while the source manual still supplies the nominal current and operating temperature.
- The HE18 exact PDP contains identity, dimensions, ship weight, voltage, finish and protection, but its exact model manual alone publishes rated and starting current, power consumption, performance and the working temperature range. A generic enclosure-thermal rule was returning “voltage only,” which let the quality gate skip that manual. SCE's calibrated device-type profile now takes precedence, requires both voltage and current, and keeps the exact HE18 manual while dropping other HE capacity manuals.
- The window-kit PDP describes standard carbon-steel and stainless siblings in one paragraph. Generic prose extraction copied Type 304 stainless onto the exact `SCE-PWK53NF` carbon-steel SKU. The SCE window-kit rule now uses the exact catalog suffix to select the applicable material, and the fixture asserts `carbon steel`.

## Reusable scraper learning

- Added reusable classifier rules and PDT profiles for `Heater`, `Heat Exchanger`, `Rain Hood`, `Pull-Out Shelf`, and `Window Kit`. The thermal products route to `cabinet.airconditioning`; passive hardware routes to `cabinet.mechanical` and has no electrical requirement.
- Apply SCE's device-type rating profile before the broad thermal-equipment fallback. This makes required fields follow product kind, so heaters and heat exchangers fetch a current-bearing source while passive hoods and shelves do not chase electrical data.
- Parse an exact SCE PDP voltage range as a first-class supply field, preserve the source manual's separate current-at-test-voltage fact, and keep variant-specific material selection tied to the requested SKU.
- The exact image URLs were downloaded and all five images were visually inspected; each shows the requested product rather than a logo or sibling item.

## Measurements

Core scrape time excludes selected document download, PDF extraction and workbook/PDT work. Full benchmark time includes those steps.

| Run | Found | Device type | Expected source facts | Expected normalized fields | Core mean / range | Full benchmark mean / range | Item result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Initial cold 01 | 80% | 0% | 80% | 100% (field-presence-only fixture checks) | 1.050 s / 0.771–1.713 s | 3.659 s / 1.756–7.288 s | Rejected |
| Accepted cold 09 | 100% | 100% | 100% | 100% with value patterns | 1.259 s / 0.776–2.309 s | 6.822 s / 1.984–14.615 s | 5/5 accepted |
| Accepted repeat cold 10 | 100% | 100% | 100% | 100% with value patterns | 1.179 s / 0.763–1.750 s | 6.462 s / 1.943–15.183 s | 5/5 accepted |

Every product's connector scrape remains below 2.5 s. The full workflow is slower on the heater and heat exchanger because it now downloads and parses the exact official manual needed to prove current and thermal ratings; those times are intentionally not presented as connector time. The shelf and window-kit full benchmark items completed under 2.5 s in both accepted repeats. Both accepted runs had 100% exact PDP URLs, exact images, device types, expected source facts, value-checked normalized fields and PDT audit, with no wrong product matches and no unproven PDT writes. The batch covers 2 of the template's 41 PDT sheets, so this is batch-level acceptance, not full-catalog coverage.

The remaining two required ECLASS classification columns are blank for the passive accessories because the exact SCE pages do not prove ECLASS values; the audit explains these missing fields, so no codes were guessed. Two powder-coat surface enum values are also skipped when the template has no exact matching enum. No unsupported values were written.

## Evidence reports

- First cold baseline: [initial-cold-01](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-02.isolatedStorage-1.tag-sce-batch-02-initial-cold-01.json)
- Intermediate diagnosis and source-policy fixes: [repair-cold-07](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-02.isolatedStorage-1.tag-sce-batch-02-repair-cold-07.json), [repair-cold-08](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-02.isolatedStorage-1.tag-sce-batch-02-repair-cold-08.json)
- Accepted repeat runs: [final-cold-09](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-02.isolatedStorage-1.tag-sce-batch-02-final-cold-09.json), [final-cold-10](../../benchmark-report.manufacturer-sce.limit-5.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-02.isolatedStorage-1.tag-sce-batch-02-final-cold-10.json)

