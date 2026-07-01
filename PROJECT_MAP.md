# PROJECT MAP — product_scraper

> **Mapa projekta za AI agente.** Cilj: nađi pravi fajl / funkciju / tip **bez otvaranja fajlova**
> → minimalna potrošnja tokena. Pročitaj ovo prvo, pa skoči ravno na metu.
> API indeks (§7) i oblici tipova (§6) namjerno su detaljni da zamijene `grep`/otvaranje.
> Ljudski-orijentiran detalj: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 1. Pregled

Lokalni desktop alat za scrapanje podataka o industrijskim elektro/mehaničkim proizvodima iz
kataloga proizvođača. Učitaš CSV/XLSX s kataloškim brojevima → odabereš proizvođača → app scrapa
službene izvore, deterministički normalizira atribute, ocjenjuje kvalitetu i izvozi `products.xlsx`
+ opcionalni PDT workbook.

**Stack:** TypeScript (ESM, `"type":"module"`) · Node + **Express 5** · **React 19 + Vite** · **Electron**
· **better-sqlite3** · **Playwright** · ExcelJS / csv-parse / pdf-parse / sharp · **Vitest**.
Sve lokalno na `127.0.0.1:3001`, bez cloud key-a. Runtime LLM (PDT AI cleanup) je opt-in
(`PDT_AI_CLEANUP=1`, lokalni Ollama/Qwen). Reader fallback (r.jina.ai — šalje URL trećoj strani) je
također opt-in: `PRODUCT_SCRAPER_ALLOW_EXTERNAL_READER=1`. Princip: vrijednosti dolaze iz izvora — **nepoznato se ne pogađa**.

## 2. Struktura

| Folder / fajl | Čemu služi |
| --- | --- |
| `src/server/` | Express API, orkestracija runova, DB, I/O, layout outputa |
| `src/server/scrapers/` | **Srce sustava** — konektori po proizvođaču + zajednička infra + "understanding engine" (40 fajlova) |
| `src/server/pdt/` | Generiranje PDT Excela iz rezultata runa (22 fajla) |
| `src/server/config/` | `manufacturers.ts` — built-in profili + custom config |
| `src/client/` | React UI (`App.tsx` monolitan, `Dropdown.tsx`, `api.ts`, `main.tsx`, `styles.css`) |
| `src/desktop/` | Electron `main.cjs` / `preload.cjs` |
| `src/shared/` | `types.ts` (+ `product-requirements.ts`) — tipovi za client i server |
| `tests/` | Vitest (33 fajla; 1 fajl ≈ 1 modul) |
| `scripts/` | audit / benchmark / probe / desktop-boot alati (`.ts`→tsx, `.cjs`→Node) |
| `templates/` | `master_pdt.xlsx` — izvor istine za PDT |
| `benchmarks/` | Fixture proizvodi + izvještaji |
| `docs/` | `ARCHITECTURE.md`, prezentacije, normalizacijske bilješke |
| `outputs/` `data/` `tmp/` | Runtime artefakti (DB, cache, workbookovi) — **ne uređivati ručno** |

## 3. Ulazne točke

- **API server:** [src/server/index.ts](src/server/index.ts) — sve `/api/*` rute. Sluša `127.0.0.1:${PORT||3001}`.
- **Dev:** `npm run dev` (API watch + Vite). **Server only:** `npm run server`.
- **Desktop:** `npm run desktop` → [scripts/start-desktop.cjs](scripts/start-desktop.cjs) → [src/desktop/main.cjs](src/desktop/main.cjs) → spawn server → BrowserWindow.
- **UI:** [src/client/main.tsx](src/client/main.tsx) → [App.tsx](src/client/App.tsx); API pozivi u [api.ts](src/client/api.ts).
- **Scrape orkestracija:** [run-manager.ts](src/server/run-manager.ts) (`RunManager.processRun`).

