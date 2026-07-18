[CmdletBinding()]
param(
    [string]$ToolsDirectory = $(if (Test-Path "D:\") { "D:\covechat-tools" } else { ".tools" }),
    [string]$TargetDirectory = $(if (Test-Path "D:\") { "D:\covechat-target" } else { "target" })
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$protocVersion = "35.1"
$protocSha256 = "5D3FF218D7D91EEA95F7569BCB5A98F3030F8996D44151279D9772EDCFF76082"
$archive = Join-Path $ToolsDirectory "protoc-$protocVersion-win64.zip"
$protocDirectory = Join-Path $ToolsDirectory "protoc-$protocVersion"
$protoc = Join-Path $protocDirectory "bin\protoc.exe"

New-Item -ItemType Directory -Force -Path $ToolsDirectory | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest `
        -Uri "https://github.com/protocolbuffers/protobuf/releases/download/v$protocVersion/protoc-$protocVersion-win64.zip" `
        -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $protocSha256) {
    throw "Downloaded protoc archive failed the pinned SHA-256 check."
}
if (-not (Test-Path -LiteralPath $protoc)) {
    Expand-Archive -LiteralPath $archive -DestinationPath $protocDirectory
}

$wasmBindgen = Get-Command wasm-bindgen -ErrorAction SilentlyContinue
if (-not $wasmBindgen -or (& $wasmBindgen.Source --version) -ne "wasm-bindgen 0.2.126") {
    cargo install wasm-bindgen-cli --version 0.2.126 --locked
    $wasmBindgen = Get-Command wasm-bindgen -ErrorAction Stop
}

$env:CARGO_TARGET_DIR = [System.IO.Path]::GetFullPath($TargetDirectory)
$env:PROTOC = [System.IO.Path]::GetFullPath($protoc)
cargo build `
    -p covechat-crypto-core `
    --features signal-protocol,mls-protocol `
    --target wasm32-unknown-unknown `
    --release
if ($LASTEXITCODE -ne 0) {
    throw "Rust/WASM build failed."
}

$wasm = Join-Path $env:CARGO_TARGET_DIR "wasm32-unknown-unknown\release\covechat_crypto_core.wasm"
& $wasmBindgen.Source `
    $wasm `
    --out-dir "apps\web\src\crypto-wasm" `
    --target web `
    --out-name covechat_crypto `
    --typescript
if ($LASTEXITCODE -ne 0) {
    throw "wasm-bindgen generation failed."
}

Write-Host "Generated browser cryptography bindings with pinned official libsignal." -ForegroundColor Green
