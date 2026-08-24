# Cold-start plan — nepoznat proizvođač, nepoznat datasheet, veliki family PDF

> **Pitanje:** zašto scraper loše radi kad prvi put vidi neku stranicu ili datasheet?
> **Odgovor u jednoj rečenici:** jer se **najvažnije odluke donose PRIJE razumijevanja** — na
> engleskim ključnim riječima, na obliku URL-a i na veličini fajla — a kad odluka padne,
> sustav **ne utihne nego se proširi na sve** (cijeli dokument, cijela tablica, sve varijante).
> Uz to, o novoj stranici se **ne nauči ništa** što bi drugi red mogao iskoristiti, i
> **ne postoji offline eval** kojim bi se popravak dokazao.

Analiza je napravljena nad cijelim `src/server/scrapers/` (40 fajlova), `db.ts`, `run-manager.ts`,
`benchmarks/`, `scripts/audit-*`, `tests/`. Sve tvrdnje ispod imaju `file:line`; pet
najvažnijih je ručno provjereno u kodu.

---

## 0. TL;DR — 5 nalaza koji sami nose ~80 % problema

| # | Nalaz | Dokaz | Učinak |
| --- | --- | --- | --- |
| 1 | **Ciljano čitanje stranica PDF-a je mrtav kod za svaki PDF < 8 MB** | `document-enrichment.ts:987-988` vraća cached full-text PRIJE nego `readTargetedPdfText` (`:996`) uopće dobije priliku; `FULL_PDF_TEXT_CACHE_MAX_FILE_BYTES = 8 MB` (`:32`) | 150-stranični family katalog se čita kao jedan blob od 250 k znakova (`MAX_PDF_TEXT_CHARS:21`) → sve zaštite od miješanja varijanti padaju na line/column prozore |
| 2 | **Sitemap discovery se praktički nikad ne izvrši** | gate `candidates.size < max(4, maxCandidates/2)` na `discovery.ts:227` dolazi **nakon** što `officialVariantUrls` (`:217`) ubaci ~15 čistih nagađanja | jedini determinističi kanal koji nova stranica pouzdano nudi je isključen točno kad je najpotrebniji |
| 3 | **Admission test za "je li ovo spec" je engleski regex, izvršava se prije multijezične ontologije** | `isUsefulSpecLabel` (`generic.ts:2573-2579`), `isLikelySpecContainer` (`:2398-2414`), `isUsefulDynamicKey` (`:1523`), `KNOWN_INLINE_LABELS` (`page-mining.ts:47`) | `class="technische-daten"` ne prođe `\btech\b`; `Bemessungsstrom` ne prođe `isUsefulSpecLabel` — **ontologija koja to zna (`ontology.ts:177`) nikad ne bude pozvana** |
| 4 | **Kad scoping padne, pipeline se tiho proširi na cijeli dokument** | `document-enrichment.ts:811` — `buildTightContextForCatalog(...) ?? text` | `GN 422-33-TK` protiv reda `GN 422` → nema scopinga → svi unscoped sweepovi rade nad svim varijantama. Ovo je **inverzija** deterministickog principa "nepoznato ostaje prazno" |
| 5 | **Ništa se ne nauči o novoj stranici osim browser-network JSON hita; i ništa se ne može offline izmjeriti** | `learnedExtractors`/`targetHealth` proslijeđeni samo na `run-manager.ts:417` (ne i na `:561`, `:670`); `stage_observations` je **write-only** (`db.ts:195/239/595`, nula SELECT-ova); benchmark je mrežni (`scripts/benchmark.ts:207`) i tvrdi samo `Boolean(field)` (`:462`) | drugi katalog na istoj stranici ponavlja isti trud; a nijedna izmjena parsera se ne može dokazati bez 14 živih sajtova |

---

## 0a. PRAVILO: svaki popravak mora koristiti i POSTOJEĆIM proizvođačima

Ovo nije "cold-start projekt" s vlastitim kodom pored postojećeg. **Svaka izmjena ide u dijeljeni put**
(`document-enrichment.ts`, `generic.ts`, `normalizer.ts`, `ontology.ts`, `discovery.ts`), pa je zahtjev
dvostran:

