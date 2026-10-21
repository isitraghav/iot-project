import { NextRequest, NextResponse } from 'next/server'
import { bands, sensorId } from '@/lib/analytics'

export async function GET(req: NextRequest) {
  return NextResponse.json(await bands(req.nextUrl.searchParams.get('range') ?? '24h', sensorId(req.nextUrl.searchParams.get('sensor'))))
}
