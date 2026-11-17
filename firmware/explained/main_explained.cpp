// ============================================================================
// main_explained.cpp — a line-by-line annotated copy of firmware/src/main.cpp
// ----------------------------------------------------------------------------
// READ-ONLY STUDY COPY. It is NOT built (PlatformIO only compiles firmware/src).
// Every line of code has a one-line comment. If you change main.cpp, this copy
// will not update automatically.
//
// Big picture: the ESP32 repeats this loop forever:
//   1. keep a BLE scan running in the background
//   2. hop through WiFi channels 1..13 listening for nearby devices
//   3. package everything heard into JSON and POST it to the server
// ============================================================================

#include <Arduino.h>            // core Arduino functions: delay(), millis(), Serial, String
#include <WiFi.h>               // ESP32 WiFi station (client) support
#include <WiFiClientSecure.h>   // HTTPS-capable network client
#include <HTTPClient.h>         // simple HTTP request helper
#include <esp_wifi.h>           // low-level ESP-IDF WiFi API (promiscuous/sniffer mode)
#include <NimBLEDevice.h>       // lightweight Bluetooth Low Energy library
#include "config.h"             // your private settings: WIFI_SSID, SERVER_URL, DEVICE_API_KEY, ...

// ─────────────────────────────────────────────── settings

static const char    *FW_VERSION      = "billboard-cloud/1.0"; // firmware name/version reported to the server
static const uint32_t WIFI_DWELL_MS   = 160;   // how long we listen on each WiFi channel (milliseconds)
static const uint8_t  WIFI_CHANNELS   = 13;    // we sweep channels 1 through 13
static const int      MAX_DEVICES     = 256;   // size of the device table; devices beyond this are dropped
static const uint32_t HTTP_TIMEOUT_MS = 15000; // give up on an upload after 15 seconds

static const size_t   MAX_SSID_LEN    = 33;    // a WiFi name is up to 32 chars, +1 for the string terminator
static const int      MAX_VENDOR_OUIS = 3;     // max vendor IDs remembered per WiFi device
static const int      MAX_BLE_SERVICES = 4;    // max BLE service IDs remembered per BLE device
static const size_t   MAX_BLE_MFR_DATA = 31;   // a BLE advertisement is at most 31 bytes

// Flags describing what a WiFi device can do; several can be combined into one byte
enum Caps : uint8_t {          // "Caps" = capabilities, stored in a single byte
  CAP_HT        = 1,           // bit 0: supports WiFi 4 (802.11n)
  CAP_VHT       = 2,           // bit 1: supports WiFi 5 (802.11ac)
  CAP_HE        = 4,           // bit 2: supports WiFi 6 (802.11ax)
  CAP_CONNECTED = 8,           // bit 3: seen sending data to a router (so it's connected to a network)
  CAP_PROBE     = 16,          // bit 4: seen sending "probe requests" (searching for networks)
  CAP_WPS       = 32,          // bit 5: announced a WPS device name/model
};                             // end of the flag list

// ─────────────────────────────────────────────── device table

// One row of the table = everything we learned about one nearby device this sweep
struct Entry {
  bool     used;               // is this table slot occupied?
  char     kind;               // 'w' = WiFi device, 'b' = BLE device, 'a' = access point (router)
  uint8_t  mac[6];             // the device's 6-byte hardware address
  int8_t   rssi;               // strongest signal strength heard (closer to 0 = nearer)
  uint16_t hits;               // how many times we heard it
  uint8_t  channel;            // WiFi channel it was heard on

  char     text[MAX_SSID_LEN];   // WiFi: 1st network name probed / AP: its name / BLE: device name
  char     text2[MAX_SSID_LEN];  // WiFi: 2nd network name probed, or the WPS device name

  uint8_t  caps;               // WiFi only: combination of the Caps flags above
  uint32_t fp;                 // WiFi only: fingerprint hash of the probe request's features
  char     model[25];          // WiFi only: WPS model name
  uint8_t  bssid[6];           // WiFi only: MAC of the router this device is connected to
  uint8_t  vo[MAX_VENDOR_OUIS][3]; // WiFi only: vendor IDs (3 bytes each) found in probe requests
  uint8_t  nvo;                // WiFi only: how many vendor IDs are stored

  uint8_t  addrType;           // BLE only: 0 = public address, 1 = random address
  int32_t  mfr;                // BLE only: manufacturer company id, or -1 if none
  uint8_t  md[MAX_BLE_MFR_DATA]; // BLE only: raw manufacturer data bytes
  uint8_t  mdLen;              // BLE only: how many manufacturer-data bytes are stored
  uint16_t svc[MAX_BLE_SERVICES]; // BLE only: 16-bit service IDs the device offers
  uint8_t  nsvc;               // BLE only: how many service IDs are stored
  uint16_t appearance;         // BLE only: "appearance" code (phone, watch, headset...)
  int8_t   tx;                 // BLE only: transmit power the device reports
  bool     hasTx;              // BLE only: did the device report a transmit power?
};                             // end of Entry

static Entry table[MAX_DEVICES];  // the table itself: all devices heard during the current sweep
static portMUX_TYPE tableMux = portMUX_INITIALIZER_UNLOCKED;  // lock so the sniffer, BLE and main loop don't corrupt the table

