import type { Settings } from './settings'

export const TYPES = ['phone', 'computer', 'wearable', 'audio', 'tv', 'tracker', 'ap', 'other'] as const
export type DevType = (typeof TYPES)[number]

export const TYPE_LABELS: Record<string, string> = {
  phone: 'Phone', computer: 'Computer', wearable: 'Wearable', audio: 'Audio',
  tv: 'TV / media', tracker: 'Tracker / tag', ap: 'Access point', other: 'Other / unknown',
}

const NAME_RULES: [DevType, RegExp][] = [
  ['tracker', /\btile\b|airtag|smarttag|jiotag|chipolo|\btag\b/i],
  ['audio', /airpods|buds|\bpods\b|headphone|earphone|headset|\bjbl\b|bose|\bwh-|\bwf-|soundcore|boat|rockerz|airdopes|nirvana|beats|speaker|soundbar|sennheiser|skullcandy|neckband|\btws\b|earbud|marshall|harman|realme buds|oneplus nord buds|sony (wh|wf)/i],
  ['wearable', /watch|\bband\b|smart ?band|amazfit|galaxy fit|\bgear\b|garmin|forerunner|\bvenu\b|fenix|polar|whoop|noisefit|colorfit|noise_|fire-?boltt|\bwave\b|\bring\b|fitbit|mi band|huawei band|honor band/i],
  ['tv', /\btv\b|bravia|fire ?tv|firestick|chromecast|roku|\[tv\]|smart tv|android tv|mi box|projector|apple tv|homepod|echo|alexa|nest (hub|audio|mini)/i],
  ['computer', /macbook|imac|mac mini|mac studio|laptop|desktop|thinkpad|ideapad|vivobook|zenbook|surface|\bdell\b|\bhp\b|lenovo|windows|-pc\b|\bpc\b|legion|omen|predator|inspiron|latitude|ipad/i],
  ['phone', /iphone|galaxy|pixel|redmi|oneplus|\bvivo\b|oppo|realme|poco|moto|nokia|xiaomi|iqoo|nothing phone|\bmobile\b|\bphone\b|android|samsung_mobile|\bsm-[a-z]\d/i],
]

const HOTSPOT_SSID = /iphone|galaxy|redmi|oneplus|androidap|vivo|oppo|realme|poco|pixel|hotspot|\bmi\b|moto|nokia|iqoo|nothing/i

const APPLE_TYPES: Record<number, [DevType, string, string]> = {
  0x02: ['other', 'iBeacon', 'high'],
  0x05: ['phone', 'Apple device (AirDrop)', 'low'],
  0x06: ['other', 'HomeKit accessory', 'high'],
  0x07: ['audio', 'AirPods / Beats', 'high'],
  0x08: ['phone', 'Apple device (Hey Siri)', 'low'],
  0x09: ['tv', 'AirPlay target (Apple TV / HomePod)', 'high'],
  0x0A: ['phone', 'Apple device (AirPlay source)', 'low'],
  0x0B: ['wearable', 'Apple Watch', 'high'],
  0x0C: ['phone', 'Apple device (Handoff)', 'low'],
  0x0D: ['computer', 'Apple device (tethering target)', 'low'],
  0x0E: ['phone', 'iPhone (personal hotspot)', 'high'],
  0x0F: ['phone', 'Apple device (Nearby Action)', 'low'],
  0x10: ['phone', 'Apple device (iPhone / iPad / Mac)', 'low'],
  0x12: ['tracker', 'Find My (AirTag or offline Apple device)', 'low'],
}

const APPLE_AUDIO_MODELS: Record<number, string> = {
  0x0220: 'AirPods', 0x0F20: 'AirPods (2nd gen)', 0x1320: 'AirPods (3rd gen)',
  0x0E20: 'AirPods Pro', 0x1420: 'AirPods Pro 2', 0x0A20: 'AirPods Max',
  0x0520: 'BeatsX', 0x0620: 'Beats Solo3', 0x0920: 'Beats Studio3',
  0x0B20: 'Powerbeats Pro', 0x0C20: 'Beats Solo Pro', 0x1020: 'Beats Flex',
  0x1120: 'Beats Studio Buds', 0x0320: 'Powerbeats3',
}

const NEARBY_ACTIONS: Record<number, [string, string]> = {
  0x0: ['unknown', 'Activity unknown'], 0x1: ['unknown', 'Activity reporting off'],
  0x3: ['idle', 'Locked / idle'], 0x5: ['idle', 'Audio, screen off'],
  0x7: ['in_use', 'Screen on'], 0x9: ['in_use', 'Watching video'],
  0xA: ['idle', 'Watch on wrist'], 0xB: ['in_use', 'Recently used'],
  0xD: ['driving', 'Driving'], 0xE: ['in_use', 'On a call / FaceTime'],
}

