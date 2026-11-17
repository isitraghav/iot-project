// Billboard audience sensor — cloud edition
//
// What it does:
//   1. Listens for nearby WiFi devices (promiscuous sniffing, hopping across channels).
//   2. Listens for nearby BLE devices (continuous background scan).
//   3. After every WiFi sweep, sends everything it heard to the server as one JSON batch.
//
// Fill in config.h before flashing. The batch is sent like this:
//   POST /api/ingest   Authorization: Bearer <DEVICE_API_KEY>
//   {"msgs":[<sighting>, <sighting>, ..., {"t":"hb", ...}]}
//
// Message types ("t"):  w = WiFi device,  b = BLE device,  a = access point,
//                       hb = heartbeat,   hello = sent once at boot.
//
// If WiFi is unavailable the heartbeat is still printed to Serial.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_wifi.h>
#include <NimBLEDevice.h>
#include "config.h"

// ─────────────────────────────────────────────── settings

static const char    *FW_VERSION      = "billboard-cloud/1.0";
static const uint32_t WIFI_DWELL_MS   = 160;   // time spent listening on each WiFi channel
static const uint8_t  WIFI_CHANNELS   = 13;    // sweep channels 1..13
static const int      MAX_DEVICES     = 256;   // devices remembered per sweep; extras are dropped
static const uint32_t HTTP_TIMEOUT_MS = 15000;

static const size_t   MAX_SSID_LEN    = 33;    // 32 chars + terminator
static const int      MAX_VENDOR_OUIS = 3;     // vendor-specific IEs remembered per WiFi device
static const int      MAX_BLE_SERVICES = 4;    // 16-bit service UUIDs remembered per BLE device
static const size_t   MAX_BLE_MFR_DATA = 31;   // BLE advertising payloads are at most 31 bytes

// Capability flags for a WiFi device (stored in Entry::caps)
enum Caps : uint8_t {
  CAP_HT        = 1,   // WiFi 4
  CAP_VHT       = 2,   // WiFi 5
  CAP_HE        = 4,   // WiFi 6
  CAP_CONNECTED = 8,   // seen sending data to an access point
  CAP_PROBE     = 16,  // seen sending probe requests
  CAP_WPS       = 32,  // announced a WPS device name / model
};

// ─────────────────────────────────────────────── device table

// Everything we know about one device during the current sweep.
// Fields only used by one kind of device are grouped below the common ones.
struct Entry {
  bool     used;
  char     kind;        // 'w' WiFi, 'b' BLE, 'a' access point
  uint8_t  mac[6];
  int8_t   rssi;        // strongest signal heard
  uint16_t hits;        // number of times heard
  uint8_t  channel;

  // Shared text fields:
  //   WiFi: text = first SSID probed, text2 = second SSID (or WPS device name)
  //   AP:   text = its SSID
  //   BLE:  text = advertised name
  char     text[MAX_SSID_LEN];
  char     text2[MAX_SSID_LEN];

  // WiFi only
  uint8_t  caps;
  uint32_t fp;          // fingerprint of the probe request's capabilities
  char     model[25];   // WPS model name
  uint8_t  bssid[6];    // access point it is connected to
  uint8_t  vo[MAX_VENDOR_OUIS][3];
  uint8_t  nvo;

  // BLE only
  uint8_t  addrType;
  int32_t  mfr;         // manufacturer id, -1 if none
  uint8_t  md[MAX_BLE_MFR_DATA];
  uint8_t  mdLen;
  uint16_t svc[MAX_BLE_SERVICES];
  uint8_t  nsvc;
  uint16_t appearance;
  int8_t   tx;
  bool     hasTx;
};

static Entry table[MAX_DEVICES];
static portMUX_TYPE tableMux = portMUX_INITIALIZER_UNLOCKED;  // guards the table (sniffer/BLE callbacks vs loop)