static volatile uint8_t  currentChannel = 1;  // channel the sniffer is on right now (volatile: changes behind our back)
static volatile uint32_t mgmtFrames = 0;      // count of WiFi management frames seen (reported in heartbeat)
static uint32_t dropped = 0;                  // count of devices lost because the table was full
static uint32_t cycle = 0;                    // how many sweeps have run since boot
static uint8_t  apChannel = 0;                // router's channel to return to after hopping (currently never set, so 0)

static String batch;           // the JSON text for the next upload, built up piece by piece
static int    batchCount = 0;  // how many JSON objects are in `batch`
static bool   wifiReady = false; // true while we're connected to the router

// ─────────────────────────────────────────────── helpers

// Copy text from raw bytes, keeping only printable characters that are safe inside JSON
static void copySafe(char *dst, size_t cap, const uint8_t *src, size_t len) {
  size_t j = 0;                                    // j = how many chars written to dst so far
  for (size_t i = 0; i < len && j < cap - 1; i++) { // walk the source bytes; stop if dst is full (keep 1 for terminator)
    uint8_t c = src[i];                            // current source byte
    bool printable = c >= 32 && c < 127;           // visible ASCII range only
    if (printable && c != '"' && c != '\\') dst[j++] = (char)c; // skip quotes/backslashes (they'd break JSON), else copy
  }                                                // end of loop
  dst[j] = 0;                                      // terminate the string with a zero byte
}                                                  // end of copySafe

// Return this device's table row, creating one if new. Returns nullptr if the table is full.
static Entry *findOrAdd(char kind, const uint8_t *mac) {
  int freeSlot = -1;                               // remember the first empty slot (-1 = none found yet)
  for (int i = 0; i < MAX_DEVICES; i++) {          // scan every row
    if (!table[i].used) {                          // empty row?
      if (freeSlot < 0) freeSlot = i;              // remember the first empty one
      continue;                                    // nothing to compare in an empty row
    }                                              // end of empty-row case
    if (table[i].kind == kind && memcmp(table[i].mac, mac, 6) == 0) return &table[i]; // same kind + same MAC = already known, return it
  }                                                // end of scan
  if (freeSlot < 0) { dropped++; return nullptr; } // no empty row: count the loss and give up

  Entry &e = table[freeSlot];                      // use the empty row
  memset(&e, 0, sizeof(e));                        // wipe it to all zeros
  e.used = true;                                   // mark it occupied
  e.kind = kind;                                   // store the device kind
  memcpy(e.mac, mac, 6);                           // store the MAC address
  e.rssi = -127;                                   // start at the weakest possible signal so any real reading beats it
  e.mfr = -1;                                      // -1 means "no manufacturer id yet"
  return &e;                                       // hand back the fresh row
}                                                  // end of findOrAdd

// Record one more time we heard a device, keeping its strongest signal
static inline void recordHit(Entry *e, int rssi) {
  e->hits++;                                       // one more sighting
  if (rssi > e->rssi) e->rssi = rssi;              // keep the strongest (largest) signal
}                                                  // end of recordHit

// Add a vendor ID to a list unless it's already there or the list is full
static void addVendorOui(uint8_t (*list)[3], uint8_t &count, const uint8_t *oui) {
  for (int i = 0; i < count; i++) {                // look through the IDs we already have
    if (memcmp(list[i], oui, 3) == 0) return;      // already stored: nothing to do
  }                                                // end of search
  if (count < MAX_VENDOR_OUIS) memcpy(list[count++], oui, 3); // room left: append it and bump the count
}                                                  // end of addVendorOui

// Add a BLE service ID to a list unless it's already there or the list is full
static void addService(uint16_t *list, uint8_t &count, uint16_t uuid) {
  for (int i = 0; i < count; i++) {                // look through the IDs we already have
    if (list[i] == uuid) return;                   // already stored: nothing to do
  }                                                // end of search
  if (count < MAX_BLE_SERVICES) list[count++] = uuid; // room left: append it and bump the count
}                                                  // end of addService

// ─────────────────────────────────────────────── WiFi sniffer

// FNV-1a: a tiny hash function that turns bytes into one 32-bit number
static inline uint32_t fnv1a(uint32_t hash, const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; i++) {               // for every input byte
    hash ^= data[i];                               // mix the byte in with XOR
    hash *= 16777619u;                             // multiply by the FNV prime to scramble the bits
  }                                                // end of loop
  return hash;                                     // return the updated hash
}                                                  // end of fnv1a

// Temporary container for what we extract from a single probe request
struct ProbeInfo {
  char     ssid[MAX_SSID_LEN];   // network name the device is searching for
  char     wpsName[MAX_SSID_LEN];// WPS device name
  char     wpsModel[25];         // WPS model name
  uint32_t fp;                   // fingerprint hash
  uint8_t  caps;                 // capability flags found
  uint8_t  vo[MAX_VENDOR_OUIS][3]; // vendor IDs found
  uint8_t  nvo;                  // number of vendor IDs found
};                               // end of ProbeInfo