**API rute (sve u `index.ts`):** `GET/POST /api/manufacturers` (+`/inspect`,`/test`,`/:id/reset-override`)
· `POST /api/csv/preview` · `POST /api/runs` (multipart: CSV + customer docs) · `GET /api/runs[/:id]`
(`?summary=1` → `summarizeRunItem`) · `PATCH /api/runs/:id/coverage-fields`
· `POST /api/runs/:id/{cancel,pause,resume}` · `/files/{result,pdt,log,document}` (+`/open`)
· `GET /api/runs/:id/pdt-routing-preview` · `POST /api/runs/:id/pdt`.

## 4. Glavni tok (slijed izvršavanja)

```
UI App.tsx ──HTTP──> index.ts POST /api/runs
  │  csv.ts (extractCatalogNumbers)
  ▼
RunManager.processRun (run-manager.ts) ──persist──> db.ts (SQLite)
  ▼ za svaki red, ograničena konkurentnost (config.concurrency, default 3, max 8):
getConnector (scrapers/index.ts)            # lazy-load po id; nepoznati → ConfiguredManufacturerConnector (config fallback)
  ▼
connector.scrape (scrapers/<vendor>.ts)
  ▼
runDeterministicScrapePipeline (deterministic-pipeline.ts)
  ├─ discovery.ts + link-discovery.ts + learned-endpoints.ts   # nalaženje službenih URL-ova
  ├─ generic.ts (parseGenericProductPage)                       # parsiranje
  ├─ page-intelligence.ts + page-mining.ts                       # deep mining hidden DOM/JSON/network
  ├─ smart-fallback.ts → browser-renderer.ts (Playwright)       # JS-heavy / fallback
  │   └─ interaction-explorer.ts                                # semantic tab/accordion/download exploration
  └─ quality-gate.ts (evaluate/applyQualityGate)                # found | partial | failed
  ▼
document-enrichment.ts (enrichResultFrom{Downloaded,Remote}Documents) ← pdf-ocr.ts, document-url.ts
  ▼
final-completeness.ts (evaluate→repair→retry zadnjih polja)
  ▼
evidence.ts (attachEvidence + field candidates/resolutions) + dedupe.ts (merge duplikata, čuva veći confidence)
  ▼
persist run_item (db.ts) → finalize run
  ├─ excel.ts (exportRunWorkbook) → outputs/.../excel/<...>.xlsx
  └─ on demand: pdt/exporter.ts (exportRunPdt) → <runId>_PDT.xlsx
```

**Fast paths:** images-only (preskoči Excel + široke fallbacke), links-only (samo URL-ovi),
customer-documents (override scrapanih vrijednosti). Run lifecycle:
`queued→running→{completed|paused|cancelled|failed}`; `resumeInterruptedRuns()` hvata prekinute
unutar 5 min prozora (`INTERRUPTED_RUN_RESUME_WINDOW_MS`).

## 5. Ovisnosti — "što utječe na što"  ⟵ NAJVAŽNIJE

### 5a. Hot files / blast radius (stvarni in-degree iz `madge src/server`)

Promjena ovih = najveći domet. Broj = koliko ga modula importa.

| In-deg | Modul | Zašto je hot / što povlači |
| ---: | --- | --- |
| 56 | `shared/types.ts` | Centralni tipovi. Diranje povlači **client i server**. Najskuplje. |
| 29 | `scrapers/normalizer.ts` | `mergeResults`/`emptyResult`/`normalizeFields` — koristi cijeli pipeline + svi konektori |
| 23 | `scrapers/catalog-number.ts` | Matching/URL-template/varijante kat. broja — svaki konektor i discovery |
| 19 | `scrapers/http-client.ts` | Svi mrežni dohvati (cache, throttle, download). Mijenjaj oprezno. |
| 18 | `scrapers/types.ts` | `ScrapeContext`, `ManufacturerConnector` — interface svih konektora |
| 17 | `scrapers/dedupe.ts` | Merge atributa/dokumenata; utječe na finalni izlaz |
| 13 | `scrapers/discovery-fallback.ts` | Config-driven fallback put |
| 11 | `scrapers/localized-urls.ts` | Lokalizirani URL-ovi (en/de) |
|  9 | `pdt/device-type-profiles.ts` | Per-device PDT mapiranje + kritične činjenice |
|  7 | `scrapers/device-type.ts` | Klasifikacija → ulaz u PDT routing |
|  6 | `config/manufacturers.ts`, `scrapers/generic.ts`, `scrapers/field-registry.ts`, `pdt/ai-cleanup.ts` | profili / generički parser / registar polja / opcionalni AI |
|  5 | `scrapers/{browser-renderer,ontology,quantity}.ts` | rendering / značenja / parsiranje veličina |

