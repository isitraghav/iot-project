import { prisma } from './prisma'
import { getSettings, Settings } from './settings'
import { distanceM, TYPES, TYPE_LABELS } from './classify'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The ESP32 sweeps WiFi/BLE once per cycle, so a visit lasts at least this long. */
const CYCLE_S = 4

const DAY_S = 86400

/** Named time ranges: [how far back in seconds (null = since midnight), chart bucket size in seconds] */
const RANGES: Record<string, [number | null, number]> = {
  '1h': [3600, 300],
  'today': [null, 3600],
  '24h': [DAY_S, 3600],
  '7d': [7 * DAY_S, 3 * 3600],
  '30d': [30 * DAY_S, DAY_S],
}

/** Distance bands (metres) used by the bands chart. `null` means "no upper limit". */
const BANDS: [number, number | null][] = [[0, 2], [2, 5], [5, 10], [10, 20], [20, 40], [40, null]]

/** Dwell-time histogram bins in seconds: [from, to, label] */
const DWELL_BINS: [number, number, string][] = [
  [0, 10, '<10s'], [10, 30, '10–30s'], [30, 60, '30–60s'],
  [60, 120, '1–2m'], [120, 300, '2–5m'], [300, Infinity, '5m+'],
]

/** How many distinct days a device was seen: [label, min days, max days] */
const VISIT_FREQUENCY_BINS: [string, number, number][] = [
  ['1 day', 1, 1], ['2 days', 2, 2], ['3 days', 3, 3], ['4–6 days', 4, 6], ['7+ days', 7, Infinity],
]

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Zone = 'viewer' | 'passerby' | 'far'

/** Round to one decimal place. */
const round1 = (n: number) => Math.round(n * 10) / 10

/** `part` as a percentage of `whole`, one decimal. Returns 0 when there is nothing to divide by. */
const percent = (part: number, whole: number) => (whole ? round1((100 * part) / whole) : 0)

/** Settings guard: never divide by less than 0.1 devices per person. */
const devicesPerPerson = (s: Settings) => Math.max(s.devices_per_person, 0.1)

/** Which distance zone a signal strength falls in. */
function zoneFor(rssi: number | null, s: Settings): Zone {
  const strength = rssi ?? -100
  if (strength >= s.viewer_rssi) return 'viewer'
  if (strength >= s.passer_rssi) return 'passerby'
  return 'far'
}

/** Details are stored as a JSON string in the database. */
const parseDetails = (json: string | null | undefined): Record<string, any> => (json ? JSON.parse(json) : {})

/** Monday = 0 ... Sunday = 6 (JS getDay() has Sunday = 0). */
const mondayFirstWeekday = (d: Date) => (d.getDay() === 0 ? 6 : d.getDay() - 1)

/** Midnight (local time) of the given date, as a new Date. */
function startOfDay(d: Date): Date {
  const copy = new Date(d)
  copy.setHours(0, 0, 0, 0)
  return copy
}

/** Get the Set stored under `key`, creating it if needed. */
function getOrCreateSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key)
  if (!set) {
    set = new Set<V>()
    map.set(key, set)
  }
  return set
}

const emptyBands = () => new Array<number>(BANDS.length).fill(0)

function bandIndex(distance: number): number {
  const index = BANDS.findIndex(([, upper]) => upper === null || distance < upper)
  return index === -1 ? BANDS.length - 1 : index
}

/** Convert a named range into [start, end, bucketSize], all in unix seconds. */
export function rangeBounds(name: string, now: number = Date.now() / 1000): [number, number, number] {
  const [span, bucket] = RANGES[name] ?? RANGES['24h']
  const start = span === null ? startOfDay(new Date(now * 1000)).getTime() / 1000 : now - span
  return [start, now, bucket]
}

// Sensor IDs are hex strings; anything else is treated as "all sensors" so it can't reach SQL
export function sensorId(raw: string | null | undefined): string | null {
  return raw && /^[a-f0-9]{6,32}$/.test(raw) ? raw : null
}

