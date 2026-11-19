import { useMemo } from 'react'
import { Box, FormControl, FormControlLabel, InputLabel, MenuItem, Select, Switch, Tooltip, Typography } from '@mui/material'
import { boundaryColor, layerColorSpec, nearestReading, rgbCss } from './inversionLayers.js'
import { nearestIndex } from './path.js'

const fmt = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits))
const jobLabel = (j) => `${j.md_min_ft}–${j.md_max_ft} ft · ${j.layers} layers · ${j.id.slice(0, 6)}`

// Toolbar control: show/hide the boundaries and pick a finished inversion job of this run.
// `inv` is the value of useInversionLayers.
export function LayersControl({ inv, curveSpec }) {
  const spec = useMemo(() => (inv.layers ? layerColorSpec(inv.layers, curveSpec) : null), [inv.layers, curveSpec])
  if (!inv.ready) return null
  if (!inv.jobs.length) {
    return (
      <Typography variant="caption" color="text.secondary" data-testid="well3d-layers-hint">
        {inv.error ? `Inversion layers unavailable: ${inv.error}` : 'Inversion layers: run an inversion on the Inversion tab'}
      </Typography>
    )
  }
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }} data-testid="well3d-layers-control">
      <FormControlLabel sx={{ mr: 0 }} label="Inversion layers"
        control={<Switch size="small" checked={inv.show} onChange={(e) => inv.setShow(e.target.checked)} />} />
      <FormControl size="small" sx={{ minWidth: 200 }} disabled={!inv.show}>
        <InputLabel id="well3d-inversion-job">Inversion</InputLabel>
        <Select labelId="well3d-inversion-job" label="Inversion" value={inv.id ?? ''} onChange={(e) => inv.setId(e.target.value)}>
          {inv.jobs.map((j) => <MenuItem key={j.id} value={j.id}>{jobLabel(j)}</MenuItem>)}
        </Select>
      </FormControl>
      {spec && inv.layers.boundaries.map((b) => (
        <Tooltip key={b.index} title={`Boundary ${b.index + 1}: ${b.rh_above} → ${b.rh_below} Ω·m (Rh above → below)`}>
          <Box sx={{ width: 14, height: 14, borderRadius: 0.5, border: 1, borderColor: 'grey.600',
            bgcolor: rgbCss(boundaryColor(spec, b)) }} />
        </Tooltip>
      ))}
      {inv.error && <Typography variant="caption" color="error">{inv.error}</Typography>}
    </Box>
  )
}

// Panel line: distance from the travel point to the nearest boundary and whether the curve's DOI reaches it.
export function LayersReadout({ layers, data, path, md }) {
  const text = useMemo(() => {
    const r = nearestReading(layers, data, nearestIndex(path, md), md)
    if (!r) return `Inversion layers: outside the inverted interval (${fmt(layers.md_ft[0], 0)}–${fmt(layers.md_ft.at(-1), 0)} ft MD)`
    if (r.boundary == null) return 'Inversion layers: no boundary at this station'
    const where = `${fmt(r.distance, 2)} m ${r.above ? 'above' : 'below'} (boundary ${r.boundary + 1})`
    if (r.seen == null) return `Nearest boundary ≈ ${where} · no DOI for this curve`
    return `Nearest boundary ≈ ${where} · ${r.seen ? 'seen' : 'not seen'} (DOI ${fmt(r.doi, 2)} m)`
  }, [layers, data, path, md])
  return <Typography variant="body2" data-testid="well3d-layers-readout">{text}</Typography>
}
