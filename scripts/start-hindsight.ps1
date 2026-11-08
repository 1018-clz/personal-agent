# Starts the local Hindsight memory service in this terminal. The app also starts it by itself,
# so this is only needed for the live tests or to watch its output.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 without a BOM.
#
# This uses DeepSeek with the key from DEEPSEEK_API_KEY or from "npm.cmd run set-key". The key the
# app's settings page saves is encrypted for the app, so this script cannot read it.
# The key only lives in this process's environment. The Chinese settings are in
# hindsight-launcher.py, shared with the app.

$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$python = Join-Path $project '.hindsight\env\Scripts\python.exe'
if (-not (Test-Path $python)) {
    Write-Host 'Hindsight is not installed. Run: npm.cmd run install-hindsight'
    exit 1
}

$configPath = Join-Path $env:APPDATA 'personal-agent\config.json'
$key = $env:DEEPSEEK_API_KEY
if (-not $key -and (Test-Path $configPath)) {
    $legacy = (Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json).deepseek
    if ($legacy) { $key = $legacy.apiKey }
}
if (-not $key) {
    Write-Host 'No DeepSeek API key found. Set DEEPSEEK_API_KEY, or run: npm.cmd run set-key'
    exit 1
}

$env:HINDSIGHT_API_LLM_API_KEY = $key
$env:PYTHONUTF8 = '1'

& $python (Join-Path $PSScriptRoot 'hindsight-launcher.py')
