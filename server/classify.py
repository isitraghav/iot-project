"""Device-type inference from what the sensor heard.

Every rule here is a heuristic. The result carries a confidence so the UI can
show guesses differently from strong evidence (an AirPods model ID, a WPS
model string, an advertised GAP appearance).
"""
import math
import re

TYPES = ["phone", "computer", "wearable", "audio", "tv", "tracker", "ap", "other"]
TYPE_LABELS = {"phone": "Phone", "computer": "Computer", "wearable": "Wearable", "audio": "Audio",
               "tv": "TV / media", "tracker": "Tracker / tag", "ap": "Access point", "other": "Other / unknown"}

# Order matters: "Galaxy Buds" must hit audio before phone, "Galaxy Watch" wearable before phone.
NAME_RULES = [
    ("tracker", r"\btile\b|airtag|smarttag|jiotag|chipolo|\btag\b"),
    ("audio", r"airpods|buds|\bpods\b|headphone|earphone|headset|\bjbl\b|bose|\bwh-|\bwf-|soundcore|boat|rockerz|"
              r"airdopes|nirvana|beats|speaker|soundbar|sennheiser|skullcandy|neckband|\btws\b|earbud|marshall|"
              r"harman|realme buds|oneplus nord buds|sony (wh|wf)"),
    ("wearable", r"watch|\bband\b|smart ?band|amazfit|galaxy fit|\bgear\b|garmin|forerunner|\bvenu\b|fenix|polar|"
                 r"whoop|noisefit|colorfit|noise_|fire-?boltt|\bwave\b|\bring\b|fitbit|mi band|huawei band|honor band"),
    ("tv", r"\btv\b|bravia|fire ?tv|firestick|chromecast|roku|\[tv\]|smart tv|android tv|mi box|projector|"
           r"apple tv|homepod|echo|alexa|nest (hub|audio|mini)"),
    ("computer", r"macbook|imac|mac mini|mac studio|laptop|desktop|thinkpad|ideapad|vivobook|zenbook|surface|"
                 r"\bdell\b|\bhp\b|lenovo|windows|-pc\b|\bpc\b|legion|omen|predator|inspiron|latitude|ipad"),
    ("phone", r"iphone|galaxy|pixel|redmi|oneplus|\bvivo\b|oppo|realme|poco|moto|nokia|xiaomi|iqoo|nothing phone|"
              r"\bmobile\b|\bphone\b|android|samsung_mobile|\bsm-[a-z]\d"),
]
NAME_RULES = [(t, re.compile(p, re.I)) for t, p in NAME_RULES]

HOTSPOT_SSID = re.compile(r"iphone|galaxy|redmi|oneplus|androidap|vivo|oppo|realme|poco|pixel|hotspot|\bmi\b|"
                          r"moto|nokia|iqoo|nothing", re.I)

