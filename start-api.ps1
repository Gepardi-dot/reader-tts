$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root ".venv\Scripts\python.exe"
$port = 8000

function Get-ListenerInfo([int]$Port) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) {
        return $null
    }

    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $commandLine = $null
    try {
        $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)").CommandLine
    }
    catch {
        $commandLine = $null
    }

    return [pscustomobject]@{
        Port        = $Port
        ProcessId   = $listener.OwningProcess
        ProcessName = if ($process) { $process.ProcessName } else { $null }
        CommandLine = $commandLine
    }
}

if (-not (Test-Path $python)) {
    Write-Error "Python venv not found at $python"
    exit 1
}

$listener = Get-ListenerInfo -Port $port
if ($listener) {
    $isReaderApi =
        $listener.ProcessName -like "python*" -and
        $listener.CommandLine -and
        $listener.CommandLine -match "uvicorn" -and
        $listener.CommandLine -match "server\.app:app"

    if ($isReaderApi) {
        Write-Host "Storybook Reader API is already running at http://localhost:$port"
        exit 0
    }

    $owner = if ($listener.ProcessName) {
        "$($listener.ProcessName) (PID $($listener.ProcessId))"
    }
    else {
        "PID $($listener.ProcessId)"
    }
    Write-Error "Port $port is already in use by $owner. Stop that process or free the port, then run this script again."
    exit 1
}

Push-Location $root
try {
    & $python -m uvicorn server.app:app --host 0.0.0.0 --port $port --reload
}
finally {
    Pop-Location
}
