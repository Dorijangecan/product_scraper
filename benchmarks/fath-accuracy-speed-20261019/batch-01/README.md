# FATH accuracy and speed — batch 01

Status: **accepted for the five exact articles below**. All five passed exact official URL, identity, type, variant-specific fields, normalized weight/material, exact product image and PDT audit checks. No wrong products or unproven PDT writes. Core connector scrape: **0.337–0.913 s/article** (mean **0.509 s**), below the 2.5 s target.

## What was broken and what changed

The previous connector fetched the search page and PDP serially through `r.jina.ai`; exact FATH searches already redirect to the canonical PDP, so the second fetch duplicated work. The original five-SKU cold baseline took **6.937–15.271 s/article** in the core connector (mean **9.353 s**).

The live Shopware PDP serves its exact product data in HTML. It places general properties in `.properties-row`, variant-specific data in a `Part #` comparison table, and material/surface/color in bold-labelled description sections. The previous Markdown-only parser skipped the selected variant row, did not carry the explicit `(g)` unit from the weight label, and could not reliably read the HTML label sections. The connector now reuses an exact PDP returned by search, parses the HTML and only the table row whose part number equals the requested SKU. A `Weight (g)` numeric cell becomes an explicitly unit-bearing value for the shared mass normalizer.

FATH also reuses gallery images across variants. For example, the page for `0810495` lists that exact SKU in the variant table but uses `0810488_p_3d.jpg`; the page labels it “product image of all versions.” That source does not prove the image shows the requested insert type. The old “largest gallery group” fallback could silently attach this sibling image. It was removed; images are returned only for an exact article code or the narrowly supported numeric length variants. Three original variants therefore correctly have no image evidence. The accepted batch uses article numbers with exact-code images.

The type classifier now distinguishes Compression Latch, Leveling Foot, Quarter Turn Lock, Handle, and Hinge from the generic cover/door accessory bucket; these types route to the existing mechanical PDT sheet.

## Selected five and exact source facts

| Article | Type | Official PDP | Values independently checked |
|---|---|---|---|
| 0810488 | Compression Latch | [FATH PDP](https://www.fath24.com/en/Large-Compression-Latch-22.5-32-ZN-Black/0810488) | Tubular insert; zinc die-cast housing; 86.5 g |
| 098H300606 | Leveling Foot | [FATH PDP](https://www.fath24.com/en/Adjustable-Leveling-Foot/098H300606) | Exact row: 35–50 mm, M6, Ø4.3 mm; PA housing; 38.0 g |
| 0810159 | Quarter Turn Lock | [FATH PDP](https://www.fath24.com/en/Industry-Standard-Quarter-Turn-Lock-22.5-18-SS/0810159) | 22.5/18 SS, double-bit 3.0 mm, IP65/NEMA 4; 95.7 g |
| 092012 | Handle | [FATH PDP](https://www.fath24.com/en/Handle/092012) | Exact row: 120 mm, M5 screw; PA; 30.0 g |
| 09576060E | Hinge | [FATH PDP](https://www.fath24.com/en/Stainless-Steel-Hinge-60-x-60/09576060E) | Non-detachable, SS316; FAmax 1,200 N, FRmax 2,000 N; 222 g |

All five image files were downloaded and visually checked against the listed component type. The target SKUs were absent from FATH run history and exact aliases before the campaign. The machine-readable manifest is [`fath.json`](fath.json).

## Before/after evidence

The first five articles were kept as a separate variant audit so speed could be compared on the same SKUs. Exact identities and official URLs were correct in the initial run. The original output incorrectly returned family images for all five and the benchmark's document gate counted those as present. After the fix, exact identity, official URL, device type, normalized-field, selected-variant and PDT assertions pass, and the three family-image mismatches fail closed.

| Article | Before core scrape | After core scrape | Exact image after strict gate |
|---|---:|---:|---|
| 0810495 | 8,287 ms | 805 ms | No: gallery uses 0810488 |
| 098H501008 | 8,928 ms | 497 ms | No: gallery uses 098H300606 |
| 092012 | 7,344 ms | 431 ms | Yes |
| 0957432 | 15,271 ms | 476 ms | No: gallery uses 0957408 |
| 09576060E | 6,937 ms | 348 ms | Yes |

Mean core time fell from **9,353 ms to 511 ms** (94.5% lower; 18.3× faster); maximum fell from **15,271 ms to 805 ms**. The `variant-audit` intentionally does not pass its required-image gate (2/5). That is why three alternative exact-image SKUs were selected for the accepted five-article batch rather than weakening image identity.

Reports:

- Original cold baseline: [`fath-batch-01-baseline-cold-01`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-01.isolatedStorage-1.tag-fath-batch-01-baseline-cold-01.json)
- Same-SKU variant audit after the fix: [`fath-batch-01-variant-audit-cold-01`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-01-variant-audit.isolatedStorage-1.tag-fath-batch-01-variant-audit-cold-01.json)
- Accepted five-article cold rerun: [`fath-batch-01-final-cold-02`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-01.isolatedStorage-1.tag-fath-batch-01-final-cold-02.json)

The accepted run's per-SKU quality gates passed. The report's separate global fixture-coverage gate is expected to remain false for a five-item FATH-only corpus: it covers one of the 41 workbook device sheets. This is not a failed product-data gate.