// Read WPS data: a list of [type:2 bytes][length:2 bytes][value] items; keep name and model
static void parseWps(const uint8_t *p, int len, ProbeInfo &pi) {
  const uint16_t WPS_DEVICE_NAME = 0x1011;         // WPS code meaning "device name"
  const uint16_t WPS_MODEL_NAME  = 0x1023;         // WPS code meaning "model name"

  int i = 0;                                       // position inside the data
  while (i + 4 <= len) {                           // while a full 4-byte item header fits
    uint16_t type = (p[i] << 8) | p[i + 1];        // first 2 bytes = item type (big-endian)
    uint16_t valueLen = (p[i + 2] << 8) | p[i + 3];// next 2 bytes = value length (big-endian)
    if (i + 4 + valueLen > len) break;             // value would run past the end: data is corrupt, stop
    const uint8_t *value = p + i + 4;              // the value starts right after the header

    if (type == WPS_DEVICE_NAME) copySafe(pi.wpsName, sizeof(pi.wpsName), value, valueLen);       // save device name
    else if (type == WPS_MODEL_NAME) copySafe(pi.wpsModel, sizeof(pi.wpsModel), value, valueLen); // save model name
    i += 4 + valueLen;                             // jump to the next item
  }                                                // end of loop
}                                                  // end of parseWps

// Read a probe request body: a list of [tag:1 byte][length:1 byte][value] elements
static void parseProbeIEs(const uint8_t *p, int len, ProbeInfo &pi) {
  const uint8_t TAG_SSID = 0, TAG_SUPPORTED_RATES = 1, TAG_EXT_RATES = 50; // element ids: network name, speed lists
  const uint8_t TAG_HT_CAPS = 45, TAG_VHT_CAPS = 191, TAG_EXT_CAPS = 127;  // element ids: WiFi 4 / WiFi 5 / extended capabilities
  const uint8_t TAG_VENDOR = 221, TAG_EXTENSION = 255;                     // element ids: vendor-specific / extension container
  const uint8_t EXT_HE_CAPS = 35;                  // inside an extension element, id 35 = WiFi 6 capabilities

  pi.fp = 2166136261u;                             // start the fingerprint at the FNV-1a starting value

  int i = 0;                                       // position inside the body
  while (i + 2 <= len) {                           // while a full 2-byte element header fits
    uint8_t tag = p[i], tagLen = p[i + 1];         // element id and its value length
    if (i + 2 + tagLen > len) break;               // element runs past the end: corrupt, stop
    const uint8_t *value = p + i + 2;              // value starts after the 2-byte header

    if (tag == TAG_SSID) {                         // element is the network name
      copySafe(pi.ssid, sizeof(pi.ssid), value, tagLen); // save it
    } else if (tag == TAG_VENDOR && tagLen >= 4) { // vendor-specific element with at least ID + type bytes
      addVendorOui(pi.vo, pi.nvo, value);          // remember the 3-byte vendor ID
      bool isWps = value[0] == 0x00 && value[1] == 0x50 && value[2] == 0xF2 && value[3] == 0x04; // 00:50:F2 type 4 = WPS
      if (isWps) {                                 // it's a WPS block
        pi.caps |= CAP_WPS;                        // flag that WPS info was present
        parseWps(value + 4, tagLen - 4, pi);       // read name/model from after the 4-byte prefix
      }                                            // end of WPS case
    }                                              // end of vendor case

    if (tag == TAG_HT_CAPS) pi.caps |= CAP_HT;     // has HT element -> supports WiFi 4
    if (tag == TAG_VHT_CAPS) pi.caps |= CAP_VHT;   // has VHT element -> supports WiFi 5
    if (tag == TAG_EXTENSION && tagLen >= 1 && value[0] == EXT_HE_CAPS) pi.caps |= CAP_HE; // extension id 35 -> supports WiFi 6

    // elements that describe the hardware are folded into the fingerprint (name and vendor data are not)
    bool inFingerprint = tag == TAG_SUPPORTED_RATES || tag == TAG_EXT_RATES || tag == TAG_HT_CAPS ||
                         tag == TAG_VHT_CAPS || tag == TAG_EXT_CAPS || tag == TAG_EXTENSION;
    if (inFingerprint) {                           // only hash the hardware-describing elements
      pi.fp = fnv1a(pi.fp, &tag, 1);               // hash the element id
      pi.fp = fnv1a(pi.fp, value, tagLen);         // hash the element value
    }                                              // end of fingerprint case
    i += 2 + tagLen;                               // jump to the next element
  }                                                // end of loop
}                                                  // end of parseProbeIEs

// Merge a parsed probe request into the device's table row (call while holding the lock)
static void storeProbe(Entry *e, const ProbeInfo &pi) {
  e->fp = pi.fp;                                   // save the fingerprint
  e->caps |= pi.caps | CAP_PROBE;                  // add found capabilities and mark "sent a probe"

  if (pi.ssid[0]) {                                // the probe named a network
    if (!e->text[0]) memcpy(e->text, pi.ssid, sizeof(pi.ssid)); // first name goes in slot 1
    else if (!e->text2[0] && strcmp(e->text, pi.ssid) != 0) memcpy(e->text2, pi.ssid, sizeof(pi.ssid)); // a different second name goes in slot 2
  }                                                // end of SSID case
  if (pi.wpsModel[0]) memcpy(e->model, pi.wpsModel, sizeof(pi.wpsModel)); // save WPS model
  if (pi.wpsName[0]) memcpy(e->text2, pi.wpsName, sizeof(pi.wpsName));    // WPS name takes over slot 2

  for (int k = 0; k < pi.nvo; k++) addVendorOui(e->vo, e->nvo, pi.vo[k]); // merge vendor IDs
}                                                  // end of storeProbe

