# Installs Hindsight into .hindsight, with its own Python, leaving the system one alone.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 without a BOM.
#
# Its dependencies have no prebuilt packages for Python 3.15, so this uses 3.13.

# The installed app runs this from its setup dialog with -Root, a writable folder.
param([string]$Root = '')

$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$root = if ($Root) { $Root } else { Join-Path $project '.hindsight' }

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
    Write-Host 'The Python launcher (py) was not found. Install Python 3 from python.org with the py launcher, then run this again.'
    exit 1
}
$tools = Join-Path $root 'venv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $root 'python'
$env:UV_CACHE_DIR = Join-Path $root 'uv-cache'

if (-not (Test-Path "$tools\Scripts\uv.exe")) {
    py -m venv $tools
    & "$tools\Scripts\python.exe" -m pip install --quiet uv
}
$uv = "$tools\Scripts\uv.exe"

# --no-bin keeps uv from adding shortcuts to ~\.local\bin.
& $uv python install 3.13 --no-bin
$python = (Get-ChildItem $env:UV_PYTHON_INSTALL_DIR -Recurse -Depth 2 -Filter python.exe | Select-Object -First 1).FullName

if (-not (Test-Path "$root\env\Scripts\python.exe")) {
    & $uv venv --python $python "$root\env"
}
& $uv pip install --python "$root\env\Scripts\python.exe" 'hindsight-api==1.1.0'

# The default PyTorch package is CPU-only, which makes recall take around six seconds.
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    & $uv pip install --python "$root\env\Scripts\python.exe" --reinstall-package torch `
        --index-url 'https://download.pytorch.org/whl/cu132' 'torch==2.15.0'
}

Write-Host 'Hindsight is installed. Start it with: npm.cmd run hindsight'
