import { createHmac } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { getSettings, Settings } from './settings'
import { classify, mergeDetails, detailsFromMsg, displayName } from './classify'
import { deviceVendor, mdCompany, normMac } from './vendors'

// ---------------------------------------------------------------------------
// Device IDs: a salted hash of the MAC, so raw MAC addresses are never the key
// ---------------------------------------------------------------------------

let warnedSalt = false

function getHmacSalt(): Buffer {
  const configured = process.env.HMAC_SALT
  if (configured) return Buffer.from(configured, 'hex')

  if (process.env.NODE_ENV === 'production' && !warnedSalt) {
    warnedSalt = true
    console.warn('HMAC_SALT is not set; deriving the MAC-hash salt from DATABASE_URL. Set HMAC_SALT (and keep it stable).')
  }
  // Derive a stable salt from DATABASE_URL so device IDs stay consistent across deploys
  const url = process.env.DATABASE_URL || 'billboard-default-salt'
  return createHmac('sha256', 'billboard-salt-v1').update(url).digest()
}

export function deviceId(kind: string, mac: string): string {
  return createHmac('sha256', getHmacSalt()).update(`${kind}|${mac.toLowerCase()}`).digest('hex').slice(0, 12)
}

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

/** A visit that is still "open": the device was seen again within visit_gap_s of its last sighting. */
interface OpenVisit {
  id: bigint | null // null = created in this batch, not inserted yet
  dev?: string
  start?: number
  dirty?: boolean // changed in this batch, needs an UPDATE
  end: number
  maxRssi: number
  samples: number
  phoneIdle: number
  phoneUse: number
}

/** Everything we will write to the database at the end of the batch. */
interface Pending {
  devices: Map<string, Prisma.Sql>
  minutes: Map<string, { minute: number; dev: string; rssi: number; hits: number; sensor: string }>
  visits: OpenVisit[]
}

type Message = Record<string, unknown>
type DeviceKind = 'wifi' | 'ble' | 'ap'

/** Message types from the ESP32: w = WiFi probe, b = BLE advertisement, a = access point beacon. */
const KIND_BY_MESSAGE_TYPE: Record<string, DeviceKind> = { w: 'wifi', b: 'ble', a: 'ap' }

/** Ignore anything weaker than this; it's too far away to be meaningful. */
const MIN_RSSI = -95

// ---------------------------------------------------------------------------
// Processing a batch of messages from one sensor
// ---------------------------------------------------------------------------

export async function processBatch(
  msgs: Message[], ts: number, sensorId: string, prevUptime: number | null = null,
) {
  const sightings = msgs.filter(msg => (msg.t as string) in KIND_BY_MESSAGE_TYPE)

  // Collect every device in the batch up front so we query the database once, not once per message
  const ids = [...new Set(
    sightings.filter(msg => msg.m).map(msg => deviceId(KIND_BY_MESSAGE_TYPE[msg.t as string], msg.m as string)),
  )]

  const [s, deviceRows] = await Promise.all([
    getSettings(), // cached
    ids.length ? prisma.devices.findMany({ where: { id: { in: ids } } }) : Promise.resolve([]),
  ])
  const existingDevices = new Map<string, Record<string, unknown>>()
  for (const row of deviceRows) existingDevices.set(row.id, row as unknown as Record<string, unknown>)

  const openVisits = await loadOpenVisits(ids, ts, s.visit_gap_s)

  // Process every message in memory...
  const pending: Pending = { devices: new Map(), minutes: new Map(), visits: [] }
  for (const msg of sightings) handleSighting(msg, ts, sensorId, s, existingDevices, openVisits, pending)
  for (const visit of openVisits.values()) {
    if (visit.id !== null && visit.dirty) pending.visits.push(visit)
  }

  // ...then write once per table, all in parallel
  await Promise.all([
    flushDevices(pending),
    flushMinutes(pending),
    flushNewVisits(pending, sensorId),
    flushVisitUpdates(pending),
    prisma.sensors.update({
      where: { id: sensorId },
      data: sensorHealth(ts, lastOfType(msgs, 'hb'), lastOfType(msgs, 'hello'), prevUptime),
    }),
  ])
}

function lastOfType(msgs: Message[], type: string): Message | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].t === type) return msgs[i]
  }
  return null
}

/** The most recent still-open visit for each device. */
async function loadOpenVisits(deviceIds: string[], ts: number, visitGapS: number) {
  const openVisits = new Map<string, OpenVisit>()
  if (!deviceIds.length) return openVisits

  const rows = await prisma.visits.findMany({
    where: { device_id: { in: deviceIds }, end: { gte: ts - visitGapS } },
    orderBy: { end: 'desc' },
  })
  for (const v of rows) {
    if (openVisits.has(v.device_id)) continue // keep only the latest per device
    openVisits.set(v.device_id, {
      id: v.id, end: v.end, maxRssi: v.max_rssi,
      samples: v.samples, phoneIdle: v.phone_idle, phoneUse: v.phone_use,
    })
  }
  return openVisits
}

