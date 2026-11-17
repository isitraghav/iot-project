import { NextResponse } from 'next/server'

// Parse a JSON body, returning null on malformed input instead of throwing a 500.
export async function readJson(req: Request): Promise<Record<string, any> | null> {
  try {
    const b = await req.json()
    return b && typeof b === 'object' ? b : null
  } catch {
    return null
  }
}

export const badRequest = (msg = 'invalid JSON body') => NextResponse.json({ error: msg }, { status: 400 })