/** SQL snippet that filters a column to one sensor (empty when no sensor is selected). */
const sensorSql = (column: string, sensor: string | null) => (sensor ? ` AND ${column} = '${sensor}'` : '')

// ---------------------------------------------------------------------------
// Excluded devices (manually ignored + auto-detected fixtures)
// ---------------------------------------------------------------------------

let fixtureCache = { timestamp: 0, ids: new Set<string>() }

/**
 * Fixtures are devices that are always there (routers, smart TVs...), so they
 * shouldn't count as audience. We spot them by how many minutes they were
 * active recently. The result is cached for a minute.
 */
async function getFixtures(s: Settings): Promise<Set<string>> {
  const nowS = Date.now() / 1000
  if (nowS - fixtureCache.timestamp < 60) return fixtureCache.ids

  const nowMinute = Math.floor(nowS / 60)
  const minActiveMinutes = s.fixture_minutes_6h
  const rows = await prisma.$queryRawUnsafe<
    { device_id: string; active_minutes: number; first_minute: number; last_minute: number; recent_minutes: number }[]
  >(`
    SELECT device_id,
           COUNT(*)::int AS active_minutes,
           MIN(minute)::int AS first_minute,
           MAX(minute)::int AS last_minute,
           SUM(CASE WHEN minute >= ${nowMinute - 360} THEN 1 ELSE 0 END)::int AS recent_minutes
    FROM minute_stats
    GROUP BY device_id
    HAVING COUNT(*) >= ${Math.min(minActiveMinutes, 360)}
  `)

  const ids = new Set<string>()
  for (const r of rows) {
    const spanMinutes = r.last_minute - r.first_minute + 1
    const activeInLast6h = r.recent_minutes >= minActiveMinutes
    const activeMostOfItsLifetime = r.active_minutes >= 360 && r.active_minutes / spanMinutes >= 0.8
    if (activeInLast6h || activeMostOfItsLifetime) ids.add(r.device_id)
  }

  fixtureCache = { timestamp: nowS, ids }
  return ids
}

