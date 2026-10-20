"""Groups the rotating addresses that belong to one physical device.

Phones change their BLE address about every 15 minutes, and many change their
WiFi probe MAC on every scan. When that happens the old address stops being
heard and a new one shows up within seconds, at a similar distance, carrying
the same style of advert. We look for that pattern and treat the pair as one
device, so dwell time, visits and people counts are per phone rather than per
address.

The matcher is deliberately cautious: when two old addresses could each be the
source, we leave the new one on its own. A missed grouping costs a little
accuracy; a wrong one would merge two people.
"""
import json

import classify

WINDOW_S = {"ble": 30, "wifi": 180}   # max silence between old's last and new's first sighting
MAX_RSSI_JUMP = 12                    # dB
MIN_SCORE = 0.5
AMBIGUITY_MARGIN = 0.12               # runner-up within this of the best -> don't group
SETTLE_S = 20                         # wait this long after a new address appears before matching it


def _signature(row):
    d = json.loads(row["details"]) if row["details"] else {}
    sig = {"vendor": row["vendor"], "name": row["name"] if row["kind"] == "ble" else None}
    if row["kind"] == "ble":
        tlvs = classify.apple_tlvs(d.get("md"))
        sig["apple_types"] = frozenset(t for t, _ in tlvs)
        nearby = next((body for t, body in tlvs if t == 0x10 and body), None)
        sig["nearby_flags"] = nearby[0] & 0x0F if nearby else None   # low nibble: device status flags
        md = d.get("md") or ""
        sig["ms_type"] = int(md[6:8], 16) & 0x1F if md.startswith("060001") and len(md) >= 8 else None
        sig["services"] = frozenset(d.get("services") or [])
        sig["tx"] = d.get("tx_power")
    else:
        sig["fp"] = row["fp"]
        sig["gen"] = d.get("wifi_gen")
        sig["ssids"] = frozenset(d.get("ssids") or [])
    return sig


def _compatible(a, b, kind):
    if a["vendor"] != b["vendor"]:
        return False
    if a["name"] and b["name"] and a["name"] != b["name"]:
        return False
    if kind == "ble":
        if bool(a["apple_types"]) != bool(b["apple_types"]):
            return False
        if a["apple_types"] and b["apple_types"] and not (a["apple_types"] & b["apple_types"]):
            return False
        if a["ms_type"] != b["ms_type"]:
            return False
        if a["tx"] is not None and b["tx"] is not None and a["tx"] != b["tx"]:
            return False
        if a["services"] and b["services"] and a["services"] != b["services"]:
            return False
    else:
        if not a["fp"] or a["fp"] != b["fp"]:
            return False
        if a["gen"] and b["gen"] and a["gen"] != b["gen"]:
            return False
    return True


def _score(sn, so, gap, rssi_jump, kind):
    s = 0.5 * (1 - gap / WINDOW_S[kind]) + 0.5 * (1 - rssi_jump / MAX_RSSI_JUMP)
    if sn["name"] and sn["name"] == so["name"]:
        s += 0.3
    if kind == "ble":
        if sn["nearby_flags"] is not None and sn["nearby_flags"] == so["nearby_flags"]:
            s += 0.1
        if sn["services"] and sn["services"] == so["services"]:
            s += 0.1
    elif sn["ssids"] & so["ssids"]:
        s += 0.3
    return round(s, 3)


def _root(conn, dev):
    """Follow entity_id up to the device that stands for the whole group."""
    seen = set()
    while dev and dev not in seen:
        seen.add(dev)
        r = conn.execute("SELECT entity_id FROM devices WHERE id=?", (dev,)).fetchone()
        if not r or not r["entity_id"] or r["entity_id"] == dev:
            return dev
        dev = r["entity_id"]
    return dev


def find_links(conn, now, settings):
    """One matching pass. Returns [(new_id, old_id, root_id, score)] to apply."""
    rows = conn.execute("""
        SELECT id, kind, vendor, name, fp, details, first_seen, last_seen, last_rssi, entity_id
        FROM devices
        WHERE randomized=1 AND kind IN ('ble','wifi')
          AND last_seen >= ? AND (label IS NULL OR label='')
        """, (now - 1800,)).fetchall()

    by_kind = {"ble": [], "wifi": []}
    for r in rows:
        by_kind[r["kind"]].append(r)

    links = []
    for kind, group in by_kind.items():
        win = WINDOW_S[kind]
        # candidate "new" addresses: appeared recently, settled, not already grouped onto someone
        news = [r for r in group if r["entity_id"] is None
                and now - r["first_seen"] >= SETTLE_S and now - r["first_seen"] <= win + 600]
        for new in news:
            sn = _signature(new)
            best = second = None
            for old in group:
                if old["id"] == new["id"]:
                    continue
                if old["first_seen"] >= new["first_seen"]:  # the later address links to the earlier one
                    continue                                # (breaks symmetry, so two addresses can't link mutually)
                gap = new["first_seen"] - old["last_seen"]
                if gap < -2 or gap > win:          # old must fall silent before new appears
                    continue
                if old["last_seen"] > new["first_seen"] + 2:  # still actively seen = a different device
                    continue
                so = _signature(old)
                if not _compatible(sn, so, kind):
                    continue
                jump = abs((new["last_rssi"] or -100) - (old["last_rssi"] or -100))
                if jump > MAX_RSSI_JUMP:
                    continue
                score = _score(sn, so, max(gap, 0), jump, kind)
                if not best or score > best[1]:
                    second, best = best, (old, score)
                elif not second or score > second[1]:
                    second = (old, score)
            if not best or best[1] < MIN_SCORE:
                continue
            if second and best[1] - second[1] < AMBIGUITY_MARGIN:
                continue   # too close to call; leave unlinked
            root = _root(conn, best[0]["id"])
            if root == new["id"]:            # would close a cycle onto ourselves
                continue
            links.append((new["id"], best[0]["id"], root, best[1]))
    # within this pass, never let two addresses resolve to each other (A->B and B->A)
    chosen = {}
    for new_id, old_id, root, score in sorted(links, key=lambda l: -l[3]):
        if old_id in chosen:          # old_id is itself linking somewhere this pass -> use its root
            root = chosen[old_id]
        if root == new_id:
            continue
        chosen[new_id] = root
    return [(n, o, chosen[n], s) for n, o, r, s in links if n in chosen and chosen[n] != n]
