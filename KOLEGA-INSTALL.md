# Product Scraper - instalacija za kolegu

Ovo je preporuceni nacin za Windows racunalo na kojem kolega treba samo pokretati scraper i povremeno dobiti novu verziju sa Gita.

## Prvi put

1. Otvori **PowerShell**.
2. Zalijepi ovu komandu **tocno ovako**. Ako je prompt vec `PS ...>`, ne dodavati rijec `powershell` ispred:

```powershell
irm https://raw.githubusercontent.com/Dorijangecan/product_scraper/main/Install-ProductScraper.ps1 | iex
```

Ako zelis forsirati instalaciju na D disk i zaobici eventualni cache stare
skripte, koristi ovu varijantu:

```powershell
$s = irm "https://raw.githubusercontent.com/Dorijangecan/product_scraper/main/Install-ProductScraper.ps1?cache=$(Get-Random)"; & ([scriptblock]::Create($s)) -InstallDir "D:\product_scraper"
```

Installer ce:

- provjeriti ima li Git
- pokusati instalirati Git preko `winget` ako fali
- skinuti projekt u `D:\product_scraper` ako postoji D disk, a ako D disk ne postoji onda na Desktop u mapu `product_scraper`
- napraviti desktop shortcut `Product Scraper`
- skinuti lokalni Node.js 22 runtime ako sistemski Node nije kompatibilan ili ga nema
- instalirati sve npm pakete iz `package-lock.json`
- instalirati Playwright Chromium ako fali
- napraviti frontend build ako fali ili je zastario
- pokrenuti aplikaciju

Prvi run moze trajati nekoliko minuta jer tada skida Node runtime, Node pakete, Electron i Playwright Chromium.

Ako Windows otvori download stranicu za Git, instaliraj sto trazi, zatvori PowerShell i ponovi istu komandu.

Ako PowerShell blokira skripte, prvo pokreni:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

Pa onda ponovno:

```powershell
irm https://raw.githubusercontent.com/Dorijangecan/product_scraper/main/Install-ProductScraper.ps1 | iex
```

Ako komandu pokreces iz `cmd.exe` ili Windows Run prozora, koristi duzu varijantu:

```powershell
powershell -ExecutionPolicy Bypass -NoProfile -Command "irm https://raw.githubusercontent.com/Dorijangecan/product_scraper/main/Install-ProductScraper.ps1 | iex"
```

Ako u PowerShellu dobijes `Program 'powershell.exe' failed to run: Access is denied`, to znaci da si u PowerShell zalijepio dugu `powershell -ExecutionPolicy ...` varijantu. Ostani u istom prozoru i pokreni kratku `irm ... | iex` komandu iznad.

## Svako sljedece pokretanje

Najlakse je dvokliknuti desktop shortcut:

```text
Product Scraper
```

Shortcut pokrece:

```text
Update-and-Start-ProductScraper.bat
```

Taj launcher prvo napravi `git pull --ff-only`, zatim po potrebi osvjezi npm pakete i Playwright Chromium, napravi build ako treba, pa pokrene scraper.

## Ako je prvi npm install pao

Ako je prije ove verzije instalacija pala na `better-sqlite3`, `node-gyp`, `Python` ili Node `24.x`, napravi ovo na koleginom racunalu za novu default instalaciju na D disku:

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

Nova verzija ce koristiti lokalni Node.js 22 runtime i ponovno instalirati pakete.

## Rucno pokretanje iz mape

Ako shortcut ne postoji:

1. Otvori mapu `D:\product_scraper` za novu default instalaciju, ili `%USERPROFILE%\Desktop\product_scraper` ako je instalirano starom metodom
2. Dvoklikni `Update-and-Start-ProductScraper.bat`

## Rucni update bez pokretanja

Ako samo zelis povuci novu verziju:

```bat
cd /d D:\product_scraper
git pull --ff-only
```

Nakon toga pokreni:

```bat
Start-ProductScraper.bat
```

## Ako je GitHub repo privatan

Jednolinijska PowerShell komanda radi najbolje kada je repo javno dostupan. Ako repo postane privatan, kolega mora imati GitHub pristup i biti prijavljen u Git for Windows, ili mu treba dati portable zip.

## Portable varijanta

Portable zip je dobar samo ako ne zelis da kolega instalira Git. Mana je sto se ne azurira sam preko `git pull`.

Na developerskom racunalu napravi paket:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-portable-package.ps1
```

Zatim kolegi posalji `product_scraper-portable.zip`. On ga raspakira i pokrene:

```text
Start-ProductScraper-Portable.bat
```

Za redovno koristenje ipak je bolja Git varijanta, jer shortcut svaki put povuce najnovije promjene.
