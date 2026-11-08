# Runs the HFSS tool server's offline tests (no AEDT needed, a few seconds).
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 without a BOM.

$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$python = Join-Path $project '.hfss\env\Scripts\python.exe'
if (-not (Test-Path $python)) {
    Write-Host 'The HFSS tools are not installed. Run: npm.cmd run install-hfss'
    exit 1
}
Push-Location (Join-Path $project 'hfss')
try {
    $env:PYTHONIOENCODING = 'utf-8'
    & $python -m hfss_agent.tests.test_offline
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
