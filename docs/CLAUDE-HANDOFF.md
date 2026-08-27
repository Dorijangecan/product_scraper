# Claude handoff — product_scraper

Datum zadnjeg provjerenog checkpointa: 2026-08-24.

## Najnoviji ABB performance checkpoint

`src/server/scrapers/abb.ts` sada koristi službeni `PisWebApi/v1/Products/Detail` endpoint
(token se kešira po procesu) prije sporih ABB HTML ruta. PIS payload se normalizira kroz postojeći
`parseAbbProductPage`, pa ne postoji drugi parser ni nagađanje vrijednosti. HTML ostaje fallback,
image-only put API namjerno preskače, a ponovljeni timeout na istom URL-u više se ne plaća tri puta.

Mjereno na `Testing PDT/ABB SPEED TEST.csv`: 59/59 kataloga ispod 30 s, median 1,11 s, p95 26,7 s,
max 26,9 s. 50 je `found`; devet `1SBL…005…` legacy ID-eva vraća prazan PIS detail i dobiva samo
jedan HTML rescue. ABB regresije su u `tests/parsers.test.ts`; puni gate je zelen (Vitest 2270/2270,
eval 35/35, 367 provjera, 0 contamination, spec-gate 0 SUSPECT, labels A/C/D/E 0).

Ovaj checkpoint nije commitan ni pushan. Prije produkcijskog push-a treba potvrditi s kolegama žele
li legacy `1SBL…005…` redove ostaviti kao `failed` nakon jednog rescue prozora ili dodati njihov stvarni
službeni URL/fixture; nemoj ih označiti kao nepostojeće samo zato što PIS API nema zapis.

## Gdje je rad stao

Rad je stao nakon zatvaranja **P1.2l** u `docs/COLD-START-PLAN.md` (§0c). ABB performance checkpoint
iznad je zaseban, paralelan rad (nije dio P0–P3 fazne tablice) — pogledaj taj odjeljak zasebno prije
nego dirneš `abb.ts`.

**P1.2l (najnovije):** `npm run audit:spec-gate -- --limit 500 --samples 40` (ŠIRI uzorak od defaultnog
120-dokument prozora koji svaki puni gate koristi) prvi put je pokrio dovoljno korpusa da nađe stvaran
**SUSPECT** (regresija po alatovoj definiciji) — `GN-6336-32-other-Metric-ISO-Thread-DIN-13.pdf ::
material = "steel"`. Provjera preko `pdftotext -layout` potvrdila je da dokument NE spominje
`GN-6336-32` nigdje — generička DIN 13 ISO metric thread tolerance tablica čiji tekst kontrastira
steel/metal thread s plastic thread da objasni SVOJ opseg, ne materijal specifičnog proizvoda.
Uzrok: `normalizer.ts`'s `deriveMaterialFromAttributes` skenira svaki "Feature"-imenovani red kroz
`materialValueFromText`, koji golom keyword-regexom hvata "steel" bez provjere generic-standard
oblika. Popravak: novi `isGenericThreadToleranceStandardText` (uzorak: `isAccessoryOrderWarningMaterialText`)
— traži "tolerance(s)" I "thread(s)" ZAJEDNO s "without steel or metallic thread insert" ili "steel /
metal threads". VAŽNO: gate je SLUČAJNO već skrivao ovu vrijednost u zadnjih 120 dokumenata (zato
default `audit:spec-gate` NIJE ovo pokazao) — popravak je namjerno na IZVORU inferencije, ne na gateu,
jer se gate ne smije koristiti kao siguran filter za pogrešnu inferenciju. Mjereno: širi audit sad
`0 SUSPECT / 24 garbage` (bilo `1/24`). Novi fixture `fixtures/gan-GN-6336-32-generic-thread-standard-datasheet/`
+ unit test u `tests/normalizer.test.ts` (potvrđeno PADA bez popravka).

