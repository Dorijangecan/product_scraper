@echo off
setlocal
cd /d "%~dp0"
title Product Scraper Portable

if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo  Nedostaje node_modules\electron\dist\electron.exe.
    echo  Ova datoteka je za portable paket koji vec sadrzi node_modules.
    echo.
    pause
    exit /b 1
)

if not exist "dist\index.html" (
    echo.
    echo  Nedostaje dist\index.html.
    echo  Portable paket mora sadrzavati vec izgradjen frontend.
    echo.
    pause
    exit /b 1
)

echo.
echo  Pokrecem Product Scraper...
echo.
"%CD%\node_modules\electron\dist\electron.exe" "%CD%\src\desktop\main.cjs"
exit /b %errorlevel%