# Apple Continuity message types (manufacturer data after company id 0x004C)
APPLE_TYPES = {
    0x02: ("other", "iBeacon", "high"),
    0x05: ("phone", "Apple device (AirDrop)", "low"),
    0x06: ("other", "HomeKit accessory", "high"),
    0x07: ("audio", "AirPods / Beats", "high"),
    0x08: ("phone", "Apple device (Hey Siri)", "low"),
    0x09: ("tv", "AirPlay target (Apple TV / HomePod)", "high"),
    0x0A: ("phone", "Apple device (AirPlay source)", "low"),
    0x0B: ("wearable", "Apple Watch", "high"),
    0x0C: ("phone", "Apple device (Handoff)", "low"),
    0x0D: ("computer", "Apple device (tethering target)", "low"),
    0x0E: ("phone", "iPhone (personal hotspot)", "high"),
    0x0F: ("phone", "Apple device (Nearby Action)", "low"),
    0x10: ("phone", "Apple device (iPhone / iPad / Mac)", "low"),
    0x12: ("tracker", "Find My (AirTag or offline Apple device)", "low"),
}
APPLE_AUDIO_MODELS = {
    0x0220: "AirPods", 0x0F20: "AirPods (2nd gen)", 0x1320: "AirPods (3rd gen)", 0x0E20: "AirPods Pro",
    0x1420: "AirPods Pro 2", 0x0A20: "AirPods Max", 0x0520: "BeatsX", 0x0620: "Beats Solo3",
    0x0920: "Beats Studio3", 0x0B20: "Powerbeats Pro", 0x0C20: "Beats Solo Pro", 0x1020: "Beats Flex",
    0x1120: "Beats Studio Buds", 0x0320: "Powerbeats3",
}
# Apple Nearby Info (type 0x10) activity code: upper nibble of the first body byte.
# Reverse-engineered (furiousMAC / Martin et al. 2019), so treat as approximate.
NEARBY_ACTIONS = {
    0x0: ("unknown", "Activity unknown"), 0x1: ("unknown", "Activity reporting off"),
    0x3: ("idle", "Locked / idle"), 0x5: ("idle", "Audio, screen off"),
    0x7: ("in_use", "Screen on"), 0x9: ("in_use", "Watching video"),
    0xA: ("idle", "Watch on wrist"), 0xB: ("in_use", "Recently used"),
    0xD: ("driving", "Driving"), 0xE: ("in_use", "On a call / FaceTime"),
}
# Microsoft Connected Devices Platform beacon: device type in low 5 bits of byte 1
MS_CDP_TYPES = {
    1: ("tv", "Xbox One"), 6: ("phone", "iPhone (Microsoft app)"), 7: ("computer", "iPad (Microsoft app)"),
    8: ("phone", "Android (Microsoft app)"), 9: ("computer", "Windows desktop"), 11: ("phone", "Windows phone"),
    12: ("computer", "Linux device"), 13: ("other", "Windows IoT"), 14: ("tv", "Surface Hub"),
    15: ("computer", "Windows laptop"), 16: ("computer", "Windows tablet"),
}
# GAP appearance category = appearance >> 6
APPEARANCE = {
    1: ("phone", "Phone"), 2: ("computer", "Computer"), 3: ("wearable", "Watch"), 5: ("tv", "Display"),
    6: ("other", "Remote control"), 7: ("wearable", "Eyeglasses"), 8: ("tracker", "Tag"), 9: ("tracker", "Keyring"),
    10: ("audio", "Media player"), 13: ("wearable", "Heart-rate sensor"), 15: ("computer", "Keyboard / mouse (HID)"),
    17: ("wearable", "Running sensor"), 18: ("wearable", "Cycling sensor"), 33: ("audio", "Audio sink"),
    34: ("audio", "Audio source"), 49: ("wearable", "Pulse oximeter"), 81: ("other", "Weight scale"),
}
# 16-bit service UUIDs
SERVICES = {
    0x180D: ("wearable", "Heart-rate service"), 0x1814: ("wearable", "Running speed service"),
    0x1816: ("wearable", "Cycling service"), 0x1812: ("computer", "Keyboard / mouse (HID)"),
    0x110B: ("audio", "Audio sink"), 0x110A: ("audio", "Audio source"),
    0xFE2C: ("audio", "Google Fast Pair accessory"), 0xFD6F: ("phone", "Exposure Notification (phone)"),
    0xFE9F: ("phone", "Google services (Android)"), 0xFEED: ("tracker", "Tile tracker"),
    0xFEEC: ("tracker", "Tile tracker"), 0xFD5A: ("tracker", "Samsung SmartTag"),
    0xFEAA: ("other", "Eddystone beacon"), 0xFE95: ("other", "Xiaomi device"),
}
SERVICE_NAMES = {k: v[1] for k, v in SERVICES.items()}
SERVICE_NAMES.update({0x180F: "Battery", 0x180A: "Device info", 0x1800: "Generic access", 0xFE03: "Amazon Alexa",
                      0xFE07: "Sonos", 0xFD82: "Sony", 0xFE0F: "Philips Hue", 0xFE59: "Nordic DFU"})
