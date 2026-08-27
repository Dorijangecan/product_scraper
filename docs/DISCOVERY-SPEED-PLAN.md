# Plan: 30 s po article numberu, za sve proizvođače

> **Cilj:** ≤ 30 s po kataloškom broju, za SVE proizvođače, bez gubitka kvalitete.
> **Kvaliteta** = eval 38/38 s 0 kontaminacija, `audit:discovery` hit-rate se NE smije smanjiti,
> spec-gate 0 SUSPECT. Dnevnik izvedbe ide u [COLD-START-PLAN.md](COLD-START-PLAN.md) §0c.

Sve u §1 je **pročitano iz koda i izmjereno**, ne pretpostavljeno.

---

## 1. Izmjereni nalazi

### 1a. Danas NE postoji nikakav end-to-end rok po artiklu

Ovo je najvažniji nalaz. Pojedinačni timeouti se **sabiraju**, i svaki pojedinačno može sam
premašiti cijeli budžet od 30 s:

| Što | Timeout | Gdje |
| --- | ---: | --- |
| jedan HTTP zahtjev (default) | **30 000 ms** | `http-client.ts` (`options.timeoutMs ?? 30000`) |
| curl fallback za dokument | **130 000 ms** (`--max-time 120`) | `http-client.ts:662` |
| browser `page.goto` | **45 000 ms** | `browser-renderer.ts:404` |
| `networkidle` čekanja | 12 000 ms × više puta | `browser-renderer.ts:292,296,316` |
| neuspjeli fetch → curl retry | **udvostručuje** cijenu | `fetchTextViaCurl` |

Jedan zahtjev koji visi = cijeli budžet potrošen. **30 s je nedostižno bez tvrdog roka po artiklu**
— to je centralna izmjena ovog plana (faza **D2**), sve ostalo je smanjivanje potrošnje unutar roka.

### 1b. 18 slijepnih search pogodaka po SVAKOM katalogu

`genericOfficialSearchTemplates` (`discovery.ts`) po bazi generira:

```
11 query ključeva:  q, query, search, s, text, keyword, searchTerm, Ntt, k, article, partNumber
 2 dodatna oblika:  /search/{part}, /site-search?q={part}
                    → .slice(0, 18)
```

Za bilo kojeg vendora **najviše JEDAN** je stvarni search endpoint. Ostalih ~17 su promašaji — i
plaćaju se **na svakom kataloškom broju, u svakom runu, zauvijek**.

### 1c. Serijski, i svaki zahtjev plaća puni throttle

- `processSearchRequests` je `for...of` s `await` (cap **28** zahtjeva).
- `acquireHostSlot` serijalizira sve zahtjeve po hostu kroz `hostMinIntervalMs` =
  `max(100, floor(rateLimitMs / concurrency))`.

| proizvođač | rateLimitMs | conc. | **interval/req** | 18 pogodaka = |
| --- | ---: | ---: | ---: | ---: |
| eaton | 1500 | 5 | 300 ms | 5,4 s |
| abb, schmersal | 1500 | 4 | 375 ms | 6,8 s |
| doepke, eta, fath, nvent, phoenix, rockwell, scame, sce, schneider, siemens, spelsberg, turck | 1500 | 3 | 500 ms | 9,0 s |
| balluff | 1200 | 2 | 600 ms | 10,8 s |
| **gan** | **3000** | **1** | **3000 ms** | **54,0 s** |

`npm run audit:discovery`: **2466 promašaja / 100 kataloga ≈ 25 mrežnih zahtjeva po katalogu** —
potvrđuje da se budžet stvarno troši. Za `gan` to je ~75 s **čistog čekanja**, prije ijedne
milisekunde parsiranja. **gan danas strukturno ne može u 30 s.**

### 1d. Search se pokreće bezuslovno

```
1. direct templates      → add()  (BEZ fetcha)
2. learned endpoints     → add()  (BEZ fetcha)
3. processSearchRequests → FETCHA, serijski, do 28×   ← bezuslovno
4. search-form discovery → homepage fetch + parse
5. rendered/browser      → do 4 rendera (45 s goto svaki!)
6. sitemapi
7. url-variant guessovi  → add()  (BEZ fetcha)
```

Korak 3 se izvršava **i kad je korak 1/2 već dao kandidata scorea ~90+**. Sav search trošak plaćen
je PRIJE nego je itko probao jeftin high-confidence template.

### 1e. Zašto se ništa ne nauči (uzrok ponavljanja)

