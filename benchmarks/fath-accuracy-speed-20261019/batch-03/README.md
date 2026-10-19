# FATH accuracy and speed — batch 03

Status: **accepted for the five articles in [`fath.json`](fath.json)**. The two final isolated cold runs each passed exact identity, official URL, type, normalized weight/material, type-specific source facts, exact-SKU image and PDT audit checks. Both had zero wrong products and zero unproven PDT writes.

## Investigation and repairs

The first candidate set included an Alu Connection Angle (`093W404N10S01`) and a Cube Connector (`093WW304N08S`). FATH did not provide an exact-SKU image on either selected PDP. The old shared gallery images were not identity evidence, so the scraper correctly left both images blank and the required-image gate rejected those candidates. The Cube Connector's initial source-attribute assertion also checked only structured attributes, even though “three aluminum profiles” was in the official description. Those two candidates were replaced; the benchmark now checks both structured attributes and official title/description text so prose-based device facts are testable.

The scraper now classifies tool hooks, swivel casters, cable binders, mounting brackets and label holders from their product names and routes them to the existing `cabinet.mechanical` sheet. Rules are type-based and apply across SKUs. The FATH page for the mounting bracket publishes the pack quantity as `20 Stück` even on its English URL. The raw value is retained; its fixture accepts the observed German unit text rather than changing source data.

## Accepted articles and verified facts

| Article | Type | Official PDP | Type-specific values checked |
|---|---|---|---|
| 6TH240NA9030S01 | Tool Hook | [FATH PDP](https://www.fath24.com/en/Tool-Hook-FX-66-27-13-for-Profiles-40-45-Slot-8-10/6TH240NA9030S01) | 360° turnable; profile slot 8/10; PA holder, SS304 wire; 73.5 g |
| 098S080T4045N | Swivel Caster | [FATH PDP](https://www.fath24.com/en/Swivel-Caster-OE-80-100-125-with-Mounting-Plate-40-45/098S080T4045N) | Ø80, height 111 mm, 1,000 N max load, TPE tread and PP wheel body; 609 g |
| 093291 | Cable Binder | [FATH PDP](https://www.fath24.com/en/Cross-Cable-Binder-Block-D28/a09f13c1eb72427ad000610952da87b4) | D28 tubular frame, cross-cable click-in block; glass-fiber-reinforced PA; 4 g, pack of 100 |
| 099RV28TWS01 | Mounting Bracket | [FATH PDP](https://www.fath24.com/en/Mounting-Bracket-60-x-47-D28-Set/099RV28TWS01) | Connects Ø28 mm tube to slot 10; adjustable slotted holes; zinc-plated steel, M8 x 20 set; 176 g |
| 02021H67100A01 | Label Holder | [FATH PDP](https://www.fath24.com/en/Self-adhesive-Label-Holder-67-2.64/02021H67100A01) | 100 mm; PVC-free plastic, reusable PE foam adhesive; scanner-compatible; 10 g |

All five downloaded product images were visually checked against the exact listed device. The first-run failed image cases are retained in the benchmark report for traceability; they were not silently counted as successes.

## Cold-run timing

| Run | Core connector scrape | Full isolated item pipeline | Per-item gates |
|---|---:|---:|---:|
| Final cold 03 | 403–885 ms (mean 610 ms) | 2,129–3,056 ms (mean 2,380 ms) | 5/5 passed |
| Final cold 04 | 404–1,045 ms (mean 625 ms) | 1,382–2,552 ms (mean 1,756 ms) | 5/5 passed |

The scraper's core work is well below the 2.5 s target in both runs. Full pipeline timing also includes document handling and workbook/PDT exports and varies more; one individual item was slightly above 2.5 s in each run.

Global fixture coverage remains false because this five-item FATH fixture set covers one of the workbook's 41 device sheets. This does not change the five passing per-article gates.

Reports:

- Initial candidates (two exact images unavailable): [`fath-batch-03-first-cold-01`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-03.isolatedStorage-1.tag-fath-batch-03-first-cold-01.json)
- Replacement rerun before description-aware assertions: [`fath-batch-03-replacement-cold-02`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-03.isolatedStorage-1.tag-fath-batch-03-replacement-cold-02.json)
- Accepted cold run: [`fath-batch-03-final-cold-03`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-03.isolatedStorage-1.tag-fath-batch-03-final-cold-03.json)
- Accepted repeat cold run: [`fath-batch-03-final-cold-04`](../../benchmark-report.fixtureDir-benchmarks-fath-accuracy-speed-20261019-batch-03.isolatedStorage-1.tag-fath-batch-03-final-cold-04.json)
