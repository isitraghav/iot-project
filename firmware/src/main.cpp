// Billboard audience sensor
// Alternates between WiFi sniffing (channel hopping) and active BLE scanning.
// Sightings are aggregated per device per cycle and streamed to the host as
// JSON lines over USB serial. Classification into device types happens on the
// host so it can be improved without reflashing.
//
// Output lines:
//   {"t":"hello",...}                                   on boot
//   {"t":"w",...}  WiFi client: probe requests and/or data frames sent to an AP
//       m mac, r max RSSI, n hits, ch channel, rnd randomized MAC, fp probe fingerprint,
//       ss probed SSIDs, cap "ht,vht,he", vo vendor IE OUIs, wn/wm WPS device name/model,
//       c 1 if seen sending data to an AP, bss that AP's BSSID
//   {"t":"a",...}  access point (from beacons): m bssid, ssid, ch
//   {"t":"b",...}  BLE: at addr type, mfr company id, md manufacturer data (hex),
//       sv 16-bit service UUIDs, ap GAP appearance, tx advertised TX power, name
//   {"t":"hb","cyc":N,"up":sec,"heap":bytes,"dev":devices,"drop":n,"mgmt":frames,...}

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <NimBLEDevice.h>

static const char    *FW_VERSION    = "billboard-sensor/1.2";
static const uint32_t WIFI_DWELL_MS = 160;   // per channel
static const uint8_t  WIFI_CHANNELS = 13;
static const uint32_t BLE_SCAN_SEC  = 2;
static const int      MAX_DEVICES   = 160;

enum Caps : uint8_t { CAP_HT = 1, CAP_VHT = 2, CAP_HE = 4, CAP_CONNECTED = 8, CAP_PROBE = 16, CAP_WPS = 32 };

struct Entry {
  bool used;
  char kind;          // 'w' client, 'a' access point, 'b' BLE
  uint8_t mac[6];
  int8_t rssi;        // max RSSI this cycle
  uint16_t hits;
  uint8_t channel;
  uint8_t addrType;
  uint8_t caps;
  int32_t mfr;        // BLE company id, -1 if none
  uint32_t fp;        // WiFi IE fingerprint
  char text[33];      // first SSID / BLE name / AP SSID
  char text2[33];     // second probed SSID / WPS device name
  char model[25];     // WPS model
  uint8_t md[31];     // BLE manufacturer data (incl. company id); 31 = whole advert payload
  uint8_t mdLen;
  uint16_t svc[4];
  uint8_t nsvc;
  uint16_t appearance;
  int8_t tx;
  bool hasTx;
  uint8_t bssid[6];
  uint8_t vo[3][3];   // vendor-specific IE OUIs
  uint8_t nvo;
};

static Entry table[MAX_DEVICES];
static portMUX_TYPE tableMux = portMUX_INITIALIZER_UNLOCKED;
static volatile uint8_t currentChannel = 1;
static uint32_t cycle = 0;
static uint32_t dropped = 0;
static volatile uint32_t mgmtFrames = 0;  // all mgmt frames seen (beacons etc.), for diagnostics

static void copySafe(char *dst, size_t cap, const uint8_t *src, size_t len) {
  size_t j = 0;
  for (size_t i = 0; i < len && j < cap - 1; i++) {
    uint8_t c = src[i];
    if (c >= 32 && c < 127 && c != '"' && c != '\\') dst[j++] = (char)c;
  }
  dst[j] = 0;
}

// Must be called inside tableMux.
static Entry *findOrAdd(char kind, const uint8_t *mac) {
  int freeIdx = -1;
  for (int i = 0; i < MAX_DEVICES; i++) {
    if (!table[i].used) {
      if (freeIdx < 0) freeIdx = i;
      continue;
    }
    if (table[i].kind == kind && memcmp(table[i].mac, mac, 6) == 0) return &table[i];
  }
  if (freeIdx < 0) { dropped++; return nullptr; }
  Entry &e = table[freeIdx];
  memset(&e, 0, sizeof(e));
  e.used = true;
  e.kind = kind;
  memcpy(e.mac, mac, 6);
  e.rssi = -127;
  e.mfr = -1;
  return &e;
}

static inline void bumpRssi(Entry *e, int rssi) {
  e->hits++;
  if (rssi > e->rssi) e->rssi = rssi;
}

// ---------------------------------------------------------------- WiFi

static inline uint32_t fnv1a(uint32_t h, const uint8_t *d, size_t n) {
  for (size_t i = 0; i < n; i++) { h ^= d[i]; h *= 16777619u; }
  return h;
}

struct ProbeInfo {
  char ssid[33];
  char wpsName[33];
  char wpsModel[25];
  uint32_t fp;
  uint8_t caps;
  uint8_t vo[3][3];
  uint8_t nvo;
};

