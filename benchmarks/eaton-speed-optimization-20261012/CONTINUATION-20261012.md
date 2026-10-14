# Eaton source-learning and final cold-run continuation

Date: 2026-10-12. The tables below supersede the earlier “post-change” timing rows in `README.md` for the final group A rerun. Each timed invocation used a separate `BENCHMARK_ISOLATED_STORAGE=1` run and an SKU-only fixture manifest. All URLs and per-field parser/source provenance remain in the linked per-SKU benchmark JSON and `request-evidence.csv`.

## Final group A rerun: same 15 SKUs

| Catalog number | Before | Final cold run | Exact PDP/type/expected fields | Strict exact device photo |
|---|---:|---:|---|---|
| `277615` | 21.485s | 19.608s | PASS; Contactor; expected fields present | FAIL; image is sibling `277600_C` |
| `088844` | 13.961s | 14.074s | PASS; Motor Circuit Breaker; expected fields present | FAIL; image is sibling `088839_C` |
| `197509` | 21.122s | 20.540s | PASS; exact Product Type now yields Control Relay; expected fields present | PASS; exact SKU asset |
| `DG1-32088FN-C21C` | 30.048s | 29.331s | FAIL; exact source says Variable Frequency Drive while classifier returns Variable Speed Drive | FAIL; sibling asset |
| `PDU3EVSR6G60A` | 28.404s | 24.674s | PASS; Power Distribution Unit; expected fields present | PASS; exact SKU asset |
| `SK6-6` | 18.858s | 15.665s | PASS; exact Eaton type resolves to Surge Protective Device | PASS; image visually matches exact surge strip; Eaton alias `SK66_C` |
| `INTERNET750U` | 14.900s | 19.116s | PASS; UPS; expected fields present | PASS; exact SKU asset |
| `5FTCKIT` | 180.018s timeout | 140.352s | FAIL; exact title is “Flex Shaft Handle Operator 60””; current is not a supported field for this handle/operator | FAIL; returned asset is another part |
| `BD63` | 14.027s | 12.411s | PASS; Fuse; expected fields present | PASS; exact SKU asset |
| `2010762` | 11.147s | 10.345s | PASS; Pushbutton / Operator; expected fields present | FAIL; exploded assembly illustration, not a device photo |
| `183283` | 24.202s | 24.302s | PASS; Pilot Light; expected fields present | PASS; exact SKU asset |
| `1173A-100` | 124.583s | 12.797s | PASS; Photoelectric Sensor; exact-row voltage evidence present | PASS; exact SKU asset |
| `XV-303-15-C00-A00-1D` | 25.423s | 24.096s | REVIEW; exact PDP lacks voltage; expected normalized voltage field absent | FAIL; XV100 family image |
| `C0005P9PS` | 16.480s | 15.053s | PASS; Transformer; expected fields present | FAIL; sibling asset |
| `BREVEM2040` | 14.346s | 13.259s | FAIL; exact Product Type is “BR EV smart breaker charger”; classifier remains unknown | PASS; exact SKU asset |

Final group A time: **395.623s total, 19.116s median, 29.331s p90**. Baseline: **559.004s, 21.122s median, 124.583s p90**. This is an observed reduction of 29.2% in summed per-item time, 9.5% in median, and 76.5% in p90 under these cold samples. It is not a 15/15 quality pass: 11/15 meet the per-item expected type and expected normalized-field fixture checks; `DG1-32088FN-C21C`, `5FTCKIT`, `XV-303-15-C00-A00-1D`, and `BREVEM2040` still fail or need review. Strict exact-photo gate is 8/15.

The clearest attributable timing change is `1173A-100`: 124.583s baseline to 12.797s on the final cold rerun (89.7% lower). Its exact PDP links the official “Sensing Solutions, Legacy Sensor Products” catalog despite the generic catalog link label/URL omitting the SKU; the exact catalog row supplies the sensor voltage. Another observed paired change is `TPC2234-3866`: 15.094s to 11.220s after parsing 16 A from the exact PDP description, ahead of the separate “(2) two-pole 15A breaker” text. The latter is an additional group B sample, with no complete before-run set for group B. Other individual shifts include live-network variation; no general per-item speed claim is made from one sample.

