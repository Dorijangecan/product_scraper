# Spelsberg batch 02 — enclosure and building-installation product types

Status: **accepted on two isolated cold runs**. The first run exposed a classifier gap: all five exact articles, product attributes, images and datasheets were found, but device types were only 0% correct (three broad `Enclosure` classifications and two `unknown`). The second run added general product-type terms and Spelsberg family mappings; both final cold runs classify all five products correctly and pass official URL, document, normalized-field, source-attribute and per-item PDT gates.

| Article | Type | Verified source facts | Official product page |
|---|---|---|---|
| 74174501 | Empty Enclosure | GEOS-L 4050-22-to/sw; 400 × 500 × 226 mm; IP66/IP67/IP69; 3.71 kg | [GEOS-L](https://www.spelsberg.com/outdoor-enclosure/empty-enclosure/74174501/) |
| 74910001 | Meter Housing | ZKi 100; 250 × 520 × 193 mm; 400 V operating; IP54/IP65; 2.8 kg | [ZKi 100](https://www.spelsberg.com/meter-housing/meter-housing/74910001/) |
| 98210101 | Installation Housing | IBTLED 1-O; 177 × 200 × 125 mm; IP30; 400 V insulation; 0.318 kg | [IBTLED 1-O](https://www.spelsberg.com/concrete-installation-systems/installation-housing/98210101/) |
| 63510001 | Terminal Block Enclosure | RKi 4/100-100x4²; 100 terminals; 4 mm²; IP54/IP66; Ui 400 V | [RKi 4/100](https://www.spelsberg.com/series-terminal-enclosures/series-terminal-enclosures/63510001/) |
| 36140701 | Channel Installation Box | KD 1 70/47 F2 gn; 80 × 79 × 47 mm; rated insulation voltage 400 V AC | [KD 1](https://www.spelsberg.com/channelsockets/front-mounted/36140701/) |

## Corrections applied

- Added specific device type rules for meter housings, terminal-block enclosures, installation housings, channel installation boxes and empty enclosures, before generic enclosure rules.
- Added Spelsberg family prefixes `GEOS-L`, `ZKi`, `IBTLED`/`IBTronic`, `RKi`/`RK-PV`/`AKi-R` and `KD`.
- Added PDT profiles with no operating voltage/current requirement where the official listing only states insulation voltage. Meter housing uses its official 400 V operating rating.
- No SKU-specific exception was used. Official values not provided stay blank.

## Before and after

| Run | Device-type match | Official URLs / documents / expected fields / source facts / PDT audits | Core scrape times |
|---|---:|---:|---:|
| Baseline cold 01 | 0/5 | 5/5 each | 86–6,890 ms |
| Classifier repair cold 02 | 5/5 | 5/5 each | 38–2,326 ms |
| Accepted repeat cold 03 | 5/5 | 5/5 each | 59–2,431 ms; mean 626 ms |

Both accepted runs remain below the 2.5 s core-scrape target. Full per-item processing was 7.6–10.7 s because documents and workbook/PDT output are included. The cabinet PDT schema requests NEMA-related values for which these Spelsberg product records provide no equivalent official value; those entries remain blank and are the only required-field audit issues. There were no unproven writes, wrong products or rejected quality gates.

Reports: [`baseline cold 01`](../../benchmark-report.manufacturer-spelsberg.limit-5.fixtureDir-benchmarks-spelsberg-accuracy-speed-20261019-batch-02.isolatedStorage-1.tag-spelsberg-batch-02-baseline-cold-01.json), [`classifier repair cold 02`](../../benchmark-report.manufacturer-spelsberg.limit-5.fixtureDir-benchmarks-spelsberg-accuracy-speed-20261019-batch-02.isolatedStorage-1.tag-spelsberg-batch-02-classifier-repair-cold-02.json), [`accepted repeat cold 03`](../../benchmark-report.manufacturer-spelsberg.limit-5.fixtureDir-benchmarks-spelsberg-accuracy-speed-20261019-batch-02.isolatedStorage-1.tag-spelsberg-batch-02-final-cold-03.json).
