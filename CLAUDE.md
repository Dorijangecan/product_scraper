# CLAUDE.md

Prije bilo kakvih izmjena pročitaj [PROJECT_MAP.md](PROJECT_MAP.md) — to je kompaktna mapa
cijelog projekta (stack, struktura, ulazne točke, tokovi podataka, konvencije, gdje-tražiti-što).

Ažuriraj `PROJECT_MAP.md` ako napraviš strukturnu promjenu (novi modul/folder, promjena
pipeline redoslijeda, sheme baze, dijeljenih tipova ili ovisnosti).

Dublji tehnički opis: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Plan nije dovršen — implementacija se mora nastaviti

[docs/COLD-START-PLAN.md](docs/COLD-START-PLAN.md) **nije opis gotovog stanja nego plan u izvedbi**:
~91 % napravljeno, **~9 % (≈5,9 dana) otvoreno**, i to su rupe u točnosti podataka, ne kozmetika.
Pregled otvorenog je u [PROJECT_MAP §0](PROJECT_MAP.md), detalji u §0b plana („Stanje po fazama") i
kronologija u §0c.

Prije nastavka pročitaj **§0b „Pravila rada"** u planu. Ta pravila nisu preporuke — svako je naučeno
kroz pokvaren podatak. Dva koja se najčešće prekrše:

1. **Prvo mjerilo, pa kod.** Ako izmjenu ne možeš izmjeriti prije nego je napišeš, prvo napiši mjerilo.
   Plan bilježi tri slučaja gdje je mjerenje oborilo procjenu iz samog plana.
2. **Tišina pobjeđuje pogrešnu vrijednost.** Prazno polje je ispravan izlaz kad se ne zna.

Mjerila (sva offline osim zadnjeg): `npx tsc --noEmit`, `npx vitest run tests --maxWorkers=1`,
`npx tsx scripts/eval.ts`, `npm run audit:spec-gate`, `npm run audit:discovery`,
`npm run audit:search-reachability`, te **uživo** `npm run probe:vendor-search`.

Node nije na bash PATH-u: `export PATH="/c/Program Files/nodejs:$PATH"`.
