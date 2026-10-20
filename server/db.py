"""SQLite storage. One writer (the ingest pipeline), many short-lived readers."""
import os
import sqlite3
import threading

DATA_DIR = os.environ.get("BILLBOARD_DATA", os.path.join(os.path.dirname(__file__), "..", "data"))
DB_PATH = os.path.join(DATA_DIR, "billboard.db")

DEFAULT_SETTINGS = {
    "viewer_rssi": -60,          # >= this: close enough to be viewing the billboard
    "passer_rssi": -80,          # >= this: passer-by; weaker sightings are ignored in analytics
    "visit_gap_s": 300,          # unseen this long -> visit ends
    "min_dwell_s": 5,            # viewer visits shorter than this aren't impressions
    "devices_per_person": 1.6,   # avg detectable radios per person (phone + watch + earbuds...)
    "auto_exclude_fixtures": 1,  # drop always-present devices (TVs, routers, printers)
    "fixture_minutes_6h": 300,   # present in this many of the last 360 minutes -> fixture
    "retention_stable_only": 1,  # retention uses only non-rotating identifiers
    "billboard_name": "Billboard #1",
    "rssi_1m_ble": -59,          # BLE RSSI at 1 m (typical phone advert)
    "rssi_1m_wifi": -45,         # WiFi client RSSI at 1 m
    "path_loss_n": 2.7,          # path-loss exponent: 2 open air, 2.7-3.5 street / indoors
    "radar_window_s": 60,        # radar shows devices seen within this many seconds
    "link_addresses": 1,         # group rotating random addresses that are the same device
}

# Columns added after the first release; added to existing databases on startup.
MIGRATIONS = {
    "devices": [("dev_type", "TEXT"), ("model", "TEXT"), ("confidence", "TEXT"), ("details", "TEXT"),
                ("entity_id", "TEXT"),       # root device this address was linked to (NULL = its own root)
                ("linked_from", "TEXT"),     # the address it replaced after a MAC rotation
                ("link_score", "REAL")],
    "visits": [("phone_idle", "INTEGER NOT NULL DEFAULT 0"),  # sightings with an Apple 'locked/idle' state
               ("phone_use", "INTEGER NOT NULL DEFAULT 0")],  # sightings with 'screen on / in use'
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,              -- 'wifi' | 'ble' | 'ap'
    randomized INTEGER NOT NULL,     -- rotating / locally administered address
    vendor TEXT,
    fp TEXT,                         -- wifi probe fingerprint
    name TEXT,                       -- BLE advertised name
    first_seen REAL NOT NULL,
    last_seen REAL NOT NULL,
    last_rssi INTEGER,
    label TEXT,
    ignored INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS minute_stats (
    minute INTEGER NOT NULL,         -- unix time // 60
    device_id TEXT NOT NULL,
    max_rssi INTEGER NOT NULL,
    hits INTEGER NOT NULL,
    PRIMARY KEY (minute, device_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_minute_dev ON minute_stats(device_id, minute);
CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    max_rssi INTEGER NOT NULL,
    samples INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_visits_start ON visits(start);
CREATE INDEX IF NOT EXISTS ix_visits_dev ON visits(device_id, start);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

write_lock = threading.Lock()


def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init():
    conn = connect()
    conn.executescript(SCHEMA)
    for table, cols in MIGRATIONS.items():
        have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, typ in cols:
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {typ}")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_devices_last_seen ON devices(last_seen)")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_devices_entity ON devices(entity_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_devices_linked_from ON devices(linked_from)")
    for k, v in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, str(v)))
    conn.commit()
    conn.close()


def _coerce(key, raw):
    default = DEFAULT_SETTINGS.get(key)
    if isinstance(default, int):
        return int(float(raw))
    if isinstance(default, float):
        return float(raw)
    return raw


def get_settings(conn):
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    out = dict(DEFAULT_SETTINGS)
    for r in rows:
        if r["key"] in DEFAULT_SETTINGS:
            out[r["key"]] = _coerce(r["key"], r["value"])
    return out


def save_settings(conn, values):
    for k, v in values.items():
        if k in DEFAULT_SETTINGS:
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (k, str(_coerce(k, v))))
    conn.commit()
