import { prisma } from './prisma'
import { getSettings, Settings } from './settings'
import { classify, distanceM, TYPES, TYPE_LABELS } from './classify'

const CYCLE_S = 4

const RANGES: Record<string, [number | null, number]> = {
  '1h': [3600, 300],
  'today': [null, 3600],
  '24h': [86400, 3600],
  '7d': [7 * 86400, 3 * 3600],
  '30d': [30 * 86400, 86400],
}

export function rangeBounds(name: string, now?: number): [number, number, number] {
  const n = now ?? Date.now() / 1000
  const [span, bucket] = RANGES[name] ?? RANGES['24h']
  let start: number
  if (span === null) {
    const d = new Date(n * 1000)
    d.setHours(0, 0, 0, 0)
    start = d.getTime() / 1000
  } else {
    start = n - span
  }
  return [start, n, bucket]
}

// Sensor IDs are 12 hex chars; anything else is treated as "all sensors" so it can't reach SQL
export function sensorId(raw: string | null | undefined): string | null {
  return raw && /^[a-f0-9]{6,32}$/.test(raw) ? raw : null
}
const sensorSql = (col: string, sensor: string | null) => (sensor ? ` AND ${col} = '${sensor}'` : '')

let fixtureCache = { ts: 0, ids: new Set<string>() }

async function getFixtures(s: Settings): Promise<Set<string>> {
  if (Date.now() / 1000 - fixtureCache.ts < 60) return fixtureCache.ids
  const nowMin = Math.floor(Date.now() / 1000 / 60)
  const thresh = s.fixture_minutes_6h
  const rows = await prisma.$queryRawUnsafe<{ device_id: string; mins: number; lo: number; hi: number; recent: number }[]>(`
    SELECT device_id,
           COUNT(*)::int AS mins,
           MIN(minute)::int AS lo,
           MAX(minute)::int AS hi,
           SUM(CASE WHEN minute >= ${nowMin - 360} THEN 1 ELSE 0 END)::int AS recent
    FROM minute_stats
    GROUP BY device_id
    HAVING COUNT(*) >= ${Math.min(thresh, 360)}
  `)
  const ids = new Set<string>()
  for (const r of rows) {
    const span = r.hi - r.lo + 1
    if (r.recent >= thresh || (r.mins >= 360 && r.mins / span >= 0.8)) ids.add(r.device_id)
  }
  fixtureCache = { ts: Date.now() / 1000, ids }
  return ids
}

export async function getExcluded(s: Settings): Promise<Set<string>> {
  const ignored = await prisma.devices.findMany({ where: { ignored: 1 }, select: { id: true } })
  const ids = new Set(ignored.map(r => r.id))
  if (s.auto_exclude_fixtures) {
    const fx = await getFixtures(s)
    for (const id of fx) ids.add(id)
  }
  return ids
}

export interface VisitRow {
  device_id: string; start: number; end: number; max_rssi: number
  phone_idle: number; phone_use: number; kind: string; randomized: number
  fp: string | null; label: string | null; vendor: string | null; entity_id: string | null
  stable: boolean; sensor_id: string | null
}

export async function getVisits(s: Settings, t0: number, t1: number, excl: Set<string>, sensor: string | null = null) {
  const rows = await prisma.$queryRawUnsafe<VisitRow[]>(`
    SELECT v.device_id, v.sensor_id, v.start, v.end, v.max_rssi, v.phone_idle, v.phone_use,
           d.kind, d.randomized, d.fp, d.label, d.vendor, d.entity_id,
           (d.randomized = 0 OR (d.label IS NOT NULL AND d.label != '')) AS stable
    FROM visits v JOIN devices d ON d.id = v.device_id
    WHERE v.start >= ${t0} AND v.start < ${t1} AND v.max_rssi >= ${s.passer_rssi}${sensorSql('v.sensor_id', sensor)}
  `)
  return rows
    .filter(r => !excl.has(r.device_id))
    .map(r => ({
      ...r,
      dwell: r.end - r.start + CYCLE_S,
      identity: r.entity_id
        ? r.entity_id
        : r.kind === 'wifi' && r.randomized && r.fp ? `fp:${r.fp}`
        : r.device_id,
      viewer: r.max_rssi >= s.viewer_rssi,
    }))
}

