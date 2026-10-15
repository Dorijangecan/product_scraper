# Siemens accuracy and speed batch 02

**Status: accepted.** Five novel product types pass the exact-product, source, document, image, normalization, PDT, and cold-acquisition checks.

## Novelty and product review

All five catalog numbers were absent from Siemens run history, aliases, cached URLs, and the existing benchmark manifests/reports when selected. Each product was checked against its exact Siemens page and downloaded datasheet. All five product images were visually reviewed and match their products.

| Product | Type | Exact official product source |
| --- | --- | --- |
| `3RT2016-1BB41` | Contactor | [Siemens Industry Mall](https://mall.industry.siemens.com/mall/en/WW/Catalog/Product/3RT2016-1BB41) |
| `3RB3016-1PE0` | Electronic overload relay | [Siemens Industry Mall](https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb=3RB3016-1PE0) |
| `3UG5512-1AR20` | Phase and line monitoring relay | [Siemens Industry Mall](https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb=3UG5512-1AR20) |
| `6SL3210-5BE25-5UV1` | SINAMICS V20 frequency converter | [Siemens SiePortal](https://sieportal.siemens.com/en-ww/products-services/detail/6SL3210-5BE25-5UV1) |
| `3LD2122-0TK11` | SENTRON switch disconnector | [Siemens Industry Mall](https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb=3LD2122-0TK11) |

## Accuracy repairs and verified fields

- **3RT2016-1BB41:** 24 V DC contactor coil; 9 A AC-3 at 400 V, 4 kW, three poles and one NO auxiliary contact. The current now comes from the exact AC-3 product rating instead of the unrelated 4.1 A AC-4 switching row. Dimensions are 58 × 45 × 73 mm; datasheet net weight is 280.8 g.
- **3RB3016-1PE0:** Electronic overload relay, Class 10E, contactor-mounted, with an adjustable 1–4 A overload trip range and 690 V maximum operating voltage. Dimensions are 45 × 72 × 90 mm; net weight is 0.219 kg. SIRIUS 3RU/3RB family classification now resolves to Overload Relay instead of Motor Starter.
- **3UG5512-1AR20:** Phase-failure, phase-sequence, and asymmetry monitoring. The normalized voltage keeps the 3-phase 160–690 V AC rated monitored range separate from the 160–760 V AC measurable range. The 5 A value is explicitly labeled thermal current of the switching contacts; it is not confused with the 5 mA minimum contact reliability value. Dimensions are 22.5 × 100 × 90 mm; Siemens MMPDATA, API, and generated datasheet agree on 0.137 kg net weight.
- **6SL3210-5BE25-5UV1:** SINAMICS V20 successor variant with integrated braking chopper, 5.5 kW rated power, 3-phase line voltage 380–480 V with −15%/+10% tolerance, and rated voltage classes 400 V IEC / 480 V NEC. LO/HO rated current remains tied to its column context: 12.50 A at 400 V and 11.00 A at 480 V. Dimensions are 184 × 182 × 169 mm; net weight is 2.4 kg; protection is IP20 / UL open type.
- **3LD2122-0TK11:** Three-pole main switch disconnector, 25 A at AC-21A/400 V and 20 A at AC-23A/400 V; rated operating voltage 690 V, IP65. Dimensions are 49 × 71 × 86 mm; net weight is 175 g. The unrelated 4–6 mm mounting hasp thickness is no longer written as device wall thickness.

## Repairs

- Corrected 3RB overload-relay family classification.
- Made Siemens current normalization preserve contactor AC-3, adjustable overload trip, monitoring-relay contact thermal, switch-disconnector AC-21A/AC-23A, and VFD LO/HO contexts.
- Made monitoring-relay normalization distinguish rated monitored voltage from the higher measurable range; retained VFD line-voltage tolerance and IEC/NEC rated classes.
- Restricted Siemens wall-thickness promotion to explicitly named housing, enclosure, or wall measurements, including after PDF enrichment.

## Verification and timing

- `npx tsc --noEmit`: passed.
- Final isolated cold report: `../../benchmark-report.manufacturer-siemens.fixtureDir-benchmarks-siemens-accuracy-speed-20261014-batch-02.isolatedStorage-1.tag-siemens-batch-02-accepted-final.json`.
- Final gates: found 5/5, exact official URL 5/5, datasheet 5/5, expected device type 5/5, PDT audit 5/5, wrong products 0, unproven writes 0, unexplained required-field issues 0. Six controlled PDT enum skips remain blank.
- Core acquisition improved from 0.653–6.034 s/device (mean 3.311 s, median 2.437 s) in the initial cold run to 0.358–2.145 s/device (mean 0.882 s, median 0.638 s) in the accepted cold repeat. All five meet the approximately 2.5-second target.
- Complete benchmark time, including documents and workbook/PDT work, was 4.871–18.047 s/device (mean 8.810 s, median 6.417 s), reported separately.
