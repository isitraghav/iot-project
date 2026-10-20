import { NextRequest } from 'next/server'
import { visitsCsv } from '@/lib/analytics'

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? '7d'
  const csv = await visitsCsv(range)
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="visits-${range}.csv"`,
    },
  })
}