function kpis(visits: (VisitRow & { dwell: number; identity: string; viewer: boolean })[], s: Settings) {
  const devs = new Set(visits.map(v => v.device_id))
  const identities = new Set(visits.map(v => v.identity))
  const viewers = new Set(visits.filter(v => v.viewer).map(v => v.identity))
  const impressions = visits.filter(v => v.viewer && (v as any).dwell >= s.min_dwell_s)
  const dwellArr = impressions.map(v => (v as any).dwell).sort((a: number, b: number) => a - b)
  const classified = impressions.filter(v => (v.phone_idle + v.phone_use) > 0)
  const headsUp = classified.filter(v => v.phone_idle >= v.phone_use)
  return {
    unique_devices: devs.size,
    est_people: Math.round(identities.size / Math.max(s.devices_per_person, 0.1)),
    viewers: viewers.size,
    impressions: impressions.length,
    avg_dwell: dwellArr.length ? Math.round(dwellArr.reduce((a: number, b: number) => a + b, 0) / dwellArr.length * 10) / 10 : 0,
    median_dwell: dwellArr.length ? dwellArr[Math.floor(dwellArr.length / 2)] : 0,
    engagement_rate: identities.size ? Math.round(100 * viewers.size / identities.size * 10) / 10 : 0,
    heads_up_rate: classified.length ? Math.round(100 * headsUp.length / classified.length * 10) / 10 : null,
    heads_up_n: classified.length,
  }
}

