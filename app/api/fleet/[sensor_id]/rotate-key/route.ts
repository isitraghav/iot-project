import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { randomBytes } from 'crypto'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ sensor_id: string }> }) {
  const { sensor_id } = await params
  const api_key = randomBytes(32).toString('base64url')
  await prisma.sensors.update({ where: { id: sensor_id }, data: { api_key } })
  return NextResponse.json({ api_key })
}
