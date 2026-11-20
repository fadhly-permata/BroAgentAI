# BroAgentAI installer (Windows, PowerShell 5.1+).
#
# The first run prepares everything the bridge needs, then registers the
# native-messaging host com.broagentai.host:
#   1. Node.js 22.6+: the one on PATH, or else a portable copy downloaded from
#      nodejs.org (SHA-256 checked) into .runtime\node. Nothing is installed
#      system-wide and no admin rights are needed.
#   2. npm dependencies (npm ci) when node_modules is missing or out of date,
#      and a check that the terminal backend (node-pty) loads.
#   3. npm run build when the build output is missing (or with -Rebuild).
#   4. scripts\native-host.mjs install for every detected browser.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Browser chrome,edge,brave,chromium] [-Rebuild] [-PortableNode]
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall [-Browser ...]
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string[]]$Browser,
    [switch]$Rebuild,
    [switch]$PortableNode
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow with the progress bar on PS 5.1
Set-Location -LiteralPath $PSScriptRoot

$MinNode = [version]'22.6.0'
$NodeLine = 22 # portable downloads take the latest release of this major line
$RuntimeDir = Join-Path $PSScriptRoot '.runtime'
$PortableDir = Join-Path $RuntimeDir 'node'
$KnownBrowsers = [ordered]@{
    chrome   = 'Google\Chrome\User Data'
    edge     = 'Microsoft\Edge\User Data'
    brave    = 'BraveSoftware\Brave-Browser\User Data'
    chromium = 'Chromium\User Data'
}

function Write-Step([string]$Text) { Write-Host "[..] $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "[OK] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "[!] $Text" -ForegroundColor Yellow }
function Stop-Install([string]$Text) {
    Write-Host "[X] $Text" -ForegroundColor Red
    exit 1
}

# Run a native command without PowerShell turning its stderr into a terminating error.
function Invoke-Native([string]$File, [string[]]$Arguments, [switch]$Quiet) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Quiet) { & $File @Arguments *> $null } else { & $File @Arguments | Out-Host }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
}

function Get-NodeVersion([string]$Exe) {
    if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { return $null }
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Collect all output first: piping a native command into Select-Object -First
        # can stop it early, which leaves a non-zero exit code.
        $lines = @(& $Exe -v 2> $null)
        if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) { return $null }
        $text = [string]$lines[0]
        return [version]($text.Trim().TrimStart('v'))
    } catch {
        return $null
    } finally {
        $ErrorActionPreference = $saved
    }
}

function Install-PortableNode {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { $arch = 'x64' }
        'ARM64' { $arch = 'arm64' }
        default { Stop-Install "Arsitektur $($env:PROCESSOR_ARCHITECTURE) tidak didukung. Install Node.js $MinNode+ manual lalu jalankan ulang." }
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $base = "https://nodejs.org/dist/latest-v$NodeLine.x"

    Write-Step "Mengunduh daftar rilis Node.js $NodeLine dari nodejs.org..."
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    $match = [regex]::Match($sums, "(?m)^([0-9a-f]{64})\s+(node-v[0-9.]+-win-$arch\.zip)\s*$")
    if (-not $match.Success) { Stop-Install "Paket Node.js untuk win-$arch tidak ditemukan di $base." }
    $hash = $match.Groups[1].Value
    $file = $match.Groups[2].Value

    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    $zip = Join-Path $RuntimeDir $file
    Write-Step "Mengunduh $file..."
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $zip
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
    if ($actual -ne $hash) {
        Remove-Item -LiteralPath $zip -Force
        Stop-Install "Checksum $file tidak cocok (diharapkan $hash, didapat $actual)."
    }

    $staging = Join-Path $RuntimeDir 'node-staging'
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $staging
    if (Test-Path -LiteralPath $PortableDir) { Remove-Item -LiteralPath $PortableDir -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $staging ($file -replace '\.zip$', '')) -Destination $PortableDir
    Remove-Item -LiteralPath $staging -Recurse -Force
    Remove-Item -LiteralPath $zip -Force
    Write-Ok "Node.js portable terpasang di $PortableDir"
}

# Returns the full path of a node.exe that is new enough. Downloads one only when $AllowDownload.
function Resolve-Node([bool]$AllowDownload) {
    if (-not $PortableNode) {
        $onPath = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($onPath) {
            $version = Get-NodeVersion $onPath.Source
            if ($version -and $version -ge $MinNode) { return $onPath.Source }
            Write-Warn "Node.js di PATH versi $version terlalu lama (butuh $MinNode+). Memakai Node.js portable."
        }
    }
    $portable = Join-Path $PortableDir 'node.exe'
    $version = Get-NodeVersion $portable
    if ($version -and $version -ge $MinNode) { return $portable }
    if (-not $AllowDownload) { return $null }
    Install-PortableNode
    if (-not (Get-NodeVersion $portable)) { Stop-Install "Node.js portable tidak bisa dijalankan: $portable" }
    return $portable
}

