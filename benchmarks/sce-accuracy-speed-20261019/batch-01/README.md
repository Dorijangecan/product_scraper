# SCE batch 01 — cooling, panel and lighting products

This batch tests five previously unseen SCE SKUs across five functional kinds. Novelty was checked against all 158 SCE runs and `product_aliases`; none of the five SKUs was present.

| Catalog number | Product kind | Correct device type | Official source fields checked |
| --- | --- | --- | --- |
| `SCE-AC5100B120VSS6` | Air conditioner | Air Conditioner | 5100 BTU/h, 120 V, 7.3 A at 50 Hz, 8.7 A at 60 Hz, airflow in both circuits, dimensions, weight, SS6 AISI 316 material |
| `SCE-N12FA66-24VDC` | Filter fan | Filter Fan | 24 V DC, 0.71 A, 86 CFM, model 4611D2003-S, dimensions and ABS-FR construction |
| `SCE-TEMNC` | Normally closed thermostat | Thermostat | 30–140 °F set point, resistive/inductive contact ratings, 24 V DC contact rating, dimensions |
| `PNA22A` | OK-series subpanel | Subpanel | 2200 × 1000 mm enclosure fit, dimensions, ship weight, galvanized steel and included mounting kit |
| `SCE-LF18` | LED enclosure light | Luminaire | 100–260 VAC, 0.105 A, 50/60 Hz, 850 lm, dimensions and steel housing |

All measurements below separate the connector scrape from the complete benchmark item, which also downloads/parses selected documents and writes/audits the workbook and PDT output. Times vary with SCE's network responses.

## What failed first and why

- The first run found all five exact product pages, exact SKU images and valid PDT writes, but only 3/5 device types and 3/5 expected source-fact checks passed. SCE's plural description `Subpanels` was not recognized; air conditioners and filter fans collapsed into the broad `Thermal Management` class.
- Every scrape first posted to Advanced Part Search and then fetched the exact product page. It also fetched a second CAD redirect page even though the exact product page already held the CAD link. Those duplicate requests kept connector time at 3.17–3.95 seconds per item.
- The air-conditioner page linked manuals for 120 V, 230 V, 460 V and R134a variants. Generic discovery ran again after the exact page was found, allowing sibling manuals and unscoped family-table material into the result. The required SS6 manual lists all three stainless variants; the generic PDF parser selected mild steel and did not extract the wrapped 60 Hz current or cabinet-airflow line.
- SCE labels the filter-fan current field `Current (A)` and prints just `0.71` as its value. That exact source field was not previously mapped into normalized current.
- The thermostat page states its ratings as `10 amp`, `1 amp` and `1.25 amp`; an initial fixture incorrectly expected compact `10A`/`1.25A` spellings. The scrape already retained the official prose, and the fixture now checks the source's actual wording.

## Reusable fixes

- SCE now opens `/partnumber_info/?n=<exact SKU>` directly. It keeps the product page's CAD URL and avoids the redundant search POST and CAD redirect fetch.
- Once SCE confirms an exact product page, its linked official documents get the chance to fill remaining fields; broad fallback discovery no longer repeats the same page or attaches sibling model evidence.
- SCE installation links with an explicit model token are retained only if that model is the requested SKU or a base-model prefix of it. For the SS6 air conditioner, the 120 V base manual is retained while 230/460 V and R134a manuals are excluded.
- A focused SCE manual reader checks both the catalog number printed in the PDF and the voltage-specific manual URL. It extracts the 50/60 Hz currents, both air circuits, and the precise `SS`/`SS6` material row. The existing exact PDP remains the source for the shared dimensions and product identity.
- Exact source labels `Current (A)` and `Amps` now normalize as rated current. Air conditioners and filter fans receive dedicated device types and share the cabinet air-conditioning PDT sheet; plural subpanel descriptions resolve as `Subpanel`.
- In quality mode, SCE keeps document links but skips PDF downloads when its exact PDP already meets the required quality gate. The air-conditioner manual remains required while its page-level current value is missing. Explicit full-document download mode still downloads documents as requested.

## Measurements

| Run | Connector scrape mean | Connector scrape range | Complete benchmark mean | Item-level quality |
| --- | ---: | ---: | ---: | ---: |
| Initial cold 01 | 3.395 s/item | 3.169–3.946 s | 22.394 s/item | rejected; type 60%, expected facts 60% |
| Accepted cold 04 | 1.068 s/item | 0.758–1.744 s | 6.104 s/item | 5/5 accepted |
| Accepted repeat cold 05 | 1.088 s/item | 0.789–1.777 s | 7.221 s/item | 5/5 accepted |

The connector scrape is 68.3% faster on average across the two accepted repeats than on the initial cold run; all five connector scrapes are below the 2.5-second target. Four complete item runs are also at or below 2.5 seconds in each accepted repeat. The air conditioner is the exception at 17.444 s and 26.569 s end to end because its exact official PDF is necessary for the 50/60 Hz current and SS6 variant material; cold network and PDF parsing time varies substantially. I am keeping that evidence because omitting it would leave an incorrect material and an incomplete current rating.

Both accepted runs reached 100% exact official URLs, exact image documents, expected normalized fields, expected source attributes and PDT audit, with zero wrong-product matches and zero unproven PDT writes. The reports say overall fixture coverage is not accepted because this five-item sample covers only 3 of 41 PDT sheets; that is a batch-scope metric, separate from these five products' item-level acceptance.

## Evidence reports

- Initial failures and baseline: [first cold 01](../../benchmark-report.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-01.isolatedStorage-1.tag-sce-batch-01-first-cold-01.json)
- Intermediate runs used to isolate current, material and source-fact problems: [repair cold 02](../../benchmark-report.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-01.isolatedStorage-1.tag-sce-batch-01-repair-cold-02.json), [repair cold 03](../../benchmark-report.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-01.isolatedStorage-1.tag-sce-batch-01-repair-cold-03.json)
- Accepted runs: [cold 04](../../benchmark-report.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-01.isolatedStorage-1.tag-sce-batch-01-repair-cold-04.json), [repeat cold 05](../../benchmark-report.fixtureDir-benchmarks-sce-accuracy-speed-20261019-batch-01.isolatedStorage-1.tag-sce-batch-01-final-cold-05.json)