// ---------------------------------------------------------------------------
// Handling one sighting
// ---------------------------------------------------------------------------

/** Is this MAC address randomized (i.e. not a stable hardware identity)? 1 = yes, 0 = no. */
function isRandomized(msg: Message, kind: DeviceKind, mac: string): number {
  const firstByte = parseInt(mac.slice(0, 2), 16)
  if (kind === 'wifi') return parseInt(String(msg.rnd ?? 0))
  if (kind === 'ap') return firstByte & 0x02 ? 1 : 0 // "locally administered" bit

  // BLE: random address type, unless it's a static random address (top two bits = 11)
  const isRandomAddressType = parseInt(String(msg.at ?? 0)) === 1
  const isStaticRandom = firstByte >> 6 === 0b11
  return isRandomAddressType && !isStaticRandom ? 1 : 0
}

/** Work out what kind of device this is, without downgrading an earlier high-confidence answer. */
function classifyDevice(
  kind: DeviceKind, details: Record<string, unknown>, name: string | null,
  vendor: string | null, randomized: number, existing: Record<string, unknown> | undefined,
): [string, string | null, string] {
  const [type, model, confidence] = classify(kind, details, name, vendor, randomized)
  if (existing?.confidence === 'high' && confidence === 'low') {
    return [existing.dev_type as string, existing.model as string, 'high']
  }
  return [type, model, confidence]
}

/** Add this sighting to the per-minute stats (used for fixture detection and the live chart). */
function recordMinute(pending: Pending, ts: number, dev: string, rssi: number, hits: number, sensorId: string) {
  const minute = Math.floor(ts / 60)
  const key = `${minute}|${dev}`
  const existing = pending.minutes.get(key)
  if (existing) {
    existing.rssi = Math.max(existing.rssi, rssi)
    existing.hits += hits
  } else {
    pending.minutes.set(key, { minute, dev, rssi, hits, sensor: sensorId })
  }
}

/** Extend the device's open visit, or start a new one if there isn't one. */
function recordVisit(
  pending: Pending, openVisits: Map<string, OpenVisit>, visitGapS: number,
  dev: string, ts: number, rssi: number, activity: unknown,
) {
  const phoneIdle = activity === 'idle' ? 1 : 0
  const phoneUse = activity === 'in_use' ? 1 : 0
  const open = openVisits.get(dev)

  if (open && ts - open.end <= visitGapS) {
    open.end = ts
    open.maxRssi = Math.max(open.maxRssi, rssi)
    open.samples++
    open.phoneIdle += phoneIdle
    open.phoneUse += phoneUse
    open.dirty = true
    return
  }

  const visit: OpenVisit = { id: null, dev, start: ts, end: ts, maxRssi: rssi, samples: 1, phoneIdle, phoneUse }
  pending.visits.push(visit)
  openVisits.set(dev, visit)
}

function handleSighting(
  msg: Message,
  ts: number,
  sensorId: string,
  s: Settings,
  existingDevices: Map<string, Record<string, unknown>>,
  openVisits: Map<string, OpenVisit>,
  pending: Pending,
) {
  const rssi = parseInt(String(msg.r ?? -127))
  const mac = msg.m as string
  if (rssi < MIN_RSSI || !mac) return

  const kind = KIND_BY_MESSAGE_TYPE[msg.t as string]
  const hits = parseInt(String(msg.n ?? 1))
  const randomized = isRandomized(msg, kind, mac)
  const fingerprint = kind === 'wifi' ? ((msg.fp as string) || null) : null

  // Identify the device and what we already know about it
  const dev = deviceId(kind, mac)
  const existing = existingDevices.get(dev)
  const mfrCode = msg.mfr != null && Number(msg.mfr) >= 0 ? Number(msg.mfr) : mdCompany(msg.md as string)
  const vendor = deviceVendor(kind, mac, randomized, mfrCode)

  const previousDetails = existing?.details ? JSON.parse(existing.details as string) : {}
  const details = mergeDetails(previousDetails, detailsFromMsg(msg))
  const bleName = kind === 'ble' ? ((msg.name as string) || (existing?.name as string) || null) : null
  const name = displayName(kind, details, bleName)
  const [type, model, confidence] = classifyDevice(kind, details, name, vendor, randomized, existing)

  const firstSeen = existing ? (existing.first_seen as number) : ts
  const detailsJson = JSON.stringify(details)

  pending.devices.set(dev, Prisma.join([
    txt(dev), txt(kind), Prisma.sql`${randomized}::int`, txt(normMac(mac)),
    txt(vendor), txt(fingerprint), txt(name), f8(firstSeen), f8(ts), Prisma.sql`${rssi}::int`,
    txt(type), txt(model), txt(confidence), txt(detailsJson), txt(sensorId),
  ]))
  // Remember the new state so later messages in this batch see it
  existingDevices.set(dev, {
    ...existing, id: dev, kind, randomized, first_seen: firstSeen,
    details: detailsJson, confidence, dev_type: type, model, name,
  })

  // Access points are tracked as devices only; they don't have visits
  if (kind === 'ap') return
  recordMinute(pending, ts, dev, rssi, hits, sensorId)
  recordVisit(pending, openVisits, s.visit_gap_s, dev, ts, rssi, details.activity)
}

