# Eaton cold-start audit (2026-08-31)

The ten catalog numbers below were selected after searching the repository's benchmarks,
fixtures, cache references, and previous reports; none occurred there before this audit. Each
was confirmed against the official Eaton SKU page before scraping. PDFs are retained as documents
only; `productUrl` is an Eaton product page.

| Catalog number | Family / official type | Extracted type | Identity / product URL | Key source-checked data | Documents / image | Duration | Result | Fix |
|---|---|---|---|---|---|---:|---|---|
| FAZ-C6/1N | FAZ; supplementary protector | Supplementary Protector | [Eaton SKU](https://www.eaton.com/us/en-us/skuPage.FAZ-C6%7B%7D1N.html) | 6 A, 240 V, 15 kAIC, single-pole, C curve | Datasheet present | 4.129 s | PASS | FAZ family classification corrected from MCB |
| 10250T102 | 10250T; heavy-duty flush pushbutton | Pushbutton / Operator | [Eaton SKU](https://www.eaton.com/us/en-us/skuPage.10250T102.html) | 30.5 mm, red plastic actuator, chrome bezel, momentary, non-illuminated | Datasheet and product image present | 5.568 s | PASS | None |
| 217436 | M22/RMQ-Titan; selector switch | Selector Switch | [Eaton SKU](https://www.eaton.com/us/en-us/skuPage.217436.html) | 3 positions, maintained thumb-grip, 46 × 30 × 30 mm, IP66 | Datasheet / CAD documents present | 16.899 s | PASS | M22-WR family classification corrected |
| 9PX6KSP | 9PX; split-phase online UPS | UPS | [Eaton SKU](https://www.eaton.com/us/en-us/skuPage.9PX6KSP.html) | 5,500 VA / 4,900 W, 120/208 V, 4U, 157.3 lb | Datasheet / manuals present | 9.750 s | PASS | Current is not inferred from VA; UPS gate requires published voltage only |
| SVX060A1-4A1N1 | SVX; adjustable-frequency drive | Variable Speed Drive | [Eaton SKU](https://www.eaton.com/us/en-us/skuPage.SVX060A1-4A1N1.html) | 60 hp, 480 V, three-phase, NEMA 1/IP21, FR7 | Datasheet present | 17.924 s | PASS | Explicit 480 V description fact now normalized |
| 208225 | DILM; Moeller contactor | Contactor | [Eaton SKU](https://www.eaton.com/us/en-us/skuPage.208225.html) | DILM contactor identity and model code confirmed | Datasheet / drawings present | 11.862 s | PASS | None |
| NON-150 | Bussmann Class H; one-time fuse | Fuse | [Eaton SKU](https://www.eaton.com/us/en-us/skuPage.NON-150.html) | 150 A, 250 V, 10 kAIC, Class H | Datasheet present | 3.238 s | PASS | None |
| CAP169114 | Capri NEWCAP CT; cable gland | Cable Gland | [Eaton SKU](https://www.eaton.com/us/en-us/skuPage.CAP169114.html) | PG11, 6–13 mm cable range, nickel-plated brass, IP66/IP68 | Datasheet / declarations present | 31.363 s | PASS | None |
| C5000K2A | MTK; industrial control transformer | Transformer | [Eaton SKU](https://www.eaton.com/us/en-us/skuPage.C5000K2A.html) | 50/60 Hz, epoxy-resin coil, UL/CSA; dimensions and weight extracted | Datasheet present | 3.801 s | PASS | Transformer current is not derived from kVA/V |
| CHSPT2SURGE | CHSPT2; Type 2 surge protection | Surge Protective Device | [Eaton SKU](https://www.eaton.com/us/en-us/skuPage.CHSPT2SURGE.html) | 120/240 V, 36 kA surge, 5 kA nominal discharge, NEMA 4 | Datasheet / install sheet present | 3.035 s | PASS | None |

## Gate evidence

The final isolated run (`BENCHMARK_FIXTURE_DIR=tmp/eaton-cold`) passed all ten rows individually:

- found: 10/10
- official product URL: 10/10
- identity: 10/10
- documents: 10/10
- normalized required fields: 10/10
- device type match: 10/10
- PDT audit: 10/10
- quality accepted: yes
- wrong products: 0

The benchmark JSON is `benchmark-report.manufacturer-eaton.fixtureDir-tmp-eaton-cold.json`.
