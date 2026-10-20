"""Billboard audience dashboard server.

    python app.py                     # read the ESP on USB (auto-detected)
    python app.py --port COM3
    python app.py --simulate --backfill 14   # demo data, no hardware needed

On Vercel the app is stateless: serial/simulator modes are not available.
ESP32 devices push data via POST /api/ingest authenticated with their API key.
"""
import sys
import os
# Ensure server/ siblings are importable when Vercel runs from the repo root
sys.path.insert(0, os.path.dirname(__file__))

import argparse
import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import analytics
import db
import ingest

log = logging.getLogger("app")
STATIC = os.path.join(os.path.dirname(__file__), "static")

clients = set()
loop = None
proc = None  # set by main() in local mode; None on Vercel


@asynccontextmanager
async def lifespan(app: FastAPI):
    global loop
    loop = asyncio.get_running_loop()
    yield


app = FastAPI(title="Billboard Audience Tracker", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def on_cycle(ts, devices):
    if loop and clients:
        msg = json.dumps({"type": "cycle", "ts": ts, "count": len(devices), "status": proc.status if proc else {}})
        asyncio.run_coroutine_threadsafe(_broadcast(msg), loop)


async def _broadcast(msg):
    for ws in list(clients):
        try:
            await ws.send_text(msg)
        except Exception:  # noqa: BLE001
            clients.discard(ws)


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"))


@app.get("/api/status")
def status():
    if proc:
        st = dict(proc.status)
        st["stale"] = not st.get("last_hb") or time.time() - st["last_hb"] > 30
        return st
    return {"source": "cloud", "connected": True, "stale": False, "sensors": len(db.list_sensors())}


@app.get("/api/summary")
def summary(range: str = "24h"):
    return analytics.summary(range)


@app.get("/api/heatmap")
def heatmap(days: int = 28):
    return analytics.heatmap(days)


@app.get("/api/retention")
def retention(days: int = 14):
    return analytics.retention(max(2, min(days, 90)))


@app.get("/api/live")
def live():
    return analytics.live()


@app.get("/api/devices")
def devices(range: str = "24h", q: str = "", tagged: bool = False, kind: str = "", type: str = ""):
    return analytics.devices(range, q, tagged, kind, type)


@app.get("/api/radar")
def radar(window: int = 0, ap: bool = False):
    return analytics.radar(window or None, ap)


@app.get("/api/bands")
def bands(range: str = "24h"):
    return analytics.bands(range)


@app.get("/api/devices/{dev_id}")
def device(dev_id: str):
    d = analytics.device_detail(dev_id)
    if not d:
        raise HTTPException(404)
    return d


class DevicePatch(BaseModel):
    label: str | None = None
    ignored: bool | None = None


@app.patch("/api/devices/{dev_id}")
def patch_device(dev_id: str, body: DevicePatch):
    conn = db.connect()
    with db.write_lock:
        if body.label is not None:
            conn.execute("UPDATE devices SET label=? WHERE id=?", (body.label.strip() or None, dev_id))
        if body.ignored is not None:
            conn.execute("UPDATE devices SET ignored=? WHERE id=?", (int(body.ignored), dev_id))
        conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/settings")
def get_settings():
    conn = db.connect()
    s = db.get_settings(conn)
    conn.close()
    return s


@app.put("/api/settings")
def put_settings(values: dict):
    conn = db.connect()
    with db.write_lock:
        db.save_settings(conn, values)
    conn.close()
    if proc:
        proc.reload_settings()
    analytics._fixture_cache["ts"] = 0
    return get_settings()


@app.get("/api/export/visits.csv")
def export_visits(range: str = "7d"):
    return StreamingResponse(analytics.visits_csv(range), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="visits-{range}.csv"'})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        clients.discard(ws)


# ─────────────────────────────────────────────── Fleet management

@app.get("/api/fleet")
def fleet_list():
    sensors = db.list_sensors()
    for s in sensors:
        s.pop("api_key", None)  # never expose keys in list
    return sensors


class SensorCreate(BaseModel):
    name: str
    location: str = ""


@app.post("/api/fleet", status_code=201)
def fleet_create(body: SensorCreate):
    if not body.name.strip():
        raise HTTPException(400, "name required")
    return db.create_sensor(body.name.strip(), body.location.strip())


@app.delete("/api/fleet/{sensor_id}", status_code=204)
def fleet_delete(sensor_id: str):
    db.delete_sensor(sensor_id)


@app.post("/api/fleet/{sensor_id}/rotate-key")
def fleet_rotate(sensor_id: str):
    new_key = db.rotate_sensor_key(sensor_id)
    return {"api_key": new_key}


@app.get("/api/fleet/{sensor_id}/config.h")
def fleet_config(sensor_id: str, wifi_ssid: str = "your_wifi", wifi_pass: str = "your_password"):
    """Download a ready-to-flash config.h for this sensor."""
    sensors = db.list_sensors()
    # fetch the full record including api_key
    conn = db.connect()
    row = conn.execute("SELECT * FROM sensors WHERE id=?", (sensor_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404)
    s = dict(row)
    host = os.environ.get("VERCEL_URL", "http://localhost:8000")
    if not host.startswith("http"):
        host = "https://" + host
    content = f"""#pragma once
// Auto-generated by Billboard Fleet — do not edit manually.

#define WIFI_SSID      "{wifi_ssid}"
#define WIFI_PASSWORD  "{wifi_pass}"

#define SERVER_URL     "{host}"
#define DEVICE_API_KEY "{s['api_key']}"
#define DEVICE_NAME    "{s['name']}"

#define BATCH_MAX      80
#define WIFI_TIMEOUT_S 15
"""
    return StreamingResponse(
        iter([content]), media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="config.h"'},
    )


# ─────────────────────────────────────────────── HTTP ingest (from ESP32)

@app.post("/api/ingest")
async def http_ingest(request: Request):
    """Receive a batch of sightings from an ESP32 over WiFi."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "missing Bearer token")
    api_key = auth[7:].strip()
    sensor = db.get_sensor_by_key(api_key)
    if not sensor:
        raise HTTPException(403, "invalid API key")

    body = await request.json()
    msgs = body.get("msgs", [])
    if not msgs:
        return {"ok": True, "processed": 0}

    # Create a fresh Processor for this sensor (it recovers open visits from DB)
    p = ingest.Processor(sensor_id=sensor["id"])
    ts = time.time()
    for msg in msgs:
        try:
            p.handle(msg, ts)
        except Exception as e:  # noqa: BLE001
            log.warning("ingest error: %s", e)

    # Update sensor last_seen
    conn = db.connect()
    with db.write_lock:
        conn.execute("UPDATE sensors SET last_seen=? WHERE id=?", (ts, sensor["id"]))
        conn.commit()
    conn.close()

    return {"ok": True, "processed": len(msgs)}


def main():
    global proc
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", help="serial port (default: auto-detect ESP); e.g. COM3 on Windows, /dev/ttyUSB0 on Linux")
    ap.add_argument("--baud", type=int, default=921600)
    ap.add_argument("--simulate", action="store_true")
    ap.add_argument("--backfill", type=int, default=0, metavar="DAYS")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--http-port", type=int, default=8000)
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    db.init()
    proc = ingest.Processor(on_cycle=on_cycle)
    if args.simulate:
        sim = ingest.Simulator(proc)
        if args.backfill:
            sim.backfill(args.backfill)
        sim.start()
    else:
        ingest.SerialSource(proc, args.port, args.baud).start()

    uvicorn.run(app, host=args.host, port=args.http_port, log_level="warning")


if __name__ == "__main__":
    main()
