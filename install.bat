@echo off
SETLOCAL
REM BroAgentAI installer (Windows). Double-click friendly wrapper around install.ps1,
REM which prepares Node.js, npm dependencies and the build, then registers
REM com.broagentai.host for the detected browsers.
REM Arguments are passed through, e.g.:  install.bat -Uninstall   or   install.bat -Rebuild

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%BROAGENTAI_NO_PAUSE%"=="1" pause
exit /b %RC%
