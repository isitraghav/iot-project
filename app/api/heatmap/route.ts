import { NextRequest, NextResponse } from 'next/server'
import { heatmap, sensorId } from '@/lib/analytics'

export async function GET(req: NextRequest) {
  const days = parseInt(req.nextUrl.searchParams.get('days') ?? '28')
  return NextResponse.json(await heatmap(days, sensorId(req.nextUrl.searchParams.get('sensor'))))
}