/** Device IDs that should be left out of every statistic. */
export async function getExcluded(s: Settings): Promise<Set<string>> {
  const ignored = await prisma.devices.findMany({ where: { ignored: 1 }, select: { id: true } })
  const excluded = new Set(ignored.map(r => r.id))
  if (s.auto_exclude_fixtures) {
    for (const id of await getFixtures(s)) excluded.add(id)
  }
  return excluded
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

export interface VisitRow {
  device_id: string; start: number; end: number; max_rssi: number
  phone_idle: number; phone_use: number; kind: string; randomized: number
  fp: string | null; label: string | null; vendor: string | null; entity_id: string | null
  stable: boolean; sensor_id: string | null
}

/** A visit row plus the values we derive from it. */
export interface Visit extends VisitRow {
  /** Seconds the device stayed around. */
  dwell: number
  /** Who this really is: linked entity, WiFi fingerprint for randomized MACs, or the device itself. */
  identity: string
  /** Close enough to see the billboard. */
  viewer: boolean
}

export async function getVisits(
  s: Settings, t0: number, t1: number, excluded: Set<string>, sensor: string | null = null,
): Promise<Visit[]> {
  const rows = await prisma.$queryRawUnsafe<VisitRow[]>(`
    SELECT v.device_id, v.sensor_id, v.start, v.end, v.max_rssi, v.phone_idle, v.phone_use,
           d.kind, d.randomized, d.fp, d.label, d.vendor, d.entity_id,
           (d.randomized = 0 OR (d.label IS NOT NULL AND d.label != '')) AS stable
    FROM visits v JOIN devices d ON d.id = v.device_id
    WHERE v.start >= ${t0} AND v.start < ${t1} AND v.max_rssi >= ${s.passer_rssi}${sensorSql('v.sensor_id', sensor)}
  `)

  return rows
    .filter(r => !excluded.has(r.device_id))
    .map(r => ({
      ...r,
      dwell: r.end - r.start + CYCLE_S,
      identity: identityOf(r),
      viewer: r.max_rssi >= s.viewer_rssi,
    }))
}

function identityOf(r: VisitRow): string {
  if (r.entity_id) return r.entity_id
  if (r.kind === 'wifi' && r.randomized && r.fp) return `fp:${r.fp}`
  return r.device_id
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Headline numbers for a set of visits. */
function kpis(visits: Visit[], s: Settings) {
  const identities = new Set(visits.map(v => v.identity))
  const viewerIdentities = new Set(visits.filter(v => v.viewer).map(v => v.identity))

  // An impression = a viewer who stayed at least min_dwell_s
  const impressions = visits.filter(v => v.viewer && v.dwell >= s.min_dwell_s)
  const dwellTimes = impressions.map(v => v.dwell).sort((a, b) => a - b)
  const totalDwell = dwellTimes.reduce((sum, d) => sum + d, 0)

  // Only iPhones etc. report activity; "heads up" = phone idle at least as often as in use
  const withActivity = impressions.filter(v => v.phone_idle + v.phone_use > 0)
  const headsUp = withActivity.filter(v => v.phone_idle >= v.phone_use)

  return {
    unique_devices: new Set(visits.map(v => v.device_id)).size,
    est_people: Math.round(identities.size / devicesPerPerson(s)),
    viewers: viewerIdentities.size,
    impressions: impressions.length,
    avg_dwell: dwellTimes.length ? round1(totalDwell / dwellTimes.length) : 0,
    median_dwell: dwellTimes.length ? dwellTimes[Math.floor(dwellTimes.length / 2)] : 0,
    engagement_rate: percent(viewerIdentities.size, identities.size),
    heads_up_rate: withActivity.length ? percent(headsUp.length, withActivity.length) : null,
    heads_up_n: withActivity.length,
  }
}

/** Share of "stable" devices (fixed MAC or labelled) that were already known before t0. */
async function returnRate(visits: Visit[], t0: number) {
  const stableDevices = new Set(visits.filter(v => v.stable).map(v => v.device_id))
  if (stableDevices.size === 0) return { return_rate: 0, stable_devices: 0 }

  const idList = [...stableDevices].map(id => `'${id}'`).join(',')
  const rows = await prisma.$queryRawUnsafe<[{ count: number }]>(
    `SELECT COUNT(*)::int as count FROM devices WHERE id IN (${idList}) AND first_seen < ${t0}`,
  )
  const returning = rows[0]?.count ?? 0
  return { return_rate: percent(returning, stableDevices.size), stable_devices: stableDevices.size }
}

/** People over time, split into fixed-size buckets. */
function buildTimeSeries(visits: Visit[], s: Settings, t0: number, t1: number, bucketSize: number) {
  const bucketCount = Math.ceil((t1 - t0) / bucketSize)
  const newBuckets = () => Array.from({ length: bucketCount }, () => new Set<string>())
  const passerDevices = newBuckets()
  const viewerDevices = newBuckets()
  const identities = newBuckets()

  for (const v of visits) {
    const i = Math.min(Math.floor((v.start - t0) / bucketSize), bucketCount - 1)
    ;(v.viewer ? viewerDevices : passerDevices)[i].add(v.device_id)
    identities[i].add(v.identity)
  }

  return Array.from({ length: bucketCount }, (_, i) => {
    const passers = passerDevices[i].size
    const viewers = viewerDevices[i].size
    return {
      t: t0 + i * bucketSize,
      // If a device was both a passer and a viewer in this bucket, don't count it twice
      passersby: passers > viewers ? passers - viewers : passers,
      viewers,
      people: round1(identities[i].size / devicesPerPerson(s)),
    }
  })
}

function buildDwellHistogram(visits: Visit[]) {
  const histogram = DWELL_BINS.map(([, , label]) => ({ label, passersby: 0, viewers: 0 }))
  for (const v of visits) {
    const bin = DWELL_BINS.findIndex(([from, to]) => v.dwell >= from && v.dwell < to)
    if (bin !== -1) histogram[bin][v.viewer ? 'viewers' : 'passersby']++
  }
  return histogram
}

/** How many distinct devices of each radio type and vendor were seen. */
function buildRadioAndVendorMix(visits: Visit[]) {
  const devicesByKind = new Map<string, Set<string>>()
  const devicesByVendor = new Map<string, Set<string>>()
  for (const v of visits) {
    getOrCreateSet(devicesByKind, v.kind).add(v.device_id)
    const vendor = v.vendor || (v.kind === 'wifi' ? 'Randomized' : 'Unknown')
    getOrCreateSet(devicesByVendor, vendor).add(v.device_id)
  }

  // Keep the top 5 vendors and lump the rest into "Other"
  let vendors = [...devicesByVendor].map(([name, ids]) => ({ name, count: ids.size })).sort((a, b) => b.count - a.count)
  if (vendors.length > 6) {
    const otherCount = vendors.slice(5).reduce((sum, v) => sum + v.count, 0)
    vendors = [...vendors.slice(0, 5), { name: 'Other', count: otherCount }]
  }

  const kinds = Object.fromEntries([...devicesByKind].map(([kind, ids]) => [kind, ids.size]))
  return { kinds, vendors }
}

export async function summary(rangeName: string, sensor: string | null = null) {
  const s = await getSettings()
  const [t0, t1, bucket] = rangeBounds(rangeName)
  const excluded = await getExcluded(s)

  const visits = await getVisits(s, t0, t1, excluded, sensor)
  const previousVisits = await getVisits(s, t0 - (t1 - t0), t0, excluded, sensor) // same-length period before

  const series = buildTimeSeries(visits, s, t0, t1, bucket)
  const peak = series.reduce((best, point) => (point.people > best.people ? point : best), series[0])
  const { kinds, vendors } = buildRadioAndVendorMix(visits)

  // Per-billboard comparison (only meaningful across the whole fleet)
  const visitsBySensor = new Map<string, Visit[]>()
  if (!sensor) {
    for (const v of visits) {
      const key = v.sensor_id || ''
      if (!visitsBySensor.has(key)) visitsBySensor.set(key, [])
      visitsBySensor.get(key)!.push(v)
    }
  }

  return {
    range: rangeName, t0, t1, bucket, settings: s,
    kpis: {
      ...kpis(visits, s),
      ...(await returnRate(visits, t0)),
      peak_t: peak?.people > 0 ? peak.t : null,
      peak_people: peak?.people ?? 0,
    },
    prev: kpis(previousVisits, s),
    series,
    dwell: buildDwellHistogram(visits),
    by_sensor: [...visitsBySensor].map(([id, sensorVisits]) => ({ id: id || null, ...kpis(sensorVisits, s) })),
    kinds,
    vendors,
    excluded: excluded.size,
  }
}

// ---------------------------------------------------------------------------
// Heatmap (average people per weekday x hour)
// ---------------------------------------------------------------------------

export async function heatmap(days = 28, sensor: string | null = null) {
  const s = await getSettings()
  const t1 = Date.now() / 1000
  const t0 = t1 - days * DAY_S
  const excluded = await getExcluded(s)
  const visits = await getVisits(s, t0, t1, excluded, sensor)

  // Distinct people in each (weekday, hour) slot, summed over the whole period
  const peopleBySlot = new Map<string, Set<string>>()
  for (const v of visits) {
    const date = new Date(v.start * 1000)
    getOrCreateSet(peopleBySlot, `${mondayFirstWeekday(date)}:${date.getHours()}`).add(v.identity)
  }

  // How many Mondays, Tuesdays... fall inside the period (to turn totals into averages)
  const daysPerWeekday = new Array<number>(7).fill(0)
  const lastDay = startOfDay(new Date(t1 * 1000))
  for (let day = startOfDay(new Date(t0 * 1000)); day <= lastDay; day = new Date(day.getTime() + DAY_S * 1000)) {
    daysPerWeekday[mondayFirstWeekday(day)]++
  }

  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  for (const [slot, people] of peopleBySlot) {
    const [weekday, hour] = slot.split(':').map(Number)
    grid[weekday][hour] = people.size
  }

  const perPerson = devicesPerPerson(s)
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const averageDevices = grid[weekday][hour] / (daysPerWeekday[weekday] || 1)
      grid[weekday][hour] = round1(averageDevices / perPerson)
    }
  }

  return { grid, days }
}

