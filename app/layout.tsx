import type { Metadata, Viewport } from 'next'
import Script from 'next/script'

export const metadata: Metadata = { title: 'Billboard Fleet', description: 'Audience measurement and fleet health for billboard sensors' }
export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover',
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f3f3f0' }, { media: '(prefers-color-scheme: dark)', color: '#0d0d0d' }],
}

// Applied before first paint so a saved theme never flashes the other one
const THEME_BOOT = `try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        {children}
        <Script
          src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"
          strategy="beforeInteractive"
        />
        <Script src="/app.js" strategy="afterInteractive" />
        <Script src="/radar.js" strategy="afterInteractive" />
      </body>
    </html>
  )
}
