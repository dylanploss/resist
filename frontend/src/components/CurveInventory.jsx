import { useMemo, useState } from 'react'
import {
  Checkbox,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { getCurves } from '../api.js'
import { useApi } from '../hooks/useApi.js'
import ApiStatus from './ApiStatus.jsx'

const MAX_PLOT_CURVES = 8

const khz = (hz) => (hz === null || hz === undefined ? '' : `${hz / 1000}`)
const pct = (v) => (v === null || v === undefined ? '' : `${Math.round(v * 100)}%`)

function CurveInventory({ run, selected, onSelectedChange }) {
  const curves = useApi(() => getCurves(run), run || null)
  const [family, setFamily] = useState('all')
  const [text, setText] = useState('')

  const rows = useMemo(() => (curves.data ? curves.data.curves : []), [curves.data])
  const families = useMemo(() => Array.from(new Set(rows.map((r) => r.family || 'unknown'))).sort(), [rows])
  const needle = text.toLowerCase()
  const shown = rows.filter(
    (r) => (family === 'all' || (r.family || 'unknown') === family) && (!needle || `${r.curve} ${r.description || ''}`.toLowerCase().includes(needle)),
  )

  const toggle = (name) => {
    if (selected.includes(name)) onSelectedChange(selected.filter((c) => c !== name))
    else if (selected.length < MAX_PLOT_CURVES) onSelectedChange([...selected, name])
  }

  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 1 }} useFlexGap>
        <Typography variant="h6">Curve inventory</Typography>
        {curves.data && (
          <Typography variant="body2" color="text.secondary">
            {curves.data.well} · {rows.length} curves · {shown.length} shown · click rows to plot (max {MAX_PLOT_CURVES})
          </Typography>
        )}
        <FormControl size="small" sx={{ minWidth: 150, ml: 'auto' }}>
          <InputLabel id="family-label">Family</InputLabel>
          <Select labelId="family-label" label="Family" value={family} onChange={(e) => setFamily(e.target.value)}>
            <MenuItem value="all">All</MenuItem>
            {families.map((f) => (
              <MenuItem key={f} value={f}>
                {f}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField size="small" label="Filter by name" value={text} onChange={(e) => setText(e.target.value)} />
      </Stack>
      {!run && <Typography color="text.secondary">Pick a run to see its curves.</Typography>}
      <ApiStatus state={curves} label="Curve inventory" onRetry={curves.reload} />
      {selected.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', mb: 1 }} useFlexGap>
          <Typography variant="body2" sx={{ alignSelf: 'center' }}>
            Plot ({selected.length}/{MAX_PLOT_CURVES}):
          </Typography>
          {selected.map((c) => (
            <Chip key={c} label={c} size="small" onDelete={() => toggle(c)} />
          ))}
        </Stack>
      )}
      {curves.data && (
        <TableContainer sx={{ maxHeight: 420 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Curve</TableCell>
                <TableCell>Unit</TableCell>
                <TableCell>Family</TableCell>
                <TableCell align="right">Freq (kHz)</TableCell>
                <TableCell align="right">Spacing (in)</TableCell>
                <TableCell>Measurement</TableCell>
                <TableCell>Suffix</TableCell>
                <TableCell align="right">Bins</TableCell>
                <TableCell align="right">Valid</TableCell>
                <TableCell>Description</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.curve} hover selected={selected.includes(r.curve)} onClick={() => toggle(r.curve)} sx={{ cursor: 'pointer' }}>
                  <TableCell padding="checkbox">
                    <Checkbox size="small" checked={selected.includes(r.curve)} slotProps={{ input: { 'aria-label': `Plot ${r.curve}` } }} />
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{r.curve}</TableCell>
                  <TableCell>{r.unit}</TableCell>
                  <TableCell>{r.family}</TableCell>
                  <TableCell align="right">{khz(r.frequency_hz)}</TableCell>
                  <TableCell align="right">{r.spacing_in ?? ''}</TableCell>
                  <TableCell>{r.measurement ?? ''}</TableCell>
                  <TableCell>{r.suffix ?? ''}</TableCell>
                  <TableCell align="right">{r.bins}</TableCell>
                  <TableCell align="right">{pct(r.valid_fraction)}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{r.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Paper>
  )
}

export default CurveInventory
