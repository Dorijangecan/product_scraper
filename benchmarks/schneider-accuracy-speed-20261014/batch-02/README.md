# Schneider Electric accuracy and speed batch 02

## Scope and acceptance

Five previously unprocessed catalog numbers from five product types were cold-scraped:

| Catalog number | Product type | Exact official product page |
| --- | --- | --- |
| `ABL6TS06B` | Control transformer | https://www.se.com/id/en/product/ABL6TS06B/voltage-transformer-230-400-v-1-x-24-v-63-va/ |
| `HMIGXU3512` | HMI panel | https://www.se.com/id/en/product/HMIGXU3512/7-inch-wide-screen-universal-model-2-serial-ports1-ethernet-port-embeddedrtc/ |
| `TCSESM043F1CU0` | Managed Ethernet switch | https://www.se.com/us/en/product/TCSESM043F1CU0/connexium-managed-switch-3-ports-for-copper-+-1-port-for-fiber-optic-multimode/ |
| `XUSL4E30H091N` | Type 4 safety light curtain | https://telemecaniquesensors.com/global/en/product/reference/XUSL4E30H091N |
| `NSYCCOTH230VID` | Electronic thermostat | https://www.se.com/us/en/product/NSYCCOTH230VID/climasys-cc-electronical-thermostat-200-240v-range-of-temperature-40%C3%A280%C3%A2c/ |

Novelty was checked against existing benchmark fixtures and the product catalog/history before the batch was selected. Each report confirms the exact official PDP, expected documents, product type and fixture-specific values. The exact product images were visually checked; no sibling model was accepted as a substitute.

## Findings and shared fixes

- `ABL6TS06B` was initially classified as a power supply and normalized with the 230 V primary voltage. Its exact page and datasheet identify a control transformer with 230/400 V AC primary, a single 24 V AC secondary and 63 VA. The shared Schneider family rule now classifies `ABL6TS*` as `Transformer`; the secondary current is derived only when those exact same-SKU rows establish one secondary winding and its VA/voltage: 63 VA ÷ 24 V = 2.63 A.
- `HMIGXU3512` publishes a 7-inch, 800 × 480 WVGA display, 24 V DC supply, 0…50 °C operating range, Ethernet 10/100BASE-TX, IP65 front protection and a 190 × 135 mm panel cut-out. The datasheet drawing visually shows external dimensions of 207 × 152.3 × 38.2 mm, but its dimension labels are not extracted reliably as text/OCR. The cut-out remains a sourced attribute and is no longer normalized as the device's external dimensions; normalized `dimensions` is left blank rather than assigning the cut-out or package dimensions to the panel.
- `TCSESM043F1CU0` is a managed ConneXium switch with 3 copper ports and 1 multimode fiber port, 12…48 V range and exact-product image. An unrelated EAN assertion was removed because the exact product source did not establish it.
- `XUSL4E30H091N` is a Type 4 safety light curtain: 30 mm resolution, 910 mm protected height, 4…12 m sensing range, 12.5 ms response, two OSSD PNP outputs and 24 V DC ±20%. General current remains blank because the source's current-consumption value is not an unqualified device current. The prior cordset image was replaced with the exact light-curtain image.
- `NSYCCOTH230VID` publishes a -40…80 °C setting range but a narrower -40…70 °C operating range; those remain separate. The exact 200…240 V AC input, 4 A at 230 V AC switching capacity, OLED and two ventilation/heating outputs are retained.
- Shared normalization fixes suppress ambiguous safety-curtain current and inferred housing colors, and preserve the exact source contexts for transformer and thermostat ratings. `ABL6TS*` and `HMIGXU*` now begin from the already-confirmed official `/id/en/` locale to avoid an initial regional redirect; the usual official URL fallbacks remain available.

## Before and after

The initial cold run is `benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-02.isolatedStorage-1.tag-schneider-batch-02-initial.json`. Final cold runs 06 and 07 use isolated storage and the same five-item manifest:

| Metric | Initial | Final cold 06 | Final cold 07 |
| --- | ---: | ---: | ---: |
| Found / exact official URL / expected documents | 80% / 100% / 100% | 100% / 100% / 100% | 100% / 100% / 100% |
| Device type / expected normalized fields / source attributes | 80% / 60% / 20% | 100% / 100% / 100% | 100% / 100% / 100% |
| Core scrape, per-device mean | 4.245 s | 0.531 s | 0.556 s |
| Core scrape, median / maximum | 3.733 / 7.351 s | 0.346 / 0.964 s | 0.304 / 1.018 s |
| Full benchmark, per-device mean | 45.137 s | 15.687 s | 14.160 s |
| Full benchmark, median / maximum | 32.806 / 123.391 s | 12.309 / 27.239 s | 10.381 / 26.507 s |

All five devices meet the 2.5-second core scrape target in both final cold runs. Document download/enrichment and PDT/workbook export remain included in the separately reported full benchmark time. Accuracy gates in both final runs are 100%, with zero wrong products, zero unproven PDT writes and zero unexplained required-field issues. Five PDT controlled-enum values remain blank/skipped.

Reports:

- Initial: `../../benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-02.isolatedStorage-1.tag-schneider-batch-02-initial.json`
- Final cold 06: `../../benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-02.isolatedStorage-1.tag-schneider-batch-02-final-cold-06.json`
- Final cold 07: `../../benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-02.isolatedStorage-1.tag-schneider-batch-02-final-cold-07.json`

## Verification and remaining limit

- The new HMI cut-out exclusion and dimension-normalization checks pass; the locale-priority test passes; `npx tsc --noEmit` passes.
- A broader run of `tests/normalizer.test.ts` plus `tests/document-enrichment.test.ts` completed 367 passing tests and 7 unrelated failing legacy assertions (Eaton voltage selection, formatting/temperature and SCE wall-thickness expectations). The targeted new tests passed; the full test suite is not claimed green.
- The HMI's external drawing dimensions are visible in its exact official datasheet, but are not yet emitted as a normalized or structured dimensions attribute. That value remains blank in scraper output and is recorded above for review; the exact cut-out value is retained separately.

**Status: accepted for the tested identity, field/source, image/document, PDT and repeated cold core-speed gates.** Continue with five new Schneider Electric product types for batch 03.