### 5b. Najkompleksniji orkestratori (out-degree — najviše importa)

| Out-deg | Modul | Uloga |
| ---: | --- | --- |
| 19 | `run-manager.ts` | Orkestracija runova (lifecycle, konkurentnost, enrichment, download) |
| 16 | `scrapers/index.ts` | Registar/lazy-load konektora |
| 15 | `pdt/exporter.ts` | Orkestracija PDT izvoza |
| 14 | `index.ts`, `manufacturer-wizard.ts` | API rute / inspect+test čarobnjak |
| 11 | `scrapers/{final-completeness,generic}.ts` | dopuna zadnjih polja / generički parser |

Nema kružnih ovisnosti (`madge --circular` → 0).

### 5c. Pravila "diraš X → diraj i Y"

- **Novi proizvođač:** profil u `config/manufacturers.ts` **+** (za dedicated) konektor `scrapers/<id>.ts` registriran u `scrapers/index.ts`. Bez konektora → config fallback.
- **Nova vrsta uređaja:** `scrapers/device-type.ts` **+** `pdt/device-type-profiles.ts` **+** `pdt/device-sheet-map.ts`.
- **Novo značenje atributa / jedinica:** `scrapers/ontology.ts` (`PROPERTY_ONTOLOGY`) ili `quantity.ts`/`normalizer.ts` — **ne** one-off regex po proizvodu. Povlači `technical-attributes.ts`, `excel.ts`, PDT resolvere, benchmark fixture.
- **Promjena quality gate praga:** `scrapers/quality-gate.ts` → mijenja fallback grananje, statistike, UI coverage. Uz testove + `npm run benchmark`.
- **Promjena PDT predloška/resolvera:** `pdt/*` ili `templates/master_pdt.xlsx` → pokreni `npm run audit:pdt`.
- **Promjena DB sheme:** `db.ts` → utječe na `run-manager.ts` i sve čitatelje runova.
- **Promjena `RunOptions`/`ProductResult`:** `shared/types.ts` → client + server + excel + pdt.

### 5d. Auto-regeneracija grafa (madge/dependency-cruiser NISU instalirani — `npx`)

```bash
npx madge --extensions ts --ts-config tsconfig.json --json src/server          # JSON graf
npx madge --extensions ts --ts-config tsconfig.json --image dep-graph.svg src/server   # treba Graphviz dot
npx madge --extensions ts --ts-config tsconfig.json --circular src/server       # kružne ovisnosti
```

## 6. Glavni tipovi (oblici — iz `shared/types.ts`, da se ne otvara)