VENDOR_TYPES = {"Garmin": "wearable", "Polar": "wearable", "Bose": "audio"}
WIFI_VENDOR_IES = {"0017f2": "Apple", "0050f2": "Microsoft/WPS", "506f9a": "Wi-Fi Direct", "001018": "Broadcom",
                   "8cfdf0": "Qualcomm", "000ce7": "MediaTek", "00e04c": "Realtek", "000c43": "Ralink"}


def merge_details(old, new):
    """Lists are unioned (capped), scalars overwritten when the new value is non-empty."""
    out = dict(old or {})
    for k, v in new.items():
        if v in (None, "", [], {}):
            continue
        if isinstance(v, list):
            merged = list(out.get(k) or [])
            for x in v:
                if x not in merged:
                    merged.append(x)
            out[k] = merged[-20:]
        else:
            out[k] = v
    return out


def apple_tlvs(md_hex):
    """[(type, body bytes)] from Apple manufacturer data, or [] if not Apple."""
    try:
        b = bytes.fromhex(md_hex or "")
    except ValueError:
        return []
    if len(b) < 4 or b[0] != 0x4C or b[1] != 0x00:
        return []
    out, i = [], 2
    while i + 2 <= len(b):
        out.append((b[i], b[i + 2:i + 2 + b[i + 1]]))
        i += 2 + b[i + 1]
    return out


def apple_activity(md_hex):
    """(state, label, code) from an Apple Nearby Info message, or None."""
    for t, body in apple_tlvs(md_hex):
        if t == 0x10 and body:
            code = body[0] >> 4
            state, label = NEARBY_ACTIONS.get(code, ("unknown", f"Activity 0x{code:X}"))
            return state, label, code
    return None


def details_from_msg(msg):
    t = msg["t"]
    if t == "w":
        caps = msg.get("cap", "")
        gen = "WiFi 6" if "he" in caps else "WiFi 5" if "vht" in caps else "WiFi 4" if "ht" in caps else None
        return {
            "ssids": [s for s in msg.get("ss", []) if s],
            "wifi_gen": gen,
            "vendor_ies": [WIFI_VENDOR_IES.get(o, o) for o in (msg.get("vo") or "").split(",") if o],
            "wps_name": (msg.get("wn") or "").strip(),
            "wps_model": (msg.get("wm") or "").strip(),
            "connected": True if msg.get("c") else None,
            "bssid": msg.get("bss"),
            "probing": True if msg.get("fp") else None,
            "channel": msg.get("ch"),
        }
    if t == "a":
        return {"ssid": msg.get("ssid"), "channel": msg.get("ch")}
    svc = [int(x, 16) for x in (msg.get("sv") or "").split(",") if x]
    act = apple_activity(msg.get("md"))
    return {
        "activity": act[0] if act else None,
        "activity_label": act[1] if act else None,
        "md": msg.get("md"),
        "services": [f"{s:04X}" for s in svc],
        "appearance": msg.get("ap"),
        "tx_power": msg.get("tx"),
        "addr_type": "random" if msg.get("at") == 1 else "public",
    }


def _apple(md_hex):
    """Parse Apple continuity TLVs. Returns (type, model, conf) for the most specific message."""
    try:
        b = bytes.fromhex(md_hex)
    except ValueError:
        return None
    if len(b) < 4 or b[0] != 0x4C or b[1] != 0x00:
        return None
    i, best = 2, None
    rank = {"high": 2, "low": 1}
    while i + 2 <= len(b):
        mtype, mlen = b[i], b[i + 1]
        body = b[i + 2:i + 2 + mlen]
        if mtype in APPLE_TYPES:
            t, model, conf = APPLE_TYPES[mtype]
            if mtype == 0x07 and len(body) >= 3:
                model = APPLE_AUDIO_MODELS.get((body[1] << 8) | body[2], model)
            if not best or rank[conf] > rank[best[2]]:
                best = (t, model, conf)
        i += 2 + mlen
    return best


