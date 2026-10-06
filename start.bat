@echo off
setlocal enabledelayedexpansion
title PowerDial CRM
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed yet.
  echo Opening the download page. Install the LTS version, then double-click this file again.
  start https://nodejs.org
  pause
  exit /b
)
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NM=%%v
if !NM! GEQ 23 (
  echo Your Node.js is version !NM!. PowerDial needs version 22.
  echo Uninstall Node.js, then install the version 22 .msi from the page that is about to open.
  start https://nodejs.org/dist/latest-v22.x/
  pause
  exit /b
)
if not exist .env (
  copy .env.example .env >nul
  echo First time setup. Choose the login you will use for PowerDial.
  set /p EM=Your email: 
  set /p PW=Choose a password: 
  powershell -NoProfile -Command "$e=$env:EM; $p=$env:PW; (Get-Content .env) | ForEach-Object { if ($_ -match '^ADMIN_EMAIL=') { 'ADMIN_EMAIL=' + $e } elseif ($_ -match '^ADMIN_PASSWORD=') { 'ADMIN_PASSWORD=' + $p } else { $_ } } | Set-Content .env"
)
if not exist node_modules\dotenv (
  echo Installing, this takes about a minute...
  call npm install
)
echo.
echo PowerDial is starting. Leave this window open. Your browser will open in a few seconds.
start "" cmd /c "timeout /t 8 >nul & start http://localhost:3000"
call npm start
pause
