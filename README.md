# Billboard Audience Tracker (ESP32 + WiFi/BLE)

Estimates how many people pass and look at a billboard, how long they stay and
how many come back. An ESP32 passively listens for WiFi probe requests and BLE
advertisements from nearby phones and wearables. It streams what it hears over
USB to this PC, where a Python service stores it and serves a live dashboard.

```
 phones / watches ──WiFi probes + BLE adverts──▶ ESP32 ──USB serial (JSON lines)──▶ server/app.py ──▶ SQLite
                                                                                        │
                                                                         browser ◀──────┘ http://localhost:8000
```

## Production service (Linux)

The dashboard runs as a systemd user service. It starts on boot (linger is
enabled) and restarts on crash. Open http://localhost:8000.

```bash
systemctl --user status billboard      # state
journalctl --user -u billboard -f      # logs
systemctl --user restart billboard     # after code changes
```

The unit file is `~/.config/systemd/user/billboard.service`. To open the
dashboard to your LAN, change `--host 127.0.0.1` to `0.0.0.0` there. The
dashboard has no login, so anyone on the network could see it.

On Windows, just keep `run.bat` running in a terminal. To auto-start on login,
create a Task Scheduler task that runs `run.bat` at logon (or wrap it in a
`.ps1` that stays in the background).

## Layout

| Path | What |
|---|---|
| `firmware/` | PlatformIO project for the ESP32 sniffer |
| `server/app.py` | FastAPI server: REST API, WebSocket live feed, static dashboard |
| `server/ingest.py` | Serial reader, MAC hashing, visit sessionization, traffic simulator |
| `server/analytics.py` | KPIs, zones, dwell, heatmap, retention cohorts |
| `server/static/` | Dashboard UI (vanilla JS + Chart.js) |
| `data/` | `billboard.db` and the secret `salt.key` (created on first run) |

## Setup

### Windows

```bat
rem Install Python env (requires uv: https://github.com/astral-sh/uv)
uv venv .venv
uv pip install -p .venv -r requirements.txt

rem Flash the ESP32 (connect it first; check Device Manager for the COM port)
flash.bat

rem Run the dashboard against the real sensor
run.bat

rem Or demo with no hardware: 14 days of synthetic history + live simulated traffic
run.bat --simulate --backfill 14
```

The ESP32 will appear as a COM port (e.g. `COM3`) in Device Manager under
*Ports (COM & LPT)* — install the CP210x or CH340 driver if it shows as unknown.
Pass `--port COM3` if auto-detect misses it.

### Linux / macOS

```bash
# one-time: serial port access (log out/in afterwards)
sudo usermod -aG dialout $USER

# Python env (already created in .venv)
uv venv .venv && uv pip install -p .venv -r requirements.txt

# flash the ESP32
./flash.sh                 # = pio run -t upload in firmware/

# run the dashboard against the real sensor
./run.sh                   # opens on http://localhost:8000

# or demo with no hardware: 14 days of synthetic history + live simulated traffic
./run.sh --simulate --backfill 14
```

Options: `--port COM3` / `--port /dev/ttyUSB0` (default: auto-detect CP210x/CH340/FTDI/Espressif),
`--host 0.0.0.0` to open the dashboard to your LAN, `--http-port 8000`.
Use `BILLBOARD_DATA=C:\path\to\dir` (Windows) or `BILLBOARD_DATA=/some/dir` (Linux) to keep a
separate database, e.g. for demos.

## How it works

**Sensing (firmware).** Each ~4 s cycle hops WiFi channels 1–13 in promiscuous
mode (160 ms each) and captures probe requests. Then it runs a 2 s passive BLE
scan. Sightings are aggregated per device per cycle (peak RSSI, hit count) and
printed as one JSON line each, followed by a heartbeat line:

```json
{"t":"w","m":"da:a1:19:..","r":-58,"n":3,"ch":6,"rnd":1,"fp":"9c1e44a0","ssid":""}
{"t":"b","m":"4c:12:..","r":-71,"n":12,"at":1,"mfr":76,"name":""}
{"t":"hb","cyc":812,"up":3250,"heap":161204,"dev":23,"drop":0}
```

`fp` is a hash of the probe's capability IEs (rates, HT/VHT/extended caps). It
stays the same when a phone randomizes its MAC, so the server can merge
randomized WiFi MACs that belong to the same device model.

**Privacy.** MAC addresses never touch disk. Each is replaced by
`HMAC-SHA256(salt, kind|mac)[:12]` with a random per-install salt in
`data/salt.key`. If you delete the salt, all IDs become unlinkable.

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

`server/classify.py` turns this into a type (phone, computer, wearable, audio,
TV/media, tracker, AP, other) and a model. It uses Apple Continuity messages
(AirPods models, Watch, Find My, Handoff…), Microsoft CDP beacons (Windows
laptop/desktop, Xbox), GAP appearance, service UUIDs (Fast Pair, Tile,
SmartTag, heart-rate…), name patterns and WPS strings. Weak inferences are
marked *(guess)*.

**Privacy note.** Device names often contain people's names ("Raghav's
iPhone"), and probed SSIDs can reveal home and work networks. That defeats
MAC hashing. For a public deployment, consider dropping `name`, `ssids` and
`wps_name` in `classify.details_from_msg`.

## Phone attention (Apple screen state)

iPhones, iPads and Macs broadcast an "activity" nibble in their BLE Nearby
Info advert (reverse-engineered — furiousMAC / Martin et al. 2019, so treat it
as approximate). `classify.apple_activity` decodes it into three states:

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

## Linking rotated addresses

Phones rotate their BLE address ~every 15 min and randomize WiFi MACs, so one
person shows up as many devices — inflating counts and hiding retention.
`linker.py` runs every 20 s and groups an address that just appeared with one
that just went silent, when they share the same advert signature (Apple/MS
message types, services, TX power, WiFi fingerprint, name), a similar RSSI, and
a short time gap — and only when there's a single clear candidate (ambiguous
matches in a crowd are left alone, since a wrong merge joins two people).

Grouped addresses share one `entity_id`, so est. people, dwell, viewers and
engagement are counted per phone. A device's panel shows how many addresses
were linked. Turn it off with **Link rotated addresses** in Settings. This is
best-effort de-anonymisation of rotating identifiers for counting; it never
recovers a real identity, and it respects the same MAC hashing.

## Calibration (do this on site)

1. Mount the ESP where the billboard is. A higher mount with a clear line of
   sight to the street works best.
2. Run `./run.sh`, open the **Live** tab, and tag your own phone.
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