export async function summary(rangeName: string, sensor: string | null = null) {
  const s = await getSettings()
  const [t0, t1, bucket] = rangeBounds(rangeName)
  const excl = await getExcluded(s)
  const visits = await getVisits(s, t0, t1, excl, sensor) as any[]
  const prev = await getVisits(s, t0 - (t1 - t0), t0, excl, sensor) as any[]

  const k = kpis(visits, s)
  const prevK = kpis(prev, s)

  // Return rate
  const stableDevs = new Set(visits.filter(v => v.stable).map((v: any) => v.device_id))
  let returning = 0
  if (stableDevs.size > 0) {
    const ids = [...stableDevs].map(id => `'${id}'`).join(',')
    const r = await prisma.$queryRawUnsafe<[{ count: number }]>(`
      SELECT COUNT(*)::int as count FROM devices WHERE id IN (${ids}) AND first_seen < ${t0}
    `)
    returning = r[0]?.count ?? 0
  }
  ;(k as any).return_rate = stableDevs.size ? Math.round(100 * returning / stableDevs.size * 10) / 10 : 0
  ;(k as any).stable_devices = stableDevs.size

  // Time series
  const nBuckets = Math.ceil((t1 - t0) / bucket)
  const passerB: Set<string>[] = Array.from({ length: nBuckets }, () => new Set())
  const viewerB: Set<string>[] = Array.from({ length: nBuckets }, () => new Set())
  const identB: Set<string>[] = Array.from({ length: nBuckets }, () => new Set())
  for (const v of visits) {
    const i = Math.min(Math.floor((v.start - t0) / bucket), nBuckets - 1)
    ;(v.viewer ? viewerB : passerB)[i].add(v.device_id)
    identB[i].add(v.identity)
  }
  const dpp = Math.max(s.devices_per_person, 0.1)
  const series = Array.from({ length: nBuckets }, (_, i) => ({
    t: t0 + i * bucket,
    passersby: passerB[i].size - (passerB[i].size > viewerB[i].size ? viewerB[i].size : 0),
    viewers: viewerB[i].size,
    people: Math.round(identB[i].size / dpp * 10) / 10,
  }))
  const peak = series.reduce((a, b) => (b.people > a.people ? b : a), series[0])
  ;(k as any).peak_t = peak?.people > 0 ? peak.t : null
  ;(k as any).peak_people = peak?.people ?? 0

  // Dwell histogram
  const bins: [number, number, string][] = [
    [0, 10, '<10s'], [10, 30, '10–30s'], [30, 60, '30–60s'],
    [60, 120, '1–2m'], [120, 300, '2–5m'], [300, 1e12, '5m+'],
  ]
  const dwellHist = bins.map(([, , label]) => ({ label, passersby: 0, viewers: 0 }))
  for (const v of visits) {
    for (let i = 0; i < bins.length; i++) {
      if (v.dwell >= bins[i][0] && v.dwell < bins[i][1]) {
        dwellHist[i][v.viewer ? 'viewers' : 'passersby']++
        break
      }
    }
  }

  // Radio / vendor mix
  const kinds: Record<string, Set<string>> = {}
  const vendors: Record<string, Set<string>> = {}
  for (const v of visits) {
    ;(kinds[v.kind] ||= new Set()).add(v.device_id)
    const vk = v.vendor || (v.kind === 'wifi' ? 'Randomized' : 'Unknown')
    ;(vendors[vk] ||= new Set()).add(v.device_id)
  }
  let vendorList = Object.entries(vendors).map(([k, s]) => ({ name: k, count: s.size })).sort((a, b) => b.count - a.count)
  if (vendorList.length > 6) {
    const other = vendorList.slice(5).reduce((a, b) => a + b.count, 0)
    vendorList = [...vendorList.slice(0, 5), { name: 'Other', count: other }]
  }

  // Per-billboard comparison (only meaningful across the whole fleet)
  const bySensor: Record<string, any[]> = {}
  if (!sensor) for (const v of visits) (bySensor[v.sensor_id || ''] ||= []).push(v)

  return {
    range: rangeName, t0, t1, bucket, settings: s,
    kpis: k, prev: prevK, series, dwell: dwellHist,
    by_sensor: Object.entries(bySensor).map(([id, vs]) => ({ id: id || null, ...kpis(vs, s) })),
    kinds: Object.fromEntries(Object.entries(kinds).map(([k, s]) => [k, s.size])),
    vendors: vendorList,
    excluded: excl.size,
  }
}

export async function heatmap(days = 28, sensor: string | null = null) {
  const s = await getSettings()
  const t1 = Date.now() / 1000
  const t0 = t1 - days * 86400
  const excl = await getExcluded(s)
  const visits = (await getVisits(s, t0, t1, excl, sensor)) as any[]

  const cells = new Map<string, Set<string>>()
  for (const v of visits) {
    const d = new Date(v.start * 1000)
    const key = `${d.getDay() === 0 ? 6 : d.getDay() - 1}:${d.getHours()}`
    ;(cells.get(key) || cells.set(key, new Set()).get(key)!).add(v.identity)
  }

  const occurrences: number[] = new Array(7).fill(0)
  let d = new Date(t0 * 1000); d.setHours(0, 0, 0, 0)
  const end = new Date(t1 * 1000); end.setHours(0, 0, 0, 0)
  while (d <= end) {
    const wd = d.getDay() === 0 ? 6 : d.getDay() - 1
    occurrences[wd]++
    d = new Date(d.getTime() + 86400000)
  }

  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0.0))
  for (const [key, ids] of cells) {
    const [wd, hr] = key.split(':').map(Number)
    grid[wd][hr] += ids.size
  }
  const dpp = Math.max(s.devices_per_person, 0.1)
  for (let wd = 0; wd < 7; wd++)
    for (let h = 0; h < 24; h++)
      grid[wd][h] = Math.round(grid[wd][h] / (occurrences[wd] || 1) / dpp * 10) / 10

  return { grid, days }
}

