@echo off
rem Build and flash the ESP32 firmware.
cd /d "%~dp0firmware"
"%~dp0.venv\Scripts\pio.exe" run -t upload %*
