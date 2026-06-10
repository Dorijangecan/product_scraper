@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Product Scraper

:: Kolegama AI/Ollama nije potreban za normalan rad. Tko zeli AI cleanup,
:: moze prije pokretanja postaviti PDT_AI_CLEANUP=1.
if not defined PDT_AI_CLEANUP set "PDT_AI_CLEANUP=0"

set "PROJECT_NODE_DIR=%~dp0.runtime\node"
if exist "%PROJECT_NODE_DIR%\node.exe" (
    set "PATH=%PROJECT_NODE_DIR%;%PATH%"
    goto :node_ok
)

:: Provjeri je li Node.js instaliran. NAJPRIJE pogledamo PATH (najlaksi slucaj).
:: Ako PATH ne radi (npr. user instalirao Node ali nije se relogovao, ili je PATH
:: nekako "ocistio"), rucno trazimo node.exe na uobicajenim mjestima i dodajemo
:: ga u PATH samo za ovu sesiju. Tako se Start-ProductScraper.bat NIKAD ne zali
:: na "Node nije instaliran" ako je Node fizicki tu.
set "NODE_DIR="
where node >nul 2>&1
if not errorlevel 1 goto :system_node_found

:: NAPOMENA: ne koristimo FOR loop jer "%ProgramFiles(x86)%" sadrzi ")" sto bi
:: pokvarilo zatvaranje petlje. Provjeravamo svaku lokaciju zasebno.
call :check_node_dir "%ProgramFiles%\nodejs"
if defined NODE_DIR goto :node_found
call :check_node_dir "%ProgramFiles(x86)%\nodejs"
if defined NODE_DIR goto :node_found
call :check_node_dir "%LOCALAPPDATA%\Programs\nodejs"
if defined NODE_DIR goto :node_found
call :check_node_dir "%LOCALAPPDATA%\nvs\default"
if defined NODE_DIR goto :node_found
call :check_node_dir "%USERPROFILE%\scoop\apps\nodejs\current"
if defined NODE_DIR goto :node_found
call :check_node_dir "%USERPROFILE%\scoop\apps\nodejs-lts\current"
if defined NODE_DIR goto :node_found
call :check_node_dir "C:\Program Files\nodejs"
if defined NODE_DIR goto :node_found
call :check_node_dir "C:\Program Files (x86)\nodejs"
if defined NODE_DIR goto :node_found

:: Posljednja sansa: NVM (nodejs verzionisanje za Windows) - uzmi najnoviju verziju
if defined NVM_SYMLINK call :check_node_dir "%NVM_SYMLINK%"
if defined NODE_DIR goto :node_found
if exist "%APPDATA%\nvm" (
    for /f "delims=" %%D in ('dir /b /ad-h /o-n "%APPDATA%\nvm\v*" 2^>nul') do (
        if exist "%APPDATA%\nvm\%%D\node.exe" (
            set "NODE_DIR=%APPDATA%\nvm\%%D"
            goto :node_found
        )
    )
)

if not defined NODE_DIR goto :install_project_node

:node_found
echo  Node nije bio u PATH-u, ali sam ga nasao u: !NODE_DIR!
set "PATH=!NODE_DIR!;%PATH%"

:system_node_found
set "NODE_MAJOR="
for /f %%V in ('node -p "process.versions.node.split(String.fromCharCode(46))[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if not "!NODE_MAJOR!"=="20" if not "!NODE_MAJOR!"=="22" goto :install_project_node

:node_ok
:: Provjeri da node stvarno radi
node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ============================================================
    echo   NODE.JS PRONADJEN ALI NE RADI!
    echo  ============================================================
    echo.
    echo  Path: !NODE_DIR!
    echo  Probaj otvoriti CMD u toj mapi i pokrenuti: node --version
    echo.
    pause
    exit /b 1
)

goto :npm_install_check

:install_project_node
echo.
echo  Instaliram lokalni Node.js 22 runtime za Product Scraper...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Ensure-ProductScraperRuntime.ps1"
if errorlevel 1 (
    echo.
    echo  ============================================================
    echo   NODE.JS RUNTIME NIJE INSTALIRAN!
    echo  ============================================================
    echo.
    echo  Automatsko skidanje Node.js runtimea nije uspjelo.
    echo  Provjeri internet konekciju pa pokreni ovu datoteku ponovo.
    echo.
    pause
    exit /b 1
)
if not exist "%PROJECT_NODE_DIR%\node.exe" (
    echo.
    echo  Node.js runtime nije pronadjen u: %PROJECT_NODE_DIR%
    echo.
    pause
    exit /b 1
)
set "PATH=%PROJECT_NODE_DIR%;%PATH%"
goto :node_ok

