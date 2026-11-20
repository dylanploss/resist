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

const postJson = (path, body) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const getSavedSelection = (run) => request(`${runPath(run)}/selection`)

export const getAutoSelection = (run) => request(`${runPath(run)}/qc`)

export const getInversionDefaults = (run) => request(`/inversion/defaults?run=${encodeURIComponent(run)}`)

export const postInversionPlan = (body) => postJson('/inversion/plan', body)

export const postInversionSection = (body) => postJson('/inversion/section', body)

export const postInversionJob = (body) => postJson('/inversion/jobs', body)

export const getInversionTargets = () => request('/inversion/targets')

export const getInversionJob = (id) => request(`/inversion/jobs/${encodeURIComponent(id)}`)

export const getFacetDefaults = (run) => request(`/inversion3d/defaults?run=${encodeURIComponent(run)}`)

export const postFacetPlan = (body) => postJson('/inversion3d/plan', body)

export const postFacetJob = (body) => postJson('/inversion3d/jobs', body)

export const getFacetJob = (id) => request(`/inversion3d/jobs/${encodeURIComponent(id)}`)

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
