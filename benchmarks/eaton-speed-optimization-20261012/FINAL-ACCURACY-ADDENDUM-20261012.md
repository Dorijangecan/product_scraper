# Eaton final accuracy addendum (2026-10-12)

This addendum records the follow-up changes and isolated cold runs after the results in [CONTINUATION-20261012.md](CONTINUATION-20261012.md). The original 30 SKU reports, request evidence, output directories, and per-field provenance remain the detailed run record.

## Shared rules applied

- The generic device classifier now maps an exact Eaton PDP `Product Type` containing “smart breaker charger” to `Circuit Breaker`. It was confirmed on `BREVEM2040`; no catalog-number exception was added. The exact PDP exposes `Product Type = BR EV smart breaker charger`, `40 A`, `208/240 Vac`, size and weight at [Eaton BREVEM2040](https://www.eaton.com/us/en-us/skuPage.BREVEM2040.html).
- When Eaton explicitly labels its PDP gallery “Photo is representative”, the parser omits those image documents, even when their asset path or alt text repeats the requested SKU. The HMI image repair also no longer replaces a rejected or sibling asset with a family image. This was confirmed on `XV-303-15-C00-A00-1D`; no device image is emitted for that product.

## Post-change isolated cold runs

Both used `BENCHMARK_ISOLATED_STORAGE=1`, an SKU-only fixture manifest, and fresh runtime storage.

| Catalog number | Elapsed | Exact SKU PDP and type | Expected normalized fields | Exact device photo | Evidence |
|---|---:|---|---|---|---|
| `BREVEM2040` | 9.899 s | PASS; Circuit Breaker | PASS; 40 A and 208/240 Vac with exact PDP provenance | PASS; downloaded image `BREVEM2040_C` visually depicts the labeled breaker charger | [cold report](../benchmark-report.manufacturer-eaton.catalogNumber-BREVEM2040.fixtureDir-benchmarks-eaton-speed-optimization-20261012-group-a.isolatedStorage-1.tag-20261012-post-accuracy-cold.json) |
| `XV-303-15-C00-A00-1D` | 21.710 s | PASS; HMI | FAIL; exact page and linked SKU sheet omit supply voltage, while an Eaton numeric alias page documents 24 V DC | FAIL / unavailable; exact PDP marks its gallery “Photo is representative”, and the family substitute is now omitted | [cold report](../benchmark-report.manufacturer-eaton.catalogNumber-XV-303-15-C00-A00-1D.fixtureDir-benchmarks-eaton-speed-optimization-20261012-group-a.isolatedStorage-1.tag-20261012-post-image-policy-cold.json) |

The numeric alias `191077` is linked to the exact XV model by Eaton’s official source: it has the same EAN `7640130099166`, lists `XV-303-15-C00-A00-1D` as its associated CAD model, and its exact SKU page states “Rated operational voltage: 24 V DC”. See [Eaton numeric SKU 191077](https://www.eaton.com/cr/es-mx/skuPage.191077.html) and [Eaton’s XV300 operator panel catalog](https://www.eaton.com/content/dam/eaton/markets/machinebuilding/it/catalogs/eaton-Operator-Interface-Products-Catalog-CA08100008-EN-IT.pdf). The current cold scrape has not yet discovered and attached this cross-catalog-number source; therefore voltage remains absent from the output pending a shared, identity-checked alternate-SKU lookup. The family manual alone was not treated as proof.

The current `XV303` report is therefore not a complete quality pass despite the benchmark’s generic `quality accepted` value: its fixture-required normalized voltage is absent and the exact-photo requirement is unmet. Do not interpret “found” or the generic benchmark gate as acceptance.

## October 13 group A rerun and 5FTCKIT completion

The same 15 group A catalog numbers were scraped again with isolated runtime storage. The run report is [`benchmark-report.manufacturer-eaton.limit-15...json`](../benchmark-report.manufacturer-eaton.limit-15.fixtureDir-benchmarks-eaton-speed-optimization-20261012-group-a.isolatedStorage-1.json). Every row has an exact Eaton SKU URL, identity confirmation, and successful document/PDT checks; the more specific quality audit remains separate.

| Catalog number | Time | Exact type | Expected fields | Exact device photo |
|---|---:|---|---|---|
| [`277615`](https://www.eaton.com/us/en-us/skuPage.277615.html) | 12.566 s | Contactor — pass | pass | unavailable: sibling asset rejected |
| [`088844`](https://www.eaton.com/us/en-us/skuPage.088844.html) | 8.312 s | Motor Circuit Breaker — pass | pass | unavailable: sibling asset rejected |
| [`197509`](https://www.eaton.com/us/en-us/skuPage.197509.html) | 11.579 s | Control Relay — pass | pass | pass |
| [`DG1-32088FN-C21C`](https://www.eaton.com/us/en-us/skuPage.DG1-32088FN-C21C.html) | 19.602 s | Variable Speed Drive — pass; exact Product Type says “Variable frequency drive,” which the shared device taxonomy canonicalizes as Variable Speed Drive | pass | unavailable: different model asset rejected |
| [`PDU3EVSR6G60A`](https://www.eaton.com/us/en-us/skuPage.PDU3EVSR6G60A.html) | 13.875 s | Power Distribution Unit — pass | pass | pass |
| [`SK6-6`](https://www.eaton.com/us/en-us/skuPage.SK6-6.html) | 5.652 s | Surge Protective Device — pass | pass | pass |
| [`INTERNET750U`](https://www.eaton.com/us/en-us/skuPage.INTERNET750U.html) | 12.398 s | UPS — pass | pass | pass |
| [`5FTCKIT`](https://www.eaton.com/us/en-us/skuPage.5FTCKIT.html) | **6.128 s** | Cover / Door Accessory — pass | pass; no electrical current requirement for the mechanical operator | unavailable: representative photo and mismatching asset ID |
| [`BD63`](https://www.eaton.com/us/en-us/skuPage.BD63.html) | 5.468 s | Fuse — pass | pass | pass |
| [`2010762`](https://www.eaton.com/us/en-us/skuPage.2010762.html) | 5.264 s | Pushbutton / Operator — pass | pass | fail: exploded assembly illustration |
| [`183283`](https://www.eaton.com/us/en-us/skuPage.183283.html) | 16.236 s | Pilot Light — pass | pass | pass |
| [`1173A-100`](https://www.eaton.com/us/en-us/skuPage.1173A-100.html) | 5.815 s | Photoelectric Sensor — pass | pass | pass |
| [`XV-303-15-C00-A00-1D`](https://www.eaton.com/us/en-us/skuPage.XV-303-15-C00-A00-1D.html) | 18.036 s | HMI — pass | pass; `24 V DC` from verified Eaton EAN alias | fail / unavailable: representative gallery omitted |
| [`C0005P9PS`](https://www.eaton.com/us/en-us/skuPage.C0005P9PS.html) | 4.500 s | Transformer — pass | pass | unavailable: sibling asset rejected |
| [`BREVEM2040`](https://www.eaton.com/us/en-us/skuPage.BREVEM2040.html) | 3.767 s | Circuit Breaker — pass | pass | pass |

Strict exact-device photos pass **8/15**. The scraper now rejects Eaton representative-photo notices in English, German, French, Spanish, Italian, and Chinese, and rejects Eaton image assets whose normalized asset ID does not include the exact requested catalog number. This removes sibling assets without claiming that every surviving matching asset is a real-device photograph; the surviving images were still visually audited separately. On `5FTCKIT`, Eaton's [exact PDP](https://www.eaton.com/us/en-us/skuPage.5FTCKIT.html) explicitly says “Photo is representative”; the localized page asset identifier is `OLI362FDJB-DOVP_C`, which does not identify `5FTCKIT`, so the output now has no image. The page describes “Flex Shaft Handle Operator 60” and publishes its dimensions, weight, and 600 V performance rating; it does not publish an operator current rating. The shared classifier gives that exact-SKU component description precedence over the broader family title/type, and shared requirements do not require switch current for a mechanical shaft-handle operator. The pre-fix isolated final sample was 140.352 s and the baseline sample timed out at 180.018 s; the latest comparable full-set cold run completed this item in 3.951 s.

For the full group A sample, total time fell from **559.004 s** to **149.198 s** (73.3% lower); median fell from **21.122 s** to **8.312 s** (60.6% lower); P90 fell from **124.583 s** to **18.036 s** (85.5% lower). These are single cold samples on the same 15-item manifest and isolated storage. All 15 exact PDP/type/expected-field checks now pass. The performance result is measured, but strict image completeness remains partial: 8/15 photos pass and 7/15 are unavailable or not photos of the exact device.

Eaton's EAN search API returned an empty result for both the XV model's EAN and the combined exact-model/EAN query. Its official numeric PDP [`191077`](https://www.eaton.com/cr/es-mx/skuPage.191077.html) publishes EAN `7640130099166`, `Rated operational voltage = 24 V DC`, and the exact associated CAD model `DA-CE-ETN.XV-303-15-C00-A00-1D`. This verified source location is persisted by EAN in shared Eaton logic; runtime enrichment still requires the alias page itself to repeat both the EAN and requested model code. Only nonzero rated operational voltage/current values are transferred, so the page's `0 VAC` rows cannot override 24 V DC. The exact requested XV product URL, title, and image evidence remain from its own PDP.

The durable shared behavior is in `src/server/scrapers/device-type.ts`, `src/server/scrapers/eaton.ts`, and `src/shared/product-requirements.ts`, with regressions in `tests/device-type.test.ts`, `tests/parsers.test.ts`, and `tests/product-requirements.test.ts`. The fixture's 5FTCKIT type is the shared `Cover / Door Accessory` category, based on Eaton's exact SKU description; the DG1 fixture uses the shared taxonomy's canonical `Variable Speed Drive` label for Eaton's “Variable frequency drive.” These fixture labels document source-backed taxonomy mappings, not SKU-specific runtime rules.

Final checks after the asset-identity gate: `npx tsc --noEmit` passed; the Eaton identity/representative-image parser tests passed (4/4); `git diff --check` passed. The broader targeted run reported **473 passed and 11 failed**. Those 11 failures are existing unit-conversion expectations that round to two decimals while this worktree's normalizer preserves full decimal precision; they are unrelated to the Eaton image/classifier changes. No full project suite or eval was run in this continuation.

## Quality, timing, and checks

- These two follow-up timings do not form a comparable 15-item rerun. They cannot update or validate the original group A speed claim. The previous measured group A baseline/final values and 15 per-SKU rows remain in `CONTINUATION-20261012.md`; group B has no baseline comparison. No new aggregate acceleration is claimed.
- Group A is still short of the strict accuracy gate: at least `XV-303-15-C00-A00-1D` has a proven exact-model field source not yet integrated, and multiple SKUs in the original set have no accepted exact-device photo. Group B likewise has unresolved required fields and exact-photo failures. No later set of 15 was selected because group A has not met its acceptance criteria.
- `npx tsc --noEmit` passed. The new full-connector regression test for representative HMI images passed, and `tests/device-type.test.ts` passed. `npx vitest run tests/device-type.test.ts tests/parsers.test.ts` reported 460 passed and 11 failed; all 11 failures compare rounded unit conversions to this worktree’s already-existing full-precision conversions. Those expectations are outside this change and were not altered.
- The stable, evidence-backed rules are in shared Eaton parsing/classification code and their exact-device regression tests. The isolated JSON reports and output/cache directories are run evidence only; no result cache or one-SKU override was added. `PROJECT_MAP.md` was not changed by this work because no project structure changed.
