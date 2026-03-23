$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$web = Join-Path $root "web"

Push-Location $web
try {
    & npm run dev -- --host
}
finally {
    Pop-Location
}
