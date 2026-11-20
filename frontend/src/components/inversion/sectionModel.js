// Shared model of the inversion curtain section: the 2D section workbench and the 3D curtain both sample it.
// Each slice is its own layered 1.5D model (backend/inversion/service.py _slice_entry); a point (MD, TVD) takes the
// layer of the slice that owns its MD ("own") or the mean over every slice whose data window covers it ("mean").
import { sampleStops } from '../well3d/colormap.js'

// Low to high resistivity, log scale.
export const RH_STOPS = [[0, [69, 117, 180]], [0.35, [145, 191, 219]], [0.55, [254, 224, 144]], [0.75, [252, 141, 89]],
  [1, [215, 48, 39]]]
export const RH_TICKS = [0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000, 3000]
export const DEFAULT_COLOR_RANGE = [1, 300]
// Fade ramp width in uncertainty-rank units: a cell fades out over this band as the slider passes its rank.
const FADE_RAMP = 0.08
const DEFAULT_ROWS = 300

export function colorRange(range) {
  const cmin = Number(range?.[0]) > 0 ? Number(range[0]) : DEFAULT_COLOR_RANGE[0]
  const cmax = Number(range?.[1]) > cmin ? Number(range[1]) : Math.max(cmin * 10, DEFAULT_COLOR_RANGE[1])
  return [cmin, cmax]
}

export function rhRgb(logRh, [cmin, cmax]) {
  const a = Math.log10(cmin)
  return sampleStops(RH_STOPS, (logRh - a) / (Math.log10(cmax) - a || 1))
}

// Points (x, y) with both finite, x ascending.
function pairs(xs, ys) {
  const x = []
  const y = []
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] != null && ys[i] != null && Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      x.push(xs[i])
      y.push(ys[i])
    }
  }
  return { x, y }
}

// Linear interpolation, clamped to the end values (null when there are no points).
export function interpPairs({ x, y }, v) {
  const n = x.length
  if (!n) return null
  if (n === 1 || v <= x[0]) return y[0]
  if (v >= x[n - 1]) return y[n - 1]
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (x[mid] <= v) lo = mid
    else hi = mid
  }
  return y[lo] + (y[hi] - y[lo]) * (v - x[lo]) / (x[hi] - x[lo] || 1)
}

export const interp = (xs, ys, v) => interpPairs(pairs(xs, ys), v)

export function prepareSlices(slices) {
  return (slices ?? []).map((s) => ({
    ...s,
    bnd: s.boundary_tvd_ft.map((b) => pairs(s.md_ft, b)),
    logRh: s.layers.map((l) => Math.log10(l.rh)),
    sigma: s.rh_std_log ?? null,
  }))
}

// Layer index of a prepared slice at (md, tvd): boundaries are ordered shallow to deep.
export function layerAt(prep, md, tvd) {
  let k = 0
  for (const b of prep.bnd) {
    const z = interpPairs(b, md)
    if (z == null || z > tvd) break
    k++
  }
  return k
}

export function ownerSlice(prepared, md) {
  return prepared.find((s) => md >= s.slice_min_ft && md < s.slice_max_ft)
    ?? (prepared.length && md === prepared.at(-1).slice_max_ft ? prepared.at(-1) : null)
}

// Gridded section over the slices' MD span and the well's TVD ± h. Per cell: own-slice log Rh, mean log Rh over
// covering slices, their spread, and an uncertainty (posterior std of the layer's log Rh combined with the spread;
// old results without rh_std_log use the spread plus distance from the well). `rank` is the uncertainty percentile
// (0 = most certain), which the fade slider thresholds so the most uncertain layers disappear first.
export function buildSection(path, slices, h, rows = DEFAULT_ROWS) {
  const prepared = prepareSlices(slices)
  if (!prepared.length) return null
  const well = pairs(path.md_ft, path.tvd_ft)
  if (!well.x.length) return null
  const sliceFt = Math.max(0.5, prepared[0].slice_max_ft - prepared[0].slice_min_ft)
  const x0 = prepared[0].slice_min_ft
  const x1 = prepared.at(-1).slice_max_ft
  const dx = Math.max(0.5, sliceFt / 4)
  const nx = Math.max(1, Math.ceil((x1 - x0) / dx))
  const lo = Math.min(...well.y) - h
  const hi = Math.max(...well.y) + h
  const ny = rows
  const dz = (hi - lo) / ny
  const size = nx * ny
  const own = new Float32Array(size).fill(NaN)
  const mean = new Float32Array(size).fill(NaN)
  const unc = new Float32Array(size).fill(NaN)
  const ownUnc = new Float32Array(size).fill(NaN)
  const spread = new Float32Array(size).fill(NaN)
  const count = new Uint8Array(size)
  const ownIdx = new Int16Array(nx).fill(-1)
  const wellAt = new Float32Array(nx)
  const hasSigma = prepared.some((s) => s.sigma)
  for (let c = 0; c < nx; c++) {
    const md = x0 + (c + 0.5) * dx
    const w = interpPairs(well, md)
    wellAt[c] = w
    const ownS = ownerSlice(prepared, md)
    ownIdx[c] = ownS ? prepared.indexOf(ownS) : -1
    const covering = prepared.filter((s) => md >= s.window_min_ft && md <= s.window_max_ft)
    const ownBounds = ownS ? ownS.bnd.map((b) => interpPairs(b, md)) : null
    const covBounds = covering.map((s) => s.bnd.map((b) => interpPairs(b, md)))
    for (let r = 0; r < ny; r++) {
      const z = lo + (r + 0.5) * dz
      if (Math.abs(z - w) > h) continue
      const i = r * nx + c
      const proxy = 0.3 * Math.abs(z - w) / h
      if (ownS) {
        let k = 0
        while (k < ownBounds.length && ownBounds[k] != null && ownBounds[k] <= z) k++
        own[i] = ownS.logRh[k]
        ownUnc[i] = hasSigma && ownS.sigma ? ownS.sigma[k] : proxy
      }
      if (!covering.length) continue
      let sum = 0
      let sum2 = 0
      let sig = 0
      for (let j = 0; j < covering.length; j++) {
        const bs = covBounds[j]
        let k = 0
        while (k < bs.length && bs[k] != null && bs[k] <= z) k++
        const v = covering[j].logRh[k]
        sum += v
        sum2 += v * v
        sig += hasSigma && covering[j].sigma ? covering[j].sigma[k] : proxy
      }
      const m = sum / covering.length
      const sd = Math.sqrt(Math.max(0, sum2 / covering.length - m * m))
      mean[i] = m
      spread[i] = sd
      count[i] = Math.min(255, covering.length)
      const s = sig / covering.length
      unc[i] = Math.sqrt(s * s + sd * sd)
      if (!Number.isNaN(ownUnc[i])) ownUnc[i] = Math.sqrt(ownUnc[i] ** 2 + sd * sd)
    }
  }
  return { prepared, x0, x1, dx, nx, ny, lo, hi, dz, own, mean, spread, count, ownIdx, wellAt, hasSigma,
    ownUnc, unc, ownRank: ranks(ownUnc), meanRank: ranks(unc) }
}

