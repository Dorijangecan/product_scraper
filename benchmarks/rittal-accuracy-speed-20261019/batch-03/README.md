# Rittal accuracy and speed — batch 03

Five new Rittal product classes were checked against exact official variant pages. Each final benchmark used isolated storage; cold runs 08 and 09 were performed after the extraction, normalization, PDT, and classification fixes.

## Products and official evidence

| SKU | Device type | Exact official product page |
| --- | --- | --- |
| 3118000 | Hygrostat | [Rittal 3118000](https://www.rittal.com/com-en/products/PG20231215KLI101/PG20231215KLI1008/PG20240123KLI204/PRO12217?variantId=3118000) |
| 4127210 | Door-operated Switch | [Rittal 4127210](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240403ZUB003/PRO15576?variantId=4127210) |
| 3286300 | Filter | [Rittal 3286300](https://www.rittal.com/com-en/products/PG20231215KLI101/PG20231215KLI1008/PG20240123KLI201/PRO12276?variantId=3286300) |
| 8611200 | Lock Insert | [Rittal 8611200](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240411ZUB101/PG20240327ZUB101/PRO59549?variantId=8611200) |
| 2411601 | Cable Gland | [Rittal 2411601](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240405ZUB003/PG20240405ZUB006/PRO68836?variantId=2411601) |

## Before and after

| Measure | Initial cold run | Final cold 08 | Final cold 09 |
| --- | ---: | ---: | ---: |
| Found / exact official URL | 4/5 / 5/5 | 5/5 / 5/5 | 5/5 / 5/5 |
| Correct device types | 1/5 (20%) | 5/5 (100%) | 5/5 (100%) |
| Expected normalized fields | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| Expected exact source attributes | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| Required saved evidence | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| PDT item audit | 5/5 | 5/5 | 5/5 |
| PDT write issues / required-field issues / unproven writes | 4 / 7 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Full item time, average / maximum | 20.83 s / 51.35 s | 2.19 s / 2.72 s | 2.11 s / 2.63 s |
| Core connector scrape, average / maximum | 0.74 s / 0.98 s | 0.67 s / 0.97 s | 0.63 s / 0.83 s |

The two final isolated runs averaged 2.15 seconds per item, a 90% reduction from the initial cold-run mean. Core connector work averaged 0.65 seconds and remained below one second for every item. Full item time also includes image and workbook/PDT processing, so a few cold item measurements fluctuate slightly above 2.5 seconds.

The final PDT runs leave source-unsupported or structurally unrepresentable cells blank. The hygrostat's voltage ranges do not state the frequency-specific minimum/maximum voltage values requested by four template cells. The door switch publishes separate current ratings paired with four voltages, so its single-current PDT cell is intentionally omitted. The cable gland's source gives `Thread: M12 x 1.5`, which is retained in evidence; the separate `Thread length: 8 mm` is not treated as thread size or thread type. No unsupported value was written.

## Findings and source locations learned

- **Hygrostat:** `Technical specifications` holds contact form, contact load, 50–100% relative-humidity setting range, and ~4% switching difference. `Rated operating voltage`, `Dimensions`, `Colour`, and `Net weight` are separate exact PDP rows.
- **Door-operated switch:** `Design` distinguishes the toggle model. `Electrical connection` gives paired ratings (240 V AC/6 A; 125 V AC/8 A; 24 V AC/6 A; 24 V DC/6 A); `Rated operating voltage` is a separate 400 V value. Do not collapse the paired loads to one current value.
- **Filter mat:** `Material`, three `Dimensions` axes, temperature resistance, `To fit Model No.`, pack quantity, and `Net weight` describe the accessory. Do not classify it as the heat exchanger named in the compatible-product description.
- **Lock insert:** `Supply includes`, `Length`, `Lock`, and `To fit enclosure type` carry its catalog-level facts. A single `Length: 26.2 mm` is not a three-axis product envelope.
- **Cable gland:** `Material` includes both Polyamide 6 and the CR/NBR seal; `IP protection category`, `Thread`, cable-diameter min/max, temperature range, torque, pack quantity, and `Net weight` are explicit. `Height`, `Width across flats`, and `Thread length` are different measurements, not overall Width × Height × Depth.
- Rittal SK/SZ/TS prefixes are broad. When the exact product title names a Hygrostat, Door-operated switch, Filter mat, Lock insert, or Cable gland, that exact wording determines the product class ahead of contextual mentions.
- Rittal's exact PDP definition-list parser retains all adjacent `<dd>` values. The images-only path is used only when exact identity, required source rows, and an official exact-page image are present.

## Verification

- Final reports: `...tag-rittal-batch-03-final-cold-08.json` and `...tag-rittal-batch-03-final-cold-09.json`.
- Initial report: `...tag-rittal-batch-03-baseline-cold-01.json`.
- Rittal/run-manager regression tests and targeted type, quality-gate, and PDT rules passed. Type check `npx tsc --noEmit` passed.

Batch 03 is accepted. Three Rittal batches are now complete; continue with a different manufacturer.
