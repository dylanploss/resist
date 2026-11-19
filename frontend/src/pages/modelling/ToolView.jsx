import { useMemo } from 'react'
import {
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  Typography,
} from '@mui/material'
import { getCore } from '../../compute/udarCore.js'
import LineChart from '../../components/LineChart.jsx'
import { chanShort, clone, fsig } from '../../udar/format.js'
import { COMPONENTS, PRESETS_TOOL, chanStyles, makeChannels, parseList } from '../../udar/state.js'
import { Card, Hint, NumField, Panel } from './fields.jsx'

const AXES = [
  ['Z', 'Z'],
  ['X', 'X'],
  ['Y', 'Y'],
  ['T', 'Tilt'],
]

function AntennaCell({ ant, onChange }) {
  return (
    <Stack spacing={0.5}>
      <Select size="small" value={ant.k} onChange={(e) => onChange({ ...ant, k: e.target.value })} inputProps={{ 'aria-label': 'Antenna orientation' }}>
        {AXES.map(([v, l]) => (
          <MenuItem key={v} value={v}>
            {l}
          </MenuItem>
        ))}
      </Select>
      {ant.k === 'T' && (
        <Stack direction="row" spacing={0.5}>
          <NumField label="Tilt °" value={ant.th} step={5} width={80} onChange={(v) => onChange({ ...ant, th: v })} />
          <NumField label="Az °" value={ant.ph} step={5} width={80} onChange={(v) => onChange({ ...ant, ph: v })} />
        </Stack>
      )}
    </Stack>
  )
}