def _ms_cdp(md_hex):
    try:
        b = bytes.fromhex(md_hex)
    except ValueError:
        return None
    if len(b) >= 4 and b[0] == 0x06 and b[1] == 0x00 and b[2] == 0x01:
        hit = MS_CDP_TYPES.get(b[3] & 0x1F)
        if hit:
            return hit[0], hit[1], "high"
    return None


def by_name(name):
    if not name:
        return None
    for t, rx in NAME_RULES:
        if rx.search(name):
            return t
    return None


def classify(kind, details, name, vendor, randomized):
    """Returns (dev_type, model, confidence)."""
    d = details or {}
    if kind == "ap":
        ssid = d.get("ssid") or ""
        if ssid and HOTSPOT_SSID.search(ssid):
            return "phone", "Mobile hotspot", "low"
        return "ap", "Access point", "high"

    if kind == "ble":
        md = d.get("md") or ""
        name_t = by_name(name)
        apple = _apple(md) if md.startswith("4c00") else None
        if apple and apple[2] == "high":
            return apple
        ms = _ms_cdp(md) if md.startswith("0600") else None
        if ms:
            return ms
        if name_t:
            return name_t, name, "high"
        if d.get("appearance"):
            hit = APPEARANCE.get(int(d["appearance"]) >> 6)
            if hit:
                return hit[0], hit[1], "high"
        for s in d.get("services") or []:
            hit = SERVICES.get(int(s, 16))
            if hit:
                return hit[0], hit[1], "low"
        if apple:
            return apple
        if vendor in VENDOR_TYPES:
            return VENDOR_TYPES[vendor], f"{vendor} device", "low"
        if vendor and not vendor.startswith("BLE 0x"):
            return "other", f"{vendor} device", "low"
        return "other", None, "low"

    # WiFi client
    wps = " ".join(x for x in (d.get("wps_name"), d.get("wps_model")) if x)
    t = by_name(wps) or by_name(name)
    if t:
        return t, d.get("wps_model") or None, "high"
    if "Apple" in (d.get("vendor_ies") or []):
        return "phone", "Apple device", "low"
    if vendor and re.search(r"espressif|tuya|shelly|sonoff|raspberry", vendor, re.I):
        return "other", f"{vendor} IoT device", "high"
    if randomized:
        # randomized MACs are almost always phones (laptops randomize too, but rarely walk past billboards)
        return "phone", "Mobile device (random MAC)", "low"
    if vendor:
        return "other", f"{vendor} device", "low"
    return "other", None, "low"


def display_name(kind, details, ble_name):
    d = details or {}
    if kind == "ble":
        return ble_name or None
    if kind == "ap":
        return d.get("ssid") or "(hidden network)"
    return d.get("wps_name") or None


def distance_m(rssi, kind, details, s):
    """Log-distance path-loss estimate. Rough: ±50% is normal indoors/outdoors."""
    if rssi is None:
        return None
    ref = s["rssi_1m_ble"] if kind == "ble" else s["rssi_1m_wifi"]
    tx = (details or {}).get("tx_power")
    if kind == "ble" and tx is not None and -30 <= tx <= 20:
        ref = tx - 41  # advertised TX power is at 0 m; ~41 dB free-space loss at 1 m
    n = max(s["path_loss_n"], 1.5)
    return round(min(max(10 ** ((ref - rssi) / (10 * n)), 0.3), 300), 1)


def rssi_for_distance(meters, kind, s):
    ref = s["rssi_1m_ble"] if kind == "ble" else s["rssi_1m_wifi"]
    return ref - 10 * s["path_loss_n"] * math.log10(max(meters, 0.1))
