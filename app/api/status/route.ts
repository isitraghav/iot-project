import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const count = await prisma.sensors.count()
  return NextResponse.json({ source: 'cloud', connected: true, stale: false, sensors: count })
}
