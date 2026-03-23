$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Error "Python venv not found at $python"
    exit 1
}

Push-Location $root
try {
    & $python -m uvicorn server.app:app --host 0.0.0.0 --port 8000 --reload
}
finally {
    Pop-Location
}
