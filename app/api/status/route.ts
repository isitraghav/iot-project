import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sensorStatus } from '@/lib/fleet'

export async function GET() {
  const sensors = await prisma.sensors.findMany({ select: { last_seen: true } })
  const now = Date.now() / 1000
  const counts = { online: 0, stale: 0, offline: 0, pending: 0 }
  for (const s of sensors) counts[sensorStatus(s.last_seen, now)]++
  return NextResponse.json({ source: 'cloud', sensors: sensors.length, ...counts })
}
