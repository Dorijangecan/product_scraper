# Rittal accuracy follow-up — 2026-10-06

## Cause and correction

Rittal SKU 7320530 has the exact official PDP at https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240405ZUB001/PG20240405ZUB002/PRO23678?variantId=7320530. Its PDP says `Design = Access sensor`, `Measuring technique = Reed contact, magnet`, and `Interfaces = RJ12`. The title alone said `CMC III sensors`, so the previous title-weighted classifier returned generic `Sensor`. The exact Design field now supplies device-type evidence when its value matches a known type. The passive reed-contact profile has no applicable standalone supply-voltage/current requirement, so those values remain blank rather than guessed.

The source-backed fixture expectation for 7320530 was changed from `Sensor` to `Access Sensor`; the evidence is recorded in `manifest.json`. This is an expectation correction from the exact PDP, not an SKU-specific production rule.

## Cold-start verification

Both 15-SKU corpora were rerun with fixture inputs only, fresh isolated SQLite and HTTP caches, no learned endpoints, no customer documents, and external search disabled. Rittal concurrency was 2. The profile's `rateLimitMs` is 1500 ms; `run-manager.ts` divides by concurrency, so the effective per-host minimum was 750 ms. Retry count and accumulated throttle wait are not instrumented.

- Previously selected Rittal audit corpus (`1038000`, `1480000`, `8617200`, `9340050`, `3486937`, `3334300`, `2500200`, `3105380`, `7955401`, `3209100`, `7320530`, `3173120`, `3243080`, `2485100`, `3173100`): exact identity 15/15, official PDP 15/15, documents 15/15, source-normalized field checks 15/15, expected device type 15/15, PDT audit 15/15, wrong products 0. Item-time sum/mean/median/range moved from 156177 / 10411.8 / 10230 / 1476–29725 ms to 145936 / 9729.1 / 8689 / 1850–23622 ms. The earlier batch-wall stopwatch was not retained, so no wall-time comparison is claimed.
- New Rittal 15-SKU corpus (`3245800`, `8618800`, `7030200`, `9350075`, `9665785`, `7888626`, `7979313`, `2500100`, `3336460`, `4532000`, `8611020`, `5302042`, `8617353`, `4127210`, `2418000`): exact identity, official PDP, documents, normalized fields, expected device type, and PDT audit each 15/15; wrong products 0. Previous final vs follow-up cold run: batch wall 124029 → 126056 ms; item-time sum 118509 → 104326 ms; mean 7900.6 → 6955.1 ms; median 4882 → 3717 ms; range 2124–33602 → 1589–27336 ms. Per-item time fell but batch wall rose 1.6%; this small number of runs does not support a code-driven speed claim.

For 2500100 the PDT audit still records a known missing optional `rated permanent current Iu` value; the official PDP does not publish it. It remains blank. There are 0 unexplained required-field issues and 0 unproven written values.

## Verification

- `npx vitest run tests/rittal.test.ts tests/device-type.test.ts tests/product-requirements.test.ts --reporter=dot`: 189 passed.
- `npm run build`: passed.
- Final cold reports, options, and raw debug logs are adjacent to this file in the `logs/` directories and the Rittal v2 corpus `final/` directory.
