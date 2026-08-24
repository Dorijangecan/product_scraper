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

Rad je stao nakon zatvaranja checkpointa **P2.2n** u `docs/COLD-START-PLAN.md`:

- Saginaw/SCE floor-stand-kit ordering tablica ima `PART #` id-header (# umjesto `No.`/`Number`) —
  `isCatalogIdHeaderCell` ga sad prepoznaje za catalog/part/order/article/item/model;
- `extractPositionedOrderingRow` više ne odbacuje jednoslovne stupac-headere (`A`/`B`) i više ne
  dvostruko broji vrijednost u dva susjedna stupca kad su bliže nego `2×columnXTolerance`;
- `extractPositionedTableRowsFromPdf`'s page-branching sad rutira leading-id oblik (ne samo
  trailing-id) na postojeći `extractPositionedTableRows` fallback umjesto tihog ispuštanja;
- `isPlausibleSpecLabel`'s leading-determiner provjera suzena na `tokens.length >= 2`, jer je
  case-fold "A" → "a" bio odbacivan kao presječena rečenica;
- dvije regresije na punom gateu popravljene AŽURIRANJEM asercije na novo, provjereno ISPRAVNIJE
  ponašanje (eaton-cbe03319 `Unit per package`, fath24 `Sku` umjesto starog naivnog atributa).

Kod koji je zadnje mijenjan:

- `src/server/scrapers/catalog-table-vocabulary.ts` — `CATALOG_ID_CELL_RE` (`#` alternativa);
- `src/server/scrapers/pdf-positioned-table.ts` — `extractPositionedOrderingRow` (header-filter,
  `nearestIndex` value-matching) i `extractPositionedTableRowsFromPdf` (page-branching fallback);
- `src/server/scrapers/spec-plausibility.ts` — `isPlausibleSpecLabel` (`tokens.length >= 2`);
- `fixtures/sce-fk0618-floor-stand-manual/` — novi value-verified fixture;
- `fixtures/eaton-cbe03319-family-catalog/expected.json` — ažurirana asercija (isti ground truth);
- `tests/catalog-table-vocabulary.test.ts`, `tests/pdf-positioned-table.test.ts`,
  `tests/spec-plausibility.test.ts`, `tests/generic-multivalue.test.ts`;
- `docs/COLD-START-PLAN.md` — §0b stanje i §0c dnevnik.

## Zadnje metrike

Zadnji puni offline gate nakon P2.2n:

- TypeScript: čist;
- Vitest: **2267/2267**, 119 test files;
- eval: **35/35**, **367** provjera, 0 failed, 0 errored, 0 contamination hits, 1 namjerni/dokumentirani color gap;
- spec gate: 120 dokumenata, **1694 → 1485**, **0 SUSPECT / 0 garbage**;
- label audit: A/C/D/E = **0**.

Ne commitati. Radno stablo je namjerno prljavo i sadrži mnogo ranijih promjena/fixtura.

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
  korpus nema dokaz za `#` u tim jezicima, samo za EN `part`/`order`/`article`/`item`/`model`/`catalog`.

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

## Prvi prompt za Claudea

Kopiraj cijeli ovaj prompt:

```text
Nastavi rad na product_scraper repou iz docs/CLAUDE-HANDOFF.md i docs/COLD-START-PLAN.md §0b.

Ne kreći od pretpostavke da treba još jedan generic heuristic. Zadnji zatvoreni checkpoint je P2.2n:
catalog-table-vocabulary.ts prepoznaje "PART #" (# umjesto No./Number) kao id-header; pdf-positioned-table.ts
više ne odbacuje jednoslovne stupac-headere niti dvostruko broji vrijednost preko dva susjedna stupca, i
rutira leading-id oblik na postojeći fallback umjesto tihog ispuštanja; spec-plausibility.ts suzio je
leading-determiner provjeru na 2+ riječi. Zadnji puni gate je zelen: Vitest 2267/2267,
eval 35/35, 367 provjera, 0 kontaminacija, spec-gate 0 SUSPECT (1694 -> 1485), label audit A/C/D/E=0.

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
