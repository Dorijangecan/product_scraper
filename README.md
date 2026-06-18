# Product Scraper

Local desktop tool for scraping public manufacturer product details from catalog
numbers and exporting traced Excel/PDT workbooks.

For the technical architecture, see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Najlakse za kolege na Windowsu

Kratke upute za slanje kolegi su u
[`KOLEGA-INSTALL.md`](KOLEGA-INSTALL.md).

Najbolji flow:

1. Prvi put pokrenu installer iz PowerShella.
2. Nakon toga koriste desktop shortcut `Product Scraper` ili dvokliknu
   `Update-and-Start-ProductScraper.bat`.

Launcher napravi `git pull`, instalira ili osvjezi npm pakete ako se promijenio
`package-lock.json`, provjeri Playwright Chromium i pokrene aplikaciju. Obican
`git pull` ne instalira dependencyje sam od sebe, zato kolege ne bi trebale
rucno povlaciti promjene pa posebno pokretati npm komande.

Prvi put im posalji ovu jednu komandu. Otvore PowerShell i zalijepe:

```powershell
irm https://raw.githubusercontent.com/Dorijangecan/product_scraper/main/Install-ProductScraper.ps1 | iex
```

Ako prompt vec pocinje s `PS ...>`, ne dodavati `powershell` ispred komande.
Duga `powershell -ExecutionPolicy ...` varijanta je samo za `cmd.exe` ili
Windows Run.

Ako PowerShell blokira skripte, u istom prozoru prvo pokrenu:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

Pa ponove `irm ... | iex` komandu.

Installer pokusa instalirati Git preko `winget` ako ga nema, skine projekt u
`D:\product_scraper` ako postoji D disk, a ako D disk ne postoji koristi Desktop
mapu `product_scraper`. Zatim napravi desktop shortcut, skine lokalni Node.js 22
runtime ako sistemski Node nije kompatibilan ili ga nema, instalira npm pakete,
instalira Playwright Chromium pri prvom pokretanju ako fali, napravi frontend
build ako treba i pokrene aplikaciju.

Ne instalira Ollama/Qwen/AI model. AI cleanup je u launcherima iskljucen po
defaultu, jer scraper normalno radi bez toga.

Nakon prvog puta neka koriste desktop shortcut `Product Scraper` ili udju u
mapu `product_scraper` i dvokliknu:

```text
Update-and-Start-ProductScraper.bat
```

Ako je stari prvi run pao na `better-sqlite3` / `node-gyp` / `Python` zbog
Node `24.x`, na tom racunalu obrisati `node_modules` i pokrenuti launcher opet.
Za novu default instalaciju na D disku:

```bat
cd /d D:\product_scraper
rmdir /s /q node_modules
Update-and-Start-ProductScraper.bat
```

Ako je projekt starije instaliran na Desktopu, koristi:

```bat
cd /d "%USERPROFILE%\Desktop\product_scraper"
rmdir /s /q node_modules
Update-and-Start-ProductScraper.bat
```

Rucna git varijanta:

```bat
cd /d D:\
git clone https://github.com/Dorijangecan/product_scraper.git product_scraper
cd /d D:\product_scraper
Start-ProductScraper.bat
```

Kasnije update i pokretanje:

```bat
cd /d D:\product_scraper
git pull
Start-ProductScraper.bat
```

