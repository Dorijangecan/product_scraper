# nVent cold-start audit — 2026-08-31

All ten catalog numbers were new against the regression corpus/cache and were verified against nVent Hoffman/Schroff official pages or datasheets before scraping. Final runs were isolated and repeated after the WAF/parser and device-family fixes.

| Catalog | Official family / expected type | Extracted type | Official URL | Checked data | Docs/image | Duration | Result |
|---|---|---|---|---|---|---:|---|
| CP2020 | Concept Panel / Mounting Accessory | Mounting Accessory | https://www.nvent.com/en-us/hoffman/products/enccp2020 | identity, title, dimensions, material | datasheet + image | 9.8s | PASS |
| CSP2020 | Concept Swing-Out Panel / Mounting Accessory | Mounting Accessory | https://www.nvent.com/en-us/hoffman/products/enccsp2020 | identity, title, dimensions, material | datasheet + image | 6.1s | PASS |
| P19SH8 | Hoffman fixed shelf / Mounting Accessory | Mounting Accessory | https://www.nvent.com/en-us/hoffman/products/encp19sh8 | identity, title, dimensions | datasheet + image | 5.8s | PASS |
| P2C208 | ProLine G2 cover / Enclosure | Enclosure | https://www.nvent.com/en-us/hoffman/products/encp2c208 | identity, title, dimensions, material | datasheet + image | 6.6s | PASS |
| P2D208 | ProLine G2 door / Enclosure | Enclosure | https://www.nvent.com/en-us/hoffman/products/encp2d208 | identity, title, dimensions, material | datasheet + image | 8.7s | PASS |
| P2B186 | ProLine G2 base / Enclosure | Enclosure | https://www.nvent.com/en-us/hoffman/products/encp2b186 | identity, title, dimensions, material | datasheet + image | 7.5s | PASS |
| P2ACEGP | Cable Entry Gland Plate / Mounting Accessory | Mounting Accessory | https://www.nvent.com/en-us/hoffman/products/encp2acegp | identity, title, dimensions, material | datasheet + image | 6.6s | PASS |
| CSD20208ST | Concept sloped-top Type 4 / Enclosure | Enclosure | https://www.nvent.com/en-us/hoffman/products/concept-sloped-top-enclosure-type-4-0/pdf | identity, title, dimensions, material | datasheet + image | 12.9s | PASS |
| P2KOD20126T3R | ProLine G2 industrial package Type 3R / Enclosure | Enclosure | https://www.nvent.com/en-us/hoffman/products/encp2kod20126t3r | identity, title, dimensions, material | datasheet + image | 7.3s | PASS |
| 23022-010 | SCHROFF VMEbus test adapter / Mounting Accessory | Mounting Accessory | https://www.nvent.com/en-us/schroff/products/enc23022-010 | identity, title, dimensions, material | datasheet + image | 14.2s | PASS |

## Reproduced defect and repair

The old generic path sent a Googlebot fallback UA and omitted the trailing slash; nVent returned WAF 403 and the fallback timed out at 60s. The smallest safe repair is a dedicated nVent direct connector using neutral `Mozilla/5.0`, the canonical trailing-slash Hoffman/Schroff URL, and the existing PowerShell HTTP client. nVent pages also append Cloudflare telemetry markers to valid product HTML; the connector removes only those markers after preserving official Coveo SKU, canonical URL and OG title evidence. Accessory family classification is explicit and source-backed for the five accessory SKUs. All ten items were rerun after the final change and passed the quality gate.
