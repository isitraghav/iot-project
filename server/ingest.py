"""Turns raw ESP sightings into devices, per-minute stats and visits.

Raw MAC addresses are never stored: each one is replaced by a salted HMAC so
the database only holds pseudonymous device IDs.
"""
import hashlib
import hmac
import json
import logging
import os
import random
import secrets
import threading
import time

import classify
import db
import linker
import vendors

log = logging.getLogger("ingest")

RSSI_FLOOR = -95


def _load_salt():
    path = os.path.join(db.DATA_DIR, "salt.key")
    os.makedirs(db.DATA_DIR, exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
        if os.name != "nt":
            os.chmod(path, 0o600)
    with open(path) as f:
        return bytes.fromhex(f.read().strip())


class Processor:
    def __init__(self, on_cycle=None, sensor_id=None):
        self.salt = _load_salt()
        self.conn = db.connect()
        self.settings = db.get_settings(self.conn)
        self.open_visits = {}      # device_id -> [visit_id, end_ts, max_rssi, samples]
        self.cycle_devices = []    # sightings since last heartbeat, for the live feed
        self.profiles = {}         # device_id -> [details, ble_name, dev_type, model, confidence]
        self.on_cycle = on_cycle
        self.autocommit = True     # backfill turns this off and commits in batches
        self.sensor_id = sensor_id
        self.status = {"source": None, "connected": False, "last_hb": None, "fw": None,
                       "chip": None, "heap": None, "uptime": None, "cycles": 0, "dropped": 0}
        self.known = set(r[0] for r in self.conn.execute("SELECT id FROM devices"))
        # resume visits that were still open when the server last stopped
        for r in self.conn.execute("""SELECT id, device_id, end, max_rssi, samples, phone_idle, phone_use
                                       FROM visits WHERE end >= ?""",
                                   (time.time() - self.settings["visit_gap_s"],)):
            self.open_visits[r["device_id"]] = [r["id"], r["end"], r["max_rssi"], r["samples"],
                                                r["phone_idle"], r["phone_use"]]
        self.last_link = 0

    def device_id(self, kind, mac):
        digest = hmac.new(self.salt, f"{kind}|{mac.lower()}".encode(), hashlib.sha256).hexdigest()
        return digest[:12]

    def reload_settings(self):
        with db.write_lock:
            self.settings = db.get_settings(self.conn)

    def handle_line(self, line, ts=None):
        line = line.strip()
        if not line.startswith("{"):
            return
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            return
        self.handle(msg, ts or time.time())

    def handle(self, msg, ts):
        t = msg.get("t")
        if t in ("w", "b", "a"):
            self._sighting(msg, ts)
        elif t == "hb":
            self._heartbeat(msg, ts)
        elif t == "hello":
            self.status.update(fw=msg.get("fw"), chip=msg.get("chip"))
            log.info("sensor online: %s", msg)

    def _profile(self, dev):
        """Cached (details, ble_name, dev_type, model, confidence) for a known device."""
        p = self.profiles.get(dev)
        if p is None and dev in self.known:
            r = self.conn.execute("SELECT details, name, kind, dev_type, model, confidence FROM devices WHERE id=?",
                                  (dev,)).fetchone()
            if r:
                details = json.loads(r["details"]) if r["details"] else {}
                p = [details, r["name"] if r["kind"] == "ble" else None, r["dev_type"], r["model"], r["confidence"]]
                self.profiles[dev] = p
        return p

    def _sighting(self, msg, ts):
        rssi = int(msg.get("r", -127))
        if rssi < RSSI_FLOOR:
            return
        t = msg["t"]
        mac = msg["m"]
        hits = int(msg.get("n", 1))
        fp = None
        if t == "w":
            kind = "wifi"
            randomized = int(msg.get("rnd", 0))
            vendor = vendors.wifi_vendor(mac, randomized)
            fp = msg.get("fp")
        elif t == "a":
            kind = "ap"
            randomized = 1 if int(mac[:2], 16) & 0x02 else 0
            vendor = vendors.wifi_vendor(mac, randomized)
        else:
            kind = "ble"
            first = int(mac[:2], 16)
            # random address type that isn't "static random" (top bits 11) rotates
            randomized = 1 if int(msg.get("at", 0)) == 1 and (first >> 6) != 0b11 else 0
            vendor = vendors.ble_vendor(int(msg.get("mfr", -1)))

        dev = self.device_id(kind, mac)
        prev = self._profile(dev) or [{}, None, None, None, None]
        details = classify.merge_details(prev[0], classify.details_from_msg(msg))
        ble_name = (msg.get("name") or prev[1]) if kind == "ble" else None
        name = classify.display_name(kind, details, ble_name)
        dev_type, model, conf = classify.classify(kind, details, name, vendor, randomized)
        if prev[4] == "high" and conf == "low":  # don't let a vague advert overwrite a strong identification
            dev_type, model, conf = prev[2], prev[3], prev[4]
        self.profiles[dev] = [details, ble_name, dev_type, model, conf]
        details_json = json.dumps(details, separators=(",", ":"))

        c = self.conn
        sid = self.sensor_id
        with db.write_lock:
            if dev in self.known:
                c.execute("""UPDATE devices SET last_seen=?, last_rssi=?, vendor=COALESCE(?, vendor), fp=COALESCE(?, fp),
                             name=COALESCE(?, name), dev_type=?, model=?, confidence=?, details=? WHERE id=?""",
                          (ts, rssi, vendor, fp, name, dev_type, model, conf, details_json, dev))
            else:
                c.execute("""INSERT INTO devices(id, kind, randomized, vendor, fp, name, first_seen, last_seen, last_rssi,
                                                 dev_type, model, confidence, details, sensor_id)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                          (dev, kind, randomized, vendor, fp, name, ts, ts, rssi, dev_type, model, conf, details_json, sid))
                self.known.add(dev)

            if kind != "ap":  # access points are infrastructure, not audience
                c.execute("""INSERT INTO minute_stats(minute, device_id, max_rssi, hits, sensor_id) VALUES (?,?,?,?,?)
                             ON CONFLICT(minute, device_id) DO UPDATE SET
                               max_rssi=MAX(max_rssi, excluded.max_rssi), hits=hits+excluded.hits""",
                          (int(ts // 60), dev, rssi, hits, sid))

                act = details.get("activity")        # Apple screen state, when present
                idle = 1 if act == "idle" else 0
                use = 1 if act == "in_use" else 0
                gap = self.settings["visit_gap_s"]
                v = self.open_visits.get(dev)
                if v and ts - v[1] <= gap:
                    v[1] = ts
                    v[2] = max(v[2], rssi)
                    v[3] += 1
                    v[4] += idle
                    v[5] += use
                    c.execute("UPDATE visits SET end=?, max_rssi=?, samples=?, phone_idle=?, phone_use=? WHERE id=?",
                              (v[1], v[2], v[3], v[4], v[5], v[0]))
                else:
                    cur = c.execute("""INSERT INTO visits(device_id, start, end, max_rssi, samples, phone_idle, phone_use, sensor_id)
                                       VALUES (?,?,?,?,1,?,?,?)""", (dev, ts, ts, rssi, idle, use, sid))
                    self.open_visits[dev] = [cur.lastrowid, ts, rssi, 1, idle, use]

        self.cycle_devices.append({"id": dev, "kind": kind, "rssi": rssi, "vendor": vendor, "type": dev_type})

    def _heartbeat(self, msg, ts):
        with db.write_lock:
            if self.autocommit:
                self.conn.commit()
            # forget visits that can no longer be extended
            gap = self.settings["visit_gap_s"]
            self.open_visits = {k: v for k, v in self.open_visits.items() if ts - v[1] <= gap}
        if len(self.profiles) > 20000:  # rebuilt lazily from the DB
            self.profiles.clear()
        if self.settings.get("link_addresses", 1) and ts - self.last_link >= 20:
            self.last_link = ts
            try:
                self._run_linker(ts)
            except Exception as e:  # noqa: BLE001 - linking must never take down ingestion
                log.warning("linker error: %s", e)
        if msg.get("fw"):
            self.status.update(fw=msg["fw"], chip=msg.get("chip"))
        self.status.update(last_hb=ts, heap=msg.get("heap"), uptime=msg.get("up"),
                           cycles=self.status["cycles"] + 1, dropped=self.status["dropped"] + int(msg.get("drop", 0)))
        devices, self.cycle_devices = self.cycle_devices, []
        if self.on_cycle:
            self.on_cycle(ts, devices)

    def _run_linker(self, ts):
        """Group rotating addresses that are the same device, so counts are per phone."""
        with db.write_lock:
            links = linker.find_links(self.conn, ts, self.settings)
            for new_id, old_id, root_id, score in links:
                # point the new address (and anyone already grouped under it) at the root
                self.conn.execute("UPDATE devices SET entity_id=?, linked_from=?, link_score=? WHERE id=?",
                                  (root_id, old_id, score, new_id))
                self.conn.execute("UPDATE devices SET entity_id=? WHERE entity_id=?", (root_id, new_id))
                if new_id in self.profiles:
                    del self.profiles[new_id]
            if links:
                self.conn.commit()
                log.info("linked %d rotated address(es)", len(links))

    def flush(self):
        with db.write_lock:
            self.conn.commit()


class SerialSource(threading.Thread):
    """Reads JSON lines from the ESP over USB; reconnects if the cable is pulled."""

    def __init__(self, proc, port=None, baud=921600):
        super().__init__(daemon=True)
        self.proc, self.port, self.baud = proc, port, baud

    def _find_port(self):
        from serial.tools import list_ports
        known_vids = {0x10C4, 0x1A86, 0x0403, 0x303A}  # CP210x, CH340, FTDI, Espressif native USB
        for p in list_ports.comports():
            if p.vid in known_vids:
                return p.device
        return None

    def run(self):
        import serial
        self.proc.status["source"] = "serial"
        while True:
            port = self.port or self._find_port()
            if not port:
                self.proc.status.update(connected=False, port=None, error="no ESP found on USB")
                time.sleep(2)
                continue
            try:
                with serial.Serial(port, self.baud, timeout=1) as ser:
                    self.proc.status.update(connected=True, port=port, error=None)
                    log.info("reading %s @ %d", port, self.baud)
                    while True:
                        raw = ser.readline()
                        if raw:
                            self.proc.handle_line(raw.decode("utf-8", errors="ignore"))
            except Exception as e:  # noqa: BLE001 - keep the reader alive whatever happens
                self.proc.status.update(connected=False, error=str(e))
                log.warning("serial error on %s: %s", port, e)
                time.sleep(2)


class Simulator(threading.Thread):
    """Synthetic street traffic for demos and for developing without the ESP."""

    CYCLE_S = 4.0

    def __init__(self, proc, speed=1.0):
        super().__init__(daemon=True)
        self.proc, self.speed = proc, speed
        self.rng = random.Random(42)
        self.regulars = [self._make_person(stable=True) for _ in range(80)]
        self.fixtures = [self._radio("wifi", stable=True), self._radio("ble", stable=True)]
        self.aps = [{"t": "a", "m": self._mac(False), "ssid": ssid, "base": base}
                    for ssid, base in [("JioFiber-5G", -62), ("Airtel_XStream", -74), ("Starbucks", -80),
                                       ("Galaxy F55 5G 5511", -70), ("", -86), ("TP-Link_2.4G", -77)]]
        self.active = []  # [person, leave_ts, base_rssi]

    def _mac(self, randomized):
        b = [self.rng.randrange(256) for _ in range(6)]
        b[0] = (b[0] | 0x02) & 0xFE if randomized else b[0] & 0xFC
        return ":".join(f"{x:02x}" for x in b)

    # (BLE name, manufacturer data, services, appearance) templates, weighted by repetition
    BLE_KINDS = [
        ("", "4c0010053a1c1a2b3c", "", None),            # iPhone nearby info, idle (status 3)
        ("", "4c0010057418aabbcc", "", None),            # iPhone nearby info, screen on (status 7)
        ("", "4c000719010e2001aabbcc", "", None),        # AirPods Pro
        ("", "4c000719011420019988", "", None),          # AirPods Pro 2
        ("", "4c000b0b0100", "", None),                  # Apple Watch (magic switch)
        ("", "4c0012190011223344", "", None),            # Find My
        ("", "0600010f2022aabbcc", "", None),            # Windows laptop
        ("Galaxy Buds2 Pro", "75000102", "fe2c", None),
        ("Galaxy Watch5 (4F2A)", "75000101", "", 192),
        ("boAt Airdopes 141", "", "fe2c", None),
        ("Mi Smart Band 7", "", "fe95", 192),
        ("Noise_ColorFit", "", "", None),
        ("", "75000102", "", None),                      # generic Samsung advert
        ("", "e000010203", "fe9f", None),                # Android / Google
        ("", "", "fd6f", None),                          # exposure notification
        ("JBL Flip 5", "", "", None),
        ("", "", "", None),
    ]
    WIFI_KINDS = [
        ("ht,vht,he", "0050f2,506f9a", "Raghav", "SAMSUNG_MOBILE"),
        ("ht,vht", "0017f2", "", ""),
        ("ht,vht,he", "", "", ""),
        ("ht", "0050f2", "", ""),
        ("ht,vht", "506f9a", "", ""),
    ]
    SSIDS = ["", "", "", "JioFiber-5G", "Airtel_XStream", "Starbucks", "TP-Link_2.4G", "College-WiFi", "DIRECT-"]

    def _radio(self, kind, stable):
        if kind == "wifi":
            cap, vo, wn, wm = self.rng.choice(self.WIFI_KINDS)
            msg = {"t": "w", "m": self._mac(not stable), "rnd": 0 if stable else 1,
                   "fp": f"{self.rng.randrange(1 << 32):08x}", "cap": cap, "vo": vo,
                   "ss": [x for x in {self.rng.choice(self.SSIDS), self.rng.choice(self.SSIDS)} if x]}
            if wn and self.rng.random() < 0.3:
                msg.update(wn=f"{self.rng.choice(['Raghav', 'Priya', 'Aman', 'Galaxy S23', 'Neha'])}", wm=wm)
            if self.rng.random() < 0.4:
                msg.update(c=1, bss="aa:bb:cc:00:11:22")
            return msg
        name, md, sv, ap = self.rng.choice(self.BLE_KINDS)
        mac = self._mac(False) if stable else self._mac(True)
        if not stable:  # resolvable private address: top bits 01
            mac = f"{(int(mac[:2], 16) & 0x3F) | 0x40:02x}" + mac[2:]
        msg = {"t": "b", "m": mac, "at": 0 if stable else 1, "mfr": int(md[2:4] + md[:2], 16) if md else -1,
               "name": name, "md": md, "sv": sv}
        if ap:
            msg["ap"] = ap
        if self.rng.random() < 0.3:
            msg["tx"] = self.rng.choice([7, 8, 12])
        return msg

    def _make_person(self, stable=False):
        radios = [self._radio("ble", stable)]
        if self.rng.random() < 0.55:
            radios.append(self._radio("wifi", stable))
        if self.rng.random() < 0.3:
            radios.append(self._radio("ble", stable))
        return radios

    def _arrival_rate(self, ts):
        hour = time.localtime(ts).tm_hour + time.localtime(ts).tm_min / 60
        wd = time.localtime(ts).tm_wday
        # morning + evening commute peaks, quiet at night, busier weekends at midday
        rate = 0.05 + 1.2 * _bump(hour, 8.5, 1.2) + 0.8 * _bump(hour, 13, 1.5) + 1.4 * _bump(hour, 18, 1.6)
        if wd >= 5:
            rate = 0.05 + 1.3 * _bump(hour, 14, 3.0)
        return rate * 0.3  # arrivals per cycle

    def step(self, ts):
        for _ in range(_poisson(self.rng, self._arrival_rate(ts))):
            if self.rng.random() < 0.08:
                person = self.rng.choice(self.regulars)
                if any(a[0] is person for a in self.active):
                    continue
            else:
                # some people carry gear with fixed addresses (wearables, older phones)
                person = self._make_person(stable=self.rng.random() < 0.15)
                if self.rng.random() < 0.005:
                    self.regulars[self.rng.randrange(len(self.regulars))] = person  # becomes a regular
            stops = self.rng.random() < 0.12
            dwell = self.rng.uniform(20, 240) if stops else self.rng.uniform(4, 25)
            base = self.rng.uniform(-62, -42) if stops else self.rng.uniform(-88, -58)
            self.active.append([person, ts + dwell, base])
        self.active = [a for a in self.active if a[1] > ts]

        for person, _, base in self.active:
            for radio in person:
                if radio["t"] == "w" and self.rng.random() > 0.35:
                    continue  # phones probe in bursts, not every cycle
                msg = dict(radio, r=int(base + self.rng.gauss(0, 4)), n=self.rng.randint(1, 6), ch=6)
                self.proc.handle(msg, ts)
        for radio in self.fixtures:
            self.proc.handle(dict(radio, r=-70 + self.rng.randint(-3, 3), n=3, ch=1), ts)
        for ap in self.aps:
            self.proc.handle({"t": "a", "m": ap["m"], "ssid": ap["ssid"], "r": ap["base"] + self.rng.randint(-2, 2),
                              "n": 20, "ch": 6}, ts)
        self.proc.handle({"t": "hb", "heap": 150000, "up": int(ts) % 100000, "drop": 0}, ts)

    def backfill(self, days):
        start = time.time() - days * 86400
        log.info("backfilling %d days of simulated traffic...", days)
        ts, n = start, 0
        self.proc.autocommit = False
        while ts < time.time() - self.CYCLE_S:
            self.step(ts)
            ts += self.CYCLE_S
            n += 1
            if n % 2000 == 0:
                self.proc.flush()
        self.proc.autocommit = True
        self.proc.flush()
        log.info("backfill done")

    def run(self):
        self.proc.status.update(source="simulator", connected=True, port="simulated", fw="sim/1.0", chip="virtual")
        while True:
            self.step(time.time())
            time.sleep(self.CYCLE_S / self.speed)


def _bump(x, mu, sigma):
    import math
    return math.exp(-((x - mu) ** 2) / (2 * sigma ** 2))


def _poisson(rng, lam):
    import math
    L, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= L:
            return k
        k += 1
