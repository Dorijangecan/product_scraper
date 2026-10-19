# Turck accuracy and speed — batch 04

Status: **accepted after two isolated cold runs.** All five devices matched their exact official pages, required images, device types, expected source facts, normalized checks, and per-item PDT audits. Both runs had zero wrong products and zero unproven PDT writes.

## Products and exact official sources

| Catalog number | Type | Official source and key facts |
|---|---|---|
| `Q4XTBLAF100-Q8` (`3091290`) | Photoelectric Sensor | [Exact PDP](https://www.turck.com/de/en/shop/sensors/photoelectric-sensors/3091290): 100 mm range; red 655 nm class 1 laser; 0.15 mm optical resolution; 43.5 × 18 × 57.5 mm; IP67/IP68/IP69; 10…30 V DC. |
| `NCLS-30-UN6X-H1141` (`100004249`) | Level Sensor | [Exact PDP](https://www.turck.com/de/en/shop/sensors/capacitive-sensors/100004249): capacitive immersion level detection; 94.8 × 22 × 22 mm; IP67/IP69K; ambient −10…70 °C and media 0…100 °C kept as separate ranges; 12…32 V DC from the exact EDB. |
| `ES-FA-11AA` (`3002628`) | Safety Relay | [Exact PDP](https://www.turck.com/de/en/shop/machine-safety/safety-relays/3002628): 118 × 22.5 × 84 mm; IP20; 24 V DC ±15%; exact model row in the [Turck Safety Solutions catalog](https://www.turck.com.tr/attachment/211824.pdf) specifies 2 NO safety contacts, 1 NC auxiliary contact, and 7 A output rating. |
| `PSU67-1P-1M-2M5-24150-IOL-F` (`100028304`) | Power Supply | [Exact PDP](https://www.turck.com/de/en/shop/power-supplies/power-supplies-for-the-field-%28ip67%29/100028304): 230 VUC input; 24…28 V DC output; 15 A; 183 × 180.6 × 58.7 mm; IP67. The normalized supply field uses the output voltage and the current field uses rated output current. |
| `IMS-AI-UNI/24V` (`7504009`) | Signal Conditioner | [Exact PDP](https://www.turck.com/de/en/shop/interface-technology/signal-conditioners/7504009): one-channel analog signal isolator; 24 V DC nominal, 16.8…30 V DC operating range; 114.5 × 6.2 × 90 mm; IP20; −20…60 °C. |

The five cover photoelectric sensing, liquid/bulk level detection, safety relaying, field power conversion, and analog signal isolation. The official image files for all five exact SKUs were visually checked; two are manufacturer drawings rather than photographs.

## Repairs

- Turck PDPs use different category paths, which the numeric `/shop/p/{id}` pattern cannot generate. The connector now tries a small set of verified official category routes first and still checks the fetched page for the requested model before accepting it. This avoided the expensive search-and-rescue path for these five devices.
- The Turck safety relay PDP and its EDB omit contact-current details. A reusable exact-row reader now reads Turck's Safety Solutions table, requires the exact model printed on the row, and captures the output rating and contact counts with official source evidence. The PDF text is cached in-process; if it cannot be fetched within 15 seconds, no rating is written from it.
- The power supply's input is 230 VUC while its output is 24…28 V DC at 15 A. Turck power-supply normalization now prioritizes output voltage/current over the input-voltage rows.
- “Signal isolator” is now recognized as a Signal Conditioner. The signal conditioner retains its operating-voltage range (16.8…30 V DC) instead of expecting only its 24 V nominal value.
- Level sensor media temperature remains separate from ambient temperature so the 0…100 °C medium range cannot overwrite the device's −10…70 °C ambient range.

## Isolated cold-run measurements

Reports: [cold 02](../../benchmark-report.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-turck-batch-04-final-cold-02.json) and [cold 03](../../benchmark-report.fixtureDir-benchmarks-turck-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-turck-batch-04-final-cold-03.json).

| Catalog number | Core scrape 02 | Core scrape 03 | Full run 02 | Full run 03 |
|---|---:|---:|---:|---:|
| `Q4XTBLAF100-Q8` | 1,210 ms | 1,189 ms | 28,522 ms | 30,108 ms |
| `NCLS-30-UN6X-H1141` | 1,139 ms | 1,194 ms | 9,368 ms | 9,781 ms |
| `ES-FA-11AA` | 988 ms | 1,097 ms | 11,355 ms | 17,356 ms |
| `PSU67-1P-1M-2M5-24150-IOL-F` | 1,128 ms | 979 ms | 6,073 ms | 6,375 ms |
| `IMS-AI-UNI/24V` | 1,057 ms | 1,016 ms | 6,617 ms | 5,215 ms |
| **Mean** | **1,104 ms** | **1,095 ms** | **12,387 ms** | **13,767 ms** |
| **Median / max** | **1,128 / 1,210 ms** | **1,097 / 1,194 ms** | **9,368 / 28,522 ms** | **9,781 / 30,108 ms** |

Every core scrape met the 2.5-second target. Full run includes image/document retrieval, enrichment, and workbook/PDT export; the larger photoelectric sensor run remains slower than the connector target. The global benchmark sheet-coverage summary is still incomplete because these five items cover only 5 of the full device-sheet inventory; all five item-level PDT audits passed.

Focused device-type, normalizer, and manufacturer tests passed; `npx tsc --noEmit` passed. No full test suite was run.
