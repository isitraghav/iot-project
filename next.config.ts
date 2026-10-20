import type { NextConfig } from 'next'

const config: NextConfig = {
  // Allow large API responses for CSV export
  api: { responseLimit: false },
}

export default config
