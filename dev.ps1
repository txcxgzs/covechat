[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$WebPort = 5173,
    [ValidateRange(1, 65535)]
    [int]$ApiPort = 8080
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:COVECHAT_WEB_HOST = "127.0.0.1"
$env:COVECHAT_WEB_PORT = "$WebPort"
$env:COVECHAT_API_HOST = "127.0.0.1"
$env:COVECHAT_API_PORT = "$ApiPort"
$env:COVECHAT_API_ORIGIN = "http://127.0.0.1:$ApiPort"

Write-Host "Web: http://127.0.0.1:$WebPort" -ForegroundColor Cyan
Write-Host "API: http://127.0.0.1:$ApiPort"
Write-Host "Point the reverse proxy to Web; /api is forwarded to the API."

$api = Start-Process -FilePath "cargo.exe" -ArgumentList @("run", "-p", "covechat-api") -WorkingDirectory $root -WindowStyle Hidden -PassThru
try {
    npm run dev --prefix $root
}
finally {
    if (-not $api.HasExited) {
        Stop-Process -Id $api.Id
    }
}
