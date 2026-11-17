# Billboard Audience Tracker (ESP32 + WiFi/BLE)

Estimates how many people pass and look at a billboard, how long they stay and
how many come back. An ESP32 passively listens for WiFi probe requests and BLE
advertisements from nearby phones and wearables. It streams what it hears over
WiFi to a cloud API, which stores it in Postgres and serves a live dashboard.

## Architecture

```
phones / watches ─WiFi probes + BLE─▶ ESP32 ─HTTPS POST /api/ingest (Bearer key)─▶ Next.js on Vercel ─▶ Postgres (Supabase)
                                                                                        │
                                                                     browser ◀──────────┘  dashboard (Basic auth)
```

| Path | What |
|---|---|
| `packet-tracer/` | Cisco Packet Tracer simulation of the whole system (scripts + build guide) |
| `firmware/` | PlatformIO project for the ESP32 sniffer (WiFi posts batches to the server) |
| `app/` | Next.js app: dashboard shell (`page.tsx`) and REST API (`app/api/*`) |
| `lib/` | Ingest + sessionization, analytics, device classification, fleet health, settings |
| `public/` | Dashboard UI (vanilla JS + Chart.js) |
| `prisma/schema.prisma` | Postgres schema |

## Deploy

1. Create a Postgres database (Supabase/Neon). Use the pooled URL for `DATABASE_URL` and the direct URL for `DIRECT_URL`.
2. Set the environment variables from `.env.example` on your host. Required in production:
   - `DATABASE_URL`, `DIRECT_URL`
   - `HMAC_SALT`: `openssl rand -hex 32`. Set once and never change it, or all device history becomes unlinkable
   - `SENSOR_WIFI_SSID`, `SENSOR_WIFI_PASSWORD`, optionally `PUBLIC_URL`: baked into generated sensor `config.h`
3. `npm install && npx prisma db push` (once, to create tables), then deploy (`npm run build` runs `prisma generate`).
4. Monitor `GET /api/health` (checks the DB).

Local dev: `cp .env.example .env`, fill it in, `npm run dev`. `npm run typecheck` runs `tsc`.

## Adding a sensor

1. In the dashboard open **Fleet → Add billboard**; it downloads a `config.h` with that sensor's key, WiFi and server URL.
2. Save it as `firmware/src/config.h` (git-ignored), connect the ESP32 and flash:

```bash
pip install -r firmware/requirements.txt
flash.bat COM3        # Windows   (no args lists COM ports)
./flash.sh            # Linux / macOS
```

On Windows the ESP32 shows as a COM port in Device Manager; install the CP210x or CH340 driver if it is unknown.
Rotating a sensor's key disconnects it until you flash a new `config.h`.

## How it works

**Sensing (firmware).** Each ~4 s cycle hops WiFi channels 1–13 in promiscuous
mode (160 ms each) and captures probe requests. Then it runs a 2 s passive BLE
scan. Sightings are aggregated per device per cycle (peak RSSI, hit count) and
batched as JSON lines (one per device, plus a heartbeat) and POSTed to `/api/ingest`:

```json
{"t":"w","m":"da:a1:19:..","r":-58,"n":3,"ch":6,"rnd":1,"fp":"9c1e44a0","ssid":""}
{"t":"b","m":"4c:12:..","r":-71,"n":12,"at":1,"mfr":76,"name":""}
{"t":"hb","cyc":812,"up":3250,"heap":161204,"dev":23,"drop":0}
```

`fp` is a hash of the probe's capability IEs (rates, HT/VHT/extended caps). It
stays the same when a phone randomizes its MAC, so the server can merge
randomized WiFi MACs that belong to the same device model.

**Privacy.** Raw MAC addresses are not stored. Each is replaced by
`HMAC-SHA256(salt, kind|mac)[:12]` using the secret `HMAC_SALT`. If the salt
changes, all IDs become unlinkable.

**Visits.** A device's sightings are merged into a *visit* until it goes unseen
for `visit_gap_s` (default 5 min). Each visit stores its start, end and peak
RSSI.

**Zones.** These are computed at query time from a visit's peak RSSI, so
changing thresholds re-classifies all history:

- **Viewer**: peak ≥ `viewer_rssi` (−60 dBm). Close enough to see the billboard.
- **Passer-by**: peak ≥ `passer_rssi` (−80 dBm).
- weaker: ignored.

**Metrics**

| Metric | Definition |
|---|---|
| Est. people | distinct identities ÷ `devices_per_person`. An identity is a device ID; for randomized WiFi MACs it's the probe fingerprint |
| Impressions | viewer visits with dwell ≥ `min_dwell_s` |
| Avg view dwell | mean dwell of impressions |
| Engagement rate | viewers ÷ unique devices |
| Return rate | stable devices in range that were first seen before the range |
| Cohort retention | % of a day's new stable devices seen again on day N |

