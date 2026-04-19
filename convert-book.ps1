param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$ArgsFromCaller
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root ".venv\Scripts\python.exe"
$script = Join-Path $root "pdf_to_audio.py"

if (-not (Test-Path $python)) {
    Write-Error "Python venv not found at $python"
    exit 1
}

& $python $script @ArgsFromCaller
exit $LASTEXITCODE
