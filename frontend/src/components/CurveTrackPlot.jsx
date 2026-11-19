import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, LinearProgress, Typography } from '@mui/material'
import PlotlyChart from './PlotlyChart.jsx'
import { STATUS, api, runPath } from '../api.js'

const MAX_POINTS = 1500
const IMAGE_HEIGHT = 150
const LINE_HEIGHT = 110
const GAP = 30
const MARGIN_TOP = 10
const FOCUS_COLOR = '#ffb300'

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : null
}

function imageTrace(track, axis, domain, colorbarLen) {
  const resistivity = track.unit === 'ohmm'
  const z = resistivity
    ? track.values.map((row) => row.map((v) => (v > 0 ? Math.log10(v) : null)))
    : track.values
  const flat = z.flat()
  const scale = resistivity
    ? { colorscale: 'Jet', zmin: percentile(flat, 0.02), zmax: percentile(flat, 0.98) }
    : (() => {
        const limit = percentile(flat.map(Math.abs), 0.98) || 1
        return { colorscale: 'RdBu', reversescale: true, zmin: -limit, zmax: limit }
      })()
  return {
    type: 'heatmap', x: track.md_ft, y: z.map((_, i) => i + 1), z, ...scale,
    xaxis: 'x', yaxis: axis, hoverongaps: false,
    hovertemplate: `${track.curve} bin %{y}: %{z:.3g}<extra>%{x:.1f} ft</extra>`,
    colorbar: { len: colorbarLen, y: (domain[0] + domain[1]) / 2, yanchor: 'middle', thickness: 10,
      x: 1.01, title: { text: resistivity ? 'log₁₀ Ω·m' : track.unit, side: 'right' } },
  }
}

function buildFigure(names, tracks, statusOf, revision, focus) {
  const present = names.filter((n) => tracks[n])
  const heights = present.map((n) => (tracks[n].image ? IMAGE_HEIGHT : LINE_HEIGHT))
  const total = heights.reduce((a, b) => a + b, 0) + GAP * Math.max(0, present.length - 1)
  const ref = (i) => (i === 0 ? 'y' : `y${i + 1}`)
  const layout = {
    height: total + MARGIN_TOP + 50, margin: { l: 95, r: 90, t: MARGIN_TOP, b: 50 }, showlegend: false,
    xaxis: { title: { text: 'MD (ft)' }, anchor: ref(present.length - 1) },
    shapes: [], uirevision: revision,
  }
  const data = []
  const tops = {}
  let offset = 0
  present.forEach((name, i) => {
    const track = tracks[name]
    const domain = [1 - (offset + heights[i]) / total, 1 - offset / total]
    tops[name] = MARGIN_TOP + offset
    offset += heights[i] + GAP
    const color = STATUS[statusOf(name)]?.color ?? '#424242'
    const logAxis = !track.image && track.unit === 'ohmm'
    const label = name === focus ? `<b>${name}</b>` : name
    layout[i === 0 ? 'yaxis' : `yaxis${i + 1}`] = {
      domain, title: { text: `${label}<br>${track.unit}`, font: { size: 11, color } },
      type: logAxis ? 'log' : 'linear', autorange: track.image ? 'reversed' : true,
    }
    if (name === focus) {
      layout.shapes.push({ type: 'rect', xref: 'paper', yref: 'paper', x0: 0, x1: 1, y0: domain[0], y1: domain[1],
        line: { color: FOCUS_COLOR, width: 3 }, fillcolor: 'rgba(0,0,0,0)', layer: 'above' })
    }
    if (track.image) {
      data.push(imageTrace(track, ref(i), domain, heights[i] / total))
    } else {
      data.push({
        type: 'scatter', mode: 'lines', x: track.md_ft, xaxis: 'x', yaxis: ref(i),
        y: logAxis ? track.values.map((v) => (v > 0 ? v : null)) : track.values,
        line: { width: 1, color }, name,
        hovertemplate: `${name} %{y:.3g}<extra>%{x:.1f} ft</extra>`,
      })
    }
  })
  return { data, layout, present, tops }
}

function CurveTrackPlot({ run, names, statusOf, focus }) {
  const [range, setRange] = useState(null)
  const [cache, setCache] = useState({ rangeKey: 'full', tracks: {}, error: null })
  const plotBox = useRef(null)
  const rangeKey = range?.join(',') ?? 'full'
  const tracks = useMemo(() => (cache.rangeKey === rangeKey ? cache.tracks : {}), [cache, rangeKey])
  const missing = names.filter((n) => !tracks[n])
  const missingKey = `${rangeKey}|${missing.join(',')}`

  useEffect(() => {
    if (!missing.length) return undefined
    let cancelled = false
    const query = new URLSearchParams({ max_points: MAX_POINTS })
    if (range) {
      query.set('start_ft', range[0])
      query.set('end_ft', range[1])
    }
    Promise.all(missing.map((name) => api(`${runPath(run)}/curves/${encodeURIComponent(name)}?${query}`)
      .then((body) => [name, body])))
      .then((entries) => !cancelled && setCache((c) => ({
        rangeKey,
        tracks: { ...(c.rangeKey === rangeKey ? c.tracks : {}), ...Object.fromEntries(entries) },
        error: null,
      })))
      .catch((error) => !cancelled && setCache((c) => ({ ...c, error: error.message })))
    return () => { cancelled = true }
  }, [missingKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data, layout, present, tops } = useMemo(
    () => buildFigure(names, tracks, statusOf, run, focus?.name), [names, tracks, statusOf, run, focus?.name])
  const focusTop = focus ? tops[focus.name] : undefined

  useEffect(() => {
    if (focusTop == null || !plotBox.current) return
    const top = plotBox.current.getBoundingClientRect().top + window.scrollY + focusTop - 120
    window.scrollTo({ top, behavior: 'smooth' })
  }, [focus?.nonce, focusTop != null]) // eslint-disable-line react-hooks/exhaustive-deps

  const events = useMemo(() => ({
    plotly_relayout: (event) => {
      if (event['xaxis.autorange']) setRange(null)
      else if (event['xaxis.range[0]'] != null) setRange([event['xaxis.range[0]'], event['xaxis.range[1]']])
    },
  }), [])

  if (!names.length) {
    return <Typography color="text.secondary">Click a point in the chart or a curve name to view its log.</Typography>
  }
  const stride = Math.max(1, ...present.map((n) => tracks[n].stride))
  return (
    <Box>
      {missing.length > 0 && !cache.error && <LinearProgress sx={{ mb: 1 }} />}
      {cache.error && <Typography color="error">{cache.error}</Typography>}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {stride > 1
            ? `Showing every ${stride}th sample (0.5 ft data). Zoom in on depth to reload at full resolution.`
            : 'Full resolution (every 0.5 ft sample).'}
          {' '}Double-click to reset zoom.
        </Typography>
        <Button size="small" onClick={() => document.getElementById('qc-scatter')
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          ↑ Back to QC chart
        </Button>
      </Box>
      <Box ref={plotBox}>
        <PlotlyChart data={data} layout={layout} events={events} />
      </Box>
    </Box>
  )
}

export default CurveTrackPlot