// WPS attributes are big-endian TLVs: 2-byte type, 2-byte length.
static void parseWps(const uint8_t *p, int len, ProbeInfo &pi) {
  int i = 0;
  while (i + 4 <= len) {
    uint16_t type = (p[i] << 8) | p[i + 1];
    uint16_t alen = (p[i + 2] << 8) | p[i + 3];
    if (i + 4 + alen > len) break;
    const uint8_t *v = p + i + 4;
    if (type == 0x1011) copySafe(pi.wpsName, sizeof(pi.wpsName), v, alen);        // Device Name
    else if (type == 0x1023) copySafe(pi.wpsModel, sizeof(pi.wpsModel), v, alen); // Model Name
    i += 4 + alen;
  }
}

static void parseProbeIEs(const uint8_t *p, int len, ProbeInfo &pi) {
  pi.fp = 2166136261u;
  int i = 0;
  while (i + 2 <= len) {
    uint8_t tag = p[i], tlen = p[i + 1];
    if (i + 2 + tlen > len) break;
    const uint8_t *val = p + i + 2;
    if (tag == 0) {
      copySafe(pi.ssid, sizeof(pi.ssid), val, tlen);
    } else if (tag == 221 && tlen >= 4) {
      bool known = false;
      for (int k = 0; k < pi.nvo; k++) known |= memcmp(pi.vo[k], val, 3) == 0;
      if (!known && pi.nvo < 3) memcpy(pi.vo[pi.nvo++], val, 3);
      if (val[0] == 0x00 && val[1] == 0x50 && val[2] == 0xF2 && val[3] == 0x04) {
        pi.caps |= CAP_WPS;
        parseWps(val + 4, tlen - 4, pi);
      }
    }
    if (tag == 45) pi.caps |= CAP_HT;
    if (tag == 191) pi.caps |= CAP_VHT;
    if (tag == 255 && tlen >= 1 && val[0] == 35) pi.caps |= CAP_HE;
    // Capability IEs are stable across MAC randomization for a given device model/OS.
    if (tag == 1 || tag == 50 || tag == 45 || tag == 191 || tag == 127 || tag == 255) {
      pi.fp = fnv1a(pi.fp, &tag, 1);
      pi.fp = fnv1a(pi.fp, val, tlen);
    }
    i += 2 + tlen;
  }
}

static void IRAM_ATTR onPromisc(void *buf, wifi_promiscuous_pkt_type_t type) {
  const wifi_promiscuous_pkt_t *pkt = (const wifi_promiscuous_pkt_t *)buf;
  const uint8_t *p = pkt->payload;
  int len = pkt->rx_ctrl.sig_len - 4;  // strip FCS
  int rssi = pkt->rx_ctrl.rssi;
  if (len < 24) return;
  uint8_t fc0 = p[0], fc1 = p[1];

  if (type == WIFI_PKT_MGMT) {
    mgmtFrames++;
    if (fc0 == 0x40) {  // probe request
      ProbeInfo pi;
      memset(&pi, 0, sizeof(pi));
      parseProbeIEs(p + 24, len - 24, pi);
      portENTER_CRITICAL_ISR(&tableMux);
      Entry *e = findOrAdd('w', p + 10);
      if (e) {
        bumpRssi(e, rssi);
        e->channel = currentChannel;
        e->fp = pi.fp;
        e->caps |= pi.caps | CAP_PROBE;
        if (pi.ssid[0]) {
          if (!e->text[0]) memcpy(e->text, pi.ssid, sizeof(pi.ssid));
          else if (!e->text2[0] && strcmp(e->text, pi.ssid) != 0) memcpy(e->text2, pi.ssid, sizeof(pi.ssid));
        }
        if (pi.wpsModel[0]) memcpy(e->model, pi.wpsModel, sizeof(pi.wpsModel));
        if (pi.wpsName[0]) memcpy(e->text2, pi.wpsName, sizeof(pi.wpsName));  // WPS name beats 2nd SSID
        for (int k = 0; k < pi.nvo && e->nvo < 3; k++) {
          bool known = false;
          for (int j = 0; j < e->nvo; j++) known |= memcmp(e->vo[j], pi.vo[k], 3) == 0;
          if (!known) memcpy(e->vo[e->nvo++], pi.vo[k], 3);
        }
      }
      portEXIT_CRITICAL_ISR(&tableMux);
    } else if (fc0 == 0x80 && len >= 38) {  // beacon
      char ssid[33] = {0};
      if (p[36] == 0) copySafe(ssid, sizeof(ssid), p + 38, p[37] <= len - 38 ? p[37] : 0);
      portENTER_CRITICAL_ISR(&tableMux);
      Entry *e = findOrAdd('a', p + 16);
      if (e) {
        bumpRssi(e, rssi);
        e->channel = currentChannel;
        if (ssid[0] && !e->text[0]) memcpy(e->text, ssid, sizeof(ssid));
      }
      portEXIT_CRITICAL_ISR(&tableMux);
    }
  } else if (type == WIFI_PKT_DATA) {
    // ToDS=1, FromDS=0: a client sending to its AP. addr1 = BSSID, addr2 = client.
    if ((fc1 & 0x03) != 0x01) return;
    const uint8_t *sta = p + 10;
    if (sta[0] & 0x01) return;  // multicast source, not a real station
    portENTER_CRITICAL_ISR(&tableMux);
    Entry *e = findOrAdd('w', sta);
    if (e) {
      bumpRssi(e, rssi);
      e->channel = currentChannel;
      e->caps |= CAP_CONNECTED;
      memcpy(e->bssid, p + 4, 6);
    }
    portEXIT_CRITICAL_ISR(&tableMux);
  }
}

