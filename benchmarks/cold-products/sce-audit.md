# SCE cold-start audit — 2026-08-31

Scope: ten catalog numbers absent from the pre-existing regression fixtures, caches, and
benchmark reports. The selected sample deliberately covers distinct SCE families (wall and
fiberglass enclosures, subpanel, lighting, wireway, rack hardware, lock kit, fan, and thermostat).
Every official URL below is the SCE `partnumber_info` PDP. The final run was performed serially,
one catalog number per isolated benchmark fixture.

| Catalog number | Official family and manually checked data | Expected / extracted type | Identity and official URL | Documents / image | Duration | Result / fix |
|---|---|---|---|---|---:|---|
| SCE-6044SC | Screw-cover steel enclosure; 6.13 x 4 x 4 in; NEMA 3R/4/12/13, IP66 | Enclosure / Enclosure | exact / [PDP](https://www.saginawcontrol.com/partnumber_info/?n=SCE-6044SC) | screw-cover manual, CAD, image | 3,668 ms | PASS |
| SCE-302412CHQRFG | Fiberglass quick-release enclosure; 32.19 x 26.19 x 12.29 in; IP66 | Enclosure / Enclosure | exact / [PDP](https://www.saginawcontrol.com/partnumber_info/?n=SCE-302412CHQRFG) | non-metallic-enclosure guide, CAD, image | 4,478 ms | PASS |
| SCE-6P4 | Flat subpanel; 5 x 3 x 0.08 in; white powder coat | Subpanel / Subpanel | exact / [PDP](https://www.saginawcontrol.com/partnumber_info/?n=SCE-6P4) | sub-plate manual, CAD, image | 2,231 ms | PASS |
| SCE-LF18NO | LED fixture without outlet; 2.75 x 18.18 x 4 in; 100–277 VAC | Luminaire / Luminaire | exact / [PDP](https://www.saginawcontrol.com/partnumber_info/?n=SCE-LF18NO) | LED-fixture manual, CAD, image | 3,154 ms | PASS |
| SCE-20RMW | Removable wire cover; 6 x 35 x 20 in; powder-coated steel | Wireway / Wireway | exact / [PDP](https://www.saginawcontrol.com/partnumber_info/?n=SCE-20RMW) | removable-wire-cover manual, CAD, image | 3,690 ms | PASS |
| SCE-72RA19TH | Type-RA rack angle; 61.25 in high; rack-mount hardware | Mounting Accessory / Mounting Accessory | exact / [PDP](https://www.saginawcontrol.com/partnumber_info/?n=SCE-72RA19TH) | rack-angles manual, CAD, image | 2,395 ms | PASS — added exact rack-angle rule |
| SCE-7230SOF19 | Swing-out 19-in rack mounting frame; 72 x 30 in; pivots for rear access | Mounting Accessory / Mounting Accessory | exact / [PDP](https://www.saginawcontrol.com/partnumber_info/?n=SCE-7230SOF19) | swing-out-rack manual, CAD, image | 4,139 ms | PASS — added exact rack-frame rule |
| SCE-PLKJIC | Padlock kit for junction boxes | Lock / Interlock / Lock / Interlock | exact / [PDP](https://www.saginawcontrol.com/partnumber_info/?n=SCE-PLKJIC) | padlock-kit manual, CAD, image | 2,465 ms | PASS |
| SCE-FF44-24VDC | 24 VDC Type 3R/12 filter fan; 5.80 x 5.80 x 3.35 in; IP54 | Thermal Management / Thermal Management | exact / [PDP](https://www.saginawcontrol.com/partnumber_info/?n=SCE-FF44-24VDC) | fan/filter manual, CAD, image | 12,450 ms | PASS |
| SCE-TEMNO | Normally-open thermostat; 30–140 F; 10 A 120–250 VAC resistive, 1.25 A 24 VDC | Thermal Management / Thermal Management | exact / [PDP](https://www.saginawcontrol.com/partnumber_info/?n=SCE-TEMNO) | thermostat manual, CAD, image | 8,241 ms | PASS |

## Reproduction and repair

Initial serial cold run found the exact official products for every item, but the two rack
accessories had no type. Their official SCE descriptions are `Angle, Rack` and `Frame, Swing Out
Rack Mounting`; neither phrase was represented in the type classifier. The repair adds only those
two narrow phrase forms to `Mounting Accessory`, plus a focused unit test. The focused regression
test passed, then the complete ten-item set was rerun.

Final cold-only result: 10/10 `found`; 10/10 exact identity; 10/10 official URL; 10/10
documents and image; 10/10 expected type; 10/10 PDT audit. No timeout, partial result, wrong
product, unproven write, or quality-gate relaxation was accepted.
