import { readJson, badRequest } from '@/lib/http'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ sensor_id: string }> }) {
  const { sensor_id } = await params
  const body = await readJson(req)
  if (!body) return badRequest()
  const data: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = String(body.name).trim()
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    data.name = name
  }
  if (body.location !== undefined) data.location = String(body.location).trim() || null
  try {
    const { api_key: _k, ...sensor } = await prisma.sensors.update({ where: { id: sensor_id }, data })
    return NextResponse.json(sensor)
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ sensor_id: string }> }) {
  const { sensor_id } = await params
  try {
    await prisma.sensors.delete({ where: { id: sensor_id } })
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return new NextResponse(null, { status: 204 })
}
