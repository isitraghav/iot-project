import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { processBatch } from '@/lib/ingest'

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'missing Bearer token' }, { status: 401 })
  }
  const apiKey = auth.slice(7).trim()
  const sensor = await prisma.sensors.findUnique({ where: { api_key: apiKey } })
  if (!sensor) return NextResponse.json({ error: 'invalid API key' }, { status: 403 })

  const body = await req.json()
  const msgs = (body.msgs ?? []) as Record<string, unknown>[]
  if (!msgs.length) return NextResponse.json({ ok: true, processed: 0 })

  await processBatch(msgs, Date.now() / 1000, sensor.id)
  return NextResponse.json({ ok: true, processed: msgs.length })
}