// ---------------------------------------------------------------------------
// Retention (new vs returning devices, cohorts, visit frequency)
// ---------------------------------------------------------------------------

export async function retention(days = 14, sensor: string | null = null) {
  const s = await getSettings()
  const t0 = (startOfDay(new Date()).getTime() - (days - 1) * DAY_S * 1000) / 1000
  const excluded = await getExcluded(s)
  const stableOnly = s.retention_stable_only
    ? `AND (d.randomized = 0 OR (d.label IS NOT NULL AND d.label != ''))`
    : ''

  const rows = await prisma.$queryRawUnsafe<{ device_id: string; day: number; first_seen: number }[]>(`
    SELECT DISTINCT v.device_id,
           FLOOR((v.start - ${t0}) / ${DAY_S})::int AS day,
           d.first_seen
    FROM visits v JOIN devices d ON d.id = v.device_id
    WHERE v.start >= ${t0} AND v.max_rssi >= ${s.passer_rssi} ${stableOnly}${sensorSql('v.sensor_id', sensor)}
  `)

  // Which devices were active on each day (day 0 = first day of the period)
  const activeByDay = new Map<number, Set<string>>()
  const firstDayOf = new Map<string, number>()
  for (const r of rows) {
    if (excluded.has(r.device_id)) continue
    getOrCreateSet(activeByDay, r.day).add(r.device_id)
    firstDayOf.set(r.device_id, Math.floor((r.first_seen - t0) / DAY_S))
  }
  const activeOn = (day: number) => activeByDay.get(day) ?? new Set<string>()

  // New vs returning devices per day
  const daily = Array.from({ length: days }, (_, day) => {
    const active = [...activeOn(day)]
    const newCount = active.filter(id => firstDayOf.get(id)! >= day).length
    return { t: t0 + day * DAY_S, new: newCount, returning: active.length - newCount }
  })

  // Cohorts: of the devices first seen on a day, what % came back 1..7 days later?
  const cohorts = []
  for (let day = 0; day < days; day++) {
    const members = [...activeOn(day)].filter(id => firstDayOf.get(id) === day)
    if (!members.length) continue

    const returnPercents = Array.from({ length: 7 }, (_, offset) => {
      const laterDay = day + offset + 1
      if (laterDay >= days) return null // that day hasn't happened yet
      const cameBack = members.filter(id => activeOn(laterDay).has(id)).length
      return percent(cameBack, members.length)
    })
    cohorts.push({ t: t0 + day * DAY_S, size: members.length, ret: returnPercents })
  }

  // Frequency: how many different days was each device seen?
  const daysSeen = new Map<string, number>()
  for (const devices of activeByDay.values()) {
    for (const id of devices) daysSeen.set(id, (daysSeen.get(id) ?? 0) + 1)
  }
  const dayCounts = [...daysSeen.values()]
  const frequency = VISIT_FREQUENCY_BINS.map(([label, min, max]) => ({
    label, count: dayCounts.filter(n => n >= min && n <= max).length,
  }))
  const total = dayCounts.length
  const repeat = dayCounts.filter(n => n > 1).length

  return {
    days, daily, cohorts, frequency, total,
    repeat_rate: percent(repeat, total),
    stable_only: Boolean(s.retention_stable_only),
  }
}