export async function retention(days = 14, sensor: string | null = null) {
  const s = await getSettings()
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const t0 = (new Date(now.getTime() - (days - 1) * 86400000)).getTime() / 1000
  const excl = await getExcluded(s)
  const stableClause = s.retention_stable_only
    ? `AND (d.randomized = 0 OR (d.label IS NOT NULL AND d.label != ''))`
    : ''

  const rows = await prisma.$queryRawUnsafe<{ device_id: string; day: number; first_seen: number }[]>(`
    SELECT DISTINCT v.device_id,
           FLOOR((v.start - ${t0}) / 86400)::int AS day,
           d.first_seen
    FROM visits v JOIN devices d ON d.id = v.device_id
    WHERE v.start >= ${t0} AND v.max_rssi >= ${s.passer_rssi} ${stableClause}${sensorSql('v.sensor_id', sensor)}
  `)

  const active = new Map<number, Set<string>>()
  const firstDay: Record<string, number> = {}
  for (const r of rows) {
    if (excl.has(r.device_id)) continue
    ;(active.get(r.day) || active.set(r.day, new Set()).get(r.day)!).add(r.device_id)
    const fd = Math.floor((r.first_seen - t0) / 86400)
    firstDay[r.device_id] = fd
  }

  const daily = Array.from({ length: days }, (_, d) => {
    const devs = active.get(d) || new Set<string>()
    const newDevs = [...devs].filter(x => firstDay[x] >= d).length
    return { t: t0 + d * 86400, new: newDevs, returning: devs.size - newDevs }
  })

  const cohorts = []
  for (let d = 0; d < days; d++) {
    const members = [...(active.get(d) || new Set<string>())].filter(x => firstDay[x] === d)
    if (!members.length) continue
    const ret = Array.from({ length: 7 }, (_, k) => {
      if (d + k + 1 >= days) return null
      const nextDay = active.get(d + k + 1) || new Set<string>()
      return Math.round(100 * members.filter(x => nextDay.has(x)).length / members.length * 10) / 10
    })
    cohorts.push({ t: t0 + d * 86400, size: members.length, ret })
  }

  const freqBins: [string, number, number][] = [['1 day', 1, 1], ['2 days', 2, 2], ['3 days', 3, 3], ['4–6 days', 4, 6], ['7+ days', 7, 1e6]]
  const daysSeen: Record<string, number> = {}
  for (const [d, devs] of active) for (const x of devs) daysSeen[x] = (daysSeen[x] || 0) + 1
  const freq = freqBins.map(([label, lo, hi]) => ({
    label, count: Object.values(daysSeen).filter(n => n >= lo && n <= hi).length,
  }))
  const total = Object.keys(daysSeen).length
  const repeat = Object.values(daysSeen).filter(n => n > 1).length

  return {
    days, daily, cohorts, frequency: freq, total,
    repeat_rate: total ? Math.round(100 * repeat / total * 10) / 10 : 0,
    stable_only: Boolean(s.retention_stable_only),
  }
}

// Devices a given sensor heard in the last windowS seconds (device rows are shared across sensors)
async function heardBy(sensor: string, windowS: number): Promise<string[]> {
  const fromMin = Math.floor((Date.now() / 1000 - windowS) / 60)
  const rows = await prisma.$queryRawUnsafe<{ device_id: string }[]>(
    `SELECT DISTINCT device_id FROM minute_stats WHERE minute >= ${fromMin} AND sensor_id = '${sensor}'
     UNION SELECT id AS device_id FROM devices WHERE kind = 'ap' AND sensor_id = '${sensor}'`)
  return rows.map(r => r.device_id)
}

