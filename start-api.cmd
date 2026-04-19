@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-api.ps1"
exit /b %errorlevel%
