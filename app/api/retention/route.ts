import { NextRequest, NextResponse } from 'next/server'
import { retention, sensorId } from '@/lib/analytics'

export async function GET(req: NextRequest) {
  const days = Math.max(2, Math.min(parseInt(req.nextUrl.searchParams.get('days') ?? '14'), 90))
  return NextResponse.json(await retention(days, sensorId(req.nextUrl.searchParams.get('sensor'))))
}
