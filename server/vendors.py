"""Best-effort vendor lookup for BLE company IDs and WiFi OUIs."""
import os

BLE_COMPANIES = {
    0x0006: "Microsoft",
    0x004C: "Apple",
    0x0059: "Nordic",
    0x006B: "Polar",
    0x0075: "Samsung",
    0x0087: "Garmin",
    0x009E: "Bose",
    0x00C4: "LG",
    0x00E0: "Google",
    0x012D: "Sony",
    0x027D: "Huawei",
    0x038F: "Xiaomi",
}

_OUI = {}


def _load_oui():
    # Wireshark's manuf file, if installed, gives full OUI coverage.
    for path in ("/usr/share/wireshark/manuf", "/usr/share/wireshark/manuf.txt"):
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8", errors="ignore") as f:
            for line in f:
                if line.startswith("#") or not line.strip():
                    continue
                parts = line.split("\t")
                if len(parts) >= 2 and len(parts[0]) == 8:
                    _OUI[parts[0].lower()] = parts[1].strip()
        break


_load_oui()


def ble_vendor(company_id):
    if company_id is None or company_id < 0:
        return None
    return BLE_COMPANIES.get(company_id, f"BLE 0x{company_id:04X}")


def wifi_vendor(mac, randomized):
    if randomized:
        return None
    return _OUI.get(mac[:8].lower())
