// Formatting, ticks and colours ported from UDAR_Bench/source/app/util.js and chart.js.

export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
export const DASHES = [[], [7, 3], [2, 3], [8, 3, 2, 3]]

export function fmt(v, d = 2) {
  if (v === undefined || v === null || Number.isNaN(v)) return '–'
  if (!isFinite(v)) return v > 0 ? '∞' : '−∞'
  let s = v.toFixed(d)
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s.replace('-', '−')
}

export function fsig(v, n = 3) {
  if (v === undefined || v === null || Number.isNaN(v)) return '–'
  if (!isFinite(v)) return v > 0 ? '∞' : '−∞'
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e5 || a < 1e-3) return v.toExponential(n - 1).replace('e+', 'e').replace('-', '−')
  return fmt(v, Math.max(0, n - 1 - Math.floor(Math.log10(a))))
}

export function fmtDur(sec) {
  if (!isFinite(sec)) return '–'
  if (sec < 1) return `${fsig(sec, 2)} s`
  if (sec < 60) return `${Math.round(sec)} s`
  if (sec < 3600) return `${fsig(sec / 60, 2)} min`
  return `${fsig(sec / 3600, 2)} h`
}

function niceStep(range, n) {
  const raw = range / Math.max(1, n)
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / p
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p
}

export function niceTicks(lo, hi, n = 6) {
  if (!(hi > lo)) return [lo]
  const st = niceStep(hi - lo, n)
  const out = []
  for (let v = Math.ceil(lo / st - 1e-9) * st; v <= hi + st * 1e-9; v += st) out.push(Math.abs(v) < st * 1e-9 ? 0 : +v.toPrecision(12))
  return out
}

export function logTicks(lo, hi) {
  const out = []
  const a = Math.floor(Math.log10(lo))
  const b = Math.ceil(Math.log10(hi))
  const few = b - a <= 3
  for (let e = a; e <= b; e++) {
    for (const m of few ? [1, 2, 5] : [1]) {
      const v = m * Math.pow(10, e)
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v)
    }
  }
  return out
}

export function tickLabel(v, span) {
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e5 || a < 1e-3) return v.toExponential(0).replace('e+', 'e').replace('-', '−')
  const dec = span !== undefined && span > 0 ? Math.max(0, -Math.floor(Math.log10(span / 5))) : 0
  return fmt(v, Math.min(6, dec))
}

const BLUE = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b']
const BLUE_RGB = BLUE.map((x) => [parseInt(x.slice(1, 3), 16), parseInt(x.slice(3, 5), 16), parseInt(x.slice(5, 7), 16)])

export function rampColor(t) {
  const c = Math.min(1, Math.max(0, t))
  const x = c * (BLUE_RGB.length - 1)
  const i = Math.min(BLUE_RGB.length - 2, Math.floor(x))
  const f = x - i
  const a = BLUE_RGB[i]
  const b = BLUE_RGB[i + 1]
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`
}

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x))
export const clone = (o) => JSON.parse(JSON.stringify(o))

export function antName(o) {
  return o.k === 'T' ? `T(${fmt(o.th, 0)}°,${fmt(o.ph, 0)}°)` : o.k
}
export function chanName(c) {
  return `${antName(c.tx)}${antName(c.rx)} ${fmt(c.L, 2)} m ${fmt(c.f, 3)} kHz`
}
export function chanShort(c) {
  return antName(c.tx) + antName(c.rx)
}

export function toCSV(rows) {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = String(v)
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(','),
    )
    .join('\n')
}

export function downloadText(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
