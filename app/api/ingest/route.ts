import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { processBatch } from '@/lib/ingest'
import { readJson, badRequest } from '@/lib/http'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const MAX_MSGS = 500

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'missing Bearer token' }, { status: 401 })
  }
  const apiKey = auth.slice(7).trim()
  let sensor
  try {
    sensor = apiKey ? await prisma.sensors.findUnique({ where: { api_key: apiKey } }) : null
  } catch (e) {
    console.error('ingest: db unavailable', e)
    return NextResponse.json({ error: 'database unavailable' }, { status: 503 })
  }
  if (!sensor) return NextResponse.json({ error: 'invalid API key' }, { status: 403 })

  const body = await readJson(req)
  if (!body) return badRequest()
  if (body.msgs !== undefined && !Array.isArray(body.msgs)) return badRequest('msgs must be an array')
  const msgs = ((body.msgs ?? []) as unknown[])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
  if (!msgs.length) return NextResponse.json({ ok: true, processed: 0 })
  if (msgs.length > MAX_MSGS) return NextResponse.json({ error: `max ${MAX_MSGS} msgs per batch` }, { status: 413 })

  try {
    await processBatch(msgs, Date.now() / 1000, sensor.id, sensor.uptime)
  } catch (e) {
    console.error('ingest failed', sensor.id, e)
    return NextResponse.json({ error: 'ingest failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, processed: msgs.length })
}
