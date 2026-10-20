import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ sensor_id: string }> }) {
  const { sensor_id } = await params
  await prisma.sensors.delete({ where: { id: sensor_id } })
  return new NextResponse(null, { status: 204 })
}
