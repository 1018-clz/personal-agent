# Saves the DeepSeek API key into config.json without showing it on screen.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 without a BOM.
#
# config.json lives in %APPDATA%, which the command sandbox cannot read. Do not use setx
# instead: it stores the key in HKCU\Environment, and sandboxed commands can read that.

$ErrorActionPreference = 'Stop'

$directory = Join-Path $env:APPDATA 'personal-agent'
$path = Join-Path $directory 'config.json'

$secure = Read-Host 'DeepSeek API Key' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim()
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
if (-not $key) {
    Write-Host 'No key entered. Nothing was changed.'
    exit 1
}

# The prompt hides what was pasted, so a wrong clipboard is otherwise invisible until a 401.
if ($key -cnotmatch '^sk-[A-Za-z0-9_-]{16,}$') {
    $spaces = ($key.ToCharArray() | Where-Object { $_ -eq ' ' }).Count
    Write-Host "That does not look like a DeepSeek API key (length $($key.Length), spaces $spaces)."
    Write-Host 'A key starts with sk- and contains no spaces. Nothing was changed.'
    Write-Host 'Copy it again from https://platform.deepseek.com/api_keys and retry.'
    exit 1
}

New-Item -ItemType Directory -Force -Path $directory | Out-Null
$config = if (Test-Path $path) {
    Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json
} else {
    New-Object PSObject
}
if (-not $config.deepseek) {
    $config | Add-Member -NotePropertyName deepseek -NotePropertyValue (New-Object PSObject)
}
$config.deepseek | Add-Member -NotePropertyName apiKey -NotePropertyValue $key -Force

# Not Set-Content: Windows PowerShell would prepend a BOM.
$json = $config | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding $false))
$ending = $key.Substring($key.Length - 4)
Write-Host "Saved to $path (length $($key.Length), ending in $ending)"
