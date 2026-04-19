$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$web = Join-Path $root "web-rewrite"
$port = 5174

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

if (-not (Test-Path $web)) {
    Write-Error "Web workspace not found at $web"
    exit 1
}

if (-not (Test-Path (Join-Path $web "node_modules"))) {
    Write-Error "Frontend dependencies are missing. Run 'npm install' in $web first."
    exit 1
}

$listener = Get-ListenerInfo -Port $port
if ($listener) {
    $isReaderVite =
        $listener.ProcessName -eq "node" -and
        $listener.CommandLine -and
        $listener.CommandLine -match "vite" -and
        $listener.CommandLine -match [regex]::Escape($web)

    if ($isReaderVite) {
        Write-Host "Storybook Reader web app is already running at http://localhost:$port"
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

Push-Location $web
try {
    & npm run dev -- --host --port $port
}
finally {
    Pop-Location
}
