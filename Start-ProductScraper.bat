@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Product Scraper

:: Provjeri je li Node.js instaliran. NAJPRIJE pogledamo PATH (najlaksi slucaj).
:: Ako PATH ne radi (npr. user instalirao Node ali nije se relogovao, ili je PATH
:: nekako "ocistio"), rucno trazimo node.exe na uobicajenim mjestima i dodajemo
:: ga u PATH samo za ovu sesiju. Tako se Start-ProductScraper.bat NIKAD ne zali
:: na "Node nije instaliran" ako je Node fizicki tu.
set "NODE_DIR="
where node >nul 2>&1
if not errorlevel 1 goto :node_ok

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

:: Posljednja sansa: NVM (nodejs verzionisanje za Windows) — uzmi najviju verziju
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

if not defined NODE_DIR (
    echo.
    echo  ============================================================
    echo   NODE.JS NIJE INSTALIRAN!
    echo  ============================================================
    echo.
    echo  Trebas instalirati Node.js da bi app radio.
    echo  Otvaram download stranicu...
    echo.
    start https://nodejs.org/en/download
    echo  Nakon instalacije Node.js, pokreni ovu datoteku ponovo.
    echo.
    pause
    exit /b 1
)

:node_found
echo  Node nije bio u PATH-u, ali sam ga nasao u: !NODE_DIR!
set "PATH=!NODE_DIR!;%PATH%"

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

:: Instaliraj node_modules ako ne postoje
if not exist "node_modules\" (
    echo.
    echo  Prva pokretanje - instaliram pakete, pricekaj malo...
    echo.
    npm install
    if errorlevel 1 (
        echo.
        echo  GRESKA pri instalaciji paketa!
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
npm run desktop
exit /b %errorlevel%

:: --- helper: provjeri sadrzi li dato dir node.exe i postavi NODE_DIR ako da ---
:check_node_dir
if exist "%~1\node.exe" set "NODE_DIR=%~1"
exit /b 0
