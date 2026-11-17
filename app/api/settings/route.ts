import { readJson, badRequest } from '@/lib/http'
import { NextRequest, NextResponse } from 'next/server'
import { getSettings, saveSettings } from '@/lib/settings'

export async function GET() {
  return NextResponse.json(await getSettings())
}

export async function PUT(req: NextRequest) {
  const body = await readJson(req)
  if (!body) return badRequest()
  await saveSettings(body)
  return NextResponse.json(await getSettings())
}