// ---------------------------------------------------------------------------
// Live view and radar
// ---------------------------------------------------------------------------

/** Devices a given sensor heard in the last windowS seconds (device rows are shared across sensors). */
async function heardBy(sensor: string, windowS: number): Promise<string[]> {
  const fromMinute = Math.floor((Date.now() / 1000 - windowS) / 60)
  const rows = await prisma.$queryRawUnsafe<{ device_id: string }[]>(
    `SELECT DISTINCT device_id FROM minute_stats WHERE minute >= ${fromMinute} AND sensor_id = '${sensor}'
     UNION SELECT id AS device_id FROM devices WHERE kind = 'ap' AND sensor_id = '${sensor}'`)
  return rows.map(r => r.device_id)
}

export async function live(windowS = 60, sensor: string | null = null) {
  const s = await getSettings()
  const now = Date.now() / 1000
  const excluded = await getExcluded(s)

  const recentDevices = await prisma.devices.findMany({
    where: {
      last_seen: { gte: now - windowS },
      kind: { not: 'ap' },
      ...(sensor ? { id: { in: await heardBy(sensor, windowS) } } : {}),
    },
    orderBy: { last_rssi: 'desc' },
  })

  const zones = { viewer: 0, passerby: 0, far: 0 }
  const devices = []
  for (const device of recentDevices) {
    if (excluded.has(device.id)) continue
    const zone = zoneFor(device.last_rssi, s)
    zones[zone]++
    const details = parseDetails(device.details)
    devices.push({ ...device, zone, activity: details.activity, activity_label: details.activity_label })
  }

  // Devices per minute for the last 60 minutes, split into viewers and passersby
  const nowMinute = Math.floor(now / 60)
  const minuteStats = await prisma.minute_stats.findMany({
    where: {
      minute: { gt: nowMinute - 60 },
      max_rssi: { gte: s.passer_rssi },
      ...(sensor ? { sensor_id: sensor } : {}),
    },
  })
  const countsByMinute = new Map<number, { viewers: number; passersby: number }>()
  for (const row of minuteStats) {
    if (excluded.has(row.device_id)) continue
    const minute = Number(row.minute)
    const counts = countsByMinute.get(minute) ?? { viewers: 0, passersby: 0 }
    counts[row.max_rssi >= s.viewer_rssi ? 'viewers' : 'passersby']++
    countsByMinute.set(minute, counts)
  }
  const minutes = Array.from({ length: 60 }, (_, i) => {
    const minute = nowMinute - 59 + i
    const counts = countsByMinute.get(minute)
    return { t: minute * 60, viewers: counts?.viewers ?? 0, passersby: counts?.passersby ?? 0 }
  })

  return {
    zones,
    devices: devices.slice(0, 50),
    minutes,
    est_people_now: round1((zones.viewer + zones.passerby) / devicesPerPerson(s)),
  }
}

