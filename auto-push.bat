@echo off
cd /d "%~dp0"
title auto-push (Diez Rios)
:loop
echo [%date% %time%] Iniciando auto-push...
node auto-push.js
echo [%date% %time%] auto-push se detuvo (codigo %errorlevel%). Reiniciando en 5s... Ctrl+C para salir.
timeout /t 5 /nobreak >nul
goto loop
