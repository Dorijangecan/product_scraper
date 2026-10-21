# Wöhner accuracy and speed, batch 01

Five previously unprocessed Wöhner SKUs spanning switching, fuse switching, power supply, current measurement, and current transformer devices. Selection and expected facts come from the exact Wöhner PIM article pages linked below.

## Final acceptance

The `batch-01-speed-100ms-h1` rerun passed the benchmark quality and coverage gates: 5/5 exact identities, official URLs, device types, normalized field checks, source-attribute checks, and PDT audits; no wrong products or unproven writes.

| SKU | Exact type | Identity | Main verified data | Image and documents |
| --- | --- | --- | --- | --- |
| `23003 000AD` | Disconnect Switch | [PIM article 1000239991](https://pim.woehner.de/EN/EN/Panel_switch_disconnectors_fuse_switch_disconnectors_and_hybrid_motor_starters_for_panel_mounted/Switch_disconnectors_%28without_fuses%29_3-pole/up_to_250_A/1000239991) | CAPUS Panel; 3-pole; 250 A; 690 V AC; 205 × 135 × 65 mm; 180.0 kg/100; EAN 4021267230036 | PIM warns the picture may show a similar product, so no image was accepted. Exact-page links include data sheet, mounting instructions, CAD drawings, and EU declaration. |
| `33803 000A` | Fuse Switch Disconnector | [PIM article 1000236607](https://pim.woehner.de/EN/EN/System/60Classic_630_A_%28800_A%29_2500_A/NH_fuse_switch_disconnectors/size_000/1000236607) | QUADRON 60Classic; NH 000; 125 A; 690 V AC; suitable for 5-pole system; 49.5 × 200 × 117 mm; EAN 4021267338039 | Similar-product image warning; not used. Exact-page links include mounting instructions, CAD drawings, dimensioned drawing, and EU declaration. |
| `36203 000A` | Power Supply | [PIM article 1000313016](https://pim.woehner.de/EN/EN/System/CrossBoard/electronic_components/power_supplies/1000313016) | BROOME20 CrossBoard; 20 A; 380–500 V AC input / 24 V DC output; 49.5 × 160 × 150 mm; 75.0 kg/100; EAN 4021267362034 | Similar-product image warning; not used. Exact-page links include operation instructions, installation instructions, and EU declaration. |
| `36400 000A` | Current Sensor | [PIM article 1000255071](https://pim.woehner.de/EN/EN/Measurement_technique/Measurement_CB/CrossMT/1000255071) | CrossMT measuring module; 100 A; 600 V; IO-Link; status LEDs; 45 × 185 × 25 mm; EAN 4021267364007 | Similar-product image warning; not used. Exact-page links include operation/installation instructions, CAD drawings, dimensioned drawing, and EU declaration. |
| `33744 000` | Current Transformer | [PIM article 1000155889](https://pim.woehner.de/EN/EN/1000155889) | CT5; 150 A primary / 5 A secondary; 1.5 VA; class 1; 720 V Um; 49 × 27 × 70 mm; 14.0 kg/100; EAN 4021267337445 | Similar-product image warning; not used. Exact-page links include CAD drawings, dimensioned drawing, and EU declaration. |

The scraper retained the exact-page document links but did not download or parse shared general-technical-information PDFs as SKU data. The listed PDFs/CAD files have not been independently opened in this batch; their labels and links are preserved from each exact PIM article's Downloads section. Product images remain absent pending an exact-SKU image source without the PIM warning.

## Repairs learned from this batch

- Changed the Wöhner search region from `EN/US` to `EN/EN`; the former returned empty results in the browser-rendered search flow.
- Replaced whole-heading comparison with exact catalog-token matching, so spaced Part No. values are not truncated or rejected.
- Parse only the exact article wrapper and keep its product description; related-product sections no longer supply the device type or facts.
- After exact identity is proven, stop broad fallback. Wöhner's shared technical-information PDF added unrelated current and dimensions to the transformer.
- Exclude the generic technical-information link and a non-PDF “Product description (PDF)” anchor; keep document links from the article's download section.
- Reject PIM images carrying the “picture may show a similar product” warning.
- Preserve paired AC/DC supply ratings, primary/secondary transformer current, and Wöhner W × H × D dimensions; do not map busbar conductor thickness into enclosure wall thickness.
- Classify an identity-confirmed article from its exact heading. CrossMT pages use the exact product route plus Part No. because the heading itself only says “measuring module”.

## Comparable benchmark results

| Run | Found / identity / type / expected attrs / PDT | Core scrape mean | Core scrape per SKU | Full isolated elapsed mean |
| --- | --- | ---: | --- | ---: |
| Initial EN/EN lookup before exact-token repair | 0/5 found; no product identities resolved | 15.6 s | 18.5, 14.8, 14.8, 15.1, 14.8 s | 15.8 s |
| EN/EN + exact-token fix, before article cleanup | 5/5 found; 3/5 types correct; sibling/document contamination remained | 6.4 s | 10.6, 5.5, 5.6, 5.2, 5.3 s | 51.7 s |
| Final, after article cleanup and speed tuning | 5/5 across all acceptance checks | 3.1 s | 5.3, 2.4, 2.4, 2.7, 2.7 s | 6.1 s |

The final run averaged 3.1 s including the cold browser startup; the four warm items averaged 2.56 s. All five passed with the 100 ms network-idle cap plus an H1 wait and exact identity validation. These results are from isolated benchmark runs with PDT export, so the full elapsed column includes that export path. The speed target is approximately met after browser warmup; the first cold lookup remains slower.

## Reports

- [Initial cold EN/US report](../../benchmark-report.manufacturer-woehner.limit-5.fixtureDir-benchmarks-woehner-accuracy-speed-20261021-batch-01.isolatedStorage-1.tag-batch-01-initial-cold-en-en.json)
- [After exact-token repair](../../benchmark-report.manufacturer-woehner.limit-5.fixtureDir-benchmarks-woehner-accuracy-speed-20261021-batch-01.isolatedStorage-1.tag-batch-01-after-exact-token-fix.json)
- [Final accuracy and speed run](../../benchmark-report.manufacturer-woehner.limit-5.fixtureDir-benchmarks-woehner-accuracy-speed-20261021-batch-01.isolatedStorage-1.tag-batch-01-speed-100ms-h1.json)
