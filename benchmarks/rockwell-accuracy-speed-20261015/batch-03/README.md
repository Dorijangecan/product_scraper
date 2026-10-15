# Rockwell accuracy and speed — batch 03

Status: **product, source, document, normalized-value, device-type, and PDT checks accepted; exact image coverage is 1/5.** The cold final run uses five new products from five device types. `1609-D1000E` is discontinued and has no planned replacement according to the current product page; it is retained here as a valid exact-SKU audit case.

## Products and evidence reviewed

| Catalog number | Device type | Official source | Key evidence checked |
|---|---|---|---|
| `1609-D1000E` | UPS (discontinued) | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.1609-D1000E.html) | Exact description: 1000 VA, 230 V AC input/output; manual 1609-UM009. Mixed 120/230 V tables and a 4.7 A value in the family manual were excluded from this SKU's supply values. The DPP `1609-d.jpg` picture is only a 1609-D family image, so it is omitted as an exact D1000E image. |
| `2711P-T7C22D9P` | HMI | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.2711P-T7C22D9P.html) | PanelView Plus 7 Performance, 7-inch VGA/TFT, Ethernet DLR, 24 V DC; official manual present. |
| `1783-CMS10DN` | Communication Gateway (Stratix 5200 managed switch) | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.1783-CMS10DN.html) | 8 copper + 2 combo ports; IP30; operating −40…60 °C; official datasheet present. No supply voltage was inferred from the Zone 2 peak-rated-voltage note. |
| `856T-BT3` | Stack Light / Beacon | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.856T-BT3.html) | 70 mm green steady LED module, 24 V nominal. Exact official product image was visually checked. Normalized 21…30 V DC and 30 mA are preserved as published rating context. |
| `5069-L306ER` | Programmable Logic Controller | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.5069-L306ER.html) | CompactLogix 5380, 600 KB, 8 I/Os, 16 EtherNet/IP devices; MOD power 18…32 V DC; 98.1 × 123 × 136.81 mm; 0…60 °C. The 300 V continuous isolation rating is not used as supply voltage. |

The HMI, switch, and PLC did not provide an exact product image in this run, so their image fields remain absent. The UPS family image was excluded. Thus the exact-image gate is not 5/5 even though the benchmark's other product checks pass.

## Initial cold baseline and final cold audit

| Product | Initial core scrape | Final core scrape | Final full benchmark |
|---|---:|---:|---:|
| `1609-D1000E` | 3.579 s | 1.332 s | 11.280 s |
| `2711P-T7C22D9P` | 1.869 s | 1.752 s | 16.596 s |
| `1783-CMS10DN` | 1.283 s | 1.165 s | 7.228 s |
| `856T-BT3` | 2.690 s | 0.836 s | 14.850 s |
| `5069-L306ER` | 1.018 s | 0.919 s | 59.865 s |
| **Mean** | **2.088 s** | **1.201 s** | **21.964 s** |

Core acquisition improved by **42.5%** by mean, and the maximum fell from **3.579 s to 1.752 s**. All five final core scrapes are below 2.5 seconds. Full benchmark time includes documents/PDF enrichment and workbook/PDT work; it is reported separately and is not the core scrape target.

Initial report: `../../benchmark-report.fixtureDir-benchmarks-rockwell-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-rockwell-batch-03-initial.json`.

Final accepted cold report: `../../benchmark-report.fixtureDir-benchmarks-rockwell-accuracy-speed-20261015-batch-03.isolatedStorage-1.tag-rockwell-batch-03-final-cold-accepted-03.json`.

## Corrections and acceptance

- Rockwell's exact PDP description is captured as a sourced product-description attribute for 1609-D products. The UPS normalizer keeps 230 V AC input/output and leaves current blank instead of borrowing family-manual values.
- Stratix 5200 uses the exact Environment/IP30 row and formats its exact operating-temperature range with °C.
- CompactLogix keeps MOD supply separate from its 300 V continuous isolation rating, formats W×H×D from the exact PDP rows, and retains temperature units.
- The generic 1609-D DPP image is filtered because it does not prove the D1000E variant.
- `npx tsc --noEmit` passed.
- Final product gates: exact found 5/5; official URL 5/5; required documents 5/5; expected type 5/5; expected normalized values 5/5; expected source attributes 5/5; PDT audit 5/5. Wrong products 0; unproven PDT writes 0; unexplained required-field issues 0. Two controlled PDT enum entries remain skipped.
- The benchmark's broader PDT sheet coverage is 5/41 and therefore `Coverage accepted: no`; the five-product quality result is `Quality accepted: yes`. These are separate gates.