const MS_CDP_TYPES: Record<number, [DevType, string]> = {
  1: ['tv', 'Xbox One'], 6: ['phone', 'iPhone (Microsoft app)'],
  7: ['computer', 'iPad (Microsoft app)'], 8: ['phone', 'Android (Microsoft app)'],
  9: ['computer', 'Windows desktop'], 11: ['phone', 'Windows phone'],
  12: ['computer', 'Linux device'], 13: ['other', 'Windows IoT'],
  14: ['tv', 'Surface Hub'], 15: ['computer', 'Windows laptop'], 16: ['computer', 'Windows tablet'],
}

const APPEARANCE: Record<number, [DevType, string]> = {
  1: ['phone', 'Phone'], 2: ['computer', 'Computer'], 3: ['wearable', 'Watch'],
  5: ['tv', 'Display'], 6: ['other', 'Remote control'], 7: ['wearable', 'Eyeglasses'],
  8: ['tracker', 'Tag'], 9: ['tracker', 'Keyring'], 10: ['audio', 'Media player'],
  13: ['wearable', 'Heart-rate sensor'], 15: ['computer', 'Keyboard / mouse (HID)'],
  17: ['wearable', 'Running sensor'], 18: ['wearable', 'Cycling sensor'],
  33: ['audio', 'Audio sink'], 34: ['audio', 'Audio source'], 49: ['wearable', 'Pulse oximeter'],
}

const SERVICES: Record<number, [DevType, string]> = {
  0x180D: ['wearable', 'Heart-rate service'], 0x1814: ['wearable', 'Running speed service'],
  0x1816: ['wearable', 'Cycling service'], 0x1812: ['computer', 'Keyboard / mouse (HID)'],
  0x110B: ['audio', 'Audio sink'], 0x110A: ['audio', 'Audio source'],
  0xFE2C: ['audio', 'Google Fast Pair accessory'], 0xFD6F: ['phone', 'Exposure Notification (phone)'],
  0xFE9F: ['phone', 'Google services (Android)'], 0xFEED: ['tracker', 'Tile tracker'],
  0xFEEC: ['tracker', 'Tile tracker'], 0xFD5A: ['tracker', 'Samsung SmartTag'],
  0xFEAA: ['other', 'Eddystone beacon'], 0xFE95: ['other', 'Xiaomi device'],
}

const WIFI_VENDOR_IES: Record<string, string> = {
  '0017f2': 'Apple', '0050f2': 'Microsoft/WPS', '506f9a': 'Wi-Fi Direct',
  '001018': 'Broadcom', '8cfdf0': 'Qualcomm', '000ce7': 'MediaTek',
  '00e04c': 'Realtek', '000c43': 'Ralink',
}

const VENDOR_TYPES: Record<string, DevType> = { Garmin: 'wearable', Polar: 'wearable', Bose: 'audio' }

function appleTlvs(mdHex: string): [number, Buffer][] {
  try {
    const b = Buffer.from(mdHex, 'hex')
    if (b.length < 4 || b[0] !== 0x4c || b[1] !== 0x00) return []
    const out: [number, Buffer][] = []
    let i = 2
    while (i + 2 <= b.length) {
      out.push([b[i], b.subarray(i + 2, i + 2 + b[i + 1])])
      i += 2 + b[i + 1]
    }
    return out
  } catch { return [] }
}

function parseApple(mdHex: string): [DevType, string, string] | null {
  try {
    const b = Buffer.from(mdHex, 'hex')
    if (b.length < 4 || b[0] !== 0x4c || b[1] !== 0x00) return null
    let best: [DevType, string, string] | null = null
    const rank: Record<string, number> = { high: 2, low: 1 }
    let i = 2
    while (i + 2 <= b.length) {
      const mtype = b[i], mlen = b[i + 1], body = b.subarray(i + 2, i + 2 + mlen)
      const hit = APPLE_TYPES[mtype]
      if (hit) {
        let [t, model, conf] = hit
        if (mtype === 0x07 && body.length >= 3) {
          const audioModel = APPLE_AUDIO_MODELS[(body[1] << 8) | body[2]]
          if (audioModel) model = audioModel
        }
        if (!best || rank[conf] > rank[best[2]]) best = [t, model, conf]
      }
      i += 2 + mlen
    }
    return best
  } catch { return null }
}

function parseMsCdp(mdHex: string): [DevType, string, string] | null {
  try {
    const b = Buffer.from(mdHex, 'hex')
    if (b.length >= 4 && b[0] === 0x06 && b[1] === 0x00 && b[2] === 0x01) {
      const hit = MS_CDP_TYPES[b[3] & 0x1f]
      if (hit) return [hit[0], hit[1], 'high']
    }
    return null
  } catch { return null }
}

function byName(name: string | null | undefined): DevType | null {
  if (!name) return null
  for (const [t, rx] of NAME_RULES) if (rx.test(name)) return t
  return null
}

export function appleActivity(mdHex: string): [string, string] | null {
  for (const [t, body] of appleTlvs(mdHex)) {
    if (t === 0x10 && body.length > 0) {
      const code = body[0] >> 4
      const hit = NEARBY_ACTIONS[code]
      return hit ?? ['unknown', `Activity 0x${code.toString(16).toUpperCase()}`]
    }
  }
  return null
}

