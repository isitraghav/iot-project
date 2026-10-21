import { createHmac } from 'crypto'
import { prisma } from './prisma'
import { getSettings } from './settings'
import { classify, mergeDetails, detailsFromMsg, displayName } from './classify'
import { deviceVendor, mdCompany, normMac } from './vendors'

function getHmacSalt(): Buffer {
  const s = process.env.HMAC_SALT
  if (s) return Buffer.from(s, 'hex')
  // Derive a stable salt from DATABASE_URL so device IDs stay consistent across deploys
  const url = process.env.DATABASE_URL || 'billboard-default-salt'
  return createHmac('sha256', 'billboard-salt-v1').update(url).digest()
}

export function deviceId(kind: string, mac: string): string {
  const salt = getHmacSalt()
  return createHmac('sha256', salt).update(`${kind}|${mac.toLowerCase()}`).digest('hex').slice(0, 12)
}

interface OpenVisit {
  id: bigint
  end: number
  maxRssi: number
  samples: number
  phoneIdle: number
  phoneUse: number
}

export async function processBatch(msgs: Record<string, unknown>[], ts: number, sensorId: string) {
  const s = await getSettings()

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

  // Load existing devices
  const existingDevices = new Map<string, Record<string, unknown>>()
  if (deviceIds.size > 0) {
    const ids = [...deviceIds]
    const devRows = await prisma.devices.findMany({ where: { id: { in: ids } } })
    for (const r of devRows) existingDevices.set(r.id, r as unknown as Record<string, unknown>)
  }

  // Load open visits
  const minEnd = ts - s.visit_gap_s
  const openVisits = new Map<string, OpenVisit>()
  if (deviceIds.size > 0) {
    const ids = [...deviceIds]
    const vRows = await prisma.visits.findMany({
      where: { device_id: { in: ids }, end: { gte: minEnd } },
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

  // Process each message
  const deviceUpdates: Promise<unknown>[] = []
  const minuteUpdates: Promise<unknown>[] = []
  const visitUpdates: Promise<unknown>[] = []
  let hb: Record<string, unknown> | null = null
  let hello: Record<string, unknown> | null = null

  for (const msg of msgs) {
    const t = msg.t as string
    if (t === 'w' || t === 'b' || t === 'a') {
      await handleSighting(msg, ts, sensorId, s, existingDevices, openVisits, deviceUpdates, minuteUpdates, visitUpdates)
    } else if (t === 'hb') hb = msg
    else if (t === 'hello') hello = msg
  }

  await Promise.all([...deviceUpdates, ...minuteUpdates, ...visitUpdates])

  await prisma.sensors.update({ where: { id: sensorId }, data: await sensorHealth(sensorId, ts, hb, hello) })
}

// Sensor last_seen plus health telemetry from the batch's heartbeat / boot message
async function sensorHealth(sensorId: string, ts: number, hb: Record<string, unknown> | null, hello: Record<string, unknown> | null) {
  const data: Record<string, unknown> = { last_seen: ts }
  const int = (v: unknown) => (v == null || isNaN(Number(v)) ? undefined : Math.round(Number(v)))
  if (hello) {
    data.fw = (hello.fw as string) || undefined
    data.chip = (hello.chip as string) || undefined
    data.mac = (hello.mac as string) || undefined
  }
  if (hb) {
    const prev = await prisma.sensors.findUnique({ where: { id: sensorId }, select: { uptime: true } })
    const up = int(hb.up)
    // Uptime going backwards means the ESP32 restarted since the last heartbeat
    const rebooted = hello || (up != null && prev?.uptime != null && up < prev.uptime)
    Object.assign(data, {
      fw: (hb.fw as string) || data.fw, chip: (hb.chip as string) || data.chip,
      uptime: up, heap: int(hb.heap), cycles: int(hb.cyc), dev_count: int(hb.dev), dropped: int(hb.drop),
      last_hb: ts,
      ...(up != null ? { booted_at: ts - up } : {}),
      ...(rebooted && prev?.uptime != null ? { reboots: { increment: 1 } } : {}),
    })
  } else if (hello && !hb) {
    data.booted_at = ts
  }
  return data
}

async function handleSighting(
  msg: Record<string, unknown>,
  ts: number,
  sensorId: string,
  s: ReturnType<typeof getSettings> extends Promise<infer T> ? T : never,
  existingDevices: Map<string, Record<string, unknown>>,
  openVisits: Map<string, OpenVisit>,
  deviceUpdates: Promise<unknown>[],
  minuteUpdates: Promise<unknown>[],
  visitUpdates: Promise<unknown>[]
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

  if (existing) {
    deviceUpdates.push(
      prisma.devices.update({
        where: { id: dev },
        data: { last_seen: ts, last_rssi: rssi, mac: macAddr, vendor: vendor ?? undefined, fp: fp ?? undefined, name: name ?? undefined, dev_type: finalType, model: finalModel, confidence: finalConf, details: detailsJson },
      })
    )
  } else {
    deviceUpdates.push(
      prisma.devices.upsert({
        where: { id: dev },
        create: { id: dev, kind, randomized, mac: macAddr, vendor, fp, name, first_seen: ts, last_seen: ts, last_rssi: rssi, dev_type: finalType, model: finalModel, confidence: finalConf, details: detailsJson, sensor_id: sensorId },
        update: { last_seen: ts, last_rssi: rssi, mac: macAddr, vendor: vendor ?? undefined, dev_type: finalType, model: finalModel, confidence: finalConf, details: detailsJson },
      })
    )
    existingDevices.set(dev, { id: dev, kind, randomized, details: detailsJson, confidence: finalConf, dev_type: finalType, model: finalModel, name })
  }

  if (kind !== 'ap') {
    const minute = Math.floor(ts / 60)
    minuteUpdates.push(
      prisma.$executeRawUnsafe(`
        INSERT INTO minute_stats(minute, device_id, max_rssi, hits, sensor_id)
        VALUES (${minute}, '${dev}', ${rssi}, ${hits}, '${sensorId}')
        ON CONFLICT(minute, device_id) DO UPDATE SET
          max_rssi = GREATEST(minute_stats.max_rssi, excluded.max_rssi),
          hits = minute_stats.hits + excluded.hits
      `)
    )

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
      visitUpdates.push(
        prisma.visits.update({
          where: { id: ov.id },
          data: { end: ts, max_rssi: ov.maxRssi, samples: ov.samples, phone_idle: ov.phoneIdle, phone_use: ov.phoneUse },
        })
      )
    } else {
      const newVisit = await prisma.visits.create({
        data: { device_id: dev, start: ts, end: ts, max_rssi: rssi, samples: 1, phone_idle: idle, phone_use: use, sensor_id: sensorId },
      })
      openVisits.set(dev, { id: newVisit.id, end: ts, maxRssi: rssi, samples: 1, phoneIdle: idle, phoneUse: use })
    }
  }
}
