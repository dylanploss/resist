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

const FREQ_ORDER = { 2000000: 0, 500000: 1, 125000: 2 }

// Resistivity before geosignal, then spacing and frequency (shallow to deep), then phase before attenuation.
function groupKey(row) {
  const kind = row.family === 'conventional' ? 2 : row.family === 'ZG' ? 1 : 0
  return [kind, row.spacing_in ?? 0, FREQ_ORDER[row.frequency_hz] ?? 9,
    row.measurement === 'attenuation' ? 1 : 0, row.family === 'ZR' ? 1 : 0, row.name]
}

export function compareGroup(a, b) {
  const ka = groupKey(a)
  const kb = groupKey(b)
  const i = ka.findIndex((v, j) => v !== kb[j])
  return i < 0 ? 0 : ka[i] < kb[i] ? -1 : 1
}

export function groupLabel(row) {
  if (row.family === 'conventional') return 'Other logs'
  return `${row.family === 'ZG' ? 'Geosignal' : 'Resistivity'} · ${row.spacing_in} in`
}
