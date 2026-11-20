import { Box, Typography } from '@mui/material'
import { NULL_RGB, cssGradient } from './colormap.js'

const fmt = (v) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toPrecision(3))

// Vertical colour bar matching the QC heatmap colour bar: log10 Ω·m for resistivity, the curve unit otherwise.
// label overrides the unit caption; showNull hides the null swatch (spec.stops may replace the named scale).
export default function ColorBar({ spec, unit, label, showNull = true }) {
  const ticks = [spec.zmax, (spec.zmin + spec.zmax) / 2, spec.zmin]
  return (
    <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0.75, bgcolor: 'rgba(255,255,255,0.85)', p: 1, borderRadius: 1 }}>
      <Box sx={{ width: 12, height: 180, background: cssGradient(spec), border: 1, borderColor: 'grey.500' }} />
      <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: 180 }}>
        {ticks.map((t, i) => <Typography key={i} variant="caption" sx={{ lineHeight: 1 }}>{fmt(t)}</Typography>)}
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography variant="caption" sx={{ writingMode: 'vertical-rl', lineHeight: 1 }}>
          {label ?? (spec.log10 ? 'log₁₀ Ω·m' : unit)}
        </Typography>
        {showNull && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }} title="Null samples">
            <Box sx={{ width: 10, height: 10, bgcolor: `rgb(${NULL_RGB.join(',')})` }} />
            <Typography variant="caption" sx={{ lineHeight: 1 }}>null</Typography>
          </Box>
        )}
      </Box>
    </Box>
  )
}