// Handle a probe request (a device searching for networks). Layout: 24-byte header, then elements.
static void onProbeRequest(const uint8_t *frame, int len, int rssi) {
  const uint8_t *senderMac = frame + 10;           // the sender's MAC is at byte 10 of the header

  ProbeInfo pi;                                    // scratch space for parsed data
  memset(&pi, 0, sizeof(pi));                      // zero it
  parseProbeIEs(frame + 24, len - 24, pi);         // parse everything after the 24-byte header

  portENTER_CRITICAL_ISR(&tableMux);               // take the lock before touching the table
  Entry *e = findOrAdd('w', senderMac);            // find/create this WiFi device's row
  if (e) {                                         // got a row (table wasn't full)
    recordHit(e, rssi);                            // count the sighting + keep best signal
    e->channel = currentChannel;                   // remember the channel
    storeProbe(e, pi);                             // save the parsed details
  }                                                // end of row case
  portEXIT_CRITICAL_ISR(&tableMux);                // release the lock
}                                                  // end of onProbeRequest

// Handle a beacon (a router announcing itself). The network-name element starts at byte 36.
static void onBeacon(const uint8_t *frame, int len, int rssi) {
  const uint8_t *apMac = frame + 16;               // the router's MAC is at byte 16

  char ssid[MAX_SSID_LEN] = {0};                   // buffer for its name, starts empty
  bool hasSsid = frame[36] == 0;                   // element id 0 = network name
  if (hasSsid) {                                   // name element is where we expect
    uint8_t ssidLen = frame[37];                   // its length
    copySafe(ssid, sizeof(ssid), frame + 38, ssidLen <= len - 38 ? ssidLen : 0); // copy it (length 0 if it would overrun)
  }                                                // end of name case

  portENTER_CRITICAL_ISR(&tableMux);               // take the lock
  Entry *e = findOrAdd('a', apMac);                // find/create this access point's row
  if (e) {                                         // got a row
    recordHit(e, rssi);                            // count the sighting
    e->channel = currentChannel;                   // remember the channel
    if (ssid[0] && !e->text[0]) memcpy(e->text, ssid, sizeof(ssid)); // store its name once
  }                                                // end of row case
  portEXIT_CRITICAL_ISR(&tableMux);                // release the lock
}                                                  // end of onBeacon

// Handle a data frame: a device sending data to a router proves it is connected to a network
static void onDataFrame(const uint8_t *frame, int rssi) {
  const uint8_t flags = frame[1];                  // second header byte holds direction flags
  const bool toAccessPoint = (flags & 0x03) == 0x01; // low 2 bits == 01 means "device -> router"
  if (!toAccessPoint) return;                      // ignore other directions

  const uint8_t *senderMac = frame + 10;           // sender's MAC at byte 10
  const bool isMulticast = senderMac[0] & 0x01;    // lowest bit set = group/broadcast address, not a real device
  if (isMulticast) return;                         // ignore those

  portENTER_CRITICAL_ISR(&tableMux);               // take the lock
  Entry *e = findOrAdd('w', senderMac);            // find/create this WiFi device's row
  if (e) {                                         // got a row
    recordHit(e, rssi);                            // count the sighting
    e->channel = currentChannel;                   // remember the channel
    e->caps |= CAP_CONNECTED;                      // flag it as connected to a network
    memcpy(e->bssid, frame + 4, 6);                // save the router's MAC (byte 4 of the header)
  }                                                // end of row case
  portEXIT_CRITICAL_ISR(&tableMux);                // release the lock
}                                                  // end of onDataFrame

// The WiFi driver calls this for every frame heard while sniffing (IRAM_ATTR = keep in fast memory)
static void IRAM_ATTR onPromisc(void *buf, wifi_promiscuous_pkt_type_t type) {
  const uint8_t FRAME_PROBE_REQUEST = 0x40;        // first header byte for a probe request
  const uint8_t FRAME_BEACON        = 0x80;        // first header byte for a beacon

  const wifi_promiscuous_pkt_t *pkt = (const wifi_promiscuous_pkt_t *)buf; // interpret the raw buffer as a packet struct
  const uint8_t *frame = pkt->payload;             // pointer to the frame bytes
  int len = pkt->rx_ctrl.sig_len - 4;              // frame length minus the 4-byte checksum at the end
  int rssi = pkt->rx_ctrl.rssi;                    // signal strength of this packet
  if (len < 24) return;                            // too short to even hold a header: ignore

  if (type == WIFI_PKT_MGMT) {                     // management frame (probes, beacons, ...)
    mgmtFrames++;                                  // count it for the heartbeat
    uint8_t frameType = frame[0];                  // first byte tells which management type
    if (frameType == FRAME_PROBE_REQUEST) onProbeRequest(frame, len, rssi);       // a device searching for networks
    else if (frameType == FRAME_BEACON && len >= 38) onBeacon(frame, len, rssi);  // a router announcing itself
  } else if (type == WIFI_PKT_DATA) {              // data frame
    onDataFrame(frame, rssi);                      // check if it shows a connected device
  }                                                // end of type check
}                                                  // end of onPromisc

