# fixtures/ — offline extraction eval korpus

Pokreni: `npm run eval` (offline, bez mreže). Detalji zašto ovo postoji: [docs/COLD-START-PLAN.md](../docs/COLD-START-PLAN.md) §3 P0.1.

## Zašto

`npm run benchmark` traži **14 živih vendor sajtova** i tvrdi samo `Boolean(result.normalized[field])`
([scripts/benchmark.ts](../scripts/benchmark.ts)). Zato je cijela klasa bugova koju ovaj projekt
stalno lovi — vrijednost koja **postoji ali je pogrešna** (weight sibling varijante, °F čitan kao °C,
`1,050` čitan kao 1.05, packaging dimenzije umjesto proizvodnih) — po konstrukciji nevidljiva.

Ovaj korpus vrti **prave ekstraktore** (`parseGenericProductPage`,
`enrichResultFromDownloadedDocuments`) nad snimljenim dokumentima i usporeďuje **vrijednosti**.

## Struktura

```
fixtures/<case-id>/
  case.json       # što se parsira (obavezno)
  expected.json   # što mora ispasti (obavezno — case bez asertacija pada)
  page.html       # snimljena stranica (opcionalno)
  actual.json     # ispis `--write-actual`, radni materijal (nije asertacija)
```

`case.json`:

```json
{
  "id": "vendor-catalog-shape",
  "manufacturerId": "eaton",
  "catalogNumber": "CBE03319",
  "note": "Što ovaj fixture čuva — prikazuje se kad padne.",
  "documents": [{ "path": "putanja/do.pdf", "url": "https://…", "type": "datasheet" }],
  "pages": [{ "path": "page.html", "url": "https://…", "sourceType": "official" }]
}
```

`path` se traži **prvo relativno na case folder, pa relativno na root repozitorija** — veliki PDF-ovi
koji već postoje u repou se referenciraju, nikad ne kopiraju.

## expected.json — semantika

| Ključ | Znači |
| --- | --- |
| `normalized` | po polju: `"1.5 kg"` (točno, case/space-insensitive) · `{"contains":"230"}` · `{"number":0.22,"unit":"kg","tolerance":0.01}` · `{"absent":true}` (polje **mora** ostati prazno) |
| `attributesInclude` | `{"name":"…","valueContains":"…"}` — atribut mora postojati |
| `mustNotContain` | tokeni koji se **ne smiju** pojaviti ni u jednoj vrijednosti. **Ovo je detektor kontaminacije** i glavni razlog zašto harness postoji |
| `allowMissing` | polja koja izvor stvarno ne objavljuje → informativno, ne pad. Drži "vendor ne kaže" odvojeno od "nismo pročitali" |
| `knownGaps` | asertacije koje su **istina ali ih još ne znamo izvući**. Ne ruše run; ali kad počnu prolaziti, run to javi i traži promociju — tako zatvoreni gap ne može tiho regresirati |
| `_source`, `_notes` | odakle je ground truth i što točno danas ne radi. Piši ih — bez njih nitko ne zna je li asertacija provjerena ili nagađana |

**Pravilo:** `expected.json` sadrži **samo provjerenu istinu iz izvora**. Ako vrijednost nije
provjerena, ne asertira se (vidi `_notes.voltage/current/protection` u
`nvent-spec00583-datasheet`). Harness koji kodira nagađanje je gori od nikakvog harnessa.

`{"absent": true}` je prvorazredna asertacija: deterministički princip projekta je da se nepoznato
**ne pogađa**, pa "polje mora ostati prazno" mora biti testabilno.

## Dva tiera asertacija

`expected.json` nosi `_tier` bilješku, jer nisu svi slučajevi jednako jaki dokaz:

