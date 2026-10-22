@echo off
cd /d "%~dp0"
title E.V.E.
node src\launcher.mjs
rem Keep the console open only if Eve crashed, so the error can be read.
if errorlevel 1 pause