```ts
ProductResult {            // središnji objekt koji teče kroz cijeli pipeline; serijaliziran u run_items
  manufacturerId; catalogNumber; status: "found"|"partial"|"failed"; confidence;
  productUrl?; localizedUrls?{en,de}; localizedDescriptions?; title?; description?;
  normalized: NormalizedProductFields;   // weight,dimensions,material,wallThickness,finish,color,
                                          // voltage,current,protection,certificates,operatingTemp{Min,Max}
  attributes: AttributeRecord[];          // {group?,name,value,unit?,sourceUrl?,sourceType?,parser?,stage?,confidence?}
  documents: DocumentRecord[];            // {type:datasheet|certificate|manual|cad|image|other,label,url,
                                          //  localPath?,downloadStatus?,parseStatus?,...}
  sources: SourceRecord[];                // {url,sourceType:official|official-fallback|distributor|cache|generated,parser,...}
  qualityGate?; diagnostics?; evidence?: EvidenceRecord[];
  technicalAttributes?: TechnicalAttributeRecord[];   // ontologijom "shvaćeni" original label/value
  error?;
}
DocumentProcessingDiagnostic { url; label?; type?; action: parsed|skipped|failed;
  stage: downloaded-document-enrichment|remote-document-enrichment|customer-document-enrichment;
  reason; attributeCount?; normalizedFields?; pageCount?; elapsedMs?; localPath?; sourceUrl?; parseError? }
RunRecord { id; manufacturerId; createdAt; updatedAt; status: RunStatus; inputFileName?;
            total; processed; found; partial; failed; outputPath?; pdtPath?;
            activityStage?; activityMessage?; options?: RunOptions; error? }
RunOptions { downloadDocuments?; downloadPdfs?; downloadCad?; downloadImages?; generateExcel?;
             generateLinksFile?; customCoverageFields?; hiddenCoverageFields?; forceFinalRetry?;
             customerDocuments?: CustomerDocumentRecord[] }
ManufacturerConfig { id; canonicalName; shortName; rateLimitMs; concurrency?; officialBaseUrls[];
             homepageUrl?; fallbackSources[]; localizedUrlTemplates?; match?; fetchPolicy?;
             markerRules?; scrapeRecipe?; customCoverageFields?; origin?; isBuiltIn?; hasOverride? }
RunStatus  = queued|running|pausing|paused|cancelling|cancelled|completed|failed
ItemStatus = pending|processing|found|partial|failed|cancelled
```

Politike u `ManufacturerConfig.scrapeRecipe`: `DiscoveryPolicyConfig`, `InteractionPolicyConfig`,
`ExtractionPolicyConfig`, `QualityPolicyConfig`, `FallbackPolicyConfig`, `FetchPolicyConfig`, `ConfidenceRulesConfig`.

**DB tablice** (`db.ts`, klasa `ScraperDb`): `runs`, `run_items`, `page_cache`, `learned_endpoints`,
`learned_extractors`, `stage_observations`, `target_health`, `exhausted_fields`.

## 7. API indeks — ključni exporti po modulu (zamjena za grep/otvaranje)

### `src/server/` (jezgra)
| Fajl | Ključni exporti |
| --- | --- |
| `index.ts` | (Express rute — vidi §3) |
| `run-manager.ts` | `RunManager`, `documentDownloadProfile`, `shouldDownloadDocumentsForRun`, `documentDownloadCandidateUrls`, `imageFileName` |
| `db.ts` | `ScraperDb` (svi DB upiti) |
| `csv.ts` | `previewCsv`, `extractCatalogNumbers` |
| `excel.ts` | `exportRunWorkbook` |
| `manufacturer-wizard.ts` | `inspectManufacturerDraft`, `testManufacturerDraft` |
| `config/manufacturers.ts` | `getManufacturerConfig`, `listManufacturerConfigs`, `saveManufacturerConfig`, `initializeManufacturerConfig`, `resetManufacturerOverride` |
| `paths.ts` | `AppPaths`, `createAppPaths` |
| `run-output.ts` | `buildRunOutputLayout`, `ensureRunOutputLayout`, `getAllowedRunOutputRoots`, `isPathInsideAny`, `findRunLogPath` |
| `run-item-summary.ts` | `summarizeRunItem` |
| `text-util.ts` | `cleanText`, `collapseWhitespace`, `collapseWhitespaceOrUndefined`, `uniqueStrings`, `slugify` — **leaf** text helpers (dependency sink; import from here, no local copies) |
| `url-util.ts` | `sameNormalizedUrl`, `sameUrlIgnoringHash`, `sameUrlOriginAndPath` — **leaf** URL-equality helpers (3 distinct semantics — see file header) |