static volatile uint8_t  currentChannel = 1;  // channel the sniffer is on right now
static volatile uint32_t mgmtFrames = 0;      // management frames seen this cycle (for the heartbeat)
static uint32_t dropped = 0;                  // devices that didn't fit in the table
static uint32_t cycle = 0;
static uint8_t  apChannel = 0;                // channel of the router we're connected to

// The JSON batch being built for the next upload
static String batch;
static int    batchCount = 0;
static bool   wifiReady = false;

// ─────────────────────────────────────────────── helpers

// Copy printable text only. Quotes and backslashes are skipped so the result is safe inside JSON.
static void copySafe(char *dst, size_t cap, const uint8_t *src, size_t len) {
  size_t j = 0;
  for (size_t i = 0; i < len && j < cap - 1; i++) {
    uint8_t c = src[i];
    bool printable = c >= 32 && c < 127;
    if (printable && c != '"' && c != '\\') dst[j++] = (char)c;
  }
  dst[j] = 0;
}

// Find the entry for this device, or claim a free slot. Returns nullptr if the table is full.
// Call with tableMux held.
static Entry *findOrAdd(char kind, const uint8_t *mac) {
  int freeSlot = -1;
  for (int i = 0; i < MAX_DEVICES; i++) {
    if (!table[i].used) {
      if (freeSlot < 0) freeSlot = i;
      continue;
    }
    if (table[i].kind == kind && memcmp(table[i].mac, mac, 6) == 0) return &table[i];
  }
  if (freeSlot < 0) { dropped++; return nullptr; }

  Entry &e = table[freeSlot];
  memset(&e, 0, sizeof(e));
  e.used = true;
  e.kind = kind;
  memcpy(e.mac, mac, 6);
  e.rssi = -127;
  e.mfr = -1;
  return &e;
}

static inline void recordHit(Entry *e, int rssi) {
  e->hits++;
  if (rssi > e->rssi) e->rssi = rssi;
}

// Remember a vendor OUI (first 3 bytes of a vendor IE) unless we already have it or the list is full.
static void addVendorOui(uint8_t (*list)[3], uint8_t &count, const uint8_t *oui) {
  for (int i = 0; i < count; i++) {
    if (memcmp(list[i], oui, 3) == 0) return;
  }
  if (count < MAX_VENDOR_OUIS) memcpy(list[count++], oui, 3);
}

// Remember a BLE service UUID unless we already have it or the list is full.
static void addService(uint16_t *list, uint8_t &count, uint16_t uuid) {
  for (int i = 0; i < count; i++) {
    if (list[i] == uuid) return;
  }
  if (count < MAX_BLE_SERVICES) list[count++] = uuid;
}

// ─────────────────────────────────────────────── WiFi sniffer

// FNV-1a hash, used to fingerprint a device by the capabilities in its probe requests
static inline uint32_t fnv1a(uint32_t hash, const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    hash ^= data[i];
    hash *= 16777619u;
  }
  return hash;
}

// What we pull out of one probe request
struct ProbeInfo {
  char     ssid[MAX_SSID_LEN];
  char     wpsName[MAX_SSID_LEN];
  char     wpsModel[25];
  uint32_t fp;
  uint8_t  caps;
  uint8_t  vo[MAX_VENDOR_OUIS][3];
  uint8_t  nvo;
};

// WPS data is a list of [type:2][length:2][value] items. We only want the device name and model.
static void parseWps(const uint8_t *p, int len, ProbeInfo &pi) {
  const uint16_t WPS_DEVICE_NAME = 0x1011;
  const uint16_t WPS_MODEL_NAME  = 0x1023;

  int i = 0;
  while (i + 4 <= len) {
    uint16_t type = (p[i] << 8) | p[i + 1];
    uint16_t valueLen = (p[i + 2] << 8) | p[i + 3];
    if (i + 4 + valueLen > len) break;
    const uint8_t *value = p + i + 4;

    if (type == WPS_DEVICE_NAME) copySafe(pi.wpsName, sizeof(pi.wpsName), value, valueLen);
    else if (type == WPS_MODEL_NAME) copySafe(pi.wpsModel, sizeof(pi.wpsModel), value, valueLen);
    i += 4 + valueLen;
  }
}

