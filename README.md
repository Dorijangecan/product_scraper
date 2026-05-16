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

## Data folders

- `data/` - local SQLite database and cached HTML pages
- `outputs/<runId>/` - Excel exports and downloaded documents

## V1 scope

- CSV input, plus Excel workbooks uploaded as `.xlsx` or `.csv`
- ABB, Balluff, and SCE manufacturer connectors
- official source first, configured direct fallback sources second
- no login-only portals, CAPTCHA solving, or network-control bypass behavior
