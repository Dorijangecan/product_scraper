# Product Scraper

Local desktop tool for scraping public ABB, Balluff, and SCE product details from catalog numbers and exporting a traced Excel workbook.

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

The app opens in a desktop window. It still runs a private local API on `127.0.0.1` in the background, but it does not open a normal browser tab.

For development only:

```powershell
npm run dev
```

Benchmark run:

```powershell
npm run benchmark
```

The benchmark reads `benchmarks/products/*.json`, runs the same scrape/download/PDF/quality/evidence flow used by the app, writes `benchmarks/benchmark-report.json`, and exits non-zero when the acceptance thresholds are missed.

PDT mapping and resolver audit:

```powershell
npm run audit:pdt
```

The PDT audit checks the real `templates/master_pdt.xlsx`: every device-product tab must be mapped from at least one known classified device type, every known type must target an existing device tab, and every mapped device-tab property must have a resolver or an explicit template-placeholder exception. It also performs a real export with one representative item per known device type and verifies the common tabs plus mapped device tabs in the output workbook. The audit exits non-zero on gaps.

## Data folders

- `data/` - local SQLite database and cached HTML pages
- `outputs/<runId>/` - Excel exports and downloaded documents

## Manufacturer configuration

Custom manufacturers can be saved from the app UI and are stored in `data/manufacturers.json`.

Useful URL placeholders:

- `{part}` - original catalog number
- `{partUpper}` / `{partLower}` - case variants
- `{partCompact}` - letters and numbers only
- `{partSnake}` / `{partDash}` - URL-friendly separators
- `{partAfterColon}` / `{partAfterColonLower}` / `{partAfterColonCompact}` - suffix after `:`

Each manufacturer and source can also define catalog aliases, confidence, marker extraction rules, and fetch policy settings such as timeout, cache TTL, retry count, retry backoff, user agent, accept-language, referer, fallback user agents, and minimum acceptable content length. Localized URL templates use one line per locale, for example:

```text
en https://www.example.com/en/product/{part}
de https://www.example.com/de/product/{part}
```

Marker extraction rules use the same shape as the older production scraper filters:

```text
Field name|||start marker|||end marker
Image URL|||/images/|||.png|||type=image; prefix=https://www.example.com/images/; suffix=.png
```

Legacy manufacturer IDs from the older scraper are accepted by the API: `newabb` -> `abb`, `saginawcontrol` -> `sce`, `schneiderelectric` -> `schneider`, and `nventhoffman`/`eldon` -> `nvent`.

Advanced scrape recipes can be edited as JSON in the manufacturer editor. Supported recipe sections include:

- `discoveryPolicy` for official search URL templates, sitemap URLs, robots sitemap discovery, URL variants, allowed official domains, and max candidates
- `interactionPolicy` for browser selectors used to close overlays, switch locale, open tabs/accordions, scroll, and capture dynamic network data
- `extractionPolicy` for label aliases, custom document URL patterns, ignored document/image URL patterns, and raw output limits
- `qualityPolicy` for required normalized fields, required document types, raw attribute minimums, and confidence caps

Every run now exports raw attributes, documents, sources, quality diagnostics, and an `Evidence` worksheet that traces values back to source URL, parser, stage, and confidence.

When Playwright discovers a catalog-confirmed official `product-api` response that improves the quality gate, the scraper stores a templated endpoint in the local SQLite `learned_endpoints` table. Future runs replay those learned official endpoints before expensive browser rendering.

## V1 scope

- CSV input, plus Excel workbooks uploaded as `.xlsx` or `.csv`
- ABB, Balluff, SCE, Eaton, Schneider, Siemens, nVent/Hoffman, Schmersal, and Spelsberg manufacturer setups, plus configurable URL-template fallback sources
- official source first, configured direct fallback sources second
- no login-only portals, CAPTCHA solving, or network-control bypass behavior