### `src/server/scrapers/` — infrastruktura
| Fajl | Ključni exporti |
| --- | --- |
| `index.ts` | `getConnector` |
| `types.ts` | `ScrapeContext`, `ManufacturerConnector` |
| `http-client.ts` | `CachedHttpClient`, `FetchedText`, `delay` |
| `browser-renderer.ts` | `BrowserRenderSession`, `renderProductPage`, `RenderedPage`, `ModalSection`, `clickSafeSelectors`, `captureFrameFragments`, `captureShadowDomFragments` (zadnja tri exportana za testove: klik-petlja s re-scanom + iframe + shadow-DOM capture) |
| `deterministic-pipeline.ts` | `runDeterministicScrapePipeline` |
| `discovery.ts` | `discoverOfficialProductCandidates`, `scoreDiscoveryCandidate` |
| `discovery-fallback.ts` | `scrapeDiscoveredFallback`, `withDiscoveryFallbackDiagnostics` |
| `link-discovery.ts` | `findBestProductLink`, `discoverProductLinks(WithDiagnostics)` |
| `learned-endpoints.ts` | `LearnedEndpointStore`, `learnedEndpointUrls`, `learnEndpointFromNetworkFetch` |
| `localized-urls.ts` | `buildLocalizedProductUrls`, `canonicalizeNventLocaleUrl`, `canonicalizeProductLocaleUrls` (collapse geo-locale `/en-xx/`→`/en-us/`) |
| `generic.ts` | `parseGenericProductPage`, `GenericFallbackScraper`, `isUnresolvedSearchResultPage` |
| `smart-fallback.ts` | `runSmartFallbackPipeline` |
| `page-intelligence.ts` | `runAdaptivePageIntelligence`, `mergeFetchedPageMining` |
| `page-mining.ts` | `minePage`, `PageMiningResult`, `PageMiningOptions` |
| `interaction-explorer.ts` | `adaptiveInteractionSelectors` |
| `field-candidates.ts` | `applyFieldCandidateResolution`, `buildFieldCandidates`, `buildFieldResolutions` |
| `mission-control.ts` | `shouldRunAdaptiveMining`, `driftFromTargetHealth` |
| `target-health.ts` | `recordTargetObservation` |
| `quality-gate.ts` | `evaluateQualityGate`, `applyQualityGate`, `finalizeQualityGate` |
| `final-completeness.ts` | `evaluateFinalCompleteness`, `repairFinalCompletenessFromEvidence`, `finalNetworkRetryDecision`, `withFinalCompletenessPolicy` |
| `evidence.ts` | `attachEvidence` (+ field candidate/resolution diagnostics) |
| `dedupe.ts` | `dedupeAttributes`, `dedupeDocuments`, `dedupeSources`, `canonicalDocumentUrlKey` |
| `document-enrichment.ts` | `enrichResultFromDownloadedDocuments`, `enrichResultFromRemoteDocuments`, `extractDocumentTextAttributes`, `documentAttributesAreSubstantive` |
| `document-url.ts` | `isPdfLikeDocument(Url)`, `documentUrlLooksRelevant`, `documentUrlLooksDownloadable` |
| `source-document-discovery.ts` | `discoverSourceDocumentsWithDiagnostics` |
| `pdf-ocr.ts` | `readPdfWithOptionalOcr` |
| `customer-documents.ts` | `extractCustomerDocumentAttributes`, `applyCustomerDocumentOverride`, `CustomerDocumentParseCache` |
| `catalog-number.ts` | `sameCatalogNumber`, `fillCatalogTemplate`, `catalogNumberVariants`, `buildConfiguredLocalizedUrls`, `compactCatalogNumber` |
| `product-identity.ts` | `structuredIdentityConflict`, `hasMatchingStructuredIdentity`, `identityConflictReason` |
| `marker-extractor.ts` | `extractMarkerData` |
| `electrical-spec-miner.ts` | `extractElectricalSpecAttributesFromText` |

### `src/server/scrapers/` — understanding engine
| Fajl | Ključni exporti |
| --- | --- |
| `normalizer.ts` | `mergeResults`, `emptyResult`, `normalizeFields`, `cleanText`, `splitNameValue`, `classifyDocument` |
| `ontology.ts` | `PROPERTY_ONTOLOGY`, `matchProperty`, `understand`, `findUnmappedSpecLabels` |
| `quantity.ts` | `parseQuantities`, `parseTemperatureRange`, `quantityMin/Max`, `ParsedQuantity` |
| `technical-attributes.ts` | `normalizeTechnicalAttributes` |
| `technical-attribute-aliases.ts` | `TECHNICAL_ATTRIBUTE_ALIASES`, `listTechnicalAttributeAliases`, `matchTechnicalAttributeAlias`, `suggestTechnicalAttributeAlias` (zadnji: prijedlog najbližeg kanonskog ključa za "Unmapped Labels") |
| `field-registry.ts` | `FIELD_REGISTRY`, `fieldDefinition`, `findFieldSourceAttribute`, `buildFieldHealth` |
| `device-type.ts` | `classifyDeviceType`, `knownDeviceTypes` |
| `device-type-families.ts` / `device-type-urls.ts` | `familyTypeFor` / `urlTypeFor` |
| `tight-context.ts` | `buildTightContextForCatalog`, `buildVariantColumnContext` |

