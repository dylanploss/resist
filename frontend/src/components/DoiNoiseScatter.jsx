import { useMemo } from 'react'
import { Box, Typography } from '@mui/material'
import PlotlyChart from './PlotlyChart.jsx'
import { STATUS } from '../api.js'

const SYMBOL = { AR: 'circle', ZR: 'square', ZG: 'diamond' }
const STATIC_LIMIT = 0.8

function groupOf(row, checked) {
  if (checked.includes(row.name)) return 'chosen'
  return row.status === 'auto' ? 'candidate' : row.status
}

const GROUPS = [
  ['chosen', 'in selection', STATUS.auto.color],
  ['candidate', 'clean candidate', STATUS.candidate.color],
  ['duplicate', 'duplicate', STATUS.duplicate.color],
  ['rejected', 'rejected', STATUS.rejected.color],
]

const LAYOUT = {
  height: 330,
  margin: { l: 55, r: 10, t: 10, b: 45 },
  xaxis: { title: { text: 'Relative depth of investigation (log)' }, type: 'log' },
  yaxis: { title: { text: 'Noise (jaggedness)' }, rangemode: 'tozero' },
  legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom' },
  shapes: [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: STATIC_LIMIT, y1: STATIC_LIMIT,
    line: { dash: 'dash', color: STATUS.rejected.color, width: 1 } }],
  annotations: [{ xref: 'paper', x: 1, y: STATIC_LIMIT, text: 'static limit', showarrow: false,
    xanchor: 'right', yanchor: 'bottom', font: { size: 10, color: STATUS.rejected.color } }],
  dragmode: 'select',
  uirevision: 'scatter',
}

function DoiNoiseScatter({ rows, checked, focus, onShowCurve, onShowCurves }) {
  const data = useMemo(() => {
    const points = rows.filter((r) => r.status !== 'context' && r.doi_index != null && r.noise != null)
    const traces = GROUPS.map(([group, name, color]) => {
      const pts = points.filter((r) => groupOf(r, checked) === group)
      return {
        type: 'scatter', mode: 'markers', name,
        x: pts.map((r) => r.doi_index), y: pts.map((r) => r.noise),
        customdata: pts.map((r) => r.name),
        text: pts.map((r) => `<b>${r.name}</b><br>${r.reason}`),
        hovertemplate: '%{text}<br>DOI %{x:.1f} · noise %{y:.2f}<br><i>click to view log</i><extra></extra>',
        marker: { color, size: 10, opacity: group === 'rejected' ? 0.55 : 0.95,
          symbol: pts.map((r) => SYMBOL[r.family] ?? 'circle'), line: { width: 1, color: 'white' } },
      }
    })
    const focused = points.find((r) => r.name === focus)
    if (focused) {
      traces.push({
        type: 'scatter', mode: 'markers+text', x: [focused.doi_index], y: [focused.noise],
        text: [focused.name], textposition: 'top center', textfont: { size: 11, color: '#e65100' },
        marker: { size: 20, color: 'rgba(0,0,0,0)', line: { width: 2.5, color: '#ffb300' } },
        hoverinfo: 'skip', showlegend: false,
      })
    }
    return traces
  }, [rows, checked, focus])

  const events = useMemo(() => ({
    plotly_click: (event) => {
      const name = event.points.find((p) => p.customdata)?.customdata
      if (name) onShowCurve(name)
    },
    plotly_selected: (event) => {
      const names = (event?.points ?? []).map((p) => p.customdata).filter(Boolean)
      if (names.length) onShowCurves(names)
    },
  }), [onShowCurve, onShowCurves])

  return (
    <Box id="qc-scatter">
      <Typography variant="subtitle2">Deep and clean is bottom right</Typography>
      <Typography variant="caption" color="text.secondary">
        ● AR ■ ZR ◆ ZG · click a point to jump to its log · drag a box to plot a group
      </Typography>
      <PlotlyChart data={data} layout={LAYOUT} events={events} />
    </Box>
  )
}

export default DoiNoiseScatter
