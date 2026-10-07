# Rittal new 15 cold-start audit

Manifest prepared before scrape. Novelty check: 0 prior run rows and 0 prior benchmark fixture/report matches for all 15 order numbers.

Conditions: Rittal concurrency 2; configured rateLimitMs=1,500 ms, effective per-host minimum interval=750 ms after run-manager divides by concurrency; fresh isolated SQLite and HTTP cache per run; external search disabled; no learned endpoints, fixture responses, or customer documents.

## Cold-start timing

| Metric | Initial | Final |
|---|---:|---:|
| Batch wall time | 127773 ms | 124029 ms |
| Sum of item times | 121891 ms | 118509 ms |
| Mean item time | 8126.1 ms | 7900.6 ms |
| Median item time | 6142 ms | 4882 ms |
| Item range | 1672–32053 ms | 2124–33602 ms |

Same 15 numbers and options in both passes. The measured wall time was slightly lower in the final pass; the change is small and cannot be attributed to code changes with only these two site-timing samples.

### Phase totals (sum across 15 products)

| Phase | Initial | Final |
|---|---:|---:|
| English+German product page scrape | 12588 ms | 12503 ms |
| Initial document downloads | 24636 ms | 17042 ms |
| Document parsing/enrichment | 57835 ms | 62431 ms |
| Workbook export | 7227 ms | 6874 ms |
| PDT export | 11674 ms | 11199 ms |

## Per-item audit

