import { useMemo } from 'react'
import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import PlotlyChart from '../PlotlyChart.jsx'

// Low to high resistivity (log scale, 1 to 300 ohm-m).
const STOPS = [[0, [69, 117, 180]], [0.35, [145, 191, 219]], [0.55, [254, 224, 144]], [0.75, [252, 141, 89]], [1, [215, 48, 39]]]
const LOG_MAX = Math.log10(300)
const COLORSCALE = STOPS.map(([s, c]) => [s, `rgb(${c.join(',')})`])
const TICKS = [1, 3, 10, 30, 100, 300]

function interp(xs, ys, x) {
  const pts = xs.map((v, i) => [v, ys[i]]).filter(([a, b]) => a != null && b != null)
  if (!pts.length) return null
  if (pts.length === 1 || x <= pts[0][0]) return pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1]
      const [x1, y1] = pts[i]
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    }
  }
  return pts[pts.length - 1][1]
}

// log10 Rh of a slice's layered model at (md, tvd); boundaries are ordered top to bottom.
function sliceColumn(slice, md) {
  const bounds = slice.boundary_tvd_ft.map((b) => interp(slice.md_ft, b, md))
  const logRh = slice.layers.map((l) => Math.log10(l.rh))
  return (z) => {
    let k = 0
    while (k < bounds.length && bounds[k] != null && bounds[k] <= z) k++
    return logRh[k]
  }
}

function buildGrid(result, h) {
  const { slices, slice_ft: sliceFt } = result
  const md = result.md_ft
  const tvd = result.tvd_ft
  const x0 = slices[0].slice_min_ft
  const x1 = slices[slices.length - 1].slice_max_ft
  const dx = Math.max(0.5, sliceFt / 4)
  const xs = []
  for (let x = x0 + dx / 2; x < x1; x += dx) xs.push(x)
  const finite = tvd.filter((v) => v != null)
  const lo = Math.min(...finite) - h
  const hi = Math.max(...finite) + h
  const dz = Math.max(0.1, (hi - lo) / 300)
  const ys = []
  for (let z = lo + dz / 2; z < hi; z += dz) ys.push(z)
  const own = ys.map(() => new Array(xs.length).fill(null))
  const mean = ys.map(() => new Array(xs.length).fill(null))
  const spread = ys.map(() => new Array(xs.length).fill(null))
  xs.forEach((x, c) => {
    const well = interp(md, tvd, x)
    if (well == null) return
    const owner = slices.find((s) => x >= s.slice_min_ft && x < s.slice_max_ft)
    const ownCol = owner ? sliceColumn(owner, x) : null
    const covering = slices.filter((s) => x >= s.window_min_ft && x <= s.window_max_ft).map((s) => sliceColumn(s, x))
    ys.forEach((z, r) => {
      if (Math.abs(z - well) > h) return
      if (ownCol) own[r][c] = ownCol(z)
      if (!covering.length) return
      const v = covering.map((f) => f(z))
      const m = v.reduce((a, b) => a + b, 0) / v.length
      mean[r][c] = m
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length)
      spread[r][c] = [Math.round(100 * (10 ** sd - 1)), v.length]
    })
  })
  return { xs, ys, own, mean, spread, lo, hi }
}

function heatmap(grid, z, title, extra) {
  return {
    type: 'heatmap', x: grid.xs, y: grid.ys, z, zmin: 0, zmax: LOG_MAX, colorscale: COLORSCALE, name: title,
    colorbar: { title: { text: 'Rh Ω·m', side: 'right' }, tickvals: TICKS.map(Math.log10), ticktext: TICKS.map(String),
      thickness: 12, len: 0.9 },
    ...extra,
  }
}

