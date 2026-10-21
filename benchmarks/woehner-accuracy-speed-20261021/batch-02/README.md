# Wöhner accuracy and speed, batch 02

Five new Wöhner PIM articles spanning a support, adapter, protective cover, fused panel switch-disconnector, and instrumented inline fuse switch-disconnector.

## Final acceptance

`batch-02-final-accuracy` passed 5/5 for exact identity, official URL, expected type, normalized fields, expected source attributes, required documents and PDT audit. No wrong products or unproven PDT writes.

| SKU | Type | Verified exact-page data | Docs / image handling |
| --- | --- | --- | --- |
| `01422 000` | Busbar | [PIM 1000066653](https://pim.woehner.de/EN/EN/System/60Classic_630_A_%28800_A%29_2500_A/Busbar_supports_busbars_and_covers/3-pole_60mm_System_classic/1000066653): 3-pole support for TCC section busbars; IEC rated voltage 800 V; EAN 4021267014223. Current intentionally blank: support is not a current-carrying rated-current device. | 3D PDF/STP, 2D DXF, dimensioned drawing, EU declaration. No accepted exact-SKU image. |
| `32116 000AC` | Busbar | [PIM 1000268843](https://pim.woehner.de/EN/DE/System/60Classic_4P/Adapters/adapters_630A/Adapter_630A_4P_left_b/1000268843): EQUES 4-pole adapter; title says 630 A, IEC rated current is 560 A; 690 V AC; 184 × 300 × 52 mm; EAN 4021267321161. | Mounting instructions, 3D PDF/STP, 2D DXF. No accepted exact-SKU image. |
| `01251 000` | Busbar | [PIM 1000044165](https://pim.woehner.de/EN/DE/System/185Power_2100_A/Busbar_supports_busbars_and_covers/cover_compartment/1000044165): touch-protection cover for 40–60 × 10 mm busbars; 1000 × 13 × 70 mm; 17.6 kg/100; EAN 4021267012519. Material blank; the only copper material candidate belonged to unrelated sibling plain text. | 3D PDF/STP, 2D DXF, dimensioned drawing, German GAEB spec, EU declaration. No accepted exact-SKU image. |
| `33337 000` | Fuse Switch Disconnector | [PIM 1000049788](https://pim.woehner.de/EN/DE/marketing/1000049788): CAPUS panel switch-disconnector with fuses, 3-pole, NH 00 / 160 A, 690 V AC; EAN 4021267333379. | Mounting instructions, 3D PDF/STP, 2D DXF, two dimensioned drawings, EU declaration. No accepted exact-SKU image. |
| `37530 000A` | Fuse Switch Disconnector | [PIM 1000364026](https://pim.woehner.de/EN/EN/System/185Power_2100_A/NH_in-line_fuse_switch_disconnectors/fuse_disc_size_00/fuse_disc_size_00_3-p_switch_333/1000364026): QUADRON inline size 00, 3-pole, title 160 A; technical rated current 150 A; includes three CTs rated 150 A / 333 mV, class 0.5; EAN 4021267375300. | Mounting instructions, dimensioned drawings ×2, EU declaration. No accepted exact-SKU image. |

Image candidates were not treated as verified product images in this benchmark; this batch's evidence report contains no image payloads. Documents are exact article-linked PIM download entries; the benchmark verifies their presence and labels, not independent content review. Shared technical-information PDFs are not used as exact-model field evidence.

## Repairs learned

- Classify the phrase “switch disconnector with fuses” as `Fuse Switch Disconnector`.
- Read current only from supported explicit rated-current labels; do not map peak withstand current or short-circuit current to normalized current.
- Do not infer material from shared Plain Text/sibling data when the exact SKU has no structured material property.
- Continue suppressing `wallThickness` for Wöhner busbar products; dimensional thickness is not enclosure wall thickness.
- Keep identity and field candidates tied to the exact PIM article and reject attributes whose name identifies another article.

## Comparable timing

| Run | Accuracy | Core scrape per SKU | Mean |
| --- | --- | --- | ---: |
| `batch-02-final-accuracy` | 5/5 accepted | 5.679, 2.568, 2.703, 2.837, 2.656 s | 3.289 s; warm mean 2.691 s |

The approximately 2.5 s target is close after warm-up, not yet consistent across all products. Cold browser startup is visible in the first SKU.

## Reports

- [Final accuracy run](../../benchmark-report.manufacturer-woehner.limit-5.fixtureDir-benchmarks-woehner-accuracy-speed-20261021-batch-02.isolatedStorage-1.tag-batch-02-final-accuracy.json)
