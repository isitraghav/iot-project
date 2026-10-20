@echo off
rem Start the dashboard server. Extra args are passed through, e.g. --simulate --backfill 14
cd /d "%~dp0server"
"%~dp0.venv\Scripts\python.exe" app.py %*
