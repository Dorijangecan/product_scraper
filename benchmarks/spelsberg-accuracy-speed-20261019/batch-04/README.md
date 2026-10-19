# Spelsberg batch 04

Validated five new device classes from exact Spelsberg product records:

| Article | Product | Expected device type |
| --- | --- | --- |
| `97106601` | U 71 DVD-2 | Ceiling Junction Box |
| `97331201` | U 120 GRO-3 | Large Conduit Box |
| `02000201` | GTi 2 VS-KD-t | Distribution Board |
| `78610101` | AKi-T 101 | NH Fuse Enclosure |
| `98700201` | BS 2 | Equipment Installation Box |

The exact product pages and datasheets identified all five articles. The baseline classified 0/5 device types and matched only 3/5 expected normalized field sets. The audit found that insulation voltage (`400 V AC`) had leaked into operating voltage, the slab-thickness limit (`up to 6.5 cm`) had leaked into wall thickness, PDF enrichment had reordered exact product dimensions, and generic field resolution had replaced the PDP's base-unit material.

The scraper now uses Spelsberg family/type evidence for these product classes, rejects insulation voltage and slab limits as operating/physical ratings, and preserves exact PDP dimensions and base-unit material through enrichment, quality gating, and field-candidate resolution. Polypropylene maps to the PDT's `Thermoplast` enum. The exact product type for AKi-T 101 remains the official `NH Fuse Enclosure`; the fixture's initial “NH Fuse Load Circuit Breaker Housing” label was corrected to match the source.

## Baseline and accepted cold runs

| Run | Type | Normalized fields and values | Exact source attributes | PDT audit | Wrong products | Core mean / max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline cold 01 | 0% | 60% | 100% | 100% | 0 | 164 / 456 ms |
| Accepted cold 06 | 100% | 100% | 100% | 100% | 0 | 141 / 457 ms |
| Accepted cold 07 | 100% | 100% | 100% | 100% | 0 | 136 / 424 ms |

Every core scrape is below the 2.5-second target. The full benchmark averages about 8.46 seconds because it also downloads/parses documents and exports the workbook/PDT; those downstream stages are measured separately. Two PDT enum cells for the BS 2's unspecific official `Plastic` value remain blank rather than guessing a material subtype; no unproven values were written. Benchmark fixture coverage remains 3 of 41 PDT sheets and is not a claim of full catalog-sheet coverage.

| Article | Accepted 07 core scrape |
| --- | ---: |
| `97106601` | 424 ms |
| `97331201` | 73 ms |
| `02000201` | 63 ms |
| `78610101` | 59 ms |
| `98700201` | 62 ms |

## Verification

- Accepted cold runs 06 and 07: all five found, exact URLs and required documents 5/5, type and normalized field/value checks 5/5, expected official source attributes 5/5, item-level PDT audits 5/5, no wrong products, and zero unproven PDT writes.
- `npx tsc --noEmit` passed.
- Focused Spelsberg device-type, insulation/slab normalization, and PDT material-enum tests passed.

Reports: [baseline cold 01](../../benchmark-report.manufacturer-spelsberg.limit-5.fixtureDir-benchmarks-spelsberg-accuracy-speed-20261019-batch-04.isolatedStorage-1.tag-spelsberg-batch-04-baseline-cold-01.json), [accepted cold 06](../../benchmark-report.manufacturer-spelsberg.limit-5.fixtureDir-benchmarks-spelsberg-accuracy-speed-20261019-batch-04.isolatedStorage-1.tag-spelsberg-batch-04-final-cold-accepted-06.json), [accepted cold 07](../../benchmark-report.manufacturer-spelsberg.limit-5.fixtureDir-benchmarks-spelsberg-accuracy-speed-20261019-batch-04.isolatedStorage-1.tag-spelsberg-batch-04-final-cold-accepted-07.json).
