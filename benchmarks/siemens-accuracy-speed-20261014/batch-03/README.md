# Siemens accuracy and speed batch 03

**Status: accepted.** Two isolated cold runs passed on the same five products after exact-source review, shared parser/classifier repairs, and final output review.

## Products and exact sources

| Catalog number | Type | Exact official source |
| --- | --- | --- |
| `5SY4104-7` | Miniature circuit breaker | [Siemens SiePortal](https://sieportal.siemens.com/en-ww/products-services/detail/5SY4104-7) |
| `8WH1000-0AF00` | Terminal block | [Siemens SiePortal](https://sieportal.siemens.com/en-ww/products-services/detail/8WH1000-0AF00) |
| `3SE5112-0CH01` | Limit switch | [Siemens SiePortal](https://sieportal.siemens.com/en-ww/products-services/detail/3SE5112-0CH01) |
| `5SD7414-1KU03` | Surge protective device | [Siemens SiePortal](https://sieportal.siemens.com/en-ww/products-services/detail/5SD7414-1KU03) |
| `3RN2013-1BW30` | Thermistor motor protection relay | [Siemens SiePortal](https://sieportal.siemens.com/en-ww/products-services/detail/3RN2013-1BW30) |

All five catalog numbers were new to the checked Siemens fixtures, reports, aliases, run history, and cached product URLs when selected. Exact-SKU Siemens datasheets were retrieved for all five. The five downloaded product images were visually inspected and matched the devices.

## Reviewed values and corrections

- **5SY4104-7:** 1-pole C-curve miniature breaker; the exact product text gives 230/400 V, 4 A, and 10 kA. The normalized current now uses the 4 A AC rated-current row instead of ambient-derating rows; voltage preserves the 230/400 V context.
- **8WH1000-0AF00:** gray through-type terminal block; exact structured rows give 1,000 V rated operating voltage and 24 A rated current. This corrects malformed unstructured voltage text (`000 V / 94 V`). Exact product data gives 48 mm height, 46.9 mm depth, 48 mm length, and 7.8 g net weight.
- **3SE5112-0CH01:** ordinary electromechanical position/limit switch, with 40 mm metal enclosure, 1 NO + 1 NC quick-action contacts, adjustable rotary actuator, 27 mm metal lever, and 19 mm plastic roller. Net weight is 0.339 kg. The generic `3SE = Safety Sensor` mapping was too broad; the family now resolves ordinary 3SE position switches to Limit Switch. Insulation/impulse voltage and fuse-protection currents remain source evidence and are not misrepresented as general device supply voltage/current.
- **5SD7414-1KU03:** UL Type 1, four-pole SPD for a 600Y/347 V wye system. The 50 kA value is explicitly labeled maximum 1-phase discharge current at 8/20 μs, not load current. Dimensions are 90 × 72 × 66 mm; net weight is 0.473 kg.
- **3RN2013-1BW30:** thermistor motor protection relay, 24–240 V AC/DC control supply, two changeover contacts, and ATEX approval. Current values retain their contact context: 3 A maximum auxiliary AC-15 current and 5 A maximum thermal current of the switching contacts. Net weight is 0.159 kg; dimensions are 100 × 22.5 × 90 mm.

## Shared repairs

- Added family classifications for Siemens `8WH` terminal blocks and `3RN` thermistor protection relays; narrowed 3SE safety classification and added the ordinary electromechanical position-switch mapping.
- Made Siemens normalization prefer rated MCB/terminal-block rows and preserve SPD system-voltage and discharge-current labels.
- Kept limit-switch insulation/impulse values and contact/fuse rows out of general voltage/current fields, including after enrichment and field-candidate resolution.
- Re-ran Siemens normalization at final quality-gate evaluation so manufacturer-specific context survives document processing.

## Verification and timing

- `npx tsc --noEmit`: passed.
- Two final isolated cold reports: `../../benchmark-report.fixtureDir-benchmarks-siemens-accuracy-speed-20261014-batch-03.isolatedStorage-1.tag-siemens-batch-03-accepted-final-05.json` and `../../benchmark-report.fixtureDir-benchmarks-siemens-accuracy-speed-20261014-batch-03.isolatedStorage-1.tag-siemens-batch-03-accepted-repeat.json`.
- Both runs passed found, exact official URL, datasheet, device type, and PDT audit gates 5/5. Wrong products: 0; unproven PDT writes: 0; unexplained required-field issues: 0. Four controlled enum skips remained blank.
- Core acquisition: first run 0.526–2.186 s/device (mean 0.882 s, median 0.570 s); cold repeat 0.419–1.823 s/device (mean 0.745 s, median 0.503 s). Every device met the approximately 2.5-second target on both runs.
- Complete benchmark time, including document handling and workbook/PDT export, was 3.549–7.364 s/device (mean 5.199 s, median 4.538 s), reported separately.
