import { FormControl, InputLabel, MenuItem, Select } from '@mui/material'

const depthRange = (r) => (r.depth_min_m === null || r.depth_max_m === null ? 'depth unknown' : `${r.depth_min_m.toFixed(0)}–${r.depth_max_m.toFixed(0)} m`)

export default function RunPicker({ runs, value, onChange, fullWidth = false }) {
  return (
    <FormControl size="small" fullWidth={fullWidth} sx={{ minWidth: fullWidth ? 0 : 360 }}>
      <InputLabel id="run-picker-label">Run</InputLabel>
      <Select labelId="run-picker-label" label="Run" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        {runs.map((r) => (
          <MenuItem key={r.run} value={r.run} disabled={Boolean(r.error)}>
            {r.run} · {r.well || 'unknown well'} · {depthRange(r)}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  )
}