## Additional group B cold run: 15 unseen SKUs

| Catalog number | Final cold run | Type / expected normalized fields | Exact PDP and documents | Strict exact device photo |
|---|---:|---|---|---|
| `225MCSR631MW` | 19.408s | PASS type; FAIL expected fields (current absent) | PASS | FAIL; `150MCSR4313_C` is a different capacitor bank |
| `IQ250MA65100-2B2C` | 29.353s | PASS; fields present | PASS | FAIL; no product image in result |
| `XTAE065D00C065` | 13.700s | PASS; fields present | PASS | FAIL; sibling `XTAE040D00A010_C` |
| `038805` | 20.854s | PASS; exact Key-operated Actuator type | PASS | PASS; exact PDP image visually depicts the key actuator |
| `257064` | 108.817s | FAIL; exact pushbutton, voltage requirement remains unresolved | PASS | PASS; exact `257064_L` image |
| `232233` | 17.181s | PASS; exact Potentiometer type; fields present | PASS | FAIL; sibling `232232_C` |
| `S811+R10N3S` | 13.742s | PASS; Soft Starter; fields present | PASS | FAIL; sibling `S811-R13N3S_C` |
| `DT3030` | 14.133s | PASS; exact Product Category yields Protective Relay | PASS | FAIL; family image `DT3000_C` |
| `229424` | 17.181s | PASS; exact Product Type yields Power Supply | PASS | PASS; exact SKU asset |
| `PS-8-LP` | 11.941s | PASS; exact Type “NAC power supply” yields Fire Alarm Power Supply | PASS | PASS; punctuation-normalized exact SKU asset |
| `PDUNV` | 16.474s | PASS; Power Distribution Unit; fields present | PASS | PASS; exact SKU asset |
| `TPC2234-3866` | 11.220s | PASS; ATS Power Distribution Unit; current = 16 A from exact description | PASS | FAIL; family asset `Eaton-eATS_FM` |
| `FG630` | 12.286s | PASS; Fuse; fields present | PASS | FAIL; `FG500_C` is another fuse model |
| `118705` | 16.768s | PASS; Safety Relay; fields present | PASS | PASS; exact SKU asset |
| `PS256B-04B1` | 12.799s | PASS; exact Product Type yields Power Supply; fields present | PASS | FAIL; sibling `PS256A-01B1_L` |

Group B time: **335.857s total, 16.474s median, 29.353s p90**. There is no pre-change group B sample, so this is runtime/coverage evidence only, not a before/after speed claim. The benchmark aggregate gate is not a per-item guarantee: `225MCSR631MW` lacks a fixture-required current and `257064` remains partial with unresolved required voltage. Full per-item type, expected-field, and no-missing-field acceptance is 13/15; strict exact-photo gate is 6/15.

## Where Eaton publishes the values the scrape did not resolve

The scraper’s reusable direct source is Eaton’s exact `skuPage.<catalog-number>.html` page. Its `General specifications` and `Product specifications` tables supply exact product name/type, dimension/weight labels, performance ratings, and model-specific attributes as static HTML. The result JSON records each value with the exact page URL, parser, and extraction stage. Eaton’s exact-PDP catalog links can also point to a generic filename; the accepted PDF data still passes the existing exact catalog-row/SKU check before enrichment.

