@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 這個視窗留著，關掉組員就進不去。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0share-wall.ps1"
pause