// A probe request body is a list of information elements: [tag:1][length:1][value].
static void parseProbeIEs(const uint8_t *p, int len, ProbeInfo &pi) {
  // Information element tags we care about
  const uint8_t TAG_SSID = 0, TAG_SUPPORTED_RATES = 1, TAG_EXT_RATES = 50;
  const uint8_t TAG_HT_CAPS = 45, TAG_VHT_CAPS = 191, TAG_EXT_CAPS = 127;
  const uint8_t TAG_VENDOR = 221, TAG_EXTENSION = 255;
  const uint8_t EXT_HE_CAPS = 35;

  pi.fp = 2166136261u;  // FNV-1a starting value

  int i = 0;
  while (i + 2 <= len) {
    uint8_t tag = p[i], tagLen = p[i + 1];
    if (i + 2 + tagLen > len) break;
    const uint8_t *value = p + i + 2;

    if (tag == TAG_SSID) {
      copySafe(pi.ssid, sizeof(pi.ssid), value, tagLen);
    } else if (tag == TAG_VENDOR && tagLen >= 4) {
      addVendorOui(pi.vo, pi.nvo, value);
      bool isWps = value[0] == 0x00 && value[1] == 0x50 && value[2] == 0xF2 && value[3] == 0x04;
      if (isWps) {
        pi.caps |= CAP_WPS;
        parseWps(value + 4, tagLen - 4, pi);
      }
    }

    if (tag == TAG_HT_CAPS) pi.caps |= CAP_HT;
    if (tag == TAG_VHT_CAPS) pi.caps |= CAP_VHT;
    if (tag == TAG_EXTENSION && tagLen >= 1 && value[0] == EXT_HE_CAPS) pi.caps |= CAP_HE;

    // These elements describe the device's hardware, so they go into the fingerprint
    bool inFingerprint = tag == TAG_SUPPORTED_RATES || tag == TAG_EXT_RATES || tag == TAG_HT_CAPS ||
                         tag == TAG_VHT_CAPS || tag == TAG_EXT_CAPS || tag == TAG_EXTENSION;
    if (inFingerprint) {
      pi.fp = fnv1a(pi.fp, &tag, 1);
      pi.fp = fnv1a(pi.fp, value, tagLen);
    }
    i += 2 + tagLen;
  }
}

// Store what a probe request told us about a WiFi device. Call with tableMux held.
static void storeProbe(Entry *e, const ProbeInfo &pi) {
  e->fp = pi.fp;
  e->caps |= pi.caps | CAP_PROBE;

  // Keep up to two different SSIDs the device is looking for
  if (pi.ssid[0]) {
    if (!e->text[0]) memcpy(e->text, pi.ssid, sizeof(pi.ssid));
    else if (!e->text2[0] && strcmp(e->text, pi.ssid) != 0) memcpy(e->text2, pi.ssid, sizeof(pi.ssid));
  }
  if (pi.wpsModel[0]) memcpy(e->model, pi.wpsModel, sizeof(pi.wpsModel));
  if (pi.wpsName[0]) memcpy(e->text2, pi.wpsName, sizeof(pi.wpsName));

  for (int k = 0; k < pi.nvo; k++) addVendorOui(e->vo, e->nvo, pi.vo[k]);
}

// A phone searching for networks (probe request). Frame layout: header (24 bytes), then IEs.
static void onProbeRequest(const uint8_t *frame, int len, int rssi) {
  const uint8_t *senderMac = frame + 10;

  ProbeInfo pi;
  memset(&pi, 0, sizeof(pi));
  parseProbeIEs(frame + 24, len - 24, pi);

  portENTER_CRITICAL_ISR(&tableMux);
  Entry *e = findOrAdd('w', senderMac);
  if (e) {
    recordHit(e, rssi);
    e->channel = currentChannel;
    storeProbe(e, pi);
  }
  portEXIT_CRITICAL_ISR(&tableMux);
}

