export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000'

export const runPath = (run) => `/runs/${encodeURIComponent(run)}`

export async function api(path, options) {
  const response = await fetch(`${API_URL}${path}`, options)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const detail = typeof body.detail === 'string' ? body.detail : body.error
    throw new Error(detail ?? `HTTP ${response.status}`)
  }
  return response.json()
}

export const FREQ_LABEL = { 2000000: '2 MHz', 500000: '500 kHz', 125000: '125 kHz' }

export const STATUS = {
  auto: { label: 'auto-pick', chip: 'success', color: '#2e7d32' },
  candidate: { label: 'candidate', chip: 'info', color: '#1976d2' },
  duplicate: { label: 'duplicate', chip: 'default', color: '#78909c' },
  rejected: { label: 'rejected', chip: 'error', color: '#d32f2f' },
  context: { label: 'context log', chip: 'default', color: '#424242' },
}

export const fmt = (value, digits = 2) => (value == null ? '–' : value.toFixed(digits))
