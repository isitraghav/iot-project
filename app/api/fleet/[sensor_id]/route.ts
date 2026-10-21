import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ sensor_id: string }> }) {
  const { sensor_id } = await params
  const body = await req.json()
  const data: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = String(body.name).trim()
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    data.name = name
  }
  if (body.location !== undefined) data.location = String(body.location).trim() || null
  const { api_key: _k, ...sensor } = await prisma.sensors.update({ where: { id: sensor_id }, data })
  return NextResponse.json(sensor)
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ sensor_id: string }> }) {
  const { sensor_id } = await params
  await prisma.sensors.delete({ where: { id: sensor_id } })
  return new NextResponse(null, { status: 204 })
}