### `src/server/scrapers/` — konektori (svi imaju `<Name>Connector`)
`abb.ts` `balluff.ts` `eaton.ts` `eta.ts` `fath.ts` `rockwell.ts` `sce.ts` `scame.ts` `schmersal.ts`
`schneider.ts` `siemens.ts` `spelsberg.ts` `turck.ts` — uz `parse<Vendor>ProductPage` helpere.
Config-driven (bez fajla): `nvent`, `phoenix`.

### `src/server/pdt/`
| Fajl | Ključni exporti |
| --- | --- |
| `exporter.ts` | `exportRunPdt`, `PdtExportResult` |
| `template.ts` | `resolveTemplatePath`, `loadTemplateWorkbook`, `DEFAULT_PDT_TEMPLATE` |
| `device-sheet-map.ts` | `deviceSheetsFor`, `targetSheets`, `knownDeviceSheets`, `CONSTANT_SHEETS` |
| `device-type-profiles.ts` | `DEVICE_TYPE_PROFILES`, `deviceTypeProfile`, `criticalFactsForDeviceType`, `eclassDefaultForDeviceType` |
| `eclass-resolvers.ts` | `resolveProperty`, `hasPropertyResolver`, `ResolveContext` |
| `facts.ts` | `buildPdtFactIndex`, `bestFact`, `PDT_ONTOLOGY_FACT_KEYS` |
| `documents-sheet.ts` | `writeDocumentsSheet` |
| `product-accessory-sheet.ts` | `writeProductAccessorySheet`, `CURATED_ACCESSORY_RULES` |
| `ai-cleaned-input-sheet.ts` / `cleaned-input-workbook.ts` | `writeAiCleanedInputSheet` / `writeCleanedInputWorkbook` |
| `ai-cleanup.ts` | `buildPdtRepairMap`, `buildPdtRepairResult` (opt-in Ollama/Qwen) |
| `rules.ts` | `pdtSheetOverrideRule`, `additionalPdtSheetsRule`, `localizedPdtDocumentUrlRules` |
| `pdt-compare.ts` | `comparePdtValues`, `valuesEquivalent` |
| `pdt-exceptions.ts` | `PDT_EXCEPTION_RULES`, `pdtExceptionRule` |
| `enum-encode.ts` | `parseEnumLegend`, `encodeEnum`, `isEnumColumn` |
| `unit-cleanup.ts` | `normalizePdtCellNumber`, `splitTemperatureRange`, `maxUnitNumber` |
| `iec-identifiers.ts` | `iec81346IdentifierForDeviceType` |
| `description-formatting.ts` / `sheet-descriptor.ts` | `compactFamilyShortDescription` / `describeSheet`, `clearBody`, `cellText` |

## 8. Konvencije

- **ESM:** importi u `.ts` koriste **`.js`** ekstenziju (`import … from "./db.js"`) — obavezno.
- **Skripte:** `.ts` → `tsx`; Node-only glue → `.cjs`.
- **Testovi:** `tests/`, ime prati modul (`quality-gate.ts`→`quality-gate.test.ts`), Vitest.
- **Lazy loading:** teški moduli (konektori, PDT, wizard) se učitavaju `await import(...)` u handleru/`getConnector` radi brzog starta — slijedi obrazac.
- **Deterministički princip:** vrijednost iz izvora/dokumenta/pravila; nepoznato ostaje prazno + dijagnostika. Općenito značenje u ontology/quantity/normalizer, ne one-off regexi.
- **Zajednički helperi:** za `cleanText`/`uniqueStrings`/`collapseWhitespace`/`slugify` importaj iz [text-util.ts](src/server/text-util.ts); za URL-usporedbu iz [url-util.ts](src/server/url-util.ts). **Ne** definiraj lokalne kopije (to su leaf moduli bez ovisnosti). CI: `npm run lint:dead` / `lint:orphans` / `lint:circular`.
- **Prije commita:** `npx tsc --noEmit` i `npx vitest run`. (Node toolchain možda nije na PATH-u — koristi `/c/Program Files/nodejs` + `npx`.)

