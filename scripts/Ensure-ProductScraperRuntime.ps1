param(
    [string]$RuntimeDir = (Join-Path (Split-Path -Parent $PSScriptRoot) ".runtime\node")
)

$ErrorActionPreference = "Stop"

function Get-NodeMajor {
    param([string]$NodeExe)

    if (-not (Test-Path -LiteralPath $NodeExe)) {
        return $null
    }

    try {
        $major = & $NodeExe -p "process.versions.node.split('.')[0]"
        if ($LASTEXITCODE -eq 0 -and $major -match '^\d+$') {
            return [int]$major
        }
    } catch {
        return $null
    }

    return $null
}

$nodeExe = Join-Path $RuntimeDir "node.exe"
$existingMajor = Get-NodeMajor -NodeExe $nodeExe
if ($existingMajor -eq 22) {
    Write-Host "Project Node.js runtime je spreman: $RuntimeDir"
    exit 0
}

Write-Host "Skidam project Node.js 22 runtime..."

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("product-scraper-node-" + [Guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $tempRoot "node.zip"
$extractDir = Join-Path $tempRoot "extract"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
    $release = $index |
        Where-Object { $_.version -like "v22.*" -and $_.files -contains "win-x64-zip" } |
        Select-Object -First 1

    if (-not $release) {
        throw "Ne mogu pronaci Node.js 22 win-x64 zip na nodejs.org."
    }

    $version = $release.version
    $url = "https://nodejs.org/dist/$version/node-$version-win-x64.zip"
    Write-Host "Preuzimam $version..."
    Invoke-WebRequest -Uri $url -OutFile $zipPath

    Write-Host "Raspakiravam Node.js runtime..."
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

    $sourceDir = Get-ChildItem -LiteralPath $extractDir -Directory |
        Where-Object { $_.Name -like "node-*-win-x64" } |
        Select-Object -First 1

    if (-not $sourceDir) {
        throw "Node.js zip nema ocekivanu strukturu."
    }

    if (Test-Path -LiteralPath $RuntimeDir) {
        Remove-Item -LiteralPath $RuntimeDir -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    Copy-Item -Path (Join-Path $sourceDir.FullName "*") -Destination $RuntimeDir -Recurse -Force

    $installedMajor = Get-NodeMajor -NodeExe $nodeExe
    if ($installedMajor -ne 22) {
        throw "Skinuti Node.js runtime nije v22."
    }

    Write-Host "Project Node.js runtime je spreman: $RuntimeDir"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