// One full WiFi sweep: listen on each channel for a short time
static void wifiPhase() {
  esp_wifi_set_promiscuous(true);                  // switch the radio into sniffer mode
  for (uint8_t ch = 1; ch <= WIFI_CHANNELS; ch++) {// for channels 1..13
    currentChannel = ch;                           // tell the callback which channel we're on
    esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);// tune the radio to this channel
    delay(WIFI_DWELL_MS);                          // listen for 160 ms
  }                                                // end of channel loop
  esp_wifi_set_promiscuous(false);                 // leave sniffer mode

  // Hopping leaves the radio on the last sniffed channel; return to the AP's
  // channel or the station link silently breaks and uploads fail (HTTP -1).
  if (apChannel) esp_wifi_set_channel(apChannel, WIFI_SECOND_CHAN_NONE); // retune to the router's channel (skipped while apChannel is 0)
}                                                  // end of wifiPhase

// ─────────────────────────────────────────────── BLE

// Extract a 16-bit UUID; BLE can also use 32/128-bit ones which we ignore
static bool getUuid16(const NimBLEUUID &uuid, uint16_t &out) {
  if (uuid.bitSize() != 16) return false;          // not a 16-bit UUID: skip
  out = uuid.getNative()->u16.value;               // read the 16-bit value
  return true;                                     // success
}                                                  // end of getUuid16

// NimBLE calls onResult every time it hears a BLE advertisement
class AdvCallbacks : public NimBLEAdvertisedDeviceCallbacks {
  void onResult(NimBLEAdvertisedDevice *d) override {   // d = the device that was just heard
    uint8_t mac[6];                                // our copy of the MAC address
    const uint8_t *rawAddr = d->getAddress().getNative(); // NimBLE's address bytes (stored backwards)
    for (int k = 0; k < 6; k++) mac[k] = rawAddr[5 - k];  // reverse them into normal order

    int32_t mfr = -1;                              // manufacturer id, -1 = none
    uint8_t md[MAX_BLE_MFR_DATA];                  // buffer for raw manufacturer data
    uint8_t mdLen = 0;                             // how many bytes we copied
    if (d->haveManufacturerData()) {               // the advertisement carries manufacturer data
      std::string data = d->getManufacturerData(); // fetch it
      if (data.size() >= 2) mfr = (uint8_t)data[0] | ((uint8_t)data[1] << 8); // first two bytes = company id (little-endian)
      mdLen = data.size() < sizeof(md) ? data.size() : sizeof(md); // copy at most 31 bytes
      memcpy(md, data.data(), mdLen);              // copy the bytes
    }                                              // end of manufacturer data case

    char name[MAX_SSID_LEN] = {0};                 // buffer for the device name, starts empty
    if (d->haveName()) {                           // the device advertises a name
      std::string n = d->getName();                // fetch it
      copySafe(name, sizeof(name), (const uint8_t *)n.data(), n.size()); // copy a JSON-safe version
    }                                              // end of name case

    uint16_t services[MAX_BLE_SERVICES];           // service IDs found in this advertisement
    uint8_t serviceCount = 0;                      // how many found
    uint16_t uuid;                                 // scratch variable for each UUID
    for (int i = 0; i < (int)d->getServiceUUIDCount(); i++) {       // each advertised service
      if (getUuid16(d->getServiceUUID(i), uuid)) addService(services, serviceCount, uuid); // keep it if 16-bit
    }                                              // end of advertised services
    for (int i = 0; i < (int)d->getServiceDataCount(); i++) {       // each service-data entry
      if (getUuid16(d->getServiceDataUUID(i), uuid)) addService(services, serviceCount, uuid); // keep it if 16-bit
    }                                              // end of service data

    uint16_t appearance = d->haveAppearance() ? d->getAppearance() : 0; // device-type code, 0 if absent
    bool hasTx = d->haveTXPower();                 // does it report transmit power?
    int8_t tx = hasTx ? d->getTXPower() : 0;       // the reported power (0 if none)
    int rssi = d->getRSSI();                       // signal strength of this advertisement
    uint8_t addrType = d->getAddress().getType();  // public (0) or random (1) address

    portENTER_CRITICAL(&tableMux);                 // take the lock
    Entry *e = findOrAdd('b', mac);                // find/create this BLE device's row
    if (e) {                                       // got a row
      recordHit(e, rssi);                          // count the sighting
      e->addrType = addrType;                      // save address type
      if (mfr >= 0) {                              // manufacturer data was present
        e->mfr = mfr;                              // save company id
        memcpy(e->md, md, mdLen);                  // save raw data
        e->mdLen = mdLen;                          // save its length
      }                                            // end of manufacturer case
      if (name[0] && !e->text[0]) memcpy(e->text, name, sizeof(name)); // save the name the first time we see one
      for (int i = 0; i < serviceCount; i++) addService(e->svc, e->nsvc, services[i]); // merge service IDs
      if (appearance) e->appearance = appearance;  // save device-type code
      if (hasTx) {                                 // transmit power was present
        e->tx = tx;                                // save it
        e->hasTx = true;                           // remember that we have it
      }                                            // end of tx case
    }                                              // end of row case
    portEXIT_CRITICAL(&tableMux);                  // release the lock
  }                                                // end of onResult
};                                                 // end of AdvCallbacks

