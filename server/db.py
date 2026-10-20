"""Storage layer. Supports SQLite (local dev) and Postgres (Vercel/production).

Set DATABASE_URL to a Postgres connection string to use Postgres; otherwise
SQLite is used and data is stored in the data/ directory.
"""
import os
import re
import sqlite3
import threading

DATA_DIR = os.environ.get("BILLBOARD_DATA", os.path.join(os.path.dirname(__file__), "..", "data"))
DB_PATH = os.path.join(DATA_DIR, "billboard.db")

_USE_PG = bool(os.environ.get("DATABASE_URL"))

DEFAULT_SETTINGS = {
    "viewer_rssi": -60,
    "passer_rssi": -80,
    "visit_gap_s": 300,
    "min_dwell_s": 5,
    "devices_per_person": 1.6,
    "auto_exclude_fixtures": 1,
    "fixture_minutes_6h": 300,
    "retention_stable_only": 1,
    "billboard_name": "Billboard #1",
    "rssi_1m_ble": -59,
    "rssi_1m_wifi": -45,
    "path_loss_n": 2.7,
    "radar_window_s": 60,
    "link_addresses": 1,
}

MIGRATIONS = {
    "devices": [("dev_type", "TEXT"), ("model", "TEXT"), ("confidence", "TEXT"), ("details", "TEXT"),
                ("entity_id", "TEXT"), ("linked_from", "TEXT"), ("link_score", "REAL"),
                ("sensor_id", "TEXT")],
    "visits":  [("phone_idle", "INTEGER NOT NULL DEFAULT 0"),
                ("phone_use",  "INTEGER NOT NULL DEFAULT 0"),
                ("sensor_id",  "TEXT")],
    "minute_stats": [("sensor_id", "TEXT")],
}

_SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS sensors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    location TEXT,
    created_at REAL NOT NULL,
    last_seen REAL
);
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    randomized INTEGER NOT NULL,
    vendor TEXT, fp TEXT, name TEXT,
    first_seen REAL NOT NULL, last_seen REAL NOT NULL, last_rssi INTEGER,
    label TEXT, ignored INTEGER NOT NULL DEFAULT 0, sensor_id TEXT
);
CREATE TABLE IF NOT EXISTS minute_stats (
    minute INTEGER NOT NULL, device_id TEXT NOT NULL,
    max_rssi INTEGER NOT NULL, hits INTEGER NOT NULL,
    sensor_id TEXT,
    PRIMARY KEY (minute, device_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_minute_dev ON minute_stats(device_id, minute);
CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL,
    max_rssi INTEGER NOT NULL, samples INTEGER NOT NULL,
    phone_idle INTEGER NOT NULL DEFAULT 0,
    phone_use INTEGER NOT NULL DEFAULT 0,
    sensor_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_visits_start ON visits(start);
CREATE INDEX IF NOT EXISTS ix_visits_dev ON visits(device_id, start);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

_PG_SCHEMA = """
CREATE TABLE IF NOT EXISTS sensors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    location TEXT,
    created_at DOUBLE PRECISION NOT NULL,
    last_seen DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    randomized INTEGER NOT NULL,
    vendor TEXT, fp TEXT, name TEXT,
    first_seen DOUBLE PRECISION NOT NULL,
    last_seen DOUBLE PRECISION NOT NULL,
    last_rssi INTEGER,
    label TEXT, ignored INTEGER NOT NULL DEFAULT 0,
    dev_type TEXT, model TEXT, confidence TEXT, details TEXT,
    entity_id TEXT, linked_from TEXT, link_score DOUBLE PRECISION,
    sensor_id TEXT
);
CREATE TABLE IF NOT EXISTS minute_stats (
    minute BIGINT NOT NULL, device_id TEXT NOT NULL,
    max_rssi INTEGER NOT NULL, hits INTEGER NOT NULL,
    sensor_id TEXT,
    PRIMARY KEY (minute, device_id)
);
CREATE INDEX IF NOT EXISTS ix_minute_dev ON minute_stats(device_id, minute);
CREATE TABLE IF NOT EXISTS visits (
    id BIGSERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    start DOUBLE PRECISION NOT NULL,
    end DOUBLE PRECISION NOT NULL,
    max_rssi INTEGER NOT NULL,
    samples INTEGER NOT NULL,
    phone_idle INTEGER NOT NULL DEFAULT 0,
    phone_use INTEGER NOT NULL DEFAULT 0,
    sensor_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_visits_start ON visits(start);
CREATE INDEX IF NOT EXISTS ix_visits_dev ON visits(device_id, start);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

write_lock = threading.Lock()


# ─────────────────────────────────────────────── Postgres adapter

class _PgCursor:
    """Wraps a psycopg2 DictCursor with sqlite3-compatible interface."""
    def __init__(self, cur):
        self._cur = cur
        self.lastrowid = None

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    def __iter__(self):
        return iter(self._cur)

    def __getattr__(self, name):
        return getattr(self._cur, name)


class _PgConn:
    """Wraps psycopg2 connection to mimic sqlite3 interface."""

    _RETURNING_TABLES = {"visits"}

    def __init__(self, conn):
        import psycopg2.extras
        self._conn = conn
        self._conn.autocommit = False
        self._factory = psycopg2.extras.DictCursor

    def execute(self, sql, params=()):
        sql, params, returning = self._translate(sql, params)
        cur = self._conn.cursor(cursor_factory=self._factory)
        cur.execute(sql, params or None)
        c = _PgCursor(cur)
        if returning:
            row = cur.fetchone()
            c.lastrowid = row[0] if row else None
        return c

    def executescript(self, sql):
        cur = self._conn.cursor()
        for stmt in re.split(r';', sql):
            stmt = stmt.strip()
            if stmt and not stmt.upper().startswith("--"):
                try:
                    cur.execute(stmt)
                except Exception:
                    pass  # ignore "already exists" errors
        self._conn.commit()

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()

    def _translate(self, sql, params):
        # ? → %s
        sql = sql.replace("?", "%s")

        returning = False

        # INSERT OR IGNORE INTO tbl → INSERT INTO tbl ... ON CONFLICT DO NOTHING
        if re.search(r"INSERT\s+OR\s+IGNORE\s+INTO", sql, re.I):
            sql = re.sub(r"INSERT\s+OR\s+IGNORE\s+INTO", "INSERT INTO", sql, flags=re.I)
            if "ON CONFLICT" not in sql.upper():
                sql += " ON CONFLICT DO NOTHING"

        # INSERT OR REPLACE INTO settings → upsert on key
        elif re.search(r"INSERT\s+OR\s+REPLACE\s+INTO\s+settings", sql, re.I):
            sql = re.sub(r"INSERT\s+OR\s+REPLACE\s+INTO\s+settings", "INSERT INTO settings", sql, flags=re.I)
            sql += " ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value"

        # visits INSERT → add RETURNING id so lastrowid works
        m = re.match(r"\s*INSERT\s+INTO\s+(\w+)\b", sql, re.I)
        if m and m.group(1).lower() in self._RETURNING_TABLES and "RETURNING" not in sql.upper():
            sql += " RETURNING id"
            returning = True

        return sql, params, returning


def connect():
    if _USE_PG:
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        return _PgConn(conn)
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init():
    conn = connect()
    schema = _PG_SCHEMA if _USE_PG else _SQLITE_SCHEMA
    conn.executescript(schema)

    if not _USE_PG:
        # SQLite column migrations (Postgres schema already has all columns)
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


# ─────────────────────────────────────────────── Sensor (fleet device) helpers

import secrets
import uuid


def create_sensor(name: str, location: str = "") -> dict:
    import time
    conn = connect()
    sid = uuid.uuid4().hex[:12]
    key = secrets.token_urlsafe(32)
    with write_lock:
        conn.execute(
            "INSERT INTO sensors(id, name, api_key, location, created_at) VALUES (?, ?, ?, ?, ?)",
            (sid, name, key, location or None, time.time()),
        )
        conn.commit()
    conn.close()
    return {"id": sid, "name": name, "api_key": key, "location": location}


def get_sensor_by_key(api_key: str) -> dict | None:
    conn = connect()
    r = conn.execute("SELECT * FROM sensors WHERE api_key=?", (api_key,)).fetchone()
    conn.close()
    return dict(r) if r else None


def list_sensors() -> list:
    conn = connect()
    rows = conn.execute("SELECT * FROM sensors ORDER BY created_at").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_sensor(sensor_id: str):
    conn = connect()
    with write_lock:
        conn.execute("DELETE FROM sensors WHERE id=?", (sensor_id,))
        conn.commit()
    conn.close()


def rotate_sensor_key(sensor_id: str) -> str:
    key = secrets.token_urlsafe(32)
    conn = connect()
    with write_lock:
        conn.execute("UPDATE sensors SET api_key=? WHERE id=?", (key, sensor_id))
        conn.commit()
    conn.close()
    return key
