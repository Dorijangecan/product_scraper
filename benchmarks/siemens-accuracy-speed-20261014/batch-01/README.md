# Siemens accuracy and speed batch 01

**Status: accepted.** The five products pass the accuracy gates and the final isolated cold run meets the per-device speed target.

## Sample and novelty

Five previously unseen MLFBs from five device types were selected after checking the benchmark fixtures, Siemens run history, aliases, and cached PDP URLs:

| Product | Type | Exact official product source |
| --- | --- | --- |
| `3RP2525-1AW30` | Timing relay | [Siemens Industry Mall](https://mall.industry.siemens.com/mall/en/DE/Catalog/Product/3RP2525-1AW30) |
| `7KM2200-2EA30-1EA1` | Power meter | [Siemens Industry Mall](https://mall.industry.siemens.com/mall/en/pt/Catalog/Product/7KM2200-2EA30-1EA1) |
| `6ES7155-6MU01-0CN0` | I/O interface module | [Siemens Industry Mall](https://mall.industry.siemens.com/mall/en/US/EN/Catalog/Product/?mlfb=6ES7155-6MU01-0CN0) |
| `6AV2123-2GB03-0AX0` | HMI panel | [Siemens Industry Mall](https://mall.industry.siemens.com/mall/en/qa/Catalog/Product/6AV2123-2GB03-0AX0) |
| `6EP3133-0TA00-0AY0` | DC/DC power supply | [Siemens Industry Mall](https://mall.industry.siemens.com/mall/en/EN/Catalog/Product/6EP3133-0TA00-0AY0) |

## Product review

- **3RP2525-1AW30:** Exact timing-relay identity and image. The technical table supports 12–240 V AC/DC, 3 A operational current at 24 V and 250 V, and 5 A thermal current; the normalized field retains the operating-current context. Device dimensions are 17.5 × 100 × 90 mm and net weight is 0.133 kg. The page describes seven ranges from 0.05 s to 100 h, one change-over contact, LED, and screw terminals.
- **7KM2200-2EA30-1EA1:** Exact SENTRON PAC2200 three-phase energy meter, Modbus TCP, 5 A current input. The current Siemens technical table gives maximum rated 480 V line-to-line and 277 V line-to-neutral; the normalizer preserves that maximum context and leaves device dimensions blank because the available 6-unit modular width is not a physical measurement. Siemens' official PAC2200 equipment manual separately says the intended low-voltage network has rated 400/230 V and that the device can measure up to 480/277 V. These values describe the nominal network and the meter's maximum measuring range respectively, so they are not conflicting ratings. The scraper output accurately records the device's maximum measuring range; 400/230 V is retained here as verified application context rather than substituted into the single normalized voltage field. [Siemens equipment manual, section 2.2](https://support.industry.siemens.com/cs/attachments/109746835/MAN_L1V30415167B-06_en_en-US.pdf).
- **6ES7155-6MU01-0CN0:** Exact ET 200SP MultiFieldbus interface module. 24 V DC nominal with 19.2–28.8 V range; rated current consumption 550 mA, maximum 650 mA; body dimensions 50 × 117 × 74 mm; product API net weight 0.173 kg. The product is an active successor for the older interface unit.
- **6AV2123-2GB03-0AX0:** Exact KTP700 Basic panel, key/touch operation, 7-inch TFT, 65,536 colors, PROFINET; 24 V DC nominal, 19.2–28.8 V range; rated current 230 mA; IP65 front/IP20 rear; net weight 0.977 kg. Body dimensions stay blank because the source exposes separate display, cutout, and enclosure measurements without an unambiguous complete body dimension in this scrape.
- **6EP3133-0TA00-0AY0:** Exact SITOP PSU3400 DC/DC supply. Input 24 V DC (14–32 V), output 24 V DC adjustable 24–28 V, rated output 5 A, 130 W; enclosure 32 × 100 × 100 mm; API net weight 0.4 kg.

All five downloaded Siemens product images were visually reviewed and match the named products. Required datasheet/document checks passed for all five. Five PDT enum values remain blank for review; there are no unproven written values or unexplained required-field issues.

## Repairs

- Added Siemens SENTRON 7KM/PAC device-type evidence so an incidental “internal power supply” phrase cannot classify the meter as a power supply.
- Siemens normalization now ignores packaging dimensions, incomplete geometry, HMI display/cutout geometry, and unlabelled material/color fragments. It prefers the exact product API net weight, preserves Siemens supply and load context, separates SITOP input/output ratings, and marks maximum meter voltages explicitly.
- Field-candidate resolution no longer restores rejected Siemens geometry/material/color guesses.
- The successful exact-product API path now uses the direct MLFB MMPDATA table while keeping the API image and datasheet. Generic detail discovery is reserved for missing base evidence. This avoids a serial BildDB image probe that added about five seconds despite an exact API image already being present.
- `PROJECT_MAP.md` records the Siemens fast path.

## Verification and timing

- `npx tsc --noEmit`: passed.
- Isolated cold baseline report: `../../benchmark-report.manufacturer-siemens.fixtureDir-benchmarks-siemens-accuracy-speed-20261014-batch-01.isolatedStorage-1.tag-siemens-batch-01-initial.json`.
- Final isolated cold run report: `../../benchmark-report.manufacturer-siemens.fixtureDir-benchmarks-siemens-accuracy-speed-20261014-batch-01.isolatedStorage-1.tag-siemens-batch-01-final-cold-repeat.json`.
- Final accuracy gates: found 5/5; exact official URL 5/5; required documents 5/5; device type 5/5; PDT audit 5/5; wrong products 0; unproven writes 0; unexplained required-field issues 0.
- Core acquisition improved from 3.290–9.810 s (mean 5.470 s) to 0.542–2.068 s (mean 0.894 s), with all five at or below 2.5 s on the final cold repeat. Full benchmark time, including document and workbook work, was 4.829–7.637 s (mean 6.230 s) and is reported separately.
- The power-meter voltage distinction is resolved by Siemens' official equipment manual: 400/230 V is the rated low-voltage network, while 480/277 V is the maximum measuring range. The exact product's current technical rows and normalized output correctly preserve the maximum measurement values. The previous hold was removed after reviewing this evidence; proceed to Siemens batch 02.
