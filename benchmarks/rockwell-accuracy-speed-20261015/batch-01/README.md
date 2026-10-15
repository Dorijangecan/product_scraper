# Rockwell accuracy and speed batch 01

**Status: accepted.** Two final isolated cold runs of the same five new devices passed the exact-product, source, required-document, normalized-value, expected-attribute, device-type, and PDT gates. Every core scrape was below 2.5 seconds on both runs.

## Products and source review

| Catalog number | Device type | Official product source | Key reviewed values |
| --- | --- | --- | --- |
| `25B-D2P3N104` | PowerFlex 525 variable-speed drive | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.25B-D2P3N104.html) | 380–480 V AC, 3 phase; 2.3 A; 0.75 kW; 137.16 × 228.6 × 233.68 mm; 1.361 kg; IP20 NEMA/Open Type. The exact-page description supplies the voltage-class context and protection. General operating temperature remains blank because available temperature text is not a general device operating rating. |
| `100-C09D10` | IEC contactor | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.100-C09D10.html) | 110 V AC at 50 Hz / 120 V AC at 60 Hz coil; 9 A maximum load current; 54.25 × 85.05 × 81.58 mm; 0.39 kg. Enclosure protection and general operating-temperature bounds remain blank where the exact sources do not establish them. |
| `140MT-C3E-B25` | Motor-protection circuit breaker | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.140MT-C3E-B25.html) · [exact configurator cutsheet](https://configurator.rockwellautomation.com/api/Product/140MT-C3E-B25/cutsheet) | 480 V, 60 Hz; adjustable thermal-current range 1.6–2.5 A; 60.96 × 83.82 × 137.16 mm; 0.277 kg. The exact product image is not accepted: Rockwell labels the rendering “Representative Rendering, Not The Actual Product,” so the image is omitted despite an exact-SKU filename. |
| `440R-S13R2` | Guardmaster single-input safety relay | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.440R-S13R2.html) | 24 V DC control supply; no supply current is inferred from output ratings; output rating remains qualified as UL C300, AC-15 1.5 A/250 V AC and DC-13 2 A/24 V DC; IP40 (NEMA 1); 119.4 × 22.5 × 113.6 mm; 0.245 kg; −5…55 °C. |
| `871TM-M5NP18-D4` | Inductive proximity sensor | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.871TM-M5NP18-D4.html) | 10–30 V DC; 18 × 63.5 mm; 0.101 kg; stainless steel 304; IP68/IP69K; −25…85 °C. Supply current remains blank because the exact page does not establish it. |

All five resolve to exact Rockwell product URLs and device types. The expected datasheet/document checks pass for 5/5. Only the 440R-S13R2 image is returned: its exact Rockwell image URL and model were visually checked. Images remain omitted for 25B-D2P3N104 (representative frame rendering), 100-C09D10 (available frame image identifies a C23 contactor, not C09), 140MT-C3E-B25 (Rockwell explicitly says the image is not the actual product), and 871TM-M5NP18-D4 (available image identifies the wildcard MXXX family, not the exact M5NP variant).

## Shared fixes and learned source rules

- Rockwell's exact PDP description is now parsed for an explicitly labeled voltage class when it publishes a range and phase count, and for enclosure protection when the same exact description states an IP/NEMA class. This preserves the PowerFlex 525's 380–480 V AC, 3-phase context rather than using its separate 480 V nominal input row.
- Safety relays now use the exact PDP's labeled `Rated control supply voltage at DC` as their control supply. Output-contact current is not promoted to supply current.
- A product's exact-SKU image filename no longer overrides Rockwell's explicit representative-rendering disclaimer.
- Independent Rockwell source fetches begin together; each response is parsed as soon as it arrives. Localized German product descriptions are fetched concurrently after the exact English PDP is identity-checked.
- Rockwell's configurator cutsheet is deferred only for 25A/25B PowerFlex drives, 440R safety relays, and 871TM sensors. The exact PDP/DPP path must prove the model-specific rating rows, required normalized fields, dimensions, weight, and an exact-PDP datasheet first. If any required evidence is missing, the configurator cutsheet is fetched as a fallback. Other device families continue fetching the cutsheet in parallel.
- For structured Rockwell PDPs, the generic parser skips a second full serialized-page URL scan after retaining hidden DOM links, embedded document data, and normal anchor links. The final datasheet and source-attribute gates still pass on both cold runs.

## Verification and timing

- `npx tsc --noEmit`: passed after the final parser and image-filter changes.
- Initial isolated timing report: `../../benchmark-report.manufacturer-rockwell.fixtureDir-benchmarks-rockwell-accuracy-speed-20261015-batch-01.isolatedStorage-1.tag-rockwell-batch-01-initial-cold-final-selection.json`.
- Final isolated cold run 01: `../../benchmark-report.fixtureDir-benchmarks-rockwell-accuracy-speed-20261015-batch-01.isolatedStorage-1.tag-rockwell-batch-01-final-accuracy-speed-01.json`.
- Final isolated cold run 02: `../../benchmark-report.fixtureDir-benchmarks-rockwell-accuracy-speed-20261015-batch-01.isolatedStorage-1.tag-rockwell-batch-01-final-accuracy-speed-02.json`.

| Metric | Initial cold baseline | Final cold 01 | Final cold 02 |
| --- | ---: | ---: | ---: |
| Core acquisition mean | 4,333 ms | 1,514 ms | 1,473 ms |
| Core acquisition median | 3,392 ms | 1,257 ms | 1,235 ms |
| Core acquisition range / maximum | 2,075–8,718 ms | 1,228–2,381 ms | 908–2,461 ms |
| Full benchmark mean | 22,005 ms | 14,000 ms | 13,735 ms |

The final core means are about 65% and 66% below the initial baseline. The initial timing run predates the strict source-value assertions and is used only as a timing baseline. Both final runs pass found, exact official URL, required document, device type, normalized fields, expected source attributes, and PDT gates 5/5. Wrong products: 0; unproven PDT writes: 0; unexplained required-field issues: 0. Seven PDT enum values remain blank rather than being forced into a nearby controlled value. Full benchmark time includes document and image handling plus workbook/PDT work; it remains visible separately and is not the 2.5-second core-acquisition measure. The benchmark CLI exits with status 1 for the isolated five-product subset because global PDT device-sheet coverage is 6/41; its product quality summary is accepted.