1. **`discoveryMemo` je per-ITEM, ne per-RUN** — kreira se *unutar* petlje po artiklima
   (`run-manager.ts:427`). Vendor-konstante se ponovno izvode za svaki kataloški broj.
2. **Uspješan search endpoint se ne pamti.** `learnConfirmedProductPage` pamti *PDP template*, ne
   *radni search endpoint*. `learnEndpointFromNetworkFetch` se za search zove **samo na
   browser/rendered putu** (`discovery.ts:249`) — plain-HTTP search koji USPIJE nikad ne postane
   naučena činjenica.
3. **Nema negativnog cachea** — da `?query=` za ovog vendora ne radi se ne pamti.

### 1f. Što je već ISPRAVNO (ne dirati)

- **Cache hitovi NE plaćaju throttle** — `fetchText` vraća iz cachea **prije** `acquireHostSlot`.
- Adaptivni `hostPenaltyMs` (429/503) i host circuit-breaker postoje i rade.
- `discoveryMemo` sprječava ponavljanje između *stageova istog artikla* (P2.4k).

---

## 2. Budžet od 30 s — raspodjela po fazama

Da bi 30 s bio dostižan, svaka faza mora imati **eksplicitan dio budžeta**:

| Faza | Budžet | Napomena |
| --- | ---: | --- |
| discovery (nalaženje PDP-a) | **6 s** | danas do ~75 s za gan |
| PDP fetch + parse | **5 s** | uklj. jedan retry |
| document discovery + download | **8 s** | paralelno, bounded |
| document enrichment (PDF parse) | **8 s** | već batchano (3 paralelno) |
| final completeness / repair | **3 s** | |
| **ukupno** | **30 s** | |

Iz toga slijede **tvrde posljedice** koje danas nisu zadovoljene:
- jedan HTTP zahtjev ne smije imati timeout 30 s → **max 6–8 s** unutar discoveryja
- curl document fallback od 130 s → **max 8 s**
- browser render (45 s goto) **ne može stati u budžet** → smije se pokrenuti samo ako je preostalo
  ≥ 12 s, s vlastitim tvrdim rokom, inače se preskače uz eksplicitan razlog
- cap od 28 search zahtjeva je besmislen pri 6 s discovery budžeta → efektivno ~8–10 za brze
  vendore, ~2–3 za `gan`

---

## 3. Plan po fazama

### D1 — Mjerni harness (PREDUVJET)

`audit:discovery` danas mjeri hit-rate, ali **ne vrijeme ni broj zahtjeva**.

Dodati (read-only, ne mijenja runtime): po katalogu broj zahtjeva, ukupno throttle-čekanje, wall
time, koji stage je pobijedio; agregat median/p95; `--baseline`/`--compare` za before/after diff.

**Kriterij:** svaki kasniji „ubrzali smo" mora doći iz OVOG alata, ne iz procjene.
**Rizik:** nema.

---

### D2 — Tvrdi rok po artiklu + graceful degradation (SRCE PLANA)

Bez ovoga 30 s nije SLA nego želja.

- Jedan `deadline` (npr. `AbortSignal` + `remainingMs()`) kreiran po artiklu, proslijeđen SVIM
  fazama. `itemScrapeController` (AbortController po artiklu) **već postoji** u `run-manager.ts` —
  ovo je njegovo proširenje u budžet, ne nova infrastruktura.
- Svaka faza **prije** skupog rada provjeri `remainingMs()` i:
  - ako ima budžeta → radi, s `timeoutMs = min(vlastiti, remainingMs)`
  - ako nema → **preskoči i zapiši eksplicitan razlog** (`reasonCode: "budget-exhausted:<stage>"`)
- Rezultat je **djelomičan + objašnjen**, nikad pogrešan. To se uklapa u već gotov P3.2
  (`FieldHealthRecord.reasonCode` razlikuje otkriće/parsiranje/scope/konflikt/not-published).
- Sniziti default timeoute na budžetne vrijednosti (§2).

**Rizik:** srednji. Mora se dokazati da rok ne reže **prije** nego je dokaz nađen za kataloge koji
danas prolaze — zato `audit:discovery` hit-rate stoji u guardrailima, i zato D1 ide prvi.

---

### D3 — Ne traži ako već znaš (najveći pojedinačni dobitak, mali rizik)

Gate na korak 3: **ne pokreći search ako već postoji kandidat utemeljen na DOKAZU**
(`hasEvidenceBackedCandidate` već postoji za sitemap gate — proširiti istu logiku).