Ako kolege ne zelis muciti s Git instalacijom, napravi portable zip i stavi ga
na GitHub Releases:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-portable-package.ps1
```

Zatim uploadas `product_scraper-portable.zip` iz roditeljske mape projekta.
Oni skinu zip, raspakiraju ga i dvokliknu
`Start-ProductScraper-Portable.bat`.

Ako kasnije zelis ukljuciti lokalni AI cleanup na nekom racunalu, instaliraj
Ollama i model zasebno pa pokreni app s `PDT_AI_CLEANUP=1`.

## Run

```powershell
npm install
npm run desktop
```

On Windows you can also launch it with:

```powershell
.\Start-ProductScraper.ps1
```

or double-click `Start-ProductScraper.bat`.

The app opens in a desktop window. It runs a private local API on `127.0.0.1`
in the background, but it does not open a normal browser tab.

Development mode:

```powershell
npm run dev
```

Benchmark run:

```powershell
npm run benchmark
```

The benchmark reads `benchmarks/products/*.json`, runs the same
scrape/download/PDF/quality/evidence flow used by the app, writes
`benchmarks/benchmark-report.json`, and exits non-zero when acceptance thresholds
are missed.

PDT mapping and resolver audit:

```powershell
npm run audit:pdt
```

The PDT audit checks the real `templates/master_pdt.xlsx`: every device-product
tab must be mapped from at least one known classified device type, every known
type must target an existing device tab, and every mapped device-tab property
must have a resolver or an explicit template-placeholder exception. It also
performs a real export with one representative item per known device type and
verifies the common tabs plus mapped device tabs in the output workbook.

## Data folders

- `data/` - local SQLite database, cached HTML/pages, custom manufacturer config
  and staged customer uploads
- `outputs/<manufacturer>/<input>/<date>_<runId>/` - Excel exports, links,
  downloaded documents, CAD, images, customer documents and logs

## Manufacturer configuration

Custom manufacturers can be saved from the app UI and are stored in
`data/manufacturers.json`.

Useful URL placeholders:

- `{part}` - original catalog number
- `{partUpper}` / `{partLower}` - case variants
- `{partCompact}` - letters and numbers only
- `{partSnake}` / `{partDash}` - URL-friendly separators
- `{partAfterColon}` / `{partAfterColonLower}` / `{partAfterColonCompact}` -
  suffix after `:`

Each manufacturer and source can also define catalog aliases, confidence, marker
extraction rules, and fetch policy settings such as timeout, cache TTL, retry
count, retry backoff, user agent, accept-language, referer, fallback user
agents, and minimum acceptable content length.

Localized URL templates use one line per locale:

```text
en https://www.example.com/en/product/{part}
de https://www.example.com/de/product/{part}
```

Marker extraction rules use this shape:

```text
Field name|||start marker|||end marker
Image URL|||/images/|||.png|||type=image; prefix=https://www.example.com/images/; suffix=.png
```

Legacy manufacturer IDs from the older scraper are accepted by the API:
`newabb` -> `abb`, `saginawcontrol` -> `sce`, `schneiderelectric` ->
`schneider`, and `nventhoffman` / `eldon` -> `nvent`.

Advanced scrape recipes can be edited as JSON in the manufacturer editor.
Supported recipe sections include:

- `discoveryPolicy` for official search URL templates, sitemap URLs, robots
  sitemap discovery, URL variants, allowed official domains, and max candidates
- `interactionPolicy` for browser selectors used to close overlays, switch
  locale, open tabs/accordions, scroll, and capture dynamic network data
- `extractionPolicy` for label aliases, custom document URL patterns, ignored
  document/image URL patterns, embedded product/resource table names, and raw
  output limits
- `qualityPolicy` for required normalized fields, required document types, raw
  attribute minimums, final completeness fields, and confidence caps

Every run exports raw attributes, technical attributes, documents, sources,
quality diagnostics, and an `Evidence` worksheet that traces values back to
source URL, parser, stage, and confidence.

When Playwright discovers a catalog-confirmed official `product-api` response
that improves the quality gate, the scraper stores a templated endpoint in the
local SQLite `learned_endpoints` table. Future runs replay those learned
official endpoints before expensive browser rendering.

## V1 scope

- CSV input and Excel workbooks uploaded as `.xlsx` or `.csv`
- Built-in profiles for ABB, Balluff, SCE, Eaton, Schneider Electric, Siemens,
  nVent/Hoffman, Schmersal, Spelsberg, SCAME, Rockwell Automation, FATH, E-T-A,
  and Phoenix Contact
- Configurable custom manufacturers through URL-template fallback sources
- Official source first, configured direct fallback sources second
- No login-only portals, CAPTCHA solving, or network-control bypass behavior
