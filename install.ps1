# BroAgentAI native host installer (PowerShell).
# Thin wrapper: all logic lives in scripts/native-host.mjs.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "BroAgentAI Native Host Installer" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[X] Node.js tidak ditemukan di PATH. Install Node.js 22.6+ lalu jalankan ulang." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path 'bridge\dist\index.js') -or -not (Test-Path 'extension\dist\manifest.json')) {
    Write-Host "[!] Build belum ada. Menjalankan npm run build..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Host "[X] Build gagal." -ForegroundColor Red; exit 1 }
}

foreach ($browser in @('chrome', 'edge')) {
    node scripts\native-host.mjs install --browser $browser
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

Write-Host "[OK] Instalasi dan registrasi berhasil." -ForegroundColor Green
Write-Host "Load unpacked dari: $PSScriptRoot\extension\dist, lalu Reload extension."
