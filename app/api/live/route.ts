import { NextRequest, NextResponse } from 'next/server'
import { live, sensorId } from '@/lib/analytics'

export async function GET(req: NextRequest) {
  return NextResponse.json(await live(60, sensorId(req.nextUrl.searchParams.get('sensor'))))
}
