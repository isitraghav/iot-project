import { NextRequest, NextResponse } from 'next/server'
import { devices } from '@/lib/analytics'

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  return NextResponse.json(await devices(
    p.get('range') ?? '24h',
    p.get('q') ?? '',
    p.get('tagged') === 'true',
    p.get('kind') ?? '',
    p.get('type') ?? '',
  ))
}
