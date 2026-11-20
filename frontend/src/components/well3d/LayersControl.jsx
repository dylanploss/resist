import { Box, FormControl, FormControlLabel, InputLabel, MenuItem, Select, Slider, Switch, Tooltip, Typography } from '@mui/material'

const jobLabel = (j) => `${j.md_min_ft}–${j.md_max_ft} ft · ${j.layers} layers · ${j.id.slice(0, 6)}`

// Toolbar control: show/hide the inversion curtain and pick a finished inversion job of this run.
// `inv` is the value of useInversionLayers.
export function LayersControl({ inv }) {
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
      <Tooltip title="The inverted curtain section (each slice's own model) draped along the well">
        <FormControlLabel sx={{ mr: 0 }} label="Inversion layers"
          control={<Switch size="small" checked={inv.show} onChange={(e) => inv.setShow(e.target.checked)} />} />
      </Tooltip>
      <FormControl size="small" sx={{ minWidth: 200 }} disabled={!inv.show}>
        <InputLabel id="well3d-inversion-job">Inversion</InputLabel>
        <Select labelId="well3d-inversion-job" label="Inversion" value={inv.id ?? ''} onChange={(e) => inv.setId(e.target.value)}>
          {inv.jobs.map((j) => <MenuItem key={j.id} value={j.id}>{jobLabel(j)}</MenuItem>)}
        </Select>
      </FormControl>
      {inv.error && <Typography variant="caption" color="error">{inv.error}</Typography>}
      {inv.layers?.slices?.length > 0 && (
        <>
          <FormControl size="small" sx={{ minWidth: 90 }}>
            <InputLabel id="well3d-curtain-h">± TVD</InputLabel>
            <Select labelId="well3d-curtain-h" label="± TVD" value={inv.curtain.halfFt}
              onChange={(e) => inv.setCurtain({ ...inv.curtain, halfFt: Number(e.target.value) })}>
              {[5, 10, 15, 25, 40].map((v) => <MenuItem key={v} value={v}>{v} ft</MenuItem>)}
            </Select>
          </FormControl>
          <Tooltip title="Fade the curtain: the most uncertain layers disappear first">
            <Box sx={{ width: 110, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="caption">Fade</Typography>
              <Slider size="small" value={Math.round(inv.curtain.fade * 100)} min={0} max={100}
                aria-label="Fade uncertain curtain" onChange={(_, v) => inv.setCurtain({ ...inv.curtain, fade: v / 100 })} />
            </Box>
          </Tooltip>
        </>
      )}
    </Box>
  )
}
