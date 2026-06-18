param(
    [string]$RepoUrl = "https://github.com/Dorijangecan/product_scraper.git",
    [string]$InstallDir,
    [switch]$SkipStart,
    [switch]$SkipShortcut,
    [switch]$NoToolInstall
)

$ErrorActionPreference = "Stop"

function Refresh-CurrentPath {
    $parts = @(
        $env:Path,
        [Environment]::GetEnvironmentVariable("Path", "Machine"),
        [Environment]::GetEnvironmentVariable("Path", "User"),
        "C:\Program Files\Git\cmd",
        "C:\Program Files (x86)\Git\cmd",
        "$env:LOCALAPPDATA\Programs\Git\cmd",
        "C:\Program Files\nodejs",
        "C:\Program Files (x86)\nodejs",
        "$env:LOCALAPPDATA\Programs\nodejs"
    ) | Where-Object { $_ -and $_.Trim().Length -gt 0 }

    $env:Path = ($parts -join ";")
}

function Get-LocalCommand($name) {
    Refresh-CurrentPath
    return Get-Command $name -ErrorAction SilentlyContinue
}

function Get-DefaultInstallDir {
    if (Test-Path -LiteralPath "D:\") {
        return "D:\product_scraper"
    }

    return (Join-Path ([Environment]::GetFolderPath("Desktop")) "product_scraper")
}

function Ensure-Tool($commandName, $wingetId, $displayName, $downloadUrl) {
    if (Get-LocalCommand $commandName) {
        Write-Host "$displayName je pronadjen."
        return
    }

    Write-Host "$displayName nije pronadjen."
    if (-not $NoToolInstall) {
        $winget = Get-LocalCommand "winget"
        if ($winget) {
            Write-Host "Pokusavam instalirati $displayName preko winget..."
            & $winget.Source install --id $wingetId --exact --source winget --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) {
                Write-Host "winget instalacija nije uspjela za $displayName."
            }
        }
    }

    if (Get-LocalCommand $commandName) {
        Write-Host "$displayName je spreman."
        return
    }

    Write-Host "Otvaram download stranicu za $displayName..."
    Start-Process $downloadUrl
    throw "Instaliraj $displayName, zatvori i ponovno pokreni ovu komandu."
}

function Invoke-Git {
    param(
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )

    $git = Get-LocalCommand "git"
    if (-not $git) {
        throw "Git nije pronadjen."
    }

    Push-Location $workingDirectory
    try {
        & $git.Source @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "git $($Arguments -join ' ') nije uspio."
        }
    } finally {
        Pop-Location
    }
}

function New-ProductScraperShortcut {
    param([string]$TargetDir)

    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktop "Product Scraper.lnk"
    $target = Join-Path $TargetDir "Update-and-Start-ProductScraper.bat"

    if (-not (Test-Path -LiteralPath $target)) {
        Write-Host "Preskacem shortcut jer ne postoji launcher: $target"
        return
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $target
        $shortcut.WorkingDirectory = $TargetDir
        $shortcut.Description = "Update and start Product Scraper"
        $shortcut.Save()
        Write-Host "Desktop shortcut je spreman:"
        Write-Host "  $shortcutPath"
    } catch {
        Write-Host "UPOZORENJE: Shortcut nije napravljen: $($_.Exception.Message)"
    }
}

Refresh-CurrentPath
Ensure-Tool "git" "Git.Git" "Git for Windows" "https://git-scm.com/download/win"

if (-not $InstallDir -or $InstallDir.Trim().Length -eq 0) {
    $InstallDir = Get-DefaultInstallDir
}

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$parentDir = Split-Path -Parent $InstallDir
New-Item -ItemType Directory -Force -Path $parentDir | Out-Null

if (Test-Path -LiteralPath (Join-Path $InstallDir ".git")) {
    Write-Host "Product Scraper vec postoji. Radim git pull..."
    Invoke-Git -Arguments @("pull", "--ff-only") -WorkingDirectory $InstallDir
} else {
    if (Test-Path -LiteralPath $InstallDir) {
        $backupDir = "$InstallDir-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Write-Host "Mapa vec postoji, ali nije git checkout:"
        Write-Host "  $InstallDir"
        Write-Host "Premjestam je u backup:"
        Write-Host "  $backupDir"
        Move-Item -LiteralPath $InstallDir -Destination $backupDir
    }

    Write-Host "Skidam Product Scraper sa GitHuba..."
    Invoke-Git -Arguments @("clone", $RepoUrl, $InstallDir) -WorkingDirectory $parentDir
}

Write-Host ""
Write-Host "Product Scraper je spreman u:"
Write-Host "  $InstallDir"

if (-not $SkipShortcut) {
    New-ProductScraperShortcut -TargetDir $InstallDir
}

if (-not $SkipStart) {
    Write-Host ""
    Write-Host "Pokrecem aplikaciju..."
    Push-Location $InstallDir
    try {
        & ".\Update-and-Start-ProductScraper.bat"
    } finally {
        Pop-Location
    }
}
