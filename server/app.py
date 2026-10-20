"""Billboard audience dashboard server.

    python app.py                     # read the ESP on USB (auto-detected)
    python app.py --port /dev/ttyUSB0
    python app.py --simulate --backfill 14   # demo data, no hardware needed
"""
import argparse
import asyncio
import json
import logging
import os
import time

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import analytics
import db
import ingest

log = logging.getLogger("app")
STATIC = os.path.join(os.path.dirname(__file__), "static")

app = FastAPI(title="Billboard Audience Tracker")
app.mount("/static", StaticFiles(directory=STATIC), name="static")

clients = set()
loop = None
proc = None


def on_cycle(ts, devices):
    """Called from the ingest thread after every sensor cycle."""
    if loop and clients:
        msg = json.dumps({"type": "cycle", "ts": ts, "count": len(devices), "status": proc.status})
        asyncio.run_coroutine_threadsafe(_broadcast(msg), loop)


async def _broadcast(msg):
    for ws in list(clients):
        try:
            await ws.send_text(msg)
        except Exception:  # noqa: BLE001
            clients.discard(ws)


@app.on_event("startup")
async def _startup():
    global loop
    loop = asyncio.get_running_loop()


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"))


@app.get("/api/status")
def status():
    st = dict(proc.status)
    st["stale"] = not st.get("last_hb") or time.time() - st["last_hb"] > 30
    return st


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


def main():
    global proc
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", help="serial port (default: auto-detect ESP)")
    ap.add_argument("--baud", type=int, default=921600)
    ap.add_argument("--simulate", action="store_true", help="generate synthetic traffic instead of reading the ESP")
    ap.add_argument("--backfill", type=int, default=0, metavar="DAYS", help="with --simulate: pre-generate history")
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