// Make sure the background BLE scan is running (it keeps going between sweeps)
static void ensureBleScanRunning() {
  NimBLEScan *scan = NimBLEDevice::getScan();      // get the scanner object
  if (!scan->isScanning()) scan->start(0, nullptr, false); // if stopped, start it with duration 0 = run forever
}                                                  // end of ensureBleScanRunning

// ─────────────────────────────────────────────── building the JSON batch

// Write a MAC like "aa:bb:cc:dd:ee:ff" into `out` (needs 18 bytes)
static void formatMac(char *out, const uint8_t *mac) {
  snprintf(out, 18, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]); // each byte as 2 hex digits
}                                                  // end of formatMac

// Small helper that appends printf-style text to a buffer without ever overflowing it
struct JsonLine {
  char  *buf;                                      // the buffer we write into
  size_t cap;                                      // its total size
  int    len;                                      // how much we've written so far

  JsonLine(char *buffer, size_t capacity) : buf(buffer), cap(capacity), len(0) {} // constructor: remember buffer, start empty

  void add(const char *fmt, ...) {                 // append formatted text (like printf)
    va_list args;                                  // holder for the extra arguments
    va_start(args, fmt);                           // begin reading the extra arguments
    len += vsnprintf(buf + len, cap - len, fmt, args); // format into the remaining space and advance len
    va_end(args);                                  // finish reading arguments
    if (len >= (int)cap) len = cap - 1;            // if output was cut off, clamp len to stay inside the buffer
  }                                                // end of add
};                                                 // end of JsonLine

// Append the WiFi-specific JSON fields
static void addWifiFields(JsonLine &json, const Entry &e) {
  bool randomizedMac = e.mac[0] & 0x02;            // "locally administered" bit set = privacy/random MAC
  json.add(",\"rnd\":%d", randomizedMac ? 1 : 0);  // "rnd": 1 if randomized, else 0
  if (e.caps & CAP_PROBE) json.add(",\"fp\":\"%08lx\"", (unsigned long)e.fp); // "fp": fingerprint as 8 hex digits, if it probed

  json.add(",\"ss\":[");                           // start the "ss" (SSIDs) array
  if (e.text[0]) json.add("\"%s\"", e.text);       // first network name
  if (e.text2[0] && !(e.caps & CAP_WPS)) json.add(",\"%s\"", e.text2); // second name (but text2 is a WPS name when WPS was seen, so skip then)
  json.add("],\"cap\":\"%s%s%s\"",                 // close the array and write "cap" (WiFi generations)
           (e.caps & CAP_HT) ? "ht," : "", (e.caps & CAP_VHT) ? "vht," : "", (e.caps & CAP_HE) ? "he" : ""); // e.g. "ht,vht,he"

  if (e.nvo) {                                     // we stored some vendor IDs
    json.add(",\"vo\":\"");                        // open the "vo" string
    for (int k = 0; k < e.nvo; k++) json.add("%s%02x%02x%02x", k ? "," : "", e.vo[k][0], e.vo[k][1], e.vo[k][2]); // comma-separated 6-hex-digit IDs
    json.add("\"");                                // close the string
  }                                                // end of vendor IDs
  if (e.caps & CAP_WPS) json.add(",\"wn\":\"%s\",\"wm\":\"%s\"", e.text2, e.model); // WPS device name and model
  if (e.caps & CAP_CONNECTED) {                    // device was seen connected to a router
    char bssid[18];                                // buffer for the router's MAC text
    formatMac(bssid, e.bssid);                     // format it
    json.add(",\"c\":1,\"bss\":\"%s\"", bssid);    // "c": 1 (connected) and "bss": router MAC
  }                                                // end of connected case
}                                                  // end of addWifiFields

// Append the BLE-specific JSON fields
static void addBleFields(JsonLine &json, const Entry &e) {
  json.add(",\"at\":%u,\"mfr\":%ld,\"name\":\"%s\"", e.addrType, (long)e.mfr, e.text); // address type, manufacturer id, name
  if (e.mdLen) {                                   // we have raw manufacturer data
    json.add(",\"md\":\"");                        // open the "md" string
    for (int k = 0; k < e.mdLen; k++) json.add("%02x", e.md[k]); // each byte as 2 hex digits
    json.add("\"");                                // close it
  }                                                // end of manufacturer data
  if (e.nsvc) {                                    // we have service IDs
    json.add(",\"sv\":\"");                        // open the "sv" string
    for (int k = 0; k < e.nsvc; k++) json.add("%s%04x", k ? "," : "", e.svc[k]); // comma-separated 4-hex-digit IDs
    json.add("\"");                                // close it
  }                                                // end of services
  if (e.appearance) json.add(",\"ap\":%u", e.appearance); // device-type code, if any
  if (e.hasTx) json.add(",\"tx\":%d", e.tx);       // transmit power, if reported
}                                                  // end of addBleFields

