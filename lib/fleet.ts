import { prisma } from './prisma'
import { getSettings } from './settings'
import { getExcluded, getVisits } from './analytics'

const ONLINE_S = 90          // firmware posts every ~5 s; allow a few missed posts
const STALE_S = 15 * 60      // after this a sensor counts as offline
const LOW_HEAP = 40 * 1024
const MAX_TABLE = 160        // firmware MAX_DEVICES

export type SensorStatus = 'online' | 'stale' | 'offline' | 'pending'
type Severity = 'critical' | 'warning' | 'info'

export function sensorStatus(lastSeen: number | null, now = Date.now() / 1000): SensorStatus {
  if (lastSeen == null) return 'pending'
  const age = now - lastSeen
  return age <= ONLINE_S ? 'online' : age <= STALE_S ? 'stale' : 'offline'
}

const ago = (s: number) => s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min`
  : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`

// Compare "billboard-cloud/1.10" > "billboard-cloud/1.9"
const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0

export async function fleet() {
  const s = await getSettings()
  const now = Date.now() / 1000
  const [sensors, excl] = await Promise.all([
    prisma.sensors.findMany({ orderBy: { created_at: 'asc' } }),
    getExcluded(s),
  ])
  const dpp = Math.max(s.devices_per_person, 0.1)
  const day0 = now - 86400
  const h0 = Math.floor(now / 3600) * 3600 - 23 * 3600
  const visits = (await getVisits(s, now - 2 * 86400, now, excl)) as any[]

  const nowMin = Math.floor(now / 60)
  const recent = await prisma.minute_stats.findMany({
    where: { minute: { gte: nowMin - 1 }, max_rssi: { gte: s.passer_rssi } },
    select: { device_id: true, sensor_id: true, max_rssi: true },
  })

  const latestFw = sensors.reduce<string | null>((a, x) => (x.fw && (!a || newer(x.fw, a)) ? x.fw : a), null)

  // Audience stats for one sensor (or the whole fleet when sensorId is undefined)
  function stats(sensorId?: string) {
    const mine = sensorId === undefined ? visits : visits.filter(v => v.sensor_id === sensorId)
    const cur = mine.filter(v => v.start >= day0), prev = mine.filter(v => v.start < day0)
    const people = (vs: any[]) => Math.round(new Set(vs.map(v => v.identity)).size / dpp)
    const impressions = cur.filter(v => v.viewer && v.dwell >= s.min_dwell_s)
    const spark = Array.from({ length: 24 }, () => new Set<string>())
    for (const v of cur) {
      const i = Math.floor((v.start - h0) / 3600)
      if (i >= 0 && i < 24) spark[i].add(v.identity)
    }
    const near = recent.filter(r => (sensorId === undefined || r.sensor_id === sensorId) && !excl.has(r.device_id))
    const nearDevs = new Set(near.map(r => r.device_id))
    const nearViewers = new Set(near.filter(r => r.max_rssi >= s.viewer_rssi).map(r => r.device_id))
    return {
      people_24h: people(cur),
      people_prev_24h: people(prev),
      viewers_24h: Math.round(new Set(cur.filter(v => v.viewer).map(v => v.identity)).size / dpp),
      impressions_24h: impressions.length,
      avg_dwell: impressions.length ? Math.round(impressions.reduce((a, v) => a + v.dwell, 0) / impressions.length) : 0,
      visits_24h: cur.length,
      devices_now: nearDevs.size,
      people_now: Math.round(nearDevs.size / dpp * 10) / 10,
      viewers_now: nearViewers.size,
      spark: spark.map(x => Math.round(x.size / dpp * 10) / 10),
    }
  }

  const out = sensors.map(({ api_key: _k, ...x }) => {
    const status = sensorStatus(x.last_seen, now)
    const st = stats(x.id)
    const issues: { severity: Severity; text: string }[] = []
    const age = x.last_seen != null ? now - x.last_seen : null
    if (status === 'pending') issues.push({ severity: 'info', text: 'Waiting for first check-in. Flash config.h to the ESP32 and power it on.' })
    if (status === 'offline' && age != null) issues.push({ severity: 'critical', text: `Offline for ${ago(age)}. Check power and WiFi at the site.` })
    if (status === 'stale' && age != null) issues.push({ severity: 'warning', text: `No check-in for ${ago(age)}.` })
    if (status !== 'pending' && status !== 'offline') {
      if (x.heap != null && x.heap < LOW_HEAP) issues.push({ severity: 'warning', text: `Low memory: ${Math.round(x.heap / 1024)} KB free.` })
      if (x.dropped) issues.push({ severity: 'warning', text: `Device table full (${MAX_TABLE}); ${x.dropped} sightings dropped last cycle.` })
      if (x.booted_at != null && now - x.booted_at < 3600 && x.reboots > 0)
        issues.push({ severity: 'info', text: `Restarted ${ago(now - x.booted_at)} ago.` })
      if (status === 'online' && st.visits_24h === 0 && (x.cycles ?? 0) > 100)
        issues.push({ severity: 'warning', text: 'Online but hasn’t counted anyone in 24 h. Check placement and thresholds.' })
    }
    if (x.fw && latestFw && x.fw !== latestFw) issues.push({ severity: 'info', text: `Firmware ${x.fw} is behind ${latestFw}.` })
    return { ...x, status, age, table_pct: x.dev_count != null ? Math.round(100 * x.dev_count / MAX_TABLE) : null, issues, ...st }
  })

  const total = stats()
  return {
    now,
    sensors: out,
    totals: {
      ...total,
      sensors: out.length,
      online: out.filter(x => x.status === 'online').length,
      stale: out.filter(x => x.status === 'stale').length,
      offline: out.filter(x => x.status === 'offline').length,
      pending: out.filter(x => x.status === 'pending').length,
      issues: out.reduce((a, x) => a + x.issues.filter(i => i.severity !== 'info').length, 0),
    },
    latest_fw: latestFw,
  }
}