/** Distance in metres at which a BLE signal drops to the given strength. */
const bleDistanceForRssi = (rssi: number, s: Settings) =>
  round1(10 ** ((s.rssi_1m_ble - rssi) / (10 * s.path_loss_n)))

export async function radar(windowS?: number, includeAp = false, sensor: string | null = null) {
  const s = await getSettings()
  const window = windowS ?? s.radar_window_s
  const now = Date.now() / 1000
  const excluded = await getExcluded(s)

  const recentDevices = await prisma.devices.findMany({
    where: {
      last_seen: { gte: now - window },
      ...(includeAp ? {} : { kind: { not: 'ap' } }),
      ...(sensor ? { id: { in: await heardBy(sensor, window) } } : {}),
    },
  })

  const devices = recentDevices
    .map(r => {
      const details = parseDetails(r.details)
      return {
        id: r.id, kind: r.kind, type: r.dev_type || 'other', model: r.model,
        confidence: r.confidence, name: r.name, label: r.label, vendor: r.vendor,
        rssi: r.last_rssi, age: Math.round(now - r.last_seen),
        distance: distanceM(r.last_rssi, r.kind, details, s),
        zone: zoneFor(r.last_rssi, s),
        randomized: Boolean(r.randomized), excluded: excluded.has(r.id),
        ssids: details.ssids || [], wifi_gen: details.wifi_gen,
        connected: Boolean(details.connected),
        activity: details.activity, activity_label: details.activity_label,
      }
    })
    .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999))

  return {
    devices,
    zones: {
      viewer_m: bleDistanceForRssi(s.viewer_rssi, s),
      passer_m: bleDistanceForRssi(s.passer_rssi, s),
    },
    window_s: window,
    types: TYPES.map(t => ({ key: t, label: TYPE_LABELS[t] })),
  }
}