export async function live(windowS = 60, sensor: string | null = null) {
  const s = await getSettings()
  const now = Date.now() / 1000
  const excl = await getExcluded(s)

  const devRows = await prisma.devices.findMany({
    where: {
      last_seen: { gte: now - windowS }, kind: { not: 'ap' },
      ...(sensor ? { id: { in: await heardBy(sensor, windowS) } } : {}),
    },
    orderBy: { last_rssi: 'desc' },
  })

  const devices = []
  const zones = { viewer: 0, passerby: 0, far: 0 }
  for (const r of devRows) {
    if (excl.has(r.id)) continue
    const zone = (r.last_rssi ?? -100) >= s.viewer_rssi ? 'viewer'
      : (r.last_rssi ?? -100) >= s.passer_rssi ? 'passerby' : 'far'
    zones[zone]++
    const details = r.details ? JSON.parse(r.details) : {}
    devices.push({ ...r, zone, activity: details.activity, activity_label: details.activity_label })
  }

  const nowMin = Math.floor(now / 60)
  const perMin = await prisma.minute_stats.findMany({
    where: { minute: { gt: nowMin - 60 }, max_rssi: { gte: s.passer_rssi }, ...(sensor ? { sensor_id: sensor } : {}) },
  })
  const buckets: Record<number, [number, number]> = {}
  for (const r of perMin) {
    if (excl.has(r.device_id)) continue
    const m = Number(r.minute)
    if (!buckets[m]) buckets[m] = [0, 0]
    buckets[m][r.max_rssi >= s.viewer_rssi ? 0 : 1]++
  }
  const minutes = Array.from({ length: 60 }, (_, i) => {
    const m = nowMin - 59 + i
    return { t: m * 60, viewers: buckets[m]?.[0] ?? 0, passersby: buckets[m]?.[1] ?? 0 }
  })

  const dpp = Math.max(s.devices_per_person, 0.1)
  return {
    zones, devices: devices.slice(0, 50), minutes,
    est_people_now: Math.round((zones.viewer + zones.passerby) / dpp * 10) / 10,
  }
}

export async function devices(rangeName = '24h', q = '', taggedOnly = false, kind = '', devType = '', sensor: string | null = null, limit = 500) {
  const s = await getSettings()
  const [t0] = rangeBounds(rangeName)
  const fx = await getFixtures(s)

  const conditions: string[] = []
  const params: (string | number)[] = []

  if (taggedOnly) {
    conditions.push(`d.label IS NOT NULL AND d.label != ''`)
  } else {
    conditions.push(`d.last_seen >= ${t0}`)
  }

  if (q) {
    const like = `%${q}%`
    // MACs match with or without separators ("aa:bb", "aa-bb", "aabb")
    const hex = /^[0-9a-f:.\-\s]+$/i.test(q) ? q.toLowerCase().replace(/[^0-9a-f]/g, '') : ''
    const macLike = hex.length >= 2 ? `%${hex.match(/../g)!.join(':')}%` : like
    conditions.push(`(d.id ILIKE $${params.length + 1} OR d.label ILIKE $${params.length + 2} OR d.vendor ILIKE $${params.length + 3} OR d.name ILIKE $${params.length + 4} OR d.model ILIKE $${params.length + 5} OR d.mac ILIKE $${params.length + 6} OR d.mac ILIKE $${params.length + 7})`)
    params.push(like, like, like, like, like, like, macLike)
  }

  if (kind) {
    conditions.push(`d.kind = $${params.length + 1}`)
    params.push(kind)
  } else {
    conditions.push(`d.kind != 'ap'`)
  }

  if (devType) {
    conditions.push(`d.dev_type = $${params.length + 1}`)
    params.push(devType)
  }

  if (sensor) conditions.push(`EXISTS (SELECT 1 FROM visits sv WHERE sv.device_id = d.id AND sv.sensor_id = '${sensor}')`)

  const where = conditions.join(' AND ')
  const sql = `
    SELECT d.*, COUNT(v.id)::int AS visits,
           COALESCE(SUM(v.end - v.start + ${CYCLE_S}), 0)::float AS total_dwell,
           MAX(v.max_rssi) AS peak_rssi,
           COUNT(DISTINCT DATE(to_timestamp(v.start)))::int AS days_seen,
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT v.sensor_id), NULL) AS sensors
    FROM devices d LEFT JOIN visits v ON v.device_id = d.id${sensorSql('v.sensor_id', sensor)}
    WHERE ${where}
    GROUP BY d.id ORDER BY d.last_seen DESC LIMIT ${limit}
  `

  const rows = params.length
    ? await prisma.$queryRawUnsafe<any[]>(sql, ...params)
    : await prisma.$queryRawUnsafe<any[]>(sql)

  return rows.map(r => {
    const details = r.details ? JSON.parse(r.details) : {}
    return {
      ...r, details,
      fixture: fx.has(r.id),
      stable: !r.randomized,
      distance: distanceM(r.last_rssi, r.kind, details, s),
    }
  })
}