function Get-Browsers {
    if ($Browser) {
        $list = @($Browser | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
        foreach ($name in $list) {
            if (-not $KnownBrowsers.Contains($name)) { Stop-Install "Browser tidak dikenal: $name (pilihan: $($KnownBrowsers.Keys -join ', '))" }
        }
        return $list
    }
    if ($Uninstall) { return @($KnownBrowsers.Keys) }
    $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
    $found = @($KnownBrowsers.Keys | Where-Object { Test-Path -LiteralPath (Join-Path $localAppData $KnownBrowsers[$_]) })
    if ($found.Count -eq 0) {
        Write-Warn 'Tidak ada browser yang terdeteksi; mendaftarkan untuk Chrome dan Edge.'
        return @('chrome', 'edge')
    }
    return $found
}

Write-Host '==========================================' -ForegroundColor Cyan
Write-Host 'BroAgentAI Installer' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan

$browsers = Get-Browsers

if ($Uninstall) {
    $node = Resolve-Node $false
    if (-not $node) { Stop-Install 'Node.js tidak ditemukan, jadi registrasi tidak bisa dihapus otomatis.' }
    foreach ($name in $browsers) {
        if ((Invoke-Native $node @('scripts\native-host.mjs', 'uninstall', '--browser', $name)) -ne 0) { Stop-Install "Gagal menghapus registrasi untuk $name." }
    }
    Write-Ok 'Registrasi native host dihapus.'
    if (Test-Path -LiteralPath $RuntimeDir) { Write-Host "Node.js portable masih ada di $RuntimeDir; hapus folder itu kalau tidak dipakai lagi." }
    exit 0
}

# 1. Node.js
$node = Resolve-Node $true
$nodeDir = Split-Path -Parent $node
$env:Path = "$nodeDir;$env:Path" # npm and its child processes use this same Node
$npm = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm)) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $npmCommand) { Stop-Install 'npm tidak ditemukan. Install ulang Node.js atau jalankan dengan -PortableNode.' }
    $npm = $npmCommand.Source
}
Write-Ok "Node.js $(Get-NodeVersion $node): $node"

# 2. Dependencies
$lock = Join-Path $PSScriptRoot 'package-lock.json'
$installedLock = Join-Path $PSScriptRoot 'node_modules\.package-lock.json'
$needInstall = $false
if (Test-Path -LiteralPath $lock) {
    $needInstall = (-not (Test-Path -LiteralPath $installedLock)) -or
        ((Get-Item -LiteralPath $lock).LastWriteTimeUtc -gt (Get-Item -LiteralPath $installedLock).LastWriteTimeUtc)
} elseif (-not (Test-Path -LiteralPath 'node_modules')) {
    # A release bundle ships node_modules and has no lockfile; never run npm install there.
    Stop-Install 'package-lock.json dan node_modules tidak ada. Unduh ulang bundle atau clone repo lengkap.'
}
if ($needInstall) {
    Write-Step 'Memasang dependensi (npm ci)...'
    if ((Invoke-Native $npm @('ci', '--no-audit', '--no-fund')) -ne 0) {
        Stop-Install 'npm ci gagal. Kalau ada error EPERM/EBUSY, tutup browser (bridge sedang dipakai) lalu jalankan ulang.'
    }
} else {
    Write-Ok 'Dependensi sudah terpasang.'
}

$ptyCheck = @('-e', "require(require.resolve('node-pty', { paths: [process.argv[1]] }))", (Join-Path $PSScriptRoot 'bridge'))
if ((Invoke-Native $node $ptyCheck -Quiet) -ne 0) {
    Write-Step 'Backend terminal (node-pty) belum siap. Menjalankan npm rebuild node-pty...'
    [void](Invoke-Native $npm @('rebuild', 'node-pty', '--foreground-scripts'))
    if ((Invoke-Native $node $ptyCheck -Quiet) -ne 0) {
        Write-Warn 'node-pty tetap tidak bisa di-load. Bridge tetap jalan, tapi tab Terminal tidak tersedia.'
    }
}

# 3. Build
$haveBuild = (Test-Path -LiteralPath 'bridge\dist\index.js') -and (Test-Path -LiteralPath 'extension\dist\manifest.json')
if ($Rebuild -or -not $haveBuild) {
    Write-Step 'Menjalankan npm run build...'
    if ((Invoke-Native $npm @('run', 'build')) -ne 0) { Stop-Install 'Build gagal.' }
} else {
    Write-Ok 'Build sudah ada (pakai -Rebuild untuk build ulang).'
}

# 4. Register the native host (the launcher runs bridge\dist\index.js with this same node.exe)
foreach ($name in $browsers) {
    Write-Step "Mendaftarkan com.broagentai.host untuk $name..."
    if ((Invoke-Native $node @('scripts\native-host.mjs', 'install', '--browser', $name)) -ne 0) { Stop-Install "Registrasi untuk $name gagal." }
}

Write-Host '==========================================' -ForegroundColor Cyan
Write-Ok "Instalasi selesai untuk: $($browsers -join ', ')"
Write-Host '1. Buka chrome://extensions (atau edge://extensions, brave://extensions), aktifkan Developer mode.'
Write-Host "2. Load unpacked: $PSScriptRoot\extension\dist"
Write-Host '3. Kalau sudah ter-load, klik Reload pada kartu BroAgentAI.'
Write-Host '==========================================' -ForegroundColor Cyan
exit 0
