# Spelsberg cold-start audit — 2026-09-01

Ten previously unused catalog numbers were selected across junction boxes, distribution boards, industrial housings, wallbox accessories and installation accessories. Each number was verified against an official Spelsberg product page/finder record before scraping. Product URLs below are PDPs; datasheet PDFs are retained only as documents.

| Catalog number | Official family / verified type | Expected → extracted | Official product page | Key official data checked | Documents/image | Time | Result / repair |
|---|---|---|---|---|---|---:|---|
| 32298001 | Junction boxes / HP 80-L | Enclosure → Enclosure | [Spelsberg PDP](https://www.spelsberg.com/junction-boxes/standard-indoor-installation/32298001/) | 85 × 85 × 42 mm, IP55, 400 V AC insulation, polypropylene | datasheet + image | 11.6 s | PASS |
| 81012001 | Junction boxes / Abox 100-10²/w | Enclosure → Enclosure | [Spelsberg PDP](https://www.spelsberg.com/junction-boxes/protected-outdoor-areas/81012001/) | 152 × 152 × 80 mm, IP66, 690 V AC/DC insulation, 57 A, polypropylene/TPE | datasheet + image | 11.3 s | PASS |
| 73361401 | Small distribution boards / AK 14 Plus | Enclosure → Enclosure | [Spelsberg PDP](https://www.spelsberg.com/small-distribution-boards/indoor-and-protected-outdoor-areas/73361401/) | 315 × 450 × 155 mm, IP65, 400 V AC rated operating voltage | datasheet + image | 10.7 s | PASS |
| 12791001 | Industrial housing / TK PC 1809-8-m | Enclosure → Enclosure | [Spelsberg PDP](https://www.spelsberg.com/industrial-housing/with-/-without-metric-knock-outs/12791001/) | polycarbonate housing, IP66, official datasheet and CAD downloads | datasheet + image | 10.7 s | PASS |
| 89602001 | Junction-box accessory / MABF 100-1 mast/pipe fixing set | Mounting Accessory → Mounting Accessory | [Spelsberg PDP](https://www.spelsberg.com/industrial-housing/with-/-without-metric-knock-outs/89602001/) | 20 × 100 × 43 mm, stainless-steel V2A fixing set | datasheet + image | 9.3 s | PASS |
| 26013201 | General accessory / DMS M32/w double-membrane seal | Cable Gland → Cable Gland | [Spelsberg PDP](https://www.spelsberg.com/accessories/spelsberg-general-accessories/26013201/) | 36.7 × 36.7 × 18 mm, IP66, TPE, sealing range 13–21 mm | datasheet + image | 8.6 s | PASS |
| 73540003 | AK accessory / AK KF 03 hinged window | Cover / Door Accessory → Cover / Door Accessory | [Spelsberg PDP](https://www.spelsberg.com/small-distribution-boards/accessories/73540003/) | 90.3 × 98.5 × 20.3 mm, 0.039 kg, UL94 V2, 960 °C glow-wire | datasheet + image | 8.6 s | PASS |
| 59181001 | Wallbox accessory / LL 7m Type 2 charging cable | Cable → Cable | [Spelsberg PDP](https://www.spelsberg.com/wallboxes/accessories/59181001/) | 7 m Type 2 cable, 12.8 × 7000 × 12.8 mm | datasheet + image | 9.4 s | PASS |
| 59181301 | Wallbox accessory / RFID-C Polar chip | RFID Device → RFID Device | [Spelsberg PDP](https://www.spelsberg.com/wallboxes/accessories/59181301/) | 30 × 45 × 3 mm RFID tag, Polar, kit of 5 | datasheet + image | 9.3 s | PASS |
| 73481501 | AK Compact accessory / AK STD mounting socket | Connector → Connector | [Spelsberg PDP](https://www.spelsberg.com/small-distribution-boards/accessories/73481501/) | 54 × 61 × 44 mm, IP54, explicit 16 A / 230 V mounting socket | datasheet + image | 8.8 s | PASS |

## Reproduction and repair

The first run found all ten products and official PDPs but exposed three issues: generic accessory misclassification, malformed dimension selection (for example `42 x 78 x 0.317 mm` instead of the official `85 x 85 x 42 mm`), and missing 230 V / 16 A fields on the AK STD finder-only description. The smallest safe fix was a Spelsberg-only exact family map, an exact three-axis dimension repair using the official page/finder attribute, and explicit extraction of the AK STD ratings that are printed in the official finder description.

After the fixes, all ten were rerun individually: **10/10 found, identity, official product URL, datasheet/image, device type, normalized fields and PDT audit; 0 wrong products**. Full regression suite: **119 files / 2328 tests passed**.
