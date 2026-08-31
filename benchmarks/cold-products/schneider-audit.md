# Schneider Electric cold-start audit — 2026-08-31

All ten references were absent from the regression fixtures, caches and prior benchmark reports before selection. Official product pages/datasheets were checked manually. The first pass reproduced two defects: Schneider's protected pages could spend the full timeout in browser/distributor retries, and the ontology reports TeSys thermal overload relays as `Motor Starter`. The smallest fix was a Schneider reader-only fallback with one ranked datasheet, plus fixture alignment to the existing ontology. BMXP342020 was excluded after a reproducible 180 s timeout and replaced by the officially documented TM221CE16R.

| Catalog no. | Family / official type | Expected → extracted | Identity / official URL | Key data checked | Docs/image | Duration | Result / repair |
|---|---|---|---|---|---|---:|---|
| LC1D09BD | TeSys Deca contactor | Contactor → Contactor | [official product](https://www.se.com/us/en/product/LC1D09BD/) | 9 A, 24 V DC coil, 3-pole | datasheet + image | 16.2 s | PASS |
| LRD08 | TeSys Deca thermal overload relay | Motor Starter → Motor Starter | [official product](https://www.se.com/us/en/product/LRD08/tesys-deca-thermal-overload-relay-2-5-to-4-a-class-10a/) | 2.5–4 A, class 10A | datasheet + image | 19.3 s | PASS; ontology mapping |
| GV2ME10 | TeSys GV2 motor circuit breaker | Motor Circuit Breaker → Motor Circuit Breaker | [official datasheet](https://www.se.com/in/en/download/document/Datasheet_GV2ME10/) | 2.5–4 A motor protection range | datasheet + image | 18.8 s | PASS |
| ABL8MEM24012 | Phaseo regulated power supply | Power Supply → Power Supply | [official product](https://www.se.com/pt/pt/product/ABL8MEM24012/) | 100–240 V AC input, 24 V DC, 1.2 A | datasheet + image | 11.8 s | PASS |
| TM221CE16R | Modicon M221 logic controller | Programmable Logic Controller → Programmable Logic Controller | [official product](https://www.se.com/us/en/product/TM221CE16R/) | 100–240 V AC, 16 I/O, Ethernet | datasheet + image | 17.0 s | PASS; replacement for timed-out BMX |
| TM241CE40R | Modicon M241 logic controller | Programmable Logic Controller → Programmable Logic Controller | [official product](https://www.se.com/pl/pl/product/TM241CE40R/) | 100–240 V AC, 24 inputs, relay/transistor outputs | datasheet + image | 22.2 s | PASS |
| ZB5AA4 | Harmony XB5 operator pushbutton | Pushbutton / Operator → Pushbutton / Operator | [official product](https://www.se.com/us/en/product/ZB5AA4/) | Harmony XB5 operator head identity | datasheet + image | 39.4 s | PASS |
| XPSAC5121 | Harmony XPS safety module | Safety Relay → Safety Relay | [official replacement notice](https://ckm-content.se.com/ckmContent/sfc/servlet.shepherd/document/download/0698V00000iPsfdQAC) | XPSAC5121 → XPSBAC14AP replacement, 24 V AC/DC family | datasheet + image | 21.1 s | PASS |
| A9F74116 | Acti9 iC60N miniature circuit breaker | Miniature Circuit Breaker → Miniature Circuit Breaker | [official product](https://www.se.com/us/en/product/A9F74116/) | 1P, 16 A, Acti9 MCB family | datasheet + image | 15.7 s | PASS |
| NSYTRV42 | Linergy TR screw terminal block | Terminal Block → Terminal Block | [official FAQ/datasheet evidence](https://www.se.com/us/en/faqs/FA229115/) | 600 V, 30 A UL/CSA; 690 V, 30 A ATEX | datasheet + image | 15.4 s | PASS |

Final isolated rerun: **10/10 quality accepted**, all identity, official URL, documents, normalized fields and PDT gates passed. Reports are the ten `benchmark-report.manufacturer-schneider.catalogNumber-*.fixtureDir-benchmarks-cold-products.json` files beside this audit.