| SKU | Official source location and evidence | Unresolved output kept blank / review |
|---|---|---|
| `5FTCKIT` | [Exact PDP](https://www.eaton.com/us/en-us/skuPage.5FTCKIT.html): description at top identifies “Flex Shaft Handle Operator 60””; General specifications gives 60 × 1 × 1.5 in and 7 lb; Performance Ratings gives 600 V. | No current rating is published for the handle/operator SKU. The fixture expects a Switch, but this SKU is an operator accessory; do not infer switch current or use the representative family image. |
| `XV-303-15-C00-A00-1D` | [Exact PDP](https://www.eaton.com/us/en-us/skuPage.XV-303-15-C00-A00-1D.html): HMI Product Type, 16 × 10 × 4 in, 5 lb, display size, exact SKU. [XV300 manual](https://www.eaton.com/content/dam/eaton/technicaldocumentation/mn/MN048017_EN.pdf) states 24 V DC for the whole XV300 line and wildcard model families. | Do not map the family-wide manual value to this SKU without a model-specific source route. The existing exact page and linked spec sheet did not yield voltage in the cold scrape. |
| `257064` | [Exact PDP](https://www.eaton.com/us/en-us/skuPage.257064.html), lines 131–138: exact Emergency Stop pushbutton; `Accessories` says “With built-in multiple LED, 24 V DC, Ie = 15 mA.” | Those values are explicitly for the built-in LED/accessory, not the switch contact circuit’s voltage/current rating. Keep generic normalized voltage empty and flag review. |
| `225MCSR631MW` | [Exact PDP](https://www.eaton.com/us/en-us/skuPage.225MCSR631MW.html): exact AutoVAR capacitor bank, 600 V and 225 kvar description, three phase, dimensions and weight; exact spec sheet is linked on the page. | No current attribute was confirmed in the exact page extraction; do not derive current from kvar/voltage. |
| `BREVEM2040` | [Exact PDP](https://www.eaton.com/us/en-us/skuPage.BREVEM2040.html): Product Type `BR EV smart breaker charger`, 40 A, 208/240 Vac, dimensions and weight. | Exact product type is a smart breaker charger; the current classifier/fixture still returns unknown vs expected Circuit Breaker. The exact wording is preserved for review rather than forced into a sibling category. |
| `TPC2234-3866` | [Exact PDP](https://www.eaton.com/us/en-us/skuPage.TPC2234-3866.html), product description: “200–240V input voltage, 16A … (2) two-pole 15A breaker.” | The shared description reader now records the input rating (16 A) separately from the output breaker rating (15 A). Exact current is verified. |

Classification rules added in `src/server/scrapers/device-type.ts` only promote Eaton Product Type, Product Category, or specific Type values when both result URL and the attribute source are the exact Eaton SKU PDP for the requested catalog number. Those patterns were verified on the concrete devices in the group B table: capacitor bank, key-operated actuator, potentiometer, protective relay, power supply, NAC fire alarm power supply, and ATS PDU. They do not accept sibling SKUs or family pages as product identity.

## Checks and limits

- Passed focused exact Eaton PDP classification tests (3) and the exact PDU-description current test (1); `npx tsc --noEmit` passed.
- Broader Eaton-focused existing tests: 69 passed, 2 failed because legacy expectations round conversions to two decimals while this worktree’s existing normalizer preserves full precision (`0.1133980925 kg` vs `0.11 kg`, and `11.158372302 kg` vs `11.16 kg`). Those precision expectations were not changed.
- Benchmark JSON reports preserve per-item elapsed time, quality fields, exact URL, source attributes, documents, and isolated runtime DB page request/cache evidence. `request-evidence.csv` preserves observed URL/status/timing/cache-body records. Per-attempt retry/backoff wait durations are not emitted by the benchmark harness, so they remain unavailable; 257064’s earlier stage diagnostic is preserved separately.
- The strict image audit remains independent of the benchmark’s built-in “image document exists” check. Overall, accepted exact device photos remain 14/30 across the two groups; 16/30 fail due to missing, family, sibling, logo/diagram, or otherwise non-exact image evidence.
- No fixtures, saved products, or previously learned links supplied discovery results during these cold runs. The isolated run databases/caches and source rows are preserved under `benchmarks/output` and the linked JSON reports.
- No project structure changed; `PROJECT_MAP.md` was not edited by this continuation.
