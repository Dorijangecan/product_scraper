@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Product Scraper - Update and Start

set "GIT_EXE="
where git >nul 2>&1
if not errorlevel 1 set "GIT_EXE=git"
if not defined GIT_EXE if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT_EXE if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles(x86)%\Git\cmd\git.exe"
if not defined GIT_EXE if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT_EXE=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"

if not defined GIT_EXE (
    echo.
    echo  Git nije pronadjen. Pokusavam ga instalirati preko winget...
    echo.
    where winget >nul 2>&1
    if not errorlevel 1 (
        winget install --id Git.Git --exact --source winget --accept-package-agreements --accept-source-agreements
        where git >nul 2>&1
        if not errorlevel 1 set "GIT_EXE=git"
        if not defined GIT_EXE if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles%\Git\cmd\git.exe"
        if not defined GIT_EXE if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles(x86)%\Git\cmd\git.exe"
        if not defined GIT_EXE if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT_EXE=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"
    ) else (
        echo  winget nije pronadjen, otvaram Git download stranicu.
        start https://git-scm.com/download/win
    )
)

if exist ".git\" (
    if defined GIT_EXE (
        echo.
        echo  Provjeravam ima li nove verzije...
        echo.
        "%GIT_EXE%" -c http.sslBackend=schannel pull --ff-only
        if errorlevel 1 (
            echo.
            echo  UPOZORENJE: Git update nije uspio.
            echo  Nastavljam sa trenutnom lokalnom verzijom.
            echo.
            pause
        )
    ) else (
        echo.
        echo  Git nije pronadjen pa preskacem update.
        echo  App ce se pokrenuti sa trenutnom lokalnom verzijom.
        echo.
    )
) else (
    echo.
    echo  Ova mapa nije git checkout pa preskacem update.
    echo.
)

call "%~dp0Start-ProductScraper.bat"
exit /b %errorlevel%