## 9. Gdje tražiti što

| Trebaš… | Gledaj |
| --- | --- |
| Dodati/izmijeniti API rutu | [index.ts](src/server/index.ts) |
| Run lifecycle (pause/resume/cancel, konkurentnost, enrichment) | [run-manager.ts](src/server/run-manager.ts) |
| Dodati proizvođača | [config/manufacturers.ts](src/server/config/manufacturers.ts) + `scrapers/<id>.ts` + [scrapers/index.ts](src/server/scrapers/index.ts) |
| Scrape redoslijed / fallback | [deterministic-pipeline.ts](src/server/scrapers/deterministic-pipeline.ts), [smart-fallback.ts](src/server/scrapers/smart-fallback.ts) |
| Discovery / URL nalaženje | [discovery.ts](src/server/scrapers/discovery.ts), [link-discovery.ts](src/server/scrapers/link-discovery.ts), [learned-endpoints.ts](src/server/scrapers/learned-endpoints.ts) |
| Normalizacija / jedinice / značenja | [ontology.ts](src/server/scrapers/ontology.ts), [normalizer.ts](src/server/scrapers/normalizer.ts), [quantity.ts](src/server/scrapers/quantity.ts) |
| Ocjena found/partial/failed | [quality-gate.ts](src/server/scrapers/quality-gate.ts), [final-completeness.ts](src/server/scrapers/final-completeness.ts) |
| Čitanje PDF/datasheet | [document-enrichment.ts](src/server/scrapers/document-enrichment.ts), [pdf-ocr.ts](src/server/scrapers/pdf-ocr.ts) |
| Klasifikacija uređaja | [device-type.ts](src/server/scrapers/device-type.ts) |
| PDT izvoz / routing po sheetu | [pdt/exporter.ts](src/server/pdt/exporter.ts), [pdt/device-sheet-map.ts](src/server/pdt/device-sheet-map.ts) |
| Products Excel | [excel.ts](src/server/excel.ts) |
| SQLite shema / upiti | [db.ts](src/server/db.ts) |
| Layout outputa / putanje | [run-output.ts](src/server/run-output.ts), [paths.ts](src/server/paths.ts) |
| Dijeljeni tipovi | [shared/types.ts](src/shared/types.ts) |
| HTTP/cache/throttle/download | [http-client.ts](src/server/scrapers/http-client.ts) |
| Playwright rendering | [browser-renderer.ts](src/server/scrapers/browser-renderer.ts) |
| UI / dashboard | [client/App.tsx](src/client/App.tsx), [client/api.ts](src/client/api.ts) |
| Electron boot | [scripts/start-desktop.cjs](scripts/start-desktop.cjs), [desktop/main.cjs](src/desktop/main.cjs) |
| Benchmark / audit | `scripts/benchmark.ts`, `scripts/audit-*.ts` (`npm run benchmark`, `npm run audit:pdt`) |

## 10. Komande

`npm run dev` (API+UI) · `npm run desktop` (Electron) · `npm run server` · `npm run build` (`tsc --noEmit`+vite)
· `npm test` (vitest) · `npm run benchmark` · `npm run audit:pdt` · `npm run clean:pdt-input`.

---

> **Ovaj fajl ažurirati kod svake veće strukturne izmjene** (novi folder/modul, promjena pipeline
> redoslijeda, sheme baze ili dijeljenih tipova, nova/uklonjena ovisnost, novi exporti u §7).
> §5a/5b/7 se mogu osvježiti `npx madge` komandom iz §5d + ponovnim izvlačenjem exporta.