// ---------------------------------------------------------------------------
// Device list and detail
// ---------------------------------------------------------------------------

export async function devices(
  rangeName = '24h', q = '', taggedOnly = false, kind = '', devType = '', sensor: string | null = null, limit = 500,
) {
  const s = await getSettings()
  const [t0] = rangeBounds(rangeName)
  const fixtures = await getFixtures(s)

  // Build the WHERE clause. User-supplied text goes in as $1, $2... parameters, never into the SQL string.
  const params: (string | number)[] = []
  const param = (value: string | number) => {
    params.push(value)
    return `$${params.length}`
  }
  const conditions: string[] = []

  conditions.push(taggedOnly ? `d.label IS NOT NULL AND d.label != ''` : `d.last_seen >= ${t0}`)

  if (q) {
    const text = param(`%${q}%`)
    // MACs match with or without separators ("aa:bb", "aa-bb", "aabb")
    const looksLikeMac = /^[0-9a-f:.\-\s]+$/i.test(q)
    const hex = looksLikeMac ? q.toLowerCase().replace(/[^0-9a-f]/g, '') : ''
    const mac = hex.length >= 2 ? param(`%${hex.match(/../g)!.join(':')}%`) : text
    conditions.push(
      `(d.id ILIKE ${text} OR d.label ILIKE ${text} OR d.vendor ILIKE ${text} OR d.name ILIKE ${text}` +
      ` OR d.model ILIKE ${text} OR d.mac ILIKE ${text} OR d.mac ILIKE ${mac})`,
    )
  }

  conditions.push(kind ? `d.kind = ${param(kind)}` : `d.kind != 'ap'`)
  if (devType) conditions.push(`d.dev_type = ${param(devType)}`)
  if (sensor) conditions.push(`EXISTS (SELECT 1 FROM visits sv WHERE sv.device_id = d.id AND sv.sensor_id = '${sensor}')`)

  const rows = await prisma.$queryRawUnsafe<any[]>(`
    SELECT d.*, COUNT(v.id)::int AS visits,
           COALESCE(SUM(v.end - v.start + ${CYCLE_S}), 0)::float AS total_dwell,
           MAX(v.max_rssi) AS peak_rssi,
           COUNT(DISTINCT DATE(to_timestamp(v.start)))::int AS days_seen,
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT v.sensor_id), NULL) AS sensors
    FROM devices d LEFT JOIN visits v ON v.device_id = d.id${sensorSql('v.sensor_id', sensor)}
    WHERE ${conditions.join(' AND ')}
    GROUP BY d.id ORDER BY d.last_seen DESC LIMIT ${limit}
  `, ...params)

  return rows.map(r => {
    const details = parseDetails(r.details)
    return {
      ...r,
      details,
      fixture: fixtures.has(r.id),
      stable: !r.randomized,
      distance: distanceM(r.last_rssi, r.kind, details, s),
    }
  })
}

export async function deviceDetail(deviceId: string) {
  const s = await getSettings()
  const device = await prisma.devices.findUnique({ where: { id: deviceId } })
  if (!device) return null

  const recentVisits = await prisma.visits.findMany({
    where: { device_id: deviceId },
    orderBy: { start: 'desc' },
    take: 100,
  })

  const nowMinute = Math.floor(Date.now() / 1000 / 60)
  const last24hStats = await prisma.minute_stats.findMany({
    where: { device_id: deviceId, minute: { gt: nowMinute - 24 * 60 } },
    orderBy: { minute: 'asc' },
  })

  // Count every address linked to the same physical entity
  const entityRoot = device.entity_id || deviceId
  const linkedAddresses = await prisma.devices.count({
    where: { OR: [{ entity_id: entityRoot }, { id: entityRoot }] },
  })

  const visitsBySensor = await prisma.visits.groupBy({
    by: ['sensor_id'], where: { device_id: deviceId }, _count: { _all: true }, _max: { end: true },
  })
  const sensors = visitsBySensor
    .filter(r => r.sensor_id)
    .map(r => ({ id: r.sensor_id, visits: r._count._all, last: r._max.end }))
    .sort((a, b) => (b.last ?? 0) - (a.last ?? 0))

  const details = parseDetails(device.details)
  delete details.md // raw manufacturer data is noisy and not useful in the UI

  return {
    device: {
      ...device,
      details,
      distance: distanceM(device.last_rssi, device.kind, details, s),
      linked_addresses: linkedAddresses,
    },
    sensors,
    visits: recentVisits.map(v => ({ ...v, id: v.id.toString(), dwell: v.end - v.start + CYCLE_S })),
    rssi: last24hStats.map(r => ({ t: Number(r.minute) * 60, rssi: r.max_rssi })),
  }
}

