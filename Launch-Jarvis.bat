@echo off
title J.A.R.V.I.S. // Windows Neural OS Interface
cd /d "%~dp0"
echo Starting J.A.R.V.I.S. Desktop Application...
if not exist "dist\index.html" (
  call npm run build
)
call npx electron .
