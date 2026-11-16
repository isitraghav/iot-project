@echo off
setlocal enabledelayedexpansion
set "SCRIPT_DIR=%~dp0"

:: flash.bat -- ESP32 billboard sensor flash utility
::
:: Usage:
::   flash.bat                        list available COM ports
::   flash.bat COM3                   flash using src\config.h on COM3
::   flash.bat COM3 config.h          copy config.h then flash on COM3

set "PORT=%~1"
set "CONFIG_SRC=%~2"

:: No args -> list COM ports
if "%PORT%"=="" goto :list_ports

:: Copy config.h if provided
if not "%CONFIG_SRC%"=="" (
    if not exist "%CONFIG_SRC%" (
        echo ERROR: File not found: %CONFIG_SRC%
        exit /b 1
    )
    echo Copying config.h from %CONFIG_SRC% ...
    copy /y "%CONFIG_SRC%" "%SCRIPT_DIR%src\config.h" >nul
    if errorlevel 1 (
        echo ERROR: Failed to copy config.h
        exit /b 1
    )
    echo   OK: src\config.h updated.
    echo.
)

:: Show what is being flashed
echo ==============================================================
echo  Billboard ESP32 Flash
echo ==============================================================
echo  Port   : %PORT%
echo  Config : %SCRIPT_DIR%src\config.h
echo ==============================================================
echo.
echo  When you see "Connecting......" below:
echo    1. Hold BOOT button
echo    2. Tap RST button once
echo    3. Release BOOT
echo.
echo Press any key to start, or Ctrl+C to cancel...
pause >nul
echo.

:: Flash
cd /d "%SCRIPT_DIR%"
python -m platformio run --target upload --upload-port %PORT%
set "RC=%ERRORLEVEL%"

echo.
if %RC% equ 0 (
    echo ==============================================================
    echo  SUCCESS -- firmware flashed to %PORT%
    echo  Press RST on the board to start running.
    echo ==============================================================
) else (
    echo ==============================================================
    echo  FAILED (exit code %RC%)
    echo.
    echo  Common causes:
    echo    - Board not in download mode (hold BOOT + tap RST)
    echo    - Wrong COM port -- run "flash.bat" with no args to list
    echo    - Another program has the port open (Serial Monitor, etc.)
    echo ==============================================================
    exit /b %RC%
)
endlocal
goto :eof

:list_ports
echo.
echo Available serial ports:
echo.
set "FOUND=0"
for /f "tokens=1,2*" %%A in ('reg query HKLM\HARDWARE\DEVICEMAP\SERIALCOMM 2^>nul') do (
    if "%%B"=="REG_SZ" (
        set "FOUND=1"
        echo   %%C
    )
)
if "%FOUND%"=="0" echo   (none found)
echo.
echo Usage:
echo   flash.bat COM3                    flash with existing src\config.h
echo   flash.bat COM3 path\to\config.h   copy config.h then flash
echo.
endlocal
goto :eof