Prije toga zatvoren je **P2.4n**: read-only `npm run audit:discovery` (offline replay, postojeći alat) našao je
stvaran, ponovljiv bug: FATH's `homepageUrl` (`fath.com`) je DRUGA apex domena od njegovog stvarnog
kataloga (`fath24.com`, u `officialBaseUrls`), a `officialVariantUrls` (discovery.ts) je i homepageUrl
tretirao kao ravnopravnu bazu za DIREKTNO URL-guessing (nagađanje `{base}/products/{variant}` itd.),
iako je `officialUrlBases` (koju ta funkcija ponovno koristi) izvorno namijenjena SAMO search/form
probingu — homepageUrl je legitiman ulaz ZA search, nikad baza za guess koji glumi stvarnu
product-URL putanju. Rezultat: `https://www.fath.com/en/6sacp3j316b2000` (pogrešna domena) je
pobjeđivao stvarni fath24.com URL u replay rangiranju. Popravak: `officialVariantUrls` sad filtrira
na baze čija origin odgovara `officialBaseUrls`-u; `officialUrlBases`'s šira uporaba (search/form)
nepromijenjena. Novi regresijski test u `tests/discovery.test.ts` potvrđeno PADA bez popravka (ručno
provjereno) prije nego je zapisan. Mjereno: FATH top-kandidat sad je `fath24.com/product/...`
(ispravna domena; puni URL OBLIK i dalje pogrešan — nema dovoljno dokaza za nagađanje punog opisnog
sluga, ostaje otvoreno, namjerno). Gan/Siemens/Eaton top-kandidat neslaganja u istom izvještaju su
ista domena kao officialBaseUrls (URL-oblik ili locale gap, već poznato) — nisu novi nalaz.

Prije toga zatvoren je **P1.1s**: read-only `npm run audit:page-attrs -- --limit 1200` (širi mješoviti korpus)
našao je stvaran Ganter (ganternorm.com) `<br>`-lijepljeni atribut: `Contact type = LK - ...(no
switching function)Connection type: K2 - Cable, end open, 2 m`. Uzrok: `<div class="product-image__
caption">Contact type: LK - ...(no switching function)<br />Connection type: K2 - ...</div>` — dvije
neovisne "Label: value" linije spojene SAMO s `<br>`; `hasNestedBlockContent` ne broji `<br>` kao
blokirajući element, pa `splitNameValue($(row).text())` fallback dobije spojen tekst bez razmaka.
Popravak: novi `hasBrJoinedMultiColonLines` u `generic.ts` (≥1 `<br>` I ≥2 dvotočke u tekstu → odbij
fallback), primijenjen na oba mjesta koja dijele isti kod (`extractSectionAwareSpecAttributes`,
`extractLooseChildPairAttributes`). Novi fixture `fixtures/gan-GN-3310-19-LK-K2-glued-value-page/`
(novija DB-cachirana snimka iste PDP nego postojeći sibling fixture — Ganter je template promijenio
otkad je stari snimak uzet). Usput: popravak je uhvatio isti obrazac i na STAROM sibling snimku
(35→34 atributa na oba), iako ga nijedna postojeća asercija nije tražila.

Prije toga zatvorena su DVA performance popravka: (1) `enrichResultFromDownloadedDocuments` sad
obrađuje dokumente u bounded batchevima (`DOWNLOADED_DOCUMENT_BATCH_SIZE=3`); (2)
`extractPositionedWeightDimensionsSafely` više ne otvara isti PDF drugi put preko `pdfjs-dist` —
posegne u `pdf-parse`-ov privatni `doc` i ponovno koristi već učitani dokument. Pun opis oba u
`docs/COLD-START-PLAN.md` §0c pod "⚙️ Performance" i "⚙️ Performance (nastavak)".

Prije performance popravaka zatvoren je **P1.1r** (kineski Balluff zh-cn cookie-consent banner — `spec-plausibility.ts`
sad odbija label/value koji riječ "cookie"/"cookies" spominje 2+ puta, jezično-neutralan signal), a
prije njega **P2.2n** (Saginaw/SCE `PART #` id-header + pozicijski reader popravci). Puni opis oba u
`docs/COLD-START-PLAN.md` §0c pod "P1.1r" i "P2.2n".

Kod koji je zadnje mijenjan (P1.2l): `src/server/scrapers/normalizer.ts`
(`isGenericThreadToleranceStandardText`, pozvan iz `materialValueFromText`);
`fixtures/gan-GN-6336-32-generic-thread-standard-datasheet/` (novi fixture);
`tests/normalizer.test.ts`; `docs/COLD-START-PLAN.md` — §0b stanje i §0c dnevnik.

Prije toga (P2.4n): `src/server/scrapers/discovery.ts` (`officialVariantUrls` sad
filtrira na `officialBaseUrls`-origine); `tests/discovery.test.ts` (novi regresijski test).

