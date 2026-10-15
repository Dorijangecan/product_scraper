# Phoenix Contact accuracy and speed — batch 01

Status: **accepted for accuracy and connector speed.** Five previously unused Phoenix Contact articles across five device types passed the exact identity, official URL, type, required image, normalized-field and PDT audit gates. The latest cold isolated rerun has no wrong products, no unproven PDT writes and no unexplained required-field issues. Twelve controlled-enum PDT values remain blank.

## Novelty and exact product evidence

Before the run, all five article numbers were absent from Phoenix `run_items`, product aliases, the page cache, existing benchmark manifests and reports. The manifest is [`phoenix.json`](phoenix.json). Each product resolved to its exact official page; one downloaded official product image per article was visually checked against the listed model.

| Article | Device type | Exact official page | Key source facts checked |
|---|---|---|---|
| 2904602 | Power Supply | [QUINT4-PS/1AC/24DC/20](https://www.phoenixcontact.com/en-us/products/power-supply-quint4-ps1ac24dc20-2904602) | 24 V DC output, 20 A model rating, 1,306 g unpackaged, 130 × 70 × 125 mm, IP20, −25…+70 °C. The official page also publishes 100–240 V AC input; normalized voltage correctly represents the output. Mixed hood/side-element material and family-variant values were left out. |
| 2966171 | Relay | [PLC-RSC-24DC/21](https://www.phoenixcontact.com/en-us/products/relay-module-plc-rsc-24dc21-2966171) | 24 V DC coil, 9 mA input, 6 A continuous contact current, 31.06 g unpackaged, 80 × 6.2 × 94 mm, operating −40…+70 °C. The relay base is IP20; the separate installation-location statement is ≥IP54. |
| 1085039 | Switch | [FL SWITCH 1005N](https://www.phoenixcontact.com/en-us/products/switch-fl-switch-1005n-1085039) | Five-port unmanaged Ethernet switch, 9–32 V DC or 18–30 V AC, maximum 110 mA at 9 V DC, also 19 mA typical at 24 V, 131 g unpackaged, 117 × 22.5 × 84 mm, IP30, −10…+60 °C. The normalized current retains the maximum-current condition. |
| 2981062 | Safety Relay | [PSR-SPP-24UC/ESL4/3X1/1X2/B](https://www.phoenixcontact.com/en-us/products/safety-relays-psr-spp-24ucesl43x11x2b-2981062) | 24 V DC control supply, 70 mA typical supply current, 159.9 g unpackaged, 112 × 22.5 × 114.5 mm, operating −20…+55 °C. The separate 38 mA consumption value applies with S12/S22 inputs; it is retained in source attributes but not substituted for supply current. |
| 1790776 | Surge Protective Device | [VAL-US-SPP-277/50/4+0-R](https://www.phoenixcontact.com/en-us/products/surge-protection-device-val-us-spp-277-50-40-r-1790776) | 277/480 V AC system, 20 kA nominal discharge current, 50 kA SCCR, installed IP20C, 496.4 g unpackaged, 109.1 × 71.2 × 71.5 mm, −40…+85 °C. The 5 mA–1 A remote signal-contact current and SCCR are not used as the discharge current. |

The safety relay's input signal range (0–5 V DC) was kept separate from its 24 V DC control supply. Temperature fields use operating values, not storage rows. The switch's 110 mA maximum at 9 V and 19 mA typical at 24 V are separate operating points; they are not combined.

## Final cold run

Report: [`benchmark-report.manufacturer-phoenix.fixtureDir-benchmarks-phoenix-accuracy-speed-20261014-batch-01.isolatedStorage-1.json`](../../benchmark-report.manufacturer-phoenix.fixtureDir-benchmarks-phoenix-accuracy-speed-20261014-batch-01.isolatedStorage-1.json).

| Article | Connector scrape | Full run (documents, enrichment and export) |
|---|---:|---:|
| 2904602 | 1,081 ms | 22,352 ms |
| 2966171 | 680 ms | 3,772 ms |
| 1085039 | 538 ms | 5,650 ms |
| 2981062 | 534 ms | 11,081 ms |
| 1790776 | 629 ms | 4,317 ms |
| **Mean** | **692 ms** | **9,434 ms** |
| **Median / max** | **629 / 1,081 ms** | **5,650 / 22,352 ms** |

The connector acquisition stage is below the 2.5-second target for all five. Full elapsed time is reported separately and does not meet that target. It includes document downloads and PDF/table enrichment; the QUINT4 full run is the main outlier. The benchmark requires an exact official product image for this batch. Exact product-detail PDF links are present in the result, but four returned HTTP 403 on download; the manifest does not claim those PDFs passed a required-document gate. The image gate passed 5/5.

## Repairs and verification

Shared Phoenix rules added or corrected for this batch:

- Classify `FL SWITCH` as Switch before the broader `FL` family rule.
- Parse the official gallery image and suppress navigation/drawing assets as product images.
- Preserve switch maximum-current voltage context; prefer Phoenix safety-relay supply current; keep surge nominal discharge current distinct from SCCR and remote-contact current.
- Select the exact model's QUINT4 output current and Phoenix unpackaged weight; suppress mixed-version material text.
- Prefer the PSR-SPP control supply over signal-input voltage; map PLC-RSC nominal coil voltage; retain both FL SWITCH voltage ranges and the paired SPD system voltage.
- Read dimensions and operating temperatures from exact reader/PDP evidence, excluding drawings, storage temperatures and unrelated electrical values.

`npx tsc --noEmit` passed. The latest isolated benchmark passed: 100% found, official URL, image gate, device type, expected normalized fields and PDT audit; wrong products 0, unproven PDT writes 0, unexplained required-field issues 0. No test suite was run. The report's broad cross-project sheet-coverage indicator is 5/41 and is not a Phoenix batch acceptance gate.