1. **Postojeći proizvođači moraju osjetiti poboljšanje.** Bugovi nađeni na nepoznatom vendoru gotovo
   uvijek su generički. Primjer: `230/400V` čitan kao sibling kataloški broj (P0.2#11) brisao je
   tehničku tablicu **svakom** vendoru koji objavljuje dual napon — ne samo novom.
2. **Nula regresije za postojeće proizvođače.** Nije dovoljno da unit testovi prolaze: oni koriste
   ručno pisane stringove. Dokaz mora ići preko **stvarnih dokumenata**.

### Kako se to mjeri (obavezno prije nego se popravak smatra gotovim)

| Provjera | Čime | Prag |
| --- | --- | --- |
| Unit regresija | `npx vitest run` (98 fajlova, vendor-specifični testovi za abb/eaton/doepke/gan/rockwell/scame/turck…) | 100 % prolaz |
| Regresija na stvarnim dokumentima | **`npm run audit:spec-gate`** — [scripts/audit-spec-plausibility.ts](../scripts/audit-spec-plausibility.ts) nad ~1300 pravih PDF-ova koje su ostavili prošli runovi u `benchmarks/output/*/documents/` | **0 SUSPECT** izgubljenih normaliziranih vrijednosti |
| Ciljana ispravnost | `npm run eval` nad `fixtures/` | bez novih tvrdih padova |

Audit vrti **pravu** funkciju dvaput — gated i ungated, preko call-time kill switcha
`PRODUCT_SCRAPER_DISABLE_SPEC_GATE=1` — i diffa. Mjeriti gate reimplementacijom gatea u audit alatu
znači mjeriti reimplementaciju. Isti kill switch je i operativni ventil: ako se gate ikad uhvati da
odbacuje stvarnu vrijednost kod nekog vendora, staro ponašanje se vrati bez izmjene koda.

Izgubljena vrijednost se **klasificira**, ne samo prebroji: brojanje ne razlikuje "pojeo stvarni
podatak" od "prestao emitirati besmislicu", a to je jedino pitanje koje audit postavlja. Vrijednosti
koje su ambigvione mašini idu u `REVIEWED_ACCEPTABLE_DROPS` **s obrazloženjem u kodu** (isti princip kao
`pdt/pdt-exceptions.ts`), da ljudska odluka ne ostane u terminal scrollbacku.

---

## 0b. HANDOFF — kako dovršiti plan (čitaj ovo prvo)

Ova sekcija je namijenjena agentu koji nastavlja rad bez povijesti razgovora. Sve niže je provjereno na
kodu, ne prepisano iz namjere.

**Aktualni handoff za Claude:** [docs/CLAUDE-HANDOFF.md](CLAUDE-HANDOFF.md). Zadnji zatvoreni
checkpoint je **P1.3x**; tamo su točni izmijenjeni fajlovi, metrike i copy/paste prvi prompt.

### Trenutna točka zaustavljanja

P2.2n je zatvoren na novom value-verified fixtureu `fixtures/sce-fk0618-floor-stand-manual/`: realan
Saginaw/SCE floor-stand-kit instalacijski PDF ima genuine row-oriented ordering tablicu čiji je
id-header `PART #` (# umjesto `No.`/`Number`) — `isCatalogIdHeaderCell` ga nije prepoznavao, pa je
`extractPositionedOrderingRow` za cijelu tablicu tiho vraćao ništa. Popravak je bio tri sloja duboko,
sve nađeno stvarnim probama nad pravim PDF-om, ne nagađanjem:
1. `catalog-table-vocabulary.ts` `CATALOG_ID_CELL_RE` sad prihvaća `#` kao alternativu `No.`/`Number`
   za catalog/cat.no/part/order/article/item/model (nikad kao samostalan `#`).
2. `pdf-positioned-table.ts` `extractPositionedOrderingRow`: header-filter `cleanText(text).length > 1`
   je odbacivao jednoslovne stupce (`A`, `B` — stvarni footprint-dimenzija stupci); zamijenjen testom
   "sadrži barem jedno slovo/broj" koji i dalje odbija golu interpunkciju (`|`, `-`, `.`).
3. Isti reader, leading-id grananje: `Math.abs(item.x - header.x) <= columnXTolerance` je dvostruko
   brojao vrijednost u DVA susjedna stupca kad su bliže nego `2×tolerance` (izmjereno: `A`/`B` stupci
   35pt razmaknuti, default tolerancija 30pt) — zamijenjen `nearestIndex` (pobjednik je najbliži
   header), isto načelo koje trailing-id grana već koristi.
4. `extractPositionedTableRowsFromPdf`-ov page-branching: pošto `PART #` sad broji kao
   `isComparisonMatrixLabelHeaderCell`, `hasNewCatalogHeader` grana se aktivirala i za leading-id
   oblik, ali je imala kod samo za trailing-id (`hasTrailingCatalogHeader`) — leading-id slučaj je
   tiho ispuštala umjesto da padne na `extractPositionedTableRows` (koji već zna oba oblika).
5. Kontraprimjer nađen tek na punom offline gateu: `spec-plausibility.ts`'s `isPlausibleSpecLabel`
   `LABEL_LEADING_DETERMINERS` (`the/a/an/…`) case-folda "A" u "a" pa je jednoslovni stupac-header
   "A" (ali ne "B") odbacivan kao "rečenica presječena određenim članom" — pravilo je suženo na
   `tokens.length >= 2`, jer svaki postojeći primjer pravila ("The safety and protection", …) već ima
   2+ riječi.

Dvije regresije nađene punim gateom, obje popravljene AŽURIRANJEM asercije na novo, provjereno
ISPRAVNIJE ponašanje (ne promocijom nagađanja):
- `fixtures/eaton-cbe03319-family-catalog/expected.json`: stari `Matched product row` tekst-blob
  (`E6-1/1/B ... 12`) nestao je jer je isti page-6 red sad ispravno pročitan pozicijskim readerom
  (`Unit per package = 12`, točan ground truth iz `_source`) pa ga `discardUnscopedFamilyTableCandidates`
  ispravno briše kao zastarjeli duplikat. Asercija zamijenjena preciznijom (`Unit per package` umjesto
  teksta bloka), objašnjenje u `_notes.matched-product-row`.
- `tests/generic-multivalue.test.ts`: fath24 HTML komparativna tablica ima stupac `Part #`; sad kad ga
  `html-table-reader.ts` prepoznaje kao id-header, ide kroz strukturirani `attributesForRow` čitač
  umjesto stare naivne `<a>`-link-text putanje koja je (slučajno) proizvodila atribut IMENOVAN po
  samom kataloškom kodu. Asercija zamijenjena provjerom čistog `Sku = 6SAME4J316B.4000` atributa;
  sibling `.2000` guard nepromijenjen i i dalje prolazi.

Kod je zadnje mijenjan u `catalog-table-vocabulary.ts` i `pdf-positioned-table.ts`; regresije/novi
testovi su u `catalog-table-vocabulary.test.ts`, `pdf-positioned-table.test.ts`, `spec-plausibility.test.ts`.

Zadnji puni gate: TypeScript čist; Vitest **2267/2267**; eval **35/35**, **367** provjera, 0
kontaminacija i 1 dokumentirani color gap; spec-gate **1694 → 1485**, 0 SUSPECT/0 garbage;
label audit A/C/D/E = 0. Ne commitati.

### Pravila rada (nisu preporuke — svako je naučeno kroz pokvaren podatak)

1. **Prvo detektor, pa kod.** Ako izmjenu ne možeš izmjeriti prije nego je napišeš, prvo napiši mjerilo.
   Šest puta je „očito ispravno" pravilo uništilo pravi podatak, i **nijednom** to nije uhvatio code
   review — uvijek korpus ili audit.
2. **Tišina pobjeđuje pogrešnu vrijednost.** Prazno polje je ispravan izlaz kad se ne zna. Nikad ne pogađaj
   da bi se popunio stupac.
3. **Pitaj kojim je putem podatak ušao, prije nego napišeš predikat.** Isto polje puni 5+ nezavisnih
   putova. Dvaput je popravak pripadao *routeu*, ne *gateu*, a gate ne može popraviti put koji strukturno
   garantira pogrešan izrez.
4. **Svako pravilo ima rub koji se mora pogoditi.** Uvijek provjeri kontraprimjer prije nego pravilo
   sletne (`Color white (RAL 9010)`, `switching capacity`, `AC 100 V; 120 V;`, `datasheet.pdf`).
5. **Ne mijenjaj kod dok mjerenje traje u pozadini.** `tsx` učita modul na startu procesa; audit pokrenut
   prije izmjene mjeri **staro** stanje. Dvaput je to izgledalo kao „popravak ne radi".
6. **Nikad ne promoviraj `actual.json` u `expected.json`.** Ground truth se čita sa stranice/PDF-a. Jednom
   sam asertirao vrijednost sibling varijante kao istinu i time zamalo zaključao bug kao očekivano
   ponašanje.
7. **Bash heredoc pojede backslashe.** Za regex-teške izmjene koristi Write/Edit ili `.cjs` skriptu s
   fajla, ne `node - << EOF`.
8. **Ne commitaj** osim ako korisnik izričito traži.
9. **Brojevi linija u §2 i §3 su iz izvorne analize i ODLUTALI SU.** Primjer: §3 P2.1 kaže da je Eaton
   hardcode na `document-enrichment.ts:1881-1976`; danas je `inferEatonRapidLink512CatalogRows` na
   **2331–2377 (47 linija)**. Traži po **imenu simbola**, nikad po broju linije. Opisi *što* i *zašto* u
   §3 su i dalje točni — samo koordinate nisu.

### Mjerila (sva su offline, bez mreže)

| Naredba | Što tvrdi | Prihvatljivo stanje |
| --- | --- | --- |
| `npx tsc --noEmit` | tipovi | čisto |
| `npx vitest run tests --maxWorkers=1` | 2264 testa | 100 % prolaz |
| `npx tsx scripts/eval.ts` | vrijednosti na 34 stvarne fixtura/casea | 34/34, 352 provjere, 0 kontaminacija, gapovi samo namjerni |
| `npm run audit:spec-gate` | 120 stvarnih vendor dokumenata | **0 SUSPECT**; pad broja atributa mora biti objašnjen red po red |
| `npm run audit:labels` | drift dvaju sustava labela | A/C/D bez neobjašnjenih |
| `npm run audit:page-attrs` | što HTML put izvuče iz keširanih stranica | usporedi prije/poslije, po grupama |
| `npm run audit:discovery` | relativna uspješnost discoveryja | ne smije pasti |

Korisni env prekidači: `PRODUCT_SCRAPER_DISABLE_SPEC_GATE=1` (gate off, za A/B),
`PRODUCT_SCRAPER_TRACE_CANONICALIZATION=1` (ispiši svako odbacivanje u mineru).

Node nije na bash PATH-u: `export PATH="/c/Program Files/nodejs:$PATH"`.

### Stanje po fazama

| Faza | Stanje | Što je ostalo |
| --- | --- | --- |
| P0.1 eval harness | ✅ 100 % | — |
| P0.2 (11 bugova) | ✅ 100 % | — |
| P1.1 ontologija kao ulazna vrata | ✅ 100 % | `page-mining.ts` više nema ručni `KNOWN_INLINE_LABELS`: strogi ontološki prefiks segmentira inline parove, a postojeći registry alias služi samo kao neutralna granica za export polja poput `Dimensions`; review teach-list sada nosi i provenanced text-only gapove, a alias suggestion je >=0,75 i vendor-scoped |
| P1.2 jedan izvor istine | ✅ 100 % | `Enclosure protection`, thickness labele, nedimenzionalne mjere i non-nameplate electrical labele više ne kolidiraju s glavnim registry poljima; normalizerov kontekstualni label vocabulary sada se također čita iz `field-registry.ts`, bez paralelnog runtime vlasnika. |
| P1.3 HTML tablice | ⏳ ~95 % | `html-table-reader.ts` sada pokriva span-matricu, multi-row headere, header units, option-kolone i comparison tablice sa svojstvima po recima / varijantama po stupcima, te ne emitira colspan-predstavljen redni label kao vlastitu vrijednost. Stvarni Ganter konfigurator sada bira K2/K5 red/stupac, ne spaja ga sa S025 siblingom i suppressira raw-HTML `alt=` curenje; svaki generic aria/semantic fallback sada također preskače tablicu koju je reader već dokazano obradio. `html-page-level.ts` označava target+sibling HTML kao family, a generic čita i jedinstvenu ordering-code radio opciju. Span reader sada zna i strogo poravnati višeretčane label/value ćelije, ali iz njihove `(KU)`/`(SU)` oznake pušta samo kod tražene varijante, kao i targetov blok kad jedna label ćelija navodi više opcija, a vrijednosti su odvojeni paragrafi. Loose DOM pair reader odbija ugniježđenu product-card kompoziciju (naslov + identitet + marketing + cart) umjesto da ju spoji na descendant `Item number:` i ne promiče accordion/grid roditelja ili njegov naslov grupe u atribut; sada kroz ograničene neutralne layout omotače prepoznaje i jedan ili više responsive leaf redaka. Responsive vrijednosne leafove sada razdvaja sa `; ` umjesto da spojene spanove objavi kao jedan token, a ponovljen protection/humidity list iz structured payload i DOM-a semantički deduplicira; grid s dva cjelovita leaf retka sada se također ne može prodati kao jedan cross-row atribut. Veliki cacheirani search-result HTML sada se odbija prije punog sweeepa, ali se i dalje predaje link discoveryju za stvarni PDP. Generic završni filter sada uklanja i sibling katalog-kodove koji su se pojavili kao property label, ali zadržava exact target label; upload-control `Size = 5 MB`, paging kontrole i JS marker sada se odbacuju kao page furniture, a `/table`/`/zip` MIME tokeni ne postaju dokumenti; ostaje šire pokriće oblika |
| P1.4 attribute budget | ✅ 100 % | rangiranje po dokazu prije `maxRawAttributes` capa |
| P2.1 PDF „ne znam" | ⏳ ~82 % | strict `matchLevel`, family-only atributi, generic legend, multi-column miner guard i local ownership guard za contact-rating su gotovi; Eaton RapidLink compatibility inference sada je izdvojena iz shared PDF čitača u eksplicitni vendor adapter. Family-only izlaz ne zamjenjuje riječ `standard` za dokaz: varijantna registry polja ostaju blokirana, a standard/compliance treba stvarni normativni token. Ciljani izbor PDF stranica sada odbija susjednu samostalnu `Catalog Number` tablicu koja ne nosi target SKU; kada pozicijski reader dokaže target stupac, generic family red koji spaja cilj i sibling SKU-ove se uklanja umjesto izvoza kontaminirane vrijednosti. Grupirani target header i dokazani završni colspan sada također zadržavaju target-only PDF vrijednost. Stacked-dimension fallback sada provjerava bliski Product/Catalog/Article/Model/SKU kontekst i odbija sibling-only tablicu; ostaje šire kalibriranje PDF tablica |
| P2.2 pozicijski tablični engine | ⏳ ~90 % | matching stranice se konzervativno spajaju, row-orijentirane ordering tablice čitaju se po stvarnim x/y redovima i njihov y-cluster sada koristi mjerilo stranice umjesto fiksnih 5 pt, continuation header se prenosi samo dok sljedeća stranica nema novi catalog-header, side-by-side headeri ne prekidaju vertikalni raspon, cijelo-rotirane stranice se normaliziraju iz PDF transformi, a x/y tolerancije se kalibriraju iz medijana geometrije; miješani vertikalni SKU headeri sada se projiciraju samo uz dokaz najmanje dva variant tokena, a headerless multi-panel comparison grid ima vlastiti target-panel dokaz, kao i coalesced SKU header / završni colspan. Row-oriented tablica sada podržava `Cat. No.` kao zadnji stupac i umjereno višeretčane ćelije target retka. `PART #` (# umjesto No./Number) sada je prepoznat id-header za catalog/part/order/article/item/model, jednoslovni stupac-header (`A`/`B`) više ne pada na `length > 1` filteru, a leading-id (ne samo trailing) row-oriented tablica dobiva stupac po `nearestIndex` umjesto simetričnog `Math.abs` prozora koji je dvostruko brojao susjedne vrijednosne stupce; page-branching sada rutira leading-id `hasNewCatalogHeader` stranicu na `extractPositionedTableRows` umjesto da je tiho ispusti |
| P2.3 OCR | ⏳ ~90 % | `pdf-ocr.ts` ima stvarni OCR fallback, per-page scan detekciju, quality gate (tekst + Tesseract confidence), konzervativan odabir `deu`/`fra`/`ita`/`spa` samo iz jasnog native konteksta (inače `eng`) te bbox OCR redaka kroz postojeći pozicijski tablični reader. Stvarni skenirani SCE cutout-list sada čuva negativni slučaj: ne smije posuditi dimenzije za drugi SKU; ostaje pozitivna kalibracija na skeniranom dokumentu koji stvarno ispisuje naš SKU u tablici |
| P2.4 discovery po dokazu | ⏳ ~86 % | post-fetch PDP evidence scoring, stvarni GET/POST form submit sa successful controls, browser input+Enter, `homepageUrl` locale entry, `hreflang` homepage alternates i prošireni query-parametri postoje; službeni exact-SKU search redirect sada daje stvarni PDP kandidat umjesto search URL-a. Inline link discovery više ne čita HTML zatvarajuće tagove kao `/a`/`/div` kandidata niti drugi put ne promiče footer `href` uz skrivene sibling SKU-ove, a slug-only službeni redirect prolazi samo uz exact SKU dokaz na odredišnom PDP-u. Offline replay sada post-fetch evidenceom priznaje službeni URL-alias tek ako cacheirani sadržaj potvrdi SKU; ostaje šira vendor/cache kalibracija |
| P3.1 učenje | ⏳ ~80 % | `stage_observations` ima read-model i ide u run debug bundle; learned JSON API endpoint sada prolazi evidence gate i replaya se kroz postojeći JSON parser, svaki quality-gate potvrđeni službeni PDP sada sprema svoj URL template za sljedeći katalog, triput neuspjeli naučeni endpoint se ne pokušava 7 dana, `target_health` čita zadnjih 50 opažanja i ima strogi 3-sample bootstrap za potpuni novi-vendor outage, a stable CSS table-row, JSON `script#id` i span-aware HTML `table + header-column` recipeji replayaju se prije sweepa; store više ne prima generičke mining “signale” koje replay ne razumije, a replay sada filtrira i postojeće povijesne no-op zapise prije limita; ostaju PDF recipeji i šire replay politike |
| P3.2 dijagnostika | ✅ 100 % | `FieldHealthRecord.reasonCode` razlikuje otkriće, parsiranje, scope, konflikt, odbijenu vrijednost i potvrđeni `not-published`; run drawer čitljivo prikazuje field/document/discovery/page-mining uzrok, dashboard agregira dominantne run blokatore, a read-only proizvođački pregled prikazuje recent `target_health` drift i naučene endpointe. |
| P3.3 jedna confidence skala | ✅ 100 % | `evidence-score.ts` je jedini 0..1 default za normalizer, field-candidate i final-repair, s imenovanim provenance tierovima; pobjednik konflikta prvo prolazi `normalizeFields`, konflikt snižava confidence jednom i ograničeno, a `audit:confidence` provjerava stvarne spremljene izlaze svih konektora. Audit je otkrio i regresija je zatvorila Siemens BT datasheet provenance propust; stari cache ostaje čitljiv kao povijesni dokaz, ne prepisuje se. |
| P3.4 wizard | ⏳ ~78 % | spremanje recepta sada zahtijeva 2 od 3 službena identity-confirmed uzorka, a pojedini mined recipe postaje izborljiv tek kad se isti strogi obrazac ponovi na dva takva uzorka; server čuva samo svježi 30-minutni test vezan uz istu konfiguraciju/službene hostove i odbija API approval bez tog dokaza. Odobrava samo strogi CSS-red, JSON-script ili matrix HTML table+header recipe; potvrđeni uzorak sprema HTML/case fixture pod wizard outputom, URL template se izvodi iz zalijepljenog product URL-a, a test prolazi i službene datasheete kroz stvarni enrichment; ostaje šira selector/PDF politika |
| P3.5 LLM kao predlagač | ✅ 100 % | lokalni opt-in batch iz Unmapped Labels teach-lista predlaže samo `label → postojeći canonicalKey`; Excel nosi review-only prijedlog, reviewer decision, osobu, dokaz i bilješku uz strogi approve/reject/needs-evidence dropdown. Zaseban lokalni opt-in PDF batch predlaže samo postojeći deterministic reader i ograničene stranice poznatog dokumenta. Nijedna odluka nije runtime konfiguracija: nema auto-aliasa, vrijednosti ni utjecaja na scraper/PDT izlaz. |

Trenutačno, ponderirano izvornim procjenama truda iz §3 i postocima po fazama iz ove tablice, napravljeno
je **~89 %**, a ostaje **~11 %** (≈6,7 od 60,5 dana). Starijih ~35 % / ~65 % bio je povijesni snapshot
prije zatvaranja većine P1–P3 stavki. Svih **5 nalaza iz §0** — onih koji „nose ~80 % problema" — je
zatvoreno, plus 40+ klasa defekata koje uopće nisu bile u procjeni.

### Redoslijed za dovršetak (po vrijednosti za izvornu pritužbu)

Izvorna pritužba je: **nova stranica ili datasheet koji sustav prvi put vidi** — podatak se ne nađe ili je
pogrešan. Faze koje na to najviše utječu, tim redom:

---

#### 1. P1.3 — `html-table-reader.ts` (novi modul) — NAJVEĆI PREOSTALI DOBITAK ZA HTML

**Zašto:** `generic.ts:377` je sirovi `$("tr").each(...)` loop koji radi `cell0 : rest.join(" | ")`. Na
svakoj tablici sa spojenim ćelijama, dvoretčanim headerom ili varijantom-po-stupcu to daje ili kašu ili
tuđu vrijednost. PDF strana istu pamet **već ima** (`pdf-positioned-table.ts`, `buildVariantColumnContext`);
HTML strana je nema, iako su joj granice ćelija eksplicitne, pa je lakša.

**Spec:** §3 P1.3 (colspan/rowspan → pravokutna matrica → orijentacija → multi-row header merge →
units-in-header → variant-column rekonstrukcija za naš katalog).

**Prije koda — obavezno:** napravi fixture koji ga traži. Ranija provjera je pokazala da jedini fixture s
pravom tablicom (`gan`, 40 spanova) modul **ne** traži — njegov problem je bio u `alt` atributima. Izvadi
kandidate iz `page_cache` (`npm run fixtures:extract`, 2610 stranica čeka) i traži stranicu gdje
`audit:page-attrs` pokaže kašu iz tablice.

**Kriterij prihvaćanja:** novi fixture prelazi iz knownGap u prolaz; `refuse-to-guess` pravilo (naš katalog
u >1 stupcu → ne emitiraj) ima test; `eval` 15+/15+; `audit:spec-gate` 0 SUSPECT.

---

#### 2. P2.1 (ostatak) — obitelj vs varijanta u PDF-u

**Već napravljeno:** `scopeUnresolved` tri-state postoji (`document-enrichment.ts:652`, `sweepsAllowed:662`)
i gasi unscoped sweepove; `buildDocumentParseScope` + page-furniture detekcija rade.

**Ostalo:**
- **`matchLevel: "exact" | "family"`** u `catalog-number.ts`: progresivno skraćivanje na separatorima
  (`GN 422-33-TK` → `GN 422-33` → `GN 422`). Family-level match smije popuniti **samo** invarijantna polja
  (material, standard, certifikati) — **nikad** weight/dimensions/voltage/current.
  ⚠️ Zamka: sibling-prefix guard postoji lokalno u `rockwell.ts` i **namjerno nije** u shared
  `catalog-number.ts`, jer je razbio customer-doc family-fallback test. `matchLevel` je način da se to
  riješi kako treba — ne premještaj guard bez njega.
- **`ordering-code-legend.ts` (novi):** pročitaj legend tablicu (`CODE = value`, pozicija u šifri →
  svojstvo) i dekodiraj našu šifru. Generalizira `protectionFromModelLegend` (`document-enrichment.ts`) i
  **briše** `inferEatonRapidLink512CatalogRows` (47 linija hardcodea za jedan Eaton proizvod) — ili ga
  barem preseli u `eaton.ts`/config. Najveći coverage win za konfigurabilne pogone i mehaničke vendore.
- **Miner catalog-awareness:** `compositeQuantityValue` ne smije spajati preko granica stupaca (danas iz
  komparativnog reda radi `"4 A / 8 A / 12 A"`); primijeni postojeći `looksLikeMultiColumnDataRow`.
- Catalog check u `extractStackedDimensionTableRows` i scoping u `extractContactRatingAttributes`.

---

#### 3. P2.2 — pozicijski čitač → pravi tablični engine

Izvornih 7 stavki P2.2 je implementirano (`extractPositionedOrderingRow`, sve matching stranice,
continuation header, side-by-side granice, transform-orijentacija, `catalog-table-vocabulary` i
geometrijska kalibracija). Modul je sada veći od izvornog 432-line snapshota i testovi rade s
hand-transcribed x/y arrayima. Preostalih ~15 % nije neimplementiran named feature, nego kalibracija
na novom stvarnom vendor/PDF layoutu: prije nove heuristike mora postojati fixture koji postojeći reader
zaista ne može sigurno pročitati.

---

#### 4. P2.4 (ostatak) — discovery po dokazu

**Već napravljeno:** breadcrumb/hreflang izvori linkova, sitemap gate, cap na sintetizirane URL-ove
(`URL_VARIANT_MAX_SCORE = 55`), recency decay, `audit:discovery` kao replay mjerilo.
**Ostalo:** šira vendor/cache kalibracija i novi snimljeni search rezultati. Post-fetch evidence scoring,
interakcija s tražilicom u browseru, pravi POST za forme, `homepageUrl` locale ulaz i službeni `hreflang`
alternativni homepage ulaz sada postoje.
⚠️ Apsolutna uspješnost discoveryja se **ne može** izmjeriti offline (383/425 fetcheva su cache promašaji).
`audit:discovery` daje pouzdanu *relativnu* metriku — koristi je za regresiju, ne za tvrdnje o postotku.

---

#### 5. Manje, ali jeftino

- **P1.4 budget:** ✅ završeno — `rankAttributesForBudget` rangira target-scoped i registry-known
  specifikacije prije strukturiranih tablica/semantike, dok široki text/summary ostaje zadnji prije
  `maxRawAttributes`; vezani score čuva izvorni redoslijed. Pokriveno je malim budget testom.
- **P1.1 ostatak:** `isUsefulDynamicKey`, `KNOWN_INLINE_LABELS` — isti obrazac kao već riješeno.
- **P2.3:** per-page odluka, quality gate, jezik i bbox pozicijski put postoje. Ostaje fixture iz stvarnog
  skeniranog datasheeta za kalibraciju pragova; bez dokaza naše SKU kolone bbox reader šuti.

---

#### 6. P3.x — poslije (34 % plana, ali najmanje veze s izvornom pritužbom)

`stage_observations` sada ima bounded read-model, ulazi u debug bundle i služi `target_health` prikazu;
P3.1 preostaje samo za PDF layout recipeje i šire replay politike, ne za osnovnu observability infrastrukturu.
P3.3 (jedna confidence skala) je zatvoren kao zadnji rizični zahvat. P3.5 ima tvrdu granicu:
**predlagač, nikad izvor vrijednosti** — smije predložiti gdje gledati i koji selektor probati, a rezultat
mora proći isti deterministički put i gate.

### Neriješeno i svjesno odgođeno (ne „zaboravljeno")

- **Sekcija B audita**: 80 svojstava koja ontologija razumije a nijedan izvezeni stupac ne nosi
  (`breakingCapacity`, `power`, `frequency`, `torque`, `poles`, `conductorCrossSection`…). Nije bug — to je
  najveći poznati **neiskorišteni ulov**.
- **`cabinet.mechanical` PDT sheet** ostaje prazan namjerno: to je CAD podatak (ECADPORT), ne scraping.

---

## 0c. Dnevnik izvedbe (kronološki, najnovije na dnu)

### ✅ P0.1 — offline eval harness (SLETIO)

[scripts/eval-core.ts](../scripts/eval-core.ts) + [scripts/eval.ts](../scripts/eval.ts) +
[fixtures/](../fixtures/README.md) + [tests/eval-core.test.ts](../tests/eval-core.test.ts) ·
`npm run eval` · 5 slučajeva, 41 asertacija na razini **vrijednosti**.

Novost vrijedna imena: **`knownGaps`** — asertacija koja je *istina* ali je još ne znamo izvući. Ne
ruši run, ali kad počne prolaziti, harness to javi i traži promociju u tvrdu asertaciju. Time
zatvoren gap ne može tiho regresirati, a suite ostaje upotrebljiv signal dok se popravci slijevaju.
Nasuprot tome: **izmišljena vrijednost nikad nije knownGap** — to je uvijek tvrdi pad.

`fixtures/_assets/` + [tests/pdf-parse-patches.test.ts](../tests/pdf-parse-patches.test.ts) —
canary za `patches/pdf-parse+2.4.5.patch` je čitao iz gitignoranog `benchmarks/output/`, pa je tiho
padao svima koji kloniraju repo, tj. točno onima koji moraju znati da patch nije primijenjen.

**Harness je odmah našao 5 bugova koji nisu bili u planu** — to je jedini pravi dokaz da vrijedi:
label sanity (P0.2#7), value sanity (P0.2#8), °F set-point (P0.2#9), norme kao siblinzi (P0.2#10),
dual vrijednosti kao siblinzi (P0.2#11).

### ✅ P0.2#7 + #8 — jedan plausibility gate na granici (SLETIO)

[src/server/scrapers/spec-plausibility.ts](../src/server/scrapers/spec-plausibility.ts) — leaf modul,
vezan na **dva choke pointa**: `stampDocumentAttributes` (svi PDF čitači) i `parseGenericProductPage`
prije capa (svi HTML ekstraktori). Osam simptoma je bila **jedna klasa buga**, pa je dobila jedno
pravilo na granici, a ne osam zakrpa u osam ekstraktora — isto kao backstop za spojene mjere u
`normalizer.ts` (whack-a-mole po nezavisnim parserima ne konvergira).

Odbacuje: C0 kontrolne znakove (pokvaren PDF font cmap), dot-leadere iz sadržaja, inline CSS
deklaracije, boilerplate/imprint linije, **instrukcije** (`should`/`must`/`be installed` — instrukcija
nikad nije specifikacija), rečenične fragmente (vodeći determiner, viseći veznik, nastavak klauzule),
nezatvorene zagrade, cijele rečenice, i **header red tablice parsiran kao podatak** (greedy
segmentacija protiv poznatog vokabulara, uz simbole veličina `In`/`Un`/`Icn` i unit hintove u
zagradama).

Rezultat na korpusu: **1/5 → 4/5 slučajeva prolazi**. nVent 87920846 (dokument bez ijedne spec
tablice) išao s 8 atributa od kojih su svih 8 bili smeće → **3 legitimna**. Oba ABB HTML slučaja čista.

**Mjereno na 220 stvarnih dokumenata postojećih proizvođača** (`npm run audit:spec-gate`):
**500 atributa smeća uklonjeno (8,2 %), 0 SUSPECT izgubljenih normaliziranih vrijednosti.**

Novi nalazi iz tog mjerenja — audit je uhvatio false positive u mom vlastitom gateu:

| Nalaz | Detalj |
| --- | --- |
| **Jedinica vs funkcijska riječ** | `"A"` (amper) kolidira s članom `"a"`, `in` s inčem, `F`/`K` s temperaturama. Viseći-veznik pravilo je zato odbacivalo **stvarne** vrijednosti (`Current rating range 0.1...20 A`). Pravilo se sad primjenjuje samo na tekst **bez cifara** — cifra znači podatak, ne prozu. Drop pao 14,9 % → 7,1 % |
| **Klasifikacija gubitka, ne brojanje** | `weight = "II 3 G: (0.00 kg)"` — ATEX oznaka zalijepljena na nulu. Brojanje ne razlikuje pojeden podatak od uklonjene besmislice; audit sad klasificira, a ambigviono ide u `REVIEWED_ACCEPTABLE_DROPS` s obrazloženjem |

### ✅ P0.2#3 + #4 + #5 — cache ključevi, learning wiring, separator (SLETJELO)

| # | Popravak | Nalaz iz izvedbe |
| --- | --- | --- |
| #4 | **Cache ključevi PDF teksta** su bili `url \| length \| first120 \| last120` → sad FNV-1a fingerprint cijelog teksta | Nijansa koju je otkrilo čitanje koda: tri korisnika `catalogOrderingCacheKey` vraćaju indekse **ključane po katalogu**, pa su catalog-agnostični po dizajnu — tu curenja nema. Pravi rizik je `documentTextCacheKey`, koji vraća **liste atributa**: sibling redovi uniformne ordering tablice imaju *istu dužinu* (`1 E6-1/1/B CBE03319 12` vs `2 E6-2/1/B CBE03320 12`) i dijele header/footer linije, pa se ključ poklopi i katalog B dobije atribute kataloga A. Vrijednosti pri tome izgledaju besprijekorno, pa ih nijedan downstream guard ne može uhvatiti |
| #5 | **Separator u dimenzijama** — `Number(x.replace(",", "."))` → `localizedNumber()` (tj. `normalizeNumberSeparators`) na svih 10 mjesta u `normalizer.ts` | `1,200 mm` je postajalo `1.2 mm`. Weight je taj helper već koristio; dimenzije ga nikad nisu preuzele. **Zamka:** za `mm` funkcija rano vraća `cleaned`, pa se bug NE vidi na običnom `1,200 x 800 mm` — vidi se na labeliranim dimenzijama (`W 1,200 mm`) i na konverziji iz cm/in. Test je zato pisan na tom obliku |
| #3 | **`learnedExtractors` + `targetHealth` u sve passeve** — novi `RunManager.learningContext()` na jednom mjestu, plus wizard | Bili su navedeni inline na 4 mjesta, a dva kasnija passa (quality-fallback i final-completeness retry) nabrajala su samo `learnedEndpoints`. Posljedica: na attemptima koji najviše govore o teškom targetu `learnedExtractors.list` je vraćao undefined (ništa se ne replaya), `learnFromMining` je rano izlazio (ništa se ne bilježi), a `recordTargetObservation` je bio no-op → `sampleCount` nikad nije rastao → `driftFromTargetHealth` (prag 8 uzoraka) **nikad nije mogao opaliti**. Vezivanje na jednom mjestu je stvarni fix: četvrti call site ne može zaboraviti dva od tri |

Wizardov "test" pass je namjerno dobio isti kontekst — inače se recept za novog proizvođača odobrava na
pipelineu koji se ponaša drugačije od onoga koji će stvarno scrapati.

### ✅ P0.2 — sletjelo 11 od 11 (ZATVORENO)

| # | Popravak | Učinak |
| --- | --- | --- |
| #1 | **Page targeting je bio mrtav kod za PDF < 8 MB.** Cache sad drži *stranice* umjesto spojenog teksta, pa se parsira jednom po fajlu (kao prije) a svaki kataloški broj bira svoje stranice. Tablice se scopiraju po stranici (`safeGetTablesByPage`) da se ne provuku kroz tablični kanal | 57-stranični katalog: čita 5 stranica umjesto blob-a od 250 k znakova |
| #6 | **Truncation/scope dijagnostika** (`describePdfScope`) | `read 5/57 pages (4-7,12)` u dijagnostici — razlikuje "nema u dokumentu" / "nismo čitali tu stranicu" / "odrezano" |
| #10 | **Norme se više ne broje kao sibling kataloški brojevi.** `GB/T10963.1`, `IEC/EN60898.1` | family Technical Data stranica se više ne odbacuje zbog citirane norme |
| #11 | **Dual vrijednosti se više ne broje kao sibling kataloški brojevi.** `230/400V`→`230400v`, `50/60Hz`→`5060hz` | **najveći nalaz**: svaka stranica s dual naponom ili dual frekvencijom je gubila cijelu tehničku tablicu, kod svih vendora |
| — | **Selekcija dijeljenih tehničkih stranica po blizini**, ne po globalnoj gustoći | prije je u multi-family katalogu vukla *tuđe* tehničke stranice → `current: "6...40 A"` za prekidač od 1 A. Sad prazno umjesto krivo |

Mjereno na `fixtures/eaton-cbe03319-family-catalog`: **9 → 23 atributa**, 5 gapova zatvoreno
(`voltage` 230/400 V, `operatingTemperature` −25…70 °C, insulation voltage, breaking capacity),
`current` prestao vraćati tuđu vrijednost. `npx tsc --noEmit` čist, **2000/2000 testova prolazi**.

Preostala 3 gapa na tom fixtureu su svi ista stvar — **engleski keyword allowlist**
(`isGlobalTechnicalLine`): `Casing protection degree` i `Design standard` nisu na listi. To je
točno P1.1, i najbolji dokaz da je P1.1 pravi sljedeći korak.

### ✅ P0.2#9 + #2 — °F/set-point i sitemap gate (SLETJELO) → **P0.2 je 11/11**

**#9 — dva različita buga u istom polju.** `operatingTemperature` je za nVent SPEC-00583 bio `32…140`:

1. *Pogrešna jedinica.* `UNIT_TABLE` poznaje `°F` i `degF` ali **ne bare `F`**, pa
   `"temperature range (32 -140 F)"` nije dao nijednu temperaturnu veličinu i propao je na
   `bareNumericRange`, koji bare brojeve čita **kao Celzij** — 32…140 °F (tj. 0…60 °C) upisano kao
   32…140 °C. Sad se skala detektira (`temperatureScales`) i konvertira; traži se cifra prije `F` da
   "Type F" ne pokrene konverziju.
2. *Pogrešno svojstvo.* `Temperature Set Point (adjustable)` je vrijednost na koju se uređaj
   **postavlja**, a ne ambijentalni raspon koji tolerira. Termostat podesiv na 60 °C nije termostat za
   60 °C okoline. Dodano u `isExcludedLabel` (uz `Sollwert`/`consigne`/`Einstellbereich`).
3. *Novo pravilo iz istog nalaza:* kad klauzula deklarira **oba** mjerila (`(°F/°C) 32/0 to 140/60`,
   `-4 to 176 F | -20 to 80 C`), svaki broj postoji dvaput i tekst ne kaže koji je koji → **odbij**.
   Tišina je bolja od Fahrenheita zapisanog kao Celzij.

**#2 — sitemap gate.** Blok je premješten **prije** `officialVariantUrls` i gate je promijenjen s
brojanja kandidata na **dokaz** (`hasEvidenceBackedCandidate`). Nagađanje ubaci ~15 kandidata (5
varijanti kat. broja × 3-4 oblika URL-a), pa je stari prag `max(4, maxCandidates/2)` = 6 uvijek već bio
prekoračen → sitemap se **nikad nije izvršio**, i to za točno onu stranicu kojoj najviše pomaže. Sitemap
hit je ujedno *bolji* dokaz od nagađanja, jer URL dolazi iz vendorovog vlastitog indeksa i zato postoji.

Dodana su dva testa koja to dokazuju (bare vendor → sitemap se dohvati i nađe PDP; postoji search hit →
sitemap se preskoči). Postojećih 58 discovery testova ovo nije pokrivalo.

**Namjerno NIJE napravljeno:** `.xml.gz` sitemapi (traži binarni fetch + gunzip). Ne mogu to validirati
offline, a discovery je najosjetljiviji dio na regresije — radije ostavljam zapisano nego neprovjereno.

### ✅ P1.1a — ontologija kao ulazna vrata (PRVI DIO SLETIO)

Novi `looksLikeUnderstandableSpec(label, value?)` u [ontology.ts](../src/server/scrapers/ontology.ts)
(`matchProperty` → alias tablica → `inferPropertyFromQuantities`), vezan na dva mjesta u
`document-enrichment.ts`: `isGlobalTechnicalLine` (koje linije se uopće čitaju) i `isKnownDocumentLabel`
(detekcija header reda).

**Teza je prvo provjerena empirijski, pa kodirana.** Ontologija zna sve što engleska lista ne zna:

| Labela | Keyword lista | Ontologija |
| --- | --- | --- |
| `Casing protection degree` | ✗ | `protection` |
| `Design standard` | ✗ | `certificates` |
| `Rated breaking capacity Icn` | ✗ | `breakingCapacity` |
| `Terminal screw fastening torque` | ✗ | `torque` |
| `Mounting method` | ✗ | `mountingType` |
| `Part number` / `Article number` | ✗ | `partNumber` |

Keyword lista je **zadržana kao dodatni put**, ne zamijenjena — kodira oblike cijelih linija za koje
ontologija nema sinonim (`selective true`). Time se admission samo širi, nikad ne sužava.

**Mjereno — i za nove i za postojeće proizvođače:**

| | Prije P1.1 | Poslije |
| --- | --- | --- |
| Eaton fixture, atributi | 22 | **44** |
| Eaton fixture, otvoreni gapovi | 4 | **1** (`current`, treba čitanje stupca → P1.3) |
| **220 stvarnih dokumenata postojećih proizvođača — zadržani atributi** | 5617 | **6424 (+14 %)** |
| SUSPECT izgubljene vrijednosti | 0 | **0** |

#### Nalazi iz izvedbe P1.1

1. **`matchProperty` matcha bilo gdje u stringu → greedy longest-first segmentacija je pogrešna.**
   `"Part number Article"` matcha na `"Part number"` i pojede riječ sljedeće ćelije, ostavljajući
   nesegmentabilan ostatak — točno tako je Eaton header red bježao detekciji. `looksLikeHeaderRowValue`
   sad ide **shortest-first**: header ćelija je najmanja prepoznatljiva labela.
2. **Ontologija over-matcha** — `Selective protection level` → `protection` (klasa selektivnosti, ne IP),
   `Electrical life` → `mechanicalLife`, bare `In` → `ratedCurrent`. Za *admission* bezopasno (i zato je
   P1.1 siguran), za *dodjelu polja* nije. Zapisano kao **P1.1b**.
3. **Bilješka u fixtureu mi je bila netočna, i widening je to dokazao.** Tvrdio sam da nVent 87920846
   „nema nikakve specifikacije" — dokument navodi radni temperaturni raspon **na četiri jezika**, a
   engleski gate ih je sve skrivao, uključujući španjolski `Rango de temperatura de empleo`. Korpus mora
   bilježiti što izvor kaže, ne što je prethodno čitanje pretpostavilo. Fixture ispravljen, i u
   ontologiju dodani ES sinonimi `de empleo` / `rango de temperatura` (provjereno iz izvora).
4. **Dual-scale s eksplicitnim jedinicama** — `-45 °C to 80 °C (-49 °F to 176 °F)`: °C vrijednosti su
   nedvosmislene i treba ih uzeti, a ne odbiti kao dvosmislene. Zapisano kao **P1.1c**.
5. **Spojenost s P0.2#7/#8:** ovo širenje je sigurno **samo zato što gate postoji** — audit pokazuje da
   widening propusti i pogrešne vrijednosti (Rockwell 1783-US5T: `finish` DIN šine i `color = "yellow"`
   iz `yellow-chromate`, oboje iz upute za montažu, pripisano Ethernet switchu), koje gate uhvati. Te
   dvije faze se ne smiju razdvajati.

### ✅ HTML korpus + P1.1 na HTML putu (SLETIO)

Prošli krug je ostavio dug: „HTML korpus je premali (2 fixturea) da bi se engleski gateovi u
`generic.ts` mijenjali s istom sigurnošću s kojom je mijenjan PDF put." To je sad zatvoreno.

**Novi [scripts/extract-page-fixtures.ts](../scripts/extract-page-fixtures.ts)** (`npm run
fixtures:extract`) joina `page_cache` + `run_items` iz `data/scraper.db`: **2610 stvarnih stranica
proizvoda kroz 10 proizvođača** (abb 100, balluff 45, fath 2, gan 191, nvent 8, rockwell 172, sce 1607,
schmersal 479, siemens 2, turck 4). Korpus je narastao **5 → 15 slučajeva**, po jedan od svakog vendora.

Uveden i **tier** u `expected.json`: *value-verified* (vrijednosti pročitane iz izvora) vs *noise-guard*
(samo univerzalni `mustNotContain`). Noise-guard hvata regresije odmah i legitiman je, ali nije izgovor
za prepisivanje `actual.json`.

Zatim su ontologija i multijezični vokabular vezani na HTML put:
- `isUsefulSpecLabel` → ontologija prvo (kao `isGlobalTechnicalLine`), lista ostaje kao dodatni put jer
  pokriva identity labele koje ontologija ne zna (`sku`, `gtin`, `order`, `article`).
- `isLikelySpecContainer` → **novi multijezični `SPEC_CONTAINER_CONTEXT_PATTERN`**. Ovdje ontologija
  *ne* pomaže: „Technische Daten" je naslov sekcije, ne svojstvo, pa nema sinonim. Vokabular sam mora
  biti višejezičan (DE/FR/IT/ES/NL/HR).

#### Nalazi iz ovog kruga

| Nalaz | Detalj |
| --- | --- |
| **E-commerce chrome kao atribut proizvoda** | Turck stranica je dala `"In StockPrice GroupE1List Price102,70 € \| Item Total102,70 €Quantity−+add_shopping_cartAdd to cart"`. Cijena, zaliha i cart akcija nisu specifikacije; valuta + cart su nedvosmisleni markeri pa je to jedno od najsigurnijih odbijanja u gateu. Labela je uz to slijepljena bez razmaka (`"Inductive SensorBI3U-EG12SK-VP4XOrder ID no. 1580601"`) — DOM artefakt, ostavljen kao **P1.1d** |
| **Siemens stranica u kešu je Angular SPA shell** | `Siemens SiePortal`, `data-beasties-container`, kataloški broj se pojavljuje **0 puta** u 31 kB HTML-a. Nula atributa je **ispravno** — sadržaj dolazi preko pview/SiePortal API-ja. Fixture prenamijenjen u *value-verified negativni* slučaj koji pribija to ponašanje. Otvorena prilika: prepoznati „shell + nema kat. broja + framework markeri" kao vlastitu dijagnozu i eskalirati na browser/API umjesto bilježenja „stranica nije parsirana" |

Mjereno: **15/15 slučajeva prolazi, 0 kontaminacija, 120 asertacija**; HTML atributi porasli na svim
vendorima (npr. rockwell 227 → 231, nvent 188 → 194, sce 43 → 46). `npx vitest run` **2045/2045**.

### ✅ Discovery je dobio mjerenje na stvarnom materijalu + P2.4a (SLETJELO)

Zadnji preostali dug je bio: „discovery je jedini dio bez potvrde na stvarnom materijalu, jer snimanje
search stranica traži mrežu." **To je bilo pogrešno** — `page_cache` drži tijelo *svake* stranice koju je
bilo koji run dohvatio, dakle i search stranice. Dokaz je bio na disku cijelo vrijeme.

**Novi [scripts/audit-discovery.ts](../scripts/audit-discovery.ts):** replaya
`discoverOfficialProductCandidates` protiv keša (13858 URL-ova), s `run_items.product_url` kao ground
truthom, i mjeri **hit@1 / hit@3 / hit** — točno metriku „discovery hit rate na 1. kandidatu" iz §5.

Dva nalaza iz samog keša, prije ijedne izmjene:

1. **0 sitemapa u 14862 keširanih redova** (i samo 1 robots.txt). To je *empirijski* dokaz da je sitemap
   gate bio mrtav — u cijeloj povijesti runova ni jedan sitemap nije dohvaćen. Za P0.2#2 sam dosad imao
   samo čitanje koda i unit testove.
2. **U gotovo svakom promašaju #1 kandidat je bio sintetizirano nagađanje** oblika
   `{origin}/product/{compactCatalog}` — `new.abb.com/product/1SAP180400R0001`,
   `ganternorm.com/product/gn331019lkk2`, `rockwellautomation.com/product/1492pde1142`. Nijedan ne
   postoji.

**P2.4a — nagađanja više ne nadglasavaju dokaz.** Svi bonusi u `scoreDiscoveryCandidate` ocjenjuju
*oblik* URL-a, a nagađanje je konstruirano da ima idealan oblik: katalog u URL-u (+30), katalog kao
segment putanje (+35), product-ish token (+15), službeni host (+10) → 130, clampano na 100, **iznad svake
faze s dokazom**. Nagađanja su zato zauzimala #1 i, gore, **izbacivala prave nalaze iz
`slice(0, maxCandidates)`**. Sad su kapirana na 55, ispod `search-result` baze (58).

| Metrika (40 stvarnih kat. brojeva, replay preko keša) | Prije | Poslije |
| --- | --- | --- |
| known PDP na **#1** | 7,5 % | **20,0 %** |
| known PDP u top 3 | 12,5 % | **25,0 %** |
| known PDP **nađen uopće** | 22,5 % | **40,0 %** |

Da „nađen uopće" poraste od pukog reordanja nije očito — porastao je jer su nagađanja doslovno
izbacivala prave kandidate iz budžeta koji deterministički pipeline dohvaća. Mehanizam je točno onaj koji
§2A opisuje pod F10.

**Kako čitati te brojke:** apsolutne vrijednosti su **donja granica** (42 cache hita / 383 promašaja —
generički search template koji stvarni run nikad nije koristio nema što servirati). Metrika je za
**prije/poslije usporedbu**, ne kao živa uspješnost.

### ✅ P0.2#2b (gzip sitemapi) + P1.1c (dual-scale °C) — SLETJELO

**`.xml.gz` sitemapi.** Prošli krug sam ovo ostavio s obrazloženjem „traži binarni fetch + gunzip; nije
validirano pa nije napravljeno". To je bilo pogrešno — gunzip se testira offline u tri linije.

Tri sloja, svaki testabilan: leaf [gzip-text.ts](../src/server/scrapers/gzip-text.ts)
(`looksGzipped` / `decodeMaybeCompressedText` / `urlLooksCompressed`, 9 unit testova) →
`CachedHttpClient.fetchMaybeCompressedText` → `fetchSitemapText` u discoveryju, koji binarni put koristi
**samo** za `.gz` URL i **samo** ako ga klijent podržava (test stubovi i offline replay audit
implementiraju samo `fetchText`). Uz 2 end-to-end testa: gzipan sitemap iz `robots.txt` se nađe, a
plain `sitemap.xml` ne plaća binarni put.

Zašto je to bila tiha rupa: `.gz` u sitemap URL-u je **format fajla**, ne transport encoding, pa `fetch`
ne dekompresira, tekst je mojibake, `extractSitemapLocs` nađe 0 `<loc>` i prijavi nulu **bez greške**.
Sitemap indeksi su često gzipani, a sitemap je jedini kanal koji nov vendor pouzdano nudi.

**P1.1c — odbijanje dual-scale klauzula je bilo previše grubo.** P0.2#9 je uveo „oba mjerila → odbij".
Ispravno za gole parove, ali ne i kad jedinica jednoznačno određuje skalu. Novi `celsiusOnlyView` ima tri
strategije, u ovom redoslijedu:

1. **ukloni zagrade koje spominju °F** — i imperijalni dodatak (`(-49 °F to 176 °F)`) i deklaraciju
   stupaca (`(°F/°C)`). Ovo **mora** biti prvo: `(°F/°C)` sadrži `/`, pa razdvajanje prije toga rastrga
   deklaraciju u lažnu `°C)` ćeliju koja onda pokupi Fahrenheit brojeve pored sebe.
2. **razdvoji na ćelije** (tab, `|`, `/`, širi razmak) i zadrži samo one s eksplicitnim °C. `/` je tu jer
   uzvodni miner spaja alternative njime, pa nVentov `-45 °C to 80 °C (-49 °F to 176 °F)` dolazi kao
   `-45 °C / 80 °C / -49 °F / 176 °F`.
3. **izvuci raspon kojemu je jedinica °C** — jer `normalizeForParsing` skupi razmake prije nas, pa
   dvostupčani layout (`Ambient Temperature ⇥ -4 to 176 F ⇥ -20 to 80 C`) izgubi granice ćelija i
   zadnji trag koji identificira Celsius stupac je završni `C`.

Nalaz iz izvedbe: kad `celsiusOnlyView` suzi klauzulu, **odreže i labelu**, pa je `hasTempKeyword` postao
false i vrijednost se ionako izgubila. Kontekst („je li ovo uopće temperatura?") mora se računati iz
**originalne** klauzule; prikaz odlučuje samo *koje brojeve* čitati. Jedan stari test iz P0.2#9 je zato
namjerno preokrenut — slučaj koji je tvrdio da se odbija sad se ispravno rješava kao `-20…80 °C`.

Rezultat: nVent 87920846 daje ispravno **−45…80 °C** iz dual-scale dokumenta. Otvoreni gapovi u korpusu
**5 → 3**. Atributi zadržani za postojeće proizvođače (120 dok.) **3828 → 4030**.

### ✅ P1.1b — preciznost ontologije (SLETIO, uz ispravak vlastite tvrdnje)

Od tri navodna over-matcha koja sam prijavio u prošlom krugu, **dva su bila stvarna, treći nije.**

| Nalaz | Ishod |
| --- | --- |
| `Selective protection level` → `protection` | **Stvaran bug.** Sinonim `protection (class\|rating\|degree\|level\|…)` hvatao je klasu selektivnosti; vrijednost „3" bi prepisala stvarni IP20. Riješeno novom `exclude` listom na `protection` (`selectiv/selektiv`, `shock/touch protection`) — a ne brisanjem `level` iz sinonima, jer „Protection level IP65" je legitiman oblik |
| bare `In` → `ratedCurrent` | **Stvaran, ali uži nego što sam mislio.** Sinonim `/\bIn\b/` je već case-sensitive, pa engleski „in" i inč nikad nisu bili problem; ostajala je samo velika početna „In" u rečenici. Riješeno lookaheadom `/\bIn\b(?!\s+[a-z])/` — „In", „In (A)", „Rated current In" i dalje prolaze |
| `Electrical life` → `mechanicalLife` | **NIJE bug — moja tvrdnja je bila pogrešna.** `/electrical\s+(?:life\|durability\|endurance)/` i `/elektrische lebensdauer/` su **eksplicitno** u sinonimima propertyja „Mechanical life / operating cycles". To je namjeran modelski izbor, ne slučajni over-match |

O trećem: električna i mehanička trajnost jesu različiti brojevi (za kontaktor ~1M vs ~10M operacija), pa
ih spajanje čini „tko prvi nađe, taj upiše". To je legitimno pitanje modela, ali razdvajanje traži novi
kanonski property plus PDT resolvere — zaseban zahvat, nije napravljen ovdje. Zapisano, ne prešućeno.

### ✅ P1.3a — PDF ordering tablica: zadnji Eaton gap zatvoren

Krenuo sam u P1.3 („HTML tablice + čitanje stupca") i odmah ispravio vlastitu pretpostavku: zadnji
otvoreni gap (`normalized:current`) **nije** bio HTML, nego **PDF** ordering tablica. Ondje su bila dva
buga, oba generička.

**1. Suppression gate je bio previše grub.** `hasStructuredOrderingRow` suprimirao je
`extractGenericCatalogTableRows` i `extractGetTableCatalogRows` — a znači samo *„ordering reader je
prepoznao kataloški BROJ"*, ne *„izvukao je specifikacije"*. Na Eatonu je našao red
`1 | E6-1/1/B | CBE03319 | 12` i ništa više, pa blokirao jedini čitač koji mapira header
(`Rated current In (A) | Part number | Article number | Unit per package`) na ćelije tog reda.
**Kataloški broj je nađen, a specifikacija pored njega bačena.**

Ta dva čitača ionako provjeravaju da je ćelija koju *header* zove kataloškim brojem stvarno naša — dakle
oni su precizni čitači, ne rizični. Unscoped sweepovi ostaju suprimirani.

**2. Spojeni identifikatorski stupci.** `Part number` i `Article number` oba mapiraju na ključ
`catalogNumber`, pa ih `mapHeaderCellsToRow` spoji u jednu ćeliju `E6-1/1/B; CBE03319`. Provjera
identiteta je onda usporedila **spojenu** ćeliju s `CBE03319` i pala:
`sameCatalogNumber("E6-1/1/B; CBE03319", "CBE03319")` je false. Pravi red je nađen i odbačen.

Interna šifra **plus** narudžbeni broj u istoj tablici nisu rubni slučaj nego norma (Eaton, Doepke,
ABB…). Novi `mappedCatalogCellMatches` / `ourCatalogCellValue`: dovoljno je da **jedan** identifikatorski
stupac odgovara, a u export ide **naš** identifikator, ne spojena ćelija.

**Eaton fixture sad ima nula otvorenih gapova** — sve što dokument tvrdi se izvlači, bez sibling
kontaminacije (`1 A`, ne `2 A`/`3 A` iz susjednih redova). 4 nova regresijska testa.

**Poštena napomena o dometu:** na 220 stvarnih PDF-ova `audit:spec-gate` daje **identične** brojke
(7047 → 6424). Dakle nema regresije, ali ni mjerljive šire koristi — taj oblik suppressiona očito nije
čest u tom uzorku. Efekt je dokazan na family katalogu, i ne bih ga prodavao kao široku pobjedu.

### ✅ P2.1a — kataloški broj samo u page furniture daje LAŽNI scope (korpus je sad bez gapova)

Zadnja dva otvorena gapa nisu bila „scoping je pao" nego nešto oštrije, i probing je to pokazao prije
ijedne izmjene:

> `SPEC-00583` se u dokumentu pojavljuje **8 puta i svih 8 su podnožja stranice**
> (`nVent.com/HoFFmAn SUBJECT TO CHANGE WITHOUT NOTICE ThermAl mAnAgemenT 3 Spec-00583`).

Zato je `catalogTextMatches` bio **true**, a `buildTightContextForCatalog` vratio **3,5 kB** prozora
građenih oko **podnožja** — ±36 linija oko svake od 8 stranica, praktički cijeli dokument. Pipeline je
vjerovao da je osam puta lokalizirao proizvod. Lokalizirao je **dokument**.

**Page furniture identificira DOKUMENT, nikad proizvod.** Zato match u njoj ne nosi nikakvu scoping
informaciju.

Detekcija je generička, bez ijednog vendora: linija je running header/footer ako se njezin
**digit-stripped** oblik ponavlja na ≥3 mjesta **I** nosi imprint marker (domena, telefon, ©,
„subject to change", „technische Änderungen"). Oba signala su potrebna — ponovljena spec linija nije
furniture, a jednokratni imprint ne diskvalificira stranicu.

Kad **sve** pojave kataloškog broja padnu u furniture **i** dokument je multi-variant, scope je
nerazriješen i suprimiraju se **catalog-agnostični** čitači (`cachedGlobalPdfAttributes`,
`cachedGlobalPdfTechnicalAttributes`, `extractCatalogFeatureAttributes`, `extractCatalogSpecificRows`),
dok header-mapped tablični čitači **i dalje rade** — ako oni nađu red koji je dokazano naš, to je upravo
dokaz koji je falio. Dijagnostika to izrijekom javlja.

Nalaz iz izvedbe: `extractCatalogSpecificRows` je preživio prvu verziju gatea i emitirao **četiri
podnožja kao „Matched product row"**. Taj čitač drži cijele linije ključane po bilo kojem
catalog-shaped tokenu, pa je „catalog-verified" samo u najslabijem smislu — bez razriješenog scopea je
slijep kao sweep.

`nvent-spec00583`: **110 → 9 atributa**, oba temperaturna gapa zatvorena. **Korpus je sad bez ijednog
otvorenog gapa.**

**Domet:** gate je namjerno uzak (traži *i* multi-variant *i* katalog-samo-u-furniture) i na 220 stvarnih
PDF-ova **nije opalio ni jednom** — brojke su identične (7047 → 6424). Za suppression promjenu to je
pravi ishod: nula kolaterale za postojeće proizvođače.

### ✅ Korpus: prvi value-verified HTML fixture + P1.3c (HTML markup u labelama)

Prošli krug je ostavio zapažanje da korpus bez gapova više nema detektor, pa je sljedeći posao
**promocija fixtura u value-verified**, ne daljnja izmjena koda. Odabrao sam onaj s **najnižim yieldom**
u odnosu na veličinu (`schmersal-101195901`, 45 atributa iz 1,2 MB stranice) jer je tamo najvjerojatnije
skriven gap.

Yield **nije** bio problem — 45 atributa i 9 normaliziranih polja je čisto čitanje. Ali provjera te
pretpostavke je otkrila **P1.3c**:

> Atributi su dolazili kao `Rated impulse withstand voltage U<sub>imp</sub>` i
> `Rated insulation voltage U<sub>i</sub>` — **markup unutar IMENA atributa**, dakle doslovno tako bi
> otišlo u Excel.

Grep HTML-a za `<sub>` nalazi **nulu**: tagovi postoje samo unutar **embedded JSON bloba**, a te stringove
cheerio text-extraction nikad ne dotakne jer nikad nisu bili DOM node. Kako sve više vendora servira
specove iz JSON state trija, ovo je rastuća klasa.

Novi `stripHtmlMarkup` ([text-util.ts](../src/server/text-util.ts), leaf) na istom choke pointu gdje ide
plausibility filter. Dvije stvari koje je vrijedilo razlučiti:

- **inline tagovi** (`sub`, `sup`, `b`, `i`, `em`, `span`, `a`…) brišu se **bez razmaka**, jer sjede
  *unutar tokena*: `U<sub>imp</sub>` je jedan simbol „Uimp", a ubaciti razmak znači izmisliti ga;
- **strukturni** (`br`, `td`, `tr`, `li`, `p`, `div`) postaju **razmak**: `24 V<br/>DC` je „24 V DC", a
  `<td>Weight</td><td>1.5 kg</td>` je „Weight 1.5 kg", ne „Weight1.5 kg".

Tag pattern zahtijeva **slovo** iza `<`, pa `< 5 mA`, `<= 10 ms` i `<0.5 W` prežive — izgubiti threshold
kvalifikator bio bi gori bug od onoga koji se čisti. Dekodiraju se i entiteti (`&deg;`, `&sup2;`,
`&plusmn;`, `&nbsp;`) te numeričke reference (`&#176;`, `&#x00B0;`).

**Novi fixture je najbogatiji HTML slučaj u korpusu** (21 asertacija): pravi IEC labeli (Uimp, Ui,
utilisation categories AC-15/DC-13), i ujedno čuva razliku `Ambient temperature -30…+60 °C` vs
`Storage and transport temperature -30…+85 °C` — `operatingTemperatureMax` mora biti 60, nikad 85.

Broj atributa nepromijenjen (45), dakle čišćenje nije ništa pojelo. Asertacija u korpusu **120 → 134**.

### ✅ P1.3d — markup i JS kod kao atributi (i dva moja vlastita false positivea)

Nastavio sam promociju fixtura, ovaj put s **najvišim** yieldom (rockwell, 230 atributa) — jer je visok
yield mjesto gdje se skriva **smeće**, obrnuta klasa greške od one koju low-yield fixture otkriva.

Korijen je isti kao P1.3c, ali dublji: **`splitNameValue` reže na `=`, a i HTML tag i JS dodjela su
građeni oko njega.** Pa je stranica dala:

```
<details id            = "ra-product-new__documentation-table-mobile" class="…"
<ra-footer origin="https = //www.rockwellautomation.com" path="/en-us/config-pages/footer"
const catalogNumber    = window.location.pathname.split('/details.')[1].replace('.html', '');
CQ_Analytics.TestTarget.currentPagePath = '\/content\/rockwell-automation\/global';
Environmental compliance inquiry = Business Email Address* This field is required Company Name*
```

`stripHtmlMarkup` tu ne pomaže — splitter je već odrezao tag, nema zatvarajućeg `>`. Mora se odbaciti
po **obliku**. Dodano: tag-shaped run bilo gdje (uklj. **custom elemente s crticom** — `<ra-footer>`,
`<select-styler>` — HTML komentare i CDATA), ime HTML atributa kao samostalna labela, JS ključne riječi i
DOM globali, JS escape sekvence (`\/`, `\uXXXX`), dotted identifier od 3+ segmenta, viseći operator
(`pageName +="`), i kontakt-forma.

**Rockwell: 230 → 144 atributa, sva 8 normaliziranih polja nepromijenjena** — šum je bio čisti balast.

#### Dva false positivea koja sam sam uveo, i koja je korpus uhvatio

Ovo je najvrjedniji dio kruga, jer pokazuje da detektor radi u oba smjera:

| Moje pravilo | Što je pokvarilo | Kako je nađeno |
| --- | --- | --- |
| `HTML_ATTRIBUTE_NAME_LABEL` je uključivao `width`, `height`, **`d`**, `type`, `name`, `value`, `title` | ABB dimenzije pale s `155 x 120 x 190 mm` na **`D 190 mm`** — jer je `d` **diameter**, prava spec labela | value-verified asertacija na ABB fixtureu, odmah |
| `OPERATOR_TAIL_LABEL` je odbacivao **svaku** labelu koja završava s `:` | `• Certifications:` izgubljena; prave labele stalno završavaju dvotočkom | unit test iz P0.2#7 |

Oba sužena, s objašnjenjem u kodu zašto je uža verzija ispravna.

Popravljen i **nedostatak harnessa**: `findContamination` je za sve tokene radio compact-matchanje
(strip interpunkcije), pa se token `<details` poklopio s legitimnim `1 year See details`. Sad compact put
vrijedi samo za tokene bez „literalne" interpunkcije — postojao je zbog kataloških šifri
(`CBE03320` vs `cbe 03320`), ne zbog markupa.

Asertacija u korpusu **134 → 150**, testova **2082 → 2088**.

### ✅ P1.3e — adresa firme kao certifikat

Uzrok nije bio tamo gdje sam pretpostavio. Grana `certification-list li` u
`extractCertificationAttributes` uzima **bilo koji** `<li>` tekst bez validacije — i to **namjerno**:
zahtijevati token allowlist na tom mjestu je prije bacalo prave country-qualified marke (`Korean KC`,
`Australian RCM`). A Rockwellova certifikacijska lista **legitimno** sadrži adresu EU predstavnika, jer je
to dio deklaracije o sukladnosti.

Dakle kontejner je ispravan, a gate mora biti na **vrijednosti**. Adresa nikad nije spec vrijednost, pa je
pravilo otišlo u opći `spec-plausibility` sloj, uz **dva nužna signala**:

- place word (`park`, `street`, `avenue`, `road`, `weg`, `platz`, `via`, `rue`, `suite`, `PO box`) **ili**
  njemački sufiks `straße/strasse` — složenice poput `Hauptstraße` nemaju granicu riječi prije, što me
  prvo promašilo;
- **plus** najmanje 4 riječi.

Oba su nužna: place word sam po sebi nije dovoljan jer je **„Park brake" pravi proizvodni termin**. A
legal-entity sufiks (`AG`, `GmbH`, `N.V.`) namjerno **nije** signal — certifikacijska tijela ga nose
(`TÜV SÜD AG`).

Rockwell: adresa nestala, **svi pravi certifikati ostali** (`Australian RCM`, `MOROCCO DOC`,
`Eurasion Economic Community` — tipfeleri su u izvoru, ne u nama). PDF audit 6424 → 6423, dakle jedna
takva adresa je bila i u PDF korpusu.

### ✅ P1.3b (dio) — Ganter tablica opcija: 4 od 5 klasa

Prije koda sam provjerio ima li korpus **detektor** za HTML tablice, jer bez njega bih gradio naslijepo.
Ima ga točno jedan: **gan** (8 tablica, **40 colspan/rowspan**); ostali fixture imaju 0-2 spana. To je
ujedno vendor kojemu je HTML **jedini** izvor istine — svi Ganter PDF-ovi su `enrichable:false`.

Promocija tog fixturea dala je najbogatiji ulov u cijelom radu — **5 klasa greške**, od kojih 4 riješene:

| Klasa | Bilo | Ishod |
| --- | --- | --- |
| električna vrijednost u polju **boje** | `color = "24 V DC ± 10 % / 7 mA"` | novi `withoutForeignQuantityKinds` backstop. **6 izvora** feeda `color`, pa unit-kind provjera ide na granicu, ne u pojedini izvor — isti obrazac kao postojeći backstop za spojene mjere |
| **cijela proza** u voltage I current | ista contact-specification paragrafa (~25 riječi) u **oba** polja | `withoutMixedKindProse`: pomiješane vrste mjera **plus** ≥12 riječi. Same-kind multi-values (`230/400 V`, `1 A, 3 A, 6 A`) i terse mixed (`24 V DC / 7 mA`) prežive — riječi nose odluku |
| UI kontrola kao vrijednost | `Connection type = "Show / Hide columns Werkstoff a d h l1 l2 l3 t"` | `UI_CONTROL_PATTERN` |
| asset put i sekcija sajta | `"@friendlycaptcha/sdk" = ".../sdk.js"`, `Upcoming Trade Shows = Automation Expo …` | `ASSET_PATH_PATTERN` + `SITE_SECTION_LABEL` |
| **variant kontaminacija** | labela jedne opcije s vrijednošću **druge**: `"SR - Silver, RAL 9006…" = "SW - Black, RAL 9005…"` | **OSTAJE** — traži pravo colspan/rowspan matrix čitanje |

Zanimljivo je što fixture sad **tvrdi da su voltage/current/color prazni** — i to je ispravan odgovor, ne
gap. Električni ratinzi ovog rukohvata pripadaju opciji odabranoj u ordering kodu; generički put ne zna
koji red tablice opcija je naš, pa **tišina pobjeđuje tuđi broj**. Ganterov dedicirani konektor varijantu
razrješava zasebno.

Korpus: **4 fixturea value-verified**, asertacija **150 → 157**, testova **2091 → 2117**.

### ⚠️ Ostatak P1.3b — i moja najgora greška u ovom radu

Krenuo sam graditi colspan/rowspan matrix čitač za zadnju gan klasu. **Prvo sam provjerio strukturu, i
dobro je što jesam:** taj tekst **nije u tablici**. Živi u `alt`/`title` atributu slike, kao escapan
markup (`&lt;br /&gt;`), i opisuje **thumbnail sibling varijante**. Matrix čitač ga nikad ne bi ni
dotaknuo — bio bih izgradio cijeli modul za problem koji ne postoji na tom mjestu.

Rješeno pravilom na **paru**: dvije vrijednosti jedna uz drugu nisu label/value par. I to je moralo biti
na paru, ne na labeli — prva verzija je gledala samo labelu, a **audit je odmah prijavio 10 izgubljenih
vrijednosti**: Ganterovi vlastiti standard sheetovi legitimno koriste opcijski string **kao labelu**
(`SW - Black, RAL 9005, textured finish` = `black`), i pipeline iz toga ispravno izvodi finish i boju.

#### Greška koju sam gotovo upisao u korpus kao ispravno ponašanje

Naš kataloški broj je `GN 422-33-RO-RK-K5-**SR**`, a stranica jasno navodi šifre:
`SR - Silver, RAL 9006` (152×) i `SW - Black, RAL 9005` (154×). Dakle **naš** finish je RAL 9006.

Generički put daje **RAL 9005** — dakle **sibling varijantinu** vrijednost. A ja sam u fixture prvo
upisao `finish: contains "RAL 9005"` kao ground truth, jer sam **vjerovao izvučenoj vrijednosti umjesto
da pročitam izvor** — točno ono što `fixtures/README.md` zabranjuje. Korpus bi time zaključao
kontaminacijski bug kao očekivano ponašanje, i svaki budući „popravak" bi ga rušio.

Ispravljeno: fixture sad tvrdi RAL 9006 i drži to kao **knownGap** (P1.3f). Nijedan gate to ne može
riješiti — `Finish = SR - Silver, RAL 9006` je posve običan par; treba razrješavanje varijante iz
ordering koda prema opcijskim šiframa na stranici.

Zapisujem grešku, ne samo popravak: bila je instruktivnija od njega.

### ✅ P1.3f — razrješavanje varijante iz ordering koda (korpus opet bez gapova)

Klasa koju gate ne može riješiti dobila je pravilo koje **treba kataloški broj**, pa ne može stajati u
leaf gateu — vezano je na choke point u `generic.ts`.

Pravilo: vrijednost oblika `CODE - opis` čiji `CODE` nije segment **našeg** ordering koda pripada sibling
varijanti. Dva uvjeta prije odbijanja, da se ne unište obični `CODE - opis` parovi
(`CE - Conformité Européenne`, `M8 - coarse thread`):

1. code **nije** među segmentima našeg kataloškog broja, **i**
2. naš kataloški broj **nosi** segment istog oblika — to je ono što uopće govori da je option-coded.

`GN 422-33-RO-RK-K5-SR` ima segmente `RO`, `RK`, `SR`, pa `SW - Black, RAL 9005` pada, a
`SR - Silver, RAL 9006` prolazi. Za `CBE03319` ili `1SDA126493R1` pravilo se **ne aktivira** jer ti
brojevi ne nose dvoslovne option segmente — isti `SW - Black` bi tamo prošao.

`finish` sad razrješava **našu** varijantu. Korpus je opet **bez otvorenih gapova**, audit **0 SUSPECT**,
**2124** testa.

### ✅ P1.4a + P1.4b — najniži yield je našao propušteni podatak (4/4)

Promocija turck fixturea, odabranog kao **najniži yield u korpusu** (27 atributa iz 287 kB) po teoriji da
nizak yield skriva *propušteno*. Potvrdilo se.

**P1.4a — odvojeni min/max redovi se nisu spajali.** Atributi `Ambient temperature min. (°C) = -30` i
`max. (°C) = 85` bili su **izvučeni cijelo vrijeme**, a `operatingTemperature` je bio prazan:
`deriveOperatingTemperature` je tražio raspon unutar **jedne** vrijednosti i nikad nije parao dva reda.
Jedinica živi u **labeli**, vrijednost je goli broj — norma za senzorske vendore (Turck, Balluff, IFM).
Novi prolaz pari redove po label-baseu i jedinicu pušta kroz `parseQuantities`, pa se °F redovi konvertiraju
postojećom logikom umjesto vlastitim kodom.

**P1.4b — naslov proizvoda je bio „Sign up to our Newsletter".** Newsletter widget markiran kao `h1` prije
product headinga. Gore od kozmetike: `confirmsIdentity` traži kataloški broj **u naslovu**, pa chrome
naslov slabi i potvrdu identiteta.

#### Dvije moje greške koje je korpus uhvatio — usporedbom kroz fixture, ne pojedinačno

| Greška | Šteta | Kako je nađena |
| --- | --- | --- |
| dodao sam `h2` u kandidate za naslov | cookie i site naslovi (`We respect your privacy`, `Ganter worldwide`) su ranije u DOM-u i **pokvarili dva naslova koja su bila ispravna** | ispis naslova kroz sve fixture odjednom |
| dao sam prednost naslovu koji **naziva** kataloški broj | Rockwell `XLS Power Supply 120W 24VDC 5A` → `1606-XLS120E`: zamijenio opis koji čovjek čita identifikatorom koji red **već nosi u svom stupcu** | ista usporedba |

Konačni redoslijed: **vendorov vlastiti `h1`** → bilo što što naziva kataloški broj → `<title>`. Catalog
match je *fallback* za slučaj kad je heading neupotrebljiv — što je točno turckov slučaj.

Strategija „biraj po ekstremima yielda" je sad **4 od 4**: schmersal (markup u labelama), rockwell (markup
i JS kod), gan (5 klasa), turck (propuštena temperatura + naslov).

Asertacija u korpusu **158 → 167**, **5 fixtura** value-verified.

### ✅ P1.4c — front-end framework curi svoje bindingove u atribute (5/5)

Promocija balluff fixturea, **najvišeg nepromoviranog yielda** (177 atributa) — visok yield je mjesto gdje
se skriva smeće. Bilo je: **Alpine.js** je curio svoje uvjetne class bindingove.

Alpine piše `:class="{ 'shadow-md': !searchOpen && !mobileMenuOpen, 'w-0': menuOpenedId !== '0' }"`, a
`splitNameValue` reže na `:` — pa nastanu parovi `'shadow-md'` = `!searchOpen && !mobileMenuOpen`.
Postojeći code-fragment gate ih je promašivao jer **ne imenuju DOM global ni metodu**.

Tri pravila, svako s vlastitim rubom koji je trebalo pogoditi:

| Pravilo | Rub |
| --- | --- |
| JS izrazi (`&&`, `\|\|`, `!==`, `===`, vodeći `!identifier`) | ne smije pogoditi `< 5 mA`, `230/400 V`, `-5 ... 55 °C` |
| labela u navodnicima + **odsječen** navodnik | split se događa i na dvotočki **unutar** imena klase (Tailwind `lg:`), pa labela ostane `'absolute inset-x-0 px-2 mx-2 lg`. Navodnik mora biti na **početku**, a za vrijednosni oblik traži se object-literal `':` — inače bi `Manufacturer's data` bio uništen |
| framework direktive (`x-*`, `v-*`, `@click`, `:class`) | Balluff je dao `x-on` = `search-open.window="openSearch"` |

**177 → 154 atributa, sva 8 normaliziranih polja nepromijenjena** — 23 komada čistog framework šuma.

Vrijedan detalj: temperatura `-5 / 55 °C` na ovom fixtureu dolazi iz **P1.4a** pairinga. Balluff koristi
isti dvoredni min/max layout kao Turck, što je dokaz da se taj popravak isplati **kroz vendore**, ne samo
na stranici na kojoj je nađen.

Strategija ekstrema yielda je **5 od 5**: schmersal, rockwell, gan, turck, balluff.

### ✅ P1.4d — prvi šum koji je stigao u IZVEZENO polje (6/6)

Promocija fath fixturea dala je nalaz drukčije težine od svih dosadašnjih:

> `certificates = "RoHS, **Data Protection Declaration**, REACH Regulation"`

Dosad je šum uglavnom sjedio u listi atributa; ovo je **pogrešna vrijednost u polju koje ide u Excel**.
GDPR obavijest nije odobrenje proizvoda.

**Uzrok nije bio gdje sam pretpostavio.** Prvo sam dodao pravilo u attribute gate — i nije pomoglo, jer
takav atribut na stranici **ne postoji**. Vrijednost dolazi iz **klasifikacije dokumenta**:
`classifyDocument` mapira riječ `declaration` na `certificate` (zbog *deklaracije o sukladnosti*), pa je
vendorov footer link „Data Protection Declaration" postao **certifikat-dokument**, a labele dokumenata pune
`normalized.certificates`.

Popravljeno testom na pravne/policy dokumente **prije** certifikatske grane — jer takvi dokumenti gotovo
uvijek nose i certifikatski keyword. `Declaration of Conformity` i dalje prolazi (testirano).

Sitniji nalazi s iste stranice: `product:price:amount = 0` (commerce meta ključ kao labela),
`baseSliderWrapperClass = modal-body` i `debug = false,` (JS config → goli boolean literal nikad nije
specifikacija).

Strategija ekstrema yielda je **6 od 6**, i ovaj krug je pokazao njezinu granicu: **attribute gate ne vidi
sve putove do polja.** Vrijednost može ući preko klasifikacije dokumenta, i tamo treba zasebna provjera.

### ✅ P1.4e — metapodaci fajla u certifikatima, i pravilo koje je postojalo ali nije opalilo (7/7)

nVent enclosure fixture, treći najviši yield. `certificates` je bio:

> `… RoHS, **CERT-00070 653 KB English** Declaration of Conformity, Declaration of Conformity **117 KB
> English** Declaration of Conformity, …`

Dekoracija download linka (veličina fajla, jezik) **u izvezenom polju**, plus ime dokumenta dvaput.

**Najzanimljivije: pravilo za to je već postojalo.** `cleanCertificateResourceText` skida veličinu i jezik
od prije ovog rada — ali **samo ukotvljeno na kraj**, a nVent stavlja dekoraciju u **sredinu**, pa se nikad
nije aktiviralo. Odkotvljena je samo **veličina** (i jezik neposredno iza nje); goli jezik ostaje ukotvljen
na kraj, jer bi skidanje bilo gdje uništilo prava certifikacijska tijela — `Germanischer Lloyd`.

Uklanjanje dekoracije *između* dvije kopije imena ostavlja `Declaration of Conformity Declaration of
Conformity`, pa je dodano i sklapanje ponovljene fraze.

**Drugi put zaredom fix nije pripadao attribute gateu.** Certifikati se sastavljaju iz **labela dokumenata**,
pa ih pravilo na razini atributa ne vidi — prvo sam ipak probao tamo i nije pomoglo. To je sad zapisano kao
pravilo za sebe: *pogrešna vrijednost u polju znači prvo pitati kojim je od nekoliko putova ušla, pa onda
pisati predikat.*

Ostaje otvoreno i zapisano u fixtureu: `IP32` u `certificates` (to je zaštita, ne odobrenje) i `Type3R`
dvaput u `protection` — token-level čišćenje u collectorima, namjerno nije spojeno u ovu izmjenu.

I jedna moja greška: prvo sam weight asertirao kao `{number: 1.63}`, a vrijednost je legitimno dvojedinična
(`3.6lb (1.63 kg)`) pa harness čita **prvi** broj — funte. Asertacija je bila pogrešna, ne ekstrakcija.

### ✅ P1.4f–P1.4i — oba ABB fixturea: 4 nove klase, i novi audit alat za HTML put (10/10 promocija)

Zadnja dva noise-guard fixturea (`abb-1SDA126404R1`, `abb-1SAP180400R0001`, ~36 atributa) promovirana u
value-verified. Dala su četiri klase, od kojih je jedna bila **bug u routeu, ne u gateu**.

**P1.4f — inline skripte kao atributi.** `a.async` = `true;`, `a.src` = `src;`,
`heading.textContent` = `desired;`, `lockUntil` = `now() + ms;`, i cijeli Google Tag Manager snippet
razlomljen u par `j=d.createElement(s),dl=l!='dataLayer'?'&l='+l` = `'';j.async=true;j.src=`. Staro
code-pravilo ih nije vidjelo jer ne imenuju DOM global i (osim jQuery-ja) ne zovu metodu. Dodano: dotted
lowercase labela, bare-identifier-plus-semicolon vrijednost, `!=`, ternary s quoteom, `createElement`,
`;`-pa-dodjela, i zero-argument poziv (`now()`). **`;` sam po sebi namjerno nije signal** — korpus asertira
da `AC 100 V; 120 V; 230/240 V (50/60 Hz);` mora preživjeti.

**P1.4h — reklamna proza raskomadana u lažne specifikacije.** Ovo je najvažniji nalaz runde, jer popravak
**nije pripadao gateu**. `extractDelimitedPlainTextSpecAttributes` nosi „Delimited" u imenu, a delimiter
mu je bio **opcionalan** (`(label)\s*(?::|-)?\s+(value)`) — pa je svaka rečenica s dvije spec riječi
postala par. Vrijednost uvijek završava neposredno **prije sljedeće labele**, a u prozi je ta riječ glava
fraze, pa je uhvaćena vrijednost strukturno zagarantirano viseći modifikator:

> `Mounting` = `options, offering expanded` · `Voltage` = `range (100-250 V 50/60 Hz and DC), managing large control`
> `Protection` = `is built-in, offering a compact solution. AF contactors have a block` · `Current` = `Low`

**Izmjereno prije izmjene**: preko keširanog korpusa taj undelimited put dao je **7 parova i svih 7 je
proza**. To je odmah oborilo prvo pravilo koje sam smislio (traži brojku ili veliko slovo) — proza o
naponskim rasponima je puna brojeva, zadržala bi 5 od 7. Drugo pravilo (odbaci sve što počinje malim
slovom) **oborio je regression suite u istoj minuti**: Phoenix Contact legitimno objavljuje
`Color white (RAL 9010)` bez delimitera. Sletjelo je pravilo na **oblik rečenice** (zarez+gerundij, točka
pa veliko slovo, klauzula bez brojki spojena funkcijskom riječi) plus „quantity labela bez brojke nije
mjerenje" — odbacuje svih 7, zadržava sve 4 prave vrijednosti.

**P1.4i — tablica srodnih proizvoda kao specifikacije.** Vendorov blok „ostali proizvodi u familiji"
renderira se kao `| naziv proizvoda | brand |`, što plain-text čitač ne razlikuje od `| labela | vrijednost |`.
Na jednoj ABB stranici to je dalo **49 atributa** tipa `KLC-S key lock open N20007 E1.3 right` = `ABB` —
imena *sibling* proizvoda kao specifikacije ovog. Diskriminator je brand, koji je u tom trenutku već
poznat iz structured data stranice; labela koja stvarno pita za proizvođača zadržava svoj odgovor.

**P1.4g — dio tipske oznake čitan kao struja (ODGOĐENO, sa zapisanim razlogom).** `current` = `2a` dolazi
iz **imena proizvoda** `KLP-A Bl.Ins/Sez Castell E1.3 2aCh`. To je key lock, pribor — stranica ne objavljuje
nikakvu struju, pa je ispravan izlaz prazno polje. Očito pravilo (SI simbol za amper je **veliko** `A`,
malo `a` je annum) uništilo bi vendore koji pišu `16a`, pa je zapisano kao knownGap s ground truthom
umjesto da se pogađa.

**Novi alat: `npm run audit:page-attrs`.** `audit:spec-gate` pokriva PDF-ove; HTML put nije imao ekvivalent.
Ovaj ispisuje što generički HTML put stvarno izvuče preko svih keširanih stranica, po grupama, dedupliciran
i sortiran (dva runa su diffabilna). On je našao P1.4i, `now()` leak i zakomentirani JS
(`// hit._highlightResult[key].value` = `_.escape(…);`) — i on je izmjerio da je nakon popravaka grupa
`Plain Text` na tih 60 stranica **prazna**: svih 50 parova je bilo šum, nijedan pravi podatak. Bez njega bi
„stegni pa vidi hoće li testovi pasti" bilo jedino mjerilo.

Dva pravila iz te runde vrijedi zapisati zbog **oblika**, ne sadržaja. Za `//` komentar **razmak iza `//`
je obavezan** — protocol-relative URL (`//www.vendor.com/…`) ga nikad nema, pa pravilo ne može opaliti na
razlomljenim tagovima. Za vrijednost `_.escape(hit._snippetResult[key].value);` traže se **dva neovisna
signala zajedno** (dotted identifier neposredno pa `(`, I završni `;`), jer svaki sam ima uvjerljiv
kontraprimjer (`Length(mm) 25;`), a oba zajedno nemaju. To je isti obrazac koji je pet puta prije spasio
prave podatke: rub pravila je ono što treba pogoditi, ne njegova namjera.

I jedan korektiv na vlastiti zaključak: širi audit (320 stranica) pokazao je da grupa `Plain Text`
**nije** univerzalno šum — na norveškom ABB sajtu (`abblvp.no`) daje prave podatke
(`Bruksområde` = `Bolig, forretningsbygg og industri.`, `Icn` = `10 kA`, `Standard` = `IEC/EN 60898,
IEC/EN 60947-2`). Zato je P1.4i vezan na **brand**, a ne na gašenje grupe: da sam zaključio „grupa je
smeće" iz prvog uzorka od 60 stranica, izgubio bih stvarni sadržaj. Mjera na 320 stranica: **153 → 15**
parova, i svih 138 izgubljenih su bili ABB sibling redovi.

Preostalih 6 curenja iz te iste widget skripte tražilo je još dva pravila, jer nemaju **ni** `;`:
`wp.template('autocomplete-empty')` i `_.escape(config['label'])` (poziv metode s quotiranim argumentom —
quote stoji umjesto točke-zapeta kao drugi signal) i `algoliaResponse.query` (camelCase code path; **inner
capital** je ono što ga čini sigurnim za odbacivanje, jer vendori objavljuju dotted lowercase vrijednosti
kao `datasheet.pdf`).

**Zamka na koju sam dvaput pao u ovoj rundi**, vrijedna zapisa jer je proceduralna a ne tehnička: pustio
sam wide audit u pozadinu, pa **u međuvremenu mijenjao kod** — a `tsx` učita modul na startu procesa, pa je
rezultat mjerio **staro** stanje. Prvi put je to izgledalo kao „popravak nije radio", drugi put kao
„ostalo je 6 curenja". Mjerenje koje traje 10 minuta mora se pokrenuti **nakon** zadnje izmjene, inače
mjeri prošlost.

### ✅ P1.2 (prvi dio) — detektor za drift labela, i najskuplji bug do sada

Po vlastitom pravilu iz plana: **prvo detektor, pa mijenjanje `normalizer.ts`.** Novi
`npm run audit:labels` (`scripts/audit-label-systems.ts`) usporedi dva sustava labela koje projekt drži
paralelno — `FIELD_REGISTRY` (16 izveznih polja, ručne engleske regexe) i `PROPERTY_ONTOLOGY` (98 svojstava,
EN/DE/FR/IT/ES/NL) — u četiri sekcije: (A) labele koje registry zna rutirati a ontologija ih ne prima,
(B) svojstva koja ontologija razumije a nijedno izvezeno polje ne nosi (informativno, 69), (C) nesuglasice
tipa jedinice, (D) sinonim koji pali na **našim vlastitim** imenima grupa i generičkom page furnitureu.

**Sekcija D je našla bug koji je tihо kvario podatke svim proizvođačima.** Francuski sinonim za finish,
`/finition/i`, nije bio ograničen granicom riječi — pa pali unutar **engleske** riječi „de-**finition**".
A `Definition List` je ime grupe koje **naš vlastiti parser** dodjeljuje svakom `<dl>` bloku, i ontologija
se matcha protiv `group + name`. Rezultat: svaka stranica sa specifikacijama u `<dl>` upisivala je prvu
vrijednost tog bloka u izvezeni stupac **`finish`**:

> `Dimensions` = `155 x 120 x 190 mm` → **finish** = `155 x 120 x 190 mm`
> `Weight` = `0.3 kg` → **finish** = `0.3 kg` · `Protection` = `IP66` → **finish** = `IP66`

Populacija: **60 od 10011** keširanih stranica ima `<dl>` — Turck (30), nVent (28), Doepke (1). Dakle tri
**postojeća** proizvođača, ne hipotetski novi. Popravak je jedna granica riječi (`/\bfinitions?\b/i`), uz
test koji čuva francuski i talijanski vokabular (`Finition`, `Traitement de finition`, `Finitura`).

To je ujedno objašnjenje za nešto što je kroz cijeli rad izgledalo kao „finish je catch-all" — uključujući
staro `finish = "and"` na ABB fixtureu i Ganterove muke s finishem. Nije bio catch-all; bio je jedan
neograničen sinonim.

**Dvije stvari koje sam usput pogrešno pretpostavio, i ispravio mjerenjem:**

1. Sekcija A je prijavila `Dimensions`, `Size`, `Gauge` kao „ontologija ih ne prima" i **pomislio sam da je
   to izgubljeni podatak** — točno pritužba korisnika (nova stranica, podatak se ne nađe). Provjera kroz
   pravi parser pokazala je da su **sve propuštene**: ontologija je *dodatni* put u `isUsefulSpecLabel`, ne
   jedini gate. Zapisano kao objašnjena iznimka, ne kao bug. (Ontologiji ipak fali agregatno svojstvo
   `dimensions` — tidy fix, nije urgentan jer se ništa ne gubi.)
2. Prva verzija sekcije C usporedila je samo `property.label` s registry aliasima i prijavila **0**
   konflikata. To je govorilo više o provjeri nego o kodu. Prepravljena da hoda **pravim putem rutiranja**
   (`matchProperty(label)` — isti poziv koji radi gate) i odmah našla `Power input`: registry ga daje
   `voltage`, ontologija ga tipizira kao `power`. Runtime to *već* rješava po jedinici vrijednosti
   (`Power input 24 W` → ništa, ispravna tišina; `Power input 24 V DC` → voltage), pa nije bug — ali ostaje
   **vidljiv** u auditu, jer je alias siguran samo dok ta provjera niže postoji, a učiniti tu garanciju
   strukturnom je upravo ostatak P1.2.

### ✅ P1.2 (ostatak) — jedan izvor istine, i 30 pogrešnih vrijednosti u produkciji

**P1.2b — guard na jedno mjesto.** Plan je tvrdio „4 kopije"; kod je imao **jednu** definiciju i pet
*poziva*, jer sam kopije objedinio još u Fazi A. Prava krhkost je bila drugdje: registry putevi ključaju na
`"voltage"`/`"current"`, ontološki na `"ratedVoltage"`/`"ratedCurrent"`, pa je isto pravilo moralo biti
napisano **dvaput, u dva vokabulara** — a šesti put znači zapamtiti ga iznova. Sad je jedan
`isDisqualifiedForQuantityKind(label, value, kind)` u ontologiji, ključan na **fizikalnoj vrsti**, jedinom
namespaceu koji dva sustava dijele; `registryFieldQuantityKind()` u registryju mapira polje na vrstu.
Namjerno je i **proširen**: inrush/peak i scope-norme sad vrijede na svim putevima, ne samo na registry
putu. Uz to `NormalizedRegistryFieldKey` pretvara tihi no-op (`operatingTemperatureMin` je legalan
`keyof NormalizedProductFields` bez registry entryja → `undefined` zauvijek) u **compile error**, s
`@ts-expect-error` testom koji pada ako zaštita ikad nestane.

**P1.2c — `ontologyKeys` na registry entryju, i sekcija E.** Veza koju je plan tražio: svaki entry sad
deklarira koja ontološka svojstva legitimno pripadaju tom izveznom stupcu. Time je pitanje „slažu li se dva
sustava o ovoj labeli" prvi put **odgovorivo**, i sekcija E audita je nabrojala **17 nesuglasica** — od
kojih 6 pogrešnih podataka koje ni jedan postojeći guard nije mogao uhvatiti, jer dijele vrstu s poljem ili
polje uopće nema vrstu:

> `Rated residual current` → **30 mA u stupac `current`** uređaja rated na 40 A · `Let-through current` (I²t)
> · `Leakage current` (µA) · `Stripping length` → `dimensions` · `Material thickness` → tekstualni `material`
> · `Enclosure protection` → `material`

Pravilo je jedno: **ontologija odlučuje koje polje, registry samo širi vokabular.** Kad ontologija labelu
može smjestiti, a smjesti je izvan `ontologyKeys` tog polja, registry ustupa. Kad je ne može smjestiti,
registryjevo nagađanje stoji — za to široki aliasi i postoje, i to je ono što drži nepoznate proizvođače.

**Testovi su odbili prvu verziju, dvaput, i oba puta su bili u pravu:**

1. Prva verzija pala je na **16 testova**. Poruka je bila da su `ontologyKeys` liste preuske: stupac
   `current` legitimno nosi i `currentConsumption` (za senzor je *to* struja koju kupac traži) i
   `switchingCapacity` (za relej je to kontaktni rating), a `Power input` nosi **napon** kad ga vendor tako
   napiše.
2. Druga verzija pala je na SCE testu (`Input Power` = `85 to 264 VDC` izgubljen). To je iznudilo oštriju i
   ispravniju formulaciju: ustupi samo kod **sibling-a iste fizikalne vrste**, gdje nijedna jedinica ne može
   razlučiti (residual current i rated current su oba amperi). Kod **različite** vrste labela je dvosmislena
   i odlučuje jedinica vrijednosti — pa ustupanje samo briše pravi podatak.

**Najveći nalaz runde: kanonizacija labele uništava kvalifikator.** Ontološki tekstualni sweep imenuje
izlaz po *definiciji*, ne po nađenom tekstu — to je ono što „Bemessungsstrom" čini čitljivim. Ali isti
rename briše riječ koja vrijednost diskvalificira: `Wire Strip Length 10 mm` postajao je atribut
**`Length = 10 mm`**, i od tog trenutka je svaka exclusion lista niže bila slijepa (`dimensionAxisLabelScore`
*ima* „stripping length" na listi — nije mogla opaliti jer kvalifikator više nije postojao). Tih 10 mm
izvozilo se kao dimenzija proizvoda.

Popravak je generički, bez ijedne nove liste: sweep smije kanonizirati samo ako **puna** labela razrješava
u isto svojstvo (`matchProperty` već preferira najspecifičniji sinonim, pa „stripping length" pobjeđuje
„length"). Mjerenje: `PRODUCT_SCRAPER_TRACE_CANONICALIZATION=1 npm run audit:spec-gate` na 220 stvarnih
dokumenata dalo je **30 odbacivanja i svih 30 je pogrešan podatak** — 30× `Wire Strip Length`/`stripping
length` kao dubina proizvoda, plus `modules under power` i razlomljeni `and approvals Pressure`. To se
događalo u **produkciji, postojećim proizvođačima**. Zato je „zadržani atributi" pao 6329 → 6299: to nije
gubitak pokrivenosti, to je 30 uklonjenih grešaka, provjerenih red po red.

I jedna posljedica koju je eval uhvatio a unit testovi nisu: uklanjanjem tog konkurenta na Ganter stranici
**promoviran je LED indikatorov napon** (`LED indicator light … Operating voltage` = `24 V DC ± 10 % / 7 mA`)
u napon proizvoda. Fixture je dosad prolazio **na sreću rangiranja**, ne zato što je vrijednost bila
blokirana. Dodano pravilo: napon signalne lampice je rating **podkomponente**; kvalifikator je obavezan, pa
proizvod koji *jest* signalna lampica zadržava svoj goli „Operating voltage" red.

### 📊 Stanje mjerila

| Mjerilo | Sad |
| --- | --- |
| `npm run eval` | **15/15 slučajeva, 0 kontaminacija, 207 asertacija, 1 open gap** (start: 5 slučajeva, 0/5, 8 kontaminacija) · **10 fixtura value-verified** · gap je namjeran: P1.4g nosi ground truth |
| `npx vitest run` | **2155/2155**, 106 fajla |
| `npm run audit:labels` (drift dvaju sustava labela) | A **0** neobjašnjenih (10 objašnjenih), C **0** (1), D **0** (1), E **14** (info; bilo 17, 6 popravljeno) · uvezan u `audit:pdt` |
| `npm run audit:discovery` (replay preko keša) | known PDP na **#1 20 %**, u top 3 **25 %**, nađen **40 %** (bilo 7,5 / 12,5 / 22,5) |
| `npm run audit:spec-gate` (stvarni dokumenti postojećih proizvođača) | **0 SUSPECT izgubljenih vrijednosti** · zadržani atributi **5617 → 6299 (+12 %)**; pad sa 6329 je 30 uklonjenih POGREŠNIH vrijednosti, provjerenih red po red |
| `npm run audit:page-attrs` (NOVO — HTML put preko keširanih stranica) | grupa `Plain Text`: na 60 stranica **50 → 0** (svih 50 šum), na 320 stranica **153 → 15** i preostalo je sve pravi podatak |
| `npx tsc --noEmit` | čisto |

### ⏳ Sljedeće

**Promocija fixtura je ZAVRŠENA: 10/10.** Svaki jedini promovirani fixture dao je barem jedan bug —
strategija „biraj po ekstremima yielda" (nizak yield = *propušteno*, visok = *smeće*) nije promašila ni
jednom. Nema više noise-guard `-page` fixtura; sljedeće širenje korpusa znači **vaditi nove stranice iz
`page_cache`** (2610 ih čeka) ili nove PDF-ove, ne promovirati postojeće.

**P1.2 je SLETIO** (detektor, guard na jedno mjesto, `ontologyKeys` veza, compile-time check — vidi gore).
Jedna stavka iz izvornog opisa je **svjesno odgođena**:

- `FIELD_LABEL_PATTERNS` (161 linija, treći vokabular labela) **nije** deriviran iz ontology sinonima.
  Zamjena 161 ručno naštimane regexe deriviranima mijenja matchiranje široko, a plan sam kaže „rizik
  srednji-visok". Umjesto toga je taj vokabular sad **podvrgnut** ontologiji preko istog pravila
  (`registryFieldContradictsOntology` vrijedi i na tom putu — mjerenje je pokazalo da bez toga
  „Rated residual current 30 mA" i dalje prolazi, jer taj put registry nikad ne konzultira). Time je
  praktična šteta od trećeg vokabulara zatvorena bez rizične zamjene. Deriviranje ostaje kao čišćenje kad
  postoji fixture koji ga traži.
- Iz P1.1 u istom obrascu: `isUsefulDynamicKey` (`generic.ts`) i `KNOWN_INLINE_LABELS` (`page-mining.ts`).

Sekcija B (69 svojstava koja ontologija razumije a nijedno izvezeno polje ne nosi) je zasebna prilika:
`breakingCapacity`, `power`, `frequency`, `torque`, `poles`, `conductorCrossSection` i još 63 su podaci koje
scraper **već razumije a nigdje ne izvozi**. To nije bug, ali je najveći poznati neiskorišteni ulov.

Dva pravila koja je ovaj rad zaslužio i koja vrijede za svaki budući popravak:

1. **Prvo pitaj kojim je putem podatak ušao, pa onda piši predikat.** Dvaput je popravak pripadao *routeu*
   a ne *gateu* (certifikati se sastavljaju iz labela dokumenata; proza je nastala iz opcionalnog
   delimitera). Gate na granici hvata smeće koje *izgleda* pogrešno; ne može popraviti put koji
   **strukturno garantira** pogrešan izrez.
2. **Svaka nova klasa smeća ima rub koji se mora pogoditi.** Šest puta je prvo pravilo bilo preširoko i
   uništilo pravi podatak (`d` = diameter, labela s dvotočkom, opcijski string kao labela, `h2` naslovi,
   apostrof u `Manufacturer's`, lowercase-initial vrijednost vs. Phoenix `Color white (RAL 9010)`), i šest
   puta je to uhvatio korpus ili audit — **nikad code review**. To je najjači argument da detektor ide
   prije koda.

**Colspan/rowspan matrix čitač (ostatak P1.3b) NIJE prioritet.** Provjera je pokazala da ga jedini fixture
s pravom tablicom (gan, 40 spanova) ne traži — njegov problem je bio u `alt` atributima. Prije gradnje tog
modula treba naći fixture koji ga stvarno traži, inače je to kod bez detektora.

Svjesni dugovi koji nose dalje:

- **Discovery se ne može mjeriti apsolutno offline.** `audit:discovery` daje pouzdanu *relativnu*
  metriku, ali 383 od 425 fetcheva su cache promašaji (generički search template koji stvarni run nikad
  nije koristio nema što servirati). Za apsolutnu uspješnost i dalje treba mreža.
- ~~**P0.1a — record/replay HTTP**~~ i ~~**HTML korpus je premali**~~ — oba zatvorena vađenjem iz
  `page_cache`, bez mreže. ~~**`.xml.gz` sitemapi**~~ — implementirano i testirano offline.

Obrazac vrijedan pamćenja: tri puta sam nešto proglasio nevalidiranim offline (HTML korpus, discovery,
gzip) i tri puta sam bio u krivu. Dva su bila rješena podatcima koji su već bili na disku
(`page_cache`), treći je bio tri linije `zlib`-a. „Ne može se provjeriti bez mreže" je zaslužilo više
skepse nego što sam mu dao.

**Zašto je P1.1 sad dokazano pravi sljedeći strukturni korak, a ne stvar preferencije:** sva 4
preostala gapa na Eaton fixtureu imaju isti korijen — *vokabular kao mehanizam*:

- `Casing protection degree` i `Design standard` nisu na engleskoj keyword listi `isGlobalTechnicalLine`
- `Part number` / `Article number` nisu u `KNOWN_LABELS`, pa detekcija header reda ne može opaliti
  (može prepoznati header samo ako zna **svaku** ćeliju u njemu)
- rated current 1 A je u ordering **tablici**, treba čitanje po stupcu, ne prozni sweep

Namjerno **nisam** krpao dodavanjem još unosa u liste (dodao sam samo `Unit per package` i varijante,
gdje je vokabular stvarno falio i gdje je i sam po sebi koristan podatak). Dopunjavanje liste po
vendoru je upravo obrazac koji plan opisuje kao uzrok problema; ontologija (98 svojstava, 7 jezika)
već zna te labele i mora postati **ulazna vrata**, a ne izlazna.

P0.1a (record/replay HTTP) je odgođen — snimanje traži mrežu, pa je korpus zasad seedan onim što je
već bilo u repou. Potrebno za discovery fixture.

---

### ✅ P1.3b — prvi stvarni HTML span-matrix fixture i čitač odabrane option-kolone

Pravilo „prvo detektor" ovdje je promijenilo odluku. `fixtures:extract -- --list` je pokazao
3.048 cacheiranih PDP-ova kroz 10 vendora. Pretraga njihovih DOM tablica našla je 347 PDP kandidata
sa spanovima: svi osim Ganterovih bili su Rockwellovi `Drawings` naslovi (2 spana, bez specifikacije).
Stari `gan-GN-422` i dalje nije dokaz za matrix reader, ali novi
`GN 6284-180-T-1-KU-2,5` jest.

U njegovoj `Article options / Table` tablici `Cable length l6 in meters` je `colspan=2`, a odabrani
part number nosi option segment `2,5`. Sirovi HTML put je dva susjedna data-cell-a spajao u
`2,5 5`, što je završilo kao `normalized.dimensions`; `5` je sibling varijanta. Fixture
`gan-GN-6284-180-T-1-KU-2-5-page` je value-verified čitanjem retka i tvrdi i pozitivan rezultat
`Cable length l6 in meters = 2,5` i negativan kontaminant `2,5 5`.

Novi `html-table-reader.ts` širi `colspan`/`rowspan` u pravokutnu matricu, spaja višeredne
headere, prenosi jedinicu iz headera (`Rated voltage [V]` + `24 DC` → `24 V DC`), čita i
catalog-in-row i option-in-column orijentaciju. Ako se naš katalog pojavi u dvije stvarne kolone,
reader ne emitira ništa. Tablice koje je reader sigurno razriješio isključene su iz starijih širokih
HTML table extractor-a, a točno stari flattenirani pair briše se prije normalizacije — ne šire
po labeli.

Dodana su 4 unit testa (span matrica, multi-row header, jedinica u headeru, option segment i
ambiguous-column silence). Puni rezultat nakon izmjene: `tsc` čist, **2159/2159** Vitest,
**16/16** eval fixtura uz 0 kontaminacija, `audit:spec-gate` **0 SUSPECT** na 120 dostupnih
cacheiranih PDF-ova, `audit:labels` A/C/D clean. `audit:page-attrs -- --group Table --limit 200`
ostao je identičan baselineu (60 distinct parova); discovery replay također nije promijenjen
(22 % #1, 25 % top-3, 41 % pronađenih).

### ✅ P1.3g — HTML family-page gate bez brisanja dokazano odabrane varijante

Isti `gan-GN-6284-180-T-1-KU-2-5-page` sada ima i eksplicitnu source-verified asertaciju
`pageLevel: "family"`: na kraju glavnog sadržaja skriva listu sva četiri ordering codea, uključujući
naš. To nije dovoljno da se svi atributi stranice pripišu našem SKU-u — selektor je family dokaz,
ne variant dokaz.

Novi `html-page-level.ts` zato prepoznaje target + barem jedan sibling kod u sadržaju proizvoda,
ali ignorira navigation/related-product railove. `ProductResult.pageLevel` dobiva `family`, generic
confidence se za takvu stranicu ograniči na 0,45, a weight/dimensions/wall thickness/finish/color,
voltage/current/protection/operating-temperature iz širokih sweepova se odbace. Prolaze samo ako
ekstraktor nosi `scope: "variant"` (odabrani HTML table row/column, katalogom filtrirani JSON ili
lokalni product context sa SKU-em koji se točno poklapa) ili `scope: "variant-option"` (jedna
radio/fieldset opcija čiji prefiks jedinstveno odgovara segmentu ordering codea).

Na stvarnom Ganter fixtureu atributi su **53 → 47**: neto je uklonjeno šest broad text/semantic
kandidata varijantnih polja bez target scopea, dok je jedan novi, dokazani ordering-option zapis
uveden kao zamjena. Odabrani `Cable length … = 2,5` ostaje. Drugi Ganter fixture je otkrio da se
njegov cilj bira preko radio konfiguratora, ne aktivne thumbnail varijante; reader sada zadržava
`SR → RAL 9006` kao finish, ali iz toga ne izvodi zasebnu `color` vrijednost. Dodani unit testovi
pokrivaju family detekciju, ignoriranje related raila, scoped `1 kg` protiv unscoped `2 kg` i
radio/fieldset option selection.

Završna provjera P1.3g: `tsc` čist, **2163/2163** Vitest, **16/16** eval fixturea / 210
asertacija / 0 kontaminacija; `audit:spec-gate` na 120 offline PDF-ova ostaje **0 SUSPECT**
(4374 → 3969 atributa; 405 odbačenih je već postojeći page-furniture šum), a `audit:labels` ima
A/C/D = 0.

Ostaje drugi stvarni fixture oblik za catalog-in-column komparativnu tablicu. Nema razloga širiti
matrix heuristiku bez takvog detektora.

### ⏳ P2.1 + P1.4 + P2.2a — strogo PDF family evidence, ordering-code legenda i cap po dokazu

`catalog-number.ts` sada ima novi, **odvojeni** API `findCatalogTextMatch`: exact match je
boundary-safe (kraći SKU se ne nalazi unutar dužeg siblinga), a tek onda slijede separator-bound
family kandidati (`GN 422-33-TK → GN 422-33 → GN 422`). Stari tolerantni
`catalogTextMatches` ostaje netaknut, jer ga customer-document fallback namjerno koristi za alias
family dokumente. Kad PDF pipeline ima samo family dokaz, redovi i electrical/mechanical sweepovi
uopće se ne čitaju; ostaju samo shared material/standard/certificate/compliance atributi, označeni
`scope: family, matchLevel: family`. Time family PDF može reći što je stvarno zajedničko, ali ne
može izmisliti targetov weight, dimensions, voltage ili current.

Novi `ordering-code-legend.ts` čita oblik `Position n / CODE = published value`. Jednoznakovni
kod prolazi samo kad je u izvoru deklarirana njegova pozicija u šifri, pa slučajna znamenka iz
drugog dijela kataloškog broja nije dokaz. `document-enrichment.ts` ga koristi za protection prije
postojećeg Eaton fallbacka. Ontology miner više ne gubi tabove prije čitanja vrijednosti: red
`Rated current\t4 A\t8 A\t12 A` sada se odbija dok katalog-čitač ne izabere točnu kolonu. Cache
tehničkih PDF sweepova uključuje katalog, a stacked dimensions row s eksplicitnim drugim catalogom
ne prolazi targetu.

P1.4 sada rangira atribute **prije** `maxRawAttributes`: target-scoped i registry-known specifikacije
ispred strukturiranih tablica/semantike, a široki text/summary zadnji; vezani score zadržava izvorni
redoslijed. P2.2a više ne vraća prvu positioned stranicu: complementarni redovi sa svih matching
stranica se spoje, a različite vrijednosti istog labela se uklanjaju kao dvosmislene.

Novi ciljane testovi pokrivaju family vs sibling-prefix rub, family-only filter, position-bound
legendu, multi-column current silence, pre-cap rangiranje i conservative continuation merge.

### ⏳ P2.2b — row-orijentirane tablice i višejezični tight-context

`pdf-positioned-table.ts` sada ima `extractPositionedOrderingRow`: kada standardni catalog-in-header
put ne pronađe target, grupira `pdfjs-dist` iteme po stvarnim y-redovima, nađe id-header i traži
**exact** model u retku. Zatim vrijednosti veže na x položaj pripadnog headera. To pokriva obrnutu
orijentaciju velikih ordering tablica bez prefix-nagađanja; `ABC-20` se namjerno ne smije spojiti s
`ABC-200`.

`tight-context.ts` više nema vlastite engleske regexe za id-header: i phase 1 (bare continuation
modeli) i jednostavni ordering-table header koriste `catalog-table-vocabulary.ts`. Novi regresijski
test pokriva `Bestell-Nr.` + bare drugi model i potvrđuje da za `ABC-200` izlazi samo `Gewicht: 0.9 kg`.

Nakon promjene: `tsc` čist, 2174/2174 testa, eval 16/16 (210 provjera, 0 kontaminacija),
`audit:spec-gate` 0 SUSPECT (1674 → 1503; 171 postojeći furniture atribut odbačen), te
`audit:labels` A/C/D = 0. Eaton fixture ima 46 umjesto 45 raw atributa: dodatni je strukturno
ograničen tablični nalaz, a svih 18 fixture asercija i contamination gate ostaju zeleni.

### ⏳ P2.4 — dokaz nakon fetch-a, ne samo URL shape

Discovery sada razlikuje prioritet za pokušaj od dokaza da je pokušaj stvarno PDP. Novi
`scoreFetchedDiscoveryEvidence` gleda HTTP odgovor, effective URL i exact SKU na product identity
surfaceu (`title`, `h1`, `og:title` ili Product JSON-LD). Kandidat koji nakon redirecta završi na
search stranici ili ne potvrdi SKU ne ulazi u `parseGenericProductPage`/merge; u quality-attemptima
ostaje jasan razlog odbijanja. Post-fetch score ulazi u confidence i audit attempt umjesto ranijeg
URL-only scorea. Regression test koristi snimljeni Balluff BIC007H PDP fixture i kontrastni search
HTML koji ponavlja SKU, ali nema PDP identitet.

Nakon promjene: `tsc` čist, 2175/2175 testa, eval 16/16 (210 provjera, 0 kontaminacija),
`audit:spec-gate` 0 SUSPECT (1674 → 1503), `audit:labels` A/C/D = 0.

### ⏳ P2.2c — comparison-table header carry-over

`extractPositionedTableRowsFromPdf` sada nosi prethodni header samo kroz neposredno uspješno
mapirane continuation stranice. Header daje isključivo x-stupac targeta, dok se label/y geometrija
uvijek ponovno uzima s trenutačne stranice. Ako sljedeća stranica ne može samostalno pokazati
label-stupac i dati vrijednost, carry se odmah odbacuje — nepovezana kasnija tablica ne može
naslijediti stari target stupac. Regression test koristi stvarne Rockwell x-koordinate: header
`1606-XLE120EL` je na prethodnoj stranici, a continuation ima samo `Rated current` red; rezultat
je isključivo `12 A` iz targetova stupca.

Nakon promjene: `tsc` čist, 2176/2176 testa, eval 16/16 (210 provjera, 0 kontaminacija),
`audit:spec-gate` 0 SUSPECT (1674 → 1503), `audit:labels` A/C/D = 0.

### ⏳ P3.1a — stage observations nisu više write-only

`ScraperDb.listStageObservations` čita ograničenu, newest-first povijest po proizvođaču i opcionalnom
hostu, uključujući status, quality score, broj atributa/dokumenata i grešku. `writeRunDebugBundle`
tu povijest zapisuje uz learned endpoints, pa je evidence iza target-health agregata dostupna za
deterministički replay i dijagnostiku, ne samo za SQL forenziku. DB test pokriva redoslijed i
polja passed/failed zapisa.

Nakon promjene: `tsc` čist, 2179/2179 testa, eval 16/16 (210 provjera, 0 kontaminacija),
`audit:spec-gate` 0 SUSPECT (1662 → 1493), `audit:labels` A/C/D = 0.

### ⏳ P3.2a — kauzalni blocker za svako atributno polje

`FieldHealthRecord` sada zadržava postojeći čitljiv `reason`, ali uz njega dobiva stabilni
`reasonCode`: `no-source-discovered`, `source-fetched-no-label`, `document-not-parsed`,
`scoping-failed`, `label-found-value-rejected` i `conflicting-candidates`. Time UI, Excel i
automatika više ne moraju parsirati opisni tekst kako bi razlikovali nije-nađen-izvor od
neparsiranog PDF-a ili namjerno odbačene vrijednosti. Document URL polja koriste isti model,
a već zaključeni zapis final-completeness audita daje `not-published` prednost općim uzrocima.
Test pokriva prazan rezultat, neuspješno parsiran dokument, dohvaćenu stranicu bez datasheeta,
preslab dokument URL i potvrđeni `not-published`. UI prikaz i run-level agregacija ostaju otvoreni.

Nakon promjene: `tsc` čist, 2181/2181 testa, eval 16/16 (210 provjera, 0 kontaminacija),
`audit:spec-gate` 0 SUSPECT (1662 → 1493), `audit:labels` A/C/D = 0.

### ✅ P1.1b — inline label granice više nisu engleska lista

`matchPropertyPrefix` je stroga, start-of-label inačica ontologije: za razliku od postojećeg
`matchProperty` ne smije prepoznati riječ usred vrijednosti. `page-mining.ts` njime segmentira
kompaktni tekst `Label: value Label: value` na svim jezicima koje ontologija već poznaje. Ako je
sljedeća granica registry-only export polje (npr. `Dimensions`), koristi se postojeći
`matchRegistryFieldLabelPrefix`, također isključivo na početku labele; nije dodana nova engleska
lista.

Test čuva stvarni oblik teksta s `Bemessungsstrom`, `Bemessungsspannung`, `Werkstoff` i
`Schutzart`. Pokušaj da `Dimensions` postane opći `PROPERTY_ONTOLOGY` key namjerno je odbačen:
matcher čita `group + name`, pa je taj aggregate key preoteo SCE-ove osne `Height`/`Width`/`Depth`
atribute i obrisao normalizirane dimenzije. Granica teksta stoga nije isto što i kanonsko fizičko
svojstvo.

Nakon promjene: `tsc` čist, 2182/2182 testa, eval 16/16 (210 provjera, 0 kontaminacija),
`audit:spec-gate` 0 SUSPECT (1662 → 1493), `audit:labels` A/C/D = 0.

### ⏳ P2.2d — dominantno rotirana PDF stranica

`PositionedTextItem` sada nosi kvantiziranu orijentaciju iz `pdfjs-dist` matrice `[a,b,c,d,e,f]`.
Kad je ne-nulta orijentacija dominantna na stranici, `normalizeDominantPageOrientation` cijeli set
sigurno vraća u obični x-desno/y-gore prostor prije header prechecka, tabličnog čitanja i
continuation carry-overa. Test rotira stvarni Rockwell comparison-table oblik za 90° i provjerava
da izlaz ostaje samo targetova težina i dimenzije; testira i 90°/180° transform matrice.

Namjerno se ne normalizira miješana stranica na kojoj je većina teksta horizontalna, a samo nekoliko
headera vertikalno: bez zasebne geometrije za taj podskup to bi spojilo vertikalni header s tuđim
horizontalnim vrijednostima. Taj oblik ostaje otvoren, uz statističku kalibraciju tolerancija.

Nakon promjene: `tsc` čist, 2183/2183 testa, eval 16/16 (210 provjera, 0 kontaminacija),
`audit:spec-gate` 0 SUSPECT (1662 → 1493), `audit:labels` A/C/D = 0.

### ⏳ P2.3a — djelomično skenirani PDF ne gubi tekstualne stranice

`pdfPagesNeedingOcr` označava samo native PDF stranice s premalo čitljivog teksta ili dominantnim
glyph šumom. `readPdfWithOptionalOcr` prima točan skup brojeva stranica i vraća per-page rezultat;
`readPdfPageSet` zamjenjuje samo stranicu čiji OCR prolazi kvalitetu i minimalnu duljinu. Tekstualne
stranice i njihove tablice ostaju native, a neuspješan OCR ne ruši već čitljiv dokument. Test pokriva
selekciju čitljive, prazne i glyph-noisy stranice.

Nakon promjene: `tsc` čist, 2184/2184 testa, eval 16/16 (210 provjera, 0 kontaminacija),
`audit:spec-gate` 0 SUSPECT (1736 → 1536; +43 zadržana atributa iz novih OCR kandidata,
0 normaliziranih SUSPECT/gubitaka), `audit:labels` A/C/D = 0.

### ⏳ P2.3b — OCR jezik iz konteksta, ali nikad iz lažno slične riječi

Za sparse/glyph-noisy stranice `readPdfPageSet` sada iz čitljivih native stranica bira lokalni
Tesseract jezik (`deu`, `fra`, `ita`, `spa`) samo kada postoje dva nezavisna, jezično specifična
tehnička izraza; inače ostaje `eng`. Vanjski i JS OCR put prihvaćaju isti jezik, a nedostajući lokalni
language pack automatski pada natrag na `eng`. `PRODUCT_SCRAPER_OCR_LANGUAGE` je uski operativni A/B
override, ne automatsko vendor pravilo.

Prvi A/B je namjerno zaustavljen: automatski odabir je zbog preširokog francuskog `température` signala
engleski Saginaw manual pročitao kao `fra` i promijenio tri sirova sadržajna retka (`10. Dimensions … p. 8`,
`BCT T = TR`, stilizirani naslov manuala), od kojih su dva preživjela gate. Detaljni audit `--details`
izolirao je jedini dokument; nijedna normalized vrijednost nije izgubljena. Nakon uklanjanja generičkih
riječi poput `temperature` iz jezičnih signala, završni A/B je opet 1736 → 1536 (200 page-furniture
dropova, 0 SUSPECT), a novi test baš zahtijeva da engleski `Operating/Ambient/Internal temperature`
ostane `eng`.

Nakon promjene: `tsc` čist; puni Vitest 2210/2210, eval 16/16 (210 provjera, 0 kontaminacija),
spec-gate 0 SUSPECT (1736 → 1536) i label auditi A/C/D = 0.

### ⏳ P2.3c — OCR bounding boxovi koriste isti strogi tablični dokaz kao native PDF

JS Tesseract sada iz `blocks → paragraphs → lines` čuva samo dovoljno pouzdane retke s bboxom te ih
pretvara u y-up `PositionedTextItem`. `readPdfPageSet` ih nosi isključivo za OCR stranicu koja je već
prošla quality gate, a `document-enrichment` ih predaje postojećem `extractPositionedTableRows` readeru.
Reader mora pronaći baš traženi katalog u jednoj stupčanoj projekciji; nejasan ili višestruk SKU stupac
ne emitira ništa. Zato OCR ne dobiva vlastiti permissive text-sweep i nikad ne može prepisati broj koji
reader nije dokazao. Test zahtijeva koordinatni OCR red, y-orijentaciju i odbacivanje retka confidence 31.

Nakon promjene: `tsc` čist; puni Vitest 2211/2211, eval 16/16 (210 provjera, 0 kontaminacija),
spec-gate 0 SUSPECT (1736 → 1536) i label auditi A/C/D = 0.

### ⏳ P3.2b — uzrok je vidljiv u postojećem run UI-u

`summarizeRunItem` sada uz `Missing Weight` zadržava `Weight: document-not-parsed` (i analogne
reason codeove) u postojećem kompaktnom `coverage.reason`. `App.tsx` taj razlog preferira kad već
zna da je kritično polje prazno, pa korisnik ne mora otvarati debug bundle da bi razlikovao
nema-izvora od neparsiranog dokumenta. Test pokriva prijenos u sažeti payload, onaj koji stvarno
dolazi do run kartice. Prošireni per-field panel i grupirana run-level dijagnostika ostaju otvoreni.

Nakon promjene: `tsc` čist, 2185/2185 testa, eval 16/16 (210 provjera, 0 kontaminacija),
`audit:spec-gate` 0 SUSPECT (1736 → 1536), `audit:labels` A/C/D = 0.

### ⏳ P2.2e — uski PDF SKU stupci ne spajaju susjede

`derivePositionedTableGeometry` iz variant-token x koordinata prvo konzervativno pre-klasterira
stvarno isti stupac (3 pt), zatim iz medijana susjednih stupaca izvodi `columnXTolerance` do
najviše provjerenih 30 pt. `matchColumnForCatalog` i dohvat vrijednosti koriste taj prag, pa
20-pt uski katalog više ne spaja `NARROW-1`/`-2`/`-3` u jednu vrijednost. Test čuva baš taj oblik
i traži isključivo `NARROW-2 → 2 kg`. Geometrija već računa i y skalu, ali ona još nije provedena
kroz sve label/value prozore — nije označena dovršenom.

Nakon promjene: `tsc` čist, 2186/2186 testa, eval 16/16 (210 provjera, 0 kontaminacija),
`audit:spec-gate` 0 SUSPECT (1736 → 1536), `audit:labels` A/C/D = 0.

### ⏳ P2.2f — y prozori više nisu fiksni Rockwell pragovi

Ista `derivePositionedTableGeometry` sada vodi row-header clustering, vertical boundary između
tablica, wrapped-header visinu, label x-margin/toleranciju, value y-prozor, spajanje wrapped
labela i row-oriented ordering tablice. Ako stranica ne daje dovoljno geometrije, postojeći dokazani
pragovi ostaju fallback; inače se sve vrijednosti izvode iz medijana baseline/stupac razmaka na toj
stranici. Time promjena ne proširuje prozore naslijepo na nepoznatom PDF-u.

Nakon promjene: `tsc` čist, 2186/2186 testa, eval 16/16 (210 provjera, 0 kontaminacija),
`audit:spec-gate` 0 SUSPECT (1736 → 1536), `audit:labels` A/C/D = 0.

### ⏳ P2.4b — POST search forme više nisu lažni GET URL-ovi

`discovery.ts` sada modelira form submit kao `{ method, url, body }`: GET zadržava query string, a
`method="post"` šalje stvarni cacheirani `application/x-www-form-urlencoded` POST. `successfulFormFields`
čuva skrivene scope/locale/CSRF vrijednosti, izabrani radio/checkbox i select vrijednosti, preskače
credential/file/submit kontrole te jedino katalog unosi kao novi podatak. Form action izvan službenih
domena odbija se prije fetcha. Search index POST dobiva 24-satni TTL, baš kao GET search URL.

Generički URL fallback sada uključuje `s`, `Ntt`, `k`, `article` i `partNumber`; baze se iteriraju po
parametru (ne obrnuto), pa ograničeni budžet ne potroši sve pokušaje na non-localized origin prije
`/en-us/`. Dva postojeća discovery testa sada traže stvarni POST i točan body (`scope + term`, odnosno
`locale + partNumber`). Ovo nije browser interakcija: JS-only formu bez server-side submit endpointa i
dalje treba riješiti kroz zaseban browser input/Enter put.

Nakon promjene: `tsc` čist; discovery regresijski skup 65/65, eval 16/16 (210 provjera, 0 kontaminacija).

### ⏳ P2.4c — browser stvarno unosi katalog u JS-only search

`BrowserRenderSession.renderSearchPage` prije skupljanja DOM-a i XHR-a poziva
`submitSearchInput`: bira prvi upotrebljiv `input[type=search]` ili semantički `name`/
placeholder/ARIA search input, poziva Playwright `fill(katalog)` i šalje `Enter`. Ako je prvi kontrolni
input skriven ili nepopunjiv, pokušava sljedeći; ako nijedan ne radi, vraća `false` bez lažnog uspjeha i
postojeći statički/API fallback ostaje netaknut. Discovery ga koristi gdje je renderer stvaran, a stari
injektirani renderer u testovima kompatibilno pada na `renderProductPage`.

Nakon promjene: `tsc` čist, browser renderer regresijski skup 16/16, discovery 65/65, eval 16/16 (210
provjera, 0 kontaminacija). Puni spec/label audit ponovno je pokrenut nad neizmijenjenim PDF/HTML
ekstrakcijskim putem; prethodna referentna vrijednost ostaje 0 SUSPECT i A/C/D = 0.

### ⏳ P2.4d — konfigurirani locale homepage postaje stvarni discovery ulaz

`officialUrlBases` i `officialOrigins` sada uz `officialBaseUrls` uključuju i već konfigurirani
`homepageUrl`. Time bare produkt-host može deterministički pokušati stvarni `/en-us/` (ili drugi
konfigurirani locale) search/form entry bez nagađanja nove domene; rezultat s homepage hosta je i dalje
podvrgnut standardnom official-domain guardu. Regression test drži upravo slučaj bare
`https://example.test` + `homepageUrl=https://example.test/en-us/` i zahtijeva
`/en-us/search?q=ABC-123` te njegov PDP rezultat.

Nakon promjene: `tsc` čist, discovery 66/66, eval 16/16 (210 provjera, 0 kontaminacija). Puni Vitest i
spec/label audit ponovno su odrađeni offline; dugotrajni audit proces je završio bez ostavljenih Node
workera, dok terminal ne vraća završni sažetak nakon svojeg 30-s timeouta.

### ⏳ P3.2c — dijagnostika nije više samo sirovi JSON

`RunItemDrawer` sada iznad debug sekcija ima otvoreni **What happened** panel. On sažima sva
ne-found field stanja s njihovim stabilnim `reasonCode`, preskočene/neuspjele dokumente, odbijene
discovery linkove i page-mining signale. Sirovi evidence/diagnostic JSON ostaje ispod za forenziku;
sažetak ne skriva podatak niti uvodi novu heuristiku, nego iz postojećeg payload-a prikazuje odgovor na
“gdje smo gledali i zašto nije objavljeno”.

Nakon promjene: `tsc` čist; ciljane P3.2/P2.4 regresije 87/87; eval i offline auditi ponovno su pokrenuti
na neizmijenjenom ekstrakcijskom putu.

### ⏳ P3.1b — naučeni JSON endpoint može stvarno proći replay

`learnEndpointFromNetworkFetch` već uči službeni catalog-confirmed JSON/API URL, a
`parseGenericProductPage` već zna top-level JSON. Između njih je postojala rupa: post-fetch PDP gate
priznavao je samo HTML `title`/`h1`/OG/JSON-LD i odbijao svaki naučeni JSON prije parsiranja. Gate sada
prihvaća JSON samo kada isti objekt ima **exact SKU u identity ključu** (`sku`, `mpn`, catalog/product/
part/model varijante) i barem jedan product-shape ključ (`name`, `description`, `material`,
`specifications`, …). Search response koji samo ehoira query nije dokaz i ostaje odbijen.

Nakon promjene: `tsc` čist; discovery + learned-endpoint regresije 75/75. Puni offline niz ponovno je
pokrenut bez mreže.

### ⏳ P3.1c — naučeni endpoint ne smije trajno trošiti pokušaje

`learned_endpoints` sada pamti `failureCount` i `lastFailureAt`. Kada naučeni kandidat triput ne
dovede do catalog-confirmed dokaza, `learnedEndpointSuppressed` ga isključuje iz replaya sedam dana;
sljedeći potvrđeni uspjeh ga pri upsertu automatski resetira. Neuspjeli mrežni dohvat sam po sebi ne
broji se kao negativno učenje — broji se samo dohvat koji je prošao do evidence gatea, ali nije dokazao
katalog. Time transientni timeout ne truje recept.

### ⏳ P3.3a — tri arbitra koriste isti default povjerenja izvora

Novi leaf `evidence-score.ts` daje usporedivih 0..1 za official, official-fallback, generated, cache i
distributor evidence te umjereno prilagođava rezultat vrsti dokaza (PDF/API/catalog-variant/meta) i
eksplicitnoj extractor confidence vrijednosti. `attributeEvidenceScore`, `sourcePriority` i
`repairAttributeScore` sada ga svi koriste kao bazu; njihove lokalne semantičke kazne ostaju lokalne
(npr. packaging weight i reader fallback). Customer-document override je namjerna zasebna politika i
ostaje iznad automatizirane skale.

Nakon promjene: `tsc` čist; 243 ciljane normalizer/final-completeness/field-candidate regresije prolaze.

### ⏳ P3.1d — target health se može oporaviti nakon popravljenog vendor sajta

`target_health` zadržava svoj agregat kao povijesni write-model, ali `getTargetHealth` za adaptivne
odluke sada računa uspjeh, kvalitetu i prosjeke iz najnovijih 50 `stage_observations`. Time pedeset
starih 404-ova više ne može nadjačati pedeset novijih uspješnih dohvaćanja. Test namjerno zapisuje baš
taj slijed i zahtijeva 50 uzoraka / 100 % recentnog uspjeha / bez drifta.

Nakon promjene: `tsc` čist; ciljane DB i mission-control regresije 9/9 prolaze.

### ⏳ P3.3b — pobjednik konflikta više ne preskače normalizer

`applyFieldCandidateResolution` je prije upisivao `selectedValue` ravno u `normalized[]`, mimo
istog validatora koji koristi ostatak pipelinea. Sada izabrani label/value prolazi kroz
`normalizeFields` i upisuje se samo ako se normalizer složi. Regresija počinje sa stvarnim raw
oblikom `24 VDC` i zahtijeva kanonski `24 V DC`; time source arbitration i value validation više
ne mogu proizvesti dva različita formata za istu činjenicu.

Nakon promjene: `tsc` čist; field-candidate/normalizer/evidence regresije 216/216 prolaze.

### ⏳ P3.1e — learned extractor sada pamti mali, stvarni CSS recipe

Kad semantički tablični sweep uspješno izvuče vrijednost iz stabilnog `tr#id` ili `tr.class`, signal
`css:table-row:…` se sprema u postojeći `learned_extractors` store. Pri idućem dohvatu miner taj
strogo ograničen recipe replaya **prije** generičkog sweeepa; samo su `tr` s jednim ID-em ili najviše
dvije CSS klase dopušteni, a svaka vrijednost i dalje prolazi isti usefulness gate. Nevažeći/stari
selektor se bez nagađanja preskoči i ostavlja konzervativni fallback. Test razlikuje `Learned Table`
od običnog `Mined Table` i zahtijeva `replayed:` signal.

### ⏳ P3.3c — nerazriješen konflikt sada košta confidence, ali samo jednom

`applyFieldCandidateResolution` zbraja različite vrijednosti po polju i snizuje confidence za 0,02 po
konfliktu, najviše 0,15. `ScrapeDiagnostics.confidencePenalty` čuva najveći već primijenjeni odbitak,
pa ponavljanje resolution faze ne može beskonačno kažnjavati isti podatak. Test pokriva i pad
0,72 → 0,70 i drugi, idempotentan prolaz.

Nakon promjene: `tsc` čist; page-mining/field-candidate/evidence ciljane regresije 43/43 prolaze.

### ⏳ P3.3d — zajednička skala sada vraća i imenovani tier dokaza

`evidence-score.ts` više ne skriva provenance iza samog broja: `evidenceTier` razlikuje
`official-document`, `official-page`, `official-fallback`, `generated`, `cache` i `distributor`.
`evidenceConfidence` iz tog istog tier-a izvodi postojeću bazu (službeni PDF ostaje 0,92, službena
stranica 0,82), pa promjena ne daje konektorima novu vendor-specifičnu prednost niti dopušta
eksplicitnoj confidence vrijednosti da preskoči izvor. Regresija zahtijeva naziv tier-a uz postojeće
score testove.

Nakon promjene: `tsc` čist; puni Vitest 2207/2207, eval 16/16 (210 provjera, 0 kontaminacija),
spec-gate 0 SUSPECT i label auditi A/C/D = 0.

### ✅ P3.3e — confidence audit prolazi stvarne izlaze konektora

Novi `evidence-audit.ts` ne parsira tekst koda, nego za svaki `AttributeRecord`, dokument i
`SourceRecord` iz spremljenog `run_items.raw_json` izvodi isti `evidenceTier`/`evidenceConfidence`
put koji koriste arbitri. `npm run audit:confidence` uzima najnovijih deset rezultata po
proizvođaču (110 stvarnih rezultata, 15.410 činjenica u ovom korpusu), izlistava tier i provenance
po konektoru, te ruši audit za URL bez izvora ili raw confidence izvan 0..1.

Prvi prolaz je stvarno našao devet povijesnih Siemens BT datasheet dokumenata: imali su URL, ali
`sourceType`/parser nisu bili na samom dokumentu, a `sourceUrl` je pokazivao na drugi pview URL.
`siemensMallStockNumberResult` i preflightani `siemensBuildingTechnologiesDatasheet` sada nose
vlastiti official datasheet URL, parser i provenance, pa ih novi rezultat svrstava u
`official-document`. Regresija to provjerava bez mreže. Devet već zapisanih povijesnih redaka audit
i dalje prikazuje kao dokaz otkrivene greške; cache se namjerno ne prepisuje niti se stari rezultat
lažno proglašava čistim.

Nakon promjene: `tsc` čist; puni Vitest **2216/2216**, eval **16/16** (210 provjera, 0
kontaminacija), spec-gate **0 SUSPECT** (1736 → 1536; 200 već klasificiranih furniture vrijednosti)
i label audit A/C/D = 0.

### ⏳ P3.5a — lokalni model smije predložiti samo ontology mapiranje

Novi `llm-label-proposals.ts` je zaseban, po defaultu ugašen (`PRODUCT_SCRAPER_LLM_LABEL_PROPOSALS=1`
ga eksplicitno uključuje) lokalni Ollama batch. Prima samo već postojećih `unmappedSpecLabels` teach-list
(oznaku, broj pojavljivanja i kratke primjere), a model smije vratiti isključivo točnu ulaznu oznaku i
jedan od već postojećih `PROPERTY_ONTOLOGY` ključeva. Nevažeći ključ, nepoznata oznaka ili duplikat se
odbacuju. Rezultat se dopisuje u `Unmapped Labels` Excel tab kao “Local AI Proposed Key (review only)”
i rationale; ni alias, ni regex, ni parser, ni vrijednost se ne mijenjaju. Čovjek mora potvrditi stvarni
alias/regex u kodu i dodati fixture prije nego idući run može išta koristiti.

Nakon promjene: `tsc` čist; puni Vitest 2209/2209, eval 16/16 (210 provjera, 0 kontaminacija),
spec-gate 0 SUSPECT i label auditi A/C/D = 0.

### ⏳ P3.4a — jedan slučajni uspjeh više ne otključava recipe

`testManufacturerDraft` testira najviše prva tri uzorka, odbija manje od tri i traži najmanje dva
prošla official identity-confirmed proizvoda prije nego vrati `passed`. UI je usklađen: Test samples
gumb se aktivira tek s tri šifre, a opis i save poruka jasno kažu 2/3 kriterij. Čisti unit test pokriva
prag 3→2 i odbijanje undersized uzorka.

Nakon promjene: `tsc` čist; manufacturer-wizard + run-manager ciljani skup 43/43 prolazi.

### ⏳ P3.2d — uzrok je vidljiv i na razini cijelog runa

Item summary sada uz postojeće countove zadržava mapu `reasonCodes`, bez slanja cijelog raw result
payload-a. Novi shared `summarizeRunDiagnostics` agregira te stabilne uzroke, document failures/skips i
discovery rejectione preko svih itema. Dashboardov otvorivi **Run blockers** panel prikazuje dominantni
uzrok (`document-not-parsed`, `no-source-discovered`, …) i operativne ukupne vrijednosti; nema nove
heuristike, samo čitljiv read-model postojećih činjenica.

Nakon promjene: `tsc` čist; run-diagnostics i run-item-summary ciljane regresije 6/6 prolaze.

### ⏳ P3.4b — potvrđeni wizard uzorak ostavlja reproducibilan trag

Nakon official identity-confirmed uzorka wizard ponovno dohvaća baš potvrđeni PDP i zapisuje
`page.html` + `case.json` u `_manufacturer-wizard-test/fixtures/<catalog>/`. Curated repo fixture
korpus se namjerno ne dira: ovo je dokaz i polazište za korisnikovu potvrdu recipeja, ne nova ground
truth asercija. Capture je odbijen ako HTML više ne sadrži exact katalog, a I/O greška ne poništava
već valjani scrape. Preview pokazuje punu putanju spremljenog fixturea.

Nakon promjene: `tsc` čist; manufacturer-wizard ciljane regresije 3/3 prolaze.

### ⏳ P3.4c — wizard predlaže, ali ne uči bez čovjeka

Neoznate oznake iz final quality gatea prolaze kroz postojeći alias-similarity indeks samo ako imaju
score ≥ 0,75. Preview ih pokazuje kao `label → canonicalKey`, s najbližom postojećom oznakom i
postotkom podudarnosti. Prijedlog nije mutation: ne upisuje alias, ne mijenja atribut ni konfiguraciju
proizvođača. Tako operator može potvrditi terminologiju bez da jedan slučajni PDP kontaminira ontologiju.
Test pokriva tipfeler `Nominal Voltge → ratedVoltage` i deduplikaciju; nepovezani `Mystery field` ne
prelazi prag.

Nakon promjene: `tsc` čist; manufacturer-wizard ciljane regresije 4/4 prolaze.

### ⏳ P2.1d — contact-rating tablica ne smije prijeći sa siblinga

`extractContactRatingAttributes` više ne tretira svaki `Contact Rating` naslov u PDF kontekstu kao
vlasništvo traženog artikla. Ako lokalni prozor uz naslov nosi catalogue-shaped kod koji nije exact ili
family match za naš katalog, čitač šuti. Brojčane ćelije i običan tekst (`0.4`, `Plug-in`) namjerno se
ne tretiraju kao oznake proizvoda. Time single-product/family sheet bez suparničkog koda i dalje daje
objavljene contact ratinge, dok `REL-200-B` tablica ne može napuniti `REL-100-A`.

Nakon promjene: `tsc` čist; full Vitest 2202/2202; eval 16/16 (210, 0 contamination); spec-gate 120
dokumenata, 0 SUSPECT; label audit A/C/D = 0.

### ⏳ P3.4d — wizard test koristi i vlastiti datasheet dokaz

Wizard je ranije contextu vraćao `downloadStatus: skipped`, pa je odobravanje novog proizvođača moglo
testirati samo PDP HTML. Sada `downloadWizardDocument` preuzima do osam enrichable službenih dokumenata
u `_manufacturer-wizard-test/documents`, koristi candidate URL-ove kao fallback i predaje rezultat
`enrichResultFromDownloadedDocuments` — potpuno isti PDF parser/gate koji vidi regularni run. Asseti i
CAD se ne povlače, a nedostupan dokument daje transparentan `failed` status umjesto rušenja validnog
PDP testa. Unit test pokriva stvarni datasheet download i deterministički naziv datoteke.

Nakon promjene: `tsc` čist; full Vitest 2203/2203; eval 16/16 (210, 0 contamination); spec-gate 120
dokumenata, 0 SUSPECT; label audit A/C/D = 0.

### ⏳ P3.4e — operator potvrđuje label, a test se mora ponoviti

Svaki wizardov prijedlog sada ima `Use mapping`. Klik upisuje isključivo raw label → postojeći
`matchedLabel` u draftov `scrapeRecipe.extractionPolicy.labelAliases`; taj je format već sanitiziran,
per-manufacturer i koristi ga generic extraction choke point. Ne sprema se canonical key izravno niti
se mutira globalna ontologija. Klik odmah poništava raniji 2/3 rezultat, pa izmijenjeni recept mora
proći nova tri uzorka prije Save. Ostaje selector-review: naučeni extractor može nastati tijekom testa,
ali wizard još nema zaseban UI za eksplicitno prihvaćanje/odbacivanje pojedinog selektora.

Nakon promjene: `tsc` čist; full Vitest 2203/2203; eval 16/16 (210, 0 contamination); spec-gate 120
dokumenata, 0 SUSPECT; label audit A/C/D = 0.

### ⏳ P3.4f — learned selector se predlaže, pa tek onda eksplicitno sprema

Wizard test više ne zove DB `upsert` za mined signal. Umjesto toga skuplja samo recipeje koje
`page-mining` zaista zna replayati i koji su došli iz identity-confirmed uzorka: `css:table-row:tr#id`
ili `tr.class[.class]`. Preview operatoru
prikaže pattern i službeni host, a `Use recipe` ga samo označi za naredni Save — tako novi, nedovršeni
wizard ne ostavlja orphan learning zapis. Pri Saveu API ponovno provjerava da je proizvođač već spremljen,
da recipe pripada njemu, da je izvor HTTPS na njegovu službenom hostu te da host odgovara source URL-u;
tek tada ide `upsertLearnedExtractor`. Ostali mining signali, proizvoljni CSS, Jina/proxy URL-ovi i
JSON-path nagađanja ovim tokom ne prolaze. Regularni dokazani runovi i dalje koriste postojeći automatski
learning put.

Nakon promjene: `tsc` čist; page-mining + manufacturer-wizard ciljane regresije 18/18 prolaze.

### ⏳ P2.4e — hreflang početna stranica je stvarni lokalizirani discovery ulaz

Kad se obrazac za pretragu ne nalazi na konfiguriranom `homepageUrl`, discovery sada iz njegove HTML
`hreflang` deklaracije uzima najviše dvije dodatne, službene lokalizirane početne stranice. Tek ondje
ponovno otkriva stvarni form control i šalje isti GET/POST zahtjev; ne pretvara alternativu u izmišljeni
URL niti slijedi obične linkove. Regresija zahtijeva `/en/ → hreflang /de/ → POST` s očuvanim
`locale=de` kontrolnim poljem i nastalim PDP kandidatom.

Nakon promjene: `tsc` čist; puni Vitest 2212/2212, eval 16/16 (210 provjera, 0 kontaminacija),
spec-gate 0 SUSPECT (1736 → 1536), label auditi A/C/D = 0. Offline discovery replay: PDP #1 22 %, top-3
25 %, nađen 41 % (raniji zabilježeni baseline 20 % / 25 % / 40 %); to je relativna, ne apsolutna metrika.

### ⏳ P3.1f — naučeni JSON nije signal, nego mali reproducibilan ulaz

Kad `mineEmbeddedJson` iz stabilnog `script#id` zaista emitira koristan atribut, zapisuje samo recept
`json:script:#id`. Idući run smije replayati jedino taj ID (ne proizvoljan CSS selektor ni slobodni
JSONPath), kroz potpuno isti JSON parser, usefulness gate i dedupe kao generički sweep. Ako script više
nema koristan podatak, nema `replayed:` signala ni izmišljene vrijednosti. Test traži `script#product-payload`
za `Rated current = 6 A` te odbija `json:script:script[data-anything]`.

Nakon promjene: `tsc` čist; puni Vitest 2213/2213, eval 16/16 (210 provjera, 0 kontaminacija),
spec-gate 0 SUSPECT (1736 → 1536) i label auditi A/C/D = 0.

### ⏳ P3.4g — operator može odobriti samo replayable JSON script recept

Wizardov `Use recipe` više nije semantički pogrešno nazvan “table” kad sample proizvede dokazani
`json:script:#id`. Server pri spremanju prihvaća samo taj `json-path` format ili postojeći strogi
`css:table-row` format, zatim opet provjerava manufacturer, HTTPS službeni host i podudaranje hosta.
`json:script:script[data-anything]` i svaki slobodni JSONPath ostaju odbijeni. Odobrenje ne sprema
vrijednost niti parser pravilo — samo adresu već deterministički čitljivog script-a.

Nakon promjene: `tsc` čist; puni Vitest 2213/2213, eval 16/16 (210 provjera, 0 kontaminacija),
spec-gate 0 SUSPECT (1736 → 1536) i label auditi A/C/D = 0.

### ⏳ P2.3d — stvarni offline skenovi potvrđuju quality gate, ali još nisu tablični fixture

Jednokratni read-only prolaz kroz 92 jedinstvena PDF-a iz `benchmarks/output` našao je 11 dokumenata
s barem jednom sparse native stranicom. Provjereni `P-P11R2-K3RF0-U450` scan (cutout drawing s listom
part-numbera) daje 52 mean OCR confidence i zato ga quality gate opravdano odbija; `800-um001` naslovnica
ima 36 i također se ne propušta. `BCS01CY` skenirani odjeljak ima čitljiv naslov, ali nema spec tablicu.
Nijedan pronađeni kandidat nije dokazani “naš SKU u OCR tablici”, pa nije promoviran u fixture niti su
pragovi labavljeni. P2.3 zato ostaje otvoren samo za baš taj stvarni tablični primjer.

### ⏳ P3.5b — LLM prijedlog ima ljudski review trag, ali nema write-back

`Unmapped Labels` Excel sheet sada uz postojeći deterministic i lokalni-AI prijedlog nosi prazne
stupce `Reviewer Decision (never applied automatically)`, `Reviewed By`, `Evidence URL / fixture` i
`Review Note`. Odluka je ograničena na `approve`, `reject` ili `needs-evidence`, pa se u workbooku
može prepoznati da je “approve” bez izvora nedovršen review. Najvažnija granica je namjerna: exporter
nikad ne čita workbook natrag, pa čak ni approve ne može dodati alias, promijeniti vrijednost ili
utjecati na idući scrape. Stvarni alias i dalje zahtijeva zasebnu promjenu izvornog koda i fixture.

Nakon promjene: `tsc` čist; puni Vitest **2217/2217**, eval **16/16** (210 provjera, 0 kontaminacija),
spec-gate **0 SUSPECT** (1736 → 1536) i label audit A/C/D = 0.

### ✅ P3.5c — PDF layout prijedlog je ograničen na deterministic reader i stranice

Novi `llm-pdf-layout-proposals.ts` je zaseban lokalni Ollama batch, po defaultu ugašen
(`PRODUCT_SCRAPER_LLM_PDF_LAYOUT_PROPOSALS=1`). Prima samo bounded tekstualne uzorke već poznatih
dokumenata i može vratiti samo jedan postojeći reader (`positioned-table`, `ordering-code-legend`,
`ocr-bbox`, `native-text` ili `no-action`) te jedinstvene stranice unutar stvarnog broja stranica.
Nepoznati dokument, izmišljeni reader, nebrojčana/out-of-range stranica i duplikat se odbacuju;
vrijednost, labela, selector, regex, parser-kod, alias i runtime konfiguracija uopće nisu dio izlaznog
tipa. `npm run review:pdf-layouts -- --input <json>` ispisuje samo review JSON: ne čita/piše bazu,
recept, fixture ni scraper rezultat. Ljudski reviewer i dalje mora pokrenuti predloženi deterministic
reader, proći isti evidence gate i dodati source-backed fixture prije ikakve promjene ekstrakcije.

Regresija dokazuje da je modul ugašen bez poziva modela te da iz modelovog miješanog odgovora ostaje
samo poznati dokument, dopušten reader i bounded stranice — bez “value” ili “selector” write-backa.
Nakon promjene: `tsc` čist; puni Vitest **2233/2233**, eval **18/18** (226 provjera, 0 kontaminacija),
spec-gate **0 SUSPECT / 0 garbage** (1731 → 1534) i label audit A/C/D/E = 0.

### ⏳ P1.3k — cijeli offline HTML cache nema četvrti span-oblik za koji bi se smjelo pisati pravilo

Read-only pregled svih **3062** cacheiranih HTML PDP-ova s uspješnog `run_item` puta našao je **191**
stranicu s najmanje četiri `colspan`/`rowspan` oznake. Svih 191 je Ganter; pripadaju već pokrivenim
GN 3310, GN 422 i GN 6284 konfiguratorima (najviše 64 span oznake i osam tablica). Nijedan drugi vendor
u ovom offline korpusu nema taj strukturni signal. Zato nije izvađen lažni “novi” fixture niti je dodana
heuristika bez detektora: sljedeće širenje P1.3 treba novi snimljeni PDP s drugačijim oblikom, ne još jednu
varijantu istog Ganter HTML-a.

### ⏳ P3.1h — povijesni mining signal ne smije potisnuti izvršivi recipe

Read-only pregled `stage_observations`/`learned_extractors` našao je stvarne stare SCE zapise poput
`embedded-json`, `catalog-neighborhood` i `text-pairs`: bili su korisni kao opažanje, ali nisu recipe
koji `minePage` može replayati. Iako novi upisi već odbacuju takve signale, `listLearnedExtractors(..., 8)`
ih je još učitavao prije valjanog recepta te su mogli ispuniti limit i u dijagnostici izgledati kao da je
učen osam puta upotrebljiv ekstraktor.

`page-intelligence.ts` sada iz ograničenog prozora od 40 povijesnih zapisa zadržava samo postojeću strogu
`isPersistableLearnedPattern` gramatiku, pa tek onda ograničava replay na osam. Regresija simulira osam
starih no-op zapisa ispred valjanog `css:table-row` recipeja i zahtijeva da se učita, replaya i u
dijagnostici prikaže kao jedini stvarno učitani recipe. Stari DB redovi ostaju sačuvani kao povijesni dokaz;
ne brišu se niti se mijenja rezultat scrapea bez ponovno dokazanog deterministic readera.

Nakon promjene: `tsc` čist; puni Vitest **2234/2234**, eval **18/18** (226 provjera, 0 kontaminacija),
spec-gate **1731 → 1534**, **0 SUSPECT / 0 garbage**, label audit A/C/D/E = 0.

### ⏳ P3.1j — offline learning store još nema dokazani PDF recipe

Read-only pregled stvarnog `learned_extractors` storea nalazi samo šest povijesnih SCE redova:
četiri nereplayable mining signala (`data-attributes`, `text-pairs`, `catalog-neighborhood`,
`embedded-json`) i dva `document-pattern` opažanja (`lazy-images`, `text-urls`). Nema nijednog
positioned/OCR/PDF table recipeja, niti dva identity-confirmed uzorka iz kojih bi wizard mogao
sigurno predložiti takav recipe. Postojeći P3.1h filter zato ostaje točan: povijesni redovi su
dijagnostički dokaz, ne izvršiva konfiguracija. Nije dodan “generički PDF recipe” niti proširen
approval whitelist bez target-bound tabličnog fixturea; sljedeći P3.1 korak mora krenuti od stvarnog
ponovljivog PDF oblika.

### ⏳ P2.4k — novi discovery replay je donja granica, ne razlog za labaviji PDP gate

Read-only `audit:discovery -- --limit 40` nad 15.235 cache URL-ova daje 47 hitova i **665 cache
promašaja**: poznati PDP je #1 za 11/40 (27,5 %), u top-3 za 13/40 (32,5 %) i među kandidatima za
16/40 (40 %). Preostali primjeri su uglavnom službene locale/redirect varijante (`balluff.com`
en-us/en-gb, `eaton.com` no/gb, Fath24/fath.com), search URL-ovi bez dokaznog PDP sadržaja ili Ganter
special-request link bez traženog PDP-a u cacheu. To potvrđuje granicu alata: offline replay je korisna
relativna regresijska metrika, ali ne može postati “fix” koji URL-oblik ili drugi locale proglasi
identitetom bez post-fetch exact-SKU dokaza.

### ⏳ P2.1h — cijeli rep velikih PDF-ova dao je samo family legendu, ne target fixture

Read-only prolaz kroz sve stranice svih **19** jedinstvenih PDF-ova većih od 1 MB tražio je istu strogu
trojku: ordering/configuration heading, deklariranu poziciju i `CODE = value` red. Tri pogotka svode se
na dvije kopije Rockwell `800F-X10` Bulletina i već odbijeni E-T-A `3120-F…` dokument. Ručno čitanje
Rockwell kandidata pokazuje mnogo ispravnih `800FP`/`800FC` ordering legenda, ali `800F-X10` je zaseban
contact-block dio u drugoj tablici; nema deklariranu poziciju ni legendu vezanu baš uz njegov SKU.
To je family-publikacija s tuđim configuratorima, ne dokaz za generičko dekodiranje targeta. Nije dodan
fixture ni decoder: sljedeći P2.1 primjer mora i sam nositi target ordering string i njegov eksplicitni
position-bound code/value dokaz.

### ✅ P0.1c — pomoćni fixture/audit pozivi ne smiju imati mutirajući `--help`

`fixtures:extract`, `audit:page-attrs` i `audit:discovery` prije nisu svi prepoznavali `--help`; prvi je zato mogao protumačiti
istraživački poziv kao normalan default extraction i tiho napraviti prazne fixture direktorije. Sada oba
fixture alata, HTML audit i discovery replay vraćaju usage i izlaze prije otvaranja baze/HTML-a ili cachea;
`audit:discovery --help` više ne pokreće višeminutni replay samo da bi ispisao pomoć. Provjera uspoređuje popis fixture direktorija
prije i poslije `--help`. Time value-level eval ostaje jedini autoritet: fixture bez ručno pročitanog
`expected.json` i dalje daje nula checkova i ruši eval exit-code, nikad se ne promiče iz `actual.json`.

Nakon zadnje promjene: `tsc` čist; puni Vitest **2244/2244**, eval **24/24** (281 provjera, 0 kontaminacija),
spec-gate **1650 → 1471**, **0 SUSPECT / 0 garbage**, label audit A/C/D/E = 0.

### ⏳ P1.1d — text-only ontology gap više nije nevidljiv, ali metadata nije teach-list

`findUnmappedSpecLabels` je prije zahtijevao barem jednu parsiranu količinu, pa je kratka stvarna
specifikacija poput `Contact metallurgy = Silver alloy` nestajala iz dijagnostike samo zato što nema
jedinicu. Sada `ScrapeDiagnostics.unmappedSpecLabels` nosi review-only `{ label, valueKind }`, gdje
je `valueKind` `quantity` ili `text`; quality gate, wizard i Excel ga samo prenose do čovjeka, nikad
ne dodjeljuju polje ni ne mijenjaju vrijednost. Excelov `Unmapped Labels` list prikazuje kind uz
primjer vrijednosti, pa reviewer zna postoji li unit-based trag ili čisto terminološki gap.

Prvi audit je namjerno zaustavio preširoko rješenje: samo micanje quantity filtra iz tri povijesna
runa izvuklo je 201 različitu oznaku, uključujući `og:title`, cijene, katalog stranice i PDF upute.
Text put zato prihvaća samo kratku vrijednost iz jasno tehničkog/specifikacijskog/tabličnog/construction
konteksta i odbija Meta/search/legacy/presentation grupe, URL-ove i poznate commerce/document labele.
Postojeći numeric audit ostaje isti; primjer stvarnog `Construction Detail = 0.104 In. carbon steel.`
ostaje vidljiv. Regresija pokriva text oznaku kroz `finalizeQualityGate` do dijagnostike i eksplicitno
zahtijeva da ne postane normalizirano polje.

### ✅ P1.1e — review suggestion nije više šum ni tuđi vendor alias

`suggestTechnicalAttributeAlias` je ranije kao prijedlog vraćao najbolji rezultat već za score
veći od nule, pa je `Mystery field` dobio `ratedVoltage` s besmislenih 0,325. Za review je to
i dalje šum koji čovjeka navodi na pogrešan posao. Sada je prag 0,75, a kandidat pool bez
manufacturer konteksta sadrži samo globalne alias-e; s kontekstom sadrži globalne i alias-e baš
tog proizvođača. `ElectricalAliasManufacturerId` je otvoreni string, pa novi vendor ne zahtijeva
promjenu zatvorene TypeScript unije da bi dobio vlastiti reviewed alias. Excel i wizard predaju
svoj manufacturer ID; nijedan prijedlog nije automatsko mapiranje. Regresija traži da `Mystery field`
šuti, dok `Rated uninterrupted current Iu` prolazi samo pod Eaton kontekstom.

### ⏳ P2.2g — row-oriented reader više nema fiksnih 5 pt za y-retke

`extractPositionedOrderingRow` je nakon uvođenja `derivePositionedTableGeometry` još imao jedan
zaostali Rockwell-prag: `clusterItemsByY(..., 5)`. Na gustoj stranici gdje header glyphovi variraju 1 pt,
a prvi data-red počinje 3 pt niže, takav prag je prvi katalog upisao u header cluster i reader je šutio.
Sada koristi isti measured `headerRowYTolerance` kao ostatak positioned enginea: jitter unutar retka
ostaje dopušten, ali zasebni kompaktni retci ne kolabiraju. Regresija traži točno
`ABC-100 → Rated current = 4 A`; prethodni kod vraća `undefined`.

Nakon promjene: `tsc` čist; puni Vitest **2235/2235**, eval **18/18** (226 provjera, 0 kontaminacija),
spec-gate **1731 → 1534**, **0 SUSPECT / 0 garbage**, label audit A/C/D/E = 0.

### ⏳ P1.3h — comparison tablica sada bira točan katalog-stupac

Čitač je već znao da se traženi puni katalog pojavljuje u headeru usporedne tablice, ali tu informaciju
nije primjenjivao: fallback je emitirao `Color = Red | Black` i time spajao target i sibling varijantu.
Nova regresija pokriva stvarni oblik “svojstvo po retku, katalog po stupcu” i zahtijeva samo `Red` i
`24 V DC` za `ABC-100`, bez `Black`/`230 AC`. `html-table-reader.ts` sada taj put aktivira samo uz
jedan točan header katalog, uzima samo njegov stupac i označava tablicu handled, pa legacy flattening
ne može ponovno spojiti siblinge.

Nakon promjene: `tsc` čist; puni Vitest **2217/2217**, eval **16/16** (210 provjera, 0 kontaminacija),
spec-gate **0 SUSPECT** (1736 → 1536) i label audit A/C/D = 0.

### ⏳ P3.1g — learned extractor sprema samo reproducibilne obrasce

`learned_extractors` je prije primao svaki mining signal, primjerice generički `key-value-table`, iako
replay zna izvršiti samo strogi `css:table-row:tr…` ili `json:script:#id` recept. Takav zapis je izgledao
kao naučena sposobnost, a idući run ga nije mogao upotrijebiti. `isPersistableLearnedPattern` sada
propušta samo te replayable recepte te četiri namjerna `capped:*` hintova za ograničavanje minerova
budžeta. Test wizard-review puta dokazuje da se CSS recipe predlaže, a obični `key-value-table` više ne
ulazi u trajni store.

Nakon promjene: `tsc` čist; puni Vitest **2217/2217**, eval **16/16** (210 provjera, 0 kontaminacija),
spec-gate **0 SUSPECT** (1736 → 1536) i label audit A/C/D = 0.

### ⏳ P3.4h — wizard razlikuje opaženi od reproduciranog recipeja

Identity-confirmed sample i dalje prikazuje svaki strogi mined recipe kao dokaz, ali ga operator više ne
može označiti za spremanje samo zato što se pojavio na jednoj PDP stranici. `confirmedLearnedExtractorSuggestions`
grupira host/kind/pattern i nudi gumb tek kada ga nose dva različita identity-confirmed kataloška uzorka
iz istog 3-sample wizard testa. Time slučajni page furniture ostaje pregledan, ali ne postaje trajno
ponašanje scrappera. Test pokriva i pozitivni 2/3 slučaj i dva različita single-sample recipeja koji moraju
ostati nenudivi.

Nakon promjene: `tsc` čist; puni Vitest **2218/2218**, eval **16/16** (210 provjera, 0 kontaminacija),
spec-gate **0 SUSPECT** (1736 → 1536) i label audit A/C/D = 0.

### ⏳ P1.3i — stvarni colspan fixture ne prodaje label kao vrijednost

`fixtures:extract -- --list` je potvrdio 3.048 cacheiranih PDP-ova, a `audit:page-attrs` na Ganteru je
pokazao stvarnu kašu: `B10d value = B10d value | 20 000 000 | …` i slične retke. Iz cachea je zato
izvučen novi, value-verified `gan-GN-3310-19-LK-K2-page`, ne sintetički primjer. Ručno čitanje njegove
službene HTML tablice potvrđuje da red `Category of use (button)` ima samo AC/DC vrijednosti i IEC normu;
prije popravka je izlaz bio `Category of use (button) | AC 15…`. Fixture prvo pada na toj kontaminaciji.

Uzrok je span-matrica: jedan `MatrixCell` objekt namjerno se ponovi na svakoj koordinati svog `colspan`a,
ali row reader je te ponovljene reference ponovno tretirao kao podatke. Sada među vrijednosti ne ulazi
samo objekt početne label-ćelije; različite ćelije i dalje ostaju. Time Ganter `B10d value` ostaje kao
`20 000 000 | as per DIN EN 13849-1`, a `Degree of soiling` kao `3 | as per DIN EN 61010-1`, bez eho
labela.

Obavezni A/B na postojećem `gan-GN-6284-180-T-1-KU-2-5-page` dao je 47 → 43 atributa. Dva promijenjena
retka nisu gubitak nego iste dvije očišćene vrijednosti gore. Četiri neto uklonjena retka su: (1)
`Approvals, conformity declarations CE marking` — labela bez vrijednosti; (2) `LED connection Type RGB`
— labela bez vrijednosti; (3) `Switching paths diagram (schematic)` — labela bez vrijednosti; (4)
`Category of use` — family-scopeani miks plug/cable napona bez dokaza da pripada traženoj varijanti.
Zadnji se namjerno ne zadržava, jer bi vraćao tuđi voltage/current. `TRACE_CANONICALIZATION=1` nije dao
`CANON-SKIP` (nije canonicalization promjena); s `DISABLE_SPEC_GATE=1` isti fixture naraste na 163 sirova
atributa i pada na kontaminaciji `2,5 5`, što potvrđuje da gate, a ne ovaj span popravak, zadržava
preostali page-furniture/sibling šum.

Nakon promjene: `tsc` čist; puni Vitest **2218/2218**, eval **17/17** (216 provjera, 0 kontaminacija),
spec-gate **0 SUSPECT** (1736 → 1536) i label audit A/C/D = 0.

### ⏳ P2.1e — stvarni ordering-code kandidat odbijen prije heuristike

Read-only sken 92 jedinstvena offline PDF-a našao je E-T-A `3120-F521-P7T1-W01D-16A` datasheet s
objavljenim code tablicama. Ručno čitanje pokazuje da dokument istovremeno opisuje različite gramatike
`3120-F…`, `X3120-A…`, `X3120-U…` i dodatne module; literalni target token `W01D` ne odgovara retku
`D01X = 1 push button black opaque`. To nije dokaz za “obrni/pogodi substring” pravilo, nego upravo
kontraprimjer: takav decoder bi lako pripisao opciju drugom modelu ili modulu. Kandidat zato nije
promoviran u fixture i kod nije promijenjen. Sljedeći P2.1 fixture mora imati eksplicitno objavljeni
target token ili position-bound segment, ne samo vizualno sličan niz znakova.

### ⏳ P2.1f — mali offline PDF korpus nema dokaz za širi ordering-code decoder

Prethodni široki scan je imao mnogo ponovljenih dokumenata i nekoliko velikih PDF-ova koji su presporo
parsali za interaktivnu provjeru. Zato je odvojeno pregledano svih 73 jedinstvena dokumenta ispod 1 MB,
uz postupni rezultat po dokumentu. Nijedan nije istodobno imao eksplicitni ordering-code naslov, deklariranu
poziciju/znak i čitljiv `CODE = published value` red; sedam oštećenih/nečitljivih PDF-a je evidentirano kao
greška čitanja, ne kao negativan dokaz. Zajedno s odbijenim E-T-A kandidatom to znači da trenutačni corpus
još ne legitimira novu legend-heuristiku ili fixture. Generic reader ostaje ograničen na već dokazanu gramatiku.

### ⏳ P2.1g — veći PDF-ovi također nisu brza legenda-fixture

Read-only nastavak je grupirao offline `benchmarks/output` po imenu i veličini i pročitao prvih 20
stranica svih **19** jedinstvenih PDF-ova većih od 1 MB. Strogi kandidat je morao u istom tekstu imati
ordering/type/configuration-code heading, deklariranu poziciju/znak i čitljiv `CODE = value` red.
Nijedan od 19 nije imao sva tri uvjeta. To nije negativan dokaz za stranice nakon 20. ili za rasterizirane
legende, nego kalibrirana odluka da se iz ovog signala ne izrađuje lažna fixture ni šira heuristika.

### ⏳ P2.4b — širi discovery replay je mjerilo donje granice, ne lažni cache "fix"

Offline replay nad 120 raspoređenih stvarno pronađenih artikala dao je 27 hit@1, 30 hit@3 i 51 URL-hit
(42,5 %), bez praznog candidate skupa; koristio je 132 cache hiteva i 1.581 cache promašaj. To je samo
donja granica, ne stopa stvarnog discoveryja. Primjer Fath `6SACP3J316B.2000` pokazuje zašto: ground-truth
PDP je službeni URL, ali jedini sačuvani odgovor za njega je opcionalni `r.jina.ai/...` reader-cache URL,
kojega offline `CachedHttpClient` namjerno ne predstavlja kao službenu mrežnu rutu. Njegov `search` rezultat
zato nije dokaz scraper-defekta niti razlog da se reader sadržaj proglasi PDP-om. Za P2.4 ostaje samo novi
snimitak izravnog službenog search → PDP toka; bez njega se ne kalibrira heuristika niti se ova donja granica
prikazuje kao apsolutni postotak.

### ✅ P2.4c — službeni search redirect je dokazani PDP URL

Isti replay/corpus ipak je imao jedan izravni dokaz koji nije reader-cache: Fathov službeni
`/en/search?search=6SAME4J316B.4000` je u `page_cache` zabilježen s `effectiveUrl` baš na
`/en/Main-Power-Cable-GST18i3-for-Module-F-Line/6SAME4J316B.4000`. Discovery je prije ignorirao taj
redirect jer je search URL bio pogrešno upisan kao `localizedUrlTemplate`, pa ga se nikada nije dohvaćalo;
ostavljao je `/search?...` kao kandidat. Sada se svaki search-oblik localized/fallback templatea vodi kroz
pravi search put, a 2xx redirect na dopušteni službeni **ne-search** URL s exact katalogom postaje PDP kandidat.
Login, kategorija, drugi search i family URL bez exact SKU-a ne prolaze. Regresijski test prvo je padao na
odsutnom PDP-u, a sada čuva stvarni Fathov configuration shape. `audit:discovery --vendor fath --limit 40`
zato ide s 0/40 na 1/40 pronađeni PDP (rank #4; viši su lokalizirane iste SKU varijante), uz 1 cache hit;
to je strogo lokalni replay gain, ne apsolutna stopa. Puna provjera: `tsc` čist; Vitest **2219/2219**; eval
**17/17**, 216 provjera, 0 kontaminacija; spec-gate **0 SUSPECT** (1736 → 1536); label auditi A/C/D = 0.

### ⏳ P3.4i — recipe approval provjerava dokaz na serveru, ne samo u UI-u

`Use recipe` je ranije bio ograničen u React UI-u, ali direktni POST na learned-extractors endpoint mogao
je preskočiti rezultat wizard testa. Server sada nakon testa drži samo 30 minuta njegov rezultat, vezan uz
manufacturer ID i skup službenih hostova. Approval zahtijeva uspješan 3-sample test, najmanje dva službena
identity-confirmed proizvoda i točno isti host/kind/pattern u `confirmedSelectorSuggestions`; u suprotnom
ne zapisuje ništa. Ciljani test pokriva odbijanje bez validaције i uspjeh samo s reproduciranim recipejem.

Nakon promjene: `tsc` čist; puni Vitest **2218/2218**, eval **17/17** (216 provjera, 0 kontaminacija),
spec-gate **0 SUSPECT** (1736 → 1536) i label audit A/C/D = 0.

### ⏳ P3.1h — potvrđeni PDP URL postaje naučeni runtime predložak

`learnEndpointFromNetworkFetch` se prije pozivao za browser/search API odgovore, ali običan službeni PDP
koji je discovery dohvatio i quality-gate potvrdio nije ostavljao svoj `{part}` URL template. Zato je
sljedeći katalog istog proizvođača opet prolazio široki discovery, unatoč upravo dokazanom putu. Nakon
svakog prolaza stvarnog quality-gatea deterministic pipeline predaje dohvaćeni PDP istom strogom helperu:
host mora biti službeni, tijelo mora sadržati exact katalog, URL mora biti templateabilan i endpoint mora
proći postojeće size/content provjere. Ne uspije li bilo koji uvjet, ne sprema se ništa. Regresija kreće od
službene search stranice, nalazi PDP i zahtijeva upis samo `https://example.test/catalog/detail.aspx?ugly=true&id={part}`.

Nakon promjene: `tsc` čist; puni Vitest **2218/2218**, eval **17/17** (216 provjera, 0 kontaminacija),
spec-gate **0 SUSPECT** (1736 → 1536) i label audit A/C/D = 0.

### ⏳ P3.1i — learned HTML tablica pamti provjerljiv header-stupac, ne sirovi red

`page-mining.ts` je uz postojeći CSS-red sweep još uvijek mogao iz comparison tablice spojiti target i
sibling u `24 DC | 230 AC`. Novi recipe je strogo `html-table:header-column:table#id-or-class:encoded-header`:
selektor smije biti samo generatorov stabilni `table#id` ili najviše dvije klase, a encoded header se mora
točno vratiti kroz `cleanText`. Replay ne izvršava slobodni CSS niti uzima spremljenu vrijednost; poziva
`html-table-reader.ts`, provjeri da tablica još nosi taj header i ponovno bira točan katalog kroz
colspan/rowspan matricu. Kad reader obradi tablicu, sirovi `tr` sweep je preskače, pa se točna varijanta
ne može ponovno zalijepiti sa siblingom. Regresija zahtijeva samo `230 V AC` za `SKU-B`, bez `24 DC`, i
provjerava i learned signal i wizard proposal.

Nakon promjene: `tsc` čist; puni Vitest **2220/2220**, eval **17/17** (216 provjera, 0 kontaminacija),
spec-gate **0 SUSPECT** (1736 → 1536) i label audit A/C/D = 0.

### ⏳ P3.4j — wizard ne smije predložiti recipe koji server nikad ne može spremiti

P3.1i je već proizvodio strogi matrix HTML recipe, ali server-side wizard whitelist je prihvaćao samo
CSS red i JSON script. To bi operatoru pokazalo valjan, dvaput reproduciran dokaz, a zatim ga odbilo na
spremanju. `manufacturer-wizard.ts` sada dopušta isti mali
`html-table:header-column:table#id-or-class:encoded-header` format: table je samo stabilni ID ili do
dvije klase, header mora se sigurnosno percent-dekodirati bez promjene whitespacea, a slobodni CSS i
`capped:*` hintovi ostaju zabranjeni. I dalje vrijede službeni HTTPS host, isti host, 3 samplea i najmanje
2 official identity-confirmed reprodukcije. Regresija pokriva valjano spremanje i odbijanje
`table[data-anything]`.

Nakon promjene: `tsc` čist; puni Vitest **2220/2220**, eval **17/17** (216 provjera, 0 kontaminacija),
spec-gate **0 SUSPECT** (1736 → 1536) i label audit A/C/D = 0.

## 1. Što je DOBRO (ne dirati, na tome graditi)

Ovo nije loš sustav — arhitektura je zdrava, problem je u nekoliko slojeva odluka.

- **Deterministički princip i "refuse to guess"** su stvarno implementirani, ne samo napisani:
  `tight-context.ts:294-300` ("Silence beats a wrong value"), `pdf-positioned-table.ts:214-228`
  (naš token u >1 x-klasteru → odbij), `isCleanSingleSpecValue` (`document-enrichment.ts:1066`),
  normalizer-level backstop za spojene mjere. To je najvrjedniji dio kulture koda.
- **`pdf-positioned-table.ts`** — pozicijski x/y čitač je jedini strukturno pouzdan tablični
  parser i **već je generaliziran** s Rockwellovog literala na multijezični anchor
  (`candidateHeaderAnchors:148` + `catalog-table-vocabulary.ts`). To je pravi temelj.
- **`ontology.ts`** — 98 kanonskih svojstava, ~1400 regexa, EN/DE/FR/IT/ES/NL/HR + dio PL/ZH,
  longest-match arbitracija (`matchProperty:2124`), memoizacija. Kvalitetno i multijezično.
- **`quantity.ts`** — °F→°C, raspone, `230/400 V` → alternative, ± tolerancije, `at 40 °C`
  kao condition, sanity bounds. Vrijednosna strana je bolja od većine komercijalnih alata.
- **Dijagnostika po dubini** — `ScrapeDiagnostics` (`shared/types.ts:277-301`) i 30 Excel
  sheetova (`excel.ts:37-66`), uključujući **Unmapped Labels** s predlaganjem aliasa. Podaci
  za učenje postoje; problem je što ih nitko ne troši (v. §5).
- **`exhausted_fields`** — najbolje dizajnirani store: 45-dnevni TTL, cause-aware (transient
  failure ne truje), zatvorena petlja (`db.ts:16/759`, `run-manager.ts:747-764`).
- **`quality-gate.test.ts`** (1295 linija) ima ~10 testova eksplicitno naslovljenih
  *"for unseen manufacturers"* — obrazac koji treba proširiti, ne izmišljati iznova.

---

## 2. Što NE VALJA — po fazama

### 2A. Discovery: nalaženje prave stranice na novom sajtu

| Problem | Dokaz | Zašto boli |
| --- | --- | --- |
| **Scoring gleda oblik URL-a, ne dokaz** | `scoreDiscoveryCandidate:262-284`. Sintetizirani `{origin}/products/{part}` dobije 40+30+35+15+10 = **100 (clamp)**, dok pravi search hit ima 58 baze, a config template maks 82 (`:293-314`) | nagađanja istisnu stvarne nalaze iz budžeta od 12 kandidata (`deterministic-pipeline.ts:34`). Nijedan signal nije post-fetch (status, `<title>`, JSON-LD `@type:Product`) |
| **POST search se tiho pretvori u GET** | forma s `method="post"` se prihvati (`discovery.ts:409`) i onda serializira u query string (`:427-428`); `fetchDiscoveryText` je GET-only (`:601`) | proizvede uvjerljiv ali pogrešan URL — gore od odustajanja |
| **Nikad se ne piše u search box** | `browser-renderer.ts` nema `fill`/`type` ni na jednom inputu; rendered discovery samo re-navigira već pale GET URL-ove (`discovery.ts:168-215`) | komentar na `discovery.ts:160-163` tvrdi da "type it into their search box" radi. Ne radi. Ovo je jedan mehanizam koji rješava POST + JS + nepoznat param naziv |
| **Nagađa se 6 imena parametra** | `genericOfficialSearchTemplates:330-349` → `q,query,search,text,keyword,searchTerm` | nema `s` (WordPress — postoji u wizardu `manufacturer-wizard.ts:378`, ali **ne** u runtimeu), `Ntt` (Endeca), `/catalogsearch/result/?q=` (Magento), `k`, `article`, `partNumber` |
| **Nema PDP-vs-family/kategorija detektora za HTML** | `isUnresolvedSearchResultPage:268-285` hvata samo *search* stranice. `scoreProductLink:203` penalizira `cart/login/support`, ali ne `category/range/series/family/overview` | family stranica prođe identity check preko substring title matcha (`quality-gate.ts:180-195`) → dobiješ podatke pogrešne (roditeljske) razine. `looksLikeMultiVariantFamilyPage` postoji **samo za PDF** |
| **Sibling-prefix kolizija je ostala vendor-lokalna** | fix je u `rockwell.ts`, ne u `catalog-number.ts:53-73` (substring match) | svaki novi vendor s prefiksnim šiframa (`XLB90E` ⊂ `XLB90EH`) ponovno nasjeda |
| **Locale ulaz** | `localePathPrefix:351-358` dodaje locale samo ako ga config već ima; `homepageUrl` discovery **nikad ne čita**; `buildLocalizedProductUrls` za nepoznat id vrati `{}` (`localized-urls.ts:50+`) | bare `https://vendor.com` nikad ne proba `/en/`, `/en-us/`, `/de/` |
| **Discovery se izvrši dvaput** | `discovery-fallback.ts:40` i `deterministic-pipeline.ts:31`; drugi poziv **bez** timeouta (prvi ima 60 s race na `:15`) | worst case po katalogu: 18 search fetcheva + 4 probe + 10 form URL-ova + 4 rendera + 12 fetcheva stranica, ×2 |
| **Vendor hardcode u "generic" putu** | `link-discovery.ts:199` (schmersal), `:223-229` (balluff), `generic.ts:189-200` (siemens), `:275` (abb partcommunity), `smart-fallback.ts:327` (abb) | novi vendor dobije *drugačije* ponašanje bez ikakve konfiguracijske površine |

### 2B. Razumijevanje stranice

| Problem | Dokaz | Zašto boli |
| --- | --- | --- |
| **Engleski gate ispred multijezične ontologije** (nalaz #3) | `generic.ts:2573`, `:2398`, `:1523`; `page-mining.ts:47` | **najveći coverage cliff u sustavu.** DE/FR/IT div-grid ili JSON stranica izgubi sve osim sirovog `<tr>`/`<dl>` |
| **3–4 divergentna label sustava, bez izvora istine** | `FIELD_LABEL_PATTERNS` 12 ključeva (`normalizer.ts:43-203`) · `FIELD_REGISTRY` 16 (`field-registry.ts:41`) · `PROPERTY_ONTOLOGY` 98 (`ontology.ts:38`) · `TECHNICAL_ATTRIBUTE_ALIASES` 223→19 (`technical-attribute-aliases.ts:315`). Most su ručno tipkani stringovi u `normalizer.ts:333/337/338` | kA-guard je već dupliciran **4×** (`:435`, `:459`, `:485-490`, `:581-586`) — peti put će se zaboraviti. `registryFieldValue("operatingTemperatureMin")` je tihi no-op. `buildFieldHealth` prijavljuje 16 polja, engine razumije 98 |
| **Neprepoznata labela se tiho briše** | `technical-attributes.ts:36` — `if (!property) return []` | nema brojača, nema loga |
| **…i nije ni prijavljena ako nije numerička** | `findUnmappedSpecLabels` (`ontology.ts:2303,2312-2313`) traži da vrijednost parsira kao quantity | točno one labele koje **nemaju** unit-inference fallback (material, connection type, mounting, output type) su i **nevidljive teach-listi**. Ontologija je zato strukturno osuđena kaskati za stvarnošću |
| **Fallback bez sinonima pokriva 6 od 98 svojstava** | `UNIT_INFERENCE_RULES` (`ontology.ts:2185-2243`) | V/A/W/Hz/°C-range/kg. Sve nenumeričko: nula fallbacka |
| **Attribute budget se puni prije nego dođe do DOM-a** | embedded-JSON putevi emitiraju 300 (`generic.ts:1126`) + 250 (`:1577`) + 250 (`:1619`) prije nego `tr`/`dt`/`li,p` ekstraktori dodaju na `:375-432`; cap 600 na `:501-504` | na Next/Nuxt vendoru prava spec tablica bude odrezana prije `normalizeFields` |
| **HTML tablice nemaju semantiku** | nema colspan/rowspan, nema kolonske orijentacije, nema multi-row headera; sirovi `tr` loop (`:375-400`) slijepi N-stupčani red u `cell0 : rest.join(" | ")` | isti problem koji je na PDF strani zahtijevao cijeli `pdf-positioned-table.ts`. Na HTML strani nije rješen |
| **Strukturirana vrijednost se izgubi za polja koja se izvoze** | `normalizeFields` koristi ručne regex normalizatore (`normalizer.ts:981/959/1117/1123`), ne `understand()`/`ParsedQuantity` | rasponi/tolerancije/alternative koje `quantity.ts` uspješno parsira nikad ne dođu u `products.xlsx` |
| **Naivni `,`→`.` u dimenzijama** | `normalizer.ts:1003, 1016, 1040, 1055, 1062` | `1,200 mm` → `1.2 mm`. Ista greška koja je za weight već ispravljena preko `normalizeNumberSeparators` |
| **Nema enum modela** | `CanonicalProperty` (`ontology.ts:16-34`) nema `enum` polje | nema kontroliranog vokabulara za connection type / mounting / output type; `pdt/enum-encode.ts` je predaleko nizvodno |
| **Footnote markeri se čiste samo na PDF putu** | HTML: `normalizeElectricalValue:1103` skida `\s+\d+\)` samo ako slijedi `IEC|EN|UL|CSA` | `16 A 1)` preživi; `¹`/`*`/`†` nigdje |
| **`aria`, shadow DOM, iframe** | shadow/iframe capture postoji samo u `browser-renderer.ts`, dakle tek nakon eskalacije gate-a | statični parse ih nikad ne vidi |

### 2C. Datasheetovi i veliki family PDF-ovi

| Problem | Dokaz | Zašto boli |
| --- | --- | --- |
| **Page targeting je mrtav kod za < 8 MB** (nalaz #1) | `document-enrichment.ts:987-988` vs `:996`; `:32` | 200-stranični walk, catalog page gate, ±1 susjed, technical-page scoring (`:1264-1336`) — sve neiskorišteno u tipičnom slučaju |
| **Truncation od 250 k znakova je head-first, bez dijagnostike** | `:1205`, `MAX_PDF_TEXT_CHARS:21` | u velikom katalogu se sekcija našeg proizvoda može odrezati; ništa ne razlikuje "nema ga u dokumentu" od "odrezan" |
| **Scoping failure → cijeli dokument** (nalaz #4) | `:811` `?? text` | nema "unscoped ⇒ ne emitiraj ništa, samo dijagnostiku" moda |
| **Nema family-prefix / option-suffix matchanja** | `catalog-number.ts:53`, `:98`; `isBoundarySafeFallbackMatch` (`pdf-positioned-table.ts:178`) dopušta samo čisto numerički ostatak | `GN 422-33-TK` vs red `GN 422` nikad ne scopira |
| **Nema generičkog čitanja ordering-code kompozicije** | jedina implementacija je `inferEatonRapidLink512CatalogRows` (`:1881-1976`) — hardcoded `^CDVRL\d{5}$`, fiksni offseti 48/144/168/10000. Jedini legend reader je `protectionFromModelLegend` (`:2038`) | mehanički / norm-dio vendori (Ganter tip) i konfigurabilni pogoni su strukturno nepokriveni |
| **`electrical-spec-miner.ts` je potpuno catalog-blind** | `mineSpecDefinitions:510` uzme labelu + 220 znakova (`:529`); `compositeQuantityValue:609` **spoji** alternative u `"4 A / 8 A / 12 A"` (`:623`) | aktivno miješa varijante; `looksLikeMultiColumnDataRow` guard koji postoji na `:1517`/`:1531` ovdje nije primijenjen |
| **Cache ključevi nisu catalog-unique** | `documentTextCacheKey:788` = `url\|length\|first120\|last120`; `catalogOrderingCacheKey:1855` = `url\|lineCount\|firstLine\|lastLine` | dva kataloga s iste stranice mogu dobiti **tuđe** atribute; nijedan downstream guard to ne može detektirati |
| **`extractStackedDimensionTableRows` nema nikakvu catalog provjeru** | `:2319` | bilo koji numerički red pod dimension headerom postane kandidat, za svaku varijantu |
| **`extractContactRatingAttributes` bezuslovno spoji 8 vrijednosti** | `:2788`, `:2826`, `:2834` | nula scopinga |
| **Pozicijski čitač: single-page, first-match, rotation-blind** | vrati prvu stranicu koja matcha (`pdf-positioned-table.ts:386-388`); `findLabeledColumnValue` uzme prvu labelu (`:249-260`); čita samo `transform[4]/[5]` (`:384`, `:419`) | rotirani headeri nemogući; continuation stranice bez ponovljenog headera se ne nose (compliance matrix to **već zna** — `pdf-compliance-matrix.ts:156-173`); dvije tablice jedna uz drugu se spoje u jedan y-klaster (`:153`) |
| **Row-orientirana velika ordering tablica nema pozicijski čitač** | samo whitespace heuristika (`:2191`) i ≤30-stranični vector grid (`:588`) | spojene ćelije u toj orijentaciji — norma u 150-straničnim katalozima — strukturno nerješive |
| **OCR: nema quality gate, nema jezika, ne radi na djelomično skeniranim** | trigger je `< 80` znakova (`:1007`); `tesseract.js` hardcoded `eng` (`pdf-ocr.ts:137`) | tekstualna korica + skenirane spec stranice → nikad ne OCR-a. OCR izlaz nema tabove pa `splitPdfTableCells:2254` padne na 2+-space branch i tablični sloj umre |
| **`tight-context.ts` phase 1 je engleski literal** | `/^catalog\s*number$/i` na `:230`; `isSimpleCatalogTableHeaderRow:162` isto | `Bestell-Nr.` / `Référence` tablica dobije samo slabiji phase 2. **I: `tight-context.ts` ne importa `catalog-table-vocabulary.ts`** — drift koji je taj modul trebao ukinuti još postoji |
| **Kalibracija je Rockwell-specifična** | `LINE_WINDOW_AFTER_DEFAULT=30` (`tight-context.ts:26`), lookback 25 (`:147`) i 20 (`:2244`), `COLUMN_X_TOLERANCE=30`/`VALUE_Y_WINDOW=10`/`HEADER_WRAP_MAX_HEIGHT=100` (`pdf-positioned-table.ts:44/60/49`), `HEADER_MIN_X=100` (`pdf-compliance-matrix.ts:23`) | ~90 % *puteva* je vendor-neutralno, ali dva mehanizma koja stvarno brane od kontaminacije su kalibrirana na jedan dokument |
| **HTML-viewer detekcija je ABB-only** | `document-viewer-resolver.ts:24-27` | svaki drugi viewer wrapper padne kao "failed download" (`run-manager.ts:1682`) |

### 2D. Učenje, gating, evaluacija

| Problem | Dokaz |
| --- | --- |
| **`stage_observations` je write-only tablica** | `db.ts:195/239/595` — DDL, index, INSERT. Nula SELECT-ova u cijelom repou. Neograničeno raste |
| **`learned_extractors` ne uči ništa prenosivo** | `pattern` je jedno od ~15 fiksnih imena signala (`page-mining.ts:183-406`), ne selektor/JSON path; jedini efekt replaya je množenje capa (`:34-38`) |
| **`learnedExtractors`/`targetHealth` ne dođu u retry passeve** | proslijeđeni samo na `run-manager.ts:417`; `:561` i `:670` ih izostavljaju → `recordTargetObservation` je no-op točno na attemptima koji najviše govore |
| **Drift je nedostupan novom vendoru i nikad se ne oporavi za starog** | `sampleCount >= 8` (`mission-control.ts:37`); `target_health` su kumulativne sume **bez windowinga** (`db.ts:637-643`) |
| **Ništa se ne nauči o URL obrascu sajta** | nema upisa search templatea koji je uspio, ni PDP path shapea. `endpointTemplateFromUrl` — točno pravi alat — koristi se **samo u wizardu** (`manufacturer-wizard.ts:68`) |
| **Nema negativnog učenja** | template koji 404-a na 500 uzastopnih dijelova retryira se vječno |
| **Tri nekomparabilne confidence skale, s obrnutim defaultom** | `attributeEvidenceScore` (`normalizer.ts:723`): undefined sourceType = **320/srednje**; `sourcePriority` (`field-candidates.ts:211`): undefined = **100/najniže**; `repairAttributeScore` (`final-completeness.ts:674`) treća skala |
| **Sirova vrijednost upisana u `normalized[]` bez validacije** | `applyFieldCandidateResolution` (`field-candidates.ts:34-39`); guard postoji samo za numeričke (`:122-153`) — `material/finish/color/protection/certificates` nezaštićeni |
| **Customer-doc override može postaviti `found` bez re-gatea** | `customer-documents.ts:323-360` (confidence 0.97) pozvan na `run-manager.ts:820` bez `finalizeQualityGate` → preskoči identity, official-source i required-field |
| **Gate mjeri prisutnost, ne ispravnost** | `quality-gate.ts:84`; `conflictCount` (`field-candidates.ts:101`) se zabilježi ali **ne** snižava score/status |
| **Nema per-field uzroka izvan 11 final-completeness polja** | `FieldHealthRecord.reason` je konstanta `"No source-backed value was found."` (`field-registry.ts:213`) — ne razlikuje "nije nađen datasheet" / "PDF parsiran ali prazan" / "labela nađena, vrijednost odbijena guardom" |
| **Najbolja dijagnostika ne dođe do UI-a** | `summarizeRunItem` izračuna `fieldHealth`/`documentProcessing`/`discovery`/`pageMining` (`run-item-summary.ts:53-56`), `App.tsx` renderira samo `criticalMissing`/`reason`/`qualityMissing` (`:4049/4102/4103`). `rejectedLinks` s razlozima — odgovor na "zašto nismo našli stranicu" — nikad se ne prikaže |
| **Benchmark je mrežni i tvrdi samo prisutnost** | `scripts/benchmark.ts:207/215` živi `connector.scrape`; `matchesNormalizedFields` = `Boolean(result.normalized[field])` (`:462`) → **tiha korupcija vrijednosti je po konstrukciji nevidljiva** |
| **Nula snimljenih HTML fixtura u testovima** | `scripts/abb-*.html` su orphani (ništa ih ne importa); `tests/pdf-parse-patches.test.ts:17` čita iz **gitignoranog** `benchmarks/output/` → pada na svježem cloneu |
| **`mission-control.ts` i `target-health.ts` nemaju NIJEDAN test** | jedini self-monitoring sustava, nula pokrivenosti |

---

## 3. Plan — što dodati / promijeniti

Redoslijed je namjeran: **P0 prvo mjeri, onda popravlja bugove, onda mijenja strukturu.**
Bez §3.1 se ništa dalje ne može dokazati.

### P0.1 — Offline record/replay eval (PREDUVJET ZA SVE OSTALO)

Bez ovoga svaka izmjena parsera je nagađanje: benchmark treba 14 živih sajtova, a nijedan
test ne koristi snimljen HTML.

- **Novi modul `src/server/scrapers/http-recorder.ts`**: `CachedHttpClient` wrapper s
  `PRODUCT_SCRAPER_RECORD_FIXTURES=1` (snimi) i `..._REPLAY_FIXTURES=1` (vrati sa diska, mreža
  zabranjena → fail ako se traži nesnimljeni URL). Ključ = normalizirani URL.
- **Korpus `fixtures/<vendor>/<catalog>/`**: `pages/*.html`, `docs/*.pdf`, `expected.json`.
  Krenuti s **8–10 slučajeva koji su nas već ugrizli** (Rockwell 1606-td002 family, Ganter
  standard sheet, Doepke prodext, Siemens BT pview, ABB viewer, nVent, Eaton CDVRL, jedan
  DE-only sajt, jedan skenirani PDF). Velike PDF-ove ne commitati sirove — držati
  `pages/*.txt` + `positioned-items.json` gdje je dovoljno.
- **`expected.json` tvrdi VRIJEDNOSTI, ne prisutnost**: `{"weight": "1.5 kg", "dimensions":
  "120 x 80 x 60 mm", "mustNotContain": ["1500 kg", "4 A / 8 A / 12 A"]}`. `mustNotContain`
  je ključan — hvata kontaminaciju, klasu bugova koju cijela memorija projekta dokumentira.
- **`npm run eval`** → offline, brz, u CI-u. Postojeći `npm run benchmark` ostaje kao živi
  smoke test.
- Popraviti `tests/pdf-parse-patches.test.ts:17` (pokazuje u gitignorani folder).

**Effort:** 2–3 dana. **Rizik:** nizak (novi kod, ništa se ne mijenja u pipelineu).
**Bez ovoga ne raditi P1/P2.**

### P0.2 — Šest bugova s malim diffom i velikim učinkom

1. **`readPdfText` order** (`document-enrichment.ts:986-1014`): probaj targeted **prvo**,
   cache po `(fajl, catalogNumber)` a ne po fajlu; ili keširaj **per-page** tekst pa targeted
   walk radi iz cachea. Ovo sam otključava page gating za svaki datasheet.
2. **Sitemap gate** (`discovery.ts:227`): premjesti sitemap blok **prije** `officialVariantUrls`
   (`:217`) i gate-aj na *"nijedan kandidat ne nosi potvrđen dokaz"* umjesto na broj kandidata.
   Dodati `.xml.gz` (gunzip) — danas tiho vraća nulu.
3. **Proslijedi `learnedExtractors` + `targetHealth`** u oba `runDeterministicScrapePipeline`
   poziva (`run-manager.ts:561-591`, `:670-700`) i u wizard (`manufacturer-wizard.ts:237-252`).
   ~6 linija; otključava replay, per-host učenje i drift.
4. **Catalog number u cache ključeve**: `documentTextCacheKey:788` i
   `catalogOrderingCacheKey:1855`. Latentni cross-catalog leak.
5. **Dimenzije: `normalizeNumberSeparators`** umjesto `replace(",", ".")` na
   `normalizer.ts:1003, 1016, 1040, 1055, 1062`.
6. **Truncation dijagnostika**: kad `MAX_PDF_TEXT_CHARS` odreže, emitiraj
   `DocumentProcessingDiagnostic{reason:"text-truncated", pageCount}`. Trenutno je nevidljivo.

**Effort:** 1–2 dana ukupno. **Rizik:** #1 i #2 mijenjaju ponašanje široko → obavezno kroz `npm run eval` + benchmark.

### P1.1 — Razumijevanje: ontologija postaje ulazna vrata, ne izlazna

Ovo je najveći coverage win za nepoznat sajt.

- **Zamijeni engleske admission gate-ove semantičkim testom.** `isUsefulSpecLabel`
  (`generic.ts:2573`), `isLikelySpecContainer` (`:2398`), `isUsefulDynamicKey` (`:1523`),
  `KNOWN_INLINE_LABELS` (`page-mining.ts:47`) → jedna nova funkcija u ontologiji:
  ```ts
  // ontology.ts
  export function looksLikeUnderstandableSpec(label: string, value?: string): boolean
  // matchProperty(label) || matchTechnicalAttributeAlias(label)
  //   || inferPropertyFromQuantities(label, value) || labelValueShapeHeuristic(label, value)
  ```
  Zadrži length cap (`:2578`, ima realan razlog — regex crash) i navigation/nav-like guardove.
  `isLikelySpecContainer` dodatno: prihvati kontejner ako **sadrži ≥2 para koja ontologija
  razumije**, neovisno o class imenu — struktura je jači signal od engleskog imena classa.
- **Neprepoznata labela se NE briše.** `technical-attributes.ts:36` → emitiraj
  `TechnicalAttributeRecord{matchType:"unmapped", property:undefined}` (ili paralelnu listu),
  s brojačem u dijagnostici.
- **`findUnmappedSpecLabels` bez quantity filtera** (`ontology.ts:2303, 2312-2313`) — pusti i
  nenumeričke labele u teach-listu, s oznakom `valueKind:"text"`. To su upravo one koje
  nemaju fallback.
- **Prag na `suggestTechnicalAttributeAlias`** (`technical-attribute-aliases.ts:401` vraća
  bilo koji `score > 0`) + vendor filter. Trenutno predlaže šum s istom težinom kao dobar match.
- **Otvori `TechnicalAttributeManufacturerScope`** (`technical-attribute-aliases.ts:3` je
  zatvorena unija 5 vendora) na `string` — novi vendor danas traži promjenu tipa.

**Effort:** 3–4 dana. **Rizik:** srednji — širi ekstrakciju, može uvesti šum. Eval s
`mustNotContain` je zaštita. Mjeri: broj atributa po stranici prije/poslije + Unmapped Labels rate.

### P1.2 — Jedan izvor istine za labele

- `FIELD_REGISTRY` entry dobije `ontologyKey?: CanonicalPropertyKey`; `FIELD_LABEL_PATTERNS`
  se **derivira** iz ontology sinonima za mapirane ključeve (zadrži ručne dodatke kao override
  listu, ne kao paralelni sustav).
- **kA/Ui guard na jedno mjesto**: jedan `isDangerousQualifier(label, unitKind)` u ontologiji,
  pozvan iz sva 4 puta (`normalizer.ts:435, 459, 485-490, 581-586`) — danas 4 kopije.
- **Unit-kind cross-check pri dodjeli**: `registryFieldValue`/`ontologyFieldValue` moraju
  provjeriti da `ParsedQuantity.kind` odgovara polju, a ne se oslanjati samo na blocklistu
  labela. `kV` u `voltage` treba pasti aritmetički, ne po imenu labele.
- **`registryFieldValue` tihi no-op**: `operatingTemperatureMin/Max` su legalni `keyof
  NormalizedProductFields` bez registry entryja → dodaj compile-time exhaustiveness check.
- **Novi audit `scripts/audit-label-systems.ts`**: prijavi svaki ontology ključ bez registry
  entryja, svaki registry ključ bez ontology ključa, i svaki `FIELD_LABEL_PATTERNS` regex koji
  ontologija ne poznaje. Uveži u `npm run audit:pdt`.

**Effort:** 3–4 dana. **Rizik:** srednji-visok (`normalizer.ts` in-degree 29) → strogo uz eval.

### P1.3 — HTML tablice dobiju semantiku (port PDF pameti na HTML)

Isti problem, već riješen na PDF strani; HTML strana ga ima nerješenog.

- **Novi `src/server/scrapers/html-table-reader.ts`**: colspan/rowspan ekspanzija →
  pravokutna matrica → detekcija orijentacije (spec-per-row vs spec-per-column) → multi-row
  header merge → units-in-header → **variant-column rekonstrukcija za naš katalog**
  (isti princip kao `buildVariantColumnContext`, ali nad DOM-om gdje su granice ćelija
  eksplicitne, pa je *lakše* i pouzdanije od PDF-a).
- Zamijeni sirovi `tr` loop (`generic.ts:375-400`) — `cell0 : rest.join(" | ")` je izvor
  cross-model kontaminacije na webu.
- **Refuse-to-guess**: naš katalog u >1 stupcu → ne emitiraj (isto pravilo kao
  `pdf-positioned-table.ts:228`).
- **PDP-vs-family detektor za HTML**: port `looksLikeMultiVariantFamilyPage`
  (`document-enrichment.ts:1081`) na HTML → ako stranica lista ≥2 distinct model koda uz naš,
  označi `pageLevel:"family"` i degradiraj confidence + zabrani da family vrijednosti popune
  varijantna polja.

**Effort:** 4–5 dana. **Rizik:** srednji (novi modul, postojeći put ostaje kao fallback).

### P1.4 — Attribute budget: rangiraj prije capa

`generic.ts:501-504` reže na 600 nakon što embedded-JSON putevi potroše do 800 slotova
(`:1126`, `:1577`, `:1619`). Rangiraj po (razumije-li ontologija) × (specifičnost izvora) i
onda reži; ili cap **po familiji strategija** nakon rangiranja.

**Effort:** 1 dan. **Rizik:** nizak.

### P2.1 — PDF: "ne znam" postaje prvorazredno stanje

- **Ukloni silent widen** (`document-enrichment.ts:811`). Novi tri-state:
  `scoped | unscoped-single-variant | unscoped-multi-variant`. U trećem stanju
  **suppress sve unscoped sweepove** (`extractGlobalPdfAttributes`, miners,
  `extractInlineDimensionText`, `extractContactRatingAttributes`,
  `extractStackedDimensionTableRows`) i emitiraj dijagnostiku
  `reason:"unscoped-multi-variant"`. Odluka o `multi-variant` već postoji kao
  `looksLikeMultiVariantFamilyPage` (`:1081`) — samo je treba iskoristiti kao gate, ne samo
  kao force-run trigger.
- **Family-prefix / option-suffix matching** u `catalog-number.ts`: `catalogNumberVariants`
  dobije progresivno skraćivanje na granicama separatora (`GN 422-33-TK` → `GN 422-33` →
  `GN 422`), s **eksplicitnim `matchLevel: "exact" | "family"`** koji putuje uz atribut.
  Family-level match smije popuniti samo polja koja su na razini familije invariantna
  (material, standard, certifikati) — **nikad** weight/dimensions/voltage. Ovdje ujedno
  promoviraj sibling-prefix guard iz `rockwell.ts` u shared modul (pazi na postojeći
  customer-doc family-fallback test koji je to prije blokirao — riješi ga `matchLevel`-om).
- **Generic ordering-code legend reader** (novi `ordering-code-legend.ts`): pročitaj legend
  tablicu (`CODE = value` / pozicija u šifri → svojstvo), dekodiraj našu šifru po pozicijama.
  Generalizira `protectionFromModelLegend` (`:2038`) i **izbacuje**
  `inferEatonRapidLink512CatalogRows` (`:1881-1976`, 95 linija hardcodea) u `eaton.ts` ili u
  config. Najveći pojedinačni coverage win za mehaničke/norm-dio vendore i konfigurabilne pogone.
- **`electrical-spec-miner.ts` dobije catalog awareness**: primijeni
  `looksLikeMultiColumnDataRow` (već postoji, `:1517`/`:1531`) na `mineSpecDefinitions:510`;
  `compositeQuantityValue:609` **ne smije** spajati vrijednosti preko granica stupaca —
  danas proizvodi `"4 A / 8 A / 12 A"` iz komparativnog reda.
- **Catalog check u `extractStackedDimensionTableRows`** (`:2319`) i scoping u
  `extractContactRatingAttributes` (`:2788`).

**Effort:** 5–7 dana. **Rizik:** srednji-visok, ali svaki dio je nezavisno testabilan kroz eval.

### P2.2 — PDF: pozicijski čitač postaje pravi tablični engine

- **Sve stranice koje matchaju, ne prva** (`pdf-positioned-table.ts:386-388`) — skoruj i
  natječi se, kao što se već radi za text/positioned konkurenciju.
- **Header carry-over preko continuation stranica** — `pdf-compliance-matrix.ts:156-173` to
  već zna; prenesi mehanizam.
- **Segmentacija stranice po x-prazninama** prije y-klasteriranja (`:153`) — rješava landscape
  stranice s dvije tablice jedna uz drugu, gdje se danas headeri spoje u jedan anchor.
- **Rotirani tekst**: uzmi `transform[0..3]` (`:384`, `:419`), grupiraj po orijentaciji, pa
  klasteriraj u rotiranom prostoru. Vertikalni headeri su česti u komparativnim matricama.
- **Row-orientirani pozicijski čitač** — danas ne postoji; jedini pozicijski row reader
  emitira samo certifikate. Velike ordering tablice (jedan katalog = jedan red) sa spojenim
  ćelijama su strukturno nerješive bez ovoga.
- **`tight-context.ts` → `catalog-table-vocabulary`**: zamijeni engleske literale
  (`:230`, `:162`) multijezičnim `isCatalogIdHeaderCell`. Modul za to **već postoji i
  namijenjen je točno tome**, ali ga `tight-context.ts` ne importa.
- **Kalibracija u konfiguraciju**: `COLUMN_X_TOLERANCE`/`VALUE_Y_WINDOW`/`HEADER_WRAP_MAX_HEIGHT`/
  `HEADER_MIN_X`/`LINE_WINDOW_AFTER_DEFAULT` → derivirati iz statistike dokumenta (medijan
  visine linije, medijan širine stupca) umjesto apsolutnih točaka tuniranih na 1606-td002.

**Effort:** 6–8 dana. **Rizik:** srednji (izolirani modul, testovi već rade s hand-transcribed x/y arrayima).

### P2.3 — OCR i skenirani dokumenti

- **Per-page odluka o OCR-u** umjesto globalnog `< 80` znakova (`document-enrichment.ts:1007`):
  izračunaj gustoću znakova po stranici; OCR-aj **stranice** koje su prazne a imaju slike.
  Danas tekstualna korica + skenirane spec stranice nikad ne OCR-aju.
- **Jezik OCR-a** iz vendor lokala / detektiranog jezika dokumenta, ne hardcoded `eng`
  (`pdf-ocr.ts:137`).
- **Quality gate na OCR izlaz**: per-word confidence iz tesseracta; pod pragom → ne emitiraj
  numeričke vrijednosti (OCR `8`↔`B`, `0`↔`O`, `1`↔`l` na mjeru je gore od praznog polja).
- **OCR + tablice**: OCR izlaz nema tabove pa `splitPdfTableCells:2254` degradira. Za
  OCR-ane stranice koristiti **pozicijski put** (tesseract daje bounding boxove) — isti
  x-klaster princip kao `pdf-positioned-table.ts`.

**Effort:** 3–4 dana. **Rizik:** nizak-srednji.

### P2.4 — Discovery: dokaz umjesto oblika URL-a

- **Dvofazni scoring**: faza 1 (pre-fetch) samo *rangira redoslijed probavanja*; faza 2
  (post-fetch) daje pravi score iz sadržaja — HTTP status, katalog u `<title>`/`<h1>`,
  JSON-LD `@type:Product`, dubina breadcrumba, broj distinct sibling model kodova,
  canonical self-reference. Sintetizirani `/products/{part}` više ne smije dobiti 100
  (`discovery.ts:262-284`) i istisnuti pravi hit iz budžeta od 12.
- **Search box interakcija** (jedan mehanizam, tri failure modea): u `browser-renderer.ts`
  dodaj "nađi search input → upiši katalog → Enter → poberi XHR + rezultate". Rješava
  POST-only search (F1), JS-only search (F2) i nepoznato ime parametra (F3) odjednom. Komentar
  na `discovery.ts:160-163` to **već obećava**.
- **POST forme**: ili pošalji pravi POST, ili odbaci kandidata — ne serializiraj u GET
  (`:409` + `:427`).
- **Locale ulaz**: čitaj `homepageUrl` (danas ga discovery ignorira) i probaj
  `/en/`, `/en-us/`, `/de/` prefikse za bare origin; koristi `hreflang` i za *ulaz*, ne samo
  za ekspanziju već nađene stranice.
- **Proširi generičke search obrasce**: `s` (WordPress — postoji u wizardu, ne u runtimeu),
  `Ntt`, `k`, `article`, `partNumber`, `/catalogsearch/result/?q=`, `/products?search=`.
- **Vendor hardcode iz generic puta u config**: `link-discovery.ts:199/223`,
  `generic.ts:189-200/275`, `smart-fallback.ts:327`, `normalizer.ts:1257-1301` →
  `ManufacturerConfig.scrapeRecipe` ili connector.
- **Jedan discovery po itemu**: dedupliciraj `discovery-fallback.ts:40` i
  `deterministic-pipeline.ts:31` (drugi je i bez timeouta).

**Effort:** 5–6 dana. **Rizik:** srednji-visok (discovery je najosjetljiviji na regresije) → eval s
snimljenim search stranicama je obavezan.

### P3.1 — Učenje: od jednog uspjeha do ponovljivog recepta

- **Learned site structure (nova tablica `learned_selectors`)**: kad se za neki host uspješno
  izvuče polje, upiši *kako* — CSS selektor / JSON path / tablični (header, kolona) /
  PDF (label, x-cluster). Replay prvo, potvrdi vrijednost, pa tek onda skupi generički sweep.
  Ovo `learned_extractors` pretvara iz cap-multiplikatora u pravi extractor store.
- **Learned URL obrasci**: upiši (a) search template koji je dao potvrđen PDP i (b)
  `endpointTemplateFromUrl(confirmedPdpUrl)`. Funkcija **već postoji** i wizard je već koristi
  (`manufacturer-wizard.ts:68`) — samo je treba pozvati u runtimeu.
- **Negativno učenje**: template s N uzastopnih 404 → deprioritiziraj/ugasi (s TTL-om, kao
  `exhausted_fields`).
- **`target_health` windowing**: sliding window (npr. zadnjih 50 observacija) umjesto lifetime
  suma (`db.ts:637-643`), da se popravljen sajt oporavi. Snizi `sampleCount >= 8`
  (`mission-control.ts:37`) ili uvedi bootstrap za nove vendore.
- **`stage_observations`**: ili napravi čitatelja (per-stage yield report: koja faza koliko
  polja donosi po vendoru — točno ono što treba za odlučivanje gdje ulagati), ili obriši
  tablicu. Danas samo raste.
- **Testovi za `mission-control.ts` i `target-health.ts`** — jedini self-monitoring, nula
  pokrivenosti.

**Effort:** 5–7 dana. **Rizik:** nizak-srednji (aditivno).

### P3.2 — Dijagnostika: reci ZAŠTO, i to na ekranu

- **Per-field kauzalni blocker za sva polja**, ne samo za 11 final-completeness polja.
  Prošiti `FieldHealthRecord.reason` (danas konstanta, `field-registry.ts:213`) na uniju:
  `no-source-discovered | source-fetched-no-label | label-found-value-rejected |
  document-not-parsed | scoping-failed | conflicting-candidates | not-published`.
  To je razlika između tri sasvim različita popravka.
- **UI**: `summarizeRunItem` **već šalje** `fieldHealth`/`documentProcessing`/`discovery`/
  `pageMining` (`run-item-summary.ts:53-56`), `App.tsx` ih ignorira. Dodaj panel po redu:
  "gdje smo gledali / što smo odbacili i zašto / koji dokument je parsiran". `rejectedLinks`
  s razlozima je najkorisniji signal za novi vendor i danas se nikad ne vidi.
- **Novi vendor dashboard**: `target_health` + learned endpoints + agregirani uzroci padova
  po proizvođaču.

**Effort:** 4–5 dana (većinom UI). **Rizik:** nizak.

### P3.3 — Confidence: jedna skala

- Spoji `attributeEvidenceScore` (`normalizer.ts:723`), `sourcePriority`
  (`field-candidates.ts:211`) i `repairAttributeScore` (`final-completeness.ts:674`) u jedan
  modul s **jednim defaultom** za undefined `sourceType` (danas 320/srednje vs 100/najniže —
  dva enginea mogu izabrati različitog pobjednika za isto polje).
- **Rubrika za per-attribute confidence** (danas ručno tunirano po konektoru: `abb.ts`
  0.6→0.98, `eaton.ts` 0.62→0.88, mining 0.68, PDF grid 0.75 — nekomparabilno). Definiraj
  tierove po *vrsti dokaza*, ne po vendoru, i uveži audit koji provjeri da konektori koriste
  te tierove.
- **`applyFieldCandidateResolution` ne smije pisati nevalidiranu sirovu vrijednost** u
  `normalized[]` (`field-candidates.ts:34-39`) — proći kroz `normalizeFields` validaciju i za
  nenumerička polja.
- **`applyCustomerDocumentOverride` → `finalizeQualityGate` nakon** (`run-manager.ts:820`);
  danas `found` na 0.97 preskoči identity, official-source i required-field provjeru.
- **Konflikt mora koštati**: `conflictCount` (`field-candidates.ts:101`) treba snižavati
  score/confidence, ne samo se zabilježiti.

**Effort:** 3–4 dana. **Rizik:** visok (mijenja arbitraciju svugdje) → zadnje, uz puni eval.

### P3.4 — Wizard: "nauči sa jednog primjera"

Danas wizard ne može izvesti recept osim u uskom sitemap slučaju, a `testManufacturerDraft`
prolazi na **1 od N** uzoraka (`manufacturer-wizard.ts:215-225`) i ne vrti PDF enrichment
(`downloadDocument` je stub, `:251`).

- Novi tok: **korisnik zalijepi 1 URL proizvoda + njegov kataloški broj** → sustav izvede
  `endpointTemplateFromUrl`, snimi stranicu kao fixture, ponudi *predložene* mapiranja labela
  (iz ontologije + `suggestTechnicalAttributeAlias`) → korisnik potvrdi → upiše se u
  `learned_selectors` + alias tablicu.
- Traži **≥2 od 3 uzorka** da prođe, i vrti pravi document enrichment u testu.

**Effort:** 4–5 dana. **Rizik:** nizak (nova površina).

### P3.5 — Opcionalni LLM samo kao *predlagač*, nikad kao izvor vrijednosti

Ontologija strukturno kaska za stvarnošću (§2B). Deterministički princip se čuva ako LLM
**nikad ne proizvodi vrijednost**, samo *mapiranje*:

- Offline batch nad Unmapped Labels teach-listom (lokalni Ollama, isti opt-in obrazac kao
  `PDT_AI_CLEANUP=1`): "je li `Bemessungsstoßspannung` = `impulseVoltage`?" → predlog u
  review file → čovjek/audit prihvati → **regex/alias uđe u kod**. Vrijednosti i dalje
  dolaze iz determinističkih parsera.
- Isto za segmentaciju nepoznatog PDF layouta: LLM predloži *koji reader* i *koje granice*,
  reader izvuče vrijednost. Nikad LLM ne prepisuje broj.

**Effort:** 3–4 dana. **Rizik:** nizak ako se granica strogo drži.

---

## 4. Redoslijed izvedbe

```
P0.1  Offline eval harness            ← BEZ OVOGA NE IDE DALJE   (2-3 d)
P0.2  6 bugova (PDF targeting, sitemap gate, learned wiring, cache keys, ",", truncation)  (1-2 d)
──────────────────────────────────────────────────────────────────────
P1.1  Ontologija kao admission gate   ← najveći coverage win      (3-4 d)
P1.3  HTML tablice + family detektor                              (4-5 d)
P2.1  PDF "ne znam" + family-prefix + legend reader                (5-7 d)
P1.4  Attribute budget ranking                                    (1 d)
──────────────────────────────────────────────────────────────────────
P2.2  Pozicijski čitač → pravi engine                             (6-8 d)
P2.4  Discovery: dokaz + search box                               (5-6 d)
P1.2  Jedan izvor istine za labele                                (3-4 d)
P2.3  OCR per-page + jezik + bboxovi                               (3-4 d)
──────────────────────────────────────────────────────────────────────
P3.1  Learned selectors + URL obrasci + negativno učenje          (5-7 d)
P3.2  Kauzalna dijagnostika + UI                                  (4-5 d)
P3.4  Wizard "nauči sa 1 primjera"                                (4-5 d)
P3.5  LLM kao predlagač mapiranja                                 (3-4 d)
P3.3  Jedna confidence skala          ← zadnje, najrizičnije      (3-4 d)
```

**Prva 2 koraka (~4 dana) sami vjerojatno daju najveći skok** — jer #1 otključava page
targeting za *svaki* datasheet, a #2 vraća sitemap kanal za *svaki* novi sajt.

## 5. Kako ćemo znati da je bolje (metrike)

Mjeriti prije/poslije svake faze, offline preko `npm run eval`:

1. **Value-accuracy** na fixture korpusu (danas nemjerljivo — benchmark tvrdi samo prisutnost).
2. **Contamination rate** — koliko `mustNotContain` pogodaka (sibling vrijednosti).
3. **Fields-per-item** na *nepoznatom* vendoru (fixture bez konektora i bez configa).
4. **Unmapped-label rate** — pada li kako ontologija raste.
5. **Silence-vs-wrong ratio** — kad ne znamo, ostavljamo li prazno (dobro) ili pogađamo (loše).
   Ovo je metrika koja čuva ono najbolje u sustavu.
6. **Discovery hit rate na 1. kandidatu** — mjeri je li scoring stvarno postao evidence-based.

### ✅ P1.3k — stvarni Ganter interaktivni konfigurator

`npm run audit:page-attrs -- --host ganternorm.com --limit 3` je pokazao da snimljeni PDP
`GN 3310-19-LK-K2` još prolazi kroz stari fallback kao `19 +0,1 / +0,3 = 6 | 5 | 22`.
Čitanje izvornog HTML-a potvrdilo je oblik: tablica ima interaktivni filter, jedan odabrani red i
zaglavlja `d Connection type K2 / K5` odnosno `Connection type S025`. To nije smjelo spojiti
K2 sa S025.

Prije izmjene je fixture proširen stvarnim tvrdnjama i padao je: table reader nije vraćao K2
stupac, a eval je objavljivao `S025 - Cable with plug, 0,25 m`. `html-table-reader.ts` sada
prepoznaje (a) dvostupčanu lookup tablicu opcija s jedinstvenim ordering-code segmentom i (b)
interaktivni konfigurator s jednim retkom: zadržava samo zajedničke stupce i option-stupce koji
spominju traženi kod. Generic family backstop zatim odbacuje samo code-prefixed sibling za polje
koje već ima eksplicitnu target-scoped opciju; dodatni finalni guard odbacuje serializirane HTML
atribute poput `alt=` iz raw-text fallbacka.

**Mjerenje:** `tsc` čist; `vitest` **2221/2221**; eval **17/17**, **218** checkova, 0
kontaminacija (Ganter 50 → 43 atributa: uklonjeni su K5/S025 i raw/dupli unosi, dok su `K2`,
otvor `19 +0,1 / +0,3`, `d = 6` i `A/F = 22` ostali); spec-gate 120 dokumenata,
1736 → 1536, 0 SUSPECT; label A/C/D clean.

### ✅ P2.4i — zatvarajući HTML tag nije discovery URL

`audit:discovery` je na stvarnom snimljenom Ganter PDP-u za `GN 3310-19-LK-K2` rangirao
`https://www.ganternorm.com/a` kao search-result kandidat. Reprodukcija je pokazala da ga
`link-discovery.ts` proizvodi iz regex grane za relativne URL-ove: `</a>`, `</div>` i slični
zatvarajući tagovi odgovarali su kao `/a`, `/div`, a široki susjedni kontekst sadržavao je pravi
katalog broj pa ih je identity scorer lažno potvrdio.

Prije izmjene novi test čita isti Ganter fixture i pada na takvom kandidatu. Inline grana sada
preskače relativni match koji neposredno slijedi `<`; URL iz atributa i tekstualni URL ostaju
netaknuti. Ciljani test prolazi, a replay discovery ostaje **32 % top-1 / 35 % top-3 / 42 %
pronađenih** (nije pao), s uklonjenim lažnim tag-kandidatima. Puni paket: `tsc` čist, Vitest
**2222/2222**, eval **17/17** bez kontaminacije, spec-gate 0 SUSPECT i labels A/C/D clean.

### ✅ P2.4j — službeni slug redirect mora dokazati SKU sadržajem

Ganter quick-finder za `GN 3310-19-LK-K2` u offline cacheu redirecta na službeni PDP čiji slug
sadrži samo obitelj `GN 3310`, dok sam HTML sadrži puni SKU. Staro pravilo je prihvaćalo redirect
jedino kad ga je exact katalog broj već bio u URL-u, pa je takav dokazani PDP odbacivalo.

Novi regresijski test prvo je padao na slug-only URL-u s `Product` JSON-LD `sku`. Redirect sada
prolazi samo ako je služben, nije search URL i `scoreFetchedDiscoveryEvidence` potvrdi exact SKU na
title/H1/OG/Product JSON-LD površini; login/kategorija i običan slug bez dokaza ostaju odbijeni.
Puni gate: `tsc` čist, **2223/2223** Vitest, eval **17/17** bez kontaminacije, spec-gate 0 SUSPECT,
labels A/C/D clean. Offline discovery agregat ostaje isti (povijesni target bira jedan red po SKU-u),
ali novi stvarni redirect put više nije strukturno nevidljiv.

### ✅ P1.2g — `Enclosure protection` nije material

Label audit je pokazao da registry za `Enclosure protection` bira `material` samo zato što je broad
alias bio pojedinačna riječ `enclosure`; ontologija ga ispravno vodi u `protection`. Postojeći
document-enrichment test ima stvarni oblik `Enclosure protection` → `IP65`. Novi test je prvo padao
na dvostrukom routanju, zatim je material alias sužen na eksplicitne `enclosure material/body/housing/
construction` labele.

Mjerljivo: concrete registry/ontology disagreements **14 → 13**; pun suite **2224/2224**, eval
**17/17**, labels A/C/D clean. Spec-gate A/B je 1736 → 1731 atributa prije gatea i 1536 → 1534
poslije, bez izgubljenog normaliziranog polja (**0 SUSPECT / 0 garbage**). Audit tada nije emitirao
per-row A/B diffs, pa se pet redova ne pripisuje unatrag samo ovom aliasu; agregat potvrđuje da nije
uvedena regresija, ali ne i uzrok svakog retka. P1.2 ipak nije 100 %: deriviranje zajedničkih
label-patterna ostaje svjesno odgođeno.

### ✅ P1.2h — debljina nije materijal

Novi registry test je prvo reproducirao da `Material thickness` i `Body thickness` paralelno odgovaraju
i `wallThickness` i `material`. Oba broad material aliasa sada imaju negativni uvjet za `thickness`,
dok specifični `wallThickness` alias ostaje vlasnik labele. Time se ne dira `Material`, `Housing
material`, `Body material` ni lokalizirane material labele.

Mjerljivo: concrete registry/ontology disagreements **13 → 11**, A/C/D ostaju clean. Ciljani testovi
su **121/121**, puni suite **2225/2225**, eval **17/17** s **218** provjera i bez kontaminacije,
te spec-gate **1731 → 1534**, **0 SUSPECT / 0 garbage** — identično stanju prije ovog alias-fixa.
Drugim riječima, popravak uklanja dokazanu pogrešnu klasifikaciju labele, bez brisanja zadržanih
atributa u realnom offline korpusu.

### ✅ P1.4g — ABB `2a KEY` nije amper

Stari knownGap iz stvarnog fixturea `abb-1SDA126404R1-page` pokazao je da summary-inference iz opisa
`POSITION 2a KEY` proizvodi `current = 2a`; riječ je o key-lock dodatku, bez objavljene struje. Novi
end-to-end test prvo je pao na istom tekstu. Popravak nije globalno odbacio malo `a` (što bi naškodilo
legitimnom `16a`), nego odbija samo amper-kandidat iza kojega neposredno slijedi eksplicitni `key` ili
`keys`.

KnownGap je zatvoren bez promjene ground-trutha: fixture sada ima **11** provjera i 0 otvorenih gapova.
Puni gate: `tsc` čist; Vitest **2226/2226**; eval **17/17**, **218** provjera i 0 kontaminacija;
spec-gate **1731 → 1534**, **0 SUSPECT / 0 garbage**; labels A/C/D clean.

### ✅ P1.4h — nVent IP rating nije certifikat

Stvarni nVent `A6R44HCR` standardni blokovi objavljuju `Type 3R` dvaput i `IEC 60529, IP32`. Prije
popravka je `IP32` završio i u `certificates`, a protection je bio `Type3R; NEMA/EEMAC Type 3R IEC
60529, IP32; Type3R`. Novi end-to-end test čita snimljenu stvarnu stranicu i zahtijeva da `IP32` nije
certifikat te da je kanonski protection baš `Type3R; IP32`.

Certificate tokenizatori više ne promiču gole `IPxx` tokene u odobrenja. U standardnim blokovima
protection collector uzima objavljene rating tokene (`Type`, `IP`, `IK`, `NEMA`), umjesto da zadržava
ponovljeni approval prose; deduplikacija sada razumije i već normalizirani oblik `Type3R`. UL, cUL,
CSA i stvarni standard `IEC 60529` ostaju u certificates. Puni gate: `tsc` čist; Vitest
**2227/2227**; eval **17/17**, **218** provjera, 0 kontaminacija i 0 otvorenih gapova; spec-gate
**1731 → 1534**, **0 SUSPECT / 0 garbage**; labels A/C/D clean.

### ✅ P3.2c — proizvođački dijagnostički pregled nije više samo Excel/debug artefakt

`target_health` je već bio pravilno računat iz kliznog prozora opažanja, a learned endpointi su
postojali u DB-u, Excelu i run debug bundleu, ali operator ih u aplikaciji nije mogao vidjeti bez
otvaranja datoteka. Novi read-only `GET /api/manufacturers/:id/operational-summary` vraća najviše 20
recent host/stage prozora iz istog bounded modela kao runtime drift detekcija, uz naučene GET/POST
endpointe i njihove success/failure brojke. Tipka **Operations** na odabranom proizvođaču prikazuje taj
pregled; postojeći run dashboard i drawer već agregiraju reason-code blokere iz svih artikala tog runa.

Novi DB test najprije je pao jer `listTargetHealth` nije postojao, zatim potvrdio da se `drift.test`
prikazuje prije zdravog targeta i da oba koriste posljednjih osam opažanja. Nema write-backa, promjene
recipeja ni promjene scrape rezultata. Puni gate: `tsc` čist; Vitest **2230/2230**; eval **17/17**,
**218** provjera, 0 kontaminacija i 0 otvorenih gapova; spec-gate **1731 → 1534**, **0 SUSPECT / 0
garbage**; label audit A/C/D/E = 0 (B = 80 je informativno, neizvozno).

### ✅ P1.3j — stvarni ABB CAD PDP potvrđuje generički tablični put, ne traži heuristiku

`audit:page-attrs` je signalizirao ABB PartCommunity URL `1SDA126426R1`, ali izolirani fixture je
opovrgnuo pretpostavku o generic-parser zastoju: 135 kB službeni HTML završi za 0,6 s i čita objavljeni
`Order Number`, `Description`, `GTIN` i `Product Class` iz stvarnih tabličnih redaka. Stranica izričito
ne objavljuje nameplate napon, struju, weight ni dimenzije, pa fixture zahtijeva da ta polja ostanu prazna.

Da bi se takav audit dokaz izvukao bez pogrešnog cache retka, `fixtures:extract` dobiva exact
`--catalog`, strogo ograničeni `--include-non-found` i `--url` (koji zahtijeva katalog). Standardni
`found` fixture put ostaje nepromijenjen; exact URL je potreban jer isti SKU u cacheu može imati search,
CAD i PDP rutu. Nema parser promjene jer detector nije pokazao kvar. Puni gate: `tsc` čist; Vitest
**2230/2230**; eval **18/18**, **226** provjera, 0 kontaminacija/gapova; spec-gate **1731 → 1534**,
**0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P1.2k — normalizer više nije drugi runtime vlasnik label vokabulara

`normalizer.ts` je držao zasebni `FIELD_LABEL_PATTERNS` za weight/dimensions/wall thickness/finish/color/
voltage/current. To nisu iste admission odluke kao `fieldMatchesLabel` — normalizer čita širi
`group + name` kontekst — ali nije smio biti zaseban modul koji ih posjeduje. Ti kontekstualni regexi
su premješteni u `field-registry.ts` kao `normalizerFieldLabelPatterns`; svi runtime pozivi normalizera
čitaju taj registry export. Novi test čuva ključne oblike `Cable length`, `Ua`, `Switching capacity` i
kinesku težinu, tako da se višeljezična/specifična pokrivenost nije nehotice suzila.

Test je prvo pao bez registry API-ja, zatim su ciljane registry+normalizer regresije prošle **192/192**.
Puni gate: `tsc` čist; Vitest **2231/2231**; eval **18/18**, **226** provjera, 0 kontaminacija/gapova;
spec-gate **1731 → 1534**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0. Nema promjene raw
atributa ni normaliziranih vrijednosti.

### ⏳ Audit nalaz — ABB PartCommunity CAD URL nije dokaz za novu HTML heuristiku

Read-only `audit:page-attrs -- --limit 200` prošao je prvih 150 snimljenih HTML stranica, a zatim se
zadržao na `https://abb-control-products.partcommunity.com/3d-cad-models/?catalog=abb_ww&part=1SDA126426R1`
(138 kB). To je službeni CAD Download Center URL, ne obični PDP; generički parser se ne smije širiti
prema njegovom neprovjerenom HTML-u samo da bi audit završio. Pokušaj širokog fixture extracta vratio je
četiri druga, nepregledana ABB copyja; njihovi manifesti i HTML kopije su odmah uklonjeni, cache izvornik
nije dirnut. Sljedeći korak je tek ciljano izdvajanje stvarnog cache artefakta i performance fixture s
ručno pročitanim izvorom — bez toga nema parser-promjene ni tvrdnje o tabličnom coverage gainu.

### ✅ P1.2i — mjera procesa nije gabarit proizvoda

Label audit je još imao tri očita pogrešna routanja: `Frame size`, `Stripping length` i `Stroke
length` su preko broad `size`/`length` aliasa punili izvozno polje `dimensions`. To nisu gabariti
kućišta/uređaja, a model za njih još nema zasebne stupce. Registry ih zato eksplicitno odbija samo za
`dimensions`; sirovi atribut i njegov ontology key ostaju vidljivi za buduće modeliranje.

Novi test je prvo pao za sva tri naziva, zatim prošao. Mjerljivo: concrete registry/ontology
disagreements **11 → 8**. Informativna sekcija B porasla je **69 → 72** upravo za ta tri neizvozna
ontology ključa — to je vidljivost, ne izgubljen podatak. Puni gate: `tsc` čist; Vitest **2228/2228**;
eval **17/17**, **218** provjera, 0 kontaminacija i 0 otvorenih gapova; spec-gate **1731 → 1534**,
**0 SUSPECT / 0 garbage**; labels A/C/D clean.

### ✅ P1.2j — glavna struja/napon nisu svaki električni broj

Zadnjih osam disagreementa su bili različiti electrical parametri pogrešno stavljeni u `voltage` ili
`current`: insulation i impulse voltage, voltage drop, te inrush, locked-rotor ratio, residual,
let-through i leakage current. Registry komentar ih je već navodio kao namjerno isključene, ali broad
aliasi to nisu provodili. Novi test je prvo pao na svih osam stvarnih labela; sada ostaju raw atributi i
ontology vrijednosti, a ne mogu popuniti nameplate `voltage`/`current` stupce.

Mjerljivo: label-audit sekcija E **8 → 0**. Sekcija B je **72 → 80**, točno osam sada vidljivih ali
neizvoznih ontology svojstava; nije uklonjen nijedan raw atribut. Puni gate: `tsc` čist; Vitest
**2229/2229**; eval **17/17**, **218** provjera, 0 kontaminacija i 0 otvorenih gapova; spec-gate
**1731 → 1534**, **0 SUSPECT / 0 garbage**; labels A/C/D clean.

### ✅ P2.2f — compliance-matrix granica više nije Rockwellova koordinata

`pdf-compliance-matrix.ts` je imao `HEADER_MIN_X = 100`: svi certification headeri i checkmarkovi
u užem PDF layoutu lijevo od te točke bili bi tiho ignorirani. Novi reproduktor ima `Catalog Number`
na x=12 te CE/UL stupce na x=49/73; stari reader vraćao je prazno, iako su checkmarkovi izravno vezani
za te stupce.

Reader sada granicu labela i data-stupaca izvodi iz prvog checkmark/header stupca, a kad postoji,
i iz objavljenog `Catalog Number` headera. Continuation stranica bez svog headera koristi prenesene
header pozicije i zadržava exact catalog-number match; ne uvodi se slobodno traženje po stranici.
Puni gate: `tsc` čist; Vitest **2238/2238**; eval **18/18**, **226** provjera, 0 kontaminacija/gapova;
spec-gate **1731 → 1534**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P2.4k — discovery se ne ponavlja između stageova istog artikla

Vendor connector može pozvati `scrapeDiscoveredFallback`, a isti artikl potom ući u deterministic
quality fallback i završni retry. Prije ove promjene svaka od tih faza ponovno je radila search-form,
browser i sitemap discovery. `ScrapeContext.discoveryMemo` sada dijeli `Promise<ProductDiscoveryResult>`
po proizvođaču i kompaktnom katalogu samo unutar jednog run-manager itema; istekli/neuspjeli promise
se ne pamti, pa transient greška ne blokira kasniji retry.

Novi test koristi dva odvojena stage-konteksta s istim memo-om: prvi discovery napravi 13 kontroliranih
offline fetch koraka, drugi napravi **0** dodatnih i vraća isti dokaz. Mapu run-manager prosljeđuje u
početni connector, quality fallback i final retry. Puni gate: `tsc` čist; Vitest **2239/2239**;
eval **18/18**, **226** provjera, 0 kontaminacija/gapova; spec-gate **1731 → 1534**, **0 SUSPECT /
0 garbage**; label audit A/C/D/E = 0.

### ✅ P3.3d — evidence audit prepoznaje dokument kao vlastiti dokaz

`audit:confidence` je nad 110 stvarnih spremljenih connector rezultata pronašao 9 Siemens problema:
stari rezultat ima datasheet URL i službeni `SourceRecord` za taj isti PDF, ali `DocumentRecord.sourceUrl`
još čuva pview referrer iz kojeg je link pronađen. Audit je zato pogrešno javljao "unresolved source",
iako je dokaz dokumenta već u rezultatu.

Za `DocumentRecord` audit sada prvo pokušava `sourceUrl`, a zatim njegov vlastiti `url`; atributi nemaju
taj fallback, jer bi to sakrilo pogrešno pripisanu vrijednost. Novi regresijski test koristi baš taj
stari referrer/PDF oblik. Mjerenje nakon promjene: **110/110** rezultata, **17.144** evidence zapisa,
**0** provenance issuea; Siemens dokumenti prelaze iz generated u official-document samo uz postojeći
službeni source zapis. Slijedi puni ekstrakcijski gate.

### ✅ P1.1f — review teach-list ne promiče manual/page-furniture kao specifikaciju

Read-only povijesni uzorak pokazao je da sama prisutnost brojke još nije dokaz spec labele: `Table 36:`
caption, URL instrukcije, `220V` kao izvučena labela i višejezične `Push/Premere/STOPPEN/Pulse STOP`
upute završavale su u Unmapped Labels. To su parser artefakti za review, ne ontološki gapovi.

`findUnmappedSpecLabels` sada strogo odbija URL u nazivu, numerirani table caption, čistu vrijednost
u ulozi naziva te samo snimljene, početno-sidrene manual-instruction/caption oblike (EN/DE/IT/ES/ZH).
Regresija namjerno zadržava dugi stvarni `Electrostatic Discharge ... IEC 61000-4-2` label i text-only
`Contact metallurgy`. Nad 50 najnovijih stvarnih rezultata svi ti manual/caption/URL nazivi su nestali;
ostaju stvarni review kandidati (`Construction Detail`, ESD/surge immunity i odvojeni modelski gapovi).
Puni gate nakon promjene: TypeScript čist; Vitest **2240/2240**; eval **18/18**, 226 checkova i 0
kontaminacija; spec-gate **1731 → 1534**, 0 SUSPECT/garbage; label audit A/C/D/E 0. Dodatni
evidence-confidence audit je **110/110** rezultata, 17.144 zapisa i 0 provenance issuea.

### ✅ P1.3l — već kompletni HTML `Label: value` retci nisu izmjenična tablica

Read-only `audit:page-attrs` nad stvarnim Saginaw Control cacheom pokazao je sumnjivi spoj na
`SCE-60RA19TH`. Izvorni službeni PDP ima dva zasebna paragrafa: `Part Number: SCE-60RA19TH` i
`Description: Angle, Rack`. Novi value-verified fixture je prije popravka reproducirao dva artefakta:
`Catalog Number = SCE-60RA19THDescription:` i `Part Number: SCE-60RA19TH = Description: Angle, Rack`.

Uzrok drugoga je bio `extractAlternatingSpecGridAttributes`: niz već kompletnih, delimited `<p>`
parova pogrešno je tretirao kao label/value ćelije i spojio susjedne retke po poziciji. Takav niz sada
ostaje element-level putu koji već čita svaki stvarni par. Identity extractor uz to više ne prihvaća
tolerantni substring u zalijepljenom tokenu: zahtijeva boundary-safe exact katalog dokaz i sprema samo
objavljeni katalog. Fixture ostavlja stvarne `Part Number` i `Description` a tvrdo odbija oba artefakta.

Drugi prolaz istog fixturea našao je nezavisni raw-text problem: `onclick`/application proza je postala
`Mounting = Designed for`, `Mounting = Angles']);\">Rack` i `Type = RA - U Shape Rack`; zaglavlje
`Industry Standards - (IS17)` dalo je i lažni `Standards = (IS17)`. HTML fallback sada prvo uklanja
nevidljivi markup/script sadržaj i nedelimited parove dopušta samo u jednom vidljivo technical/spec/data
bloku s najmanje tri poznate labele. To namjerno zadržava postojeći unseen-vendor `Technical summary`
regresijski oblik (`Housing material Glass-fiber reinforced polyester …`), dok reader/Markdown ostaje
nepromijenjen. Usko pravilo dodatno odbija samo parenthetical internal-code za labelu `Standards`; IEC/UL
standardi ostaju dopušteni.

Mjerljivo: fixture **15 → 10** atributa. Pet uklonjenih redaka su točno dva cross-node artefakta,
tri application/onclick prozna retka i `(IS17)` header-code; zasebni stvarni `Part Number` i
`Description` ostaju. S `PRODUCT_SCRAPER_DISABLE_SPEC_GATE=1` je **40** sirovih atributa i svih osam
fixture zabrana prolazi, dakle popravak ne ovisi o gateu; canonicalization trace nije prijavio skip.
Puni gate: `tsc` čist; Vitest **2240/2240**; eval **19/19**, **234** provjera, 0 kontaminacija/gapova;
spec-gate **1731 → 1534**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P1.3m — product-header kartica nije `Label: value` par

Read-only `audit:page-attrs` nad Schmersal cacheom našao je stvarni PDP `153048818`
(`AZM150B-STL-10/02RA-024`). HTML kartica uredno objavljuje naslov i `Item number: 153048818`, ali
u istom ugniježđenom stablu nosi marketing (`Product features`, connector/enclosure bullets), prijavu
za cijene i `Add to Cart` / watchlist / compare akcije. `extractLooseChildPairAttributes` je nakon
neuspjelog pravog child-pair čitanja pozivao `splitNameValue($(row).text())` na svakom ancestoru;
jedan descendant colon zato je proizveo Page Evidence atribute od cijele kartice.

Novi value-verified fixture čuva stvarni model, article number, 24 VDC / 2 A, IP67/IP65, dimenzije,
materijal i ambient raspon. Prije popravka ima 50 atributa i pet Page Evidence redaka. Nakon njega ima
**46**: uklonjena su točno četiri UI artefakta — tri spojena retka s `Product features…Add to Cart…`
i jedan redundantni slijepljeni `AZM…Item number = 153048818`. Nije izgubljen proizvodni podatak:
strukturirani `Article number (order number)`, `Product type description` i čisti `Item number =
153048818` ostaju. Fallback za gole leaf `Label: value` retke sada ne radi kroz descendant blockove,
a child-pair put jednako odbija dvije cijele layout podgrane; span/div spec redovi ostaju pokriveni
regresijskim testom.

S `PRODUCT_SCRAPER_DISABLE_SPEC_GATE=1` fixture ima **57** sirovih atributa i svih 15 provjera prolazi
bez kontaminacije; canonicalization trace nije prijavio skip. Dakle ispravak nije nuspojava spec-gatea.
Puni gate: `tsc` čist; Vitest **2241/2241**; eval **20/20**, **249** provjera, 0
kontaminacija/gapova; spec-gate **1731 → 1534**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P2.3a — stvarni skenirani dokument ne smije posuditi tuđi nacrt

Korpus je napokon dobio stvarni scanned-PDF case, ali ne kao izmišljenu OCR pobjedu. SCE run za
`P-P11R2-K3RF0-U450` povezuje službeni jednoslojni cutout sheet. Vizualni pregled potvrđuje da list
crta i navodi **druge** varijante (`P-R2-F3R3-U450`, `P-Q7-F3R3-U450`, `P-R2-K3RF3-U450`…), nikad naš
`P-P11R2-K3RF0-U450`. Native tekst je prazan; OCR doista prepoznaje većinu nacrta, ali na srednjih
52/100 pada na postojećem pragu 55 i enrichment korektno vraća nula atributa.

Novi value-verified negativni fixture tvrdo zahtijeva prazne dimensions/weight/voltage/current i odbija
sve tri susjedne šifre. To je ispravna odluka: spuštanje praga da bi se iz neodgovarajućeg, multi-variant
nacrta izvukle dimenzije bilo bi upravo pogađanje koje plan zabranjuje. Još nije pozitivan OCR table
fixture — za to treba snimljeni sken koji istovremeno pokazuje naš katalog i njegovu SKU-kolonu.
Puni gate: `tsc` čist; Vitest **2241/2241**; eval **21/21**, **256** provjera, 0
kontaminacija/gapova; spec-gate **1731 → 1534**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P1.3n — accordion naslov i roditeljski grid nisu atributi

Stvarni Schmersal PDP `101166156` (`AZM 170-02ZKA-ST 230VAC`) pokazao je drugi oblik iste
greške. Svaka tehnička grupa sadrži pojedinačne leaf retke (npr. `Product type description`,
`Article number`, `Housing material`, dimenzije), ali generički fallback je uz njih objavio i
roditeljske rekonstrukcije: prvi cijeli red kao ime, ostale retke kao vrijednost, te `Ordering data`
sa sadržajem cijele grupe.

Novi value-verified fixture prije popravka ima **100** atributa i pet kontaminacija. Nakon njega ima
**95**: uklonjeno je točno pet sintetičkih roditeljskih/grupnih zapisa — Ordering data, Ordering-data
grid, General data grid, Features grid i Dimensions grid. Leaf činjenice ostaju: model, article number,
glass-fibre reinforced housing, 30 mm duljina, 275 g, 24 V AC/DC, 4 A, IP67 i -25...+60 °C. Čitač sada
prepoznaje ponovljene dvoćelijske child-retke kao grid, a završni shared filter odbija samo nazive koji
su čista sekcija/grupa (`Ordering data`, `Mechanical specifications`), ne konkretnu labelu `Feature`.

S `PRODUCT_SCRAPER_DISABLE_SPEC_GATE=1` fixture pada **112 → 107** raw atributa i svih 16 provjera
prolazi bez kontaminacije; canonicalization trace nije prijavio skip. Dakle pet redaka nisu skrivena
gateom, nego su stvarno prestala nastajati. Puni gate: TypeScript čist; Vitest **2242/2242**; eval
**22/22**, **272** provjere, 0 kontaminacija/gapova; spec-gate **1731 → 1534**, **0 SUSPECT / 0
garbage**; label audit A/C/D/E = 0.

### ✅ P2.1i — `standard` u family PDF-u nije automatski shared podatak

Stvarni 16-stranični E-T-A `3120-F` datasheet za traženi
`3120-F521-P7T1-W01D-16A` ispisuje samo `F521` family prefiks i popis mogućih ratinga, ali ne puni
target kod niti pozicijski dokaz za sufiks `-16A`. Zato je novi fixture namjerno **refusal** case: nema
normaliziranog napona/struje/dimenzije i ne smije nagađati dekodiranje ordering codea.

Otkriven je zaseban family-output propust: PDF tablični reader je iz raspadnutog naslova
`Standard voltage ratings and typical internal resistance values` izvezao `Standard voltage = ratings
and typical internal`. Prethodni allow-list je gledao samo pojavljuje li se riječ `standard`, pa je
mogao propustiti rating zato što mu je dio naslova.

`isFamilyInvariantAttribute` sada provjerava samo naziv retka (ne generički PDF group, da `Housing
material` pod grupom `Dimensions` ostane dopušten), prvo odbija registry-prepoznata varijantna polja, a
standarde/norme/certifikate/odobrenja zadržava samo uz stvarni objavljeni normativni token (npr. EN,
IEC, UL, CE). Regresijski test čuva `Material: Stainless steel` i `Applicable standard: EN 60947-2`,
ali odbija slomljeni `Standard voltage…` naslov.

Mjerljivo na stvarnom fixtureu: **8 → 1** family atribut. Sedam uklonjenih redaka su četiri
raskomadana `standard`/approval naslova, dva `standard` opisa varijante i lažni `Standard voltage`;
jedini preostali je objavljeni `Housing material = thermoplastics, black UL94V-0`. Nema izgubljenog
normaliziranog polja (prije i poslije `{}`). S `PRODUCT_SCRAPER_DISABLE_SPEC_GATE=1` i canonicalization
traceom rezultat je isti (**1** atribut), pa korekcija ne ovisi o downstream gateu. Puni gate:
TypeScript čist; root Vitest **2242/2242**; eval **23/23**, **278** provjera, 0 kontaminacija/gapova;
spec-gate **1650 → 1471**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0. `npx vitest run`
preko cijelog checkouta dodatno zahvaća `.claude/worktrees/...` kopiju i ondje je našao dva postojeća
5 s Excel timeouta; autoritativni root `tests/` suite je čist.

### ✅ P1.3o — poravnati `<br>` retci nisu jedna velika specifikacija

Read-only span scan 1.088 cacheiranih HTML stranica našao je 161 tablicu s `colspan`/`rowspan`;
osim već poznatih Ganter matrica, stvarni `GN 6284-180-T-1-SU` PDP ima dvostruku ćeliju s poravnatim
linijama. Lijevo objavljuje `Contacts`, `Contact material`, `Contact resistor`…, a desno redom
`Changeover contact`, `Silver alloy`, `25 mΩ`…. Prijašnji reader je prije odluke napravio jednu
dugu string-ćeliju; downstream gate ju je odbio i objavljeni material/resistor su nestali.

Novi fixture je izdvojen iz cachea prije koda i prvo je pao na oba facts. Matrix ćelija sada čuva i
vidljive `<br>` retke. Reader ih razdvaja samo kad red ima točno dvije logičke ćelije i jednak broj
linija; zadržava samo semantički sigurne parove, pa ne pomiče `Mech. contact lifespan` na susjedni
napon/struju. Posebno je bitno da explicitna `(KU)`/`(SU)` oznaka ostaje variant identity: za traženi
`…-SU` `Plug (SU) = 8-pin plug M12x1` prolazi, a `Cable (KU) = PUR cable…` je odbijen kao sibling.

Mjerljivo: stvarni fixture **38 → 44** atributa; šest dodataka su `Contacts`, `Contact material =
Silver alloy`, `Contact resistor = 25 mΩ`, `Lifespan`, `Actuation force / distance` i target `Plug
(SU)`. Niti jedan nije uklonjen; sibling cable se ne pojavljuje. Sa spec-gateom isključenim fixture
ima 160 sirovih atributa, ali sve tri zabrane/provjere i dalje prolaze, a canonicalization trace nema
skip — rezultat nije nuspojava downstream filtra. Puni gate: TypeScript čist; root Vitest
**2243/2243**; eval **24/24**, **281** provjera, 0 kontaminacija/gapova; spec-gate **1650 → 1471**,
**0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P2.4l — footer link nije search rezultat samo zato što je SKU u susjednom HTML-u

Offline replay je za Ganter `GN 3310-19-LK-K2` prije promjene rangirao generički službeni footer URL
`/en/productpages/special-requests` kao prvi kandidat. Stvarni PDP nosi taj link u bloku pomoći, a
odmah poslije njega skriva sve selectable SKU varijante. Raw-HTML fallback je zato u prozoru od 520
znakova pronašao traženi SKU i ponovno pročitao isti `href`, mimo strožeg DOM anchor konteksta; rezultat
je bio score 75 za stranicu koja nije proizvod.

Regresija koristi postojeći snimljeni PDP i prvo je pala. Inline fallback sada preskače URL koji je
unutar HTML opening taga: DOM put ga već čita uz lokalni elementni kontekst, dok fallback ostaje za
JSON, inline script i literalni response tekst. Time se ne uvodi vendor blacklist i ne blokira stvarne
script/JSON product linkove. Nakon promjene `special-requests` više nije kandidat; #1 za isti replay je
Ganterov stvarni `/product/gn331019lkk2` quickfinder URL. Široki cache replay ostaje 23/80 (28,7 %) #1,
26/80 (32,5 %) top-3 i 31/80 (38,8 %) pronađenih — točno se navodi kao uklonjen false positive, ne kao
nezasluženi rast agregatne metrike.

Puni gate: TypeScript čist; root Vitest **2244/2244**; eval **24/24**, **281** provjera, 0
kontaminacija/gapova; spec-gate **1650 → 1471**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P2.4m — discovery audit mora priznati dokazani PDP redirect, ne samo stari URL string

`audit:discovery` je ranije računao hit isključivo preko `sameNormalizedUrl(candidate.url,
run_items.product_url)`. To je podcjenjivalo stvarni pipeline: ABB Smartlink za
`1SAP180400R0001` je službeni kandidat, cache ga vodi na aktualni globalni ABB PDP, a njegov Product
JSON-LD potvrđuje točan SKU. Historijski run pak pamti staru poljsku putanju. Audit je zato prijavio
promašaj iako bi runtime nakon fetch-a točno prihvatio stranicu.

Replay sada za svaki kandidat prvo zadržava strogi recorded URL hit, a za različit URL iz već postojećeg
cachea traži isti `scoreFetchedDiscoveryEvidence` identity dokaz koji koristi runtime. Cache 404 i
nepotvrđeni URL ostaju promašaj: ovo nije priznavanje URL shapea niti internet request. Na ABB uzorku
to otkriva **68/80 (85 %)** sadržajno potvrđenih PDP-ova (prije je string-metrika tvrdila 0); mješoviti
uzorak od 80 sada je **35/80 (43,8 %) #1**, **39/80 (48,8 %) top-3**, **54/80 (67,5 %) pronađenih**,
od kojih je 26 potvrđeno sadržajem. To je korekcija mjerenja, ne tvrdnja da je ova izmjena sama promijenila
runtime discovery.

Puni gate: TypeScript čist; root Vitest **2244/2244**; eval **24/24**, **281** provjera, 0
kontaminacija/gapova; spec-gate **1650 → 1471**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ⏳ P2.3e — širi PDF korpus i dalje nema positive target-SKU OCR tablicu

Korpus pod `benchmarks/output/**/documents` više nije procijenjen po broju run foldera: SHA-256
deduplikacija daje **306** različitih PDF sadržaja od 1.341 datoteke. Read-only `pdf-parse` scan prvih
dviju stranica našao je samo nekoliko native-text-sparse kandidata: CAD crteže, blank stranicu u
certifikatu, već poznati `P-P11R2-K3RF0-U450` cutout/list i SCE `12EL1206LP` swing-panel assembly list.

Postojeći OCR na zadnjem listu prolazi kvalitetu (56 confidence; score 82), ali sadržaj je generička
assembly instrukcija (`EL/XEL Wallmount Enclosures`, mounting holes) i **ne ispisuje** `SCE-12EL1206LP`
niti target tablični red. Nije fixture: iz nje se ne smije zaključiti dimenzija ili atribut za taj SKU.
Ovaj prošireni korpus zato ne opravdava labavljenje confidence/identity praga; P2.3 ostaje otvoren samo
za budući stvarni sken koji na istoj stranici objavljuje target SKU i njegovu vrijednost/tabličnu kolonu.

### ✅ P2.2h — continuation header staje na novoj katalog-tablici

Službeni Rockwell `1606-TD002H` već je u repou kao customer dokument. Na p. 25 tablica `Power Supplies
with Integrated Decoupling Function` objavljuje `1606-XLE240ERL` u prvom stupcu: `Output Current, Nom =
10 A` i `Adjustment Range = Fixed`. Prethodna p. 22 sadrži kraći, različiti `1606-XLE240E` s
`Adjustment Range = 24…28V`; ona ostaje važan kontraprimjer za strict header identity.

Novi value-verified fixture je prvo pao: normalizirani current bio je `10 A / 20 A`, iako ciljna ćelija
jasno kaže samo `10 A`. Istraga je odvojila dva kvara. Prvo, label je na p. 25 vodoravno rascijepljen u
`Output` + `Current, Nom`; reader sada drugi fragment uzima samo sa iste baselinije u praznom prostoru
između label-stupca i prve data-kolone. Drugo i presudno, header p. 25 nastavljao se kroz kasnije,
nepovezane tablice koje opet počinju s `Catalog Number`, pa je reader njihove `20 A`, `3 A`, `7.5 A`…
retke pokušavao projicirati na stari target stupac i konzervativni merge je zatim odbacio pravi 10 A.

Sada svaki novi `Catalog Number` header prekida carried grid prije čitanja vrijednosti. Stranica bez
vlastitog target headera smije naslijediti grid samo ako nema takav strukturni dokaz nove tablice. Time
reader za isti stvarni PDF vraća `Output Current, Nom = 10 A` i `Adjustment Range = Fixed`; finalni
current prelazi **`10 A / 20 A` → `10 A`**, bez toleriranja sibling raspona.

Puni gate: TypeScript čist; root Vitest **2245/2245**; eval **25/25**, **284** provjera, 0
kontaminacija/gapova; spec-gate **1650 → 1471**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P2.1j — susjedna PDF tablica za drugi SKU nije target kontekst

Isti novi Rockwell fixture zatim je pokazao zaseban, nizvodni propust: cilj je na p. 25, ali ciljani
tekstualni read namjerno uzima i jednu susjednu stranicu. P. 24 počinje vlastitom `Catalog Number`
tablicom za 380…480 V modele i ne spominje `1606-XLE240ERL`; generic tab-prolaz je zato u targetov
Attributes izvozio, primjerice, `24V = 5 A | 120 W | 2 AC 380…480V | — | 1606-XLE120E-2`.

To nije vrijednost koju treba kasnije rangirati ili maskirati: čitava stranica je strukturno nova tablica
za druge kataloge. `selectPdfTextFromPageSet` i veliki-PDF ekvivalent sada zadržavaju neighbour samo
ako nije takva samostalna catalog-tablica bez točnog targeta. Continuation bez novog headera ostaje
dopušten, pa se ne gubi legitimni nastavak targetove tablice.

A/B za isti fixture je **96 → 69** atributa. Svih 27 uklonjenih redaka dokazano je šum: šest redaka
380…480 V p. 24 nosi `1606-XLE96B-2`/`120E-2`/`240E-3`/`960…` siblinge, a preostalih 21 su njihovi
multi-column aggregatei (`85.4% | 90.4% | …`, `500 g`, `16.4 W / 12.7 W / …`) ili susjedne
`1606-XLD…`/`1606-XLERED` tablice. Nijedan nije targetova p. 25 vrijednost; `Output Current, Nom =
10 A` i `Adjustment Range = Fixed` ostaju prisutni. Fixture sada izričito odbija `1606-XLE120E-2`.

Puni gate nakon sužavanja na jaki ID-header: TypeScript čist; root Vitest **2245/2245**; eval
**25/25**, **285** provjera, 0 kontaminacija/gapova; spec-gate **1650 → 1471**, **0 SUSPECT /
0 garbage**; label audit A/C/D/E = 0. Eaton `CBE03319` je posebna regresija: njegova zajednička
`Technical Data` stranica nema ID header ni target SKU, ali se zadržava i daje `230/400 V`, `IP20`,
`-25…70 °C`, `500 V` i `6 kA`.

### ✅ P1.3p — responsive grid iza dva layout omotača nije jedan atribut

`audit:page-attrs` je na cacheiranom službenom Schmersal PDP-u `101164207` (`AZM
161SK-12/12RK-024`) našao novu parent-kompoziciju. Sekcija `Mechanical data - Connection technique`
ima šest pravih dvostupčanih redaka (`Cable entry`, `Termination`, oba cable-section polja, `Note`,
`Allowed type of cable`), ali je uz njih izlazio i jedan lažni atribut koji cijeli sadržaj lijepi u
vrijednost naslova sekcije.

Novi fixture je prije korekcije pao na tom aggregateu uz 91 atribut. DOM pokazuje točan uzrok:
`section → border div → alternating-row div → rows`; stari `hasNestedSpecGrid` gledao je samo jedan
layout omotač. Sada konzervativno provjerava još jednog neposrednog potomka i isključivo traži već
postojeći dokaz najmanje tri leaf label/value retka. Leaf činjenice ostaju dokazive: `Cable entry =
4 x M16 x 1,5` i `Cable section, minimum = 0.25 mm²`; rezultat je **91 → 89**, uz uklonjen samo
lažni parent zapis i njegov duplicate put.

Puni gate: TypeScript čist; root Vitest **2245/2245**; eval **26/26**, **288** provjera, 0
kontaminacija/gapova; spec-gate **1650 → 1471**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P0.2f — kontakt footer nije plain-text specifikacija

Read-only HTML audit na službenom SCE PDP-u `SCE-12EL1206LPLG` našao je `Plain Text` par
`(800) 234-6871 - Fax = (989) 799-4524`. Isti PDP jasno objavljuje `Part Number =
SCE-12EL1206LPLG`; telefon/fax je isključivo kontakt-footer i nema produktno značenje.

Novi fixture prvo pada na fax vrijednosti. `extractPlainTextAttributes` sada odbija par samo kada
njegova labela eksplicitno kaže tel/phone/fax/e-mail **i** vrijednost zaista izgleda kao telefon ili
e-mail. Zbog oba uvjeta se ne blokira tehnički `Contact configuration: ...`. A/B je **7 → 6**
atributa: uklonjen je samo fax, target part number ostaje.

### ✅ P1.1k — Livewire framework stanje nije produktni atribut

Službeni Balluff PDP `BAE00M3` nosi i vidljive specifikacije (`Output capacity max. = 720 W`) i
desetke `wire:snapshot` komponenti. Generic JSON prolaz je iz njih izvozio PHP serialization metadata
(`Illuminate\\Support\\Collection`, `App\\Domains\\…`) te `memo/children` hash i UI-state kao
`Livewire Snapshot` atribute.

Novi fixture prvo pada na dva class-namea, zatim na stvarnom memo hash-u. Reader sada odbija framework
class-name vrijednosti neovisno o putanji te, ali samo u `Livewire Snapshot` grupi, memo/children/scripts/
assets/errors i nekoliko jasnih UI switch-pathova. Ne blokira product identity ili dokumente: `sku =
BAE00M3`, `orderCode`, `productLabel` i vidljivi `720 W` ostaju. A/B je **75 → 51** atribut; 13
uklonjenih su PHP class-nameovi, 11 Livewire runtime/memo zapisa, nijedan nije produktna činjenica.
Isti fixture je naknadno uhvatio i raw JS izraz `this.focusedIndex … this.filteredSearchTerms`; uski
plain-text runtime filter ga odbija bez dodirivanja običnih vrijednosti. Konačni A/B je **75 → 50**:
13 PHP class-nameova i 12 Livewire/JS runtime zapisa.

Daljnji audit istog fixturea izolirao je osam preostalih raw UI redaka (`cookieBannerHeight`,
`focusedIndex`, search-term limiti, `stickyFooterHeight` i Tailwind `rounded-xl …`). Oni imaju
imenovani browser-state key ili nedvosmislen CSS utility value; `isPlainTextRuntimePair` sada odbija
samo te oblike. Konačni rezultat je **75 → 42**: dodatnih osam nisu produktni podaci, a nijedna
vidljiva specifikacija/identitet nije izgubljen.

Puni gate nakon korekcije: TypeScript čist; root Vitest **2245/2245**; eval **28/28**, **297**
provjera, 0 kontaminacija/gapova; spec-gate **1650 → 1471**, **0 SUSPECT / 0 garbage**; label audit
A/C/D/E = 0.

### ✅ P1.1l — Typo3 runtime i prepolovljeni URL nisu specifikacije

Read-only `audit:page-attrs` preko službenih Ganter PDP-ova našao je raw fallback parove
`wait_for_update = 500,` i `Information and contribution at https = //typo3.org/`. Oba dolaze iz
frontend konfiguracije/attributiona, ne iz tablice proizvoda. Postojeći value-verified fixture za
`GN 3310-19-LK-K2` je prvo proširen s dvije tvrde zabrane i zatim korektno pao na obje vrijednosti.

`isPlainTextRuntimePair` sada odbija isključivo exact `wait_for_update` runtime key i fragmentirani
URL oblik gdje je `https:` završio u labeli, a vrijednost počinje s `//host`. Ne odbija običnu
tehničku labelu s podvlakom niti dokument URL koji je čitav u svojoj vrijednosti. A/B na fixtureu je
**45 → 43** atributa; s `PRODUCT_SCRAPER_DISABLE_SPEC_GATE=1` fixture i dalje prolazi svih 10
provjera pri 162 sirova atributa, pa uklanjanje nije nuspojava downstream gatea.

Puni gate: TypeScript čist; root Vitest **2245/2245**; eval **28/28**, **299** provjera, 0
kontaminacija/gapova; spec-gate **1650 → 1471**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P1.1m — frontend konfiguracija i SVG CSS nisu tehnički atributi

Širi read-only audit reprezentativnih snimljenih PDP-ova našao je dva ponovljiva raw-fallback oblika:
nVent VWO skripta daje `settings_tolerance = 500,`, a ABB/Ganter inline SVG daje `fill = #1f1f1f;`
odnosno `#4e4e4d;`. To nisu tolerance proizvoda ni finish; to su browser konfiguracija i CSS
deklaracije. Postojeći value-verified nVent `A6R44HCR` i Ganter `GN 3310-19-LK-K2` fixturei su prvo
prošireni tvrdom zabranom i oba su korektno pala na jednoj jedinoj vrijednosti.

Raw runtime filter sada odbija točan `settings_tolerance` key te `fill` samo ako je vrijednost CSS
heksadecimalna boja s završnim `;`. Default A/B je **58 → 57** (nVent) i **43 → 42** (Ganter), bez
gubitka njihovih value-verified polja. nVentova puna fixture asertacija s ugašenim globalnim spec-gateom
namjerno pada na starim certificate/document šumovima, pa je dokaz za ovu promjenu izoliran direktno
na sirovom parseru: pri 203 nVent i 162 Ganter atributa oba nova zabranjena oblika imaju **0 hitova**.

### ✅ P1.1n — VWO page-hiding bootstrap se odbija prije spec-gatea

Isti nVent source je u raw prolazu još davao `hide_element = 'body'` i raspadnuti
`hide_element_style='opacity = 0 !important …`. Postojeći fixture već tvrdo odbija `!important`, ali
to je prije ove korekcije prolazilo samo zato što ga je kasniji plausibility gate uklanjao. To nije
dovoljno: raw atributi prolaze više putova i moraju biti čisti na izvoru.

Runtime filter sada odbija samo VWO `hide_element` / `hide_element_style` key-obitelj, uključujući
assignment-split labelu. Izolirani raw parser s ugašenim spec-gateom nakon promjene ima **0**
`hide_element*` i `!important` hitova; stvarne nVent specifikacije fixturea ostaju nepromijenjene.

### ✅ P1.1o — marketinška kartica nije atribut samo zato što ima h2 i paragraf

Ganter PDP u dnu stranice ponavlja karticu `Ganter Catalogue` s tekstom “many exciting ideas” i
CTA-om “Order free Catalogue”. Dva su generička puta to čitala kao `Page Evidence` atribut: loose
label/value čitač i h2→sljedeći-paragraf fallback. Fixture `GN 3310-19-LK-K2` prvo je pao na obje
marketinške vrijednosti.

Oba puta sada odbijaju samo `Page Evidence` catalogue par koji nosi eksplicitni CTA/promotivni tekst;
kataloški broj i stvarni dokument/katalog ostaju mogući. A/B je **42 → 39** atributa; s ugašenim
spec-gateom **162 → 159** uz svih 13 fixture provjera, pa rezultat nije skriven downstream filtrom.

### ✅ P1.1p — Livewire popis jezika datasheeta nije specifikacija artikla

Read-only audit Balluffovih snimljenih PDP-ova otkrio je da je raniji Livewire filter provjeravao samo
zadnji segment JSON putanje. Zato je `datasheetLanguages / pl = Polish` ostao izvezen: `pl` nije
runtime key, ali mu je roditelj čisti UI popis jezika za download. Postojeći value-verified
`BAE00M3` fixture prvo je dobio tvrdu zabranu `Polish` i korektno pao baš na tom atributu.

Livewire path filter sada odbija `datasheetLanguages` u bilo kojem segmentu putanje; product identity,
document URL-ovi i vidljiva specifikacija `Output capacity max. = 720 W` nisu obuhvaćeni. A/B je
**42 → 41** atribut na `BAE00M3` i **38 → 37** na drugom Balluff fixtureu, uz sve postojeće vrijednosne
asertacije. Puni gate: TypeScript čist; root Vitest **2245/2245**; eval **28/28**, **304** provjere,
0 kontaminacija/gapova; spec-gate **1650 → 1471**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P2.1k + P2.2i — headerless PDF comparison panel mora pobijediti široki family red

Službeni Allen-Bradley `1492-J3` PDF (`A117-CA001A-EN-P`, p. 12-8) ima tri eksplicitna stupca
`1492-J3`, `1492-J4` i `1492-J6`, ali gornja comparison tablica nema `Cat. No.` header. Prijašnji
reader zato je preskočio točan grid i generic tab-text prolaz izvezao `Maximum Current = 25 A | 20 A |
24 A | 21 A | 35 A | …`; `35 A` počinje susjedni J4 stupac. Niže na stranici ordering blok dodatno je
izvozio `Grey | 1492-J3 | 100 | 1492-J4 | 1492-J6` kao da je boja J3.

Novi value-verified fixture prvo je pao na `35 A`, `1492-J4` i `1492-J6`. Position reader sada smije
sintetizirati headerless comparison anchor samo iznad nižeg eksplicitnog ID-headera, samo iz najmanje
dva numerička variant tokena i samo ako panel dokazano nosi gusti red podstupaca. Granica target panela
uzima midpoint prema susjednom panelu; najbliža value-baseline sprječava da se `AC/DC` ili susjedni
wire-range red spoji s `Maximum Current`. Za J3 rezultat je točno `25 A 20 A 24 A 21 A` i više ne sadrži
J4/J6 vrijednosti.

Kad taj pozicijski dokaz postoji, generički kandidat ostaje za normalno single-value konfliktno
rangiranje, ali se uklanja ako sadržava više mjerenja od target-panel retka ili ako target i sibling SKU
stvarno dijele isti family red. To je strukturni, ne vendor-specifični dokaz: postojeći test za jedan
pojedinačni, ali pogrešan `Efficiency` kandidat iz 1606-XLS tablice i dalje zahtijeva oba konkurenta.
Uklonjeno je 1492 family-šum: široki current `Feature` red, višestupčani current agregat, Color/variant
redovi i ordering-code feature retci s J4/J6. To nisu J3 atributi. Istina `Color = Grey` je vidljiva u
izvoru, ali niži row-oriented ordering blok reader još ne rekonstruira; fixture ju nosi kao eksplicitni
`normalized:color` known gap umjesto da se kontaminirana boja prikaže kao točna.

Puni gate: TypeScript čist; root Vitest **2246/2246**; eval **29/29**, **310** provjera, 0 kontaminacija
i 1 otvoreni, dokumentirani color gap; spec-gate **1649 → 1470**, **0 SUSPECT / 0 garbage**; label
audit A/C/D/E = 0.

### ✅ P1.3q — višeretčani option blok ne smije spojiti target K2 sa siblingom S025

Read-only audit šest Ganterovih cacheiranih PDP-ova našao je da službeni `GN 3310-19-LK-K2` i dalje
izvozi tablični red `Connection type Cable with open end (K2 / K5) or Cable with plug (S025) = PUR
cable … 5-pin connector …`. Izvorni HTML ima jednu colspan label ćeliju s dva option bloka te dvije
odvojene `<p>` vrijednosti. K2 je cable-open, dok je 5-pin connector stvarno S025 sibling.

Postojeći value-verified fixture prvo je proširen tvrdom zabranom točnog connector teksta i korektno je
pao. Reader sada zadržava granice paragrafa, prepoznaje najmanje dva `(option-code)` bloka i bira samo
onaj čiji je kod dio traženog kataloga. Oblik bez jednog jednoznačnog optiona šuti; obični aligned
multiline redovi ostaju na starom putu. K2 izlaz zadržava `PUR cable with open stranded wires (2 m or
5 m)`, a S025 connector više nije emitiran. To je uklonjen sibling šum, ne izgubljena K2 činjenica.

Puni gate: TypeScript čist; root Vitest **2246/2246**; eval **29/29**, **311** provjera, 0
kontaminacija i 1 raniji dokumentirani color gap; spec-gate **1649 → 1470**, **0 SUSPECT / 0 garbage**;
label audit A/C/D/E = 0.

### ✅ P1.3w — sibling katalog-kod ne smije postati HTML property label

Read-only parse službenog Fath fixturea `6SAME4J316B.4000` pokazao je zaseban oblik varijantnog šuma:
comparison tablica je kroz generički leaf sweep izvezla sibling SKU-ove
`6SAMB1J313B.2000` i `6SAME4J316B.2000` kao imena atributa, iako su to option-kolone, ne svojstva.
Raniji `isForeignVariantOptionValue` guard pokrivao je samo kod u vrijednosti, pa je ovaj slučaj ostao
neuhvaćen. Test je prvo pao na stvarnom `fixtures/fath-6SAME4J316B-4000-page/page.html`.

Generic final filter sada prepoznaje samo uski oblik standalone kataloškog tokena s internim separatorom
i odbacuje ga ako `findCatalogTextMatch` ne potvrdi exact traženi broj. Time se uklanjaju oba sibling labela,
ali target `6SAME4J316B.4000` ostaje; metadata labele poput ECLASS/ERP nisu pogođene. Na ciljnom fixtureu
izlaz je **77 → 75** atributa: uklonjena su dva lažna property-label retka, bez gubitka target činjenice.

Puni gate: TypeScript čist; root Vitest **2262/2262**; eval **34/34**, **352** provjere, 0 kontaminacija i
1 raniji dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P1.3x — upload ograničenje ne smije postati product `Size`

Read-only replay službenog Rockwell PDP-a `1606-XLS120E` pokazao je page-furniture oblik koji nije tablica:
generic text sweep je iz upload forme izvukao `Size = 5 MB`, iako proizvodni fixture ima stvarne tehničke vrijednosti
za `Size`/dimenzije. Test je prvo pao na postojećem `fixtures/rockwell-1606-XLS120E-page/page.html`.

Dodao sam uski završni filter koji odbacuje samo atribut s imenom `Size` čija vrijednost počinje numeričkim
`KB`/`MB`/`GB` limitom, numerički izbor `Items Per Page`, te točan JS marker `page = pageViewData`. Time se ne dira
`Size = 120 x 80 x 30 mm` ni druge dimenzijske vrijednosti. Na fixtureu je izlaz **114 → 111** atributa: uklonjeni su
upload-limit, paging kontrola i JS state, bez gubitka `Weight = 620 g` i ostalih provjerenih činjenica.

Na istom fixtureu read-only document audit našao je i `/table`, `/zip`, `/x-zip` i `/x-zip-compressed` kao hrefove
iz widgeta. Zajednički URL classifier ih sada odbija samo kada su točno root MIME/type tokeni bez queryja; pravi
`/files/product.zip` ostaje dozvoljen. To uklanja četiri lažna dokumenta, bez diranja stvarnih ZIP/DXF/PDF linkova.

Puni gate: TypeScript čist; root Vitest **2264/2264**; eval **34/34**, **352** provjere, 0 kontaminacija i
1 raniji dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P2.1m — stacked-dimension fallback ne smije posuditi siblingovu tablicu

Postojeći Siemens-stacked čitač imao je precizan redni put (`stackedRowNamesDifferentCatalog`), ali njegov
posljednji regex fallback nije primao katalog uopće. Ako je red siblinga bio dovoljno loše izvučen da precizni
reader nije proizveo atribut, fallback je ipak mogao vratiti siblingove dimenzije i težinu traženom SKU-u.

Regresija je prvo pala na istom stacked obliku koji već pokriva `BPZ:VSG519K15-5`: dokument navodi samo
`Product BPZ:VSG519K15-6`, ali je stari fallback vratio `DN 20 ... 6.0 kg`. Popravak prosljeđuje katalog u
fallback i provjerava samo section nakon `Dimensions` plus prethodne retke koji eksplicitno nose Product/Catalog/
Article/Model/Part/SKU/Type oznaku. Normativni i certifikacijski tokeni poput `A5W00023883` zato ne mogu lažno
ugasiti target-only tablicu, dok sibling-only tablica ostaje prazna.

Puni gate: TypeScript čist; root Vitest **2261/2261**; eval **34/34**, **352** provjere, 0 kontaminacija i
1 raniji dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P2.1l + P2.2j — grupirani PDF header i završni colspan pripadaju target SKU-u

Službeni Rockwell `1769-PB4` datasheet (`1769-TD008C-EN-P`, p. 6) ima četiri tehnička stupca. Četvrti
header je jedna PDF.js ćelija `1769-PB4, 1769-PB4K`; redovi `Input voltage range` i `Input voltage,
nom` imaju samo tri fizičke ćelije jer zadnja ćelija dokazano prekriva PB2/PB4 kraj retka. Prijašnji
čitač grupirani header nije mogao povezati s PB4, pa je generic PDF put normalizirao PA2/PA4 AC
raspon i spajao sva četiri current retka.

Novi value-verified fixture prvo je pao na `85...265 V AC`, `2.0 A | 4.0 A` i cijeli family `24V`
current red. Header tokeni se sada rastavljaju samo u eksplicitno coalesced header ćeliji (zarez,
točka-zarez, pipe ili novi red), nikad iz proizvoljnog proznog teksta. Ako targetu nedostaje vlastita
fizička value ćelija, reader smije preuzeti neposredno lijevu samo kada najbliža baseline ima točno po
jednu ćeliju za svaki prethodni stupac i nijednu za target — dokazani trailing colspan, ne sibling
heuristika. `PDF Electrical Text` kandidat s istom labelom potom se odbacuje samo kada postoji
pozicionirani target dokaz.

PB4 sada daje `Input voltage range = 19.2...31.2 V DC`, nominalnih `24V DC`, `Current capacity @ 5V =
4.0 A` i `@24V = 1.7 A`; PB4K dijeli isti fizički stupac i nije konflikt. `1492-J3` i
`1606-XLE240ERL` regresije su ciljano ponovno provjerene: usko rastavljanje headera ne smije vratiti
njihove sibling vrijednosti. Puni gate: TypeScript čist; root Vitest **2247/2247**; eval **30/30**,
**318** provjera, 0 kontaminacija i 1 raniji dokumentirani color gap; spec-gate **1691 → 1482**,
**0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P2.2k — row-oriented PDF tablica može imati `Cat. No.` na kraju

Službeni Rockwell `1492-EAJ35` PDF (`1492-TD015A-EN-P`, p. 43 / tiskana p. 44) ima End Barriers
tablicu s fizičkim svojstvima lijevo i `Cat. No.` na desnom rubu. Stari row reader pretpostavljao je
identifikator u prvom stupcu; generic sweep je zato zadržavao `Grey 100 1492-EAJ35` kao neimenovani
Feature, a normalizator je birao dimenziju drugog dijela dokumenta.

Novi value-verified fixture prvo je pao na nedostajuće target dimensions, torque, Color i Pkg Qty te
na taj flattenani Feature. Kad dokazani `Cat. No.` stoji zadnji, reader sada čita lokalni višeretčani
header-band i mapira ćelije najbližem property headeru; smije spojiti samo uski višeretčani band oko
točno pronađenog target SKU-a. Normalne first-column tablice zadržavaju strogu jednoradnu granicu.
Generički `Feature` se dodatno odbacuje samo ako nosi target SKU i najmanje dvije neovisno
pozicionirane vrijednosti istog retka. Target sada daje `8 x 56 x 47 mm`, `Torque = 4.4 lb-in`,
`Color = Grey` i `Pkg Qty. = 100`, bez flattenanog retka. Puni gate: TypeScript čist; root Vitest
**2248/2248**; eval **31/31**, **326** provjera, 0 kontaminacija i 1 raniji dokumentirani color gap;
spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P1.1q — CAD cookie wall nije PDP i ne smije spaliti HTML audit

Široki read-only `audit:page-attrs` zastao je iza 150 cacheiranih stranica na službenom ABB
PartCommunity URL-u za `1SDA126426R1`. Izvor nije CAD/PDP sadržaj: `No Third-party Cookies
supported` i `Please enable cookies in your browser for PARTcommunity to work` stoje uz 20 UI tablica
i 105 skripti. Generic parser je, unatoč postojećem discovery upozorenju za isti URL oblik, prolazio
kroz sve tablice i trošio minute bez ijedne produktne činjenice.

Novi test prvo reproducira oba stvarna wall markera i zabranjuje UI table atribut. Parser sada preskače
samo span-aware HTML table reader za kombinaciju točnog `abb-control-products.partcommunity.com` hosta
i obje poruke; normalne CAD/PDP stranice nisu pogođene. Male, jasno označene
`editable-part-header → editable-part-input-column` locked redove čita zasebno, pa stvarni cache i
dalje zadržava `Product Class = Accessory` bez UI tablica. Ciljani A/B ostaje ispod sekunde umjesto
višeminutnog table mining prolaza. Puni gate: TypeScript čist; root Vitest **2249/2249**; eval
**31/31**, **326** provjera, 0 kontaminacija i 1 raniji dokumentirani color gap; spec-gate
**1691 → 1482**, **0 SUSPECT / 0 garbage**; label audit A/C/D/E = 0.

### ✅ P1.3r — obrađena target-tablica ne smije kroz ARIA filter vratiti sibling stupac

`fixtures:extract -- --list` je prije prvo sekvencijalno radio `stat` nad svim cacheiranim PDP
datotekama, čak i kada je operator tražio samo `--vendor gan --limit 1`. Zato je discovery stvarnog
novog HTML oblika znao premašiti interaktivni timeout prije izbora kandidata. Selekcija vendor/katalog
sada se radi u SQL-u prije filesystem provjere, provjera putanja je ograničeno paralelna, a novi
in-memory regresijski test čuva da se suženje ne vrati iza skeniranja cijelog korpusa.

Tako je iz cachea izvađen službeni Ganter `GN 3310-19-LK-K5` PDP i ručno pročitan prije pisanja
`expected.json`. Izvor izričito navodi `K5 - Cable, end open, 5 m`; priority-tablica ima zajednički
K2/K5 `d = 6` te odvojeni sibling `S025 = 5`. Sam `html-table-reader` točno bira K5/K2 stupac, ali
generički ARIA fallback je nakon toga čitao filter `<select aria-labelledby="t-1-c-2">` i ponovno
izvozio `Connection type S025 = 5`. Novi value-verified fixture prvo je pao baš na tom retku.

ARIA i semantic fallback sada oba preskaču tablicu koju je span-aware reader već označio kao obrađenu;
tablica koja readeru nije dokaziva ostaje dostupna postojećim fallbackovima. A/B za K5 je **38 → 34**
atributa: uklonjeni su (1) duplicate filter `A/F = 22` — isti činjenica ostaje iz readera; (2)
`Connection type S025 = 5` — sibling šum; (3) duplicate `d Connection type K2 / K5 = 6` — target
činjenica ostaje iz readera; (4) duplicate `Installation opening = 19 +0,1 / +0,3` — target činjenica
također ostaje iz readera. K5 option i sve tri normalizirane source činjenice ostaju.

Puni gate: TypeScript čist; root Vitest **2251/2251**; eval **32/32**, **337** provjera, 0
kontaminacija i 1 raniji dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**;
label audit A/C/D/E = 0.

### ⏳ P2.3e — OCR kandidat mora biti vidljiv, reproduktibilan i target-bound prije nove heuristike

Jednokratni ručni pregled 92 PDF-a iz ranijeg korpusa više nije dovoljan nakon što je offline
`benchmarks/output` narastao. Novi read-only `npm run audit:ocr-corpus` deduplicira datoteke po
SHA-256, čita isti native tekst kao produkcijski `pdfPagesNeedingOcr` gate i za svaku sparse stranicu
ispisuje kratki native uzorak. Alat ne radi OCR, ne piše fixture i ne mijenja rezultat; njegova jedina
svrha je pronaći dokaz za sljedeću OCR promjenu ili dokazati da ga nema.

Trenutni prolaz: **287 jedinstvenih PDF-a** od 1.487 dokumentskih kopija, 12 s barem jednom sparse
native stranicom i 0 nečitljivih. Većina su prazni CAD/crteži, naslovnice ili sadržaj. Dva naizgled
relevantna slučaja provjerena su stvarnim OCR-om: `SCE-AC3400B120V` daje prihvatljiv tekst (confidence
57), ali to je sadržaj priručnika, ne target-SKU tablica; `PS1C1269B` je nacrt kabinetâ s confidence
46 i quality gate ga pravilno odbija. Raniji `P-P11R2-K3RF0-U450` scan ostaje negativni fixture:
target nije dokazani red tablice. Nema pozitivnog target-bound OCR tabličnog primjera, pa prag 55 i
strogi positioned reader ostaju nepromijenjeni — spuštanje praga bi bilo nagađanje, ne poboljšanje.

Puni gate nakon novog audita: TypeScript čist; root Vitest **2251/2251**; eval **32/32**, **337**
provjera, 0 kontaminacija i 1 dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0
garbage**; label audit A/C/D/E = 0.

### ✅ P2.3f — reusable OCR worker ne smije blokirati završetak jednokratnog procesa

Stvarni OCR probe nad `SCE-AC3400B120V` vratio je valjan rezultat, ali je ostavio dva JS Tesseract
workera živima nakon što je promise već završen. To je dobar cache za dugovječni server, ali loš za
jednokratni `tsx` audit/test: proces je ostajao aktivan bez daljnjeg rada. Novi regression test prvo je
pao jer `unrefOcrWorker` nije postojao.

`pdf-ocr.ts` sada workere drži `ref()` samo dok barem jedan OCR poziv stvarno radi; kad se zadnji poziv
završi, `unref()` ih pušta da cache ostane dostupan živom serveru, ali ne drži CLI proces na životu.
Brojač čuva paralelne OCR pozive: prvi ih referencira, zadnji ih odreferencira. Browser-backed worker bez
Node `ref`/`unref` API-ja je no-op. Stvarni Saginaw probe i dalje vraća isti rezultat (confidence 57,
7 positioned redaka), a neposredno nakon završetka procesa nema zaostalih Node worker procesa.

Puni gate: TypeScript čist; root Vitest **2252/2252**; eval **32/32**, **337** provjera, 0
kontaminacija i 1 dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**;
label audit A/C/D/E = 0.

### ✅ P3.1k — novi vendor ne čeka osam potpunih promašaja za adaptivni put

Originalni `mission-control` prag od osam uzoraka značio je da potpuno novi službeni host s tri
uzastopna `failed`, score-0 pokušaja još uvijek nema drift signal, iako je svaka činjenica govorila da
primarni put ne radi. To nije isti slučaj kao tri miješana onboarding rezultata: prerano proglašenje
drifta za njih bi samo trošilo fallback budžet.

Novi `target-health-policy.ts` je jedan vlasnik odluke za runtime i DB read-model. Normalni prag ostaje
8 uzoraka (success <45 % ili average quality <45), ali strogi bootstrap već od 3 uzorka prolazi **samo**
kada je success rate 0 i average quality 0. Runtime tada pokreće adaptive mining; operational summary
prikazuje isti `driftSuspected`, pa dashboard i pipeline ne mogu proturječiti jedan drugome. Ciljani
regresijski test prvo je pao na starom “not enough samples” odgovoru, zatim pokriva catastrophic 3/3,
2/2 (još prerano) i miješani 3-sample slučaj (bez drifta), plus isti DB window.

Puni gate: TypeScript čist; root Vitest **2255/2255**; eval **32/32**, **337** provjera, 0
kontaminacija i 1 dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**;
label audit A/C/D/E = 0.

### ✅ P0.1d — novi OCR corpus audit ima nemutirajući `--help`

Novi `audit:ocr-corpus` je prvotno primao `--help` kao nepoznatu opciju i svejedno pokretao puni
deduplicirani PDF scan. To nije sigurnosni ni izlazni defect, ali za višeminutni offline audit je
operativno pogrešno i vraća već zatvoreni P0.1 problem pomoćnih alata. Novi mali test najprije je pao
na odsutnom `parseOcrCorpusOptions`, zatim zahtijeva i `--help` i `-h`. Oba sada ispišu usage i završe
prije otvaranja korpusa; potvrđeno je direktnim `npm run audit:ocr-corpus -- --help` pozivom.

Puni gate: TypeScript čist; root Vitest **2256/2256**; eval **32/32**, **337** provjera, 0
kontaminacija i 1 dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**;
label audit A/C/D/E = 0.

### ✅ P1.3s — search-result nije PDP i ne smije pokrenuti puni HTML sweep

`audit:page-attrs -- --limit 200` na cacheu nije stvarno stao iza 150. Novi read-only `--trace`
pokazao je da ABB PartCommunity cookie-wall sada brzo prolazi, ali zatim svaki 672 kB ABBlvp.no
WordPress URL oblika `?s=<catalog>` troši oko 18 s u generičkom parseru. Snimljeni
`1SDA126474R1` HTML u `<title>`, breadcrumbu i Yoast JSON-LD eksplicitno kaže
`SearchResultsPage`; kartica, košarica i linkovi u njemu nisu PDP činjenice.

Fixture je najprije ručno označen kao value-verified negativni slučaj i regression test je pao:
parser je vratio `partial` s atributima nakon 18 s. `parseGenericProductPage` sada nakon jeftinog
title čitanja prepoznaje isti postojeći unresolved-search dokaz i odmah vraća prazan `failed`
rezultat. `GenericFallbackScraper` i dalje nakon tog povratka pokreće `discoverProductLinks…`, pa
search stranica smije dovesti do exact PDP-a, ali joj se produktni podaci više ne pripisuju.

Ciljani fixture sada ima 0 atributa i prolazi 6/6 za 0,1 s; stvarni `audit:page-attrs -- --limit 200`
prolazi svih 200/200, bez parse greške. Novi `--trace` samo ispisuje start/done URL oko svakog
read-only parser poziva kada je potrebno izolirati idući cache outlier.

Puni gate: TypeScript čist; root Vitest **2258/2258**; eval **33/33**, **343** provjere, 0
kontaminacija i 1 raniji dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**;
label audit A/C/D/E = 0.

### ✅ P1.3t — responsive multiple values nisu jedan zalijepljeni token

`audit:page-attrs -- --host products.schmersal.com --contains IP65IP67 --trace` pronašao je stvarni
Schmersal PDP `131029963`: responsive red `IP Degree of protection` emitirao je `IP65IP67`, a
`Note (Relative humidity)` `non-condensingnon-icing`. To nisu dvije slučajno spojene specifikacije:
službeni product payload za isti artikl ima `values: ["IP67", "IP65"]`, dok vidljivi red prikazuje
zasebne inline spanove `IP65` i `IP67`; isto vrijedi za `non-condensing` i `non-icing`.

Novi value-verified fixture i test najprije su pali na `normalized.protection = IP67; IP65; IP65IP67`.
U `childElementSpecPair` value strana sada samo za čiste sibling inline leafove bez vlastitog teksta
zadržava granicu `; `; label strana i složeniji DOM ostaju na starom text putu. Završni choke point
zatim deduplicira isključivo male, eksplicitno prepoznate neuređene liste (IP/IK/NEMA/Type protection
tokeni te `non-condensing`/`non-icing` za taj humidity label). Tako structured source ostaje prvi
(`IP67; IP65`), DOM duplikat nestaje, a dimenzije, rasponi i slobodan tekst se ne sortiraju niti spajaju.

Puni gate: TypeScript čist; root Vitest **2259/2259**; eval **34/34**, **347** provjera, 0
kontaminacija i 1 raniji dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**;
label audit A/C/D/E = 0.

### ✅ P1.3u — dva responsive retka nisu jedan label/value par

Širi read-only `audit:page-attrs -- --limit 600` nad cacheom našao je Schmersal `101164207` izlaz
`Rated insulation voltage Ui250 VAC = Rated impulse withstand voltage Uimp; 4kV`. Službeni product
payload i vidljivi DOM iste stranice jasno imaju dva odvojena reda: `Rated insulation voltage Uᵢ =
250 VAC` te `Rated impulse withstand voltage Uimp = 4 kV`. Dobre pojedinačne činjenice već su bile
prisutne; loša je dodatni, izmišljeni cross-row par.

Postojeći fixture je prvo proširen ručno provjerenim UI/Uimp asertacijama i zabranom lažne vrijednosti,
a novi regression test je korektno pao. Uzrok je bio parent-grid guard: smatrao je gridom tek tri
dokaziva leaf retka. Dvije responsive specifikacije zato su se tretirale kao label i value. Guard sada
prepoznaje dva cjelovita leaf retka kao grid; pojedinačni stvarni red i dalje ima dvije ćelije, ali te
ćelije same nisu label/value redovi. Ciljani A/B je **87 → 86** atributa: uklonjen je samo lažni par,
dok `Ui = 250 VAC` i `Uimp = 4 kV` ostaju.

Puni gate: TypeScript čist; root Vitest **2260/2260**; eval **34/34**, **350** provjera, 0
kontaminacija i 1 raniji dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**;
label audit A/C/D/E = 0.

### ✅ P1.3v — responsive section-heading nije atribut jednog leaf retka

Isti službeni Schmersal `101164207` PDP nakon P1.3u još je sadržavao drugi neovisni artefakt:
`Approvals - Standards = CertificatesCCCcULusIFA`. Stvarni payload i vidljivi DOM dokazuju da je
`Approvals - Standards` naslov grupe, a jedini responsive red ispod njega je
`Certificates = CCC; cULus; IFA`. Nije dopušteno popraviti to samo brisanjem izlaza: fixture najprije
zahtijeva stvarni `Certificates` podatak i zabranjuje slijepljeni heading izlaz.

Uzrok su heading i `aria-labelledby` fallbackovi: prepoznavali su samo grid s više redaka pa su kroz
tri neutralna responsive layout-omotača pojedinačni leaf red čitali kao vrijednost naslova grupe.
Novi ograničeni strukturni guard prepoznaje leaf red sa dvije do osam nenested ćelija i prolazi najviše
četiri layout sloja; ne radi opći rekurzivni scrape. Ciljani A/B je **86 → 85** atributa: uklonjen je
samo izmišljeni heading par, dok `Certificates` ostaje.

Puni gate: TypeScript čist; root Vitest **2260/2260**; eval **34/34**, **352** provjere, 0
kontaminacija i 1 raniji dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**;
label audit A/C/D/E = 0.

### ✅ Handoff checkpoint — P1.3x + document URL furniture

Ovdje je rad predan sljedećem agentu. Read-only replay službenog Rockwell PDP-a
`1606-XLS120E` pokazao je tri lažna produktna izlaza (`Size = 5 MB`, numerički `Items Per Page`,
`page = pageViewData`) i četiri lažna document URL-a (`/table`, `/zip`, `/x-zip`,
`/x-zip-compressed`). Regresije su prvo pale na postojećem value-verified fixtureu; uski filteri
zatim uklanjaju samo te UI/JS/MIME tokene, dok `Size` dimenzije, `Weight = 620 g` i stvarni
ZIP/DXF/PDF dokumenti ostaju.

Zadnji puni gate: TypeScript čist; root Vitest **2264/2264**; eval **34/34**, **352** provjere,
0 kontaminacija i 1 dokumentirani color gap; spec-gate **1691 → 1482**, **0 SUSPECT / 0 garbage**;
label audit A/C/D/E = 0. Detaljan copy/paste handoff i prvi Claude prompt su u
[`docs/CLAUDE-HANDOFF.md`](CLAUDE-HANDOFF.md). Sljedeći agent treba krenuti read-only detectorom
za novi stvarni PDF/layout slučaj, ne još jednim naslijepo proširenim heuristicom.

### ✅ P2.2n — `PART #` id-header, jednoslovni ordering-tablica stupac i leading-id page-branching gap

Read-only detector (ad-hoc skripta, ne dio repoa) pokrenut nad `extractPositionedTableRowsFromPdf`
protiv 830 datasheet/manual PDF-a iz `benchmarks/output/*/documents` tražio je stranice gdje target
katalog dijeli vizualni red s ≥2 brojčano-izgledna susjeda, a reader ipak vraća `undefined` — heuristika
za "ovo izgleda kao tablica koju bismo trebali pročitati, a ne čitamo je". Jedini realan hit (nakon
isključivanja 800F-X10-datasheet-Product-Cutsheet.pdf-a koji je oštećen/korumpiran PDF, nepovezano) bio
je Saginaw/SCE `SCE-FK0618-manual-Floor-Stand-Hole-Layout.pdf`: stvarna `PART # | A | B` ordering
tablica s 27 sibling floor-stand kataloga.

Sirovi pdfjs-dist dump potvrdio je ground truth: header `PART #`(x=298.8,y=618.8) / `A`(x=364.2) /
`B`(x=400.9); target red `SCE-FK0618`(x=290.7,y=569.4) / `6.00`(x=358.8) / `18.00`(x=393.8). Novi
value-verified fixture `fixtures/sce-fk0618-floor-stand-manual/` prvo je pao (`ATTRIBUTE-MISSING
attribute:B`), zatim su probom protiv stvarnog PDF-a redom otkrivena **tri** zasebna, stvarna bug-a
(ne jedan): (1) `isCatalogIdHeaderCell` nije prepoznavao `#` kao `No.`/`Number` alternativu za
`part`/`order`/`article`/`item`/`model`/`catalog`; (2) `extractPositionedOrderingRow`'s header-filter
`cleanText(text).length > 1` je odbacivao jednoslovne stupce `A`/`B` (zamijenjen testom na barem jedno
slovo/broj, i dalje odbija golu interpunkciju); (3) isti reader's leading-id vrijednosni match
(`Math.abs(item.x - header.x) <= columnXTolerance`) je dvostruko brojao vrijednost u oba susjedna
stupca kad je razmak stupaca (35pt) manji od `2×tolerance` (30pt) — zamijenjen `nearestIndex`, isti
princip kao već postojeći trailing-id branch. Nakon sva tri, `extractPositionedTableRowsFromPdf`'s
page-branching i dalje je vraćao `undefined` na PUNOM PDF-u (iako je izolirani poziv radio): budući da
`PART #` sad broji kao `isComparisonMatrixLabelHeaderCell`, `hasNewCatalogHeader` grana se aktivirala,
ali imala je kod samo za `hasTrailingCatalogHeader` slučaj — četvrti popravak rutira leading-id granu
na `extractPositionedTableRows` (koji već ima interni fallback na `extractPositionedOrderingRow`)
umjesto tihog ispuštanja.

Puni gate nakon sva četiri popravka otkrio je **dvije stvarne regresije**, obje s legitimnim uzrokom
(bolja ekstrakcija je promijenila oblik postojećeg podatka, ne pokvarila ga) i obje popravljene
ažuriranjem asercije na novo, provjereno ispravnije ponašanje:
- `eaton-cbe03319-family-catalog` fixture: page-6 ordering red za `CBE03319`/`E6-1/1/B` sad ide kroz
  isti pozicijski reader (leading-id grana sad radi za taj oblik) i ispravno vraća `Unit per package =
  12` (točan ground truth iz `_source`); `discardUnscopedFamilyTableCandidates` je zato ispravno
  uklonio stariji `Matched product row` tekst-blob kao zastarjeli duplikat. Asercija zamijenjena
  preciznijom (`Unit per package`), stari podatak nije izgubljen — samo bolje strukturiran.
- `tests/generic-multivalue.test.ts` (HTML put, `html-table-reader.ts` dijeli `catalog-table-vocabulary.ts`):
  fath24 komparativna tablica ima `Part #` stupac; sad prepoznat kao id-header, tablica ide kroz
  strukturirani `attributesForRow` čitač umjesto stare naivne `<a>`-link-text putanje koja je
  (slučajno) proizvodila atribut IMENOVAN samim kataloškim kodom. Asercija zamijenjena provjerom
  čistog `Sku = 6SAME4J316B.4000` atributa; sibling `.2000`-kod guard nepromijenjen.
- Petu, samostalnu regresiju otkrio je isti puni gate: bare-word stupac-header "A" (case-fold u "a")
  padao je na `spec-plausibility.ts`'s `LABEL_LEADING_DETERMINERS` provjeri namijenjenoj presječenim
  rečenicama ("The safety and protection…") — svaki postojeći primjer tog pravila ima 2+ riječi, pa je
  suženo na `tokens.length >= 2`; test dodan da "A"/"B"/"a"/"The" prežive, a "A remote" i dalje pada.

Puni gate: TypeScript čist; root Vitest **2267/2267**; eval **35/35**, **367** provjera, 0
kontaminacija i 1 raniji dokumentirani color gap; spec-gate **1694 → 1485**, **0 SUSPECT / 0 garbage**
(brojevi +3/+3 nasuprot baseline — nova stvarna, čista polja iz istog 120-dokumentnog korpusa, ne
kontaminacija); label audit A/C/D/E = 0.

**Preostali rizik / negativni nalazi:** ostatak od 830 skeniranih PDF-a nije dao drugi dokaziv
target-bound layout gap (samo ponovljeni `800F-X10` korumpirani PDF, nepovezano s ovim popravkom).
Nisam širio `#`-alternativu na DE/FR/IT id-header sinonime (`Bestell-Nr.`, `Référence`, …) jer korpus
nema dokaz za `#` u tim jezicima — samo EN `part`/`order`/`article`/`item`/`model`/`catalog` + `#`.
