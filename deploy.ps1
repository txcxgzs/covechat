[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8088,
    [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker was not found. Install and start Docker Desktop, then run .\deploy.ps1 again."
}

docker compose version | Out-Null

function New-RandomSecret {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).Replace("+", "-").Replace("/", "_").TrimEnd("=")
}

$envPath = Join-Path $root ".env"
if (-not (Test-Path -LiteralPath $envPath)) {
    $postgresSecret = New-RandomSecret
    $minioSecret = New-RandomSecret
    @"
COVECHAT_HTTP_HOST=$HostAddress
COVECHAT_HTTP_PORT=$Port
POSTGRES_PASSWORD=$postgresSecret
MINIO_ROOT_USER=covechat
MINIO_ROOT_PASSWORD=$minioSecret
"@ | Set-Content -LiteralPath $envPath -Encoding utf8NoBOM
    Write-Host "Created .env with random infrastructure passwords." -ForegroundColor Green
}

docker compose --env-file .env -f compose.deploy.yml up -d --build
if ($LASTEXITCODE -ne 0) {
    throw "Deployment failed. Run: docker compose --env-file .env -f compose.deploy.yml logs"
}

$target = "http://${HostAddress}:${Port}"
Write-Host ""
Write-Host "CoveChat is running at: $target" -ForegroundColor Cyan
Write-Host "Reverse proxy upstream: $target"
Write-Host "Status: docker compose --env-file .env -f compose.deploy.yml ps"
Write-Host "Stop: docker compose --env-file .env -f compose.deploy.yml down"
