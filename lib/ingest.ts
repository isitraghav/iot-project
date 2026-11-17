import { createHmac } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { getSettings } from './settings'
import { classify, mergeDetails, detailsFromMsg, displayName } from './classify'
import { deviceVendor, mdCompany, normMac } from './vendors'

let warnedSalt = false
function getHmacSalt(): Buffer {
  const s = process.env.HMAC_SALT
  if (s) return Buffer.from(s, 'hex')
  if (process.env.NODE_ENV === 'production' && !warnedSalt) {
    warnedSalt = true
    console.warn('HMAC_SALT is not set; deriving the MAC-hash salt from DATABASE_URL. Set HMAC_SALT (and keep it stable).')
  }
  // Derive a stable salt from DATABASE_URL so device IDs stay consistent across deploys
  const url = process.env.DATABASE_URL || 'billboard-default-salt'
  return createHmac('sha256', 'billboard-salt-v1').update(url).digest()
}

export function deviceId(kind: string, mac: string): string {
  const salt = getHmacSalt()
  return createHmac('sha256', salt).update(`${kind}|${mac.toLowerCase()}`).digest('hex').slice(0, 12)
}

interface OpenVisit {
  id: bigint | null // null = created in this batch, not inserted yet
  dev?: string
  start?: number
  dirty?: boolean
  end: number
  maxRssi: number
  samples: number
  phoneIdle: number
  phoneUse: number
}

interface Pending {
  devices: Map<string, Prisma.Sql>
  minutes: Map<string, { minute: number; dev: string; rssi: number; hits: number; sensor: string }>
  visits: OpenVisit[]
}

export async function processBatch(
  msgs: Record<string, unknown>[], ts: number, sensorId: string, prevUptime: number | null = null,
) {
  // Collect device IDs we'll need
  const deviceIds = new Set<string>()
  for (const msg of msgs) {
    const t = msg.t as string
    if (t === 'w' || t === 'b' || t === 'a') {
      const mac = msg.m as string
      if (!mac) continue
      const kind = t === 'w' ? 'wifi' : t === 'a' ? 'ap' : 'ble'
      deviceIds.add(deviceId(kind, mac))
    }
  }
  const ids = [...deviceIds]

  // Settings (cached) and existing devices load in parallel
  const [s, devRows] = await Promise.all([
    getSettings(),
    ids.length ? prisma.devices.findMany({ where: { id: { in: ids } } }) : Promise.resolve([]),
  ])
  const existingDevices = new Map<string, Record<string, unknown>>()
  for (const r of devRows) existingDevices.set(r.id, r as unknown as Record<string, unknown>)

  // Load open visits
  const openVisits = new Map<string, OpenVisit>()
  if (ids.length) {
    const vRows = await prisma.visits.findMany({
      where: { device_id: { in: ids }, end: { gte: ts - s.visit_gap_s } },
      orderBy: { end: 'desc' },
    })
    for (const v of vRows) {
      if (!openVisits.has(v.device_id)) {
        openVisits.set(v.device_id, {
          id: v.id, end: v.end, maxRssi: v.max_rssi,
          samples: v.samples, phoneIdle: v.phone_idle, phoneUse: v.phone_use,
        })
      }
    }
  }

  // Process each message in memory
  const pending: Pending = { devices: new Map(), minutes: new Map(), visits: [] }
  let hb: Record<string, unknown> | null = null
  let hello: Record<string, unknown> | null = null
  for (const msg of msgs) {
    const t = msg.t as string
    if (t === 'w' || t === 'b' || t === 'a') handleSighting(msg, ts, sensorId, s, existingDevices, openVisits, pending)
    else if (t === 'hb') hb = msg
    else if (t === 'hello') hello = msg
  }
  for (const ov of openVisits.values()) if (ov.id !== null && ov.dirty) pending.visits.push(ov)

  // Flush: one statement per table, all in parallel
  await Promise.all([
    flushDevices(pending),
    flushMinutes(pending),
    flushNewVisits(pending, sensorId),
    flushVisitUpdates(pending),
    prisma.sensors.update({ where: { id: sensorId }, data: sensorHealth(ts, hb, hello, prevUptime) }),
  ])
}

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

