// Colour scales copied from plotly.js-dist-min so the 3D view matches the QC tab heatmaps.
// `npm run check:colormap` compares these stops and the interpolation with the installed Plotly bundle.
export const PLOTLY_SCALES = {
  Jet: [
    [0, [0, 0, 131]], [0.125, [0, 60, 170]], [0.375, [5, 255, 255]],
    [0.625, [255, 255, 0]], [0.875, [250, 0, 0]], [1, [128, 0, 0]],
  ],
  RdBu: [
    [0, [5, 10, 172]], [0.35, [106, 137, 247]], [0.5, [190, 190, 190]],
    [0.6, [220, 170, 132]], [0.7, [230, 145, 90]], [1, [178, 10, 28]],
  ],
}

// Darker than the RdBu midpoint grey (190) so a null never reads as a zero geosignal.
export const NULL_RGB = [80, 80, 80]

// Plotly `reversescale`: walk the stops backwards and map each position p to 1 - p.
export function scaleStops(name, reverse = false) {
  const stops = PLOTLY_SCALES[name]
  if (!stops) throw new Error(`Unknown colour scale ${name}`)
  return reverse ? stops.slice().reverse().map(([p, rgb]) => [1 - p, rgb]) : stops
}

// Linear RGB interpolation with clamping, as Plotly's d3 linear colour scale does.
export function sampleStops(stops, t) {
  const x = Math.min(1, Math.max(0, t))
  let k = 1
  while (k < stops.length - 1 && x > stops[k][0]) k++
  const [p0, c0] = stops[k - 1]
  const [p1, c1] = stops[k]
  const f = p1 > p0 ? (x - p0) / (p1 - p0) : 0
  return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * f))
}

// Maps a raw curve value to [r, g, b] (0-255) with the backend colour spec {scale, reverse, log10, zmin, zmax}.
// Null, non-finite and (on a log10 scale) non-positive values map to NULL_RGB.
export function colorFn(spec) {
  const stops = scaleStops(spec.scale, spec.reverse)
  const span = spec.zmax - spec.zmin || 1
  return (value) => {
    if (value == null || !Number.isFinite(value) || (spec.log10 && value <= 0)) return NULL_RGB
    const z = spec.log10 ? Math.log10(value) : value
    return sampleStops(stops, (z - spec.zmin) / span)
  }
}

// CSS gradient from zmin (bottom) to zmax (top) for the colour bar.
export function cssGradient(spec) {
  const stops = spec.stops ?? scaleStops(spec.scale, spec.reverse)
  const parts = stops.map(([p, c]) => `rgb(${c.join(',')}) ${(p * 100).toFixed(1)}%`)
  return `linear-gradient(to top, ${parts.join(', ')})`
}
