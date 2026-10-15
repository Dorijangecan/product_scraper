# Siemens accuracy and speed batch 04

**Status: accepted.** Two final isolated cold runs passed all five products after the Siemens exact-article path and normalization repairs.

## Products and official sources

| Catalog number | Device type | Exact official source |
| --- | --- | --- |
| `7MF1567-3DB00-1AA1` | Pressure sensor / SITRANS P220 | [Siemens SiePortal](https://sieportal.siemens.com/en-ww/products-services/detail/7MF1567-3DB00-1AA1) |
| `6GT2801-5BA30` | RFID reader / RF360R | [Siemens SiePortal](https://sieportal.siemens.com/en-ww/products-services/detail/6GT2801-5BA30) |
| `4AM3242-5LT10-0FA0` | Single-phase transformer / SITAS | [Siemens SiePortal](https://sieportal.siemens.com/en-ww/products-services/detail/4AM3242-5LT10-0FA0) |
| `3SK1122-2CB42` | Advanced safety relay | [Siemens SiePortal](https://sieportal.siemens.com/en-ww/products-services/detail/3SK1122-2CB42) |
| `3RM1007-1AA04` | Direct motor starter | [Siemens SiePortal](https://sieportal.siemens.com/en-ww/products-services/detail/3RM1007-1AA04) |

The five catalog numbers were checked against benchmark fixtures/reports, aliases, run history, and cached product URLs before selection. All five returned an exact article identity and exact Siemens product URL.

## Evidence review and corrections

- **7MF1567-3DB00-1AA1:** the exact article description gives a 0–160 bar gauge range, 480 bar overload pressure, 4–20 mA two-wire output, 7–33 V DC supply, stainless wetted parts, and G 1/2 process connection. Normalization keeps the supply voltage; it does not mislabel the 4–20 mA signal as device supply current. The official image tied to the exact article was reviewed; it shows three P220 connection variants together, so the exact connector variant is not isolated in the photo.
- **6GT2801-5BA30:** RF360R reader for SIMATIC RF300; 13.56 MHz, up to 150 mm read/write range, 20.4–28.8 V, 0.15 A, and IP67. The image shows the RF360R reader.
- **4AM3242-5LT10-0FA0:** exact description gives one phase, 0.063 kVA nominal power (0.19 kVA S6), 660 V ±5% primary, 230 V secondary, 0.27 A secondary current, and IP00. Normalized voltage and current preserve the primary/secondary context. The direct exact-API path exposed a duplicated `IP IP00` string; Siemens normalization now reduces that to `IP00`. The image shows the SITAS transformer.
- **3SK1122-2CB42:** Advanced safety relay with 24 V DC control supply, 2 NO instantaneous plus 2 NO delayed electronic outputs, and a 2 A maximum semiconductor output rating at DC-13, 24 V. The 2 A value remains explicitly qualified as an output rating. The image shows the matching SIRIUS safety relay.
- **3RM1007-1AA04:** direct starter rated 0.55–3 kW and 1.6–7 A; control supply is 24 V DC and main operating voltage is 48–500 V. Normalization keeps these voltage contexts separate and labels the current as adjustable overload-trip current. The image shows the matching SIRIUS starter.

Every downloaded image was opened and visually reviewed. The official Siemens datasheet URL used by the fast path includes the exact catalog number; each final run passed the datasheet/document gate.

## Shared repairs

- Added Siemens family classifications for the `6GT2801` RFID reader and `3MV` motor circuit breaker families.
- Preserved pressure-transmitter DC supply bounds, qualified safety-relay semiconductor output current, and breaker overload-trip versus AC-3 current contexts.
- Normalized transformer primary/secondary voltage and secondary current from the exact Siemens product description. Kept motor-starter control and main-circuit voltage separate.
- Added a fast path for exact Siemens API records only when catalog identity, an article image, a product-specific datasheet, and all device-type-required electrical fields are present. The exact-MLFB TED datasheet URL is generated from the confirmed article number; otherwise the existing MMPDATA and discovery fallbacks remain available.
- Removed a duplicate `IP` prefix produced when an exact description says `IP00`.

## Verification and timing

- `npx tsc --noEmit`: passed.
- Final isolated cold reports: `../../benchmark-report.fixtureDir-benchmarks-siemens-accuracy-speed-20261014-batch-04.isolatedStorage-1.tag-siemens-batch-04-final-04.json` and `../../benchmark-report.fixtureDir-benchmarks-siemens-accuracy-speed-20261014-batch-04.isolatedStorage-1.tag-siemens-batch-04-final-05.json`.
- Both runs passed exact official URL, required document, device type, expected normalized field, and PDT audit gates 5/5. Wrong products: 0; unproven PDT writes: 0; unexplained required-field issues: 0. Ten controlled enum skips remained blank.
- Core acquisition, run 1: 0.261–1.252 s/device (mean 0.735 s, median 0.754 s). Cold repeat: 0.282–1.425 s/device (mean 0.770 s, median 0.697 s). All five met the 2.5-second target on both runs.
- Complete benchmark time, including document handling and workbook/PDT export, was 2.560–6.609 s/device on the repeat (mean 5.074 s, median 5.146 s); reported separately from acquisition.
- Benchmark fixture coverage remains 5/41 device sheets; this batch evaluates five Siemens types and does not claim full catalog-sheet coverage.
