$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "pi-test.ps1") @args
exit $LASTEXITCODE
