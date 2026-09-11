# PROJECT MAP — product_scraper

> **Mapa projekta za AI agente.** Cilj: nađi pravi fajl / funkciju / tip **bez otvaranja fajlova**
> → minimalna potrošnja tokena. Pročitaj ovo prvo, pa skoči ravno na metu.
> API indeks (§7) i oblici tipova (§6) namjerno su detaljni da zamijene `grep`/otvaranje.
> Ljudski-orijentiran detalj: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 0. STATUS: plan NIJE dovršen — implementacija se mora nastaviti

> **Čitaj prije nego bilo što mijenjaš.** [docs/COLD-START-PLAN.md](docs/COLD-START-PLAN.md) nije
> dokumentacija gotovog stanja nego **plan u izvedbi**. Otprilike **91 % je napravljeno, ~9 % (≈5,9
> dana) ostaje**, i to nije „nice to have" — to su otvorene rupe u točnosti podataka.

**Što je otvoreno** (detalji i točan opseg: §0b „Stanje po fazama" u planu):

| faza | ostalo | što |
| --- | --- | --- |
| P3.1 učenje | ~1,2 d | PDF recipeji i šire replay politike |
| P2.1 PDF „ne znam" | ~1,1 d | šire kalibriranje PDF tablica |
| P3.4 wizard | ~1,0 d | šira selector/PDF politika |
| P2.4 discovery po dokazu | ~0,8 d | šira vendor/cache kalibracija |
| P2.2 pozicijski engine | ~0,7 d | ostatak kalibracije geometrije |
| P4 discovery bez logike u linkovima | ~0,6 d | živa provjera preostalih vendora |
| P2.3 OCR | ~0,4 d | kalibracija na skenu koji stvarno ispisuje naš SKU |
| P1.3 HTML tablice | ~0,2 d | šire pokriće oblika |

Zatvoreno 100 %: P0.1, P0.2, P1.1, P1.2, P1.4, P3.2, P3.3, P3.5.

**Dvije stvari koje nisu „preostali sati" nego poznata ograničenja:**

1. **Indeks naslova iz P4.11 nije izvediv iz sitemapa** — oni naslove ne nose, a dobiti ih znači
   dohvatiti svaku PDP stranicu, što je točno trošak koji indeks treba ukloniti.
2. **P4 je potvrđen uživo samo za `gan` i `fath`.** Ostali vendori nisu, a klasa
   `search-hits-unconfirmed` (siemens 5, turck 2 od 60) još nije objašnjena. Alat postoji:
   `npm run probe:vendor-search -- --vendor <id> --catalog "<broj>"`.

**Kako nastaviti, i zašto baš tako.** Plan ima pravila rada u §0b koja nisu preporuke — svako je
naučeno kroz pokvaren podatak. Najvažnije: **prvo mjerilo, pa kod**. §0c bilježi **tri** slučaja gdje
je mjerenje oborilo procjenu iz plana (P4.7 „najveći dobitak" → 1/60; P4.4 „najbolji omjer" → 1/23
hosta; `no-search-entry` 11/60 → **0** nakon što se odvojilo od „nije u korpusu"). Postoci po fazama
gore su zato **planska pomoć, ne mjerenje** — tvrde samo `eval`, `audit:*` i `probe:vendor-search`.

## 1. Pregled

Lokalni desktop alat za scrapanje podataka o industrijskim elektro/mehaničkim proizvodima iz
kataloga proizvođača. Učitaš CSV/XLSX s kataloškim brojevima → odabereš proizvođača → app scrapa
službene izvore, deterministički normalizira atribute, ocjenjuje kvalitetu i izvozi `products.xlsx`
+ opcionalni PDT workbook.

**Stack:** TypeScript (ESM, `"type":"module"`) · Node + **Express 5** · **React 19 + Vite** · **Electron**
· **better-sqlite3** · **Playwright** (+ **patchright** stealth variant) · **got-scraping** ·
**fingerprint-injector**/**fingerprint-generator** · ExcelJS / csv-parse / pdf-parse / sharp / tesseract.js · **Vitest**.
Sve lokalno na `127.0.0.1:3001`, bez cloud key-a. Runtime LLM (PDT AI cleanup) je opt-in
(`PDT_AI_CLEANUP=1`, lokalni Ollama/Qwen). Reader fallback (r.jina.ai — šalje URL trećoj strani) je
također opt-in: `PRODUCT_SCRAPER_ALLOW_EXTERNAL_READER=1`. Princip: vrijednosti dolaze iz izvora — **nepoznato se ne pogađa**.
Anti-bot hardening (2026-09): primarni HTTP fetch (`http-client.ts`) ide preko **got-scraping**
(TLS/HTTP2 fingerprint bliži pravom browseru, vlastiti headeri ostaju fiksni radi `page_cache` ključa)
umjesto golog `fetch()`; Playwright fallback (`browser-renderer.ts`) koristi **patchright** (drop-in,
uklanja CDP automation-artefakte), default-on ad/tracker domain block (`ad-block-domains.ts`, vendano
iz Peter Lowe liste), realan `fingerprint-injector` profil umjesto fiksnog UA stringa, i bounded wait
na Cloudflare non-interactive/managed izazov. `PRODUCT_SCRAPER_STEALTH_BROWSER=0` vraća na goli
playwright ako patchright ikad zakaže na nekoj mašini.

## 2. Struktura

| Folder / fajl | Čemu služi |
| --- | --- |
| `src/server/` | Express API, orkestracija runova, DB, I/O, layout outputa |
| `src/server/scrapers/` | **Srce sustava** — konektori po proizvođaču + zajednička infra + "understanding engine" (43 fajla; ReeR koristi `reer.ts` REST-to-canonical-PDP konektor); uz to `cohort-anomaly.ts` (cross-record MAD-outlier detekcija) i `field-coverage-drift.ts` (shape-drift baseline po proizvođaču), obje pozvane iz `run-manager.ts` `finalizeRun`, pure/offline, bez DB pristupa same po sebi |
| `src/server/pdt/` | Generiranje PDT Excela iz rezultata runa (22 fajla) |
| `src/server/config/` | `manufacturers.ts` — built-in profili + custom config |
| `src/client/` | React UI (`App.tsx` monolitan, `Dropdown.tsx`, `api.ts`, `main.tsx`, `styles.css`) |
| `src/desktop/` | Electron `main.cjs` / `preload.cjs` |
| `src/shared/` | `types.ts` (+ `product-requirements.ts`) — tipovi za client i server. `product-requirements.ts` (`requiredElectricalFields`) dijeli **dva korpusa**: "kakav je ovo uređaj" (bez tuđeg teksta — naslovi dokumenata, PDF proza, liste pribora) i "postoji li objavljeni rating" (SVE, dokumenti se računaju). Miješanje je dizalo napon na obično kućište (`hmi` iz naslova priručnika, `pressure` iz PDF proze) i gasilo ga PLC-u kojemu rating živi samo u PDF-u |
| `tests/` | Vitest (44 fajla; 1 fajl ≈ 1 modul) |
| `scripts/` | audit / benchmark / probe / desktop-boot alati (`.ts`→tsx, `.cjs`→Node) |
| `templates/` | `master_pdt.xlsx` — izvor istine za PDT |
| `patches/` | `patch-package` patchevi za bugove u ovisnostima (npr. `pdf-parse` `getTable()` crash) — auto-primijenjeno `npm install` postinstall hookom, **ne brisati** |
| `benchmarks/` | Fixture proizvodi + izvještaji (**mrežni** live-check); `products/` je regresijski corpus, `cold-products/` je odvojeni skup novih artikala/obitelji za otkrivanje endpoint-drifta, a proizvođački izolirani audit korpusi (npr. `rockwell-15-new/`, `rockwell-15-new-2/`) drže strogo odabrane cold-start uzorke |
| `fixtures/` | **Offline eval korpus** — snimljeni HTML/PDF + `expected.json` s asertacijama na razini *vrijednosti* (`npm run eval`). Postoji jer je `benchmarks/` mrežni i tvrdi samo `Boolean(field)`, pa mu je klasa "vrijednost postoji ali je pogrešna" nevidljiva. Vidi [fixtures/README.md](fixtures/README.md) |
| `docs/` | `ARCHITECTURE.md`, `COLD-START-PLAN.md` (analiza+plan za nepoznate vendore/datasheetove), `CLAUDE-HANDOFF.md` (zadnja točka rada i copy/paste prompt), prezentacije, normalizacijske bilješke |
| `outputs/` `data/` `tmp/` | Runtime artefakti (DB, cache, workbookovi) — **ne uređivati ručno** |

## 3. Ulazne točke

- **API server:** [src/server/index.ts](src/server/index.ts) — sve `/api/*` rute. Sluša `127.0.0.1:${PORT||3001}`.
- **Dev:** `npm run dev` (API watch + Vite). **Server only:** `npm run server`.
- **Desktop:** `npm run desktop` → [scripts/start-desktop.cjs](scripts/start-desktop.cjs) → [src/desktop/main.cjs](src/desktop/main.cjs) → spawn server → BrowserWindow. `getServerRuntime()` **probira** kandidate (npm node → system node u Program Files → PATH node → bundlani `.runtime/node` → Electron-as-node) i bira **prvi koji stvarno može instancirati better-sqlite3** (`new Database(':memory:')`) — izbjegava NODE_MODULE_VERSION crash kad je native modul buildan za drugu Node verziju od runtimea (npr. stari portable v22 vs modul za v24).
- **UI:** [src/client/main.tsx](src/client/main.tsx) → [App.tsx](src/client/App.tsx); API pozivi u [api.ts](src/client/api.ts).
- **Scrape orkestracija:** [run-manager.ts](src/server/run-manager.ts) (`RunManager.processRun`).

**API rute (sve u `index.ts`):** `GET/POST /api/manufacturers` (+`/:id/operational-summary` za read-only target-health/learned-endpoint pregled, `/inspect`,`/test`,`/:id/learned-extractors`,`/:id/reset-override`)
· `GET /api/field-coverage-matrix` (site×field health matrica preko SVIH proizvođača — `run-manager.ts` `buildFieldCoverageMatrix`, renderano u `App.tsx` `FieldCoverageMatrixPanel`, uvijek expanded kad postoji drift)
· `POST /api/csv/preview` · `POST /api/runs` (multipart: CSV + customer docs) · `GET /api/runs[/:id]`
(`?summary=1` → `summarizeRunItem`) · `PATCH /api/runs/:id/coverage-fields`
· `POST /api/runs/:id/{cancel,pause,resume}` · `/files/{result,pdt,log,document}` (+`/open`)
· `GET /api/runs/:id/pdt-routing-preview` · `POST /api/runs/:id/pdt`
· `POST|DELETE /api/runs/:id/accessory-matrix` (multipart XLSX; parsira se odmah pa je pogrešan fajl odbijen dok operater još gleda picker; sprema se u `RunOptions.accessoryMatrix` i time nadjačava matrix priložen pri startu runa)
· `POST /api/accessory-matrix/preview` (matrix prije nego run postoji → main partovi + točke). **`POST /api/runs` više ne zahtijeva CSV:** ako je poslan samo `accessoryMatrix`, kataloški brojevi su njegovi main partovi (`accessoryMatrixCatalogNumbers`, ista normalizacija kao `extractCatalogNumbers`), a `inputFileName` je ime matrixa; accessory brojevi se **ne** scrapaju.

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
  ├─ search-results.ts                                         # presuda rezultatske stranice (0 / N pogodaka / JS shell / blokirano)
  ├─ opensearch.ts                                             # vendorov vlastiti search template iz <link rel=search>
  ├─ product-aliases.ts                                        # drugo ime istog proizvoda (tipska oznaka / narudžbeni kod / GTIN)
  ├─ external-search.ts                                        # opt-in vanjski search bridge (default ISKLJUČEN)
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
  ├─ cohort-anomaly.ts (detectCohortAnomalies)          # cross-record MAD-outlier flags within the run's own device-type cohorts, patched into run_items
  ├─ field-coverage-drift.ts (detectFieldCoverageDrift)  # this run's per-field fill-rate vs the manufacturer's recent completed-run baseline
  ├─ excel.ts (exportRunWorkbook) → outputs/.../excel/<...>.xlsx   # surfaces both above as review flags + a Run Summary warning section
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
| 17 | `scrapers/index.ts` | Registar/lazy-load konektora, uključujući ReeR |
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
                                          //  localPath?,downloadStatus?,parseStatus?,enrichable?,...}
                                          //  enrichable:false → link se čuva/skida ali PDF-mining
                                          //  enrichment ga preskače (npr. Ganter multi-varijantni katalozi)
  sources: SourceRecord[];                // {url,sourceType:official|official-fallback|distributor|cache|generated,parser,...}
  qualityGate?; diagnostics?; evidence?: EvidenceRecord[];
  // diagnostics.terminal?.skipNetworkFallback marks an authoritative negative connector response:
  // row stays failed, but run-manager skips remote-document/discovery/browser retries and moves on.
  // diagnostics.cohortAnomalies?: CohortAnomalyDiagnostic[] — patched in post-run by cohort-anomaly.ts,
  // review-only flag, value itself is never touched. See scrapers/cohort-anomaly.ts in §7.
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
             customerDocuments?: CustomerDocumentRecord[]; accessoryMatrix?: CustomerDocumentRecord }
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
| `run-manager.ts` | `RunManager`, `documentDownloadProfile`, `shouldDownloadDocumentsForRun`, `documentDownloadCandidateUrls`, `imageFileName`; debug bundle uključuje learned endpoints i recent `stageObservations` |
| `db.ts` | `ScraperDb` (svi DB upiti), uključujući `listStageObservations` za newest-first raw history i `listTargetHealth` za bounded per-host/stage dashboard prozore iza `target_health` agregata |
| `csv.ts` | `previewCsv`, `extractCatalogNumbers` |
| `excel.ts` | `exportRunWorkbook` — izvozi `Unmapped Labels` teach-list s `quantity`/`text` kindom, deterministic/local-AI review prijedlozima i human review stupcima (approve/reject/needs-evidence, reviewer, source/fixture, note); workbook se nikad ne čita natrag u alias ili parser konfiguraciju |
| `manufacturer-wizard.ts` | `inspectManufacturerDraft`, `testManufacturerDraft`, `confirmedLearnedExtractorSuggestions`, `wizardValidationKey`, `buildWizardAliasSuggestions`, `downloadWizardDocument`, `approveWizardLearnedExtractor`; save-gate zahtijeva 2/3 official identity-confirmed uzorka, UI nudi mined recipe za Save tek kada se isti strogi obrazac ponovi na dva takva uzorka, a server prihvaća approval samo uz svježi testni dokaz vezan uz isti ID/službene hostove. Potvrđeni PDP zapisuje reproducibilni HTML/case fixture pod wizard outputom, a do 8 enrichable službenih dokumenata prolazi isti PDF enrichment kao regularni run; nikad u curated korpus; API dopušta samo službeni HTTPS, host-matching `css:table-row:tr…`, `json:script:#id` ili strogi `html-table:header-column:table#id-or-class:encoded-header` recipe koji miner već zna replayati |
| `scrapers/eaton-ordering-inference.ts` | Isključivo Eaton RapidLink offset/model-code adapter; shared `document-enrichment` predaje mu dokazanu baznu ordering-row funkciju, pa drugi proizvođači ne mogu naslijediti CDVRL/RASP5X pretpostavke |
| `scrapers/pdf-positioned-table.ts` | Geometrijski PDF reader za comparison i ordering tablice; dominantno rotirane stranice normalizira cijele, a miješane stranice projicira samo dokazani vertikalni SKU-header sloj (≥2 variant tokena) |
| `scrapers/llm-pdf-layout-proposals.ts` | Lokalni, po defaultu ugašen review helper: za već poznati PDF dopušta samo postojeći deterministic reader i bounded broj stranica; nema scraper import ni write-back put za vrijednosti, selektore, recepte ili konfiguraciju |
| `config/manufacturers.ts` | `getManufacturerConfig`, `listManufacturerConfigs`, `saveManufacturerConfig`, `initializeManufacturerConfig`, `resetManufacturerOverride` |
| `paths.ts` | `AppPaths`, `createAppPaths` |
| `run-output.ts` | `buildRunOutputLayout`, `ensureRunOutputLayout`, `getAllowedRunOutputRoots`, `isPathInsideAny`, `findRunLogPath` |
| `run-item-summary.ts` | `summarizeRunItem` |
| `unit-conversion.ts` | `POUND_TO_KILOGRAM`, `POUND_TO_GRAM`, `OUNCE_TO_KILOGRAM`, `OUNCE_TO_GRAM`, `INCH_TO_MILLIMETER` — **leaf**, jedini izvor istine za imperijalne faktore (egzaktne definicije). Prije je pet modula imalo svoje kopije, tri odrezane (`0.453592`), pa je isti Saginaw kg izlazio različit iz products.xlsx i iz PDT resolvera. Ne deklarirati lokalne kopije.
| `text-util.ts` | `cleanText`, `collapseWhitespace`, `collapseWhitespaceOrUndefined`, `uniqueStrings`, `slugify` — **leaf** text helpers (dependency sink; import from here, no local copies) |
| `url-util.ts` | `sameNormalizedUrl`, `sameUrlIgnoringHash`, `sameUrlOriginAndPath` — **leaf** URL-equality helpers (3 distinct semantics — see file header) |

### `src/server/scrapers/` — infrastruktura
| Fajl | Ključni exporti |
| --- | --- |
| `index.ts` | `getConnector` |
| `types.ts` | `ScrapeContext` (uklj. per-item `discoveryMemo` koji connector/fallback/final retry dijele), `ManufacturerConnector` |
| `http-client.ts` | `CachedHttpClient`, `FetchedText`, `delay`, `DEFAULT_USER_AGENT` (aktualni Chrome UA; ABB/Siemens Akamai edge odbija stare verzije). Primarni tekstualni fetch (`fetchTextWithRetry`) ide preko `got-scraping` (`fetchViaGotScraping`, `useHeaderGenerator:false` da headeri ostanu deterministički za cache-key) umjesto golog `fetch()` — curl/PowerShell fallbackovi i `fetchBufferWithRetry` (downloadi slika/dokumenata) namjerno ostaju na golom `fetch()` |
| `browser-renderer.ts` | `BrowserRenderSession`, `renderProductPage`, `RenderedPage`, `ModalSection`, `clickSafeSelectors`, `captureFrameFragments`, `captureShadowDomFragments` (zadnja tri exportana za testove: klik-petlja s re-scanom + iframe + shadow-DOM capture). Browser je `patchright` (fallback na `playwright` ako nedostupan; `PRODUCT_SCRAPER_STEALTH_BROWSER=0` prisilno vraća na `playwright`), context gradi `createFingerprintedContext` preko `fingerprint-injector`/`fingerprint-generator` (fallback na stari fiksni UA/viewport). `applyRequestFiltering` (jedan `page.route` po pageu) kombinira opt-in `blockResourceTypes` s default-on ad/tracker blockom (`ad-block-domains.ts`; opt-out `interactionPolicy.disableAdBlock`). `waitForNonInteractiveCloudflareChallenge` (bounded, 8s default) čeka da Cloudflareov `cType: 'non-interactive'\|'managed'` marker nestane prije nastavka — "interactive" (checkbox) Turnstile namjerno nije handlean |
| `ad-block-domains.ts` | `AD_BLOCK_DOMAINS`, `isAdBlockedHost`, `isAdBlockedUrl` — vendana Peter Lowe ad/tracker lista (~3500 domena, ista koju koristi Scraplingov `block_ads`), suffix-chain matcher; regenerirati re-fetchanjem izvora, ne ručno editirati |
| `deterministic-pipeline.ts` | `runDeterministicScrapePipeline` — nakon stvarnog quality-gate prolaza predaje potvrđeni službeni PDP u `learnEndpointFromNetworkFetch`, pa se samo dokazani `{part}` URL put sprema za iduće kataloge; connectorov i oba fallback pokušaja dijele itemov discovery memo |
| `discovery.ts` | `discoverOfficialProductCandidates`, `scoreDiscoveryCandidate` — memoizira uspješan discovery samo unutar `ScrapeContext.discoveryMemo`; transient rejection se izbacuje da retry smije pokušati ponovno |
| `discovery-fallback.ts` | `scrapeDiscoveredFallback`, `withDiscoveryFallbackDiagnostics` |
| `link-discovery.ts` | `findBestProductLink`, `discoverProductLinks(WithDiagnostics)` |
| `learned-endpoints.ts` | `LearnedEndpointStore`, `learnedEndpointUrls`, `learnEndpointFromNetworkFetch` |
| `search-results.ts` | `searchResultVerdict`, `looksClientRenderedSearchShell` — Čista funkcija: čita vlastitu presudu rezultatske stranice (`zero`/`hits`/`js-only`/`blocked`/`unknown`) iz EN/DE/FR/IT/ES/NL fraza i ispisanog broja pogodaka. Zasad je koristi samo `audit:search-reachability`; runtime rutiranje je P4.5 |
| `opensearch.ts` | `openSearchDescriptionUrls`, `openSearchTemplates`, `fillOpenSearchTemplate` — Čita vendorov objavljeni search/suggest template iz `<link rel="search" type="…opensearchdescription+xml">`. Koristi ga `discoverSearchFormRequests` iz već dohvaćenog homepagea. **Izmjereno: samo 1 od 23 hosta u korpusu ga uopće deklarira** — kad linka nema ne košta ništa |
| `product-aliases.ts` | `harvestProductAliases`, `aliasSearchTerms`, `ProductAliasStore` — Skuplja vendorova druga imena s potvrđenog PDP-a (tablica `product_aliases`) i vraća ih kao UPITE za tražilicu. `identityLevel: "family"` (tipska oznaka je često 1:više) smije biti upit, nikad dokaz identiteta |
| `external-search.ts` | `externalSearchEnabled`, `externalSearchUrl`, `parseExternalSearchResults` — Opt-in (`PRODUCT_SCRAPER_ALLOW_EXTERNAL_SEARCH=1`), default isključen jer šalje šifru trećoj strani. Rezultati prolaze official-domain guard pa post-fetch identity gate |
| `localized-urls.ts` | `buildLocalizedProductUrls`, `canonicalizeNventLocaleUrl`, `canonicalizeProductLocaleUrls` (collapse geo-locale `/en-xx/`→`/en-us/`) |
| `generic.ts` | `parseGenericProductPage`, `GenericFallbackScraper`, `isUnresolvedSearchResultPage` |
| `html-table-reader.ts` | Span-aware DOM table reader used by `generic.ts` and adaptive `page-mining.ts`: expands colspan/rowspan into a matrix, merges headers and selects the one catalog/ordering-code variant column; it also selects a unique ordering-code row in two-cell option lookups and target-labelled columns in a one-row interactive configurator. Repeated coordinates of the same colspan label cell are layout only and never echoed into its value; ambiguous selections emit nothing. It can replay a validated stable table plus actual header input, but still re-proves the requested catalog variant. |
| `html-page-level.ts` | PDP-vs-family classifier for generic HTML: detects target-plus-sibling catalog codes in product content and requires variant scope before family-page values can fill variant fields. |
| `smart-fallback.ts` | `runSmartFallbackPipeline` |
| `page-intelligence.ts` | `runAdaptivePageIntelligence`, `mergeFetchedPageMining` — u `learned_extractors` zapisuje samo replayable CSS-row, JSON-script i span-aware HTML-table recipeje te ograničene `capped:*` mine-budget hintove; dokazani recipeji se mogu predložiti wizardu, a tek operatorovo odobrenje na službenom hostu ih sprema za replay |
| `page-mining.ts` | `minePage`, `PageMiningResult`, `PageMiningOptions`, `isPersistableLearnedPattern`; compactni inline `Label: value` tekst segmentira strogo preko ontološkog/registry label-prefixa, bez engleskog allowlista. `css:table-row:tr#id` / `tr.class`, `json:script:#id` i `html-table:header-column:table#id-or-class:encoded-header` learned recipeji su strogo whitelistani i replayaju se prije generičkog sweeepa; HTML recept ponovno bira traženi katalog kroz matrix reader, pa ne spaja sibling stupce. |
| `interaction-explorer.ts` | `adaptiveInteractionSelectors` |
| `field-candidates.ts` | `applyFieldCandidateResolution`, `buildFieldCandidates`, `buildFieldResolutions` |
| `mission-control.ts` | `shouldRunAdaptiveMining`, `driftFromTargetHealth` |
| `target-health-policy.ts` | zajednička policy za normalni 8-sample drift i strogi 3-sample catastrophic bootstrap; istu odluku koriste runtime adaptive mining i DB operational summary |
| `target-health.ts` | `recordTargetObservation` |
| `quality-gate.ts` | `evaluateQualityGate`, `applyQualityGate`, `finalizeQualityGate`. **Opt-out:** `qualityPolicy.notApplicableFields` briše polje i iz `requiredNormalizedFields` liste i iz device-type električnog zahtjeva — bez toga gate vječno pada na polju koje korisnik ne traži i svaki takav red plati dodatni fallback krug |
| `final-completeness.ts` | `evaluateFinalCompleteness`, `repairFinalCompletenessFromEvidence`, `finalNetworkRetryDecision`, `withFinalCompletenessPolicy`. `notApplicableFields` se u `finalFieldRequirement` provjerava **prvo** (prije profila i električne heuristike) → polje ne ulazi u `retryMissing`, pa nema mrežnog retryja |
| `evidence.ts` | `attachEvidence` (+ field candidate/resolution diagnostics) |
| `dedupe.ts` | `dedupeAttributes`, `dedupeDocuments`, `dedupeSources`, `canonicalDocumentUrlKey` |
| `cohort-anomaly.ts` | `detectCohortAnomalies` — cross-record outlier check per run: groups results by `classifyDeviceType`, MAD-based robust z-score (`(x-median)/(1.4826*MAD)`, threshold 3.5) per numeric field (weight/voltage/current/operatingTemperature{Min,Max}) within each device-type cohort; N<8 or MAD=0 falls back to a 10x order-of-magnitude ratio check for strictly-positive fields only (skipped for temperature — ratios are meaningless around/below zero). Flags for review only, never mutates a value. Wired in `run-manager.ts` `applyCohortAnomalyDiagnostics`/`cohortAnomalyPatchesForRun`, patched into `run_items.result.diagnostics.cohortAnomalies` (`shared/types.ts` `CohortAnomalyDiagnostic`), surfaced in `excel.ts` Clean Export "Cohort Anomaly" column + folded into Review Reason/Issue Type/Suggested Action |
| `field-coverage-drift.ts` | `detectFieldCoverageDrift`, `fieldCoverageSnapshot`, `buildFieldCoverageMatrixRow` — shape-level drift: this run's per-field fill-rate (`TRACKED_COVERAGE_FIELDS`: image/weight/dimensions/material/certificates/voltage/current/color/protection/operatingTemperature) vs a rolling baseline of the same manufacturer's last completed runs (`db.ts` `listCompletedRunsByManufacturer`/`listManufacturerIdsWithCompletedRuns`). Needs >=2 usable baseline runs and a previously-well-populated field (>=30%) before flagging a >=25pp drop — catches "the site changed" fast instead of it looking like normal per-run variation. Computed at export time in `run-manager.ts` `computeFieldCoverageDrift` (per-run, into the Excel Run Summary "⚠ Coverage drift" section) **and** on demand across all manufacturers via `run-manager.ts` `buildFieldCoverageMatrix` (dashboard matrix, `GET /api/field-coverage-matrix`) — neither path persists anything, both are cheap to recompute from `run_items` |
| `document-enrichment.ts` | `enrichResultFromDownloadedDocuments`, `enrichResultFromRemoteDocuments`, `extractDocumentTextAttributes` (now also takes `tables?: TableArray[]` from `pdf-parse`'s `getTable()` vector-grid table detection), `documentAttributesAreSubstantive`, `looksLikeMultiVariantFamilyPage` (jeftin, bez re-parsea: neka linija prints naš catalog uz ≥1 drugi distinct model-kod → familijska/usporedna stranica; force-runa positioned reader čak i kad W/D izgledaju čisto, jer tab-heuristika zna napuniti cross-model vrijednost koja *izgleda* čista). Family-prefix PDF evidence is stamped `matchLevel: family` and may retain only shared material/standard/certification attributes; product rows remain exact-only. |
| `pdf-positioned-table.ts` | `extractPositionedTableRows(FromPdf)`, `extractPositionedWeightAndDimensions(FromPdf)`, `extractPositionedOrderingRow`, `normalizeDominantPageOrientation`, `derivePositionedTableGeometry` — **strukturno pouzdan** tablični čitač: klasterira prave x/y iz `pdfjs-dist` → rekonstruira vizualne stupce (rješava merged-column tablice koje tekst/tab heuristika ne može). X/Y tolerancije su medijan stvarnih SKU-stupaca i line baselinea (fallback su dokazani stari pragovi), pa uski susjedni stupci ne kolabiraju. Dominantno rotirana stranica vraća se u isti prostor iz `[a,b,c,d]` transformi prije prechecka i carry-overa; miješani vertikalni headeri se konzervativno ne miješaju. Uz catalog-in-header put, fallback `extractPositionedOrderingRow` čita row-orijentiranu tablicu: exact target-model red → headeri u istom x-stupcu (bez prefix-nagađanja). `extractPositionedTableRowsFromPdf` prenosi prethodni target-header samo na neposredno x/y-kompatibilnu continuation stranicu i resetira ga na prvom neuspješnom mapiranju. **Anchor generaliziran s Rockwell "Catalog Number" na BILO KOJI proizvođač:** `candidateHeaderAnchors` sidri na jaki id-label iz `catalog-table-vocabulary` (EN/DE/FR/IT), a ako ga nema — sintetizira anchor iz header-reda variant-tokena + najljevljeg label-stupca; page-gate (`pageMentionsCatalog`) veže se na NAŠ kataloški token, ne na literal. Refuse-to-guess: naš token u >1 x-klasteru → undefined |
| `spec-plausibility.ts` | `isPlausibleSpecValue`, `isPlausibleSpecLabel`, `isPlausibleSpecPair`, `looksLikeHeaderRowValue`, `specPlausibilityGateDisabled` — **leaf** gate "je li ovo uopće specifikacija". Vezan na DVA choke pointa: `stampDocumentAttributes` (svi PDF čitači) i `parseGenericProductPage` prije capa (svi HTML ekstraktori). Odbacuje C0 kontrolne znakove (pokvaren font cmap), TOC dot-leadere, inline CSS, boilerplate/imprint, **instrukcije** (`should`/`must`/`be installed`), rečenične fragmente, nezatvorene zagrade, cijele rečenice i **header red parsiran kao podatak**. Jedno pravilo na granici umjesto zakrpa po ekstraktorima. **Zamka:** jedinice kolidiraju s funkcijskim riječima (`A`=amper vs član, `in`=inch, `F`/`K`) → fragment-pravila se primjenjuju samo na tekst BEZ cifara. Kill switch `PRODUCT_SCRAPER_DISABLE_SPEC_GATE=1` (call-time) za audit i kao operativni ventil |
| `catalog-table-vocabulary.ts` | `catalogTableKeyFor` (header ćelija → kanonski ključ, EN/DE/FR/IT), `isCatalogIdHeaderCell` (jaki id-stupac label whole-cell), `isCatalogTableHeaderText` (broad header-row test) — **jedini izvor istine** za tablične headere; prije dupliciran regex u 3 funkcije `document-enrichment.ts` (draftao). Ne uvoditi lokalne kopije |
| `document-url.ts` | `isPdfLikeDocument(Url)`, `documentUrlLooksRelevant`, `documentUrlLooksDownloadable` |
| `document-viewer-resolver.ts` | `isDocumentViewerUrl`, `extractEmbeddedPdfAssetUrl`, `resolveViewerPdfUrl` — HTML PDF-viewer wrapper → pravi (potpisani) PDF asset. Konkretno ABB library `search.abb.com/library/Download.aspx?...&Action=Launch` vraća HTML s `<iframe src=library.e.abb.com/.../<id>_view.pdf?x-sign=…>`; run-manager (`resolvePdfDownloadPlan`) ga razriješi pri downloadu i skine PDF, a u exportu čuva stabilni Download.aspx link (potpisani URL brzo istekne) |
| `discovery.ts` | `discoverOfficialProductCandidates`, `scoreDiscoveryCandidate`, `scoreFetchedDiscoveryEvidence` — URL score samo određuje redoslijed pokušaja; nakon fetch-a exact SKU mora biti na PDP identity surfaceu (`title`/`h1`/OG/Product JSON-LD) prije parsiranja i mergea. Search-result effective URL nije dokaz čak ni ako ponavlja SKU, **osim** kad službeni catalog-search HTTP redirect već završava na ne-search URL-u s exact SKU-om: tada se taj browser-observed PDP URL čuva kao kandidat, ne konstruira se. Kada lokalni homepage nema formu, najviše dva njegova službena `hreflang` alternata mogu biti dodatni locale ulazi za stvarni GET/POST search-form submit. |
| `source-document-discovery.ts` | `discoverSourceDocumentsWithDiagnostics` |
| `pdf-ocr.ts` | `readPdfWithOptionalOcr`, `pdfPagesNeedingOcr`, `inferOcrLanguage`, `ocrLinesToPositionedItems` (pdftoppm+tesseract CLI first; falls back to pdf-parse's `getScreenshot()` + `tesseract.js` WASM OCR when those binaries aren't on PATH — always available, no install needed). OCR je per-page: samo sparse/glyph-noisy native stranice se renderiraju, rezultat prolazi quality gate, a lokalni jezik se bira samo iz ≥2 specifična native tehnička signala; nejasno ili bez paketa → `eng`. Pri JS OCR-u pouzdani line bboxovi ostaju y-up positioned items i prolaze kroz isti SKU-column dokaz `pdf-positioned-table.ts`; nisu slobodni tekstualni sweep |
| `customer-documents.ts` | `extractCustomerDocumentAttributes`, `applyCustomerDocumentOverride`, `CustomerDocumentParseCache` |
| `catalog-number.ts` | `sameCatalogNumber`, `fillCatalogTemplate`, `catalogNumberVariants`, `buildConfiguredLocalizedUrls`, `compactCatalogNumber`, `findCatalogTextMatch` / `catalogMatchLevel` — strict boundary-safe exact identity plus explicit separator-bounded family level. Do not replace legacy tolerant `catalogTextMatches` globally. |
| `ordering-code-legend.ts` | Generic `CODE = value` / declared-position ordering-code legend decoder. Only decodes a one-character option when the source declares its code position; `document-enrichment.ts` uses it before the legacy protection-specific fallback. |
| `product-identity.ts` | `structuredIdentityConflict`, `hasMatchingStructuredIdentity`, `identityConflictReason` |
| `marker-extractor.ts` | `extractMarkerData` |
| `electrical-spec-miner.ts` | `extractElectricalSpecAttributesFromText` (hand-tuned voltage/current/power), `extractOntologySpecAttributesFromText` (same label+context-window engine driven by `ontology.ts`'s `PROPERTY_ONTOLOGY` — mines dimensions/weight/temperature/torque/pressure/etc. directly from PDF prose), `extractInlineNameplateSpecAttributes` (unlabeled comma-separated nameplate strings "3AC 230V, 5.5kW, 20A" / "3x400V ±10%, 50/60Hz, 7.5HP, IP20" — tokenizer čistih value+unit segmenata s fazom/AC-DC/tolerancijom/HP/kVA/IP/temp/kg; gate: ≥2 električna pogotka ili napon+frekvencija po liniji; koristi se i po ćeliji u customer xlsx/CSV matrici) |

### `src/server/scrapers/` — understanding engine
| Fajl | Ključni exporti |
| --- | --- |
| `normalizer.ts` | `mergeResults`, `emptyResult`, `normalizeFields`, `cleanText`, `splitNameValue` (dijeli na `:`/`=`, odbacuje value-fragment "labele" preko `isValueFragmentLabel` ali čuva "W x H x D"), `isValueFragmentLabel`, `classifyDocument`. **kA surge/fault (breaking capacity, discharge/impulse/short-circuit current) NE smiju u rated current** — `isLowValueCurrentLabel` gard u SVA 4 puta (bestNormalized/registry/ontology/inferred); `Ui`/`Uimp` isto preko `isLowValueVoltageLabel`. NB: 3 divergentna label-sustava (FIELD_LABEL_PATTERNS+FIELD_REGISTRY+ontology) → gard treba u svakom putu |
| `evidence-score.ts` | `evidenceTier`, `evidenceConfidence` — imenovani provenance tierovi (`official-document`, `official-page`, fallback, generated, cache, distributor) i zajednička ograničena 0..1 baza za rangiranje evidence izvora u normalizeru, field-candidate rezoluciji i final-field repairu; customer override i field-semantika ostaju izvan ovog leafa |
| `evidence-audit.ts` | `auditResultEvidence` — zajednički offline dokaz provenance pokrivenosti za spremljeni rezultat: svaku atributnu/dokument/source činjenicu mapira u isti tier i score, nasljeđuje source metadata samo kada URL stvarno odgovara, te prijavljuje nerazriješiv URL ili raw confidence izvan 0..1; CLI `audit:confidence` radi nad najnovijim stvarnim rezultatima svakog konektora |
| `llm-label-proposals.ts` | `proposeUnmappedLabelMappings` — eksplicitno opt-in lokalni Ollama batch za review-only `unmapped label → postojeći canonicalKey` prijedloge; validira točnu ulaznu oznaku i ontology allow-list te nikad ne dodaje alias, mijenja vrijednost ili ulazi u parser |
| `ontology.ts` | `PROPERTY_ONTOLOGY`, `matchProperty`, `matchPropertyPrefix`, `understand`, `findUnmappedSpecLabels`, `inferPropertyFromQuantities` (unit-driven fallback za labele koje nijedan sinonim ne zna: V/A/W/Hz/°C/kg vrijednost → ratedVoltage/ratedCurrent/power(Loss/Consumption)/frequency/operating-storageTemperature/weight, s višejezičnim blokadama opasnih kvalifikatora; `findUnmappedSpecLabels` nosi review-only `{label,valueKind}` i za kratke tekstualne vrijednosti iz spec-konteksta, ali odbija meta/search/document šum; koristi ga technical-attributes (`matchType:"unit_inference"`, niži confidence) i normalizer kao zadnji fallback za voltage/current/weight) |
| `quantity.ts` | `parseQuantities`, `parseTemperatureRange`, `quantityMin/Max`, `ParsedQuantity`. Jedinice uklj. **°F/degF→°C konverzija** (prije: "-40 to 185 °F" se čitao kao 185 °C), `%`,`rpm`,`hp`,`N/kN`,`dB`,`ms/s`,`hPa/mmHg/Torr/atm`; kind-ovi force/speed/soundLevel/time/ratio. Bare `N`/`s` zadnji u UNIT_PATTERN + `(?![a-zµ])` gard; `Nm` prije `N`. ± tolerancija `%` se filtrira iz matcheva prije petlje |
| `technical-attributes.ts` | `normalizeTechnicalAttributes` |
| `technical-attribute-aliases.ts` | `TECHNICAL_ATTRIBUTE_ALIASES`, `listTechnicalAttributeAliases`, `matchTechnicalAttributeAlias`, `suggestTechnicalAttributeAlias` (zadnji: review prijedlog najbližeg kanonskog ključa za `Unmapped Labels`, ali tek od 0,75 i samo globalni + eksplicitno odabrani manufacturer aliasi; manufacturer ID je otvoreni string za nove vendore) |
| `field-registry.ts` | `FIELD_REGISTRY`, `fieldDefinition`, `matchRegistryFieldLabelPrefix`, `findFieldSourceAttribute`, `buildFieldHealth`; health zadržava čitljiv `reason` i stabilni `reasonCode` za discovery/parse/scope/conflict/value-rejection blokatore |
| `shared/run-diagnostics.ts` | `summarizeRunDiagnostics` — shared, payload-only agregat `reasonCode` blokatora, document procesa i discovery odbijanja za run dashboard; ne uvodi novu heuristiku niti zahtijeva raw result JSON |
| `device-type.ts` | `classifyDeviceType`, `knownDeviceTypes`. Tekst-kanal pobjednik po `definitionPriority` PRVO → bare tokeni (`motor/switch/cable/valve/pump/filter`) su u niskom tieru (615, ispod Sensor 620) da "motor cable"→Cable, "limit switch"→Sensor; DE/FR/IT nazivi u specifičnim pravilima (Leitungsschutzschalter→MCB, Schütz≠Schutz→Contactor, Näherungsschalter, Trennschalter/sezionatore, disjoncteur, Reihenklemme, Netzteil, Transformator, Sicherung) |
| `device-type-families.ts` / `device-type-urls.ts` | `familyTypeFor` / `urlTypeFor` |
| `tight-context.ts` | `buildTightContextForCatalog`, `buildVariantColumnContext` |

### `src/server/scrapers/` — konektori (svi imaju `<Name>Connector`)
`abb.ts` `balluff.ts` `doepke.ts` `eaton.ts` `eta.ts` `fath.ts` `gan.ts` `rockwell.ts` `sce.ts` `scame.ts` `schmersal.ts`
`schneider.ts` `siemens.ts` `spelsberg.ts` `turck.ts` — uz `parse<Vendor>ProductPage` helpere.
Config-driven (bez fajla): `nvent`, `phoenix`.
`gan.ts` (Ganter Norm, standardni strojni elementi): `GanterNormConnector` — traži preko
`/en/products/quick-finder?q=`. Quick-finder danas **301-redirecta puni ordering kod** (npr.
"GN 422-33-TK-LK-K2-SW") ravno na točnu varijantnu stranicu (s `#fragmentom` koji kodira odabrane
opcije), pa se disambiguacija između sibling-varijanti iste obitelji ("One/Two Function Elements",
"with Cable"/"with Plug") rješava sama; bare family ("GN 422") vraća disambiguation listu i tretira
se kao fallback (`uniqueExactFamilyHit` za jedini exact hit). Family stranica ne sadrži pun customer
ordering code, pa connector dodaje self-referentni "Catalog Number" atribut (kao Doepke) da shared
identity-check ne odbaci red. Multi-row "Article options / Table" (grupa **Ganter Geometry** — namjerno
bez riječi "dimensions") rješava se preko variant-tokena; dvosmisleno → weight/dimenzije prazne.
**Web stranica je izvor istine — svi Ganter PDF-ovi su `enrichable:false`** (link se čuva/skida, ali
se NE minea): "standard sheet" je multi-varijantni + višejezični (EN/DE/FR/IT) print-katalog čija
ekstrakcija truje čiste web podatke garbageom ("current: Cavo 4 A", "protection: voir tableau",
"voltage: 24 V / 24 V / 120 V / 12 V"). Vidi `enrichable` flag na `DocumentRecord`. Za jednoznačno
riješen jedan redak, connector sintetizira `normalized.dimensions` iz Ganter Geometry stupaca (samo
klasični crtački simboli b/a/d/h/l1/t…; verbozni config stupci tipa "Connection type" se izostave).

`siemens.ts` (`SiemensConnector`): standardni MLFB automation dio ide preko SiePortal anon-token API-ja
(`parseSiemensProductApiResponse`) + mmpdata; **Building Technologies stock brojevi** (`S55…`, regex
`/^S\d{5}-[A-Z]\d+$/`) idu preko **Industry Online Support pview API-ja** (`support.industry.siemens.com
/webapp/pview/WW/en/<sn>$/`, `parseSiemensBuildingTechnologiesPview`) — daje ime/opis/lifecycle/sliku/
canonical URL **+ punu tablicu tehničkih specifikacija** ugrađenu kao HTML u `<td>` CDATA
(`extractSiemensTechnicalData`: voltage/protection/dimensions/temp/torque/power → normalized). BT brojevi
se rutaju na pview PRVO (prije SiePortal automation API-ja, koji za njih nema ta polja).
**`productUrl` = radna SiePortal katalog-detail stranica** (`sieportal.siemens.com/en-ww/products-services/detail/<sn>`,
konstanta `SIEMENS_SIEPORTAL_DETAIL`) — NE pview `producturl` (`/pv/<sn>/pi`), koji je samo API-ulaz i u pregledniku
302-redirecta na generičku "Support" landing (=mrtav link u exportu); pview URL ostaje samo kao data-source.
**Njemački opisi** (PDT "Description DE" stupci) puni `enrichBuildingTechnologiesGermanDescriptions`: BT grana
uz EN pview dohvaća i **DE pview** (`/webapp/pview/WW/de/<sn>$/`, parser `parseSiemensBuildingTechnologiesGermanDescriptions`)
i postavi `localizedDescriptions.de` (title/description). Prije toga su DE stupci ostajali prazni jer determinist.
EN→DE fallback ne zna prevesti HVAC prozu ("Valve actuator"). Siemensov `descriptionshort` u OBA jezika počinje
tipskom oznakom (MFN, npr. "SSC331.09UT Ventilantrieb 300N"), pa realni DE short ujedno nosi type-number koji je
DE opisima nedostajao. Best-effort: pad ne ruši EN rezultat.
Ista detail stranica nosi net weight — sada **popunjen** preko `enrichBuildingTechnologiesFromMall`:
BT grana nakon pview zove `fetchSiemensProductApi` (isti anon-token `SearchApi/GetProductsDetails` kao
automation; danas služi i BT — staro "404 za BT" je zastarjelo) i dodaje Net Weight + Product Number (MFN)
+ Country of Origin + Customs Commodity Code, pa renormalizira. **Dimenzije se NE uzimaju odatle** (API daje
samo packaging dims → pokvario bi pview product W×H×D). Weight format-zamka: `uiNetWeightValue` je uvijek
europski ("1,866 Kg" = 1.866), pa `normalizeNumberSeparators` heuristika krivo čita kao 1866 (tisućice) →
koristi se `siemensEuropeanWeightToDot` (exported, testiran). GTIN: `GetProductsDetails` uvijek vraća
`ean:null` za BT, ali sestrinski `ProductInformation/GetProductsAndPrices` (`SIEMENS_PRODUCT_AND_PRICES_API`)
ga ima (`productInformation.productIdentifiers.ean`) — dodan kao atribut `"EAN"` preko exportane
`extractSiemensProductAndPricesEan` (neovisan try/catch, ne ruši weight ako padne). **Certifikati NE idu
ovim putem** — istraženo i zaključeno blokirano: SiePortal "Documents & downloads" tab zove `POST
/api/onesearch/search` (`documentTypes:4` = KnowledgeBaseEntries), koji vraća 403 na anonimni token bez
obzira na `filters.networks` vrijednost — treba pravu prijavljenu sesiju, ne parametar-guessing.
Auth refaktoriran u modul-fn (`readSiemensAuthConfig`/`fetchSiemensAnonymousToken`/`fetchSiemensProductApi`).
Akamai edge traži
**browser UA** (node UA → 403), pa `http-client.ts` `DEFAULT_USER_AGENT`
mora biti aktualni Chrome (Chrome/125 se odbija, Chrome/148 prolazi — bitno i za image download).
Datasheet PDF: `hit.sbt.siemens.com` "Data Sheet for Product" (direktan PDF), priložen samo ako
content-type preflight potvrdi PDF (neki BT proizvodi ga nemaju → bez mrtvog linka). BT brojevi su
izuzeti od `requiredElectricalFields` (voltage/current nisu strukturirani na IOS-u; mall-discovery
fallback = Access Denied/timeout).

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
| `product-accessory-sheet.ts` | `writeProductAccessorySheet`, `CURATED_ACCESSORY_RULES`. Uz priloženi accessory matrix on je **jedini** izvor tog taba (scrapani + curated se ignoriraju) |
| `accessory-matrix.ts` | `loadAccessoryMatrix`, `parseAccessoryMatrixBuffer`, `readAccessoryMatrixSheet`, `buildAccessoryMatrixPlan`, `pointVariantIndex`, `accessoryMatrixCatalogNumbers`, `accessoryMatrixMainPartsNotInRun` — **port operaterove VBA makro skripte** (`accessori matrix/Skripte_V2.txt`): iz prvog lista uploadanog XLSX-a (red 2 = imena točaka, red 3 = opisi, main partovi u koloni A od reda 4) gradi tri deterministička izlaza — Product Accessory redovi (+ variant index = broj iza zadnjeg `_` u imenu točke), Connection Point redovi (jedna točka po main partu, `User supplementary point N` restarta po main partu) i `INLIST('mp1,mp2,…', PN)` conditione. Prazan red između grupa main partova je namjeran (kao u makrou). Ground truth: `fixtures/_assets/accessory-matrix-example.xlsx` sadrži i ulaz (`Matrix`) i makrov izlaz (`final`/`conn point`/`Condition`), pa `tests/accessory-matrix.test.ts` tvrdi red-za-red jednakost |
| `connection-point-sheet.ts` | `writeConnectionPointSheet` — tab se puni **samo** iz accessory matrixa (geometrija spojnih točaka je CAD podatak, ne scrape); bez matrixa ostaje prazan placeholder. Ciljne kolone (makrove C/D/G/I/U/AF/AG/AJ/AP) razrješavaju se po PDT property idu, ne po poziciji; nedostaje li ijedna → glasna greška umjesto upisa u pogrešnu ćeliju |
| `accessory-conditions-sheet.ts` | `ACCESSORY_CONDITIONS_SHEET`, `writeAccessoryConditionsSheet`, `patchAccessoryConditionsIntoWorkbookFile` — `INLIST` conditioni ne idu u PDT nego u products workbook: matrix priložen pri startu runa upisuje ih `excel.ts` odmah, a matrix odabran u PDT panelu ih zakrpa u već zapisani `products.xlsx` (neuspjeh = warning, PDT ostaje valjan) |
| `ai-cleaned-input-sheet.ts` / `cleaned-input-workbook.ts` | `writeAiCleanedInputSheet` / `writeCleanedInputWorkbook` |
| `saginaw-weight-dimension-workbook.ts` | `writeSaginawWeightDimensionWorkbook`, `buildSaginawWeightDimensionRows`, `saginawWorkbookPathForPdt`, `isSaginawManufacturer` — **samo `sce`**: prateći workbook uz PDT (`<runId>_PDT_saginaw-weight-dimensions.xlsx`): kat. broj, Description + Description DE (`localizedDescriptions.de`), H/W/D + Est. Ship Weight u **in/lbs I mm/kg**. **Nigdje se ne zaokružuje.** Imperijalni stupci su cifre verbatim sa stranice (skine se samo jedinica, `9.50"`→`9,50`; jedinica je u headeru). Metrički su **egzaktna** decimalna konverzija (25.4 i 0.45359237 su egzaktne definicije) preko **BigInt cjelobrojne aritmetike, ne floata** — `59.94"`→`1522,476` mm (float bi dao `1522.4760000000001`), `26 lbs`→`11,79340162` kg; višak nula s njihovog formata se skida (`6.00"`→`152,4`). Decimalni zarez + sve ćelije text (`numFmt "@"`) da Excel ne pojede `9,50` u `9,5` ni ne prereže duge decimale. Sve što nakon skidanja jedinice nije goli broj (ili je metričko) se **ispušta**, ne pogađa |
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
| Zašto discovery nije našao stranicu (klase zastoja) | [search-results.ts](src/server/scrapers/search-results.ts), [scripts/audit-search-reachability.ts](scripts/audit-search-reachability.ts) |
| Upit koji čovjek proba nakon nule / obiteljski prefiks | `searchQueryVariants` u [catalog-number.ts](src/server/scrapers/catalog-number.ts) — `queryOnlyFamilyPrefix` je odvojen od `catalogFamilyMatchCandidates` jer upit nije tvrdnja o identitetu |
| Otvaranje rezultata koje nismo identificirali | `discoverUnverifiedResultLinks` + `fuzzyCatalogAffinity` u [link-discovery.ts](src/server/scrapers/link-discovery.ts); stage `search-result-unverified`, bodovan 30 |
| Sitemap URL indeks po proizvođaču (30d TTL) | tablica `sitemap_urls` u [db.ts](src/server/db.ts), čita ga `discoverFromSitemaps`; bez naslova — iz sitemapa nisu dostupni |
| Normalizacija / jedinice / značenja | [ontology.ts](src/server/scrapers/ontology.ts), [normalizer.ts](src/server/scrapers/normalizer.ts), [quantity.ts](src/server/scrapers/quantity.ts) |
| Koje manufacturer-labele ontologija još ne prepoznaje | `npx tsx scripts/audit-unmapped-spec-labels.ts` — findUnmappedSpecLabels nad cijelom povijesti runova iz `data/scraper.db`, rangirano po učestalosti i `quantity`/`text` kindu |
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
| Benchmark / audit | `scripts/benchmark.ts`, `scripts/audit-*.ts` (`npm run benchmark`, `npm run audit:pdt`); `npm run audit:page-attrs -- --limit 200` replaya generic HTML parser nad cacheom, `--trace` označava start/done svakog URL-a za izoliranje sporog oblika, a `--contains <text>` uz trace ispisuje točan URL/atribut koji nosi sumnjivu vrijednost; `npm run audit:ocr-corpus` deduplicira offline PDF korpus i izlistava samo native-sparse stranice koje eventualno mogu opravdati OCR fixture/pravilo |
| Offline regresija ekstrakcije (vrijednosti, ne prisutnost) | [scripts/eval.ts](scripts/eval.ts) + [scripts/eval-core.ts](scripts/eval-core.ts) + [fixtures/](fixtures/README.md) (`npm run eval`) |
| Mjerenje discoveryja offline (hit@1/hit@3 **i cijena**: zahtjeva/artikl, throttle, pobjednički stage, po proizvođaču) | [scripts/audit-discovery.ts](scripts/audit-discovery.ts) (`npm run audit:discovery -- --limit 160 --json after.json --compare before.json`) — replaya `discoverOfficialProductCandidates` protiv `page_cache` uz in-memory learned-endpoint store (`--no-learning` da se isključi); apsolutni hit je donja granica, brojevi zahtjeva su stvarni |
| **Gdje** discovery stane kad ne nađe (`hit` / `no-search-entry` / `search-hits-unidentified` / `search-hits-unconfirmed` / `search-zero-hits` / `search-js-only` / `search-blocked`) | [scripts/audit-search-reachability.ts](scripts/audit-search-reachability.ts) (`npm run audit:search-reachability -- --limit 60 --examples`) — mjerilo za COLD-START-PLAN §6 (P4). Offline replay nema browser i cache drži samo oblike koje smo ikad tražili, pa brojka **sustavno pretegne prema `no-search-entry`**; koristiti za prije/poslije, ne kao apsolutni udio |
| Zajednički offline replay harness za oba discovery audita (cache, uzorak, learned store, model cijene) | [scripts/discovery-replay.ts](scripts/discovery-replay.ts) — jedan izvor istine; dva audita koja različito modeliraju cache prestaju biti usporediva |
| **Što vendorova tražilica STVARNO radi** (jedini način da se P4 potvrdi — offline replay nema browser ni necacheirane oblike) | [scripts/probe-vendor-search.ts](scripts/probe-vendor-search.ts) (`npm run probe:vendor-search -- --vendor gan --catalog "GN 3310-19-LK-K2"`) — LIVE. Pokreće stvarni `discoverOfficialProductCandidates` protiv sajta i ispisuje probane URL-ove, presude, notes i kandidate. Puni `page_cache`, pa nakon njega stari audit baselineovi više nisu ista mjerna podloga |
| Poredak generičkih search oblika (koji query ključ je ikad odgovorio, po vendoru) | [scripts/audit-search-shapes.ts](scripts/audit-search-shapes.ts) (`npm run audit:search-shapes`) — dokaz za `GENERIC_SEARCH_SHAPES` u `discovery.ts`; nikad ne mijenjaj taj poredak bez ovog ispisa |
| Vađenje HTML fixtura iz keša prošlih runova (~2600 stranica, 10 vendora) | [scripts/extract-page-fixtures.ts](scripts/extract-page-fixtures.ts) (`npm run fixtures:extract -- --list`) — joina `page_cache` + `run_items` iz `data/scraper.db`; piše samo `case.json`, `expected.json` je ljudski posao |
| Provjera da izmjena ne šteti POSTOJEĆIM proizvođačima | [scripts/audit-spec-plausibility.ts](scripts/audit-spec-plausibility.ts) (`npm run audit:spec-gate`) — vrti pravi pipeline gated+ungated nad ~1300 stvarnih PDF-ova iz `benchmarks/output/`; **0 SUSPECT** izgubljenih vrijednosti je uvjet |
| Plan za nepoznate vendore/datasheetove | [docs/COLD-START-PLAN.md](docs/COLD-START-PLAN.md) |

## 10. Komande

`npm run dev` (API+UI) · `npm run desktop` (Electron) · `npm run server` · `npm run build` (`tsc --noEmit`+vite)
· `npm test` (vitest) · **`npm run eval`** (offline value-level regresija nad `fixtures/`; `-- --case <id>`,
`--write-actual`, `--json <path>`) · **`npm run audit:spec-gate`** (utjecaj na postojeće proizvođače nad
stvarnim PDF-ovima; `-- --limit 220`) · `npm run benchmark` (mrežni) · `npm run audit:pdt` · `npm run clean:pdt-input`.
`npm run review:pdf-layouts -- --input <json>` je lokalni opt-in, read-only PDF-layout review output; ne mijenja recipe ni rezultat scrapea. `npm run audit:ocr-corpus -- --json tmp/ocr-corpus.json` je read-only pregled kandidata za OCR kalibraciju; ne pokreće OCR i ne mijenja fixture, recipe ni rezultat scrapea.

---

> **Ovaj fajl ažurirati kod svake veće strukturne izmjene** (novi folder/modul, promjena pipeline
> redoslijeda, sheme baze ili dijeljenih tipova, nova/uklonjena ovisnost, novi exporti u §7).
> §5a/5b/7 se mogu osvježiti `npx madge` komandom iz §5d + ponovnim izvlačenjem exporta.
