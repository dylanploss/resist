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