:npm_install_check

:: Instaliraj ili osvjezi node_modules ako ne postoje ili ako je package-lock.json noviji.
set "NPM_STAMP=node_modules\.product-scraper-install-ok"
set "NPM_INSTALL_NEEDED=0"
if not exist "node_modules\" set "NPM_INSTALL_NEEDED=1"
if not exist "!NPM_STAMP!" set "NPM_INSTALL_NEEDED=1"
if exist "package-lock.json" if exist "!NPM_STAMP!" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$lock=(Get-Item -LiteralPath 'package-lock.json').LastWriteTimeUtc; $stamp=(Get-Item -LiteralPath 'node_modules\.product-scraper-install-ok').LastWriteTimeUtc; if ($lock -gt $stamp) { exit 1 }"
    if errorlevel 1 set "NPM_INSTALL_NEEDED=1"
)
if "!NPM_INSTALL_NEEDED!"=="1" (
    echo.
    echo  Prvo pokretanje ili nova verzija - instaliram pakete, pricekaj malo...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  GRESKA pri instalaciji paketa!
        pause
        exit /b 1
    )
    type nul > "!NPM_STAMP!"
)

:: Native moduli (npr. better-sqlite3) ovise o tocnoj Node ABI verziji.
:: Ako su node_modules zadnji put instalirani s drugim Nodeom, aplikacija se srusi
:: na startu s "NODE_MODULE_VERSION ...". Provjeri i automatski rebuildaj.
node -e "require('better-sqlite3'); console.log('native-ok')" >nul 2>&1
if errorlevel 1 (
    echo.
    echo  Native moduli nisu za ovu Node.js verziju - popravljam better-sqlite3...
    echo.
    call npm rebuild better-sqlite3
    if errorlevel 1 (
        echo.
        echo  GRESKA pri popravljanju better-sqlite3 native modula!
        echo  Probaj rucno pokrenuti: npm rebuild better-sqlite3
        echo.
        pause
        exit /b 1
    )
    node -e "require('better-sqlite3')" >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  better-sqlite3 se i dalje ne moze ucitati.
        echo  Probaj rucno: npm install
        echo.
        pause
        exit /b 1
    )
)

:: Provjeri je li Electron binary raspakiran (path.txt mora sadrzavati samo "electron.exe")
if exist "node_modules\electron\path.txt" (
    for /f %%i in (node_modules\electron\path.txt) do set EPATH=%%i
    if /i "!EPATH!"=="dist/electron.exe" (
        echo electron.exe> node_modules\electron\path.txt
    )
)
if not exist "node_modules\electron\path.txt" (
    echo.
    echo  Raspakivam Electron binarnu datoteku...
    echo.
    if exist "node_modules\electron\dist\electron.exe" (
        echo electron.exe> node_modules\electron\path.txt
    ) else (
        node node_modules\electron\install.js
        if exist "node_modules\electron\dist\electron.exe" (
            echo electron.exe> node_modules\electron\path.txt
        )
    )
)

:: Provjeri jesu li Playwright (Chromium) browseri instalirani - potrebno za Balluff expanded sections
set "PW_CACHE=%LOCALAPPDATA%\ms-playwright"
set "PW_NEEDED=0"
if not exist "%PW_CACHE%" set "PW_NEEDED=1"
if "%PW_NEEDED%"=="0" (
    dir /b "%PW_CACHE%\chromium-*" >nul 2>&1
    if errorlevel 1 set "PW_NEEDED=1"
)
if "%PW_NEEDED%"=="1" (
    echo.
    echo  Instaliram Playwright Chromium ^(potrebno za Balluff Key features/Downloads/Classifications/Digital Product Passport^)...
    echo.
    call npx --yes playwright install chromium
    if errorlevel 1 (
        echo.
        echo  UPOZORENJE: Playwright Chromium instalacija nije uspjela.
        echo  Balluff prosireni podaci ^(Weight, Key features, Classifications, DPP^) nece se moci skinuti.
        echo  Mozes pokrenuti rucno: npx playwright install chromium
        echo.
        pause
    )
)

:: Pokreni app
echo.
echo  Pokrecem Product Scraper...
echo.
call npm run desktop
exit /b %errorlevel%

:: --- helper: provjeri sadrzi li dato dir node.exe i postavi NODE_DIR ako da ---
:check_node_dir
if exist "%~1\node.exe" set "NODE_DIR=%~1"
exit /b 0
