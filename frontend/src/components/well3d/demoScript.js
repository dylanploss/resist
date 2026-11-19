// Builds the scripted fly-through for the 3D well demo from the loaded well3d payload.
// Returns { speed, stops: [{ md, title, text }] } with stops in increasing MD.

const MIN_GAP = 0.03 // stops closer than this fraction of the well are merged
const SMOOTH = 0.02 // moving-mean window as a fraction of the samples, so a single spike is not picked
const EDGE = 0.03 // zone picks skip this fraction at each end, where start-up/TD readings are unreliable
const TRAVEL_S = 25 // target travel time for the whole well

const finite = (v) => v != null && Number.isFinite(v)
const fmtMd = (md) => `${Math.round(md).toLocaleString('en-US')} ft`
const fmtVal = (v) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(2) : v.toPrecision(3))
const fmtM = (v) => `${v.toFixed(1)} m`

function sampleValues(data) {
  return data.values.map((row) => {
    if (!data.image) return finite(row) ? row : null
    const ok = (row ?? []).filter(finite)
    return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null
  })
}

// One score per sample in colour space: log10 for resistivity, clipped to the colour range
// (2nd–98th percentile) so tool-limit spikes do not win.
function sampleScores(data, raw) {
  const { log10, zmin, zmax } = data.color ?? {}
  return raw.map((v) => {
    if (v == null || (log10 && v <= 0)) return null
    const z = log10 ? Math.log10(v) : v
    return zmin != null && zmax != null ? Math.min(zmax, Math.max(zmin, z)) : z
  })
}

function movingMean(values, half) {
  const out = new Array(values.length).fill(null)
  let sum = 0
  let count = 0
  const add = (v, s) => {
    if (v == null) return
    sum += s * v
    count += s
  }
  for (let i = 0; i < Math.min(half, values.length); i++) add(values[i], 1)
  for (let i = 0; i < values.length; i++) {
    if (i + half < values.length) add(values[i + half], 1)
    if (i - half - 1 >= 0) add(values[i - half - 1], -1)
    if (values[i] != null && count > 0) out[i] = sum / count
  }
  return out
}

function argExtreme(values, sign, from, to) {
  let best = -1
  for (let i = from; i < to; i++) {
    if (values[i] != null && (best < 0 || sign * (values[i] - values[best]) > 0)) best = i
  }
  return best
}

const doiAt = (data, i) => {
  const r = data.doi_m?.[i]
  if (r == null) return null
  return Array.isArray(r) ? Math.max(...r) : r
}

export function demoScript(data, mdStart, mdEnd) {
  const length = Math.max(mdEnd - mdStart, 1)
  const speed = Math.min(1000, Math.max(50, length / TRAVEL_S))
  const raw = sampleValues(data)
  const resistivity = Boolean(data.color?.log10)
  const smooth = movingMean(sampleScores(data, raw), Math.max(1, Math.round(raw.length * SMOOTH / 2)))
  const value = (i) => (resistivity ? 10 ** smooth[i] : smooth[i])
  const from = Math.floor(raw.length * EDGE)
  const to = Math.max(from + 1, raw.length - from)
  const unit = data.unit ? ` ${data.unit}` : ''
  const candidates = []

  const valueStop = (i, title, note) => {
    if (i < 0) return
    const doi = doiAt(data, i)
    const parts = [`MD ${fmtMd(data.md_ft[i])}`, `local mean ≈ ${fmtVal(value(i))}${unit}`]
    if (doi != null) parts.push(`DOI ${Array.isArray(data.doi_m[i]) ? 'up to' : '≈'} ${fmtM(doi)}`)
    candidates.push({ i, title, text: `${parts.join(' · ')}${note ? ` — ${note}` : ''}` })
  }
  const hi = argExtreme(smooth, 1, from, to)
  const lo = argExtreme(smooth, -1, from, to)
  if (resistivity) {
    valueStop(hi, 'Resistive zone', data.doi_m && 'the tube bulges where the tool reads deeper')
    valueStop(lo, 'Conductive zone', data.doi_m && 'the tube narrows where the tool reads shallower')
  } else {
    valueStop(hi, 'Highest value', null)
    valueStop(lo, 'Lowest value', null)
  }

  if (data.image && Array.isArray(data.doi_m?.[0])) {
    const spreads = data.doi_m.map((r) => Math.max(...r) - Math.min(...r))
    const best = argExtreme(movingMean(spreads, Math.max(1, Math.round(raw.length * SMOOTH / 4))), 1, from, to)
    if (best >= 0) {
      const r = data.doi_m[best]
      candidates.push({
        i: best,
        title: 'Largest DOI asymmetry',
        text: `MD ${fmtMd(data.md_ft[best])} · reach ${fmtM(Math.min(...r))}–${fmtM(Math.max(...r))} around the ring` +
          ' — the tube reaches further toward the resistive side',
      })
    }
  }
  const last = data.md_ft.length - 1
  candidates.push({ i: last, title: 'End of the well', text: `MD ${fmtMd(data.md_ft[last])} · TD of this run` })

  const stops = []
  for (const c of candidates) {
    const md = Math.min(mdEnd, Math.max(mdStart, data.md_ft[c.i]))
    if (stops.some((s) => Math.abs(s.md - md) < MIN_GAP * length)) continue
    stops.push({ md, title: c.title, text: c.text })
  }
  stops.sort((a, b) => a.md - b.md)
  return { speed, stops }
}
