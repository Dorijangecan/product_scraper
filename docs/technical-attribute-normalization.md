# Technical Attribute Normalization

The scraper keeps raw manufacturer attributes unchanged in `attributes`, then adds a second view in `technicalAttributes`:

- `canonicalKey`: stable internal property key from the ontology.
- `canonicalLabel`: human-readable standard name.
- `originalGroup`, `originalName`, `originalValue`: the manufacturer wording and source value.
- `quantities`: parsed physical quantities when the value carries units.
- `sourceUrl`, `sourceType`, `parser`, `stage`: evidence chain back to the source.
- `matchType`, `matchedAlias`, `matchedAliasManufacturerId`, `matchScore`: how the label was recognized.
- `confidence` and `reason`: deterministic explanation of the mapping.

## Matching Strategy

Normalization is manufacturer-agnostic by default:

1. Exact manufacturer aliases are applied first when the manufacturer has a known special label.
2. Exact global aliases apply to every manufacturer, including new/custom manufacturers.
3. The property ontology maps multilingual labels and known technical terms.
4. Conservative fuzzy alias matching runs as a fallback for misspellings, word-order changes, and near-equivalent labels.
5. The electrical spec miner scans semi-structured HTML/PDF text for source-backed voltage/current/loss phrases when a catalog does not expose clean label/value table markup.

The raw manufacturer wording remains in `attributes` and in each `technicalAttributes.originalName` / `originalValue` pair. Fuzzy matches are recorded with lower confidence and an explicit `matchType` such as `fuzzy_global_alias`.

## Initial Evidence Map

| Canonical key | Manufacturer | Observed source label | Evidence |
| --- | --- | --- | --- |
| `powerLoss` | ABB | `Power Loss at Rated Operating Conditions per Pole`; also catalog tables use `Power loss Pv` | ABB Empower PDF for `1SAZ721201R1025`: https://empower.abb.com/ecatalog/ec/EN_NA/p/1SAZ721201R1025/pdf; ABB S800HV technical PDF: https://search.abb.com/library/Download.aspx?Action=Launch&DocumentID=2CCC457096D0201&DocumentPartId=&LanguageCode=en |
| `powerLoss` | Schneider Electric | `Power dissipation per pole`; `Power dissipation in W` | Schneider product page example: https://www.se.com/us/en/product/GV7RS25/tesys-gv7-manual-starter-and-protector-thermal-magnetic-circuit-protector-rocker-lever-3-p-ac3-15-25-a-high-interrupt/ |
| `powerLoss` | Eaton | `Static heat dissipation, non-current-dependent Pvs`; some pages also show `Power loss` under electrical rating | Eaton skuPage examples: https://www.eaton.com/us/en-us/skuPage.095132.html and https://www.eaton.com/gb/en-gb/skuPage.140062.html |
| `powerLoss` | Siemens | `power loss [W] / maximum`; `power loss [W] / for rated value of the current / at AC / in hot operating state / per pole` | Siemens SiePortal mmpdata examples: https://mall.industry.siemens.com/goos/catalog/Pages/mmpdata.ashx?MLFB1=3WA1112-3AE02-0AA0-Z+D85+T40&lang=en and https://mall.industry.siemens.com/goos/catalog/Pages/mmpdata.ashx?MLFB1=3VM1463-4EE32-0AA0&lang=en |
| `powerLoss` | Global | `power loss`, `power dissipation`, `module power dissipation`, `dissipation power`, `dissipated power`, `thermal dissipation`, `heat loss`, `watt loss`, `Pv`, `Pvs`, `Verlustleistung` | Executable global alias dictionary in `technical-attribute-aliases.ts`; verified by unit tests for unknown manufacturers |
| `ratedCurrent` | ABB / Schneider / Siemens / Rockwell / Eaton / Global | `Rated Operational Current`, `[Ie] rated operational current`, `Bemessungsbetriebsstrom`, `Continuous Operating Current`, `Amperage Rating`, `load current`, `output current rating`, `current-carrying capacity` | Covered by existing ontology tests and official examples above; Rockwell SCCR/current ratings docs: https://literature.rockwellautomation.com/idc/groups/literature/documents/td/1492-td013_-en-p.pdf |
| `ratedVoltage` | Schneider / Rockwell / Global | `[Us] rated supply voltage`, `supply voltage range`, `module supply voltage`, `sensor supply voltage`, `auxiliary voltage`, `load voltage`, `voltage range` | Executable ontology and global aliases; bracket-prefixed IEC labels and broad catalog labels are covered by tests |
| `currentConsumption` | Rockwell / Global | `current consumption`, `input current`, `supply current`, `current draw`, `no-load current Io max.`, `quiescent current`, `Stromaufnahme` | Kept separate from `ratedCurrent` and `powerConsumption` so I/O modules, sensors and electronics do not look like load-current ratings |
| `breakingCapacity` | Rockwell / Schneider / Siemens / Eaton / ABB | `SCCR`, `[Ics] rated service short-circuit breaking capacity`, `maximum short-circuit current breaking capacity (Icu)`, `Interrupt rating`, `Rated Ultimate Short-Circuit Breaking Capacity` | Rockwell SCCR literature: https://literature.rockwellautomation.com/idc/groups/literature/documents/at/sccr-at002_-en-p.pdf; Siemens and Schneider examples above |

## Runtime Behavior

Unknown labels are not guessed. If an attribute value contains a parseable quantity but its label has no ontology match, it remains in raw `attributes` and can surface through existing `diagnostics.unmappedSpecLabels` for later teaching.

The miner only emits an attribute when a known electrical label and a parseable unit-bearing value occur together in the source text. It keeps `ratedCurrent` separate from `currentConsumption` so load ratings are not confused with electronics draw.

## Code Artifacts

- Runtime mapper: `src/server/scrapers/technical-attributes.ts`
- Manufacturer alias catalog: `src/server/scrapers/technical-attribute-aliases.ts`
- Semi-structured electrical text miner: `src/server/scrapers/electrical-spec-miner.ts`
- Per-product output: `ProductResult.technicalAttributes`
- Workbook tabs:
  - `Technical Attributes`: mapped attributes found on scraped products.
  - `Alias Dictionary`: known manufacturer aliases and evidence links, including aliases not present in the current run.
