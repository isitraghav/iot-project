import { prisma } from './prisma'

export interface Settings {
  viewer_rssi: number
  passer_rssi: number
  visit_gap_s: number
  min_dwell_s: number
  devices_per_person: number
  auto_exclude_fixtures: number
  fixture_minutes_6h: number
  retention_stable_only: number
  billboard_name: string
  rssi_1m_ble: number
  rssi_1m_wifi: number
  path_loss_n: number
  radar_window_s: number
  link_addresses: number
}

export const DEFAULT_SETTINGS: Settings = {
  viewer_rssi: -60,
  passer_rssi: -80,
  visit_gap_s: 300,
  min_dwell_s: 5,
  devices_per_person: 1.6,
  auto_exclude_fixtures: 1,
  fixture_minutes_6h: 300,
  retention_stable_only: 1,
  billboard_name: 'Billboard #1',
  rssi_1m_ble: -59,
  rssi_1m_wifi: -45,
  path_loss_n: 2.7,
  radar_window_s: 60,
  link_addresses: 1,
}

function coerce(key: string, raw: string): number | string {
  const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]
  if (typeof def === 'number') {
    const n = parseFloat(raw)
    return Number.isInteger(def) ? Math.round(n) : n
  }
  return raw
}

let cache: { at: number; value: Settings } | null = null
const SETTINGS_TTL_MS = 10_000

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < SETTINGS_TTL_MS) return cache.value
  const rows = await prisma.settings.findMany()
  const out: Record<string, number | string> = { ...DEFAULT_SETTINGS }
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) out[r.key] = coerce(r.key, r.value)
  }
  cache = { at: Date.now(), value: out as unknown as Settings }
  return cache.value
}

export async function saveSettings(values: Record<string, string | number>): Promise<void> {
  cache = null
  const ops = Object.entries(values)
    .filter(([k]) => k in DEFAULT_SETTINGS)
    .map(([k, v]) =>
      prisma.settings.upsert({
        where: { key: k },
        create: { key: k, value: String(v) },
        update: { value: String(v) },
      })
    )
  await Promise.all(ops)
}

export async function initSettings(): Promise<void> {
  const ops = Object.entries(DEFAULT_SETTINGS).map(([k, v]) =>
    prisma.settings.upsert({
      where: { key: k },
      create: { key: k, value: String(v) },
      update: {},
    })
  )
  await Promise.all(ops)
}
