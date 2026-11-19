import { Fragment, useEffect, useRef, useState } from 'react'
import {
  Box, Checkbox, Chip, FormControlLabel, Link, Switch, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material'
import { FREQ_LABEL, STATUS, compareGroup, fmt, groupLabel } from '../api.js'

const FILTERS = [
  ['measurements', 'All'], ['AR', 'AR'], ['ZR', 'ZR'], ['ZG', 'ZG'], ['context', 'Other logs'],
]
const COLUMNS = ['Use', 'Plot', '#', 'Curve', 'Freq', 'Spacing', 'Type', 'Depth', 'DOI', 'Noise', 'Score', 'Status']

function matches(row, filter) {
  if (filter === 'measurements') return row.status !== 'context'
  if (filter === 'context') return row.status === 'context'
  return row.family === filter
}

function QcTable({ rows, checked, plotted, focus, onToggleChecked, onTogglePlotted, onShowCurve }) {
  const [filter, setFilter] = useState('measurements')
  const [order, setOrder] = useState('grouped')
  const [hideRejected, setHideRejected] = useState(false)
  const container = useRef(null)
  const visible = rows.filter((row) => matches(row, filter) && !(hideRejected && row.status === 'rejected'))
  if (order === 'grouped') visible.sort(compareGroup)

  useEffect(() => {
    const box = container.current
    const row = focus && box?.querySelector(`[data-curve="${CSS.escape(focus)}"]`)
    if (!row) return
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top
    box.scrollTo({ top: box.scrollTop + offset - box.clientHeight / 2, behavior: 'smooth' })
  }, [focus])

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1, flexWrap: 'wrap' }}>
        <ToggleButtonGroup size="small" exclusive value={filter}
          onChange={(_, value) => value && setFilter(value)}>
          {FILTERS.map(([value, label]) => <ToggleButton key={value} value={value}>{label}</ToggleButton>)}
        </ToggleButtonGroup>
        <ToggleButtonGroup size="small" exclusive value={order}
          onChange={(_, value) => value && setOrder(value)}>
          <ToggleButton value="grouped">Grouped</ToggleButton>
          <ToggleButton value="score">By score</ToggleButton>
        </ToggleButtonGroup>
        <FormControlLabel label="Hide rejected" control={
          <Switch size="small" checked={hideRejected} onChange={(e) => setHideRejected(e.target.checked)} />
        } />
        <Typography variant="caption" color="text.secondary">
          {visible.length} curves · Use = include in inversion · click a name to view its log
        </Typography>
      </Box>
      <TableContainer ref={container} sx={{ maxHeight: 460, border: 1, borderColor: 'divider', borderRadius: 1,
        '& td, & th': { whiteSpace: 'nowrap' } }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {COLUMNS.map((h) => <TableCell key={h} sx={{ fontWeight: 600 }}>{h}</TableCell>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((row, i) => {
              const status = STATUS[row.status]
              const header = order === 'grouped' && (i === 0 || groupLabel(visible[i - 1]) !== groupLabel(row))
              return (
                <Fragment key={row.name}>
                  {header && (
                    <TableRow>
                      <TableCell colSpan={COLUMNS.length}
                        sx={{ bgcolor: 'grey.100', fontWeight: 600, py: 0.5, color: 'text.secondary' }}>
                        {groupLabel(row)}
                      </TableCell>
                    </TableRow>
                  )}
                  <TableRow hover selected={checked.includes(row.name)} data-curve={row.name}
                    sx={row.name === focus ? { outline: '2px solid #ffb300', outlineOffset: -2 } : undefined}>
                    <TableCell padding="checkbox">
                      <Checkbox size="small" disabled={row.status === 'context'}
                        checked={checked.includes(row.name)} onChange={() => onToggleChecked(row.name)} />
                    </TableCell>
                    <TableCell padding="checkbox">
                      <Checkbox size="small" color="secondary"
                        checked={plotted.includes(row.name)} onChange={() => onTogglePlotted(row.name)} />
                    </TableCell>
                    <TableCell>{row.rank ?? ''}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>
                      <Link component="button" underline="hover" onClick={() => onShowCurve(row.name)}
                        sx={{ fontFamily: 'inherit', fontSize: 'inherit' }}>{row.name}</Link>
                    </TableCell>
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
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  )
}

export default QcTable
