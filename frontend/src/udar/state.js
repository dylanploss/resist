// Application state for the Modelling (UDAR) page, ported from UDAR_Bench/source/app/state.js and main.js.
// Only the 1D (planar dipping layers) mode is ported; the 2D section and the 2.5D solver are not.
import { getCore } from '../compute/udarCore.js'
import { SERIES_COLORS, DASHES, antName, chanName, chanShort, clamp, clone, fsig } from './format.js'

export const PRESETS_TOOL = {
  'Generic UDAR: 3 spacings, ZZ/ZX/XZ/XX': { spacings: [8, 16, 30], freqs: [100, 24, 6], comps: ['ZZ', 'ZX', 'XZ', 'XX'], pair: true },
  'Deep reading: 4 spacings, 2-24 kHz': { spacings: [10, 20, 30, 40], freqs: [24, 12, 6, 2], comps: ['ZZ', 'ZX', 'XZ'], pair: true },
  'Triaxial: 2 spacings × 2 frequencies': { spacings: [12, 24], freqs: [24, 6], comps: ['ZZ', 'XX', 'YY', 'ZX', 'XZ', 'XY', 'YX'], pair: false },
  'Axial only: ZZ at 3 spacings': { spacings: [8, 16, 30], freqs: [100, 24, 6], comps: ['ZZ'], pair: true },
}

export const PRESETS_GEO1 = {
  'Thin sand in shale': { dip: 1.5, dipAz: 180, z0: 2000, layers: [{ rh: 2, rv: 3, tvt: 0 }, { rh: 60, rv: 80, tvt: 8 }, { rh: 2, rv: 3, tvt: 0 }] },
  'Thick reservoir over water leg': { dip: 0.5, dipAz: 180, z0: 1996, layers: [{ rh: 2.5, rv: 4, tvt: 0 }, { rh: 90, rv: 110, tvt: 14 }, { rh: 1.2, rv: 1.5, tvt: 0 }] },
  'Five layers with laminated shale': {
    dip: 2,
    dipAz: 180,
    z0: 1999,
    layers: [{ rh: 3, rv: 6, tvt: 0 }, { rh: 25, rv: 40, tvt: 5 }, { rh: 100, rv: 120, tvt: 7 }, { rh: 8, rv: 12, tvt: 6 }, { rh: 1.5, rv: 2, tvt: 0 }],
  },
  'Homogeneous (reference)': { dip: 0, dipAz: 0, z0: 2000, layers: [{ rh: 10, rv: 10, tvt: 0 }] },
}

export const COMPONENTS = ['ZZ', 'ZX', 'XZ', 'XX', 'YY', 'XY', 'YX', 'YZ', 'ZY']

export function makeChannels(spec) {
  const rows = []
  const cmp = (c) => ({ k: c, th: 0, ph: 0 })
  spec.spacings.forEach((L, i) => {
    const fl = spec.pair ? [spec.freqs[Math.min(i, spec.freqs.length - 1)]] : spec.freqs
    for (const f of fl) for (const c of spec.comps) rows.push({ on: true, L, f, tx: cmp(c[0]), rx: cmp(c[1]) })
  })
  return rows
}

export function parseList(s) {
  return String(s)
    .split(/[,\s;]+/)
    .map(parseFloat)
    .filter((v) => isFinite(v) && v > 0)
}

export function defaultState() {
  return {
    v: 1,
    tab: 'tool',
    tool: {
      channels: makeChannels(PRESETS_TOOL['Generic UDAR: 3 spacings, ZZ/ZX/XZ/XX']),
      gen: { spacings: '8, 16, 30', freqs: '100, 24, 6', pair: true, comps: { ZZ: true, ZX: true, XZ: true, XX: true, YY: false, XY: false, YX: false, YZ: false, ZY: false } },
    },
    filter: 'key_201_2012',
    well: { md0: 0, N0: 0, E0: 0, D0: 1993, inc0: 88, az0: 0, sections: [{ len: 150, incEnd: 90, azEnd: 0 }, { len: 150, incEnd: 92, azEnd: 0 }], tf: 0, mdStart: 20, mdEnd: 280, mdStep: 2 },
    geo1: clone(PRESETS_GEO1['Thin sand in shale']),
    auto: true,
    cursorMd: 150,
    chartQty: 'ap',
    fwdSel: {},
    inv: {
      noise: { ampDb: 0.1, phaseDeg: 0.5, floorPpm: 100, biasDb: 0, biasDeg: 0, seed: 1 },
      off: [],
      nLayers: 3,
      perturb: { rho: 2, d: 3 },
      nStarts: 4,
      maxIter: 40,
      filter: 'key_101_2012',
      dipErr: 0,
      dipAzErr: 0,
      continuation: true,
      acceptChi2: 1.6,
      fitChan: 0,
      anisoFree: false,
    },
  }
}

