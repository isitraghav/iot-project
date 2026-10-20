"""Audience metrics computed from visits.

Zones are derived at query time from each visit's peak RSSI, so changing the
thresholds in Settings re-classifies history immediately.
"""
import json
import math
import time
from collections import defaultdict
from datetime import datetime, timedelta

import classify
import db

CYCLE_S = 4  # one sensor cycle; a single-sighting visit still lasted about this long

RANGES = {  # name -> (seconds, bucket seconds)
    "1h": (3600, 300),
    "today": (None, 3600),
    "24h": (86400, 3600),
    "7d": (7 * 86400, 3 * 3600),
    "30d": (30 * 86400, 86400),
}

_fixture_cache = {"ts": 0, "ids": set()}


def range_bounds(name, now=None):
    now = now or time.time()
    span, bucket = RANGES.get(name, RANGES["24h"])
    if span is None:
        start = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    else:
        start = now - span
    return start, now, bucket


def fixtures(conn, s):
    """Devices that are basically always there: shop TVs, routers, the sensor's neighbours."""
    if time.time() - _fixture_cache["ts"] < 60:
        return _fixture_cache["ids"]
    now_min = int(time.time() // 60)
    thresh = s["fixture_minutes_6h"]
    rows = conn.execute("""
        SELECT device_id, COUNT(*) AS mins, MIN(minute) AS lo, MAX(minute) AS hi,
               SUM(minute >= ?) AS recent
        FROM minute_stats GROUP BY device_id HAVING mins >= ?""", (now_min - 360, min(thresh, 360))).fetchall()
    ids = set()
    for r in rows:
        span = r["hi"] - r["lo"] + 1
        if r["recent"] >= thresh or (r["mins"] >= 360 and r["mins"] / span >= 0.8):
            ids.add(r["device_id"])
    _fixture_cache.update(ts=time.time(), ids=ids)
    return ids


def excluded(conn, s):
    ids = set(r[0] for r in conn.execute("SELECT id FROM devices WHERE ignored=1"))
    if s["auto_exclude_fixtures"]:
        ids |= fixtures(conn, s)
    return ids


def stable_sql(alias="d"):
    return f"({alias}.randomized=0 OR ({alias}.label IS NOT NULL AND {alias}.label != ''))"


def _visits(conn, s, t0, t1, excl):
    rows = conn.execute(f"""
        SELECT v.device_id, v.start, v.end, v.max_rssi, v.phone_idle, v.phone_use,
               d.kind, d.randomized, d.fp, d.label, d.vendor, d.entity_id,
               {stable_sql()} AS stable
        FROM visits v JOIN devices d ON d.id = v.device_id
        WHERE v.start >= ? AND v.start < ? AND v.max_rssi >= ?""", (t0, t1, s["passer_rssi"])).fetchall()
    out = []
    for r in rows:
        if r["device_id"] in excl:
            continue
        # one identity per physical device: a linked group, else a WiFi probe fingerprint, else the address
        if r["entity_id"]:
            identity = r["entity_id"]
        elif r["kind"] == "wifi" and r["randomized"] and r["fp"]:
            identity = f"fp:{r['fp']}"
        else:
            identity = r["device_id"]
        out.append({
            "dev": r["device_id"], "start": r["start"], "dwell": r["end"] - r["start"] + CYCLE_S,
            "rssi": r["max_rssi"], "kind": r["kind"], "identity": identity, "label": r["label"],
            "vendor": r["vendor"], "stable": r["stable"],
            "viewer": r["max_rssi"] >= s["viewer_rssi"],
            "idle": r["phone_idle"], "use": r["phone_use"],
        })
    return out


def _kpis(visits, s):
    devs = {v["dev"] for v in visits}
    viewers = {v["identity"] for v in visits if v["viewer"]}
    impressions = [v for v in visits if v["viewer"] and v["dwell"] >= s["min_dwell_s"]]
    identities = {v["identity"] for v in visits}
    dwell = sorted(v["dwell"] for v in impressions)
    # heads-up: viewer impressions where the phone was mostly idle (not being looked at)
    classified = [v for v in impressions if (v["idle"] + v["use"]) > 0]
    heads_up = [v for v in classified if v["idle"] >= v["use"]]
    return {
        "unique_devices": len(devs),
        "est_people": round(len(identities) / max(s["devices_per_person"], 0.1)),
        "viewers": len(viewers),
        "impressions": len(impressions),
        "avg_dwell": round(sum(dwell) / len(dwell), 1) if dwell else 0,
        "median_dwell": dwell[len(dwell) // 2] if dwell else 0,
        "engagement_rate": round(100 * len(viewers) / len(identities), 1) if identities else 0,
        "heads_up_rate": round(100 * len(heads_up) / len(classified), 1) if classified else None,
        "heads_up_n": len(classified),
    }


def summary(range_name):
    conn = db.connect()
    s = db.get_settings(conn)
    t0, t1, bucket = range_bounds(range_name)
    excl = excluded(conn, s)
    visits = _visits(conn, s, t0, t1, excl)
    prev = _visits(conn, s, t0 - (t1 - t0), t0, excl)

    kpis = _kpis(visits, s)
    prev_kpis = _kpis(prev, s)

    # Return rate: stable devices in range that were also seen before the range
    stable_devs = {v["dev"] for v in visits if v["stable"]}
    returning = 0
    if stable_devs:
        q = ",".join("?" * len(stable_devs))
        returning = conn.execute(f"SELECT COUNT(*) FROM devices WHERE id IN ({q}) AND first_seen < ?",
                                 (*stable_devs, t0)).fetchone()[0]
    kpis["return_rate"] = round(100 * returning / len(stable_devs), 1) if stable_devs else 0
    kpis["stable_devices"] = len(stable_devs)

    # Time series
    n_buckets = math.ceil((t1 - t0) / bucket)
    passer_b = [set() for _ in range(n_buckets)]
    viewer_b = [set() for _ in range(n_buckets)]
    ident_b = [set() for _ in range(n_buckets)]
    for v in visits:
        i = min(int((v["start"] - t0) // bucket), n_buckets - 1)
        (viewer_b if v["viewer"] else passer_b)[i].add(v["dev"])
        ident_b[i].add(v["identity"])
    dpp = max(s["devices_per_person"], 0.1)
    series = [{
        "t": t0 + i * bucket,
        "passersby": len(passer_b[i] - viewer_b[i]),
        "viewers": len(viewer_b[i]),
        "people": round(len(ident_b[i]) / dpp, 1),
    } for i in range(n_buckets)]
    peak = max(series, key=lambda r: r["people"]) if series else None
    kpis["peak_t"] = peak["t"] if peak and peak["people"] > 0 else None
    kpis["peak_people"] = peak["people"] if peak else 0

    # Dwell distribution
    bins = [(0, 10, "<10s"), (10, 30, "10–30s"), (30, 60, "30–60s"), (60, 120, "1–2m"),
            (120, 300, "2–5m"), (300, 1e12, "5m+")]
    dwell_hist = [{"label": b[2], "passersby": 0, "viewers": 0} for b in bins]
    for v in visits:
        for i, (lo, hi, _) in enumerate(bins):
            if lo <= v["dwell"] < hi:
                dwell_hist[i]["viewers" if v["viewer"] else "passersby"] += 1
                break

    # Radio / vendor mix
    kinds = defaultdict(set)
    vendors = defaultdict(set)
    for v in visits:
        kinds[v["kind"]].add(v["dev"])
        vendors[v["vendor"] or ("Randomized" if v["kind"] == "wifi" else "Unknown")].add(v["dev"])
    vendor_list = sorted(((k, len(x)) for k, x in vendors.items()), key=lambda kv: -kv[1])
    if len(vendor_list) > 6:
        other = sum(c for _, c in vendor_list[5:])
        vendor_list = vendor_list[:5] + [("Other", other)]

    conn.close()
    return {
        "range": range_name, "t0": t0, "t1": t1, "bucket": bucket, "settings": s,
        "kpis": kpis, "prev": prev_kpis, "series": series, "dwell": dwell_hist,
        "kinds": {k: len(x) for k, x in kinds.items()},
        "vendors": [{"name": k, "count": c} for k, c in vendor_list],
        "excluded": len(excl),
    }


def heatmap(days=28):
    """Average estimated people per weekday x hour over the last `days` days."""
    conn = db.connect()
    s = db.get_settings(conn)
    t1 = time.time()
    t0 = t1 - days * 86400
    visits = _visits(conn, s, t0, t1, excluded(conn, s))
    conn.close()
    cells = defaultdict(set)  # (date, hour) -> identities
    for v in visits:
        dt = datetime.fromtimestamp(v["start"])
        cells[(dt.date(), dt.hour)].add(v["identity"])
    # how many times each weekday occurs in the window (for averaging)
    occurrences = defaultdict(int)
    d = datetime.fromtimestamp(t0).date()
    while d <= datetime.fromtimestamp(t1).date():
        occurrences[d.weekday()] += 1
        d += timedelta(days=1)
    first_day = min((k[0] for k in cells), default=None)
    if first_day:  # don't average over days before the sensor existed
        occurrences = defaultdict(int)
        d = first_day
        while d <= datetime.fromtimestamp(t1).date():
            occurrences[d.weekday()] += 1
            d += timedelta(days=1)
    grid = [[0.0] * 24 for _ in range(7)]
    for (date, hour), ids in cells.items():
        grid[date.weekday()][hour] += len(ids)
    dpp = max(s["devices_per_person"], 0.1)
    for wd in range(7):
        for h in range(24):
            n = occurrences[wd] or 1
            grid[wd][h] = round(grid[wd][h] / n / dpp, 1)
    return {"grid": grid, "days": days}


def retention(days=14):
    conn = db.connect()
    s = db.get_settings(conn)
    excl = excluded(conn, s)
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    t0 = (today - timedelta(days=days - 1)).timestamp()
    stable_clause = f"AND {stable_sql()}" if s["retention_stable_only"] else ""
    rows = conn.execute(f"""
        SELECT DISTINCT v.device_id, CAST((v.start - ?) / 86400 AS INTEGER) AS day, d.first_seen
        FROM visits v JOIN devices d ON d.id = v.device_id
        WHERE v.start >= ? AND v.max_rssi >= ? {stable_clause}""",
                        (t0, t0, s["passer_rssi"])).fetchall()
    conn.close()

    active = defaultdict(set)
    first_day = {}
    for r in rows:
        if r["device_id"] in excl:
            continue
        active[r["day"]].add(r["device_id"])
        fd = int((r["first_seen"] - t0) // 86400)
        first_day[r["device_id"]] = fd

    daily = []
    for d in range(days):
        devs = active.get(d, set())
        new = sum(1 for x in devs if first_day[x] >= d)
        daily.append({"t": t0 + d * 86400, "new": new, "returning": len(devs) - new})

    max_k = 7
    cohorts = []
    for d in range(days):
        members = [x for x in active.get(d, set()) if first_day[x] == d]
        if not members:
            continue
        ret = []
        for k in range(1, max_k + 1):
            if d + k >= days:
                ret.append(None)
            else:
                ret.append(round(100 * sum(1 for x in members if x in active.get(d + k, ())) / len(members), 1))
        cohorts.append({"t": t0 + d * 86400, "size": len(members), "ret": ret})

    freq_bins = [("1 day", 1, 1), ("2 days", 2, 2), ("3 days", 3, 3), ("4–6 days", 4, 6), ("7+ days", 7, 10 ** 6)]
    days_seen = defaultdict(int)
    for d, devs in active.items():
        for x in devs:
            days_seen[x] += 1
    freq = [{"label": lbl, "count": sum(1 for n in days_seen.values() if lo <= n <= hi)} for lbl, lo, hi in freq_bins]
    total = len(days_seen)
    repeat = sum(1 for n in days_seen.values() if n > 1)
    return {"days": days, "daily": daily, "cohorts": cohorts, "frequency": freq,
            "total": total, "repeat_rate": round(100 * repeat / total, 1) if total else 0,
            "stable_only": bool(s["retention_stable_only"])}


def live(window_s=60):
    conn = db.connect()
    s = db.get_settings(conn)
    now = time.time()
    excl = excluded(conn, s)
    rows = conn.execute("""SELECT id, kind, vendor, label, last_rssi, last_seen, randomized, name, dev_type, model, details
                           FROM devices WHERE last_seen >= ? AND kind != 'ap' ORDER BY last_rssi DESC""",
                        (now - window_s,)).fetchall()
    devices = []
    zones = {"viewer": 0, "passerby": 0, "far": 0}
    for r in rows:
        if r["id"] in excl:
            continue
        z = "viewer" if r["last_rssi"] >= s["viewer_rssi"] else "passerby" if r["last_rssi"] >= s["passer_rssi"] else "far"
        zones[z] += 1
        d = dict(r)
        det = json.loads(d.pop("details")) if d.get("details") else {}
        devices.append({**d, "zone": z, "activity": det.get("activity"), "activity_label": det.get("activity_label")})
    now_min = int(now // 60)
    per_min = conn.execute("""SELECT minute, device_id, max_rssi FROM minute_stats
                              WHERE minute > ? AND max_rssi >= ?""", (now_min - 60, s["passer_rssi"])).fetchall()
    conn.close()
    buckets = defaultdict(lambda: [0, 0])
    for r in per_min:
        if r["device_id"] in excl:
            continue
        buckets[r["minute"]][0 if r["max_rssi"] >= s["viewer_rssi"] else 1] += 1
    minutes = [{"t": m * 60, "viewers": buckets[m][0], "passersby": buckets[m][1]}
               for m in range(now_min - 59, now_min + 1)]
    dpp = max(s["devices_per_person"], 0.1)
    return {"zones": zones, "devices": devices[:50], "minutes": minutes,
            "est_people_now": round((zones["viewer"] + zones["passerby"]) / dpp, 1)}


def devices(range_name="24h", q="", tagged_only=False, kind="", dev_type="", limit=500):
    conn = db.connect()
    s = db.get_settings(conn)
    t0, t1, _ = range_bounds(range_name)
    fx = fixtures(conn, s)
    where = ["d.last_seen >= ?"]
    args = [t0]
    if tagged_only:
        where = ["d.label IS NOT NULL AND d.label != ''"]
        args = []
    if q:
        where.append("(d.id LIKE ? OR d.label LIKE ? OR d.vendor LIKE ? OR d.name LIKE ? OR d.model LIKE ? OR d.details LIKE ?)")
        args += [f"%{q}%"] * 6
    if kind:
        where.append("d.kind = ?")
        args.append(kind)
    else:
        where.append("d.kind != 'ap'")
    if dev_type:
        where.append("d.dev_type = ?")
        args.append(dev_type)
    rows = conn.execute(f"""
        SELECT d.*, COUNT(v.id) AS visits, COALESCE(SUM(v.end - v.start + {CYCLE_S}), 0) AS total_dwell,
               MAX(v.max_rssi) AS peak_rssi, COUNT(DISTINCT date(v.start, 'unixepoch', 'localtime')) AS days_seen
        FROM devices d LEFT JOIN visits v ON v.device_id = d.id
        WHERE {' AND '.join(where)}
        GROUP BY d.id ORDER BY d.last_seen DESC LIMIT ?""", (*args, limit)).fetchall()
    conn.close()
    return [{**dict(r), "details": json.loads(r["details"]) if r["details"] else {},
             "fixture": r["id"] in fx, "stable": not r["randomized"],
             "distance": classify.distance_m(r["last_rssi"], r["kind"], json.loads(r["details"] or "{}"), s)}
            for r in rows]


def device_detail(dev_id):
    conn = db.connect()
    d = conn.execute("SELECT * FROM devices WHERE id=?", (dev_id,)).fetchone()
    if not d:
        conn.close()
        return None
    visits = conn.execute("""SELECT start, end, max_rssi, samples, phone_idle, phone_use FROM visits WHERE device_id=?
                             ORDER BY start DESC LIMIT 100""", (dev_id,)).fetchall()
    now_min = int(time.time() // 60)
    rssi = conn.execute("""SELECT minute, max_rssi FROM minute_stats WHERE device_id=? AND minute > ?
                           ORDER BY minute""", (dev_id, now_min - 24 * 60)).fetchall()
    # addresses grouped under this one as a single physical device (MAC rotations)
    root = d["entity_id"] or dev_id
    linked = conn.execute("""SELECT COUNT(*) FROM devices WHERE entity_id=? OR id=?""", (root, root)).fetchone()[0]
    s = db.get_settings(conn)
    conn.close()
    dev = dict(d)
    dev["details"] = json.loads(dev["details"]) if dev.get("details") else {}
    dev["distance"] = classify.distance_m(dev["last_rssi"], dev["kind"], dev["details"], s)
    dev["linked_addresses"] = linked
    dev["details"].pop("md", None)
    return {"device": dev,
            "visits": [{**dict(v), "dwell": v["end"] - v["start"] + CYCLE_S} for v in visits],
            "rssi": [{"t": r["minute"] * 60, "rssi": r["max_rssi"]} for r in rssi]}


def visits_csv(range_name):
    conn = db.connect()
    s = db.get_settings(conn)
    t0, t1, _ = range_bounds(range_name)
    rows = conn.execute("""SELECT v.device_id, d.kind, d.vendor, d.label, d.randomized, v.start, v.end, v.max_rssi
                           FROM visits v JOIN devices d ON d.id=v.device_id
                           WHERE v.start >= ? AND v.start < ? ORDER BY v.start""", (t0, t1)).fetchall()
    conn.close()
    yield "device_id,kind,vendor,label,randomized,start,end,dwell_s,max_rssi,zone\n"
    for r in rows:
        zone = "viewer" if r["max_rssi"] >= s["viewer_rssi"] else "passerby" if r["max_rssi"] >= s["passer_rssi"] else "far"
        label = (r["label"] or "").replace('"', "'")
        yield (f'{r["device_id"]},{r["kind"]},"{r["vendor"] or ""}","{label}",{r["randomized"]},'
               f'{datetime.fromtimestamp(r["start"]).isoformat(timespec="seconds")},'
               f'{datetime.fromtimestamp(r["end"]).isoformat(timespec="seconds")},'
               f'{round(r["end"] - r["start"] + CYCLE_S)},{r["max_rssi"]},{zone}\n')


BANDS = [(0, 2), (2, 5), (5, 10), (10, 20), (20, 40), (40, None)]


def _band(dist):
    for i, (lo, hi) in enumerate(BANDS):
        if hi is None or dist < hi:
            return i
    return len(BANDS) - 1


def radar(window_s=None, include_ap=False):
    """Devices currently in range with estimated distance, for the radar view."""
    conn = db.connect()
    s = db.get_settings(conn)
    window_s = window_s or s["radar_window_s"]
    now = time.time()
    excl = excluded(conn, s)
    rows = conn.execute(f"""SELECT id, kind, vendor, label, name, last_rssi, last_seen, randomized, dev_type, model,
                                   confidence, details, ignored
                            FROM devices WHERE last_seen >= ? {"" if include_ap else "AND kind != 'ap'"}""",
                        (now - window_s,)).fetchall()
    conn.close()
    out = []
    for r in rows:
        details = json.loads(r["details"]) if r["details"] else {}
        dist = classify.distance_m(r["last_rssi"], r["kind"], details, s)
        z = "viewer" if r["last_rssi"] >= s["viewer_rssi"] else "passerby" if r["last_rssi"] >= s["passer_rssi"] else "far"
        out.append({
            "id": r["id"], "kind": r["kind"], "type": r["dev_type"] or "other", "model": r["model"],
            "confidence": r["confidence"], "name": r["name"], "label": r["label"], "vendor": r["vendor"],
            "rssi": r["last_rssi"], "age": round(now - r["last_seen"], 1), "distance": dist, "zone": z,
            "randomized": bool(r["randomized"]), "excluded": r["id"] in excl,
            "ssids": details.get("ssids") or [], "wifi_gen": details.get("wifi_gen"),
            "connected": bool(details.get("connected")),
            "activity": details.get("activity"), "activity_label": details.get("activity_label"),
        })
    out.sort(key=lambda d: d["distance"] or 999)
    # where the RSSI zone thresholds sit on the distance scale (BLE model, approximate)
    zones = {"viewer_m": round(10 ** ((s["rssi_1m_ble"] - s["viewer_rssi"]) / (10 * s["path_loss_n"])), 1),
             "passer_m": round(10 ** ((s["rssi_1m_ble"] - s["passer_rssi"]) / (10 * s["path_loss_n"])), 1)}
    return {"devices": out, "zones": zones, "window_s": window_s,
            "types": [{"key": t, "label": classify.TYPE_LABELS[t]} for t in classify.TYPES]}


def bands(range_name="24h"):
    """Unique devices per distance band (closest approach of each visit), split by radio and by type."""
    conn = db.connect()
    s = db.get_settings(conn)
    t0, t1, _ = range_bounds(range_name)
    excl = excluded(conn, s)
    rows = conn.execute("""SELECT v.device_id, MAX(v.max_rssi) AS rssi, d.kind, d.dev_type, d.details
                           FROM visits v JOIN devices d ON d.id = v.device_id
                           WHERE v.start >= ? AND v.start < ? GROUP BY v.device_id""", (t0, t1)).fetchall()
    conn.close()
    grid = {k: [0] * len(BANDS) for k in ("wifi", "ble")}
    types = defaultdict(lambda: [0] * len(BANDS))
    for r in rows:
        if r["device_id"] in excl or r["kind"] not in grid:
            continue
        dist = classify.distance_m(r["rssi"], r["kind"], json.loads(r["details"] or "{}"), s)
        b = _band(dist)
        grid[r["kind"]][b] += 1
        types[r["dev_type"] or "other"][b] += 1
    return {
        "range": range_name,
        "bands": [{"lo": lo, "hi": hi, "label": f"{lo}–{hi} m" if hi else f"{lo}+ m"} for lo, hi in BANDS],
        "wifi": grid["wifi"], "ble": grid["ble"],
        "types": [{"key": t, "label": classify.TYPE_LABELS[t], "bands": types[t], "total": sum(types[t])}
                  for t in classify.TYPES if t in types],
    }
