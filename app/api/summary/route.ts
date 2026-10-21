import { NextRequest, NextResponse } from 'next/server'
import { summary, sensorId } from '@/lib/analytics'

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? '24h'
  return NextResponse.json(await summary(range, sensorId(req.nextUrl.searchParams.get('sensor'))))
}
