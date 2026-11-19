import { useEffect, useMemo, useState } from 'react'
import { Box, LinearProgress, Typography } from '@mui/material'
import PlotlyChart from './PlotlyChart.jsx'
import { api, runPath } from '../api.js'

const PALETTE = ['#2a78d6', '#e8710a', '#1e8e3e', '#d01884', '#9334e6', '#12b5cb', '#f9ab00', '#5f6368']
const REFERENCE = 'RDEP'

// Selected averaged resistivities on one log axis, with the DISKOS deep resistivity dashed for comparison.
function ArOverlay({ run, names, hasReference, onShowCurve }) {
  const [cache, setCache] = useState({ run, tracks: {}, error: null })
  const wanted = useMemo(() => (hasReference ? [...names, REFERENCE] : names), [names, hasReference])
  const tracks = useMemo(() => (cache.run === run ? cache.tracks : {}), [cache, run])
  const missing = wanted.filter((n) => !tracks[n])
  const missingKey = missing.join(',')

  useEffect(() => {
    if (!missing.length) return undefined
    let cancelled = false
    Promise.all(missing.map((n) => api(`${runPath(run)}/curves/${encodeURIComponent(n)}?max_points=1500`)
      .then((body) => [n, body])))
      .then((entries) => !cancelled && setCache((c) => ({
        run, tracks: { ...(c.run === run ? c.tracks : {}), ...Object.fromEntries(entries) }, error: null,
      })))
      .catch((error) => !cancelled && setCache((c) => ({ ...c, error: error.message })))
    return () => { cancelled = true }
  }, [run, missingKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => wanted.filter((n) => tracks[n]).map((n, i) => {
    const ref = n === REFERENCE
    return {
      type: 'scatter', mode: 'lines', name: ref ? `${n} (DISKOS)` : n, x: tracks[n].md_ft,
      y: tracks[n].values.map((v) => (v > 0.0201 && v < 1990 ? v : null)), meta: n,
      line: { width: ref ? 1.2 : 1.4, color: ref ? '#5f6368' : PALETTE[i % PALETTE.length], dash: ref ? 'dash' : 'solid' },
      hovertemplate: `${n} %{y:.3g} Ω·m<extra>%{x:.1f} ft</extra>`,
    }
  }), [wanted, tracks])

  const layout = useMemo(() => ({
    height: 260, margin: { l: 60, r: 10, t: 10, b: 40 }, uirevision: run,
    xaxis: { title: { text: 'MD (ft)' } }, yaxis: { title: { text: 'Resistivity (Ω·m)' }, type: 'log' },
    legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 11 } },
  }), [run])

  const events = useMemo(() => ({
    plotly_click: (event) => {
      const name = event.points?.[0]?.data?.meta
      if (name && name !== REFERENCE) onShowCurve(name)
    },
  }), [onShowCurve])

  if (!names.length) {
    return <Typography color="text.secondary" variant="body2">No averaged resistivity (AR) channel selected.</Typography>
  }
  return (
    <Box>
      {missing.length > 0 && !cache.error && <LinearProgress sx={{ mb: 1 }} />}
      {cache.error && <Typography color="error">{cache.error}</Typography>}
      <PlotlyChart data={data} layout={layout} events={events} />
    </Box>
  )
}

export default ArOverlay
