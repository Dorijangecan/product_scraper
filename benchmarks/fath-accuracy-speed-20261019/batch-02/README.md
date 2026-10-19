# FATH accuracy and speed — batch 02

Status: **accepted for these five exact articles**. Each passed exact official URL, identity, device type, required normalized fields, important article-specific attributes, exact-code product image, and PDT audit checks. There were no wrong products, unexplained required-field issues, or unproven PDT writes. Core connector time was **0.375–0.782 s/article** (mean **0.495 s**), below the 2.5 s target.

## What the investigation found

The FATH catalog's exact search results often already contain the canonical product detail page. The connector now reuses that response instead of making a second serial request. Product properties, selected article data, and material/surface details are read from the server-rendered HTML. The selected variant must match the requested article number. Image acceptance is also tied to the exact article code; a family or sibling image does not count as proof.

The added device-type rules distinguish these mechanical parts instead of leaving them in a generic cover/accessory category. Their data routes to the existing `cabinet.mechanical` sheet. This batch exercises five additional mechanical types and checks their defining values, including EPDM and slot ranges, catch force, magnetic holding forces, finish, and material.

## Selected articles and official evidence

| Article | Type | Official PDP | Values checked against the exact article |
|---|---|---|---|
| 0810099 | Over-Center Draw Latch | [FATH PDP](https://www.fath24.com/en/Over-Center-Draw-Latch-80/0810099) | Non-locking, powder-coated, zinc die-cast; 112.8 g; image `0810099_p_3d.jpg` |
| 093110 | Door Stop | [FATH PDP](https://www.fath24.com/en/Door-Stop-with-EPDM-Damper-Set/093110) | EPDM damper, slots 8/10, PA/fiberglass body; 26 g; image `093110_p_3d.jpg` |
| 093043 | Ball Catch | [FATH PDP](https://www.fath24.com/en/Ball-Catch-30/093043) | Strong version, approximately 50 N holding force, PA; 45 g; image `093043_p_3d.jpg` |
| 093094 | Magnetic Catch | [FATH PDP](https://www.fath24.com/en/Magnetic-Catch-20-Set/093094) | Set 1, approximately 5 N front / 3 N back, PA; 9 g; image `093094_p_3d.jpg` |
| 093082 | Door Latch | [FATH PDP](https://www.fath24.com/en/Door-Latch/093082) | Slots 8/10, zinc die-cast; 120 g; image `093082_p_3d.jpg` |

All five downloaded images were visually inspected and matched the listed component. The fixture records the exact PDP, normalized weight and material, article-specific attributes, expected device type, and required image for repeatable cold runs.

## Cold-run measurements

| Article | Connector scrape | Full item pipeline | Result |
|---|---:|---:|---|
| 0810099 | 782 ms | 2,077 ms | All item gates passed |
| 093110 | 375 ms | 1,270 ms | All item gates passed |
| 093043 | 506 ms | 2,053 ms | All item gates passed |
| 093094 | 405 ms | 1,330 ms | All item gates passed |
| 093082 | 408 ms | 1,227 ms | All item gates passed |
| **First-run mean** | **495 ms** | **1,591 ms** | **5/5 passed** |

A second isolated cold run reconfirmed all five per-article gates. Core scrape times were **362–788 ms** (mean **485 ms**); full item pipeline times were **1,146–2,110 ms**. This repeat also stayed within the 2.5 s per-device target.

The separate global fixture-coverage gate remains false because this five-item FATH-only run covers one of the workbook's 41 device sheets. The five per-article quality gates all passed; global workbook coverage is a different gate.

Machine-readable fixture: [`fath.json`](fath.json).

Benchmark report: [`fath-batch-02-first-cold-01`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-02.isolatedStorage-1.tag-fath-batch-02-first-cold-01.json).

Repeat cold report: [`fath-batch-02-final-cold-02`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-02.isolatedStorage-1.tag-fath-batch-02-final-cold-02.json).
