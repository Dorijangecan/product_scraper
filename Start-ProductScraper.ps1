$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if (-not $env:PDT_AI_CLEANUP) {
    $env:PDT_AI_CLEANUP = "0"
}
npm run desktop