// ---------------------------------------------------------------------------
// Writing to the database (one statement per table)
// ---------------------------------------------------------------------------

const f8 = (n: number) => Prisma.sql`${n}::float8`
const txt = (v: string | null | undefined) => Prisma.sql`${v ?? null}::text`

async function flushDevices(p: Pending) {
  if (!p.devices.size) return
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO devices (id, kind, randomized, mac, vendor, fp, name, first_seen, last_seen, last_rssi, dev_type, model, confidence, details, sensor_id)
    VALUES ${Prisma.join([...p.devices.values()].map(r => Prisma.sql`(${r})`))}
    ON CONFLICT (id) DO UPDATE SET
      last_seen = EXCLUDED.last_seen, last_rssi = EXCLUDED.last_rssi, mac = EXCLUDED.mac,
      vendor = COALESCE(EXCLUDED.vendor, devices.vendor), fp = COALESCE(EXCLUDED.fp, devices.fp),
      name = COALESCE(EXCLUDED.name, devices.name), dev_type = EXCLUDED.dev_type, model = EXCLUDED.model,
      confidence = EXCLUDED.confidence, details = EXCLUDED.details`)
}

async function flushMinutes(p: Pending) {
  if (!p.minutes.size) return
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO minute_stats (minute, device_id, max_rssi, hits, sensor_id)
    VALUES ${Prisma.join([...p.minutes.values()].map(m => Prisma.sql`(${m.minute}::bigint, ${m.dev}::text, ${m.rssi}::int, ${m.hits}::int, ${m.sensor}::text)`))}
    ON CONFLICT (minute, device_id) DO UPDATE SET
      max_rssi = GREATEST(minute_stats.max_rssi, EXCLUDED.max_rssi),
      hits = minute_stats.hits + EXCLUDED.hits`)
}

async function flushNewVisits(p: Pending, sensorId: string) {
  const rows = p.visits.filter(v => v.id === null)
  if (!rows.length) return
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO visits (device_id, start, "end", max_rssi, samples, phone_idle, phone_use, sensor_id)
    VALUES ${Prisma.join(rows.map(v => Prisma.sql`(${v.dev}::text, ${f8(v.start!)}, ${f8(v.end)}, ${v.maxRssi}::int, ${v.samples}::int, ${v.phoneIdle}::int, ${v.phoneUse}::int, ${sensorId}::text)`))}`)
}

async function flushVisitUpdates(p: Pending) {
  const rows = p.visits.filter(v => v.id !== null)
  if (!rows.length) return
  await prisma.$executeRaw(Prisma.sql`
    UPDATE visits SET "end" = v.e, max_rssi = v.r, samples = v.n, phone_idle = v.i, phone_use = v.u
    FROM (VALUES ${Prisma.join(rows.map(v => Prisma.sql`(${v.id}::bigint, ${f8(v.end)}, ${v.maxRssi}::int, ${v.samples}::int, ${v.phoneIdle}::int, ${v.phoneUse}::int)`))}) AS v(id, e, r, n, i, u)
    WHERE visits.id = v.id`)
}

// ---------------------------------------------------------------------------
// Sensor health
// ---------------------------------------------------------------------------

// Sensor last_seen plus health telemetry from the batch's heartbeat / boot message
function sensorHealth(ts: number, hb: Message | null, hello: Message | null, prevUptime: number | null) {
  const data: Record<string, unknown> = { last_seen: ts }
  const toInt = (v: unknown) => (v == null || isNaN(Number(v)) ? undefined : Math.round(Number(v)))

  if (hello) {
    data.fw = (hello.fw as string) || undefined
    data.chip = (hello.chip as string) || undefined
    data.mac = (hello.mac as string) || undefined
  }

  if (hb) {
    const uptime = toInt(hb.up)
    // Uptime going backwards means the ESP32 restarted since the last heartbeat
    const rebooted = hello || (uptime != null && prevUptime != null && uptime < prevUptime)
    Object.assign(data, {
      fw: (hb.fw as string) || data.fw, chip: (hb.chip as string) || data.chip,
      uptime, heap: toInt(hb.heap), cycles: toInt(hb.cyc), dev_count: toInt(hb.dev), dropped: toInt(hb.drop),
      last_hb: ts,
      ...(uptime != null ? { booted_at: ts - uptime } : {}),
      ...(rebooted && prevUptime != null ? { reboots: { increment: 1 } } : {}),
    })
  } else if (hello) {
    data.booted_at = ts
  }
  return data
}