function ranks(values) {
  const finite = []
  for (const v of values) if (!Number.isNaN(v)) finite.push(v)
  finite.sort((a, b) => a - b)
  const out = new Float32Array(values.length).fill(NaN)
  const n = finite.length
  if (!n) return out
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isNaN(v)) continue
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (finite[mid] < v) lo = mid + 1
      else hi = mid
    }
    out[i] = n > 1 ? lo / (n - 1) : 0
  }
  return out
}

// Opacity of a cell with uncertainty rank `rank` (0 certain .. 1 most uncertain) at fade level `fade` (0 .. 1).
export function fadeAlpha(rank, fade) {
  if (!(fade > 0)) return 1
  return Math.min(1, Math.max(0, ((1 - fade) - rank) / FADE_RAMP + 1))
}

// Cell lookup: values of the grid at (md, tvd) for the chosen view, or null outside the section.
export function sectionCell(grid, md, tvd, view) {
  if (!grid) return null
  const c = Math.floor((md - grid.x0) / grid.dx)
  const r = Math.floor((tvd - grid.lo) / grid.dz)
  if (c < 0 || c >= grid.nx || r < 0 || r >= grid.ny) return null
  const i = r * grid.nx + c
  const v = view === 'mean' ? grid.mean[i] : grid.own[i]
  if (Number.isNaN(v)) return null
  return {
    logRh: v, rank: view === 'mean' ? grid.meanRank[i] : grid.ownRank[i],
    unc: view === 'mean' ? grid.unc[i] : grid.ownUnc[i],
    spread: grid.spread[i], count: grid.count[i],
    slice: grid.ownIdx[c] >= 0 ? grid.prepared[grid.ownIdx[c]] : null,
  }
}

// Cumulative horizontal displacement (ft) along the well from inclination, for apparent dips in the MD/TVD section.
export function horizontalDisplacement(path) {
  const { md_ft: md, inclination_deg: inc, tvd_ft: tvd } = path
  const out = new Array(md.length).fill(null)
  let h = 0
  for (let i = 0; i < md.length; i++) {
    if (i > 0 && md[i] != null && md[i - 1] != null) {
      const dm = md[i] - md[i - 1]
      const a = inc?.[i]
      const b = inc?.[i - 1]
      if (a != null && b != null) {
        h += dm * (Math.sin(a * Math.PI / 180) + Math.sin(b * Math.PI / 180)) / 2
      } else if (tvd[i] != null && tvd[i - 1] != null) {
        h += Math.sqrt(Math.max(0, dm * dm - (tvd[i] - tvd[i - 1]) ** 2))
      }
    }
    out[i] = h
  }
  return out
}

// Apparent dip (deg, positive = deepening with MD) of a section line along the well's vertical section.
export function apparentDip(line, path, hd) {
  const p = pairs(path.md_ft, hd)
  const extrap = (md) => {
    const n = p.x.length
    if (n < 2) return md
    if (md < p.x[0]) return p.y[0] + (md - p.x[0]) * (p.y[1] - p.y[0]) / (p.x[1] - p.x[0] || 1)
    if (md > p.x[n - 1]) return p.y[n - 1] + (md - p.x[n - 1]) * (p.y[n - 1] - p.y[n - 2]) / (p.x[n - 1] - p.x[n - 2] || 1)
    return interpPairs(p, md)
  }
  const dh = extrap(line.md2_ft) - extrap(line.md1_ft)
  if (Math.abs(dh) < 0.01) return null
  return Math.atan((line.tvd2_ft - line.tvd1_ft) / dh) * 180 / Math.PI
}
