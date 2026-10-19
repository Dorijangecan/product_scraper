# Spelsberg batch 03 — junction and protected equipment

Status: **accepted on two isolated cold runs**. The first run matched product identity, official URL, required documents, and all actual source facts for every article, but only classified 1/5 types. It also incorrectly required voltage to remain blank for two products whose official product data explicitly provides 400 V and 690 V operating ratings. The rules below distinguish the exact product classes and retain those operating ratings.

| Article | Type | Verified source facts | Official product page |
|---|---|---|---|
| 40642001 | Junction Box | Abox Pro 060-6²; IP66/IP67/IP69; 690 V insulation; 41 A terminal rating; 5 poles; 6 mm² | [Abox Pro 060-6²](https://www.spelsberg.com/junction-boxes/industrial-environment/40642001/) |
| 73220401 | Socket Enclosure | STG 004; four 230 V Schuko outlets; IP44; 125 × 200 × 122 mm; 0.88 kg | [STG 004](https://www.spelsberg.com/socket-distributor/socket-housing/73220401/) |
| 01009501 | Lightning Protection Enclosure | GBZ 252-40; 400 V operating; 320 × 320 × 179 mm; 4.2 kg | [GBZ 252-40](https://www.spelsberg.com/gti-iso-switchgears/busbar-housing-with-operating-equipment/lightning-protection-housing-gbz/01009501/) |
| 04621501 | NH Fuse Enclosure | GST 2315-250; 250 A busbar; one NH 000 switch disconnector; 690 V operating; 320 × 320 × 179 mm | [GST 2315-250](https://www.spelsberg.com/gti-iso-switchgears/busbar-housing-with-operating-equipment/nh-bus-mounting-fuse-load-circuit-breaker-housing/04621501/) |
| 67040001 | Terminal Block | RK 4² feed-through terminal; 6 × 48 × 47 mm; connection ranges 0.2–6 / 0.2–4 mm²; 0.01 kg | [RK 4²](https://www.spelsberg.com/series-terminal-enclosures/series-terminal-enclosures/67040001/) |

## Corrections applied

- Added primary-function rules and manufacturer family mappings for Abox Pro junction boxes, STG socket enclosures, GBZ lightning-protection housings and GST NH fuse enclosures.
- Added PDT routing for those product classes.
- Corrected the fixture's meaning: Ui values remain insulation ratings; official operating-voltage fields remain normalized where published. Junction-box terminal current is not treated as the operating current of the box.
- No source values were guessed. The terminal-block connection range keeps the manufacturer's unambiguous rigid/flexible order.

## Before and after

| Run | Type / normalized / source facts | Official URLs and documents | Core scrape time |
|---|---:|---:|---:|
| Baseline cold 01 | 20% / 60% / 80% | 5/5 | 85–1,768 ms |
| Repair cold 02 | 100% / 100% / 100% | 5/5 | 60–2,027 ms |
| Accepted repeat cold 03 | 100% / 100% / 100% | 5/5 | 61–2,099 ms; mean 549 ms |

Both accepted runs pass all per-item PDT audits, have no wrong products or unproven PDT writes, and remain below the 2.5 s core-scrape goal. Full item time, including document downloads and workbook/PDT output, is 7.9–9.9 s. Two enclosure rows have blank NEMA-type PDT fields because the Spelsberg records publish IP and IEC data, not NEMA values.

Reports: [`baseline cold 01`](../../benchmark-report.manufacturer-spelsberg.limit-5.fixtureDir-benchmarks-spelsberg-accuracy-speed-20261019-batch-03.isolatedStorage-1.tag-spelsberg-batch-03-baseline-cold-01.json), [`repair cold 02`](../../benchmark-report.manufacturer-spelsberg.limit-5.fixtureDir-benchmarks-spelsberg-accuracy-speed-20261019-batch-03.isolatedStorage-1.tag-spelsberg-batch-03-repair-cold-02.json), [`accepted repeat cold 03`](../../benchmark-report.manufacturer-spelsberg.limit-5.fixtureDir-benchmarks-spelsberg-accuracy-speed-20261019-batch-03.isolatedStorage-1.tag-spelsberg-batch-03-final-cold-03.json).
