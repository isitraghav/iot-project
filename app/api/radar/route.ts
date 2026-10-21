import { NextRequest, NextResponse } from 'next/server'
import { radar, sensorId } from '@/lib/analytics'

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const win = parseInt(p.get('window') ?? '0') || undefined
  const ap = p.get('ap') === 'true'
  return NextResponse.json(await radar(win, ap, sensorId(p.get('sensor'))))
}
