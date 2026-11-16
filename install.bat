@echo off
SETLOCAL EnableDelayedExpansion

echo ==========================================
echo BroAgentAI Native Host Installer
echo ==========================================

SET "DIR=%~dp0"
SET "DIR=%DIR:~0,-1%"
SET "EXT_DIST=%DIR%\extension\dist"
SET "BRIDGE_ENTRY=%DIR%\bridge\dist\index.js"

REM 1. Pastikan hasil build extension & bridge ada
if not exist "%BRIDGE_ENTRY%" (
    echo [!] File bridge belum dibuild. Menjalankan npm run build...
    call npm run build
)

REM 2. Cari otomatis Extension ID di Chrome Preferences / Secure Preferences
SET "EXT_ID="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$extPath = '%EXT_DIST%'.ToLower(); $found = ''; foreach ($p in @('Default','Profile 1','Profile 2','Profile 3')) { foreach ($f in @('Secure Preferences','Preferences')) { $pref = Join-Path $env:LOCALAPPDATA ('Google\Chrome\User Data\' + $p + '\' + $f); if (Test-Path $pref) { try { $json = Get-Content $pref -Raw | ConvertFrom-Json; $settings = $json.extensions.settings; if ($settings) { foreach ($prop in $settings.PSObject.Properties) { $pathVal = $prop.Value.path; if ($pathVal -and $pathVal.ToLower() -eq $extPath) { $found = $prop.Name; break } } } } catch {} } if ($found) { break } } if ($found) { break } }; Write-Output $found"`) do (
    SET "EXT_ID=%%I"
)

REM 3. Jika tidak ketemu di Chrome, batalkan proses & beri tahu path lengkap
if "%EXT_ID%"=="" (
    echo.
    echo [X] GAGAL: Ekstensi BroAgentAI belum terpasang di Google Chrome!
    echo.
    echo Chrome tidak mengizinkan instalasi ekstensi unpacked secara otomatis.
    echo Silakan muat ekstensi terlebih dahulu di Chrome:
    echo   1. Buka chrome://extensions/
    echo   2. Aktifkan 'Developer mode' di pojok kanan atas
    echo   3. Klik 'Load unpacked' dan pilih folder berikut:
    echo      %EXT_DIST%
    echo   4. Jalankan ulang install.bat ini setelah ekstensi terpasang.
    echo.
    pause
    exit /b 1
)

echo [+] Extension ID terdeteksi otomatis: %EXT_ID%

REM 4. Buat wrapper .cmd karena Chrome Native Messaging Windows membutuhkan executable/batch (bukan .js langsung)
REM    Disimpan di luar bridge\dist: build (tsup --clean) menghapus isi dist setiap kali jalan.
SET "HOST_CMD=%DIR%\bridge\broagentai-host.cmd"
for /f "usebackq delims=" %%N in (`where node`) do (
    SET "NODE_EXE=%%N"
    goto :found_node
)
:found_node
if "%NODE_EXE%"=="" SET "NODE_EXE=node.exe"

echo @echo off> "%HOST_CMD%"
echo "%NODE_EXE%" "%BRIDGE_ENTRY%" %%*>> "%HOST_CMD%"

REM 5. Buat file manifest JSON sesuai format standar Native Messaging
SET "MANIFEST_DIR=%LOCALAPPDATA%\Google\Chrome\NativeMessagingHosts"
if not exist "%MANIFEST_DIR%" mkdir "%MANIFEST_DIR%"
SET "MANIFEST=%MANIFEST_DIR%\com.broagentai.host.json"

powershell -NoProfile -Command "$m = @{ name = 'com.broagentai.host'; description = 'BroAgentAI native messaging host (local bridge)'; path = '%HOST_CMD%'; type = 'stdio'; allowed_origins = @('chrome-extension://%EXT_ID%/') }; [IO.File]::WriteAllText('%MANIFEST%', ($m | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))"

echo [+] Manifest tersimpan di: %MANIFEST%

REM 6. Daftarkan otomatis ke Windows Registry (Chrome & Edge)
echo [+] Mendaftarkan Native Messaging Host ke Windows Registry...
REG ADD "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.broagentai.host" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
REG ADD "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.broagentai.host" /ve /t REG_SZ /d "%MANIFEST%" /f >nul

echo ==========================================
echo [OK] Instalasi & Registrasi Berhasil!
echo Silakan reload ekstensi di chrome://extensions/
echo ==========================================
pause