export function mergeDetails(old: Record<string, unknown>, newData: Record<string, unknown>): Record<string, unknown> {
  const out = { ...old }
  for (const [k, v] of Object.entries(newData)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue
    if (Array.isArray(v)) {
      const merged: unknown[] = [...((out[k] as unknown[]) || [])]
      for (const x of v) if (!merged.includes(x)) merged.push(x)
      out[k] = merged.slice(-20)
    } else {
      out[k] = v
    }
  }
  return out
}

export function detailsFromMsg(msg: Record<string, unknown>): Record<string, unknown> {
  const t = msg.t as string
  if (t === 'w') {
    const caps = (msg.cap as string) || ''
    const gen = caps.includes('he') ? 'WiFi 6' : caps.includes('vht') ? 'WiFi 5' : caps.includes('ht') ? 'WiFi 4' : null
    return {
      ssids: ((msg.ss as string[]) || []).filter(Boolean),
      wifi_gen: gen,
      vendor_ies: ((msg.vo as string) || '').split(',').filter(Boolean).map(o => WIFI_VENDOR_IES[o] || o),
      wps_name: ((msg.wn as string) || '').trim(),
      wps_model: ((msg.wm as string) || '').trim(),
      connected: msg.c ? true : null,
      bssid: msg.bss || null,
      probing: msg.fp ? true : null,
      channel: msg.ch || null,
    }
  }
  if (t === 'a') return { ssid: msg.ssid || null, channel: msg.ch || null }
  const svc = ((msg.sv as string) || '').split(',').filter(Boolean).map(x => parseInt(x, 16))
  const act = appleActivity((msg.md as string) || '')
  return {
    activity: act ? act[0] : null,
    activity_label: act ? act[1] : null,
    md: msg.md || null,
    services: svc.map(s => s.toString(16).padStart(4, '0').toUpperCase()),
    appearance: msg.ap || null,
    tx_power: msg.tx ?? null,
    addr_type: msg.at === 1 ? 'random' : 'public',
  }
}

export function classify(
  kind: string,
  details: Record<string, unknown>,
  name: string | null,
  vendor: string | null,
  randomized: number
): [DevType, string | null, string] {
  const d = details || {}
  if (kind === 'ap') {
    const ssid = (d.ssid as string) || ''
    if (ssid && HOTSPOT_SSID.test(ssid)) return ['phone', 'Mobile hotspot', 'low']
    return ['ap', 'Access point', 'high']
  }
  if (kind === 'ble') {
    const md = (d.md as string) || ''
    const nameT = byName(name)
    const apple = md.startsWith('4c00') ? parseApple(md) : null
    if (apple && apple[2] === 'high') return apple
    const ms = md.startsWith('0600') ? parseMsCdp(md) : null
    if (ms) return ms
    if (nameT && name) return [nameT, name, 'high']
    const ap = d.appearance as number | undefined
    if (ap != null) {
      const hit = APPEARANCE[ap >> 6]
      if (hit) return [hit[0], hit[1], 'high']
    }
    for (const s of (d.services as string[]) || []) {
      const hit = SERVICES[parseInt(s, 16)]
      if (hit) return [hit[0], hit[1], 'low']
    }
    if (apple) return apple
    if (vendor && VENDOR_TYPES[vendor]) return [VENDOR_TYPES[vendor], `${vendor} device`, 'low']
    if (vendor && !vendor.startsWith('BLE 0x')) return ['other', `${vendor} device`, 'low']
    return ['other', null, 'low']
  }
  // WiFi
  const wps = [d.wps_name, d.wps_model].filter(Boolean).join(' ')
  const t = byName(wps) || byName(name)
  if (t) return [t, (d.wps_model as string) || null, 'high']
  const vis = (d.vendor_ies as string[]) || []
  if (vis.includes('Apple')) return ['phone', 'Apple device', 'low']
  if (vendor && /espressif|tuya|shelly|sonoff|raspberry/i.test(vendor)) return ['other', `${vendor} IoT device`, 'high']
  if (randomized) return ['phone', 'Mobile device (random MAC)', 'low']
  if (vendor) return ['other', `${vendor} device`, 'low']
  return ['other', null, 'low']
}

export function displayName(kind: string, details: Record<string, unknown>, bleName?: string | null): string | null {
  if (kind === 'ble') return bleName || null
  if (kind === 'ap') return (details.ssid as string) || '(hidden network)'
  return (details.wps_name as string) || null
}

export function distanceM(rssi: number | null, kind: string, details: Record<string, unknown>, s: Settings): number | null {
  if (rssi == null) return null
  const ref = kind === 'ble' ? s.rssi_1m_ble : s.rssi_1m_wifi
  const tx = details?.tx_power as number | undefined
  const refAdj = kind === 'ble' && tx != null && tx >= -30 && tx <= 20 ? tx - 41 : ref
  const n = Math.max(s.path_loss_n, 1.5)
  return Math.round(Math.min(Math.max(10 ** ((refAdj - rssi) / (10 * n)), 0.3), 300) * 10) / 10
}
