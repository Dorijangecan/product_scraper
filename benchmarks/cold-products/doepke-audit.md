# Doepke cold-start audit — 2026-08-31

All ten catalog numbers were absent from prior local fixtures, cache, and benchmark reports. Each
was confirmed on Doepke's official `prodext.php?ARTNR=` product record and tested individually.

| Catalog number | Official family / checked data | Expected / extracted | Official URL | Docs/image | Duration | Result |
|---|---|---|---|---|---:|---|
| 09912076 | DLS 6hdc DC MCB; 2P, B, 3.5 A, 250 VDC, 6 kA | MCB / MCB | official product record | datasheet, manuals, CAD, image | 6,609 ms | PASS |
| 09949125 | DRCBO 4 Type-B SK RCBO; 1+N, C20, 30 mA | RCD / RCD | official product record | datasheet, manuals, CAD, image | 8,379 ms | PASS |
| 09980410 | HS 2 installation contactor; 230 VAC, 25 A, 1 NC/3 NO | Contactor / Contactor | official product record | datasheet, CAD, image | 5,126 ms | PASS |
| 09980715 | RZM 128 time relay | Relay / Relay | official product record | datasheet, image | 7,234 ms | PASS |
| 09920177 | EV-S G fork busbar; 3P, 63 A | Busbar / Busbar | official product record | datasheet, image | 3,319 ms | PASS |
| 09961302 | DAFDD 1 AFDD/fire-protection switch; 2P, 16 A, 30 mA, 240 VAC | Switch / Switch | official product record | datasheet, manual, CAD, image | 10,767 ms | PASS |
| 09500153 | SIR 16 L latching/impulse switch; 24 VDC control, 16 A at 230 VAC | Switch / Switch | official product record | datasheet, manual, image | 5,485 ms | PASS |
| 09340250 | DRCM 1 A residual-current monitor; 85–264 VAC | Current Sensor / Current Sensor | official product record | datasheet, manual, image | 6,600 ms | PASS |
| 09340323 | DCT A-105 residual-current transformer; 105 mm inner diameter, Type A | Transformer / Transformer | official product record | datasheet, manual, image | 6,925 ms | PASS |
| 09146909 | DFS 4 selective RCCB; 4P, 63 A, 300 mA, Type A | RCD / RCD | official product record | datasheet, manual, image | 7,097 ms | PASS |

Repair: added only official Doepke vocabulary that the parser actually emitted: the full RCBO
family wording, plural `time relays`, and `residual current monitor`. The first complete run
reproduced the gaps; focused regression then passed and the full ten-item rerun was 10/10 accepted.
