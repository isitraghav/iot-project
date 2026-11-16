import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

// Serverless-friendly pool sizing: the Supabase pooler (pgbouncer) handles many client
// connections, so allow a few per instance and wait longer before giving up.
function pooledUrl(): string | undefined {
  const url = process.env.DATABASE_URL
  if (!url) return undefined
  const extra: string[] = []
  if (!/[?&]connection_limit=/.test(url)) extra.push('connection_limit=10')
  if (!/[?&]pool_timeout=/.test(url)) extra.push('pool_timeout=30')
  if (!extra.length) return url
  return url + (url.includes('?') ? '&' : '?') + extra.join('&')
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ log: [], datasources: { db: { url: pooledUrl() } } })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
