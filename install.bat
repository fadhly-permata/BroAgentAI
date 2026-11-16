@echo off
SETLOCAL
REM BroAgentAI native host installer (Windows).
REM Builds when needed, then registers com.broagentai.host for Chrome and Edge.
REM All logic lives in scripts\native-host.mjs so there is one installer to maintain.

echo ==========================================
echo BroAgentAI Native Host Installer
echo ==========================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [X] Node.js tidak ditemukan di PATH. Install Node.js 22.6+ lalu jalankan ulang.
    goto :fail
)

if not exist "bridge\dist\index.js" goto :build
if not exist "extension\dist\manifest.json" goto :build
goto :install

:build
echo [!] Build belum ada. Menjalankan npm run build...
call npm run build
if errorlevel 1 (
    echo [X] Build gagal.
    goto :fail
)

:install
call node scripts\native-host.mjs install --browser chrome
if errorlevel 1 goto :fail
call node scripts\native-host.mjs install --browser edge
if errorlevel 1 goto :fail

echo ==========================================
echo [OK] Instalasi dan registrasi berhasil.
echo 1. Buka chrome://extensions, aktifkan Developer mode.
echo 2. Load unpacked: %~dp0extension\dist
echo 3. Kalau sudah ter-load, klik Reload pada kartu BroAgentAI.
echo ==========================================
if not "%BROAGENTAI_NO_PAUSE%"=="1" pause
exit /b 0

:fail
if not "%BROAGENTAI_NO_PAUSE%"=="1" pause
exit /b 1
