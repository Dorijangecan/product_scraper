# nVent batch 08 — source accuracy and speed

## Five new product categories

- `G520826G360` — HOFFMAN enclosure air conditioner
- `EN1350` — SCHROFF intelligent PDU
- `CC207` — ERICO transformer-tank grounding connector
- `4Z34812M` — CADDY conduit-to-rod/wire clip
- `F44T3R12` — HOFFMAN Type 3R wireway section

The SKU-only manifest and official URL, document, normalized-field, attribute, device-type, and PDT assertions are in `fixtures.json`.

## Cause and repair

The nVent connector sent previously unseen SCHROFF `EN`, ERICO `CC`, and CADDY `4Z` catalog prefixes to the HOFFMAN route. Exact-page identity checks correctly rejected those pages, leaving the rows failed. The connector now routes `EN` to SCHROFF, `CC` to ERICO, and `4Z` to CADDY before accepting a page only when its canonical URL and exact SKU metadata match.

The exact ERICO title `Transformer Tank Grounding Connector` was classified as a Transformer because of the word “transformer”. It now resolves to Connector. The CADDY “Snap Close Conduit to Rod/Wire Clip” resolves to Mounting Accessory. Both classifications have focused regression coverage.

The former `EB0324` candidate was not retained: current browser navigation returned HTTP 404 for its indexed product URL and the page did not expose exact live product metadata. It is not counted as a scrape pass. The live exact-PDP `EN1350` replaces it.

## Accepted evidence

Both attached reports are isolated-storage live benchmark runs. The five-item cold run and the cold-plus-immediate-repeat run each passed 100% exact identity, official URL, document, device-type, expected normalized fields, expected source attributes, and PDT audits; zero wrong products and zero unproven PDT writes.

| Core scrape pass | Per-device ms | Mean | Median | P90 |
| --- | --- | ---: | ---: | ---: |
| Cold, first five | 9249, 2096, 998, 1271, 1088 | 2940 ms | 1271 ms | 9249 ms |
| Warm, repeated five | 1052, 1636, 1022, 1327, 1021 | 1212 ms | 1052 ms | 1636 ms |
| Both passes, 10 attempts | — | 2076 ms | 1180 ms | 2096 ms |

The first cold nVent browser capture carries the one-time startup cost; the warm five are all below 2.5 seconds. `elapsedMs` additionally includes document/PDF processing and workbook/PDT exports, while `scrapeElapsedMs` is used for the 2.5-second target. The two `EN1350` PDT exports each safely skipped one optional surface-finish enum (`Powder Coated` is not an allowed value in that field); no required field was affected.

## Reports

- `report-cold.json` — independent five-SKU cold run.
- `report-cold-warm.json` — same five SKUs repeated in one isolated process.
