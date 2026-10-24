@echo off
chcp 65001 >nul
cd /d "%~dp0"
py -3 server.py
if errorlevel 1 python server.py
pause
