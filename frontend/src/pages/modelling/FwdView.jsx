import { useMemo } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import LineChart from '../../components/LineChart.jsx'
import { antName, chanShort, downloadText, fmtDur, fsig, toCSV } from '../../udar/format.js'
import { PH_MIN_AMP, ampYlim, ampdb, buildSection, chanArrays, chanStyles, pairKey, stIndex, stationCount } from '../../udar/state.js'
import { Card, Hint, Panel } from './fields.jsx'
import SectionChart from './SectionChart.jsx'

const R2D = 180 / Math.PI

export function StatusPill({ status }) {
  const m = { none: ['Not run yet', 'default'], ok: ['Up to date', 'success'], stale: ['Out of date', 'warning'], busy: ['Running', 'info'] }[status]
  return <Chip size="small" label={m[0]} color={m[1]} />
}

function exportCSV(f) {
  const hdr = ['MD_m', 'TVD_m', 'North_m', 'East_m', 'Inc_deg', 'Azi_deg']
  f.cfg.channels.forEach((c) => hdr.push(`${c.name} amp_dB`, `${c.name} phase_deg`, `${c.name} re`, `${c.name} im`))
  const rows = [hdr]
  for (let i = 0; i < f.nSt; i++) {
    const s = f.st[i]
    const r = [s.md, s.D, s.N, s.E, s.inc * R2D, s.az * R2D]
    for (let c = 0; c < f.nch; c++) {
      const re = f.data[2 * (i * f.nch + c)]
      const im = f.data[2 * (i * f.nch + c) + 1]
      r.push(ampdb(re, im), Math.atan2(im, re) * R2D, re, im)
    }
    rows.push(r.map((v) => +v.toPrecision(9)))
  }
  downloadText('udar_forward.csv', toCSV(rows))
}

function exportJSON(f) {
  const re = []
  const im = []
  for (let i = 0; i < f.nSt; i++) {
    const a = []
    const b = []
    for (let c = 0; c < f.nch; c++) {
      a.push(f.data[2 * (i * f.nch + c)])
      b.push(f.data[2 * (i * f.nch + c) + 1])
    }
    re.push(a)
    im.push(b)
  }
  const obj = {
    tool: 'UDAR Bench',
    note: 'normalised complex coupling, free-space ZZ coupling = 1, e^(-i omega t) convention',
    engine: 'exact layered earth (1D)',
    config: f.cfg,
    md: Array.from(f.st, (s) => s.md),
    tvd: Array.from(f.st, (s) => s.D),
    channels: f.cfg.channels.map((c) => c.name),
    re,
    im,
  }
  downloadText('udar_forward.json', JSON.stringify(obj), 'application/json')
}

