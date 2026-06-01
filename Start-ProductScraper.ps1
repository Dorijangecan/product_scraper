$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot "Start-ProductScraper.bat")
exit $LASTEXITCODE
