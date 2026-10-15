# Rockwell accuracy and speed — batch 02

Status: **accuracy accepted; acquisition target met**. This batch contains five SKUs with distinct functions. Novelty was checked against benchmark manifests, Rockwell run history, product aliases, and cached product URLs. An initially considered 1606-XLE120E and its 1606-XLS240E replacement were rejected after SQLite history showed that both had already been scraped.

## Selected products and official evidence

| Catalog number | Device type | Official source | Facts to verify |
|---|---|---|---|
| `1497-B-M1-0-N` | Control circuit transformer | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.1497-B-M1-0-N.html) | 80 VA; 240/208 V, 60 Hz primary; 120 V, 60 Hz secondary; no primary/secondary fuse blocks; no-cover construction. Do not collapse primary and secondary into one unsupported operating voltage/current pair. |
| `1420-V1P` | Power meter | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.1420-V1P.html) | PowerMonitor 500; nominal measuring voltage 120 V line-to-neutral / 208 V line-to-line; control power 100–240 V AC; 5 A nominal / 6 A maximum current input; front is 96 × 96 mm, while depth is a separate panel-mount measurement. |
| `1321-3R80-B` | Three-phase line reactor | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.1321-3R80-B.html) | 80 A line reactor, 0.4 mH. The exact page currently publishes only a small set of technical attributes; do not infer a line voltage from adjacent drive products or family documents. |
| `802T-AMTH` | Standard limit switch | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.802T-AMTH.html) | Active, horizontal non-plug-in, maintained-contact, four-circuit lever switch; NEMA 4/13 oiltight construction; operating −18…54 °C. Do not invent an electrical supply voltage/current where the exact product page does not publish one. |
| `150-C30NBD` | SMC-3 soft starter | [Rockwell product page](https://www.rockwellautomation.com/en-us/products/details.150-C30NBD.html) | Exact description says 30 A, 480 V, 3-phase and 100–240 V AC control. The technical table distinguishes line-connected 10–30 A from delta-connected 17.3–52 A motor ratings; auxiliary-contact values and input current are separate circuits. Open type, IP2X, 110 × 139.7 × 44.8 mm, 0.86 kg, and −5…50 °C. |

The 1420 manual and 1321/1497 technical data documents are official references; family-level tables were used only when their exact product row or model-specific PDP supported the value.

## Initial cold baseline

Report: `../../benchmark-report.fixtureDir-benchmarks-rockwell-accuracy-speed-20261015-batch-02.isolatedStorage-1.tag-rockwell-batch-02-initial.json`.

| Product | Core acquisition | Full benchmark | Initial issue |
|---|---:|---:|---|
| `1497-B-M1-0-N` | 2.238 s | 11.512 s | Shipping weight treated as product mass; DPP width and height overrode the exact un-fused product dimensions. |
| `1420-V1P` | 3.985 s | 22.704 s | Nominal LN/LL measurement pair collapsed to 120 V; 6 A overload used instead of 5 A nominal / 6 A max CT input; packing weight and mixed module/panel geometry normalized. |
| `1321-3R80-B` | 2.922 s | 9.157 s | Misclassified as a variable-speed drive. |
| `802T-AMTH` | 2.162 s | 14.447 s | Classified only as a generic switch; representative image and unrelated electrical rows were not valid exact-product supply ratings. |
| `150-C30NBD` | 3.383 s | 12.078 s | Misclassified as a motor; the 0.6 A auxiliary contact, 200 V lower boundary, and Type 1 SCCR enclosure option were incorrectly promoted to main device fields. |
| **Mean** | **2.938 s** | **13.980 s** | Device type: 2/5; expected normalized fields: 3/5; expected source attributes: 3/5. |

All five exact Rockwell PDPs, required documents, and PDT audits were already present. Wrong products, unproven PDT writes, and unexplained required-field issues were zero.

## Corrections and final cold review

Shared type rules now identify the line reactor, limit switch, and soft starter correctly. Rockwell normalization now keeps the 1497's primary/secondary voltage context and exact no-fuse dimensions while suppressing shipping weight; preserves the 1420's LN/LL, CT-current, front-protection, and temperature context while suppressing mixed measurements/packed weight; labels the 1321 as a line reactor with the 80 A / 0.4 mH rating; leaves unsupported 802T supply voltage/current blank and records NEMA 4/13 construction; and uses the 150 SMC-3's 30 A main-circuit current, 200–480 V operating range, exact dimensions/weight, IP2X, and operating temperature instead of auxiliary-contact or SCCR options.

The 1420, 802T, and 150 product sheets mark their pictures as representative renderings, not the actual product. Those images were excluded. No exact-product image was returned for the other SKUs in this cold run, so the batch does not claim any image as visually verified.

Final isolated cold report: `../../benchmark-report.fixtureDir-benchmarks-rockwell-accuracy-speed-20261015-batch-02.isolatedStorage-1.tag-rockwell-batch-02-accuracy-final-01.json`.

| Product | Core acquisition | Full benchmark |
|---|---:|---:|
| `1497-B-M1-0-N` | 1.870 s | 8.634 s |
| `1420-V1P` | 2.093 s | 16.931 s |
| `1321-3R80-B` | 0.809 s | 6.378 s |
| `802T-AMTH` | 0.903 s | 10.503 s |
| `150-C30NBD` | 1.233 s | 8.237 s |
| **Mean** | **1.382 s** | **10.137 s** |

Core acquisition improved by **53%** from the initial mean; all five products met the 2.5-second target in the final cold run. Full benchmark time includes post-scrape documents and exports and remains separately visible.

Final product gates: exact product found 5/5; exact official PDP 5/5; required documents 5/5; expected device type 5/5; expected normalized values 5/5; expected source attributes 5/5; PDT audit 5/5. Wrong products: 0; unproven written values: 0; unexplained required-field issues: 0. Five controlled PDT enum values remain blank. The benchmark reports `Quality accepted: yes`; its broader global fixture-coverage gate remains 4/41 device sheets and is not used to claim product-field acceptance for this five-item batch. `npx tsc --noEmit` passed. No test suite was run.