| Order no. | Expected family / type → found classifier | Exact identity and official PDP | Required fields | German title | Real image | Initial → final ms; scrape ms final |
|---|---|---|---:|---|---|---:|
| 3245800 | Blue e+ filter fan EMC / Thermal Management → Thermal Management | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215KLI101/PG20231215KLI102/PG20240718KLI001/PRO136518?variantId=3245800) | voltage=200 V - 240 V, 1~, 50 Hz/60 Hz (PASS) | Blue e+ Filterlüfter EMV | PASS: [source](https://www.rittal.com/imf/x1200/2_54814/) | 32053 → 33602; 1296 ms |
| 8618800 | VX cable entry section / Enclosure Accessory → Mounting Accessory | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240405ZUB003/PG20240405ZUB007/PRO82563?variantId=8618800) | N/A (0) | Profil zur Kabeleinführung, mittig | PASS: [source](https://www.rittal.com/imf/x1200/78_939/) | 2989 → 2329; 658 ms |
| 7030200 | CMC III CAN bus access / Access Sensor → Access Sensor | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ITI101/PG20240408ITI301/PG20240913ITI006/PG20240925ITI004/PRO37142?variantId=7030200) | N/A (0) | CMC III CAN-Bus Access | PASS: [source](https://www.rittal.com/imf/x1200/2_37871/) | 3186 → 2185; 681 ms |
| 9350075 | RiLine60 busbar connector / Busbar Accessory → Busbar | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215POW101/PG20240417STR201/PG20240418STR203/PG20250927STR101/PRO0566?variantId=9350075) | N/A (0) | Schienenverbinder | PASS: [source](https://www.rittal.com/imf/x1200/2_36065/) | 6489 → 7335; 628 ms |
| 9665785 | Cable entry gland for roof plate / Enclosure Accessory → Cable Gland | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240411ZUB102/PG20240328ZUB101/PRO13714?variantId=9665785) | N/A (0) | Kabeleinführungsflansch für Dachblech | PASS: [source](https://www.rittal.com/imf/x1200/2_37141/) | 2327 → 3390; 624 ms |
| 7888626 | TX CableNet network rack / Network Cabinet → Rack Cabinet | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ITI101/PG20240402ITI203/PRO125564?variantId=7888626) | N/A (0) | Netzwerkschrank TX CableNet mit Sichttür | PASS: [source](https://www.rittal.com/imf/x1200/2_55019/) | 5734 → 4510; 2291 ms |
| 7979313 | PDU switched / Power Distribution Unit → Power Distribution Unit | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ITI101/PG20240403ITI201/PG20240913ITI001/PG20240925ZUB101/PRO115365?variantId=7979313) | voltage=230 V (AC) (PASS); current=32 A (PASS) | PDU switched | PASS: [source](https://www.rittal.com/imf/x1200/78_2777/) | 11524 → 10649; 791 ms |
| 2500100 | LED system light / Luminaire → Luminaire | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240403ZUB001/PRO64749?variantId=2500100) | N/A (0) | Systemleuchte LED | PASS: [source](https://www.rittal.com/imf/x1200/2_46555/) | 13931 → 15316; 1187 ms |
| 3336460 | Blue e chiller, 30.8/36.9 kW / Thermal Management → Thermal Management | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215KLI101/PG20231215KLI104/PG20240718KLI005/PRO85465?variantId=3336460) | voltage=400 V, 3~, 50 Hz | 460 V, 3~, 60 Hz (PASS) | Chiller Blue e 8 - 48 kW | PASS: [source](https://www.rittal.com/imf/x1200/2_53906/) | 15410 → 16938; 726 ms |
| 4532000 | TS mounting plate / Enclosure Accessory → Subpanel | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240403ZUB102/PG20240403ZUB107/PRO14242?variantId=4532000) | N/A (0) | Montageplatine | PASS: [source](https://www.rittal.com/imf/x1200/2_36470/) | 3185 → 2927; 608 ms |
| 8611020 | Comfort handle / Enclosure Accessory → Cover / Door Accessory | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240411ZUB101/PG20240327ZUB102/PRO14540?variantId=8611020) | N/A (0) | Komfortgriff für TS, TS IT, VX SE, PC, IW | PASS: [source](https://www.rittal.com/imf/x1200/2_37180/) | 5284 → 2592; 572 ms |
| 5302042 | 19-inch cable link, depth-variable / Cable Management → Mounting Accessory | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240408ZUB101/PG20240408ZUB103/PRO136670?variantId=5302042) | N/A (0) | 19"-Kabelbrücke, tiefenvariabel | PASS: [source](https://www.rittal.com/imf/x1200/2_57136/) | 1672 → 2124; 650 ms |
| 8617353 | VX mounting plate attachment Type A / Enclosure Accessory → Mounting Accessory | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240403ZUB102/PG20240403ZUB105/PRO86680?variantId=8617353) | N/A (0) | Montageplatten-Fixierung Typ A, für VX | PASS: [source](https://www.rittal.com/imf/x1200/2_51415/) | 6142 → 4882; 623 ms |
| 4127210 | Door-operated switch / Electrical Accessory → Switch | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240403ZUB003/PRO15576?variantId=4127210) | N/A (0) | Türpositionsschalter | PASS: [source](https://www.rittal.com/imf/x1200/2_36588/) | 6185 → 4017; 605 ms |
| 2418000 | Safety lock / Safety Accessory → Lock / Interlock | PASS: [official PDP](https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240411ZUB101/PG20240327ZUB101/PRO14664?variantId=2418000) | N/A (0) | Sicherheitsverriegelung | PASS: [source](https://www.rittal.com/imf/x1200/78_3344/) | 5780 → 5713; 563 ms |

## Required field evidence

Applicable field values are limited to the profile requirements for the found device type. The normalized value and raw official attribute must both exist on the exact product URL.
- **3245800 voltage**: 200 V - 240 V, 1~, 50 Hz/60 Hz; official row `Rated operating voltage` = `200 V - 240 V, 1~, 50 Hz/60 Hz`; [source PDP](https://www.rittal.com/com-en/products/PG20231215KLI101/PG20231215KLI102/PG20240718KLI001/PRO136518?variantId=3245800); **PASS**.
- **7979313 voltage**: 230 V (AC); official row `Rated operating voltage` = `230 V (AC)`; [source PDP](https://www.rittal.com/com-en/products/PG20231215ITI101/PG20240403ITI201/PG20240913ITI001/PG20240925ZUB101/PRO115365?variantId=7979313); **PASS**.
- **7979313 current**: 32 A; official row `Rated current (max.)` = `32 A`; [source PDP](https://www.rittal.com/com-en/products/PG20231215ITI101/PG20240403ITI201/PG20240913ITI001/PG20240925ZUB101/PRO115365?variantId=7979313); **PASS**.
- **3336460 voltage**: 400 V, 3~, 50 Hz | 460 V, 3~, 60 Hz; official row `Rated operating voltage` = `400 V, 3~, 50 Hz`; [source PDP](https://www.rittal.com/com-en/products/PG20231215KLI101/PG20231215KLI104/PG20240718KLI005/PRO85465?variantId=3336460); **PASS**.

Coverage: **4/4** applicable electrical fields. Other 11 product types have no required electrical fields under their actual device-type profile.

## Retrieval and limitations
Final run recorded 30 fresh HTML cache entries (15 English and 15 German exact-variant pages), 31 downloaded files (including all 15 images), and at least 61 successful retrievals. Retry count and throttle wait duration are not instrumented, so they are **unmeasured**.

One PDT target row for 2500100 (`rated permanent current Iu`) had no value on the official PDP; it is marked Optional and left blank. The run reports one known PDT required-field audit issue (zero unexplained required-field issues) and zero unproven values written. No current was guessed.

Initial/final benchmark reports and raw logs are in `baseline/` and `final/`. Official English product-page captures are in `evidence/official-pdp-*.html`; the visually reviewed image contact sheet is `evidence/image-contact-sheet.png`.

## Follow-up after Rittal access-sensor classifier correction

The same 15 order numbers were run again from a fresh isolated SQLite database and HTTP cache after a separate accuracy fix for Rittal `Design = Access sensor` records. All gates remained 15/15. See `final/after-access-sensor-report.json`, `final/after-access-sensor-fix.log`, and `final/after-access-sensor-options.txt`.

| Metric | Prior final | Follow-up |
|---|---:|---:|
| Batch wall time | 124029 ms | 126056 ms |
| Sum of item times | 118509 ms | 104326 ms |
| Mean item time | 7900.6 ms | 6955.1 ms |
| Median item time | 4882 ms | 3717 ms |
| Item range | 2124–33602 ms | 1589–27336 ms |
| Identity / official PDP / documents / device type / PDT audit | 15/15 each | 15/15 each |

Item-time sum fell 12.0%, while batch wall time was 1.6% higher. Network and document-processing variation is large; this is not evidence of a code-driven speedup. The effective per-host interval is 750 ms: run-manager divides the configured 1500 ms `rateLimitMs` by concurrency 2.
