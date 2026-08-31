# Schmersal cold-start audit — 2026-08-31

The ten numbers below are the new Schmersal cold-start set; the two older control
fixtures (`AZ16-12ZVRK-M16` and `RSS36-I2-SD-ST`) were not counted. Each official
PDP was checked for the article number, family and device type before the isolated
scrape. The final post-fix rerun was performed one article at a time.

| Catalog number | Official family / expected type | Extracted identity / type | Official source | Manually checked key data | Documents / image | Final duration | Result / fix |
| --- | --- | --- | --- | --- | --- | ---: | --- |
| 101134000 | AZ 16 safety switch / Safety Sensor | AZ 16-12ZVRK-G24 / Safety Sensor | https://products.schmersal.com/en_US/az-16-12zvrk-g24-101134000 | 90 × 52 × 30 mm; 230 V AC; 10 A; IP67 | Datasheet, manual, image | 9,831 ms | PASS |
| 101199600 | BNS 36 magnetic safety sensor / Safety Sensor | BNS 36-1101Z-L-5.0m / Safety Sensor | https://products.schmersal.com/nl_NL/bns-36-1101z-l-5-0m-101199600 | 88 × 25 mm; 225 g; IP67 | Datasheet, certificate, CAD, image | 19,858 ms | PASS |
| 101196285 | SRB101EXi safety relay / Safety Relay | EX safety relay module / Safety Relay | https://products.schmersal.com/nl_NL/srb101exi-1a-101196285 | 100 × 22.5 × 121 mm; 24 V DC; 2 A; IP54/IP40 | Datasheet, certificates, image | 14,546 ms | PASS |
| 101176197 | SRB202CA safety relay / Safety Relay | SRB202CA 24VDC / Safety Relay | https://products.schmersal.com/en_US/srb202ca-24vdc-101176197 | 100 × 22.5 × 121 mm; 24 V DC −10/+20%; 2 A; IP20/IP40/IP54 | Datasheet, manual, image | 5,220 ms | PASS |
| 101109211 | BNS 33 magnetic safety sensor / Safety Sensor | BNS 33-12Z / Safety Sensor | https://products.schmersal.com/fr_BE/bns-33-12z-101109211 | 100 V AC; 0.4 A; IP67; official product image | Datasheet/manual evidence, image | 4,864 ms | PASS; deterministic PDP added after reproduced 180 s search-rescue timeout |
| 101150050 | AZ 16 individually coded safety switch / Safety Sensor | AZ 16-12ZIB1-M16 / Safety Sensor | https://products.schmersal.com/en_US/az-16-12zib1-m16-101150050 | 90 × 52 × 30 mm; 4 A / 230 V AC; 10 A; IP67 | Datasheet, manual, image | 10,345 ms | PASS |
| 101209119 | AZM 161 AS solenoid interlock / Solenoid Interlock | AZM 161 BZ ST1-AS R / Solenoid Interlock | https://products.schmersal.com/en_US/azm-161-bz-st1-as-r-101209119 | 130 × 90 × 30 mm; 26.5…31.6 V DC; 250 mA; IP67 | Datasheet, manual, certificates, image | 12,087 ms | PASS; AZM family type precedence fixed |
| 101150376 | AZM 161 mounting set / Mounting Accessory | AZM 161 P / Mounting Accessory | https://products.schmersal.com/zh_CN/azm-161-p-101150376 | Official page identifies mounting set; no electrical values invented | Datasheet/manual links, image | 9,656 ms | PASS; deterministic PDP and explicit accessory identity |
| 101160481 | AZM 161SK solenoid interlock / Solenoid Interlock | AZM 161SK-33RKAN-024 M16 / Solenoid Interlock | https://products.schmersal.com/en_CA/azm-161sk-33rkan-024-m16-101160481 | 90 × 150 × 30 mm; 24 V AC/DC; 10 A; IP67 | Datasheet, manual, certificates, image | 6,081 ms | PASS; deterministic PDP removed reproduced timeout |
| 101209107 | AZM 161 AS solenoid interlock / Solenoid Interlock | AZM 161 Z ST1-AS R / Solenoid Interlock | https://products.schmersal.com/en_US/azm-161-z-st1-as-r-101209107 | 130 × 90 × 30 mm; 26.5…31.6 V DC; 250 mA; IP67 | Datasheet, manual, certificates, image | 12,323 ms | PASS; AZM family type precedence fixed |

## Gate evidence

The post-fix isolated rerun passed all ten new rows individually: found 10/10,
official URL 10/10, identity 10/10, documents 10/10, device type 10/10, PDT
audit 10/10, wrong products 0, quality accepted for every row. The benchmark
reports are the ten `benchmark-report.manufacturer-schmersal.catalogNumber-*.json`
files for these numbers.