// An access point announcing itself (beacon). The SSID element starts at byte 36.
static void onBeacon(const uint8_t *frame, int len, int rssi) {
  const uint8_t *apMac = frame + 16;

  char ssid[MAX_SSID_LEN] = {0};
  bool hasSsid = frame[36] == 0;  // tag 0 = SSID
  if (hasSsid) {
    uint8_t ssidLen = frame[37];
    copySafe(ssid, sizeof(ssid), frame + 38, ssidLen <= len - 38 ? ssidLen : 0);
  }

  portENTER_CRITICAL_ISR(&tableMux);
  Entry *e = findOrAdd('a', apMac);
  if (e) {
    recordHit(e, rssi);
    e->channel = currentChannel;
    if (ssid[0] && !e->text[0]) memcpy(e->text, ssid, sizeof(ssid));
  }
  portEXIT_CRITICAL_ISR(&tableMux);
}

// A device sending data to an access point tells us it is connected to that network.
static void onDataFrame(const uint8_t *frame, int rssi) {
  const uint8_t flags = frame[1];
  const bool toAccessPoint = (flags & 0x03) == 0x01;
  if (!toAccessPoint) return;

  const uint8_t *senderMac = frame + 10;
  const bool isMulticast = senderMac[0] & 0x01;
  if (isMulticast) return;

  portENTER_CRITICAL_ISR(&tableMux);
  Entry *e = findOrAdd('w', senderMac);
  if (e) {
    recordHit(e, rssi);
    e->channel = currentChannel;
    e->caps |= CAP_CONNECTED;
    memcpy(e->bssid, frame + 4, 6);
  }
  portEXIT_CRITICAL_ISR(&tableMux);
}

// Called by the WiFi driver for every frame heard while sniffing
static void IRAM_ATTR onPromisc(void *buf, wifi_promiscuous_pkt_type_t type) {
  const uint8_t FRAME_PROBE_REQUEST = 0x40;
  const uint8_t FRAME_BEACON        = 0x80;

  const wifi_promiscuous_pkt_t *pkt = (const wifi_promiscuous_pkt_t *)buf;
  const uint8_t *frame = pkt->payload;
  int len = pkt->rx_ctrl.sig_len - 4;  // minus the 4-byte checksum
  int rssi = pkt->rx_ctrl.rssi;
  if (len < 24) return;  // shorter than a WiFi header

  if (type == WIFI_PKT_MGMT) {
    mgmtFrames++;
    uint8_t frameType = frame[0];
    if (frameType == FRAME_PROBE_REQUEST) onProbeRequest(frame, len, rssi);
    else if (frameType == FRAME_BEACON && len >= 38) onBeacon(frame, len, rssi);
  } else if (type == WIFI_PKT_DATA) {
    onDataFrame(frame, rssi);
  }
}

// Listen on every channel in turn
static void wifiPhase() {
  esp_wifi_set_promiscuous(true);
  for (uint8_t ch = 1; ch <= WIFI_CHANNELS; ch++) {
    currentChannel = ch;
    esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
    delay(WIFI_DWELL_MS);
  }
  esp_wifi_set_promiscuous(false);

  // Hopping leaves the radio on the last sniffed channel; return to the AP's
  // channel or the station link silently breaks and uploads fail (HTTP -1).
  if (apChannel) esp_wifi_set_channel(apChannel, WIFI_SECOND_CHAN_NONE);
}

// ─────────────────────────────────────────────── BLE

// A 16-bit UUID is the only kind we keep. Returns false for 32/128-bit UUIDs.
static bool getUuid16(const NimBLEUUID &uuid, uint16_t &out) {
  if (uuid.bitSize() != 16) return false;
  out = uuid.getNative()->u16.value;
  return true;
}

