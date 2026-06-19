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

function Resolve-InstallDir {
    param([string]$Path)

    if (-not $Path -or $Path.Trim().Length -eq 0) {
        $Path = Get-DefaultInstallDir
    }

    try {
        return [System.IO.Path]::GetFullPath($Path)
    } catch {
        throw "InstallDir nije ispravan Windows path: $Path"
    }
}

function Ensure-ParentDirectory {
    param([string]$Path)

    $parentDir = Split-Path -Parent $Path
    if (-not $parentDir -or $parentDir.Trim().Length -eq 0) {
        throw "Ne mogu odrediti parent mapu za install path: $Path"
    }

    if ([System.IO.Directory]::Exists($parentDir)) {
        return $parentDir
    }

    New-Item -ItemType Directory -Force -Path $parentDir | Out-Null

    if (-not [System.IO.Directory]::Exists($parentDir)) {
        throw "Ne mogu napraviti parent mapu: $parentDir"
    }

    return $parentDir
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
        $effectiveArguments = @("-c", "http.sslBackend=schannel") + $Arguments
        & $git.Source @effectiveArguments
        if ($LASTEXITCODE -ne 0) {
            throw "git $($Arguments -join ' ') nije uspio."
        }
    } finally {
        Pop-Location
    }
}

function Get-GitHubMainZipUrl {
    param([string]$RepoUrl)

    if ($RepoUrl -match '^https://github\.com/([^/]+)/([^/.]+)(?:\.git)?/?$') {
        return "https://github.com/$($matches[1])/$($matches[2])/archive/refs/heads/main.zip"
    }

    throw "ZIP fallback podrzava samo github.com HTTPS repo URL: $RepoUrl"
}

function Install-FromGitHubZip {
    param(
        [string]$RepoUrl,
        [string]$InstallDir
    )

    $zipUrl = Get-GitHubMainZipUrl $RepoUrl
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "product-scraper-install-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    $zipPath = Join-Path $tempRoot "product-scraper-main.zip"
    $extractDir = Join-Path $tempRoot "extract"

    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

    try {
        Write-Host "Skidam ZIP fallback:"
        Write-Host "  $zipUrl"
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath

        Write-Host "Raspakiravam Product Scraper..."
        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

        $sourceRoot = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
        if (-not $sourceRoot) {
            throw "ZIP fallback nema ocekivanu mapu nakon raspakiravanja."
        }

        if (Test-Path -LiteralPath $InstallDir) {
            Remove-Item -LiteralPath $InstallDir -Recurse -Force
        }

        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        Get-ChildItem -LiteralPath $sourceRoot.FullName -Force | Copy-Item -Destination $InstallDir -Recurse -Force

        $markerPath = Join-Path $InstallDir ".product-scraper-zip-install.txt"
        Set-Content -LiteralPath $markerPath -Value @(
            "Installed from GitHub ZIP fallback because git clone failed.",
            "Run the installer again later to convert this folder to a git checkout."
        )
    } finally {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
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

$InstallDir = Resolve-InstallDir $InstallDir
$parentDir = Ensure-ParentDirectory $InstallDir

Write-Host "Install mapa:"
Write-Host "  $InstallDir"

if (Test-Path -LiteralPath (Join-Path $InstallDir ".git")) {
    Write-Host "Product Scraper vec postoji. Radim git pull..."
    try {
        Invoke-Git -Arguments @("pull", "--ff-only") -WorkingDirectory $InstallDir
    } catch {
        $backupDir = "$InstallDir-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Write-Host "Git pull nije uspio:"
        Write-Host "  $($_.Exception.Message)"
        Write-Host "Premjestam postojecu mapu u backup i radim svjezu instalaciju:"
        Write-Host "  $backupDir"
        Move-Item -LiteralPath $InstallDir -Destination $backupDir

        Write-Host "Skidam Product Scraper sa GitHuba..."
        try {
            Invoke-Git -Arguments @("clone", $RepoUrl, $InstallDir) -WorkingDirectory $parentDir
        } catch {
            Write-Host "Git clone nije uspio:"
            Write-Host "  $($_.Exception.Message)"
            Write-Host "Pokusavam instalaciju bez Gita preko GitHub ZIP-a..."
            Install-FromGitHubZip -RepoUrl $RepoUrl -InstallDir $InstallDir
        }
    }
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
    try {
        Invoke-Git -Arguments @("clone", $RepoUrl, $InstallDir) -WorkingDirectory $parentDir
    } catch {
        Write-Host "Git clone nije uspio:"
        Write-Host "  $($_.Exception.Message)"
        Write-Host "Pokusavam instalaciju bez Gita preko GitHub ZIP-a..."
        Install-FromGitHubZip -RepoUrl $RepoUrl -InstallDir $InstallDir
    }
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