- **Nikad** ne preskakati search kad je jedini kandidat `url-variant` guess (nagađanje ≠ dokaz,
  vidi P2.4n).
- Ispravniji redoslijed (veći zahvat): pusti pipeline da **verificira** jeftine high-confidence
  kandidate prije nego discovery eskalira na search (escalate-on-failure).

**Očekivano:** u audit replayu 47 % kataloga ima #1 hit → za njih search faza pada na 0 zahtjeva.

---

### D4 — Nauči vendorov radni search ključ jednom (najveći ponavljajući dobitak)

Kad search template proizvede potvrđen PDP, zapamti **oblik templatea** kao vendor-činjenicu.

- Sljedeći katalog: naučeni oblik **prvi**, ostalih 17 samo ako padne.
- Store: postojeća `learned_endpoints` tablica već ima
  `manufacturer_id / host / kind / pattern / success_count / last_success_at` → dodati `kind`
  `search-template`. Recency decay i suppression **već postoje**.
- **Negativni cache:** oblik koji za taj host vrati 404/nula rezultata dobiva TTL suppression.
- Ključati po **hostu**, ne samo `manufacturer_id` (vendor može imati različit ključ po lokalizaciji).

**Očekivano:** 18 → 1 pogodak od drugog kataloga nadalje. **Za `gan`: ~54 s → ~3 s.** Ovo je faza
koja `gan` uopće dovodi u domet 30 s.

---

### D5 — Run-level vendor cache (ne per-item)

Promovirati **vendor-invarijantne** činjenice iz per-item memoa u per-run scope: razriješena
search-form action/method, radni search ključ (unutar runa, prije DB upisa), sitemap index,
homepage `hreflang` alternates.

**Kritično:** cachirati SAMO vendor-invarijantno. **Nikad** per-katalog rezultate — to bi bila
cross-kontaminacija između artikala (klasa buga koju `mustNotContain` fixture-i love).

**Rizik:** srednji. Granica mora biti u tipu (`VendorDiscoveryFacts`, ne dijeljeni `Map<string, any>`),
da se per-katalog vrijednost ne može slučajno ubaciti.

---

### D6 — Rangiraj query ključeve po dokazu iz korpusa

Lista 11 ključeva je slučajnog redoslijeda, ne po hit-rateu. Read-only analiza `page_cache`
(15 298 URL-ova): koji oblici su **ikad** vratili rezultate, po vendoru i ukupno → preurediti, top-N
prvo. Čisto **redoslijed**, ništa se ne uklanja → pokrivenost ista.

---

### D7 — Token-bucket throttle (najrizičnija, radi zadnje)

Danas svaki zahtjev čeka **puni interval + vlastito response vrijeme** (latencije se slažu).
Predlog: token bucket s istom **prosječnom** stopom, ali dopuštenim burstom 2–3 po hostu.

**Rizik: NAJVEĆI.** `gan` je eksplicitno dokumentiran u configu:
> „ganternorm.com rate-limits an IP after a short burst (observed: ~37 rapid requests → the site
> starts dropping connections)"

→ **`gan` i svaki `concurrency: 1` vendor ostaje opt-out, strogo serijski.** Burst se uvodi
per-vendor uz mjerenje, nikad globalno.

---

## 4. Iskrena procjena dostižnosti 30 s

Ovo treba reći jasno prije nego se počne: **30 s kao tvrdi rok je dostižno. 30 s uz PUNU kvalitetu
na svakom artiklu nije — i to je odluka koju trebaš svjesno donijeti.**

| Slučaj | Danas | Nakon D2–D5 | Stane u 30 s? |
| --- | ---: | ---: | --- |
| ABB (već mjereno) | median 1,1 s / p95 26,7 s | bolje | ✅ već sad |
| tipičan vendor, direct template radi | ~10–15 s | ~4–8 s | ✅ komotno |
| tipičan vendor, treba search | ~25–35 s | ~8–12 s | ✅ |
| **gan** | **~75 s+** | **~10–18 s** | ✅ **tek nakon D4** |
| treba browser render (JS-only) | 45 s+ samo goto | rok ga reže | ⚠️ djelomično |
| treba veliki family PDF (57 str., 2,9 MB) | 10–20 s samo taj PDF | rok ga reže | ⚠️ djelomično |
| 9 legacy ABB `1SBL…005…` (prazan PIS) | 1 HTML rescue | nepromijenjeno | ✅ ali `failed` |

