#!/usr/bin/env bash
# Build and flash the ESP32 firmware (needs: pip install -r firmware/requirements.txt).
cd "$(dirname "$0")/firmware" || exit 1
[ -f src/config.h ] || { echo "firmware/src/config.h missing - download it from the dashboard (Fleet > sensor > Download config.h)"; exit 1; }
exec python3 -m platformio run -t upload "$@"