Prije toga (P1.1s): `src/server/scrapers/generic.ts` (`hasBrJoinedMultiColonLines`,
oba poziva u `extractSectionAwareSpecAttributes`/`extractLooseChildPairAttributes`);
`fixtures/gan-GN-3310-19-LK-K2-glued-value-page/` (novi fixture); `tests/generic-multivalue.test.ts`.

Prije toga (performance): `src/server/scrapers/document-enrichment.ts`
(`enrichResultFromDownloadedDocuments` batch obrada, `readPdfPageSet`/`capturePositionedPagesFromParser`
native positioned-item reuse); `src/server/scrapers/pdf-positioned-table.ts`
(`extractPositionedTableRowsFromPages`, `extractPositionedWeightAndDimensionsFromPages`);
`tests/document-enrichment.test.ts` (novi batch-boundary test).

## Zadnje metrike

Zadnji puni offline gate nakon P1.2l:

- TypeScript: čist;
- Vitest: **2283/2283**, 119 test files;
- eval: **38/38**, **390** provjera, 0 failed, 0 errored, 0 contamination hits, 1 namjerni/dokumentirani color gap;
- spec gate (120, default): **1694 → 1485**, **0 SUSPECT / 0 garbage** (nepromijenjeno);
- spec gate (500, širi uzorak — `-- --limit 500 --samples 40`): **0 SUSPECT / 24 garbage** (bilo
  **1 SUSPECT / 24 garbage** prije popravka — jedini SUSPECT je bio ovaj);