**Tradeoff:** manjina artikala (JS-only stranice, veliki obiteljski katalozi) trenutno traje > 30 s
zato što stvarno *treba* toliko. Uz D2 oni će vratiti **djelomičan rezultat + eksplicitan razlog**
(`budget-exhausted:<stage>`) umjesto potpunog. To je bolje od današnjeg stanja (gdje mogu trajati
3+ min), ali **je gubitak podatka za te artikle** — nije besplatno.

Dvije opcije, tvoja odluka:
- **(A) Tvrdi 30 s za sve** — predvidivo vrijeme, manjina artikala djelomična uz razlog.
- **(B) 30 s p95 + escape hatch** — tvrdi rok npr. 90 s, ali 30 s meki cilj: artikl koji je *na putu*
  da nađe dokaz smije prekoračiti. p95 ≤ 30 s, bez gubitka podatka.

Moja preporuka: **(B)**, jer izvorna pritužba projekta je „podatak se ne nađe ili je pogrešan" —
tvrdi rez koji baca podatak radi brzine radi protiv toga. Ali (A) je legitiman ako je predvidivo
vrijeme runa važnije. Reci koju hoćeš i po tome ću postaviti D2.

---

## 5. Kvalitetni guardraili (za SVAKU fazu, bez iznimke)

Ubrzanje se **ne priznaje** ako bilo što padne:

| Mjerilo | Prihvatljivo |
| --- | --- |
| `npx tsc --noEmit` | čisto |
| `npx vitest run tests --maxWorkers=1` | 100 % |
| `npx tsx scripts/eval.ts` | 38/38, 390 provjera, **0 kontaminacija** |
| `npm run audit:spec-gate` | 0 SUSPECT |
| `npm run audit:labels` | A/C/D/E = 0 |
| **`npm run audit:discovery`** | **#1 / top-3 / found NE pod 47 % / 51 % / 70 %** |
| **D1 harness** | zahtjevi/katalog i wall time **moraju** pasti, mjereno prije/poslije |
| 429/503 stopa | ne smije rasti (politeness je dio mjerenja, ne samo wall time) |

Pravila naučena u ovom repou (COLD-START-PLAN §0b):

1. **Brzina se ne kupuje tišinom.** Faza koja ubrza preskakanjem dokaza i vrati prazno polje je
   regresija, ne optimizacija — zato hit-rate stoji u guardrailima.
2. **Mjeri u ZAGRIJANOM procesu.** Već dokazano ovdje: cold-process benchmark dao je lažno nizak
   broj jer jednokratni `pdfjs-dist` import dominira prvi poziv. Warm-up + 3 ponavljanja.
3. **Ne mijenjaj kod dok audit radi** (`tsx` učita modul na startu procesa).

---

## 6. Redoslijed i procjena

| # | Faza | Dobitak | Rizik |
| --- | --- | --- | --- |
| 1 | **D1** mjerni harness | ✅ **SLETIO** — mjeri zahtjeve, throttle, pobjednički stage, po proizvođaču, `--compare` | nema |
| 2 | **D3** ne traži ako znaš | ✅ **SLETIO** — 22 → 11 zahtjeva medijan, −33 % ukupno, hit-rate isti, top-3 52,5 → 57,5 % | mali |
| 3 | **D4** nauči search ključ | ✅ **SLETIO** — 11 → 3 zahtjeva medijan, `schmersal` 11 → 1; `gan`/`fath`/`eaton`/`abb` offline nepromijenjeni (nema što naučiti iz korpusa) | mali–srednji |
| 4 | **D2** tvrdi rok + degradacija | **jedino što čini 30 s SLA-om** | srednji |
| 5 | **D5** run-level vendor cache | srednji | srednji |
| 6 | **D6** rangiranje ključeva | ✅ **SLETIO** — `npm run audit:search-shapes` dao dokaz; `/search/{part}` (182/184) bio nedostupan pri 2+ baze. Dobitak nevidljiv offline | mali |
| 7 | **D7** token bucket | srednji, per-vendor | **najveći** |

D3/D4 idu prije D2 namjerno: prvo smanji stvarnu potrošnju, pa onda postavi rok — obrnuto bi rok
rezao posao koji je još uvijek nepotrebno velik, pa bi degradacija bila češća nego što mora biti.

---

## 7. Što NE raditi

- **Ne dizati `concurrency`/`rateLimitMs` globalno kao „rješenje".** Ne uklanja 17 nepotrebnih
  zahtjeva, samo ih brže ispaljuje — a za `gan` je dokazano da izaziva drop konekcija.