export async function deviceDetail(devId: string) {
  const s = await getSettings()
  const d = await prisma.devices.findUnique({ where: { id: devId } })
  if (!d) return null

  const visitRows = await prisma.visits.findMany({
    where: { device_id: devId },
    orderBy: { start: 'desc' },
    take: 100,
  })
  const nowMin = Math.floor(Date.now() / 1000 / 60)
  const rssiRows = await prisma.minute_stats.findMany({
    where: { device_id: devId, minute: { gt: nowMin - 24 * 60 } },
    orderBy: { minute: 'asc' },
  })

  const root = d.entity_id || devId
  const linked = await prisma.devices.count({ where: { OR: [{ entity_id: root }, { id: root }] } })

  const seenBy = await prisma.visits.groupBy({
    by: ['sensor_id'], where: { device_id: devId }, _count: { _all: true }, _max: { end: true },
  })

  const details = d.details ? JSON.parse(d.details) : {}
  delete details.md
  return {
    device: { ...d, details, distance: distanceM(d.last_rssi, d.kind, details, s), linked_addresses: linked },
    sensors: seenBy.filter(r => r.sensor_id).map(r => ({ id: r.sensor_id, visits: r._count._all, last: r._max.end }))
      .sort((a, b) => (b.last ?? 0) - (a.last ?? 0)),
    visits: visitRows.map(v => ({ ...v, id: v.id.toString(), dwell: v.end - v.start + CYCLE_S })),
    rssi: rssiRows.map(r => ({ t: Number(r.minute) * 60, rssi: r.max_rssi })),
  }
}

