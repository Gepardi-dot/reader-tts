param(
    [string]$Distro = "Ubuntu",
    [string]$User = "",
    [string]$VenvPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Convert-WindowsPathToWsl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = (Resolve-Path -LiteralPath $Path).Path.Replace('\', '/')
    if ($resolved.Length -lt 3 -or $resolved[1] -ne ':') {
        throw "Unsupported Windows path for WSL conversion: $Path"
    }

    $drive = $resolved.Substring(0, 1).ToLowerInvariant()
    $suffix = $resolved.Substring(2)
    return "/mnt/$drive$suffix"
}

$scriptPath = Join-Path $PSScriptRoot "setup_neutts_wsl.sh"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing setup script: $scriptPath"
}

$linuxScriptPath = Convert-WindowsPathToWsl -Path $scriptPath
$wslCommand = Get-Command wsl.exe -ErrorAction SilentlyContinue
if ($wslCommand) {
    $wslExe = $wslCommand.Source
} else {
    $wslCommand = Get-Command wsl -ErrorAction SilentlyContinue
    $wslExe = if ($wslCommand) { $wslCommand.Source } else { $null }
}
if (-not $wslExe) {
    throw "WSL is not installed or not available on PATH."
}

if ($User) {
    $baseArgs = @("-d", $Distro, "-u", $User, "--", "bash", $linuxScriptPath)
} else {
    $baseArgs = @("-d", $Distro, "--", "bash", $linuxScriptPath)
}

if ($VenvPath) {
    & $wslExe @baseArgs $VenvPath
} else {
    & $wslExe @baseArgs
}