const STORE_KEY = 'resist-udar-v1'

export function loadState() {
  const def = defaultState()
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return def
    const s = JSON.parse(raw)
    if (!s || s.v !== def.v) return def
    const merged = { ...def, ...s, tool: { ...def.tool, ...s.tool }, well: { ...def.well, ...s.well }, inv: { ...def.inv, ...s.inv, noise: { ...def.inv.noise, ...(s.inv && s.inv.noise) } } }
    cfgFromState(merged)
    return merged
  } catch {
    return def
  }
}

export function saveState(S) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S))
  } catch {
    /* storage may be unavailable */
  }
}

export function clearState() {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* storage may be unavailable */
  }
}

const chanSig = (c) => [c.L, c.f, antName(c.tx), antName(c.rx)].join('|')

export function cfgFromState(S) {
  const w = S.well
  const traj = { md0: w.md0, N0: w.N0, E0: w.E0, D0: w.D0, inc0: w.inc0, az0: w.az0, sections: w.sections.map((s) => ({ len: Math.max(0.5, s.len), incEnd: s.incEnd, azEnd: s.azEnd })) }
  let mdEnd = w.md0
  for (const s of traj.sections) mdEnd += s.len
  const mdStart = clamp(w.mdStart, w.md0, mdEnd)
  const mdStop = clamp(w.mdEnd, mdStart, mdEnd)
  const mdStep = Math.max(0.1, w.mdStep)
  const channels = S.tool.channels.filter((c) => c.on).map((c) => ({ L: c.L, f: c.f * 1000, tx: clone(c.tx), rx: clone(c.rx), name: chanName(c), sig: chanSig(c) }))
  const g1 = clone(S.geo1)
  g1.refN = traj.N0
  g1.refE = traj.E0
  return { traj, tf: w.tf, mdStart, mdEnd: mdStop, mdStep, channels, mode: '1d', geo1: g1, geo2: null, filter: S.filter, slopeWin: 5, eng2d: null, fd: null }
}

export function stationCount(cfg) {
  return Math.max(1, Math.floor((cfg.mdEnd - cfg.mdStart) / cfg.mdStep + 1e-9) + 1)
}

export function validate(cfg) {
  if (!cfg.channels.length) return 'Turn on at least one channel in the Tool tab.'
  for (const c of cfg.channels) if (!(Math.abs(c.L) > 0) || !(c.f > 0) || !isFinite(c.L) || !isFinite(c.f)) return 'Every channel needs a non-zero spacing and a positive frequency.'
  if (!(cfg.mdEnd >= cfg.mdStart)) return 'The logging interval is empty. Check the From and To depths.'
  if (stationCount(cfg) > 3000) return `The logging interval has ${stationCount(cfg)} stations. Increase the step to keep it below 3000.`
  for (const s of cfg.traj.sections) if (!isFinite(s.len) || !isFinite(s.incEnd) || !isFinite(s.azEnd)) return 'A wellbore section has a missing value.'
  const L = cfg.geo1.layers
  if (!L.length) return 'Add at least one layer.'
  for (const l of L) if (!(l.rh > 0) || !(l.rv > 0)) return 'Resistivities must be positive.'
  for (let k = 1; k < L.length - 1; k++) if (!(L[k].tvt > 0)) return 'Interior layers need a positive thickness.'
  return null
}

