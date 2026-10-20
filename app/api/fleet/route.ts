import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { randomBytes } from 'crypto'

export async function GET() {
  const sensors = await prisma.sensors.findMany({ orderBy: { created_at: 'asc' } })
  return NextResponse.json(sensors.map(({ api_key: _k, ...s }) => s))
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const name = (body.name as string)?.trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const id = randomBytes(6).toString('hex')
  const api_key = randomBytes(32).toString('base64url')
  const sensor = await prisma.sensors.create({
    data: { id, name, api_key, location: (body.location as string)?.trim() || null, created_at: Date.now() / 1000 },
  })
  return NextResponse.json(sensor, { status: 201 })
}
