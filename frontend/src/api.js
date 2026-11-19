export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/+$/, '')

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request(path, options) {
  let response
  try {
    response = await fetch(`${API_URL}${path}`, options)
  } catch (e) {
    throw new ApiError(`Backend not reachable at ${API_URL} (${e.message})`, 0)
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const message = body && body.error ? body.error : `HTTP ${response.status} ${response.statusText}`
    throw new ApiError(message, response.status)
  }
  if (body === null) throw new ApiError('Backend returned no JSON body', response.status)
  return body
}

export const getHealth = () => request('/health')

export const getRuns = () => request('/runs')

export const getCurves = (run) => request(`/curves?run=${encodeURIComponent(run)}`)

export const getCurveData = (run, curves) =>
  request(`/curves/${encodeURIComponent(run)}/data?curves=${curves.map(encodeURIComponent).join(',')}`)

export const postQcSelect = (run, nSelect) =>
  request('/qc/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run, n_select: nSelect }),
  })

// Helpers shared by the QC visualization components.
export const runPath = (run) => `/runs/${encodeURIComponent(run)}`

export const api = (path, options) => request(path, options)

export const FREQ_LABEL = { 2000000: '2 MHz', 500000: '500 kHz', 125000: '125 kHz' }

export const STATUS = {
  auto: { label: 'auto-pick', chip: 'success', color: '#2e7d32' },
  candidate: { label: 'candidate', chip: 'info', color: '#1976d2' },
  duplicate: { label: 'duplicate', chip: 'default', color: '#78909c' },
  rejected: { label: 'rejected', chip: 'error', color: '#d32f2f' },
  context: { label: 'context log', chip: 'default', color: '#424242' },
}

export const fmt = (value, digits = 2) => (value == null ? '–' : value.toFixed(digits))