// Sensor last_seen plus health telemetry from the batch's heartbeat / boot message
function sensorHealth(ts: number, hb: Record<string, unknown> | null, hello: Record<string, unknown> | null, prevUptime: number | null) {
  const data: Record<string, unknown> = { last_seen: ts }
  const int = (v: unknown) => (v == null || isNaN(Number(v)) ? undefined : Math.round(Number(v)))
  if (hello) {
    data.fw = (hello.fw as string) || undefined
    data.chip = (hello.chip as string) || undefined
    data.mac = (hello.mac as string) || undefined
  }
  if (hb) {
    const up = int(hb.up)
    // Uptime going backwards means the ESP32 restarted since the last heartbeat
    const rebooted = hello || (up != null && prevUptime != null && up < prevUptime)
    Object.assign(data, {
      fw: (hb.fw as string) || data.fw, chip: (hb.chip as string) || data.chip,
      uptime: up, heap: int(hb.heap), cycles: int(hb.cyc), dev_count: int(hb.dev), dropped: int(hb.drop),
      last_hb: ts,
      ...(up != null ? { booted_at: ts - up } : {}),
      ...(rebooted && prevUptime != null ? { reboots: { increment: 1 } } : {}),
    })
  } else if (hello && !hb) {
    data.booted_at = ts
  }
  return data
}

function handleSighting(
  msg: Record<string, unknown>,
  ts: number,
  sensorId: string,
  s: ReturnType<typeof getSettings> extends Promise<infer T> ? T : never,
  existingDevices: Map<string, Record<string, unknown>>,
  openVisits: Map<string, OpenVisit>,
  pending: Pending,
) {
  const rssi = parseInt(String(msg.r ?? -127))
  if (rssi < -95) return

  const t = msg.t as string
  const mac = msg.m as string
  if (!mac) return
  const hits = parseInt(String(msg.n ?? 1))
  const kind = t === 'w' ? 'wifi' : t === 'a' ? 'ap' : 'ble'

  let randomized = 0
  let fp: string | null = null

  if (t === 'w') {
    randomized = parseInt(String(msg.rnd ?? 0))
    fp = (msg.fp as string) || null
  } else if (t === 'a') {
    randomized = (parseInt(mac.slice(0, 2), 16) & 0x02) ? 1 : 0
  } else {
    const first = parseInt(mac.slice(0, 2), 16)
    randomized = (parseInt(String(msg.at ?? 0)) === 1 && (first >> 6) !== 0b11) ? 1 : 0
  }

  const dev = deviceId(kind, mac)
  const macAddr = normMac(mac)
  const mfr = msg.mfr != null && Number(msg.mfr) >= 0 ? Number(msg.mfr) : mdCompany(msg.md as string)
  const vendor = deviceVendor(kind, mac, randomized, mfr)
  const existing = existingDevices.get(dev)
  const prevDetails = existing?.details ? JSON.parse(existing.details as string) : {}
  const newDetails = detailsFromMsg(msg)
  const details = mergeDetails(prevDetails, newDetails)
  const bleName = t === 'b' ? ((msg.name as string) || (existing?.name as string) || null) : null
  const name = displayName(kind, details, bleName)
  const [devType, model, conf] = classify(kind, details, name, vendor, randomized)
  const prevConf = existing?.confidence as string
  const [finalType, finalModel, finalConf] =
    prevConf === 'high' && conf === 'low'
      ? [existing?.dev_type as string, existing?.model as string, 'high']
      : [devType, model, conf]
  const detailsJson = JSON.stringify(details)

  pending.devices.set(dev, Prisma.join([
    txt(dev), txt(kind), Prisma.sql`${randomized}::int`, txt(macAddr),
    txt(vendor), txt(fp), txt(name), f8(existing ? (existing.first_seen as number) : ts), f8(ts), Prisma.sql`${rssi}::int`,
    txt(finalType), txt(finalModel), txt(finalConf), txt(detailsJson), txt(sensorId),
  ]))
  existingDevices.set(dev, { ...(existing ?? {}), id: dev, kind, randomized, first_seen: existing ? existing.first_seen : ts, details: detailsJson, confidence: finalConf, dev_type: finalType, model: finalModel, name })

  if (kind !== 'ap') {
    const minute = Math.floor(ts / 60)
    const mk = `${minute}|${dev}`
    const pm = pending.minutes.get(mk)
    if (pm) { pm.rssi = Math.max(pm.rssi, rssi); pm.hits += hits }
    else pending.minutes.set(mk, { minute, dev, rssi, hits, sensor: sensorId })

    const act = details.activity as string | undefined
    const idle = act === 'idle' ? 1 : 0
    const use = act === 'in_use' ? 1 : 0
    const ov = openVisits.get(dev)

    if (ov && ts - ov.end <= s.visit_gap_s) {
      ov.end = ts
      ov.maxRssi = Math.max(ov.maxRssi, rssi)
      ov.samples++
      ov.phoneIdle += idle
      ov.phoneUse += use
      ov.dirty = true
    } else {
      const nv: OpenVisit = { id: null, dev, start: ts, end: ts, maxRssi: rssi, samples: 1, phoneIdle: idle, phoneUse: use }
      pending.visits.push(nv)
      openVisits.set(dev, nv)
    }
  }
}