**User tagging.** In *Devices & Tags*, label a device (e.g. "Raghav's phone",
"Shop staff 1") to tag it. Tagged devices count as stable identities for
retention, even if their address is random. Tick **Ignore** to exclude your
own or staff devices from all audience numbers. Devices that are present
almost all the time (TVs, routers) are flagged as *fixtures* and auto-excluded.

## Radar & device identification

The **Radar** tab plots every device seen in the last 20 s / 1 min / 5 min:
- Distance from the centre is estimated from RSSI with a log-distance model,
  `d = 10^((RSSI@1m − RSSI) / (10·n))`. It uses the advertised BLE TX power
  when a device sends one.
- Angle is a stable hash of the device ID. The sensor can't measure direction.
- Colour = device type; shape = radio (● BLE, ■ WiFi, ◆ AP).
- The shaded discs are the viewer and passer-by zones.

Below the radar are the traffic rings (unique devices per distance band, WiFi
on the left half, BLE on the right) and a type × distance table.

What the sensor captures per device (firmware 1.1):

| Radio | Captured |
|---|---|
| BLE (active scan) | name (incl. scan response), manufacturer data, 16-bit service UUIDs, GAP appearance, TX power |
| WiFi probes | probed SSIDs, WiFi 4/5/6 capability, vendor IE OUIs, WPS device name + model |
| WiFi data frames | clients connected to nearby APs (+ which AP); catches phones that rarely probe |
| Beacons | nearby access points and their SSIDs (shown on the radar, never counted as audience) |

`lib/classify.ts` turns this into a type (phone, computer, wearable, audio,
TV/media, tracker, AP, other) and a model. It uses Apple Continuity messages
(AirPods models, Watch, Find My, Handoff…), Microsoft CDP beacons (Windows
laptop/desktop, Xbox), GAP appearance, service UUIDs (Fast Pair, Tile,
SmartTag, heart-rate…), name patterns and WPS strings. Weak inferences are
marked *(guess)*.

**Privacy note.** Device names often contain people's names ("Raghav's
iPhone"), and probed SSIDs can reveal home and work networks. That defeats
MAC hashing. For a public deployment, consider dropping `name`, `ssids` and
`wps_name` in `detailsFromMsg` in `lib/classify.ts`.

## Phone attention (Apple screen state)

iPhones, iPads and Macs broadcast an "activity" nibble in their BLE Nearby
Info advert (reverse-engineered — furiousMAC / Martin et al. 2019, so treat it
as approximate). `lib/classify.ts` decodes it into three states:

- **idle** — screen off / locked (and Apple Watch on wrist)
- **in use** — screen on, watching video, on a call
- **driving**

Each visit counts how many sightings were idle vs in use. The Overview
**Heads-up viewers** metric is the share of iPhone viewers whose screen was
mostly off — i.e. likely looking *up* at the billboard rather than down at
their phone. It only covers Apple devices that advertised a state
(`heads_up_n` says how many), so read it as a sample, not the whole audience.
The radar tooltip, the Live table and each device's visit history show the
state too.

## Linking rotated addresses (not yet ported)

Phones rotate BLE addresses about every 15 min, so one person can appear as
several devices. The old Python service ran a linker that grouped them via a
shared `entity_id`. That linker was not ported to the Next.js rewrite: the
`entity_id` column and the **Link rotated addresses** setting exist but nothing
populates them yet, so est. people is currently counted per device ID (WiFi
randomized MACs are still merged by probe fingerprint).

## Calibration (do this on site)

1. Mount the ESP where the billboard is. A higher mount with a clear line of
   sight to the street works best.
2. Open the dashboard's **Live** tab, and tag your own phone.
3. Stand where a viewer would stand to read the billboard. Note your phone's
   RSSI in the device drawer. Set **Viewer zone threshold** a few dB below it.
4. Walk to the far edge of the area you want to count and set the
   **Passer-by threshold** the same way.
5. For the radar, hold a phone 1 m from the sensor and set **BLE/WiFi signal
   at 1 m** in Settings. Then adjust the **path-loss exponent** until a phone
   at 10 m reads about 10 m.
6. Count real people by hand for 10–15 min, then compare with *Unique devices*
   over the same window. Set **Devices per person** = devices ÷ people.

## Limitations (worth stating in your report)

- Modern iOS and Android randomize WiFi MACs and rotate BLE addresses about
  every 15 min. Footfall counts stay reasonable, but long-term retention is
  only measured on stable or tagged identities. The retention tab says so.
- Phones probe only intermittently, especially with the screen off. BLE
  catches more of them. Neither sees people without a device.
- RSSI is noisy: bodies, walls and pocket placement shift it by ±10 dB. The
  zones are an estimate of distance, not a measurement.
- A single sensor gives presence, not direction or position.
- Passive sniffing of public broadcast frames is legal in most places, but
  check your local privacy rules (e.g. GDPR or India's DPDP Act) before
  deploying in public. Keep the hashing on, and put up signage.