function ToolLayout({ channels }) {
  const chs = channels.filter((c) => c.on)
  if (!chs.length) return <Typography color="text.secondary">No channels are enabled. Turn a channel on in the table.</Typography>
  const Ls = Array.from(new Set(chs.map((c) => Math.abs(c.L)))).sort((a, b) => b - a)
  const W = 760
  const rowH = 26
  const H = 26 + Ls.length * rowH + 24
  const x0 = 70
  const x1 = W - 300
  const xm = (x0 + x1) / 2
  const sx = (p) => xm + (p / Ls[0]) * ((x1 - x0) / 2) * 0.92
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxHeight: H * 1.4, fontSize: 11 }}>
      <rect x={x0 - 12} y={8} width={x1 - x0 + 24} height={10} rx={5} fill="#eceff1" stroke="#9aa1aa" />
      <line x1={xm} x2={xm} y1={4} y2={H - 14} stroke="#9aa1aa" strokeDasharray="2 3" />
      <text x={xm} y={H - 3} textAnchor="middle">
        measure point
      </text>
      {Ls.map((L, i) => {
        const y = 38 + i * rowH
        const here = chs.filter((c) => Math.abs(c.L) === L)
        const fs = Array.from(new Set(here.map((c) => c.f))).sort((a, b) => b - a)
        const label = fs.map((f) => `${fsig(f, 3)} kHz: ${here.filter((c) => c.f === f).map(chanShort).join(' ')}`).join('   ')
        return (
          <g key={L}>
            <line x1={sx(-L / 2)} x2={sx(L / 2)} y1={y} y2={y} stroke="#9aa1aa" strokeWidth={1.5} />
            <circle cx={sx(-L / 2)} cy={y} r={7} fill="#eb6834" stroke="#333" />
            <text x={sx(-L / 2)} y={y + 3.5} textAnchor="middle" fill="#fff" fontWeight={600}>
              T
            </text>
            <circle cx={sx(L / 2)} cy={y} r={7} fill="#fff" stroke="#333" />
            <text x={sx(L / 2)} y={y + 3.5} textAnchor="middle" fontWeight={600}>
              R
            </text>
            <text x={8} y={y + 4}>
              {fsig(L, 3)} m
            </text>
            <text x={x1 + 20} y={y + 4}>
              {label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function homogeneousCurves(channels, filter) {
  const { Engine, HANKEL_FILTERS } = getCore()
  const chs = channels.filter((c) => c.on)
  const pairs = []
  for (const c of chs) {
    const k = `${Math.abs(c.L)}|${c.f}`
    if (!pairs.some((p) => p.k === k)) pairs.push({ k, L: Math.abs(c.L), f: c.f })
  }
  const sty = chanStyles(pairs.map((p) => ({ L: p.L, f: p.f, tx: { k: 'Z' }, rx: { k: 'Z' } })))
  const filt = HANKEL_FILTERS[filter]
  const T = new Float64Array(10)
  const rs = []
  for (let i = 0; i <= 40; i++) rs.push(Math.pow(10, -1 + (4 * i) / 40))
  const A = []
  const B = []
  pairs.forEach((p, j) => {
    const a = []
    const ph = []
    for (const r of rs) {
      const m = { N: 1, sh: Float64Array.of(1 / r), sv: Float64Array.of(1 / r), zi: new Float64Array(0) }
      Engine.tensor(2 * Math.PI * p.f * 1000, m, 0, p.L, 0, 1, filt, T)
      const sc = 2 * Math.PI * p.L ** 3
      const re = T[4] * sc
      const im = T[5] * sc
      a.push(20 * Math.log10(Math.hypot(re, im)))
      ph.push((Math.atan2(im, re) * 180) / Math.PI)
    }
    for (let i = ph.length - 2; i >= 0; i--) ph[i] -= 360 * Math.round((ph[i] - ph[i + 1]) / 360)
    const name = `${fsig(p.L, 3)} m, ${fsig(p.f, 3)} kHz`
    A.push({ name, color: sty[j].color, x: rs, y: a })
    B.push({ name, color: sty[j].color, x: rs, y: ph })
  })
  return { A, B }
}

export default function ToolView({ S, update }) {
  const T = S.tool
  const gen = T.gen
  const curves = useMemo(() => homogeneousCurves(T.channels, S.filter), [T.channels, S.filter])

  const setChan = (i, patch) => update((d) => Object.assign(d.tool.channels[i], patch))
  const doGen = (append) => {
    const sp = parseList(gen.spacings)
    const fr = parseList(gen.freqs)
    const comps = Object.keys(gen.comps).filter((c) => gen.comps[c])
    if (!sp.length || !fr.length || !comps.length) return
    const rows = makeChannels({ spacings: sp, freqs: fr, comps, pair: gen.pair })
    update((d) => {
      d.tool.channels = append ? d.tool.channels.concat(rows) : rows
    })
  }
  const loadPreset = (name) => {
    const p = PRESETS_TOOL[name]
    if (!p) return
    update((d) => {
      d.tool.channels = makeChannels(p)
      d.tool.gen.spacings = p.spacings.join(', ')
      d.tool.gen.freqs = p.freqs.join(', ')
      d.tool.gen.pair = p.pair
      for (const c of Object.keys(d.tool.gen.comps)) d.tool.gen.comps[c] = p.comps.indexOf(c) >= 0
    })
  }

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(420px, 520px) 1fr' }, gap: 2 }}>
      <Stack spacing={2}>
        <Card title="Channels">
          <Hint>
            Each channel is one transmitter–receiver pair at one frequency. Spacing is signed: a negative value puts the receiver behind the transmitter. Channels are depth-shifted to a common
            measure point (the pair midpoint).
          </Hint>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">On</TableCell>
                <TableCell>Spacing (m)</TableCell>
                <TableCell>Freq (kHz)</TableCell>
                <TableCell>Tx axis</TableCell>
                <TableCell>Rx axis</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {T.channels.map((c, i) => (
                <TableRow key={i}>
                  <TableCell padding="checkbox">
                    <Checkbox size="small" checked={c.on} onChange={(e) => setChan(i, { on: e.target.checked })} />
                  </TableCell>
                  <TableCell>
                    <NumField label="" value={c.L} step={0.5} width={80} onChange={(v) => setChan(i, { L: v })} />
                  </TableCell>
                  <TableCell>
                    <NumField label="" value={c.f} min={0.01} width={80} onChange={(v) => setChan(i, { f: v })} />
                  </TableCell>
                  <TableCell>
                    <AntennaCell ant={c.tx} onChange={(a) => setChan(i, { tx: a })} />
                  </TableCell>
                  <TableCell>
                    <AntennaCell ant={c.rx} onChange={(a) => setChan(i, { rx: a })} />
                  </TableCell>
                  <TableCell padding="none">
                    {T.channels.length > 1 && (
                      <IconButton size="small" aria-label="Remove channel" onClick={() => update((d) => d.tool.channels.splice(i, 1))}>
                        ×
                      </IconButton>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button
              size="small"
              onClick={() =>
                update((d) => {
                  const l = d.tool.channels[d.tool.channels.length - 1]
                  d.tool.channels.push({ ...clone(l), on: true })
                })
              }
            >
              Add channel
            </Button>
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel id="tool-preset">Load a preset…</InputLabel>
              <Select labelId="tool-preset" label="Load a preset…" value="" onChange={(e) => loadPreset(e.target.value)}>
                {Object.keys(PRESETS_TOOL).map((k) => (
                  <MenuItem key={k} value={k}>
                    {k}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </Card>
        <Card title="Generate a channel set">
          <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
            <TextField size="small" label="Spacings (m)" value={gen.spacings} onChange={(e) => update((d) => (d.tool.gen.spacings = e.target.value))} />
            <TextField size="small" label="Frequencies (kHz)" value={gen.freqs} onChange={(e) => update((d) => (d.tool.gen.freqs = e.target.value))} />
          </Stack>
          <FormControlLabel
            control={<Checkbox size="small" checked={gen.pair} onChange={(e) => update((d) => (d.tool.gen.pair = e.target.checked))} />}
            label="Pair the n-th spacing with the n-th frequency"
          />
          <Typography variant="caption" component="div">
            Components (Tx axis, Rx axis)
          </Typography>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', my: 0.5 }} useFlexGap>
            {COMPONENTS.map((c) => (
              <ToggleButton key={c} size="small" value={c} selected={!!gen.comps[c]} onChange={() => update((d) => (d.tool.gen.comps[c] = !d.tool.gen.comps[c]))}>
                {c}
              </ToggleButton>
            ))}
          </Stack>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="contained" onClick={() => doGen(false)}>
              Replace channel list
            </Button>
            <Button size="small" onClick={() => doGen(true)}>
              Add to list
            </Button>
          </Stack>
        </Card>
        <Card title="Numerical accuracy">
          <FormControl size="small" fullWidth>
            <InputLabel id="hankel">Hankel transform filter</InputLabel>
            <Select labelId="hankel" label="Hankel transform filter" value={S.filter} onChange={(e) => update((d) => (d.filter = e.target.value))}>
              <MenuItem value="key_201_2012">201 points (accurate)</MenuItem>
              <MenuItem value="key_101_2012">101 points (about 2× faster)</MenuItem>
            </Select>
          </FormControl>
          <Hint>
            Over 120 test models the 201-point filter differs from the empymod package by at most 2.2e-8 of the free-space coupling, and the 101-point filter by at most 1.7e-5.
          </Hint>
        </Card>
      </Stack>
      <Stack spacing={2}>
        <Panel title="Transmitter and receiver layout" sub="nested spacings share one measure point">
          <ToolLayout channels={T.channels} />
        </Panel>
        <Panel title="Axial (ZZ) coupling in a homogeneous formation" sub="free-space coupling = 0 dB, 0°">
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1 }}>
            <LineChart series={curves.A} xlog xlabel="Resistivity (Ω·m)" ylabel="Amplitude (dB)" height={240} />
            <LineChart series={curves.B} xlog xlabel="Resistivity (Ω·m)" ylabel="Phase (°)" height={240} />
          </Box>
        </Panel>
        <Hint>
          Couplings are magnetic-dipole fields per unit moment, normalised by the free-space ZZ coupling at the same spacing, 1/(2π|L|³). Tx and Rx are point dipoles on a rigid straight tool;
          borehole, mandrel and displacement currents are neglected.
        </Hint>
      </Stack>
    </Box>
  )
}
