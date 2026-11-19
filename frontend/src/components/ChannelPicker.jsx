import { useMemo, useState } from 'react'
import {
  Box, Button, Checkbox, Chip, FormControlLabel, MenuItem, Select, Switch, Tooltip, Typography,
} from '@mui/material'
import { STATUS, fmt } from '../api.js'

const MNEMONIC = /^(AR|ZR|ZG)([HML])(\d+)([PA])([CTBLR]?)$/
const FREQ = { H: '2 MHz', M: '500 kHz', L: '125 kHz' }
const FREQ_ORDER = { H: 0, M: 1, L: 2 }
const STATUS_RANK = { rejected: 0, duplicate: 1, candidate: 2, auto: 3 }

const GROUPS = [
  { type: 'avg', title: 'Averaged resistivity', code: 'AR', note: 'One value per depth: the 32 bins averaged.' },
  { type: 'image', title: 'Resistivity images', code: 'ZR', note: '32 values per depth, one per 11.25° bin.' },
  { type: 'quad', title: 'Quadrant resistivities', code: 'ZR…T/B/L/R', note: 'Ticking a box selects all four quadrants.' },
  { type: 'geo', title: 'Geosignals', code: 'ZG', note: '32 bins minus their average, from the far receiver.' },
]

function typeOf(family, suffix) {
  if (family === 'AR') return 'avg'
  if (family === 'ZG') return 'geo'
  return 'TBLR'.includes(suffix) && suffix ? 'quad' : 'image'
}

// Rows keyed by type, frequency and spacing; each with phase/attenuation cells listing the curve names behind them.
function catalogue(rows) {
  const out = Object.fromEntries(GROUPS.map((g) => [g.type, []]))
  const seen = {}
  for (const row of rows) {
    const m = MNEMONIC.exec(row.name)
    if (!m) continue
    const [, family, fc, sp, kind, suffix] = m
    const type = typeOf(family, suffix)
    const key = type + fc + sp
    if (!seen[key]) {
      seen[key] = { type, fc, sp: Number(sp), P: null, A: null }
      out[type].push(seen[key])
    }
    const cell = seen[key][kind] ?? (seen[key][kind] = { base: null, corr: null, quads: [] })
    if (type === 'quad') cell.quads.push(row.name)
    else if (suffix === 'C') cell.corr = row.name
    else cell.base = row.name
  }
  for (const t of Object.keys(out)) out[t].sort((a, b) => FREQ_ORDER[a.fc] - FREQ_ORDER[b.fc] || a.sp - b.sp)
  return out
}

// The curve names a cell stands for: four quadrants, or the raw/corrected twin in use.
function cellNames(cell, checked, useCorr) {
  if (cell.quads.length) return cell.quads
  if (cell.corr && checked.includes(cell.corr)) return [cell.corr]
  if (cell.base && checked.includes(cell.base)) return [cell.base]
  return [useCorr && cell.corr ? cell.corr : cell.base ?? cell.corr]
}

function cellInfo(names, byName) {
  const rs = names.map((n) => byName[n]).filter(Boolean)
  if (!rs.length) return null
  const score = rs.reduce((s, r) => s + (r.score ?? 0), 0) / rs.length
  const worst = rs.reduce((w, r) => (STATUS_RANK[r.status] < STATUS_RANK[w.status] ? r : w), rs[0])
  return { rows: rs, score, status: worst.status }
}

function CellTip({ info }) {
  return (
    <Box sx={{ fontSize: 12 }}>
      {info.rows.map((r) => (
        <Box key={r.name} sx={{ mb: 0.5 }}>
          <b>{r.name}</b> · {STATUS[r.status].label}
          <br />score {fmt(r.score)} · noise {fmt(r.noise)} · coverage {fmt(r.coverage)} · {r.doi_tier ?? '–'}
          {r.reason && <><br /><i>{r.reason}</i></>}
        </Box>
      ))}
      <i>Click the score to view the log.</i>
    </Box>
  )
}

function PickCell({ cell, checked, useCorr, byName, focus, onToggle, onShow }) {
  if (!cell) return <td style={{ textAlign: 'center', color: '#9e9e9e' }}>–</td>
  const names = cellNames(cell, checked, useCorr)
  const info = cellInfo(names, byName)
  if (!info) return <td />
  const on = names.filter((n) => checked.includes(n)).length
  const status = STATUS[info.status]
  const focused = names.includes(focus)
  return (
    <td style={{ textAlign: 'center', padding: '1px 2px' }}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
        <Checkbox size="small" sx={{ p: 0.25 }} checked={on === names.length} indeterminate={on > 0 && on < names.length}
          onChange={() => onToggle(names, on !== names.length, cell)} slotProps={{ input: { 'aria-label': names.join(', ') } }} />
        <Tooltip title={<CellTip info={info} />} placement="right" arrow>
          <Box component="button" type="button" onClick={() => onShow(names)}
            sx={{
              minWidth: 38, px: 0.5, py: 0.1, fontSize: 11, fontVariantNumeric: 'tabular-nums', cursor: 'pointer',
              borderRadius: 1, border: '1px solid', borderColor: status.color,
              bgcolor: info.status === 'auto' ? status.color : 'transparent',
              color: info.status === 'auto' ? '#fff' : status.color,
              opacity: info.status === 'rejected' ? 0.7 : 1,
              outline: focused ? '2px solid #ffb300' : 'none', outlineOffset: 1,
              textDecoration: info.status === 'rejected' ? 'line-through' : 'none',
            }}>
            {fmt(info.score)}
          </Box>
        </Tooltip>
      </Box>
    </td>
  )
}