// Colour by (spacing, frequency) pair, dash by Tx/Rx configuration.
export function chanStyles(chs) {
  const pairs = []
  const cfgs = []
  return chs.map((c) => {
    const pk = `${c.L}|${c.f}`
    const ck = chanShort(c)
    let pi = pairs.indexOf(pk)
    if (pi < 0) pi = pairs.push(pk) - 1
    let ci = cfgs.indexOf(ck)
    if (ci < 0) ci = cfgs.push(ck) - 1
    return { color: SERIES_COLORS[pi % SERIES_COLORS.length], dash: DASHES[ci % DASHES.length] }
  })
}

const DB_FLOOR = 1e-9
export const PH_MIN_AMP = 1e-7
export const ampdb = (re, im) => 20 * Math.log10(Math.max(Math.hypot(re, im), DB_FLOOR))
const R2D = 180 / Math.PI

function unwrapDeg(a) {
  let last = null
  for (let i = 0; i < a.length; i++) {
    if (!isFinite(a[i])) continue
    if (last !== null) a[i] -= 360 * Math.round((a[i] - last) / 360)
    last = a[i]
  }
  return a
}

// Per-channel series from an interleaved (station, channel, re/im) array.
export function chanArrays(data, nSt, nch, c) {
  const re = new Float64Array(nSt)
  const im = new Float64Array(nSt)
  const amp = new Float64Array(nSt)
  const ph = new Float64Array(nSt)
  for (let i = 0; i < nSt; i++) {
    const k = 2 * (i * nch + c)
    re[i] = data[k]
    im[i] = data[k + 1]
    amp[i] = ampdb(re[i], im[i])
    ph[i] = Math.hypot(re[i], im[i]) > PH_MIN_AMP ? Math.atan2(im[i], re[i]) * R2D : NaN
  }
  unwrapDeg(ph)
  const first = ph.find((v) => isFinite(v))
  if (first !== undefined) {
    const sh = 360 * Math.round(first / 360)
    if (sh) for (let i = 0; i < nSt; i++) ph[i] -= sh
  }
  return { re, im, amp, ph }
}

export function ampYlim(series) {
  let mx = -Infinity
  let mn = Infinity
  for (const s of series) {
    for (const v of s.y) {
      if (!isFinite(v)) continue
      if (v > mx) mx = v
      if (v < mn) mn = v
    }
  }
  if (!isFinite(mx)) return null
  const lo = Math.max(mn, mx - 110)
  const pad = Math.max(1, (mx - lo) * 0.05)
  return [lo - pad, mx + pad]
}

export const pairKey = (c) => `${fsig(c.L, 3)} m, ${fsig(c.f / 1000, 3)} kHz`

export function stIndex(cfg, nSt, md) {
  return clamp(Math.round((md - cfg.mdStart) / cfg.mdStep), 0, nSt - 1)
}

// Signed angle between tool axis and bedding; positive when the tool heads toward deeper layers.
export function stationAngles(cfg, stations) {
  const { buildLocal1D, v3 } = getCore()
  const nrm = buildLocal1D(cfg.geo1).nrm
  return Float64Array.from(stations, (st) => Math.asin(clamp(v3.dot(nrm, st.zt), -1, 1)) * R2D)
}