- label audit: A/C/D/E = **0**;
- audit:discovery: 47%/51%/70% (#1/top3/found) nepromijenjeno — FATH top-kandidat sad ispravna
  domena (`fath24.com` umjesto `fath.com`), puni URL oblik ostaje otvoren.

Ne commitati. Radno stablo je namjerno prljavo i sadrži mnogo ranijih promjena/fixtura. (Napomena: u
prošlosti su se pojavili commitovi izvan ovog dogovora — `cd27a30`, `e5488ea`, `7537c5d` — vjerojatno
od paralelne sesije. Provjeri `git log`/`git status` prije nego pretpostaviš da je stablo prljavo.)

## Što još ostaje

Otvorene faze:

1. **P2.1 PDF „ne znam” (~82 %)** — šire kalibriranje stvarnih PDF tablica i target-bound ordering-code dokaza.
2. **P2.2 pozicijski PDF engine (~90 %)** — samo novi stvarni layout koji postojeći reader ne može sigurno pročitati.
3. **P2.3 OCR (~90 %)** — pozitivna kalibracija na skeniranom dokumentu koji stvarno ispisuje target SKU u tablici.
4. **P2.4 discovery (~86 %)** — širi vendor/cache replay, ali samo uz službeni exact-SKU non-search dokaz.
5. **P3.1/P3.4 (~80/~78 %)** — PDF learning recipeji i šira replay/wizard politika.

Važni negativni nalazi koje ne treba ponovno promovirati:

- `800F-X10` family legend nema target-bound poziciju za taj SKU (i dalje se ponavlja kao korumpirani
  PDF u `benchmarks/output/*` — "Invalid PDF structure", nepovezano s bilo kojim readerom);
- ETA `W01D` token nije dokaz za `D01X = ...` code/value red;
- pregled velikih offline PDF-ova nije našao strogu kombinaciju target SKU + ordering heading + deklarirana pozicija + `CODE = value`;
- discovery miss bez službenog cacheiranog exact-PDP dokaza nije siguran kandidat za heuristic fix;
- `#`-alternativa za id-header NIJE proširena na DE/FR/IT sinonime (`Bestell-Nr.`, `Référence`, …) —
  korpus nema dokaz za `#` u tim jezicima, samo za EN `part`/`order`/`article`/`item`/`model`/`catalog`;
- `hasRepeatedCookieMention` (P1.1r) je namjerno samo za riječ "cookie"/"cookies" — nije proširen na
  druge consent/legal riječi (npr. "GDPR", "隐私政策") jer korpus (700-page uzorak) nema drugi dokazan
  slučaj gdje bi to bilo potrebno; širi audit:page-attrs sweep preko 700 uzoraka nije našao drugu
  kontaminacijsku klasu osim ove;
- naivan `Promise.all` za dokumente NIJE pravi speed fix (izmjereno ~6.5%, ne ono što bi paralelizam
  sugerirao) jer je Node.js jednonitni za JS — CPU-bound `pdfjs-dist` rad se samo isprepliće, ne
  izvršava usporedno; bounded-batch (3) je zadržan zbog stvarnog `worker_threads` OCR dobitka i I/O
  preklapanja, ne zbog CPU paralelizma koji ne postoji;
- dupli PDF parse (`extractPositionedWeightDimensionsSafely`) je RIJEŠEN reuse-om `pdf-parse`-ovog
  internog `doc` polja (vidi gore) — ali samo za CACHE-ELIGIBLE (≤8 MB) put kroz `readPdfPageSet`.
  `readPdfText`'s streaming grana za velike (>8 MB) datoteke i `enrichResultFromRemoteDocuments`
  (network fetch put) i dalje NEMAJU ovaj reuse — `extractPositionedWeightDimensionsSafely`'s novi
  `nativePositionedItemsByPage` parametar je opcionalan i pada natrag na file-reopen kad nije
  proslijeđen, pa je siguran, ali coverage nije potpun. Šira primjena je moguća, ali velike obiteljske
  PDF-ove (koji bi najviše profitirali) treba prvo izmjeriti — ne pretpostaviti da je isti postotak;
- izmjereni ~9% dobitak (zagrijani proces) je manji od prvotne ~30-45% procjene zbog jednokratnog
  `pdfjs-dist` cold-start troška koji je zbunio izolirani single-catalog benchmark — vidi
  `docs/COLD-START-PLAN.md` §0c "⚙️ Performance (nastavak)" prije nego ponovno mjeriš na isti (pogrešan)
  način; uvijek dodaj warm-up poziv prije mjerenja u istom procesu.

## Pravila nastavka

1. Prvo read-only detector/probe, zatim fixture koji stvarno pada, tek onda kod.
2. Ne promovirati `actual.json` u `expected.json`; ground truth se čita iz stranice/PDF-a.
3. Ne koristiti brojeve linija iz stare analize; tražiti simbole po imenu.
4. Ne mijenjati kod dok `tsx` audit već radi.
5. Za svaku izmjenu provjeriti kontraprimjer i objasniti promjenu broja atributa/dokumenata.
6. Ne širiti heuristiku ako korpus nema dokazani layout.

## Offline gate

U PowerShellu prvo:

```powershell
$env:PATH='C:\Program Files\nodejs;' + $env:PATH
```

Nakon izmjene pokrenuti:

```powershell
npx tsc --noEmit
npx vitest run tests --maxWorkers=1
npx tsx scripts/eval.ts
npm run audit:spec-gate
npm run audit:labels
```

Prihvatljivo je samo čisto TypeScript, svi testovi, eval bez kontaminacije, 0 SUSPECT i čisti A/C/D/E.

Povremeno (kad tražiš novi P1.2-stil nalaz, ne za svaki puni gate) vrijedi i šire pokriti korpus:
```powershell
npm run audit:spec-gate -- --limit 500 --samples 40
```
Default `audit:spec-gate` (120 dokumenata) NE pokriva dovoljno korpusa da nađe rjeđe SUSPECT-e —
`P1.2l` je pronađen samo širim uzorkom.

## Prvi prompt za Claudea

Kopiraj cijeli ovaj prompt:

```text
Nastavi rad na product_scraper repou iz docs/CLAUDE-HANDOFF.md i docs/COLD-START-PLAN.md §0b.

Ne kreći od pretpostavke da treba još jedan generic heuristic. Zadnji zatvoreni checkpoint je P1.2l:
`npm run audit:spec-gate -- --limit 500 --samples 40` (ŠIRI od defaultnog 120-dokument prozora) našao
je stvaran SUSPECT (`material = "steel"` inferiran iz generičke DIN/ISO thread-tolerance standard
tekst na dokumentu koji ne spominje svoj katalog broj nigdje). Popravak je na IZVORU (`normalizer.ts`'s
`materialValueFromText`), ne na gateu, koji ga je slučajno već skrivao. VAŽNO za sljedeći detector:
default `npm run audit:spec-gate` (120 dok.) NE pokriva dovoljno korpusa da nađe rjeđe SUSPECT-e —
povremeno vrijedi pokrenuti `-- --limit 500 --samples 40` (ili veći) da se provjeri širi dio od 1337+
dokumenata u `benchmarks/output/`, ne samo default prozor.

Prije toga zatvoren je P2.4n: discovery.ts's officialVariantUrls je nagađao product-URL-ove i preko
homepageUrl-ove origine, ne samo officialBaseUrls-ove — stvaran bug za FATH (homepageUrl=fath.com,
stvarni katalog=fath24.com) gdje je pogrešna domena pobjeđivala u audit:discovery replayu. Popravak
filtrira guess-baze na officialBaseUrls origine; officialUrlBases-ova šira search/form-probing
uporaba nepromijenjena. FATH-ov URL OBLIK i dalje ostaje pogrešan (nema dokaza za nagađanje punog
sluga) — namjerno otvoreno, ne pogađaj ga.

Prije toga zatvoren je P1.1s: generic.ts sad odbija splitNameValue fallback kad red ima <br> I 2+
dvotočke u tekstu (hasBrJoinedMultiColonLines) — real Ganter image-caption div spajao je dvije
neovisne "Label: value" linije preko <br> u jednu vrijednost. Novi fixture je NOVIJA DB-cachirana
snimka iste Ganter PDP nego postojeći sibling fixture — vendor je promijenio template otkad je stari
snimak uzet; kad vadiš nove HTML fixture, provjeri prvo postoji li već sličan fixture s ISTIM URL-om
čija bi novija DB snimka mogla otkriti template promjenu.

Prije toga zatvorena su DVA performance popravka (batch document processing +
readPdfPageSet/capturePositionedPagesFromParser PDF double-parse fix) — pun opis, uključujući DVA
iskrena mjerena nalaza (naivan Promise.all ODBAČEN kao neefikasan; cold-process benchmark daje
lažno nizak broj, uvijek mjeri u zagrijanom procesu) u docs/COLD-START-PLAN.md §0c "⚙️ Performance"
i "⚙️ Performance (nastavak)". Prije toga P1.1r (kineski cookie-consent) i P2.2n (PART # id-header).

Zadnji puni gate je zelen: Vitest 2283/2283, eval 38/38, 390 provjere, 0 kontaminacija, spec-gate
(120) 0 SUSPECT (1694 -> 1485), spec-gate (500 širi uzorak) 0 SUSPECT / 24 garbage, label audit
A/C/D/E=0.

NAPOMENA: između radnih sesija su se pojavili commitovi izvan dogovora (vjerojatno paralelna sesija na
istom repou). Provjeri `git log --oneline -5` i `git status` PRIJE nego išta pretpostaviš o stanju
radnog stabla — ne pretpostavljaj da je prljavo ili čisto bez provjere. Baza `data/scraper.db` (1.4 GB)
može biti zaključana ako paralelna sesija upravo piše u nju — ne čekaj upit u beskonačnost, koristi
TaskStop i pređi na dokaz s filesystem/benchmark korpusa umjesto DB agregacije.

Tvoj sljedeći zadatak je P2.1/P2.2/P2.3/P2.4/P3.1 preostali dio. Prvo napravi read-only detector nad
offline PDF/HTML korpusom i pronađi layout koji postojeći reader stvarno čita pogrešno ili preskače.
Obavezno prvo dodaj fixture/test koji pada na stvarnoj stranici/PDF-u; nikad ne promoviraj actual.json u
expected.json i ne pogađaj vrijednosti. Ako nema dokazivog target-bound PDF/order/discovery slučaja,
zabilježi negativan nalaz u §0c umjesto da uvedeš heuristiku.

Prije bilo kakve izmjene pročitaj CLAUDE.md, PROJECT_MAP.md, docs/ARCHITECTURE.md, docs/COLD-START-PLAN.md
§0b/§0c i fixtures/README.md. Traži simbole po imenu, ne po starim brojevima linija. Ne mijenjaj kod dok
audit traje. Ne commitaj.

Nakon svake stvarne izmjene pokreni:
$env:PATH='C:\Program Files\nodejs;' + $env:PATH
npx tsc --noEmit
npx vitest run tests --maxWorkers=1
npx tsx scripts/eval.ts
npm run audit:spec-gate
npm run audit:labels

Ažuriraj docs/COLD-START-PLAN.md: stanje u §0b, kronologiju u §0c, točne metrike i objašnjenje svake
uklonjene ili zadržane vrijednosti. Na kraju mi javi: detector evidence, fixture/test, kod, metrike,
što je ostalo i je li korpus stvarno bolji.
```
