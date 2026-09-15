@echo off
:: Met à jour OF_REFRESH_TOKEN — double-clic pour lancer
node update-token.js %1
if %ERRORLEVEL% NEQ 0 pause
