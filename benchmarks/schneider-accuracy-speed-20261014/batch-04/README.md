# Schneider Electric accuracy and speed batch 04

## Scope and acceptance

Five new Schneider articles were selected from five distinct product kinds. Each catalog number was checked against benchmark fixtures and reports, the local `run_items` history, product aliases, and cached page URLs before selection; no prior record was found for the final five.

| Catalog number | Device type | Official exact product page |
| --- | --- | --- |
| `TM221CE16T` | Programmable logic controller | https://www.se.com/nl/en/product/TM221CE16T/logic-controller-modicon-m221-16-io-9-di-7-do-transistor-pnp-ethernet/ |
| `A9F74110` | Miniature circuit breaker | https://www.se.com/id/en/product/A9F74110/ic60n-miniature-circuit-breaker-1p-10a-c-curve/ |
| `NSYCRN86200` | Enclosure | https://www.se.com/us/en/product/NSYCRN86200/panelset-crn-plain-door-w-o-mount-plate-h800xw600xd200-ip66-ik10-ral7035-/ |
| `ATS01N206QN` | Soft starter | https://www.se.com/us/en/product/ATS01N206QN/soft-starter-for-asynchronous-motor-altistart-01-ats01-6a-380-to-415v-1-5-to-3kw/ |
| `XACA271H7` | Pushbutton / operator | https://www.se.com/us/en/product/XACA271H7/pendant-control-station-xaca-2-pushbuttons/ |

## Accuracy review and shared fixes

- `TM221CE16T`: the exact description calls this a Modicon M221 logic controller but also mentions its BR2032 backup battery. The classifier initially chose Battery because incidental component text outweighed the product type. The M221 family now wins as a PLC. The PLC's 24 V DC supply and IP20 cover rating are retained; 0.5 A discrete output and the expansion-bus output current are not promoted as device supply current.
- `A9F74110`: the exact PDP gives 10 A, dimensions 85 × 18 × 78.5 mm, weight 0.215 kg, IP20, 10 kA breaking capacity at 220–240 V AC, and 6 kA at 230 V AC. A datasheet row marked `[Ue] rated operational voltage` had been normalized from a 12 V lower operating boundary as `12...60 V AC`. The shared Schneider MCB normalization now uses the exact PDP's voltage-qualified breaking rating (`220...240 V AC`) and leaves the short-circuit capacities in their source context. The A9F family now starts with the exact official `/id/en/` page, avoiding slower locale probes.
- `NSYCRN86200`: exact product data establishes a wall-mounted steel enclosure, 800 × 600 × 200 mm, IP66, IK10, RAL 7035, and 18.138 kg. A trailing parenthesis in the parsed color is removed without dropping the RAL code. The packaging dimensions (including 100 cm and 196 cm pallet values) are not used as device dimensions.
- `ATS01N206QN`: use the exact datasheet's `IcL starter rating` of 6 A and rated supply voltage of 380–415 V; contact/output-current rows are not a substitute for the starter rating. The exact product description also mentions 1.1 kW at 200–240 V, while its page title and datasheet present other 380–415 V motor-power ratings. Motor power is therefore retained with its source context and not flattened into a single normalized value.
- `XACA271H7`: the exact product is a two-button Harmony XAC pendant station. Its matching datasheet gives the AC-15 contact pair 240 V / 3 A, IP65, IK08, and 0.475 kg; the exact product's temperature range is −25…70 °C. The diagrams include several station cut-out variants, and the PDF parser produced an unrelated dimension vector, so normalized dimensions remain blank pending a safely oriented exact two-button measurement. The official product page marks the article discontinued since 2020; identity and documentation are still exact.

All five final images were opened and visually compared with the listed product type/model. The MCB, starter, enclosure, M221 PLC, and two-button pendant images match their expected products. Final identity, official URL, required document/image, type, evidence-backed normalized-field and source-attribute checks, and PDT audit pass 5/5. There are zero wrong products, unproven writes, or unexplained required-field issues. Four PDT controlled-enum values remain blank. The benchmark's PDT fixture coverage is 6/41 sheets; batch acceptance is based on the five requested device records, not coverage of the entire workbook.

## Before and after

The initial cold report was re-evaluated against the final evidence-backed manifest so the field and source comparisons use identical checks. The baseline found all exact products, URLs, and required documents, but classified the M221 as a battery and passed only 1/5 normalized-field checks. Initial mean core scrape time was 4.894 s/device; median was 4.591 s and maximum 6.988 s.

| Metric | Initial cold | Final cold 01 | Final cold 02 |
| --- | ---: | ---: | ---: |
| Found / exact official URL / required docs | 5/5 / 5/5 / 5/5 | 5/5 / 5/5 / 5/5 | 5/5 / 5/5 / 5/5 |
| Correct device type | 4/5 | 5/5 | 5/5 |
| Expected normalized fields / source attributes | 1/5 / 5/5* | 5/5 / 5/5 | 5/5 / 5/5 |
| PDT audit / wrong products / unproven writes | 5/5 / 0 / 0 | 5/5 / 0 / 0 | 5/5 / 0 / 0 |
| Core scrape mean | 4.894 s | 0.576 s | 0.732 s |
| Core scrape median / maximum | 4.591 / 6.988 s | 0.322 / 1.068 s | 0.321 / 1.847 s |
| Full benchmark mean** | 26.331 s | 15.851 s | 16.868 s |
| Full benchmark median / maximum** | 28.812 / 37.861 s | 15.935 / 28.582 s | 15.770 / 30.429 s |

Both final isolated cold runs keep every connector scrape below 2.5 seconds. Core mean is reduced by 88% on final run 01 and 85% on the repeat compared with the initial baseline. Full benchmark time includes document downloads/enrichment and workbook/PDT generation and remains reported separately.

\* Initial attribute checks were recomputed against the final manifest's source patterns; the initial exploratory manifest used narrower patterns. The initial expected-field failure is retained because its wrong values/type were real.

\*\* Full elapsed timings are shown for visibility; they are not the 2.5-second core acquisition target.

## Verification and reports

- Initial baseline: `../../benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-04.isolatedStorage-1.tag-schneider-batch-04-initial.json`
- Accuracy repair rerun: `../../benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-04.isolatedStorage-1.tag-schneider-batch-04-accuracy-01.json`
- Final cold 01: `../../benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-04.isolatedStorage-1.tag-schneider-batch-04-final-cold-01.json`
- Final cold 02: `../../benchmark-report.manufacturer-schneider.fixtureDir-benchmarks-schneider-accuracy-speed-20261014-batch-04.isolatedStorage-1.tag-schneider-batch-04-final-cold-02.json`
- `npx tsc --noEmit` passed.
- Focused device-type, normalizer, field-candidate, and parser checks passed: 15 tests; 758 skipped by the test-name filter.
