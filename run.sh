#!/usr/bin/env bash
# Start the dashboard server. Extra args are passed through, e.g. --simulate --backfill 14
cd "$(dirname "$0")/server" && exec ../.venv/bin/python app.py "$@"