function ChannelPicker({ rows, checked, plotted, focus, nSelect, onNSelect, onSetChecked, onReset, onShow, onTogglePlotted }) {
  const [useCorr, setUseCorr] = useState(false)
  const byName = useMemo(() => Object.fromEntries(rows.map((r) => [r.name, r])), [rows])
  const cat = useMemo(() => catalogue(rows), [rows])
  const context = rows.filter((r) => r.status === 'context' && !/^(DEPT|TVD|TVDSS|UTMX|UTMY)$/.test(r.name))
  const hasCorr = rows.some((r) => /^AR.*C$/.test(r.name))

  const toggle = (names, add, cell) => {
    const twins = cell.quads.length ? cell.quads : [cell.base, cell.corr].filter(Boolean)
    const rest = checked.filter((n) => !twins.includes(n))
    onSetChecked(add ? [...rest, ...names] : rest, add ? names : [], add ? [] : twins)
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mb: 1 }}>
        <Button size="small" variant="outlined" onClick={onReset}>Auto-pick</Button>
        <Select size="small" value={nSelect} onChange={(e) => onNSelect(e.target.value)} aria-label="Auto-pick count"
          sx={{ fontSize: 13, '& .MuiSelect-select': { py: 0.5 } }}>
          {[5, 6, 7, 8, 9, 10].map((n) => <MenuItem key={n} value={n}>{n} curves</MenuItem>)}
        </Select>
        <Button size="small" onClick={() => onSetChecked([], [], checked)}>Clear</Button>
      </Box>
      {hasCorr && (
        <FormControlLabel sx={{ mb: 0.5, '& .MuiFormControlLabel-label': { fontSize: 12.5 } }}
          control={<Switch size="small" checked={useCorr} onChange={(e) => setUseCorr(e.target.checked)} />}
          label="Use corrected averaged channels (C) where available" />
      )}
      <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: 1 }}>
        {['auto', 'candidate', 'duplicate', 'rejected'].map((s) => (
          <Box key={s} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontSize: 11, color: 'text.secondary' }}>
            <Box sx={{ width: 10, height: 10, borderRadius: 0.5, border: '1px solid', borderColor: STATUS[s].color,
              bgcolor: s === 'auto' ? STATUS[s].color : 'transparent' }} />
            {STATUS[s].label}
          </Box>
        ))}
      </Box>
      {GROUPS.map((g) => {
        const list = cat[g.type]
        if (!list.length) return null
        return (
          <Box key={g.type} sx={{ pt: 1, mt: 1, borderTop: 1, borderColor: 'divider' }}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
              <Typography variant="subtitle2">{g.title}</Typography>
              <Typography variant="caption" color="text.secondary">{g.code}</Typography>
            </Box>
            <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5,
              '& th': { fontWeight: 500, color: 'text.secondary', textAlign: 'left', fontSize: 11.5, py: 0.25 },
              '& tbody tr:hover': { bgcolor: 'action.hover' } }}>
              <thead>
                <tr><th>Frequency</th><th>Spacing</th><th style={{ textAlign: 'center' }}>Phase</th>
                  <th style={{ textAlign: 'center' }}>Attenuation</th></tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.fc + r.sp}>
                    <td>{FREQ[r.fc]}</td>
                    <td>{r.sp} in</td>
                    {['P', 'A'].map((k) => (
                      <PickCell key={k} cell={r[k]} checked={checked} useCorr={useCorr} byName={byName} focus={focus}
                        onToggle={toggle} onShow={onShow} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </Box>
            <Typography variant="caption" color="text.secondary">{g.note}</Typography>
          </Box>
        )
      })}
      {context.length > 0 && (
        <Box sx={{ pt: 1, mt: 1, borderTop: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle2">Context logs</Typography>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
            Not inverted; click to add to or remove from the tracks.
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {context.map((r) => (
              <Chip key={r.name} size="small" label={r.name} onClick={() => onTogglePlotted(r.name)}
                color={plotted.includes(r.name) ? 'primary' : 'default'}
                variant={plotted.includes(r.name) ? 'filled' : 'outlined'} sx={{ fontFamily: 'monospace' }} />
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

export default ChannelPicker