// Vertical section along the well azimuth: layer polygons, boundary lines and the well path.
export function buildSection(cfg, tr) {
  const { buildLocal1D } = getCore()
  const loc = buildLocal1D(cfg.geo1)
  const n = tr.md.length - 1
  const dN = tr.N[n] - tr.N[0]
  const dE = tr.E[n] - tr.E[0]
  const az = Math.hypot(dN, dE) > 1 ? Math.atan2(dE, dN) : (cfg.geo1.dipAz * Math.PI) / 180
  const vs = (N, E) => (N - cfg.traj.N0) * Math.cos(az) + (E - cfg.traj.E0) * Math.sin(az)
  const step = Math.max(1, Math.floor(tr.md.length / 600))
  const well = []
  for (let i = 0; i < tr.md.length; i += step) well.push([vs(tr.N[i], tr.E[i]), tr.D[i], tr.md[i]])
  if (n % step !== 0) well.push([vs(tr.N[n], tr.E[n]), tr.D[n], tr.md[n]])
  let xa = Infinity
  let xb = -Infinity
  let za = Infinity
  let zb = -Infinity
  for (const p of well) {
    xa = Math.min(xa, p[0])
    xb = Math.max(xb, p[0])
    za = Math.min(za, p[1])
    zb = Math.max(zb, p[1])
  }
  const padx = Math.max(15, (xb - xa) * 0.06)
  xa -= padx
  xb += padx
  let z0 = za - 22
  let z1 = zb + 22
  if (z1 - z0 < 60) {
    const m = (z0 + z1) / 2
    z0 = m - 30
    z1 = m + 30
  }
  const nrm = loc.nrm
  const depthAt = (k, x) => {
    const N = cfg.traj.N0 + x * Math.cos(az)
    const E = cfg.traj.E0 + x * Math.sin(az)
    return (loc.zi[k] - nrm[0] * N - nrm[1] * E) / nrm[2]
  }
  const boundaries = []
  for (let k = 0; k < loc.zi.length; k++) boundaries.push([[xa, depthAt(k, xa)], [xb, depthAt(k, xb)]])
  const rh = Array.from(loc.sh, (s) => 1 / s)
  const rv = Array.from(loc.sv, (s) => 1 / s)
  return { x0: xa, x1: xb, z0, z1, boundaries, rh, rv, well, vs }
}

export function specFreeCount(spec) {
  return spec.layers.reduce((a, l) => a + (l.rh.free ? 1 : 0) + (l.kv.free ? 1 : 0), 0) + (spec.d1.free ? 1 : 0) + spec.t.reduce((a, p) => a + (p.free ? 1 : 0), 0)
}

const mkParam = (v, lo, hi, free) => ({ v, lo, hi, free: !!free })

// Starting model: the true geology at the first station, perturbed by the user's initial error factors.
export function defaultSpec(S, cfg, nL) {
  const { buildTrajectory, makeStation, truthAt } = getCore()
  const pr = S.inv.perturb
  const hasTruth = nL === cfg.geo1.layers.length
  const tr = buildTrajectory(cfg.traj, 1)
  const st = makeStation(tr, cfg.mdStart, cfg.tf)
  const tt = truthAt(cfg, st)
  const layers = []
  const t = []
  for (let k = 0; k < nL; k++) {
    let rh
    let kv
    if (hasTruth) {
      rh = tt.rh[k] * Math.pow(Math.max(1.0001, pr.rho), k % 2 === 0 ? 1 : -1)
      kv = Math.max(1, tt.rv[k] / tt.rh[k])
    } else {
      rh = Math.pow(10, 0.5 + 1.5 * (k % 2 === 0 ? 0 : 1))
      kv = 1.3
    }
    layers.push({ rh: mkParam(+rh.toPrecision(3), 0.1, 3000, true), kv: mkParam(+kv.toPrecision(3), 1, 8, S.inv.anisoFree) })
  }
  const d1 = +(hasTruth ? tt.zi[0] + pr.d : -5).toFixed(2)
  for (let k = 0; k < nL - 2; k++) t.push(mkParam(hasTruth ? +Math.max(1, (tt.zi[k + 1] - tt.zi[k]) * 0.8).toFixed(2) : 6, 0.3, 80, true))
  return { layers, d1: mkParam(d1, -60, 60, true), t }
}

export function icfgFromState(S, cfg, spec) {
  const iv = S.inv
  const sel = []
  cfg.channels.forEach((c, i) => {
    if (iv.off.indexOf(c.sig) < 0) sel.push(i)
  })
  return {
    spec: clone(spec),
    channels: sel,
    assumed: { ampDb: iv.noise.ampDb, phaseDeg: iv.noise.phaseDeg, floorPpm: iv.noise.floorPpm },
    nStarts: iv.nStarts,
    maxIter: iv.maxIter,
    filter: iv.filter,
    dipErr: iv.dipErr,
    dipAzErr: iv.dipAzErr,
    continuation: iv.continuation,
    startSpread: { lnRho: 1.2, d: 6 },
    seed: iv.noise.seed * 7 + 3,
    acceptChi2: iv.acceptChi2,
    screen: 60,
    refinePasses: 2,
  }
}
