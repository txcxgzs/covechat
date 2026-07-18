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
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes).Replace("+", "-").Replace("/", "_").TrimEnd("=")
    }
    finally {
        $generator.Dispose()
    }
}

$envPath = Join-Path $root ".env"
if (-not (Test-Path -LiteralPath $envPath)) {
    $postgresSecret = New-RandomSecret
    $minioSecret = New-RandomSecret
    $contents = @"
# CoveChat 部署配置（自动生成）
# 反向代理上游监听地址（默认只监听本机回环，由宝塔/Nginx/Caddy 反代到公网）
COVECHAT_HTTP_HOST=$HostAddress
COVECHAT_HTTP_PORT=$Port

# 基础设施随机强密码（请勿修改，除非同步轮换对应服务凭据）
POSTGRES_PASSWORD=$postgresSecret
MINIO_ROOT_USER=covechat
MINIO_ROOT_PASSWORD=$minioSecret

# 第 6 轮新增：CSRF 纵深防御的 Origin 允许列表（逗号分隔，不含尾斜杠）。
# 留空 = 开发模式放行所有 Origin（不安全，仅用于本地测试）。
# 生产部署必须设置为实际公网域名，例如：
#   ALLOWED_ORIGINS=https://chat.example.com
ALLOWED_ORIGINS=
"@
    [System.IO.File]::WriteAllText(
        $envPath,
        $contents,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Write-Host "Created .env with random infrastructure passwords." -ForegroundColor Green
    Write-Host ""
    Write-Host "⚠️  重要：编辑 .env 设置 ALLOWED_ORIGINS 为你的公网域名，" -ForegroundColor Yellow
    Write-Host "    否则 Origin 校验处于开发模式放行所有请求（不安全）。" -ForegroundColor Yellow
    Write-Host "    示例：ALLOWED_ORIGINS=https://chat.example.com" -ForegroundColor Yellow
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
