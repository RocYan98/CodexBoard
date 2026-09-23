@echo off
powershell.exe -NoLogo -NoProfile -File "%~dp0taskctl.ps1" %*
exit /b %errorlevel%
