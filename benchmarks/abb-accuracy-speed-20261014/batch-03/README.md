# ABB cold batch 03

Five unseen ABB products were selected across motor protection, analog I/O, current measurement, fuse switching, and contactors. Their catalog numbers were checked against earlier ABB benchmark batches. The exact ABB pages confirmed the requested IDs, and the five downloaded product images were visually checked against the product type.

## Product accuracy review

| Catalog number | Verified type | Product-specific details reviewed |
| --- | --- | --- |
| `1SAM350000R1005` | Motor circuit breaker / manual motor starter | MS132-1.0, 3 poles, 0.63–1.0 A setting range, 1 A rated operating current, 0.25 kW AC-3 at 400 V, 690 V AC main circuit rating, trip class 10, and 100 kA service breaking capacity at 400 V AC. Exact ABB page links the datasheet and manuals. |
| `1SAP250600R0001` | I/O module | AI531, eight analog inputs, input types U/I/RTD/resistance/thermocouple/digital, 16-bit resolution including sign, 1–4-wire connection, 24 V DC process supply, and IP20 housing. ABB Help's exact AI531 technical pages are attached as official technical documentation. |
| `2CSG111080R1141` | Current transformer | CTA/40, 40 A primary to 5 A secondary, 20 VA output, ±0.5% accuracy, FS 5, 50–60 Hz. The normalized current is the primary rating; both sides of the ratio remain in the source-backed attributes. |
| `1SEP201428R0001` | Fuse switch disconnector | XLP000-6CC, 3 poles, NH000/NH00C fuse size, 100 A rated current, 400/500/690 V AC, baseplate mounting, and 50 kA conditional short-circuit rating at 690 V. Exact ABB page links the datasheet. |
| `1SBL136201R2100` | Contactor | AF09Z-40-00-21, 4 poles, 9 A AC-3 at 400 V, 25 A AC-1 at 690 V, 4 kW AC-3 at 400 V, operational rating up to 690 V, and 24–60 V AC / 20–60 V DC coil. The normalized current uses the motor-duty AC-3 rating rather than the 35 A free-air thermal rating. Exact ABB page links the technical sheet. |

## Corrections applied

- ABB analog input modules now classify as `I/O Module`, ahead of ABB's broader PLC ECLASS label when the exact product description says analog input module.
- Current transformers and fuse switch disconnectors receive their specific device types and route to the measurement and fuse/switch PDT sheets.
- The CP-style generic contactor current selection is corrected for ABB contactors: when the exact ABB product page supplies AC-3 current at 400 V, that motor-duty rating is normalized instead of free-air thermal current.
- AI531's official ABB Help source now contributes its configurable-input fact and technical-data document link. Its analog-input count, signal types, resolution, supply, and protection remain tied to ABB product/help sources.

## Final cold accuracy and speed pass

Report: `../../benchmark-report.manufacturer-abb.fixtureDir-benchmarks-abb-accuracy-speed-20261014-batch-03.isolatedStorage-1.tag-final.json`

The final isolated cold pass accepted all 5/5 products. Exact identity, official URL, required documentation, device type, expected normalized fields, and PDT audit each passed 5/5. There were no wrong products or unproven written values. One optional generic PLC `Function` enum was safely skipped because the source value describes analog input signals, not one of the PDT switch-function legend values.

| Catalog number | Acquisition ms | Total benchmark ms |
| --- | ---: | ---: |
| `1SAM350000R1005` | 3,353 | 4,616 |
| `1SAP250600R0001` | 2,201 | 3,320 |
| `2CSG111080R1141` | 1,031 | 1,793 |
| `1SEP201428R0001` | 1,311 | 2,171 |
| `1SBL136201R2100` | 2,850 | 3,830 |

Acquisition median is 2,201 ms and mean is 2,149 ms. Three of five items were below 2.5 seconds in this cold sample. Repeat cold passes varied for the slower ABB page fetches; a separate accuracy-and-speed run measured 1,048–3,513 ms acquisition with a 1,655 ms median and 1,982 ms mean. The target is close on average but is not yet a reliable per-item ceiling. Total benchmark time also includes workbook and PDT export and has a 3,320 ms median in the final pass.

## Verification

- Focused tests passed: 4 selected classifier, ABB normalization, and PDT resolver tests.
- `npx tsc --noEmit` passed.
- The unrelated full normalizer-suite failures remain the existing physical-value precision expectations recorded in prior batch notes; the new ABB-focused cases pass.
