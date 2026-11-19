import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { api } from '../../api.js'
import { useApi } from '../../hooks/useApi.js'
import { colorFn } from './colormap.js'
import { locate } from './path.js'

// Inversion layer boundaries in the 3D well view. Geometry comes from GET /inversion/jobs/{id}/layers
// (backend/inversion/layers.py): per boundary and station the boundary TVD, the perpendicular distance
// to the well and whether it is above; normal_ned tilts the boundary sideways by dip and dip azimuth.

const FT = 0.3048
const UP = new THREE.Vector3(0, 1, 0)
const EAST = new THREE.Vector3(1, 0, 0)

// Finished inversion jobs of the run (refreshed whenever the tab becomes active) and the picked job's geometry.
// The newest job is shown unless the user picked another one.
export function useInversionLayers(run, active) {
  const [list, setList] = useState({ run: null, jobs: [], error: null })
  useEffect(() => {
    if (!run || !active) return undefined
    let alive = true
    api(`/inversion/jobs?run=${encodeURIComponent(run)}`).then(
      (body) => alive && setList({ run, jobs: body.jobs, error: null }),
      (e) => alive && setList({ run, jobs: [], error: e.message }),
    )
    return () => {
      alive = false
    }
  }, [run, active])
  const jobs = list.run === run ? list.jobs : []
  const [pick, setPick] = useState({ run: null, id: null })
  const id = pick.run === run && jobs.some((j) => j.id === pick.id) ? pick.id : jobs[0]?.id ?? null
  const [show, setShow] = useState(true)
  const geometry = useApi(() => api(`/inversion/jobs/${encodeURIComponent(id)}/layers`),
    id && show ? `inversion-layers|${id}` : null)
  return {
    jobs, id, show, setShow,
    setId: (value) => setPick({ run, id: value }),
    ready: list.run === run,
    layers: show ? geometry.data : null,
    loading: geometry.loading,
    error: list.run === run ? list.error ?? geometry.error?.message ?? null : null,
  }
}

// Boundaries share the tube's colour scale when the curve is a resistivity (Jet, log10), else Jet over the layers.
export function layerColorSpec(layers, curveSpec) {
  if (curveSpec?.scale === 'Jet' && curveSpec.log10) return curveSpec
  const logs = layers.layers.map((l) => Math.log10(l.rh))
  return { scale: 'Jet', reverse: false, log10: true, zmin: Math.min(...logs) - 0.1, zmax: Math.max(...logs) + 0.1 }
}

export const rgbCss = ([r, g, b]) => `rgb(${r},${g},${b})`

export const boundaryColor = (spec, boundary) => colorFn(spec)(boundary.rh_below)

// DOI (m) of the shown curve at a sample, looking toward the boundary: per-bin rings use the
// high-side bin (0) for a boundary above and the low-side bin (bins/2) for one below.
export function doiToward(data, i, above) {
  const r = data.doi_m?.[i]
  if (r == null) return null
  if (!Array.isArray(r)) return r
  return r[above ? 0 : Math.floor(r.length / 2)]
}

// Nearest station index for a measured depth, or -1 outside the inverted interval (half a step of slack).
export function stationAt(layers, md) {
  const mds = layers.md_ft
  const n = mds.length
  if (!n) return -1
  const half = n > 1 ? (mds[n - 1] - mds[0]) / (n - 1) / 2 : 1
  if (md < mds[0] - half || md > mds[n - 1] + half) return -1
  const { i, f } = locate({ md: mds, n }, md)
  return Math.min(n - 1, f < 0.5 ? i : i + 1)
}

// Nearest boundary at a measured depth, and whether the shown curve's DOI reaches it.
export function nearestReading(layers, data, sampleIndex, md) {
  const j = stationAt(layers, md)
  if (j < 0) return null
  const k = layers.nearest.boundary[j]
  if (k == null) return { station: j, boundary: null }
  const distance = layers.nearest.distance_m[j]
  const above = layers.nearest.above[j]
  const doi = doiToward(data, sampleIndex, above)
  return { station: j, boundary: k, distance, above, doi, seen: doi == null ? null : distance < doi }
}

// Runs [a, b] of path sample indices where the nearest boundary lies within the DOI.
export function seenRuns(layers, data, path) {
  const runs = []
  let start = -1
  for (let i = 0; i <= path.n; i++) {
    const reading = i < path.n ? nearestReading(layers, data, i, path.md[i]) : null
    const seen = Boolean(reading?.seen)
    if (seen && start < 0) start = i
    if (!seen && start >= 0) {
      runs.push([Math.max(0, start - 1), Math.min(path.n - 1, i)])
      start = -1
    }
  }
  return runs
}

// Sub-path of samples a..b (inclusive) that buildTube accepts.
export function slicePath(path, a, b) {
  const s = (arr) => arr.subarray(3 * a, 3 * (b + 1))
  return { n: b - a + 1, md: path.md.slice(a, b + 1), pos: s(path.pos), tan: s(path.tan), high: s(path.high), right: s(path.right) }
}

// Scene position of boundary k at station j: the well point at that MD moved vertically to the boundary TVD.
export function boundaryPoint(layers, k, j, frame, exaggeration, out) {
  const tvdB = layers.boundaries[k].tvd_ft[j]
  const tvdW = layers.tvd_ft[j]
  if (tvdB == null || tvdW == null) return null
  return out.copy(frame.pos).addScaledVector(UP, (tvdW - tvdB) * FT * exaggeration)
}

// Horizontal unit vector perpendicular to the well, and the scene offset of moving `s` metres along it
// inside the dipping boundary plane (scene: x east, y up x exaggeration, z south; normal is N, E, D).
export function sideOffset(tangent, normal, exaggeration, out) {
  out.set(-tangent.z, 0, tangent.x)
  if (out.lengthSq() < 1e-8) out.copy(EAST)
  out.normalize()
  const [nN, nE, nD] = normal
  const dE = out.x
  const dN = -out.z
  const dD = nD > 1e-6 ? -(nN * dN + nE * dE) / nD : 0
  out.y = -dD * exaggeration
  return out
}