function ValuesTable({ f, cursorMd }) {
  const i = stIndex(f.cfg, f.nSt, cursorMd)
  const st = f.st[i]
  return (
    <>
      <Typography variant="body2" sx={{ mb: 1 }}>
        MD <b>{fsig(st.md, 6)} m</b> · TVD <b>{fsig(st.D, 6)} m</b> · Inclination <b>{fsig(st.inc * R2D, 5)}°</b> · Azimuth <b>{fsig((((st.az * R2D) % 360) + 360) % 360, 5)}°</b>
      </Typography>
      <TableContainer sx={{ maxHeight: 320 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Channel</TableCell>
              <TableCell align="right">Amplitude (dB)</TableCell>
              <TableCell align="right">Phase (°)</TableCell>
              <TableCell align="right">Real</TableCell>
              <TableCell align="right">Imaginary</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {f.cfg.channels.map((c, j) => {
              const re = f.data[2 * (i * f.nch + j)]
              const im = f.data[2 * (i * f.nch + j) + 1]
              return (
                <TableRow key={c.sig}>
                  <TableCell>{c.name}</TableCell>
                  <TableCell align="right">{fsig(ampdb(re, im), 5)}</TableCell>
                  <TableCell align="right">{Math.hypot(re, im) > PH_MIN_AMP ? fsig(Math.atan2(im, re) * R2D, 5) : '–'}</TableCell>
                  <TableCell align="right">{fsig(re, 5)}</TableCell>
                  <TableCell align="right">{fsig(im, 5)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  )
}

export default function FwdView({ S, update, cfg, cfgError, fwd, status, progress, onRun, onCancel, setCursor, tr }) {
  const qty = S.chartQty
  const chs = fwd ? fwd.cfg.channels : cfg.channels
  const sty = useMemo(() => chanStyles(chs), [chs])
  const pairs = []
  chs.forEach((c, i) => {
    const k = pairKey(c)
    if (!pairs.some((p) => p.k === k)) pairs.push({ k, color: sty[i].color })
  })

  const groups = useMemo(() => {
    if (!fwd) return []
    const md = Float64Array.from(fwd.st, (s) => s.md)
    const fstyle = chanStyles(fwd.cfg.channels)
    const arr = fwd.cfg.channels.map((c, i) => chanArrays(fwd.data, fwd.nSt, fwd.nch, i))
    const map = new Map()
    fwd.cfg.channels.forEach((c, i) => {
      const k = chanShort(c)
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(i)
    })
    return Array.from(map.entries()).map(([k, idxs]) => {
      const A = []
      const B = []
      for (const i of idxs) {
        const pk = pairKey(fwd.cfg.channels[i])
        if (S.fwdSel[pk] === false) continue
        const a = arr[i]
        A.push({ name: pk, color: fstyle[i].color, x: md, y: qty === 'ap' ? a.amp : a.re })
        B.push({ name: pk, color: fstyle[i].color, x: md, y: qty === 'ap' ? a.ph : a.im })
      }
      const c0 = fwd.cfg.channels[idxs[0]]
      return { k, sub: `Tx ${antName(c0.tx)}, Rx ${antName(c0.rx)}`, A, B, ylimA: qty === 'ap' ? ampYlim(A) : null }
    })
  }, [fwd, qty, S.fwdSel])

  const sec = useMemo(() => (tr ? buildSection(cfg, tr) : null), [cfg, tr])
  const nSt = stationCount(cfg)

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(320px, 400px) 1fr' }, gap: 2 }}>
      <Stack spacing={2}>
        <Card title="Forward model" actions={<StatusPill status={status} />}>
          <Hint>
            {status === 'busy' && progress
              ? `Running: ${Math.round(100 * progress.f)}% done, ${fsig(progress.elapsed, 3)} s elapsed`
              : `${nSt} stations, ${cfg.channels.length} channels${fwd ? `; last run took ${fmtDur(fwd.ms / 1000)}` : ''}`}
          </Hint>
          <Stack direction="row" spacing={1} sx={{ my: 1 }}>
            <Button variant="contained" onClick={() => onRun(false)} disabled={status === 'busy' || Boolean(cfgError)}>
              Run forward model
            </Button>
            {status === 'busy' && <Button onClick={onCancel}>Cancel</Button>}
          </Stack>
          <LinearProgress variant="determinate" value={status === 'busy' && progress ? 100 * progress.f : 0} />
          <FormControlLabel
            control={<Checkbox size="small" checked={S.auto} onChange={(e) => update((d) => (d.auto = e.target.checked))} />}
            label="Update after an edit when the job is small"
          />
          {cfgError && <Alert severity="warning">{cfgError}</Alert>}
        </Card>
        <Card title="Display">
          <FormControl size="small" fullWidth sx={{ mb: 1 }}>
            <InputLabel id="qty">Quantity</InputLabel>
            <Select labelId="qty" label="Quantity" value={qty} onChange={(e) => update((d) => (d.chartQty = e.target.value))}>
              <MenuItem value="ap">Amplitude (dB) and phase (°)</MenuItem>
              <MenuItem value="ri">Real and imaginary (free-space ZZ = 1)</MenuItem>
            </Select>
          </FormControl>
          <Typography variant="caption">Spacing and frequency pairs</Typography>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', my: 0.5 }} useFlexGap>
            {pairs.map((p) => {
              const on = S.fwdSel[p.k] !== false
              return (
                <Chip
                  key={p.k}
                  size="small"
                  label={p.k}
                  variant={on ? 'filled' : 'outlined'}
                  icon={<Box component="span" sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: p.color, ml: '6px !important' }} />}
                  onClick={() => update((d) => (d.fwdSel[p.k] = !on))}
                />
              )
            })}
          </Stack>
          <Hint>
            Amplitude is 20·log10 of the coupling relative to the free-space ZZ coupling at the same spacing. Phase is the argument of that complex ratio (e^(−iωt) convention), unwrapped along the
            well.
          </Hint>
        </Card>
        <Card title="Export">
          <Stack direction="row" spacing={1}>
            <Button size="small" disabled={!fwd} onClick={() => exportCSV(fwd)}>
              Data as CSV
            </Button>
            <Button size="small" disabled={!fwd} onClick={() => exportJSON(fwd)}>
              Data as JSON
            </Button>
          </Stack>
          <Hint>Noise-free data at every station and channel.</Hint>
        </Card>
      </Stack>
      <Stack spacing={2}>
        {sec && (
          <Panel title="Tool position" sub="click the well or any log to move the tool">
            <SectionChart sec={sec} height={230} cursorMd={S.cursorMd} onPick={setCursor} />
          </Panel>
        )}
        {status === 'stale' && <Alert severity="warning">The model has changed since this run, so the logs below show the previous model. Press Run forward model to update them.</Alert>}
        {!fwd && <Typography color="text.secondary">No data yet. Press Run forward model.</Typography>}
        {groups.map((g) => (
          <Panel key={g.k} title={`${g.k} coupling`} sub={g.sub}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1 }}>
              <LineChart
                series={g.A}
                height={210}
                xlabel="Measured depth (m)"
                ylabel={qty === 'ap' ? 'Amplitude (dB)' : 'Real part'}
                ylim={g.ylimA}
                cursorX={S.cursorMd}
                onPick={(p) => setCursor(p.x)}
              />
              <LineChart series={g.B} height={210} xlabel="Measured depth (m)" ylabel={qty === 'ap' ? 'Phase (°)' : 'Imaginary part'} cursorX={S.cursorMd} onPick={(p) => setCursor(p.x)} legend={false} />
            </Box>
          </Panel>
        ))}
        {fwd && (
          <Panel title="Values at the tool position">
            <ValuesTable f={fwd} cursorMd={S.cursorMd} />
          </Panel>
        )}
      </Stack>
    </Box>
  )
}
