import type { Metadata } from 'next'
import Script from 'next/script'

export const metadata: Metadata = { title: 'Billboard Audience' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
