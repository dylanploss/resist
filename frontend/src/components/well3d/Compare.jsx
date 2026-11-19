import { FormControl, InputLabel, ListSubheader, MenuItem, Select, Typography, Box } from '@mui/material'
import { STATUS } from '../../api.js'
import ColorBar from './ColorBar.jsx'

const fmt = (v, digits = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits))
const fmtValue = (v) => (v == null || !Number.isFinite(v) ? 'null' : Math.abs(v) >= 1000 ? v.toExponential(2) : v.toPrecision(4))
const fmtDoi = (r) => (Array.isArray(r) ? `${fmt(Math.min(...r))}–${fmt(Math.max(...r))}` : fmt(r))

function meanValue(data, i) {
  const row = data.values[i]
  if (!data.image) return row
  const finite = (row ?? []).filter((v) => v != null && Number.isFinite(v))
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null
}

// "Compare with" picker: None, the suggested opposite-tier QC pick, QC auto-picks, then all curves.
export function ComparePicker({ value, onChange, shown, suggestion, selected, names, statusOf }) {
  const picks = selected.filter((n) => n !== shown && n !== suggestion)
  const others = names.filter((n) => n !== shown && n !== suggestion && !selected.includes(n))
  const item = (n) => (
    <MenuItem key={n} value={n} sx={{ fontFamily: 'monospace', color: STATUS[statusOf(n)]?.color }}>{n}</MenuItem>
  )
  return (
    <FormControl size="small" sx={{ minWidth: 200 }}>
      <InputLabel id="well3d-compare-label">Compare with</InputLabel>
      <Select labelId="well3d-compare-label" label="Compare with" value={value} onChange={(e) => onChange(e.target.value)}
        sx={{ fontFamily: 'monospace' }} data-testid="well3d-compare">
        <MenuItem value=""><em>None</em></MenuItem>
        {suggestion && <ListSubheader>Suggested (opposite DOI tier)</ListSubheader>}
        {suggestion && item(suggestion)}
        {picks.length > 0 && <ListSubheader>QC auto-picks</ListSubheader>}
        {picks.map(item)}
        {others.length > 0 && <ListSubheader>All curves</ListSubheader>}
        {others.map(item)}
      </Select>
    </FormControl>
  )
}

const role = (layout, d) => (d === layout.inner ? 'inner, solid' : 'shell, transparent')

// One DOI line per compared curve, at sample i.
export function CompareDoi({ layout, i }) {
  return [layout.inner, layout.outer].map((d) => (
    <Typography key={d.curve} variant="body2" data-testid="well3d-doi-compare" sx={{ fontFamily: 'monospace' }}>
      {d.curve} ({role(layout, d)}): {fmtValue(meanValue(d, i))} {d.unit}{d.image ? ' (mean)' : ''} · DOI{' '}
      {d.doi_m ? `≈ ${fmtDoi(d.doi_m[i])} m (from ${d.doi_source})` : 'n/a (fixed radius)'} ·{' '}
      {d.doi_tier ?? 'non-ADR'}
    </Typography>
  ))
}

// Colour bar for the second curve, labelled with its name and role.
export function CompareColorBar({ layout, data }) {
  return (
    <Box sx={{ textAlign: 'center' }}>
      <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block', bgcolor: 'rgba(255,255,255,0.85)' }}>
        {data.curve} ({role(layout, data).split(',')[0]})
      </Typography>
      <ColorBar spec={data.color} unit={data.unit} />
    </Box>
  )
}
