import { NextRequest, NextResponse } from 'next/server'

// Everything except sensor ingest (Bearer key) and the health probe sits behind HTTP Basic auth.
// Set DASHBOARD_PASSWORD (and optionally DASHBOARD_USER, default "admin").
// If the password is unset in production the app refuses to serve rather than run open.
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

export function middleware(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD
  if (!password) {
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('DASHBOARD_PASSWORD is not configured', { status: 503 })
    }
    return NextResponse.next()
  }
  const user = process.env.DASHBOARD_USER || 'admin'
  const header = req.headers.get('authorization') ?? ''
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6))
      const i = decoded.indexOf(':')
      if (i >= 0 && safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), password)) {
        return NextResponse.next()
      }
    } catch { /* fall through */ }
  }
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Billboard Fleet", charset="UTF-8"' },
  })
}

export const config = {
  matcher: ['/((?!api/ingest|api/health|_next/static|_next/image|favicon.ico).*)'],
}
