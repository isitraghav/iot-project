import OUI from './oui.json'

// Bluetooth SIG company identifiers most often heard near a billboard
const BLE_COMPANIES: Record<number, string> = {
  0x0006: 'Microsoft', 0x000f: 'Broadcom', 0x001d: 'Qualcomm', 0x004c: 'Apple', 0x0059: 'Nordic',
  0x005d: 'Realtek', 0x006b: 'Polar', 0x0075: 'Samsung', 0x0087: 'Garmin', 0x009e: 'Bose',
  0x00c4: 'LG', 0x00e0: 'Google', 0x012d: 'Sony', 0x0157: 'Huami', 0x0171: 'Amazon',
  0x027d: 'Huawei', 0x02e5: 'Espressif', 0x02ff: 'Silicon Labs', 0x038f: 'Xiaomi', 0x0499: 'Ruuvi',
}

export function normMac(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '')
  return hex.length === 12 ? hex.match(/../g)!.join(':') : mac.toLowerCase()
}

export function ouiVendor(mac: string): string | null {
  return (OUI as Record<string, string>)[mac.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6)] || null
}

export function bleCompany(companyId: number | null | undefined): string | null {
  if (companyId == null || companyId < 0) return null
  return BLE_COMPANIES[companyId] || `BLE 0x${companyId.toString(16).padStart(4, '0').toUpperCase()}`
}

// Company id from raw manufacturer data ("4c0010…" → 0x004C)
export function mdCompany(md: string | null | undefined): number | null {
  if (!md || md.length < 4) return null
  return parseInt(md.slice(2, 4) + md.slice(0, 2), 16)
}

// Randomized addresses carry no registered prefix, so only stable ones get an OUI lookup.
// BLE devices advertise their maker in manufacturer data, which wins when present.
export function deviceVendor(kind: string, mac: string, randomized: number, mfr: number | null): string | null {
  if (kind === 'ble') {
    const c = bleCompany(mfr)
    if (c && !c.startsWith('BLE 0x')) return c
    return (!randomized && ouiVendor(mac)) || c
  }
  return randomized ? null : ouiVendor(mac)
}
