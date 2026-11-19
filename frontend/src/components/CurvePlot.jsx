import { useMemo, useState } from 'react'
import { Box, FormControlLabel, Paper, Stack, Switch, Typography } from '@mui/material'
import { getCurveData } from '../api.js'
import { useApi } from '../hooks/useApi.js'
import { SERIES_COLORS } from '../udar/format.js'
import ApiStatus from './ApiStatus.jsx'
import LineChart from './LineChart.jsx'

function binMean(v) {
  if (!Array.isArray(v)) return v
  let s = 0
  let n = 0
  for (const b of v) {
    if (b === null || !isFinite(b)) continue
    s += b
    n++
  }
  return n ? s / n : null
}

// One log track per curve, depth increasing downward; image curves (bins > 1) show the mean over bins.
function CurvePlot({ run, curves }) {
  const key = run && curves.length ? `${run}|${curves.join(',')}` : null
  const data = useApi(() => getCurveData(run, curves), key)
  const [logScale, setLogScale] = useState(true)

  const tracks = useMemo(() => {
    if (!data.data) return []
    const depth = data.data.depth_m
    return Object.entries(data.data.curves).map(([name, c], i) => {
      const values = c.bins > 1 ? c.values.map(binMean) : c.values
      const positive = values.some((v) => v !== null && v > 0) && values.every((v) => v === null || v > 0)
      return { name, unit: c.unit, bins: c.bins, positive, series: [{ name, color: SERIES_COLORS[i % SERIES_COLORS.length], x: values, y: depth, width: 1.2 }] }
    })
  }, [data.data])

  const ylim = useMemo(() => {
    if (!data.data || !data.data.depth_m.length) return null
    const d = data.data.depth_m
    return [Math.min(d[0], d[d.length - 1]), Math.max(d[0], d[d.length - 1])]
  }, [data.data])

  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="h6">Curves vs depth</Typography>
        <FormControlLabel control={<Switch checked={logScale} onChange={(e) => setLogScale(e.target.checked)} />} label="Log scale for positive curves" />
      </Stack>
      {!key && <Typography color="text.secondary">Select curves in the inventory to plot them.</Typography>}
      <ApiStatus state={data} label="Curve data" onRetry={data.reload} />
      {tracks.length > 0 && (
        <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(tracks.length, 4)}, minmax(220px, 1fr))`, gap: 1 }}>
          {tracks.map((t) => (
            <Box key={t.name}>
              <Typography variant="subtitle2" sx={{ textAlign: 'center' }}>
                {t.name}
                {t.bins > 1 ? ` (mean of ${t.bins} bins)` : ''}
              </Typography>
              <LineChart
                series={t.series}
                height={520}
                xlog={logScale && t.positive}
                yReverse
                ylim={ylim}
                xlabel={t.unit || ''}
                ylabel="Depth (m)"
                legend={false}
              />
            </Box>
          ))}
        </Box>
      )}
    </Paper>
  )
}

export default CurvePlot
