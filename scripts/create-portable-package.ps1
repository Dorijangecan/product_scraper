$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$parent = Split-Path $root -Parent
$packageDir = Join-Path $parent "product_scraper-portable"
$zipPath = Join-Path $parent "product_scraper-portable.zip"

function Copy-Tree($source, $destination) {
    if (!(Test-Path -LiteralPath $source)) {
        throw "Missing required path: $source"
    }

    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    robocopy $source $destination /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed for $source with exit code $LASTEXITCODE"
    }
}

Write-Host "Building frontend..."
Push-Location $root
try {
    npm run build
} finally {
    Pop-Location
}

Write-Host "Preparing portable folder..."
if (Test-Path -LiteralPath $packageDir) {
    Remove-Item -LiteralPath $packageDir -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Force -Path $packageDir | Out-Null

Copy-Tree (Join-Path $root "src") (Join-Path $packageDir "src")
Copy-Tree (Join-Path $root "dist") (Join-Path $packageDir "dist")
Copy-Tree (Join-Path $root "node_modules") (Join-Path $packageDir "node_modules")

Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination $packageDir
Copy-Item -LiteralPath (Join-Path $root "package-lock.json") -Destination $packageDir
Copy-Item -LiteralPath (Join-Path $root "tsconfig.json") -Destination $packageDir
Copy-Item -LiteralPath (Join-Path $root "vite.config.ts") -Destination $packageDir
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination $packageDir -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $root "Start-ProductScraper-Portable.bat") -Destination $packageDir

$node = Get-Command node -ErrorAction Stop
$nodeDir = Join-Path $packageDir "runtime\node"
New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
Copy-Item -LiteralPath $node.Source -Destination (Join-Path $nodeDir "node.exe")

$playwrightCache = Join-Path $env:LOCALAPPDATA "ms-playwright"
if (Test-Path -LiteralPath $playwrightCache) {
    Copy-Tree $playwrightCache (Join-Path $packageDir "runtime\ms-playwright")
}

Write-Host "Creating zip..."
tar.exe -a -cf $zipPath -C $parent "product_scraper-portable"

$zip = Get-Item -LiteralPath $zipPath
Write-Host ("Created {0} ({1:N2} MB)" -f $zip.FullName, ($zip.Length / 1MB))
