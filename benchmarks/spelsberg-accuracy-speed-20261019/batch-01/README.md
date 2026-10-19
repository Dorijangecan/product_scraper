# Spelsberg batch 01 — electrical mobility and distribution

Status: **accepted**. Both isolated cold runs returned the exact requested product, official product-finder URL, matching product image and datasheet, expected device type, normalized fields, expected source facts, and passing per-item PDT audit. The second accepted run is [`report-cold-03-accepted`](../report-cold-03-accepted.json).

| Article | Type | Official product page |
|---|---|---|
| 20003401 | E-Bike Charging Station | [TG BCS 3 LED](https://www.spelsberg.com/e-bike-charging-stations/with-schuko-sockets/20003401/) |
| 86650201 | Fire-Resistant Junction Box | [WKE 2](https://www.spelsberg.com/fire-protection-cable-boxes/connections-and-junctions/86650201/) |
| 73130801 | Socket Outlet Combination | [STV 1208-S](https://www.spelsberg.com/socket-distributor/pre-wired/73130801/) |
| 73541201 | Small Distribution Board | [AK 12](https://www.spelsberg.com/small-distribution-boards/standard-indoor-installation/73541201/) |
| 59181601 | EV Charging Station | [Wallbox Polar DLM Bundle](https://www.spelsberg.com/wallboxes/smart-pro/59181601/) |

## Extraction rules learned

- Use the exact Product Finder record when it contains article number, name, official URL, image, dimensions, protection, weight and material; otherwise fall back to the exact product page.
- Separate rated operating voltage from rated insulation voltage. The WKE 2's 450 V and STV's 400 V are insulation ratings, not operating ratings.
- Read 230 V Schuko outlet ratings from the named product-finder fields and the exact `equipped with` section.
- Keep only exact-article datasheets and images. Product cards, sibling products and accessory material must not replace product fields.
- Preserve the product's base-unit material and dimensions when datasheets describe accessories or packaging.
- `Polystyrene` encodes to the PDT material legend category `Thermoplast` when that legend is present.

## Before and after

The initial connector path stalled for up to 180 seconds while it fetched unrelated product/accessory pages. The exact-record fast path reduced core connector time to **56–432 ms** in the accepted cold runs (mean **157 ms**, maximum **432 ms**). Full per-item processing, including documents and workbook/PDT output, was **7.9–10.2 s** in the accepted full run; the two Spelsberg articles with unresolved required-field audit entries retain unsupported fields blank rather than inventing an ECLASS/NEMA value.

| Article | Core scrape, accepted cold run | Full pipeline |
|---|---:|---:|
| 20003401 | 432 ms | 9.5 s |
| 86650201 | 94 ms | 10.2 s |
| 73130801 | 92 ms | 8.0 s |
| 73541201 | 85 ms | 7.9 s |
| 59181601 | 82 ms | 8.2 s |

The earlier report [`report-cold-01`](../report-cold-01.json) is retained for comparison. A separate cold attempt had an intermittent document-transfer failure and is documented in [`report-cold-02-doc-failure`](../report-cold-02-doc-failure.json); the final run matched all five required document sets. Core scrape is comfortably below the 2.5 s/device target; the later PDF/document/export stages dominate end-to-end time.
