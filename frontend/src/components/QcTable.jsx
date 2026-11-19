import { useState } from 'react'
import {
  Box, Checkbox, Chip, FormControlLabel, Switch, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material'
import { FREQ_LABEL, STATUS, fmt } from '../api.js'

const FILTERS = [
  ['measurements', 'All'], ['AR', 'AR'], ['ZR', 'ZR'], ['ZG', 'ZG'], ['context', 'Other logs'],
]

function matches(row, filter) {
  if (filter === 'measurements') return row.status !== 'context'
  if (filter === 'context') return row.status === 'context'
  return row.family === filter
}

function QcTable({ rows, checked, plotted, onToggleChecked, onTogglePlotted }) {
  const [filter, setFilter] = useState('measurements')
  const [hideRejected, setHideRejected] = useState(false)
  const visible = rows.filter((row) => matches(row, filter) && !(hideRejected && row.status === 'rejected'))

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1, flexWrap: 'wrap' }}>
        <ToggleButtonGroup size="small" exclusive value={filter}
          onChange={(_, value) => value && setFilter(value)}>
          {FILTERS.map(([value, label]) => <ToggleButton key={value} value={value}>{label}</ToggleButton>)}
        </ToggleButtonGroup>
        <FormControlLabel label="Hide rejected" control={
          <Switch size="small" checked={hideRejected} onChange={(e) => setHideRejected(e.target.checked)} />
        } />
        <Typography variant="caption" color="text.secondary">
          {visible.length} curves · Use = include in inversion · Plot = show below
        </Typography>
      </Box>
      <TableContainer sx={{ maxHeight: 460, border: 1, borderColor: 'divider', borderRadius: 1,
        '& td, & th': { whiteSpace: 'nowrap' } }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {['Use', 'Plot', '#', 'Curve', 'Freq', 'Spacing', 'Type', 'Depth', 'DOI', 'Noise', 'Score', 'Status']
                .map((h) => <TableCell key={h} sx={{ fontWeight: 600 }}>{h}</TableCell>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((row) => {
              const status = STATUS[row.status]
              return (
                <TableRow key={row.name} hover selected={checked.includes(row.name)}>
                  <TableCell padding="checkbox">
                    <Checkbox size="small" disabled={row.status === 'context'}
                      checked={checked.includes(row.name)} onChange={() => onToggleChecked(row.name)} />
                  </TableCell>
                  <TableCell padding="checkbox">
                    <Checkbox size="small" color="secondary"
                      checked={plotted.includes(row.name)} onChange={() => onTogglePlotted(row.name)} />
                  </TableCell>
                  <TableCell>{row.rank ?? ''}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{row.name}</TableCell>
                  <TableCell>{FREQ_LABEL[row.frequency_hz] ?? ''}</TableCell>
                  <TableCell>{row.spacing_in ? `${row.spacing_in} in` : ''}</TableCell>
                  <TableCell>{row.measurement ?? ''}</TableCell>
                  <TableCell>{row.doi_tier ?? ''}</TableCell>
                  <TableCell>{fmt(row.doi_index, 1)}</TableCell>
                  <TableCell sx={{ color: row.noise > 0.8 ? 'error.main' : undefined }}>{fmt(row.noise)}</TableCell>
                  <TableCell>{fmt(row.score)}</TableCell>
                  <TableCell>
                    <Tooltip title={row.reason || status.label} placement="left">
                      <Chip size="small" label={status.label} color={status.chip}
                        variant={row.status === 'auto' ? 'filled' : 'outlined'} />
                    </Tooltip>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  )
}

export default QcTable
