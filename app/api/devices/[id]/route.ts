import { NextRequest, NextResponse } from 'next/server'
import { deviceDetail } from '@/lib/analytics'
import { prisma } from '@/lib/prisma'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const d = await deviceDetail(id)
  if (!d) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(d)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const data: Record<string, unknown> = {}
  if (body.label !== undefined) data.label = (body.label as string).trim() || null
  if (body.ignored !== undefined) data.ignored = body.ignored ? 1 : 0
  await prisma.devices.update({ where: { id }, data })
  return NextResponse.json({ ok: true })
}