function overlays(result, h, boundaries) {
  const md = result.md_ft
  const tvd = result.tvd_ft
  const traces = []
  if (boundaries) {
    const x = []
    const y = []
    for (const s of result.slices) {
      for (const b of s.boundary_tvd_ft) {
        const a = interp(s.md_ft, b, s.slice_min_ft)
        const c = interp(s.md_ft, b, s.slice_max_ft)
        if (a == null || c == null) continue
        x.push(s.slice_min_ft, s.slice_max_ft, null)
        y.push(a, c, null)
      }
    }
    traces.push({ type: 'scatter', mode: 'lines', x, y, name: 'Slice boundaries', hoverinfo: 'skip',
      line: { color: '#222', width: 1.2 }, connectgaps: false })
  }
  for (const [sign, name] of [[-1, `well − ${h} ft`], [1, `well + ${h} ft`]]) {
    traces.push({ type: 'scatter', mode: 'lines', x: md, y: tvd.map((z) => (z == null ? null : z + sign * h)), name,
      showlegend: false, hoverinfo: 'skip', line: { color: '#9e9e9e', width: 1, dash: 'dash' } })
  }
  traces.push({ type: 'scatter', mode: 'lines', x: md, y: tvd, name: 'Well path', line: { color: '#000', width: 2.5 },
    customdata: result.inclination_deg,
    hovertemplate: 'TVD %{y:.1f} ft<br>INC %{customdata:.1f}°<extra>%{x:.1f} ft MD</extra>' })
  return traces
}

function layoutFor(grid, height, title) {
  return {
    height, margin: { l: 70, r: 10, t: 28, b: 40 }, uirevision: 'curtain',
    title: { text: title, font: { size: 13 }, x: 0, xanchor: 'left', xref: 'paper' },
    xaxis: { title: { text: 'MD (ft)' } },
    yaxis: { title: { text: 'TVD (ft)' }, range: [grid.hi, grid.lo] },
    showlegend: false,
  }
}

// Curtain section along the well. Every slice is its own 1.5D model fitted on a sliding data window centred on it:
// "Slices" colours each slice by its own model; "Mean" averages log Rh over every model whose data window covers
// that MD (all runs that saw it), so it fills in as slices finish.
function CurtainPlot({ result, halfWindowFt = 15, height = 340, view = 'both', onViewChange }) {
  const h = Math.max(1, Number(halfWindowFt) || 15)
  const grid = useMemo(() => (result?.slices?.length ? buildGrid(result, h) : null), [result, h])
  const plots = useMemo(() => {
    if (!grid) return []
    const out = []
    if (view !== 'mean') {
      out.push({
        key: 'slices',
        data: [heatmap(grid, grid.own, 'Slices', {
          hovertemplate: 'Rh %{customdata:.1f} Ω·m<br>TVD %{y:.1f} ft<extra>%{x:.1f} ft MD · slice model</extra>',
          customdata: grid.own.map((row) => row.map((v) => (v == null ? null : 10 ** v))),
        }), ...overlays(result, h, true)],
        layout: layoutFor(grid, height, `Slices: one model per ${result.slice_ft} ft slice (data window ${result.window_ft} ft)`),
      })
    }
    if (view !== 'slices') {
      out.push({
        key: 'mean',
        data: [heatmap(grid, grid.mean, 'Mean', {
          customdata: grid.mean.map((row, r) => row.map((v, c) => (v == null ? null
            : [10 ** v, ...(grid.spread[r][c] ?? [null, null])]))),
          hovertemplate: 'mean Rh %{customdata[0]:.1f} Ω·m (±%{customdata[1]}%, %{customdata[2]} runs)'
            + '<br>TVD %{y:.1f} ft<extra>%{x:.1f} ft MD</extra>',
        }), ...overlays(result, h, false)],
        layout: layoutFor(grid, height, 'Mean of all runs whose data window covers each MD (geometric mean of Rh)'),
      })
    }
    return out
  }, [grid, result, h, height, view])

  if (!result?.slices?.length) {
    return <Typography variant="body2" color="text.secondary">Waiting for the first slice…</Typography>
  }
  return (
    <Box>
      {onViewChange && (
        <ToggleButtonGroup size="small" exclusive value={view} onChange={(_, v) => v && onViewChange(v)} sx={{ mb: 1 }}>
          <ToggleButton value="slices">Slices</ToggleButton>
          <ToggleButton value="mean">Mean</ToggleButton>
          <ToggleButton value="both">Both</ToggleButton>
        </ToggleButtonGroup>
      )}
      {plots.map((p) => <PlotlyChart key={p.key} data={p.data} layout={p.layout} />)}
    </Box>
  )
}

export default CurtainPlot