// ---------------------------------------------------------------------------
// Bands (how far away devices were)
// ---------------------------------------------------------------------------

export async function bands(rangeName = '24h', sensor: string | null = null) {
  const s = await getSettings()
  const [t0, t1] = rangeBounds(rangeName)
  const excluded = await getExcluded(s)

  const rows = await prisma.$queryRawUnsafe<
    { device_id: string; rssi: number; kind: string; dev_type: string | null; details: string | null }[]
  >(`
    SELECT v.device_id, MAX(v.max_rssi)::int AS rssi, d.kind, d.dev_type, d.details
    FROM visits v JOIN devices d ON d.id = v.device_id
    WHERE v.start >= ${t0} AND v.start < ${t1}${sensorSql('v.sensor_id', sensor)}
    GROUP BY v.device_id, d.kind, d.dev_type, d.details
  `)

  // Number of devices in each distance band, per radio and per device type
  const perRadio: Record<string, number[]> = { wifi: emptyBands(), ble: emptyBands() }
  const perType: Record<string, number[]> = {}

  for (const r of rows) {
    if (excluded.has(r.device_id) || !perRadio[r.kind]) continue
    const distance = distanceM(r.rssi, r.kind, parseDetails(r.details), s) ?? 999
    const band = bandIndex(distance)
    perRadio[r.kind][band]++

    const type = r.dev_type || 'other'
    perType[type] ??= emptyBands()
    perType[type][band]++
  }

  return {
    range: rangeName,
    bands: BANDS.map(([lo, hi]) => ({ lo, hi, label: hi ? `${lo}–${hi} m` : `${lo}+ m` })),
    wifi: perRadio.wifi,
    ble: perRadio.ble,
    types: TYPES.filter(t => perType[t]).map(t => ({
      key: t,
      label: TYPE_LABELS[t],
      bands: perType[t],
      total: perType[t].reduce((a, b) => a + b, 0),
    })),
  }
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/** Unix seconds -> "YYYY-MM-DD HH:MM:SS" (UTC). */
const formatTimestamp = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19)

export async function visitsCsv(rangeName: string, sensor: string | null = null): Promise<string> {
  const s = await getSettings()
  const [t0, t1] = rangeBounds(rangeName)
  const rows = await prisma.$queryRawUnsafe<any[]>(`
    SELECT v.device_id, v.sensor_id, d.mac, d.kind, d.vendor, d.label, d.randomized, v.start, v.end, v.max_rssi
    FROM visits v JOIN devices d ON d.id = v.device_id
    WHERE v.start >= ${t0} AND v.start < ${t1}${sensorSql('v.sensor_id', sensor)}
    ORDER BY v.start
  `)

  const lines = ['device_id,sensor_id,mac,kind,vendor,label,randomized,start,end,dwell_s,max_rssi,zone']
  for (const r of rows) {
    const label = (r.label || '').replace(/"/g, "'") // swap quotes so the CSV field stays valid
    lines.push([
      r.device_id,
      r.sensor_id || '',
      r.mac || '',
      r.kind,
      `"${r.vendor || ''}"`,
      `"${label}"`,
      r.randomized,
      formatTimestamp(r.start),
      formatTimestamp(r.end),
      Math.round(r.end - r.start + CYCLE_S),
      r.max_rssi,
      zoneFor(r.max_rssi, s),
    ].join(','))
  }
  return lines.join('\n') + '\n'
}