// Called by NimBLE every time a BLE advertisement is heard
class AdvCallbacks : public NimBLEAdvertisedDeviceCallbacks {
  void onResult(NimBLEAdvertisedDevice *d) override {
    // NimBLE stores the address reversed
    uint8_t mac[6];
    const uint8_t *rawAddr = d->getAddress().getNative();
    for (int k = 0; k < 6; k++) mac[k] = rawAddr[5 - k];

    // Manufacturer data: first two bytes are the company id
    int32_t mfr = -1;
    uint8_t md[MAX_BLE_MFR_DATA];
    uint8_t mdLen = 0;
    if (d->haveManufacturerData()) {
      std::string data = d->getManufacturerData();
      if (data.size() >= 2) mfr = (uint8_t)data[0] | ((uint8_t)data[1] << 8);
      mdLen = data.size() < sizeof(md) ? data.size() : sizeof(md);
      memcpy(md, data.data(), mdLen);
    }

    char name[MAX_SSID_LEN] = {0};
    if (d->haveName()) {
      std::string n = d->getName();
      copySafe(name, sizeof(name), (const uint8_t *)n.data(), n.size());
    }

    // Service UUIDs, both advertised and from service data
    uint16_t services[MAX_BLE_SERVICES];
    uint8_t serviceCount = 0;
    uint16_t uuid;
    for (int i = 0; i < (int)d->getServiceUUIDCount(); i++) {
      if (getUuid16(d->getServiceUUID(i), uuid)) addService(services, serviceCount, uuid);
    }
    for (int i = 0; i < (int)d->getServiceDataCount(); i++) {
      if (getUuid16(d->getServiceDataUUID(i), uuid)) addService(services, serviceCount, uuid);
    }

    uint16_t appearance = d->haveAppearance() ? d->getAppearance() : 0;
    bool hasTx = d->haveTXPower();
    int8_t tx = hasTx ? d->getTXPower() : 0;
    int rssi = d->getRSSI();
    uint8_t addrType = d->getAddress().getType();

    portENTER_CRITICAL(&tableMux);
    Entry *e = findOrAdd('b', mac);
    if (e) {
      recordHit(e, rssi);
      e->addrType = addrType;
      if (mfr >= 0) {
        e->mfr = mfr;
        memcpy(e->md, md, mdLen);
        e->mdLen = mdLen;
      }
      if (name[0] && !e->text[0]) memcpy(e->text, name, sizeof(name));
      for (int i = 0; i < serviceCount; i++) addService(e->svc, e->nsvc, services[i]);
      if (appearance) e->appearance = appearance;
      if (hasTx) {
        e->tx = tx;
        e->hasTx = true;
      }
    }
    portEXIT_CRITICAL(&tableMux);
  }
};

// BLE scans continuously in the background (NimBLE task) so phones are heard
// during WiFi hopping and HTTP uploads too, not just in a 2 s window per cycle.
static void ensureBleScanRunning() {
  NimBLEScan *scan = NimBLEDevice::getScan();
  if (!scan->isScanning()) scan->start(0, nullptr, false);
}

// ─────────────────────────────────────────────── building the JSON batch

