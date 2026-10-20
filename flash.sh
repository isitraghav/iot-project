#!/usr/bin/env bash
# Build and flash the ESP32 firmware. Pauses the billboard service while flashing (it holds the serial port).
cd "$(dirname "$0")/firmware" || exit 1
running=$(systemctl --user is-active billboard 2>/dev/null)
[ "$running" = active ] && systemctl --user stop billboard
../.venv/bin/pio run -t upload "$@"; rc=$?
[ "$running" = active ] && systemctl --user start billboard
exit $rc
