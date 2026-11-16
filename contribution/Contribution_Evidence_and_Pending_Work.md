# Contribution Evidence and Pending Work

Prepared 16 Nov 2026 for CSE3722. Companion to `IoT_Project_Contribution_Report.docx/.pdf`.
The person allocation is a **proposed allocation, subject to team confirmation**. Source and Git history do not prove who wrote what.

## 1. Material inspected
- `README.md`, `package.json`, `requirements.txt`, `vercel.json`, `next.config.ts`
- `firmware/platformio.ini`, `firmware/src/main.cpp` (424 lines), `firmware/src/config.h` (credentials not reproduced)
- `prisma/schema.prisma`, `app/page.tsx`, `app/layout.tsx`, all `app/api/**/route.ts`
- `lib/ingest.ts`, `lib/fleet.ts`, `lib/analytics.ts`, `lib/classify.ts`, `lib/settings.ts`
- `public/app.js`, `public/radar.js`; `server/*.py` (route and function inventory only)
- Live site `https://iot-project-xi-seven.vercel.app/`, read-only: `/` and `/api/summary` returned 200; `/api/fleet` listed 2 sensors (ESP32-D0WD-V3, firmware billboard-cloud/1.0), both **offline** at review time. One empty-body, unauthenticated POST to `/api/ingest` was sent by mistake during review; it got no response (timed out) and wrote nothing.
- Not done: the course handout PDF and the zip archive named in the original prompt (paths were for another machine); no flashing or hardware test.

## 2. Key implementation evidence
| Claim | Evidence |
|---|---|
| Wi-Fi promiscuous capture, channels 1-13 x 160 ms | main.cpp L146, L194, L22-23 |
| BLE scan, continuous | main.cpp L214, L250 |
| 256-entry table, drops counted | main.cpp L25, L78 |
| HTTPS POST, Bearer key, TLS verification off | main.cpp L298-311 |
| Failed batch discarded (no retry/buffer) | main.cpp L322-365 |
| Ingest auth 401/403 | app/api/ingest/route.ts |
| HMAC device id; salt fallback from DATABASE_URL | lib/ingest.ts L8-19 |
| Cloud stores normalised MAC | schema `devices.mac`; ingest.ts L220 |
| Visits, minute stats, batched SQL | lib/ingest.ts L39-142, L226-249 |
| Fleet status/issues | lib/fleet.ts L5-17, L76-89 |
| Zones, KPIs, retention | lib/analytics.ts L46-65, L77-97 |
| Dashboard polls ~4 s | public/app.js L1206 |

## 3. Discrepancies (code treated as authoritative)
- README describes USB-serial ingestion and per-sighting serial output; current firmware uploads over HTTPS and prints only heartbeat/status lines.
- README: scan cycle ~4 s with 2 s BLE; firmware: continuous BLE, 13 x 160 ms Wi-Fi phase. `BLE_SCAN_SEC` and `BATCH_MAX` are unused; `setMaxResults(0)` is inside a comment (main.cpp L404).
- Firmware `MAX_DEVICES = 256`, `fleet.ts MAX_TABLE = 160`.
- README: "MAC never touches disk"; cloud schema stores `devices.mac`.
- Cloud reads `entity_id` but only the local `linker.py` writes it.

## 4. Security / privacy findings (values deliberately not recorded)
- Dashboard and admin endpoints have no authentication.
- `/api/fleet/[id]/config.h` hardcodes Wi-Fi credentials in source and returns the device key without auth.
- Secrets were tracked in Git history (`firmware/src/config.h`, `data/salt.key`, `data/billboard.db*`, `app/api/fleet/[sensor_id]/config.h/route.ts`). **Rotate the Wi-Fi password, device keys and salt.**

## 5. Not found in inspected material
External sensors, actuator hardware/control, email/SMS/push alerts, MQTT, automated tests, measured performance, 15-paper review, faculty approval.

## 6. Pending work
See report Section 10 (M1-M6) and Section 9 (tests, all "Not measured").
Open questions for the team: names/roll numbers; who actually did what; hardware photos; faculty approval; which external sensor/actuator to add; whether to port the linker to cloud.