| Tier | Što tvrdi | Kada |
| --- | --- | --- |
| **value-verified** | konkretne vrijednosti pročitane **iz izvora** (`normalized`, `attributesInclude`, `{absent:true}`) | uvijek kad je izvor pročitan |
| **noise-guard** | samo `mustNotContain` s **univerzalnim** istinama (CSS, imprint, cookie banner, cart) | novi fixture koji još nitko nije pročitao |

Noise-guard je legitiman tier — hvata regresije i vrijedi odmah — ali **nije** izgovor da se
`actual.json` prepiše u `expected.json`. Promocija u value-verified ide samo nakon čitanja izvora.

## Vađenje HTML fixtura iz keša prošlih runova

```bash
npm run fixtures:extract -- --list
```

`data/scraper.db` (`page_cache` + `run_items`) drži tijelo svake stranice koju je bilo koji run
dohvatio, plus koji je kataloški broj završio na kojem URL-u. To je ~2600 stvarnih stranica proizvoda
kroz 10 proizvođača — najbolji izvor HTML fixtura, i radi offline.

```bash
npm run fixtures:extract -- --spread 10        # po jedna stranica od svakog proizvođača
npm run fixtures:extract -- --vendor abb --limit 2
npm run fixtures:extract -- --vendor abb --catalog 1SDA126426R1  # samo jedan točan cache kandidat
npm run fixtures:extract -- --vendor abb --catalog 1SDA126426R1 --include-non-found # audit dokaz koji run nije potvrdio
npm run fixtures:extract -- --vendor abb --catalog 1SDA126426R1 --url "https://abb-control-products.partcommunity.com/3d-cad-models/?catalog=abb_ww&part=1SDA126426R1" --include-non-found
```

Skripta piše samo `case.json` i kopira `page.html` (jer je `data/` gitignoran). `expected.json` ostaje
čovjeku — namjerno.

## Kako dodati case

1. `mkdir fixtures/<case-id>` + `case.json` (referenciraj PDF/HTML).
2. `npm run eval -- --case <case-id> --write-actual` → pogledaj `actual.json`.
3. **Otvori izvorni dokument** i pročitaj prave vrijednosti. Ne prepisuj `actual.json` u
   `expected.json` — time se bug pretvara u baseline.
4. Napiši `expected.json` s `_source` bilješkom odakle je koja vrijednost.
5. Što danas ne radi → `knownGaps`. Što je izmišljeno (vrijednost koja ne postoji u izvoru) →
   **tvrda** asertacija, nikad knownGap.

## Trenutno stanje korpusa (baseline)

| Case | Oblik | Čuva |
| --- | --- | --- |
| `eaton-cbe03319-family-catalog` | 57-stranični multi-varijantni katalog, 2.9 MB | scoping 1 kataloga iz 27 siblinga na istoj stranici; dostupnost family Technical Data stranice |
| `nvent-87920846-datasheet` | 2-stranična instrukcija, bez spec tablice | **negativni fixture** — dokument bez specova ne smije dati specove |
| `nvent-spec00583-datasheet` | multi-proizvodni spec sheet, dual °F/°C stupci | °F→°C, set-point vs operating range, nescopeabilan dokument |
| `abb-1SDA126493R1-page` | HTML PDP koji radi | regresijska zaštita weight/dimensions kroz P1.1/P1.3 |
| `abb-1SAP180400R0001-page` | HTML PDP, type code ≠ catalog number | identity kad ime proizvoda nije kataloški broj |

Crveno stanje je **očekivano** dok P0.2 faze ne slete — te asertacije su definicija "gotovo",
ne nova regresija. Popis padova drži [docs/COLD-START-PLAN.md](../docs/COLD-START-PLAN.md).

## Što ovaj korpus još ne pokriva

Snimljeni HTML zahtijeva mrežu, pa je korpus zasad seedan onim što je već bilo u repou.
Sljedeći korak (P0.1a) je record/replay sloj oko `CachedHttpClient` (`--record` / `--replay`) da se
cijeli discovery put može snimiti i vrtjeti offline. Do tada `pages` fixture treba dodavati ručno.
