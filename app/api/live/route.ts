import { NextResponse } from 'next/server'
import { live } from '@/lib/analytics'

export async function GET() {
  return NextResponse.json(await live())
}
