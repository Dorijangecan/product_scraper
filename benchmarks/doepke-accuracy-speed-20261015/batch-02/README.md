# Doepke accuracy and speed — batch 02

This isolated cold batch covers five new product types: RCBO, fuse-switch disconnector, impulse relay, Dupline digital input board, and Dupline motion detector. The five products were checked against exact Doepke product pages and exact-article data sheets or manual, including the DNP 8E's exact operating manual.

## Acceptance and timing

| Catalog number | Verified device type | Initial core ms | Final cold 01 core ms | Final cold 02 core ms | Final 02 full ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 09915804 | Residual Current Device | 346 | 349 | 356 | 4,500 |
| 09980087 | Fuse Switch Disconnector | 254 | 258 | 243 | 2,427 |
| 09500210 | Relay | 120 | 109 | 113 | 2,526 |
| 09501139 | I/O Module | 120 | 120 | 118 | 4,706 |
| 09501134 | Sensor | 123 | 115 | 133 | 2,314 |

The first run found 4/5 products and passed 3/5 device-type, 0/5 normalized-field, and 0/5 expected-source-attribute checks. Both final cold runs passed exact identity, official URL, required document, device type, normalized fields, expected attributes, and PDT audit 5/5. Wrong products: 0; unproven PDT writes: 0. Five controlled PDT enum values were skipped rather than forced into a nearby value.

All four downloaded product images were visually checked and match the exact SIR 16 M, DBM 1, DNP 8E, and Tytan II devices. The RCBO 1 page links a sibling/representative illustration, so no image is accepted for `09915804`.

The connector core scrape stayed below 0.36 seconds per device on both final runs, well below the 2.5-second target. Full item time includes document download/enrichment and PDT/workbook output: its average fell from 7.498 seconds initially to 3.212 seconds on final cold 01 and 3.295 seconds on the repeat. The DNP 8E time also fell from 24.264 seconds to 4.423–4.706 seconds after excluding the unrelated 5 MB Dupline planning aid. Remaining full-pipeline time is separate from the core scrape target.

## Corrections learned from these devices

- **09915804 RCBO 1:** normalize 230 V AC from the exact data sheet's rated-voltage row, not the 253 V maximum test-circuit operating voltage. Do not treat its representative/sibling image as an exact product image.
- **09980087 Tytan II:** classify the triple-hyphen `fuse-switch-disconnector` wording correctly. Exact PDF rows provide 3 poles, 400 V AC, 63 A, 50 kA, 800 V insulation, and 6 kV impulse withstand.
- **09500210 SIR 16 M:** retain 24 V DC and 4 mA as control supply values; keep the separate 16 A relay-contact rating out of normalized device current.
- **09501139 DNP 8E:** classify the `8-way binary input` as an I/O module. The exact manual provides 24 V DC, 20 mA, eight NPN inputs, 8 V / 17 mA input contact supply/load, and 73 × 59 mm board dimensions. The PCB is open and has no published enclosure protection rating. The exact manual satisfies the technical-document requirement; family-wide Dupline data is excluded from the product's field evidence.
- **09501134 DBM 1:** retain bus consumption as 2.6 mA (max. 3.5 mA), dimensions 55 × 104 × 57 mm, IP40, −10…50 °C, 10 m range, 90° angle, 24 detection zones, and 3 areas. Its exact data sheet says the Dupline bus signal is the operating source and publishes no standalone supply voltage, so voltage remains blank without failing quality.

## Reproducible reports

- Initial cold baseline: `../../benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-02.isolatedStorage-1.tag-doepke-batch-02-initial-cold-01.json`
- Final cold 01: `../../benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-02.isolatedStorage-1.tag-doepke-batch-02-accuracy-repair-04.json`
- Final cold repeat 02: `../../benchmark-report.manufacturer-doepke.limit-5.fixtureDir-benchmarks-doepke-accuracy-speed-20261015-batch-02.isolatedStorage-1.tag-doepke-batch-02-final-cold-repeat-01.json`
- Exact-device fixture expectations: `fixtures.json`
