# nVent accuracy and speed batch 09

## Five product types

The batch adds five exact SKUs across five different device types. The fixture manifest records exact URL, document, normalized-field, source-attribute, device-type, and PDT requirements.

| SKU | Device type | Exact official page |
|---|---|---|
| `10713-518` | Fan Assembly | [Schroff pusher fan](https://www.nvent.com/en-us/schroff/products/enc10713-518) |
| `LEDHL24V48` | Luminaire | [Hoffman hazardous-location LED strip light](https://www.nvent.com/en-us/hoffman/products/encledhl24v48) |
| `DSW01QD` | Switch | [Hoffman door switch](https://www.nvent.com/en-us/hoffman/products/encdsw01qd) |
| `12P4I` | Mounting Accessory | [CADDY Push-In Conduit Clamp](https://www.nvent.com/en-us/caddy/products/efs12p4i) |
| `MPSC404SS` | Connector | [ERICO Multi-Purpose Grounding Clamp](https://www.nvent.com/en-us/erico/products/efsmpsc404ss) |

## Root causes and learned corrections

The new `MPSC` and `12P` prefixes were missing from nVent's exact product routes, so these SKUs could fall into unrelated brand paths. Added exact family routes and canonical URL checks. Device type mapping now recognizes the LED light, fan unit, push-in conduit clamp, and multi-purpose grounding clamp from exact page evidence.

The nVent pages include related items and broad family content. For the Schroff fan, the parser had treated a 2.5 m accessory cable length and polypropylene cable detail as fan dimensions/material. Those cross-linked values are now excluded; the fan keeps the exact Steel / Polypropylene PDP material and no unproven overall dimensions or current. The LED page maps to Luminaire. The door switch keeps its product Plastic material instead of the enclosure's Mild Steel. For `12P4I`, 25 lb / 110 N is a static load capacity, not product mass; normalized mass and envelope dimensions stay blank. The ERICO clamp keeps its labelled 65 mm length and width and Stainless Steel 304 material. The phrase “will not crack” is a durability claim, not a surface finish; the final normalization and field-candidate stages now clear that unsupported finish.

## Acceptance and timings

The isolated five-item final cold run passed identity, official URL, document, device type, normalized-field, source-attribute, and PDT checks at 5/5 (100%). Wrong products: 0; unproven PDT writes: 0. Each run had one safely skipped optional PDT enum value; no required field was affected.

| Core scrape pass | Per-device milliseconds | Mean | Median | Maximum |
|---|---|---:|---:|---:|
| Final cold, first five | 8707, 927, 858, 952, 946 | 2478 ms | 946 ms | 8707 ms |
| Immediate repeat, same five | 1260, 871, 827, 925, 903 | 957 ms | 903 ms | 1260 ms |
| Both passes, 10 attempts | — | 1718 ms | 926 ms | 8707 ms |

The initial cold browser capture adds one-time overhead to `10713-518`; the other four cold devices and every immediate repeat were below 2.5 seconds. `scrapeElapsedMs` is the core acquisition measure. `elapsedMs` also includes document processing and workbook/PDT export, so it is reported separately in the raw files.

Before repair, the comparable five-item accuracy run passed only 3/5 device types, 4/5 normalized-field expectations, and 3/5 expected source-attribute checks; PDT audits were 5/5. Its mean core time was 3114 ms. This batch first fixed source/type/field errors, then reduced core mean to 2478 ms cold and 957 ms on the immediate repeat.

## Evidence files

- `fixtures.json` — exact product assertions, including fields that must remain blank.
- `report-cold-final.json` — accepted final five-product cold run.
- `report-cold-warm.json` — accepted cold run followed by the same five products in one isolated session.