static void wifiPhase() {
  esp_wifi_set_promiscuous(true);
  for (uint8_t ch = 1; ch <= WIFI_CHANNELS; ch++) {
    currentChannel = ch;
    esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
    delay(WIFI_DWELL_MS);
  }
  esp_wifi_set_promiscuous(false);
}

// ---------------------------------------------------------------- BLE

static void addSvc(uint16_t *svc, uint8_t &n, uint16_t u) {
  for (int i = 0; i < n; i++) if (svc[i] == u) return;
  if (n < 4) svc[n++] = u;
}

static bool uuid16(const NimBLEUUID &u, uint16_t &out) {
  if (u.bitSize() != 16) return false;
  out = u.getNative()->u16.value;
  return true;
}

class AdvCallbacks : public NimBLEAdvertisedDeviceCallbacks {
  void onResult(NimBLEAdvertisedDevice *d) override {
    uint8_t mac[6];
    const uint8_t *raw = d->getAddress().getNative();  // little-endian
    for (int k = 0; k < 6; k++) mac[k] = raw[5 - k];

    int32_t mfr = -1;
    uint8_t md[31];
    uint8_t mdLen = 0;
    if (d->haveManufacturerData()) {
      std::string m = d->getManufacturerData();
      if (m.size() >= 2) mfr = (uint8_t)m[0] | ((uint8_t)m[1] << 8);
      mdLen = m.size() < sizeof(md) ? m.size() : sizeof(md);
      memcpy(md, m.data(), mdLen);
    }
    char name[33] = {0};
    if (d->haveName()) {
      std::string n = d->getName();
      copySafe(name, sizeof(name), (const uint8_t *)n.data(), n.size());
    }
    uint16_t svc[4];
    uint8_t nsvc = 0;
    uint16_t u;
    for (int i = 0; i < (int)d->getServiceUUIDCount(); i++)
      if (uuid16(d->getServiceUUID(i), u)) addSvc(svc, nsvc, u);
    for (int i = 0; i < (int)d->getServiceDataCount(); i++)
      if (uuid16(d->getServiceDataUUID(i), u)) addSvc(svc, nsvc, u);
    uint16_t appearance = d->haveAppearance() ? d->getAppearance() : 0;
    bool hasTx = d->haveTXPower();
    int8_t tx = hasTx ? d->getTXPower() : 0;
    int rssi = d->getRSSI();
    uint8_t addrType = d->getAddress().getType();

    portENTER_CRITICAL(&tableMux);
    Entry *e = findOrAdd('b', mac);
    if (e) {
      bumpRssi(e, rssi);
      e->addrType = addrType;
      if (mfr >= 0) { e->mfr = mfr; memcpy(e->md, md, mdLen); e->mdLen = mdLen; }
      if (name[0] && !e->text[0]) memcpy(e->text, name, sizeof(name));
      for (int i = 0; i < nsvc; i++) addSvc(e->svc, e->nsvc, svc[i]);
      if (appearance) e->appearance = appearance;
      if (hasTx) { e->tx = tx; e->hasTx = true; }
    }
    portEXIT_CRITICAL(&tableMux);
  }
};

static void blePhase() {
  NimBLEScan *scan = NimBLEDevice::getScan();
  scan->start(BLE_SCAN_SEC, false);  // blocking
  scan->clearResults();
}

// ---------------------------------------------------------------- Output

static void fmtMac(char *out, const uint8_t *m) {
  snprintf(out, 18, "%02x:%02x:%02x:%02x:%02x:%02x", m[0], m[1], m[2], m[3], m[4], m[5]);
}