- **Ne skraćivati listu query ključeva bez dokaza iz korpusa.** Uklanjanje oblika koji je nekom
  vendoru jedini radni = tihi gubitak pokrivenosti.
- **Ne cachirati per-katalog rezultate na run razini** (D5) — cross-kontaminacija.
- **Ne uvoditi burst za `concurrency: 1` vendore.**
- **Ne postavljati rok bez razloga u dijagnostici.** Artikl koji je odrezan mora reći gdje i zašto,
  inače „nema podatka" i „nismo stigli" postaju nerazlučivi — točno ono što P3.2 rješava.

---

## 8. Izmjereno stanje po proizvođaču (nakon D1 + D3)

`npx tsx scripts/audit-discovery.ts --limit 160`. `wait` = modelirano hladno throttle čekanje
(zahtjevi × per-host interval), **bez** latencije odgovora — dakle donja granica.

| proizvođač | n | hit@1 | hit | zahtjeva (med) | ms/req | wait (med) | tko daje odgovor | što još treba |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `sce` (Saginaw) | 17 | 100 % | 100 % | **1** | 500 | **0,5 s** | localized-template 17/17 | ništa — ovo je etalon |
| `rockwell` | 18 | 100 % | 100 % | **1** | 500 | **0,5 s** | localized-template 18/18 | ništa |
| `balluff` | 18 | 94 % | 94 % | **1** | 600 | **0,6 s** | localized-template 17/17 | ništa |
| `nvent` | 8 | 0 % | 100 % | 3 | 500 | 1,5 s | direct-template 8/8 | rangiranje: točan je nađen, ali ne na #1 |
| `siemens` | 6 | 0 % | 0 % | 3 | 500 | 1,5 s | — | ground truth je CZ lokal, WW template ga ne pogađa → **lokalizacija** |
| `turck` | 4 | 0 % | 50 % | 6 | 500 | 3,0 s | search-result 2/2 | mali uzorak; specs ionako u PDF-u iza JS tabova |
| `schmersal` | 17 | 100 % | 100 % | 11 | 375 | 4,1 s | search-result 17/17 | njegov search radi i configuriran je → **D4** ga svodi na ~1 |
| `abb` | 18 | 33 % | 100 % | 26 | 375 | 9,8 s | url-variant 12/18 | **rangiranje**: točan URL se nađe, ali nagađanje pobjeđuje dokaz |
| `eaton` | 18 | 33 % | 72 % | 30 | 300 | 9,0 s | direct-template 6/13 | **lokal**: traži se `/no/no-no/`, nudi se `/gb/en-gb/` (ista stranica, drugi jezik) |
| `fath` | 18 | 0 % | 6 % | 27 | 500 | 13,5 s | search-result 1/1 | PDP je slug (`/en/<Ime>/<kat>`); radi samo **search redirect** → **D4** |
| `gan` (Ganter) | 18 | 0 % | 0 % | **29** | **3000** | **87,0 s** | — | nijedan template ne potvrđuje → probe ne opali, plaća se puni search. **Jedino D4 ga spašava** |

**Kako čitati:** `hit` je donja granica (katalog čija search stranica nikad nije cachirana ne može se
offline ponovno otkriti — zato `gan`/`fath`/`siemens` imaju nisku vrijednost koja NIJE nužno živa
stopa neuspjeha). `zahtjeva` i `wait` su, nasuprot tome, **stvarni** — to je ono što bi živi run platio.

**Tri odvojena problema, ne jedan:**

1. **Cijena** (`gan` 87 s, `fath`/`eaton`/`abb` ~10–14 s) — rješava **D4** (nauči radni search ključ) i
   **D2** (tvrdi rok). D3 ovdje ne pomaže jer se probe ne aktivira bez templatea koji potvrđuje.
2. **Rangiranje** (`abb` hit 100 % ali hit@1 33 %, `nvent` 0 % hit@1 uz 100 % hit) — točan URL se nađe,
   ali `url-variant` nagađanje ga nadglasa. Pipeline zato dohvaća krive stranice prije točne.
3. **Lokalizacija** (`eaton`, `siemens`) — nađe se ista stranica na drugom jeziku. Za `eaton` je to
   vjerojatno **lažni promašaj audita** (obje stranice postoje i obje su točne); za `siemens` nije,
   jer CZ PDP nosi podatke kojih na WW nema.
