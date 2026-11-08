# Installs the HFSS tool server's Python environment into .hfss\env.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 without a BOM.
#
# The venv is built on the Python that ships with Ansys Electronics Desktop, which pyaedt is
# tested against, instead of whatever Python the user has. AEDT's installer sets one
# ANSYSEM_ROOT<version> variable per installed version, e.g. ANSYSEM_ROOT252 for 2025 R2.
#
# Usage: npm.cmd run install-hfss              (newest installed AEDT)
#        npm.cmd run install-hfss -- -Version 242   (a specific one)
#
# The installed app runs this from its setup dialog with -EnvDir (a writable folder, since the
# program folder may not be) and -Requirements (the copy of requirements.txt it ships).

param([string]$Version = '', [string]$EnvDir = '', [string]$Requirements = '')

$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$envDir = if ($EnvDir) { $EnvDir } else { Join-Path $project '.hfss\env' }
$requirements = if ($Requirements) { $Requirements } else { Join-Path $project 'hfss\requirements.txt' }

$roots = Get-ChildItem Env: | Where-Object { $_.Name -match '^ANSYSEM_ROOT(\d{3})$' -and (Test-Path $_.Value) } |
    Sort-Object Name -Descending
if ($Version) { $roots = $roots | Where-Object { $_.Name -eq "ANSYSEM_ROOT$Version" } }
if (-not $roots) {
    Write-Host 'Ansys Electronics Desktop was not found (no ANSYSEM_ROOTxxx environment variable).'
    Write-Host 'Install AEDT first, then run this again.'
    exit 1
}
$root = @($roots)[0]

# The bundled Python's folder name carries its version (3_10 in 2025 R2), so look rather than guess.
$base = Join-Path $root.Value 'commonfiles\CPython'
$python = Get-ChildItem $base -Recurse -Depth 5 -Filter python.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\winx64\\Release\\python\\python\.exe$' } |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $python) {
    Write-Host "No Python found under $base. This AEDT may be too old for pyaedt."
    exit 1
}
Write-Host "Using $($root.Name) and its Python: $($python.FullName)"

if (-not (Test-Path "$envDir\Scripts\python.exe")) {
    & $python.FullName -m venv $envDir
    if ($LASTEXITCODE -ne 0) { throw 'Creating the venv failed.' }
}
Write-Host 'Installing pyaedt and the other packages (a few minutes the first time)...'
& "$envDir\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Installing the requirements failed.' }

& "$envDir\Scripts\python.exe" -c "import ansys.aedt.core, mcp, psutil, numpy; print('pyaedt', ansys.aedt.core.__version__)"
if ($LASTEXITCODE -ne 0) { throw 'The environment does not import cleanly.' }
Write-Host "The HFSS tools are installed in $envDir"