static void printEntry(const Entry &e) {
  static char line[600];
  char mac[18];
  fmtMac(mac, e.mac);
  int n = 0;
  auto add = [&](const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    n += vsnprintf(line + n, sizeof(line) - n, fmt, ap);
    va_end(ap);
    if (n >= (int)sizeof(line)) n = sizeof(line) - 1;
  };

  add("{\"t\":\"%c\",\"m\":\"%s\",\"r\":%d,\"n\":%u,\"ch\":%u", e.kind, mac, e.rssi, e.hits, e.channel);
  if (e.kind == 'w') {
    add(",\"rnd\":%d", (e.mac[0] & 0x02) ? 1 : 0);  // locally administered = randomized
    if (e.caps & CAP_PROBE) add(",\"fp\":\"%08lx\"", (unsigned long)e.fp);
    add(",\"ss\":[");
    if (e.text[0]) add("\"%s\"", e.text);
    if (e.text2[0] && !(e.caps & CAP_WPS)) add(",\"%s\"", e.text2);
    add("],\"cap\":\"%s%s%s\"", (e.caps & CAP_HT) ? "ht," : "", (e.caps & CAP_VHT) ? "vht," : "", (e.caps & CAP_HE) ? "he" : "");
    if (e.nvo) {
      add(",\"vo\":\"");
      for (int k = 0; k < e.nvo; k++) add("%s%02x%02x%02x", k ? "," : "", e.vo[k][0], e.vo[k][1], e.vo[k][2]);
      add("\"");
    }
    if (e.caps & CAP_WPS) add(",\"wn\":\"%s\",\"wm\":\"%s\"", e.text2, e.model);
    if (e.caps & CAP_CONNECTED) {
      char b[18];
      fmtMac(b, e.bssid);
      add(",\"c\":1,\"bss\":\"%s\"", b);
    }
  } else if (e.kind == 'a') {
    add(",\"ssid\":\"%s\"", e.text);
  } else {
    add(",\"at\":%u,\"mfr\":%ld,\"name\":\"%s\"", e.addrType, (long)e.mfr, e.text);
    if (e.mdLen) {
      add(",\"md\":\"");
      for (int k = 0; k < e.mdLen; k++) add("%02x", e.md[k]);
      add("\"");
    }
    if (e.nsvc) {
      add(",\"sv\":\"");
      for (int k = 0; k < e.nsvc; k++) add("%s%04x", k ? "," : "", e.svc[k]);
      add("\"");
    }
    if (e.appearance) add(",\"ap\":%u", e.appearance);
    if (e.hasTx) add(",\"tx\":%d", e.tx);
  }
  add("}");
  Serial.println(line);
}

static void flush() {
  // Move entries out one at a time so the critical section stays short.
  int count = 0;
  Entry e;
  for (int i = 0; i < MAX_DEVICES; i++) {
    portENTER_CRITICAL(&tableMux);
    bool used = table[i].used;
    if (used) { e = table[i]; table[i].used = false; }
    portEXIT_CRITICAL(&tableMux);
    if (!used) continue;
    count++;
    printEntry(e);
  }
  portENTER_CRITICAL(&tableMux);
  uint32_t drop = dropped, mgmt = mgmtFrames;
  dropped = 0;
  mgmtFrames = 0;
  portEXIT_CRITICAL(&tableMux);
  Serial.printf("{\"t\":\"hb\",\"cyc\":%lu,\"up\":%lu,\"heap\":%lu,\"dev\":%d,\"drop\":%lu,\"mgmt\":%lu,\"fw\":\"%s\",\"chip\":\"%s\"}\n",
                (unsigned long)cycle, (unsigned long)(millis() / 1000),
                (unsigned long)ESP.getFreeHeap(), count, (unsigned long)drop, (unsigned long)mgmt,
                FW_VERSION, ESP.getChipModel());
}

void setup() {
  Serial.begin(921600);
  delay(200);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  wifi_promiscuous_filter_t filt = {.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA};
  esp_wifi_set_promiscuous_filter(&filt);
  esp_wifi_set_promiscuous_rx_cb(&onPromisc);

  NimBLEDevice::init("");
  NimBLEScan *scan = NimBLEDevice::getScan();
  scan->setAdvertisedDeviceCallbacks(new AdvCallbacks(), true);  // want duplicates
  scan->setActiveScan(true);  // scan responses carry names and TX power
  scan->setInterval(100);
  scan->setWindow(90);
  scan->setMaxResults(0);  // callbacks only, don't store

  Serial.printf("{\"t\":\"hello\",\"fw\":\"%s\",\"chip\":\"%s\",\"mac\":\"%s\"}\n",
                FW_VERSION, ESP.getChipModel(), WiFi.macAddress().c_str());
}

void loop() {
  cycle++;
  wifiPhase();
  blePhase();
  flush();
}