export async function visitsCsv(rangeName: string, sensor: string | null = null): Promise<string> {
  const s = await getSettings()
  const [t0, t1] = rangeBounds(rangeName)
  const rows = await prisma.$queryRawUnsafe<any[]>(`
    SELECT v.device_id, v.sensor_id, d.mac, d.kind, d.vendor, d.label, d.randomized, v.start, v.end, v.max_rssi
    FROM visits v JOIN devices d ON d.id = v.device_id
    WHERE v.start >= ${t0} AND v.start < ${t1}${sensorSql('v.sensor_id', sensor)}
    ORDER BY v.start
  `)
  const lines = ['device_id,sensor_id,mac,kind,vendor,label,randomized,start,end,dwell_s,max_rssi,zone\n']
  for (const r of rows) {
    const zone = r.max_rssi >= s.viewer_rssi ? 'viewer' : r.max_rssi >= s.passer_rssi ? 'passerby' : 'far'
    const label = (r.label || '').replace(/"/g, "'")
    lines.push(`${r.device_id},${r.sensor_id || ''},${r.mac || ''},${r.kind},"${r.vendor || ''}","${label}",${r.randomized},` +
      `${new Date(r.start * 1000).toISOString().replace('T', ' ').slice(0, 19)},` +
      `${new Date(r.end * 1000).toISOString().replace('T', ' ').slice(0, 19)},` +
      `${Math.round(r.end - r.start + CYCLE_S)},${r.max_rssi},${zone}\n`)
  }
  return lines.join('')
}

const BANDS: [number, number | null][] = [[0, 2], [2, 5], [5, 10], [10, 20], [20, 40], [40, null]]

function bandIndex(dist: number): number {
  for (let i = 0; i < BANDS.length; i++) {
    const [, hi] = BANDS[i]
    if (hi === null || dist < hi) return i
  }
  return BANDS.length - 1
}

export async function radar(windowS?: number, includeAp = false, sensor: string | null = null) {
  const s = await getSettings()
  const win = windowS ?? s.radar_window_s
  const now = Date.now() / 1000
  const excl = await getExcluded(s)

  const rows = await prisma.devices.findMany({
    where: {
      last_seen: { gte: now - win },
      ...(includeAp ? {} : { kind: { not: 'ap' } }),
      ...(sensor ? { id: { in: await heardBy(sensor, win) } } : {}),
    },
  })

  const out = rows.map(r => {
    const details = r.details ? JSON.parse(r.details) : {}
    const dist = distanceM(r.last_rssi, r.kind, details, s)
    const zone = (r.last_rssi ?? -100) >= s.viewer_rssi ? 'viewer'
      : (r.last_rssi ?? -100) >= s.passer_rssi ? 'passerby' : 'far'
    return {
      id: r.id, kind: r.kind, type: r.dev_type || 'other', model: r.model,
      confidence: r.confidence, name: r.name, label: r.label, vendor: r.vendor,
      rssi: r.last_rssi, age: Math.round(now - r.last_seen), distance: dist, zone,
      randomized: Boolean(r.randomized), excluded: excl.has(r.id),
      ssids: details.ssids || [], wifi_gen: details.wifi_gen,
      connected: Boolean(details.connected),
      activity: details.activity, activity_label: details.activity_label,
    }
  }).sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999))

  const zones = {
    viewer_m: Math.round(10 ** ((s.rssi_1m_ble - s.viewer_rssi) / (10 * s.path_loss_n)) * 10) / 10,
    passer_m: Math.round(10 ** ((s.rssi_1m_ble - s.passer_rssi) / (10 * s.path_loss_n)) * 10) / 10,
  }
  return {
    devices: out, zones, window_s: win,
    types: TYPES.map(t => ({ key: t, label: TYPE_LABELS[t] })),
  }
}

export async function bands(rangeName = '24h', sensor: string | null = null) {
  const s = await getSettings()
  const [t0, t1] = rangeBounds(rangeName)
  const excl = await getExcluded(s)

  const rows = await prisma.$queryRawUnsafe<{ device_id: string; rssi: number; kind: string; dev_type: string | null; details: string | null }[]>(`
    SELECT v.device_id, MAX(v.max_rssi)::int AS rssi, d.kind, d.dev_type, d.details
    FROM visits v JOIN devices d ON d.id = v.device_id
    WHERE v.start >= ${t0} AND v.start < ${t1}${sensorSql('v.sensor_id', sensor)}
    GROUP BY v.device_id, d.kind, d.dev_type, d.details
  `)

  const grid: Record<string, number[]> = { wifi: new Array(BANDS.length).fill(0), ble: new Array(BANDS.length).fill(0) }
  const types: Record<string, number[]> = {}
  for (const r of rows) {
    if (excl.has(r.device_id) || !grid[r.kind]) continue
    const details = r.details ? JSON.parse(r.details) : {}
    const dist = distanceM(r.rssi, r.kind, details, s) ?? 999
    const b = bandIndex(dist)
    grid[r.kind][b]++
    const t = r.dev_type || 'other'
    if (!types[t]) types[t] = new Array(BANDS.length).fill(0)
    types[t][b]++
  }

  return {
    range: rangeName,
    bands: BANDS.map(([lo, hi]) => ({ lo, hi, label: hi ? `${lo}–${hi} m` : `${lo}+ m` })),
    wifi: grid.wifi, ble: grid.ble,
    types: TYPES.filter(t => types[t]).map(t => ({
      key: t, label: TYPE_LABELS[t], bands: types[t], total: types[t].reduce((a, b) => a + b, 0),
    })),
  }
}