// Append one JSON object to the batch, adding a comma if it isn't the first
static void addToBatch(const char *json) {
  if (batchCount > 0) batch += ',';                // separate from the previous object
  batch += json;                                   // append the object text
  batchCount++;                                    // one more object in the batch
}                                                  // end of addToBatch

// Empty the batch so the next sweep starts fresh
static void clearBatch() {
  batch = "";                                      // erase the text
  batchCount = 0;                                  // reset the counter
}                                                  // end of clearBatch

// Convert one table row into a JSON object and add it to the batch
static void appendEntry(const Entry &e) {
  static char buffer[600];                         // work buffer (static so it isn't on the small stack)
  JsonLine json(buffer, sizeof(buffer));           // writer for that buffer

  char mac[18];                                    // buffer for the MAC text
  formatMac(mac, e.mac);                           // format the MAC
  json.add("{\"t\":\"%c\",\"m\":\"%s\",\"r\":%d,\"n\":%u,\"ch\":%u", e.kind, mac, e.rssi, e.hits, e.channel); // common fields: type, MAC, signal, hit count, channel

  if (e.kind == 'w') addWifiFields(json, e);       // WiFi device: add WiFi fields
  else if (e.kind == 'a') json.add(",\"ssid\":\"%s\"", e.text); // access point: just its network name
  else addBleFields(json, e);                      // otherwise it's BLE: add BLE fields
  json.add("}");                                   // close the JSON object

  addToBatch(buffer);                              // add the finished object to the batch
}                                                  // end of appendEntry

// Add the status "heartbeat" object (uptime, memory, counts) to the batch
static void appendHeartbeat(int deviceCount, uint32_t droppedDevices, uint32_t mgmtFrameCount) {
  char hb[256];                                    // buffer for the heartbeat JSON
  snprintf(hb, sizeof(hb),                         // write formatted text into it
    "{\"t\":\"hb\",\"cyc\":%lu,\"up\":%lu,\"heap\":%lu,\"dev\":%d,\"drop\":%lu,\"mgmt\":%lu,\"fw\":\"%s\",\"chip\":\"%s\",\"name\":\"%s\"}", // the JSON template
    (unsigned long)cycle, (unsigned long)(millis() / 1000), (unsigned long)ESP.getFreeHeap(), // sweep number, uptime in seconds, free memory
    deviceCount, (unsigned long)droppedDevices, (unsigned long)mgmtFrameCount,               // devices this sweep, dropped devices, management frames
    FW_VERSION, ESP.getChipModel(), DEVICE_NAME);  // firmware version, chip model, device name from config.h
  addToBatch(hb);                                  // add it to the batch
  Serial.println(hb);                              // also print it to the USB serial monitor
}                                                  // end of appendHeartbeat

// ─────────────────────────────────────────────── uploading

// Send the batch to the server; returns true on success
static bool postBatch() {
  if (!wifiReady || batch.isEmpty()) return false; // nothing to do if offline or the batch is empty

  String url = String(SERVER_URL) + "/api/ingest"; // full endpoint URL
  String body = "{\"msgs\":[" + batch + "]}";      // wrap the objects in {"msgs":[ ... ]}

  WiFiClientSecure client;                         // network connection object
  client.setInsecure();                            // don't verify the server's TLS certificate (simple but less secure)
  HTTPClient http;                                 // HTTP request helper
  http.setTimeout(HTTP_TIMEOUT_MS);                // give up after 15 seconds
  http.begin(client, url);                         // prepare the request to our URL
  http.addHeader("Content-Type", "application/json"); // say the body is JSON
  http.addHeader("Authorization", "Bearer " DEVICE_API_KEY); // authenticate with the device key (string pasted together at compile time)
  int code = http.POST(body);                      // send it; code = HTTP status, or negative on network error
  http.end();                                      // close the connection

  if (code == 200 || code == 204) {                // server said OK
    Serial.printf("[http] POST ok (%d msgs, %d bytes)\n", batchCount, body.length()); // log success
    return true;                                   // report success
  }                                                // end of success case
  Serial.printf("[http] POST failed: HTTP %d\n", code); // log the failure code
  return false;                                    // report failure
}                                                  // end of postBatch

// Move every device from the table into the batch (emptying the table); returns how many
static int drainTableIntoBatch() {
  int count = 0;                                   // devices moved so far
  Entry e;                                         // local copy of a row
  for (int i = 0; i < MAX_DEVICES; i++) {          // go through every table row
    portENTER_CRITICAL(&tableMux);                 // lock while reading the row
    bool used = table[i].used;                     // is this row occupied?
    if (used) {                                    // yes
      e = table[i];                                // copy it out
      table[i].used = false;                       // free the row for the next sweep
    }                                              // end of used case
    portEXIT_CRITICAL(&tableMux);                  // unlock (the slow JSON work happens outside the lock)

    if (!used) continue;                           // skip empty rows
    count++;                                       // count this device
    appendEntry(e);                                // convert the copy to JSON and add it to the batch
  }                                                // end of loop
  return count;                                    // tell the caller how many devices there were
}                                                  // end of drainTableIntoBatch