static void formatMac(char *out, const uint8_t *mac) {
  snprintf(out, 18, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

// Appends formatted text to a fixed buffer, never overflowing it
struct JsonLine {
  char  *buf;
  size_t cap;
  int    len;

  JsonLine(char *buffer, size_t capacity) : buf(buffer), cap(capacity), len(0) {}

  void add(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    len += vsnprintf(buf + len, cap - len, fmt, args);
    va_end(args);
    if (len >= (int)cap) len = cap - 1;
  }
};

static void addWifiFields(JsonLine &json, const Entry &e) {
  bool randomizedMac = e.mac[0] & 0x02;
  json.add(",\"rnd\":%d", randomizedMac ? 1 : 0);
  if (e.caps & CAP_PROBE) json.add(",\"fp\":\"%08lx\"", (unsigned long)e.fp);

  // SSIDs the device probed for (text2 holds a WPS name instead when WPS was seen)
  json.add(",\"ss\":[");
  if (e.text[0]) json.add("\"%s\"", e.text);
  if (e.text2[0] && !(e.caps & CAP_WPS)) json.add(",\"%s\"", e.text2);
  json.add("],\"cap\":\"%s%s%s\"",
           (e.caps & CAP_HT) ? "ht," : "", (e.caps & CAP_VHT) ? "vht," : "", (e.caps & CAP_HE) ? "he" : "");

  if (e.nvo) {
    json.add(",\"vo\":\"");
    for (int k = 0; k < e.nvo; k++) json.add("%s%02x%02x%02x", k ? "," : "", e.vo[k][0], e.vo[k][1], e.vo[k][2]);
    json.add("\"");
  }
  if (e.caps & CAP_WPS) json.add(",\"wn\":\"%s\",\"wm\":\"%s\"", e.text2, e.model);
  if (e.caps & CAP_CONNECTED) {
    char bssid[18];
    formatMac(bssid, e.bssid);
    json.add(",\"c\":1,\"bss\":\"%s\"", bssid);
  }
}

static void addBleFields(JsonLine &json, const Entry &e) {
  json.add(",\"at\":%u,\"mfr\":%ld,\"name\":\"%s\"", e.addrType, (long)e.mfr, e.text);
  if (e.mdLen) {
    json.add(",\"md\":\"");
    for (int k = 0; k < e.mdLen; k++) json.add("%02x", e.md[k]);
    json.add("\"");
  }
  if (e.nsvc) {
    json.add(",\"sv\":\"");
    for (int k = 0; k < e.nsvc; k++) json.add("%s%04x", k ? "," : "", e.svc[k]);
    json.add("\"");
  }
  if (e.appearance) json.add(",\"ap\":%u", e.appearance);
  if (e.hasTx) json.add(",\"tx\":%d", e.tx);
}

// Add one piece of JSON to the batch, comma-separated from the previous one
static void addToBatch(const char *json) {
  if (batchCount > 0) batch += ',';
  batch += json;
  batchCount++;
}

static void clearBatch() {
  batch = "";
  batchCount = 0;
}

// Turn one device into a JSON object and add it to the batch
static void appendEntry(const Entry &e) {
  static char buffer[600];
  JsonLine json(buffer, sizeof(buffer));

  char mac[18];
  formatMac(mac, e.mac);
  json.add("{\"t\":\"%c\",\"m\":\"%s\",\"r\":%d,\"n\":%u,\"ch\":%u", e.kind, mac, e.rssi, e.hits, e.channel);

  if (e.kind == 'w') addWifiFields(json, e);
  else if (e.kind == 'a') json.add(",\"ssid\":\"%s\"", e.text);
  else addBleFields(json, e);
  json.add("}");

  addToBatch(buffer);
}

// Status line added to the end of every batch
static void appendHeartbeat(int deviceCount, uint32_t droppedDevices, uint32_t mgmtFrameCount) {
  char hb[256];
  snprintf(hb, sizeof(hb),
    "{\"t\":\"hb\",\"cyc\":%lu,\"up\":%lu,\"heap\":%lu,\"dev\":%d,\"drop\":%lu,\"mgmt\":%lu,\"fw\":\"%s\",\"chip\":\"%s\",\"name\":\"%s\"}",
    (unsigned long)cycle, (unsigned long)(millis() / 1000), (unsigned long)ESP.getFreeHeap(),
    deviceCount, (unsigned long)droppedDevices, (unsigned long)mgmtFrameCount,
    FW_VERSION, ESP.getChipModel(), DEVICE_NAME);
  addToBatch(hb);
  Serial.println(hb);
}

// ─────────────────────────────────────────────── uploading

static bool postBatch() {
  if (!wifiReady || batch.isEmpty()) return false;

  String url = String(SERVER_URL) + "/api/ingest";
  String body = "{\"msgs\":[" + batch + "]}";

  WiFiClientSecure client;
  client.setInsecure();  // skip cert validation — fine for a local/LAN server too
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " DEVICE_API_KEY);
  int code = http.POST(body);
  http.end();

  if (code == 200 || code == 204) {
    Serial.printf("[http] POST ok (%d msgs, %d bytes)\n", batchCount, body.length());
    return true;
  }
  Serial.printf("[http] POST failed: HTTP %d\n", code);
  return false;
}

// Move everything heard this sweep into the batch (emptying the table); returns the device count
static int drainTableIntoBatch() {
  int count = 0;
  Entry e;
  for (int i = 0; i < MAX_DEVICES; i++) {
    // Copy out under the lock, then do the slow JSON work outside it
    portENTER_CRITICAL(&tableMux);
    bool used = table[i].used;
    if (used) {
      e = table[i];
      table[i].used = false;
    }
    portEXIT_CRITICAL(&tableMux);

    if (!used) continue;
    count++;
    appendEntry(e);
  }
  return count;
}

// End of a sweep: build the batch, send it, start fresh
static void flush() {
  int deviceCount = drainTableIntoBatch();

  portENTER_CRITICAL(&tableMux);
  uint32_t droppedDevices = dropped;
  uint32_t mgmtFrameCount = mgmtFrames;
  dropped = 0;
  mgmtFrames = 0;
  portEXIT_CRITICAL(&tableMux);

  appendHeartbeat(deviceCount, droppedDevices, mgmtFrameCount);

  if (wifiReady) postBatch();
  else Serial.printf("[wifi] offline — %d msgs not sent\n", batchCount);

  clearBatch();
}

// ─────────────────────────────────────────────── WiFi connection

static void connectWifi() {
  Serial.printf("[wifi] connecting to %s…\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - startedAt) < (WIFI_TIMEOUT_S * 1000UL)) {
    delay(500);
    Serial.print('.');
  }

  wifiReady = WiFi.status() == WL_CONNECTED;
  if (wifiReady) Serial.printf("\n[wifi] connected, IP %s\n", WiFi.localIP().toString().c_str());
  else Serial.println("\n[wifi] connect failed — will retry");
}

// ─────────────────────────────────────────────── Arduino entry points

static void setupWifiSniffer() {
  // Promiscuous mode is switched on and off around each sweep (see wifiPhase)
  wifi_promiscuous_filter_t filter = {.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA};
  esp_wifi_set_promiscuous_filter(&filter);
  esp_wifi_set_promiscuous_rx_cb(&onPromisc);
}

static void setupBle() {
  NimBLEDevice::init("");
  NimBLEScan *scan = NimBLEDevice::getScan();
  scan->setAdvertisedDeviceCallbacks(new AdvCallbacks(), true);
  scan->setActiveScan(true);
  scan->setInterval(100);
  scan->setWindow(100);  // window == interval: radio listens 100% of the time
  // NOTE: the original source had "scan->setMaxResults(0);" here but it was accidentally
  // inside the comment above, so it never ran. Left disabled to keep behaviour unchanged.
}

// Tell the server (and Serial) that we just booted
static void sendHello() {
  char hello[200];
  snprintf(hello, sizeof(hello),
    "{\"t\":\"hello\",\"fw\":\"%s\",\"chip\":\"%s\",\"mac\":\"%s\",\"name\":\"%s\"}",
    FW_VERSION, ESP.getChipModel(), WiFi.macAddress().c_str(), DEVICE_NAME);
  Serial.println(hello);

  if (wifiReady) {
    addToBatch(hello);
    postBatch();
    clearBatch();
  }
}

void setup() {
  Serial.begin(921600);
  delay(200);

  // Connect WiFi first so it doesn't interfere with sniffing during the cycle
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  connectWifi();

  setupWifiSniffer();
  setupBle();
  sendHello();
}

void loop() {
  // Reconnect WiFi if it was lost
  if (WiFi.status() != WL_CONNECTED) {
    wifiReady = false;
    connectWifi();
  }
  cycle++;
  ensureBleScanRunning();
  wifiPhase();
  flush();
}
