#pragma once

// ── WiFi ──────────────────────────────────────────────────────────────────
#define WIFI_SSID      "raghav"
#define WIFI_PASSWORD  "123456789"

// ── Server ────────────────────────────────────────────────────────────────
// Your Vercel deployment URL, or http://192.168.x.x:8000 for a local server.
#define SERVER_URL     "https://iot-project-xi-seven.vercel.app"

// Paste the API key from the Fleet page on the dashboard.
#define DEVICE_API_KEY "paste_key_here"

// Human-readable name shown in the Fleet page.
#define DEVICE_NAME    "Billboard #1"

// ── Tuning ────────────────────────────────────────────────────────────────
// POST a batch after accumulating this many sighting lines (or at heartbeat).
#define BATCH_MAX 80

// Seconds to wait for a WiFi connection before giving up and retrying.
#define WIFI_TIMEOUT_S 15