// End of a sweep: build the full batch, upload it, reset
static void flush() {
  int deviceCount = drainTableIntoBatch();         // table -> batch, and remember how many devices

  portENTER_CRITICAL(&tableMux);                   // lock to read+reset the shared counters
  uint32_t droppedDevices = dropped;               // read the dropped-device count
  uint32_t mgmtFrameCount = mgmtFrames;            // read the management-frame count
  dropped = 0;                                     // reset for the next sweep
  mgmtFrames = 0;                                  // reset for the next sweep
  portEXIT_CRITICAL(&tableMux);                    // unlock

  appendHeartbeat(deviceCount, droppedDevices, mgmtFrameCount); // add the status object last

  if (wifiReady) postBatch();                      // online: upload
  else Serial.printf("[wifi] offline — %d msgs not sent\n", batchCount); // offline: just log it (data is discarded)

  clearBatch();                                    // start the next sweep with an empty batch
}                                                  // end of flush

// ─────────────────────────────────────────────── WiFi connection

// Connect to the router (waits up to WIFI_TIMEOUT_S seconds)
static void connectWifi() {
  Serial.printf("[wifi] connecting to %s…\n", WIFI_SSID); // log which network we try
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);            // start connecting with the credentials from config.h

  uint32_t startedAt = millis();                   // note when we started
  while (WiFi.status() != WL_CONNECTED && (millis() - startedAt) < (WIFI_TIMEOUT_S * 1000UL)) { // wait until connected or timed out
    delay(500);                                    // check twice a second
    Serial.print('.');                             // print a progress dot
  }                                                // end of wait loop

  wifiReady = WiFi.status() == WL_CONNECTED;       // remember whether it worked
  if (wifiReady) Serial.printf("\n[wifi] connected, IP %s\n", WiFi.localIP().toString().c_str()); // success: show our IP address
  else Serial.println("\n[wifi] connect failed — will retry"); // failure: loop() will retry later
}                                                  // end of connectWifi

// ─────────────────────────────────────────────── Arduino entry points

// Register our packet callback with the WiFi driver
static void setupWifiSniffer() {
  wifi_promiscuous_filter_t filter = {.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA}; // only deliver management + data frames
  esp_wifi_set_promiscuous_filter(&filter);        // apply the filter
  esp_wifi_set_promiscuous_rx_cb(&onPromisc);      // call onPromisc for every matching frame
}                                                  // end of setupWifiSniffer

// Initialise Bluetooth scanning
static void setupBle() {
  NimBLEDevice::init("");                          // start the BLE stack with no device name
  NimBLEScan *scan = NimBLEDevice::getScan();      // get the scanner
  scan->setAdvertisedDeviceCallbacks(new AdvCallbacks(), true); // call AdvCallbacks for each advertisement; true = also report repeats
  scan->setActiveScan(true);                       // active scan: also ask devices for extra info (names)
  scan->setInterval(100);                          // scan cycle length (ms)
  scan->setWindow(100);                            // listen the whole interval (window == interval) = always listening
  // NOTE: the original source had "scan->setMaxResults(0);" here but it was accidentally
  // inside the comment above, so it never ran. Left disabled to keep behaviour unchanged.
}                                                  // end of setupBle

// Announce that the device just booted
static void sendHello() {
  char hello[200];                                 // buffer for the hello JSON
  snprintf(hello, sizeof(hello),                   // write formatted text into it
    "{\"t\":\"hello\",\"fw\":\"%s\",\"chip\":\"%s\",\"mac\":\"%s\",\"name\":\"%s\"}", // JSON template
    FW_VERSION, ESP.getChipModel(), WiFi.macAddress().c_str(), DEVICE_NAME);         // firmware, chip, our own MAC, device name
  Serial.println(hello);                           // print it to serial

  if (wifiReady) {                                 // online
    addToBatch(hello);                             // put it in the batch
    postBatch();                                   // upload immediately
    clearBatch();                                  // reset the batch
  }                                                // end of online case
}                                                  // end of sendHello

// Arduino runs setup() once at power-on
void setup() {
  Serial.begin(921600);                            // start the USB serial port at 921600 baud
  delay(200);                                      // short pause so the port is ready

  WiFi.mode(WIFI_STA);                             // act as a normal WiFi client (station)
  WiFi.disconnect();                               // clear any previous connection state
  connectWifi();                                   // connect first so it doesn't disturb sniffing later

  setupWifiSniffer();                              // register the sniffer callback
  setupBle();                                      // configure Bluetooth scanning
  sendHello();                                     // tell the server we booted
}                                                  // end of setup

// Arduino runs loop() over and over forever
void loop() {
  if (WiFi.status() != WL_CONNECTED) {             // lost the router?
    wifiReady = false;                             // mark offline
    connectWifi();                                 // try to reconnect
  }                                                // end of reconnect case
  cycle++;                                         // count this sweep
  ensureBleScanRunning();                          // keep the BLE scan alive
  wifiPhase();                                     // sweep WiFi channels (takes about 13 x 160 ms = ~2 s)
  flush();                                         // package and upload what we heard
}                                                  // end of loop
