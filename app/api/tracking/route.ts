import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { deviceId } from '@/lib/ingest'

const MAC_RE = /^([0-9a-f]{2}[:\-]?){5}[0-9a-f]{2}$/i
const DAY = 86400

export async function GET(req: NextRequest) {
  const days = Math.min(30, Math.max(1, parseInt(req.nextUrl.searchParams.get('days') ?? '7') || 7))
  const since = Date.now() / 1000 - days * DAY
  const tracked = await prisma.tracked_devices.findMany({ orderBy: { created_at: 'desc' } })
  const ids = tracked.flatMap(t => [t.id, t.ble_id])
  const visits = ids.length
    ? await prisma.visits.findMany({ where: { device_id: { in: ids }, end: { gte: since } }, orderBy: { start: 'desc' }, take: 2000 })
    : []
  const rows = tracked.map(t => {
    const v = visits.filter(x => x.device_id === t.id || x.device_id === t.ble_id)
    const sensors = [...new Set(v.map(x => x.sensor_id).filter(Boolean))]
    return {
      id: t.id, created_at: t.created_at,
      last_seen: v.length ? Math.max(...v.map(x => x.end)) : null,
      visits: v.length, sensors,
      timeline: v.slice(0, 50).map(x => ({ start: x.start, end: x.end, sensor_id: x.sensor_id, max_rssi: x.max_rssi })),
    }
  })
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const mac = String(body.mac ?? '').trim()
  if (!MAC_RE.test(mac)) return NextResponse.json({ error: 'Enter a valid MAC address' }, { status: 400 })
  const clean = mac.replace(/[:\-]/g, '').toLowerCase().match(/../g)!.join(':')
  const id = deviceId('wifi', clean), ble_id = deviceId('ble', clean)
  await prisma.tracked_devices.upsert({
    where: { id },
    create: { id, ble_id, created_at: Date.now() / 1000 },
    update: {},
  })
  return NextResponse.json({ ok: true, id }, { status: 201 })
}
