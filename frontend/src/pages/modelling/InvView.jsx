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
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import LineChart from '../../components/LineChart.jsx'
import { SERIES_COLORS, chanShort, clamp, downloadText, fsig, toCSV } from '../../udar/format.js'
import { ampYlim, ampdb, buildSection, chanArrays, chanStyles, specFreeCount, stIndex } from '../../udar/state.js'
import { Card, Hint, NumField, Panel } from './fields.jsx'
import { StatusPill } from './FwdView.jsx'
import SectionChart from './SectionChart.jsx'

const R2D = 180 / Math.PI
const col = (k) => SERIES_COLORS[k % SERIES_COLORS.length]

function StartModelTable({ spec }) {
  const rows = []
  spec.layers.forEach((L, k) => rows.push([`Rh, layer ${k + 1} (Ω·m)`, L.rh]))
  spec.layers.forEach((L, k) => rows.push([`Rv/Rh, layer ${k + 1}`, L.kv]))
  rows.push(['Boundary 1 (m)', spec.d1])
  spec.t.forEach((p, k) => rows.push([`Thickness, layer ${k + 2} (m)`, p]))
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Parameter</TableCell>
          <TableCell>Free</TableCell>
          <TableCell align="right">Start</TableCell>
          <TableCell align="right">Min</TableCell>
          <TableCell align="right">Max</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(([label, p]) => (
          <TableRow key={label}>
            <TableCell sx={{ whiteSpace: 'nowrap' }}>{label}</TableCell>
            <TableCell>{p.free ? 'yes' : 'no'}</TableCell>
            <TableCell align="right">{fsig(p.v, 4)}</TableCell>
            <TableCell align="right">{fsig(p.lo, 3)}</TableCell>
            <TableCell align="right">{fsig(p.hi, 3)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function exportInvCSV(inv) {
  const N = inv.res[0].rh.length
  const hdr = ['MD_m', 'TVD_m', 'chi2']
  for (let k = 0; k < N; k++) hdr.push(`Rh${k + 1}_ohmm`, `Rv${k + 1}_ohmm`)
  for (let k = 0; k < N - 1; k++) hdr.push(`dist_b${k + 1}_m`, `sd_b${k + 1}_m`)
  if (inv.truth) {
    for (let k = 0; k < N; k++) hdr.push(`true_Rh${k + 1}`)
    for (let k = 0; k < N - 1; k++) hdr.push(`true_dist_b${k + 1}`)
  }
  const rows = [hdr]
  inv.res.forEach((r, i) => {
    const st = inv.st[i]
    const row = [st.md, st.D, r.chi2]
    for (let k = 0; k < N; k++) row.push(r.rh[k], r.rv[k])
    for (let k = 0; k < N - 1; k++) row.push(r.zi[k], r.zsd[k])
    if (inv.truth) {
      const t = inv.truth[i]
      for (let k = 0; k < N; k++) row.push(t.rh[k])
      for (let k = 0; k < N - 1; k++) row.push(t.zi[k])
    }
    rows.push(row.map((v) => +v.toPrecision(8)))
  })
  downloadText('udar_inversion.csv', toCSV(rows))
}

function exportObsCSV(fwd, obs) {
  const hdr = ['MD_m', 'TVD_m']
  fwd.cfg.channels.forEach((c) => hdr.push(`${c.name} amp_dB`, `${c.name} phase_deg`))
  const rows = [hdr]
  for (let i = 0; i < fwd.nSt; i++) {
    const s = fwd.st[i]
    const r = [s.md, s.D]
    for (let c = 0; c < fwd.nch; c++) {
      const re = obs[2 * (i * fwd.nch + c)]
      const im = obs[2 * (i * fwd.nch + c) + 1]
      r.push(ampdb(re, im), Math.atan2(im, re) * R2D)
    }
    rows.push(r.map((v) => +v.toPrecision(9)))
  }
  downloadText('udar_noisy_data.csv', toCSV(rows))
}

function resultCharts(inv) {
  const res = inv.res
  const md = Float64Array.from(inv.st, (s) => s.md)
  const N = res[0].rh.length
  const A = []
  for (let k = 0; k < N; k++) {
    A.push({
      name: `Layer ${k + 1}`,
      color: col(k),
      x: md,
      y: Float64Array.from(res, (r) => r.rh[k]),
      band: [Float64Array.from(res, (r) => r.rh[k] * Math.exp(-r.sd[k])), Float64Array.from(res, (r) => r.rh[k] * Math.exp(r.sd[k]))],
    })
    if (inv.truth) A.push({ name: `Layer ${k + 1} true`, hideLegend: true, color: col(k), dash: [6, 3], width: 1.4, x: md, y: Float64Array.from(inv.truth, (t) => t.rh[k]) })
  }
  const B = []
  for (let k = 0; k < N - 1; k++) {
    B.push({
      name: `Boundary ${k + 1}`,
      color: col(k),
      x: md,
      y: Float64Array.from(res, (r) => r.zi[k]),
      band: [Float64Array.from(res, (r) => r.zi[k] - r.zsd[k]), Float64Array.from(res, (r) => r.zi[k] + r.zsd[k])],
    })
    if (inv.truth) B.push({ name: `Boundary ${k + 1} true`, hideLegend: true, color: col(k), dash: [6, 3], width: 1.4, x: md, y: Float64Array.from(inv.truth, (t) => t.zi[k]) })
  }
  B.push({ name: 'Tool', hideLegend: true, color: '#555', width: 1, x: md, y: new Float64Array(res.length) })
  const C = [{ name: 'χ²', color: col(0), x: md, y: Float64Array.from(res, (r) => Math.max(r.chi2, 1e-3)), marker: 3 }]
  const acc = inv.icfg.acceptChi2
  const chi = Float64Array.from(res, (r) => r.chi2).sort()
  const ok = res.filter((r) => r.chi2 <= acc).length
  const stats = { n: res.length, ok, med: chi[Math.floor(res.length / 2)], mean: chi.reduce((a, b) => a + b, 0) / res.length }
  return { A, B, C, stats, hl: [{ y: acc, color: '#d32f2f' }] }
}

function fitSeries(d, ci) {
  const nSt = d.st.length
  const md = Float64Array.from(d.st, (s) => s.md)
  const co = chanArrays(d.clean, nSt, d.nch, ci)
  const ob = chanArrays(d.obs, nSt, d.nch, ci)
  let mo = null
  if (d.res && d.j >= 0) {
    const buf = new Float64Array(nSt * 2)
    for (let i = 0; i < nSt; i++) {
      buf[2 * i] = d.res[i].sim[2 * d.j]
      buf[2 * i + 1] = d.res[i].sim[2 * d.j + 1]
    }
    mo = chanArrays(buf, nSt, 1, 0)
  }
  const mk = (key) => {
    const s = [
      { name: 'Noisy data', color: '#555', x: md, y: ob[key], marker: 2 },
      { name: 'True (noise-free)', color: SERIES_COLORS[0], x: md, y: co[key], width: 1.4, dash: [6, 3] },
    ]
    if (mo) s.push({ name: 'Inverted model', color: SERIES_COLORS[1], x: md, y: mo[key], width: 2 })
    return s
  }
  const A = mk('amp')
  return { A, B: mk('ph'), ylimA: ampYlim(A), hasModel: Boolean(mo) }
}

export default function InvView({ S, update, cfg, spec, fwd, obs, inv, status, busy, progress, onRun, onCancel, setCursor, tr }) {
  const iv = S.inv
  const nz = iv.noise
  const chs = cfg.channels
  const sty = useMemo(() => chanStyles(chs), [chs])
  const nSel = chs.filter((c) => iv.off.indexOf(c.sig) < 0).length
  const nFree = spec ? specFreeCount(spec) : 0
  const setInv = (k) => (v) => update((d) => (d.inv[k] = v))
  const setNoise = (k) => (v) => update((d) => (d.inv.noise[k] = v))

  const charts = useMemo(() => (inv ? resultCharts(inv) : null), [inv])
  const fitChan = clamp(iv.fitChan, 0, Math.max(0, chs.length - 1))
  const fit = useMemo(() => {
    if (inv) return fitSeries({ st: inv.st, nch: inv.nch, clean: inv.clean, obs: inv.obs, res: inv.res, j: inv.icfg.channels.indexOf(fitChan) }, fitChan)
    if (fwd && obs && fitChan < fwd.nch) return fitSeries({ st: fwd.st, nch: fwd.nch, clean: fwd.data, obs, res: null, j: -1 }, fitChan)
    return null
  }, [inv, fwd, obs, fitChan])

  const sec = useMemo(() => {
    const c = inv ? inv.cfg : cfg
    const t = inv ? inv.tr : tr
    if (!t) return null
    return buildSection(c, t)
  }, [inv, cfg, tr])

  const overlays = useMemo(() => {
    if (!inv || !sec) return []
    const N = inv.res[0].rh.length
    const out = []
    for (let k = 0; k < N - 1; k++) {
      out.push({
        color: '#eb6834',
        pts: inv.res.map((r, i) => {
          const st = inv.st[i]
          return [sec.vs(st.N, st.E), st.D + r.zi[k] / Math.max(0.05, r.nrm[2])]
        }),
      })
    }
    return out
  }, [inv, sec])

  const atCursor = useMemo(() => {
    if (!inv) return null
    const i = stIndex(inv.cfg, inv.st.length, S.cursorMd)
    return { r: inv.res[i], st: inv.st[i], t: inv.truth ? inv.truth[i] : null }
  }, [inv, S.cursorMd])

  const toggleChan = (sig) =>
    update((d) => {
      const k = d.inv.off.indexOf(sig)
      if (k >= 0) d.inv.off.splice(k, 1)
      else d.inv.off.push(sig)
    })

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(360px, 460px) 1fr' }, gap: 2 }}>
      <Stack spacing={2}>
        <Card title="Inversion" actions={<StatusPill status={status} />}>
          <Hint>
            {busy === 'inv' && progress
              ? `Running: ${Math.round(100 * progress.f)}% done, ${fsig(progress.elapsed, 3)} s elapsed`
              : `${nSel} of ${chs.length} channels selected: ${2 * nSel} data values per station, ${nFree} free parameters${inv ? `; last run took ${fsig(inv.ms / 1000, 3)} s` : ''}`}
          </Hint>
          <Stack direction="row" spacing={1} sx={{ my: 1 }}>
            <Button variant="contained" onClick={onRun} disabled={busy !== null}>
              Run inversion
            </Button>
            {busy === 'inv' && <Button onClick={onCancel}>Cancel</Button>}
          </Stack>
          <LinearProgress variant="determinate" value={busy === 'inv' && progress ? 100 * progress.f : 0} />
          {nSel > 0 && 2 * nSel <= nFree && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              There are no more data values than free parameters, so the inversion is under-determined and can take much longer. Select more channels or use fewer layers.
            </Alert>
          )}
          <Hint>Each station is inverted on its own with a layered model whose layers lie parallel to the assumed bedding. The forward data are computed first if they are out of date.</Hint>
        </Card>
        <Card title="Noise added to the synthetic data">
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1 }}>
            <NumField label="Amplitude" unit="dB" min={0} step={0.01} value={nz.ampDb} onChange={setNoise('ampDb')} width="100%" />
            <NumField label="Phase" unit="°" min={0} step={0.1} value={nz.phaseDeg} onChange={setNoise('phaseDeg')} width="100%" />
            <NumField label="Floor" unit="ppm" min={0} step={10} value={nz.floorPpm} onChange={setNoise('floorPpm')} width="100%" />
            <NumField label="Bias, amplitude" unit="dB" min={0} step={0.01} value={nz.biasDb} onChange={setNoise('biasDb')} width="100%" />
            <NumField label="Bias, phase" unit="°" min={0} step={0.1} value={nz.biasDeg} onChange={setNoise('biasDeg')} width="100%" />
            <NumField label="Seed" step={1} min={1} value={nz.seed} onChange={setNoise('seed')} width="100%" />
          </Box>
          <Button size="small" sx={{ mt: 1 }} onClick={() => update((d) => (d.inv.noise.seed = 1 + Math.floor(Math.random() * 999999)))}>
            New noise realisation
          </Button>
          <Hint>
            Gaussian noise on amplitude (dB) and phase, drawn independently per station and channel. The floor adds noise to the real and imaginary parts, in ppm of the free-space ZZ coupling. Bias
            is one random offset per channel, constant along the well. The inversion weights the data with these noise levels.
          </Hint>
        </Card>
        <Card title="Dip assumed by the inversion">
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
            <NumField label="Dip error" unit="°" step={0.5} value={iv.dipErr} onChange={setInv('dipErr')} width="100%" />
            <NumField label="Dip azimuth error" unit="°" step={1} value={iv.dipAzErr} onChange={setInv('dipAzErr')} width="100%" />
          </Box>
          <Hint>The inversion is told the formation dip and dip azimuth at each station. Add an error here to see how a wrong dip affects the result.</Hint>
        </Card>
        <Card title="Tool channels used in the inversion">
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }} useFlexGap>
            {chs.map((c, i) => {
              const on = iv.off.indexOf(c.sig) < 0
              return (
                <Chip
                  key={c.sig}
                  size="small"
                  label={c.name}
                  variant={on ? 'filled' : 'outlined'}
                  icon={<Box component="span" sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: sty[i].color, ml: '6px !important' }} />}
                  onClick={() => toggleChan(c.sig)}
                />
              )
            })}
          </Stack>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" onClick={() => update((d) => (d.inv.off = []))}>
              All
            </Button>
            <Button size="small" onClick={() => update((d) => (d.inv.off = chs.map((c) => c.sig)))}>
              None
            </Button>
            <Button size="small" onClick={() => update((d) => (d.inv.off = chs.filter((c) => chanShort(c) !== 'ZZ').map((c) => c.sig)))}>
              ZZ only
            </Button>
          </Stack>
        </Card>
        <Card title="Layer model">
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, alignItems: 'center' }}>
            <FormControl size="small">
              <InputLabel id="nl">Layers</InputLabel>
              <Select labelId="nl" label="Layers" value={iv.nLayers} onChange={(e) => update((d) => (d.inv.nLayers = e.target.value))}>
                {[2, 3, 4, 5, 6, 7].map((n) => (
                  <MenuItem key={n} value={n}>
                    {n}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <NumField label="Initial Rh error ×" min={1} step={0.1} value={iv.perturb.rho} onChange={(v) => update((d) => (d.inv.perturb.rho = v))} width="100%" />
            <NumField label="Boundary offset" unit="m" step={0.5} value={iv.perturb.d} onChange={(v) => update((d) => (d.inv.perturb.d = v))} width="100%" />
          </Box>
          <FormControlLabel
            control={<Checkbox size="small" checked={iv.anisoFree} onChange={(e) => update((d) => (d.inv.anisoFree = e.target.checked))} />}
            label="Invert the anisotropy ratio Rv/Rh"
          />
          {spec ? <StartModelTable spec={spec} /> : <Alert severity="warning">The starting model could not be built from the current geology.</Alert>}
          <Hint>
            The starting model is the true model with the errors above, so a synthetic test begins close to the answer. If a station fits poorly the solver also tries random starts. Boundary 1 is
            measured along the bedding normal from the tool; positive means below the tool.
          </Hint>
        </Card>
        <Card title="Solver">
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1 }}>
            <NumField label="Random starts" min={0} max={20} step={1} value={iv.nStarts} onChange={setInv('nStarts')} width="100%" />
            <NumField label="Iterations" min={5} max={200} step={5} value={iv.maxIter} onChange={setInv('maxIter')} width="100%" />
            <NumField label="Accept χ² below" min={1} step={0.1} value={iv.acceptChi2} onChange={setInv('acceptChi2')} width="100%" />
          </Box>
          <FormControl size="small" fullWidth sx={{ mt: 1 }}>
            <InputLabel id="ifilt">Hankel filter</InputLabel>
            <Select labelId="ifilt" label="Hankel filter" value={iv.filter} onChange={(e) => update((d) => (d.inv.filter = e.target.value))}>
              <MenuItem value="key_101_2012">101 points (fast)</MenuItem>
              <MenuItem value="key_201_2012">201 points (same as the forward model)</MenuItem>
            </Select>
          </FormControl>
          <FormControlLabel
            control={<Checkbox size="small" checked={iv.continuation} onChange={(e) => update((d) => (d.inv.continuation = e.target.checked))} />}
            label="Start each station from the previous solution"
          />
        </Card>
      </Stack>
      <Stack spacing={2}>
        {status === 'stale' && <Alert severity="warning">Settings have changed since this inversion ran. The results below belong to the previous settings.</Alert>}
        {sec && (
          <Panel title="Inverted section" sub="colour and dashed lines: true model; orange lines: inverted boundaries">
            <SectionChart sec={sec} height={300} cursorMd={S.cursorMd} onPick={setCursor} overlays={overlays} />
            {charts && (
              <Typography variant="body2" sx={{ px: 1 }}>
                Stations <b>{charts.stats.n}</b> · Within accept level{' '}
                <b>
                  {charts.stats.ok} ({fsig((100 * charts.stats.ok) / charts.stats.n, 3)}%)
                </b>{' '}
                · Median χ² <b>{fsig(charts.stats.med, 3)}</b> · Mean χ² <b>{fsig(charts.stats.mean, 3)}</b> · Run time <b>{fsig(inv.ms / 1000, 3)} s</b>
              </Typography>
            )}
          </Panel>
        )}
        {!inv && <Typography color="text.secondary">No inversion yet. Set the noise and the layer model, then press Run inversion.</Typography>}
        {charts && (
          <>
            <Panel title="Layer resistivities" sub="inverted (solid, with ±1σ band) and true (dashed)">
              <LineChart series={charts.A} ylog height={220} xlabel="Measured depth (m)" ylabel="Rh (Ω·m)" cursorX={S.cursorMd} onPick={(p) => setCursor(p.x)} />
            </Panel>
            <Panel title="Distance from the tool to each boundary" sub="along the bedding normal, positive below the tool; bands are ±1σ">
              <LineChart series={charts.B} height={220} xlabel="Measured depth (m)" ylabel="Distance (m)" cursorX={S.cursorMd} onPick={(p) => setCursor(p.x)} />
            </Panel>
            <Panel title="Misfit" sub="reduced χ² per station">
              <LineChart series={charts.C} ylog height={160} xlabel="Measured depth (m)" ylabel="Reduced χ²" hlines={charts.hl} cursorX={S.cursorMd} onPick={(p) => setCursor(p.x)} legend={false} />
            </Panel>
          </>
        )}
        <Panel title="Data fit">
          <FormControl size="small" sx={{ minWidth: 260, mb: 1 }}>
            <InputLabel id="fitc">Channel</InputLabel>
            <Select labelId="fitc" label="Channel" value={chs.length ? fitChan : ''} onChange={(e) => update((d) => (d.inv.fitChan = e.target.value))}>
              {chs.map((c, i) => (
                <MenuItem key={c.sig} value={i}>
                  {c.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {!fit && <Typography color="text.secondary">Run the forward model to see the noisy data.</Typography>}
          {fit && (
            <>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1 }}>
                <LineChart series={fit.A} ylim={fit.ylimA} height={210} xlabel="Measured depth (m)" ylabel="Amplitude (dB)" cursorX={S.cursorMd} onPick={(p) => setCursor(p.x)} />
                <LineChart series={fit.B} height={210} xlabel="Measured depth (m)" ylabel="Phase (°)" cursorX={S.cursorMd} onPick={(p) => setCursor(p.x)} legend={false} />
              </Box>
              {!fit.hasModel && <Hint>{inv ? 'This channel is not used in the inversion, so there is no model curve for it.' : 'The inverted model curve appears here after the inversion has run.'}</Hint>}
            </>
          )}
        </Panel>
        {atCursor && (
          <Panel title="Result at the tool position">
            <Typography variant="body2" sx={{ mb: 1 }}>
              MD <b>{fsig(atCursor.st.md, 6)} m</b> · TVD <b>{fsig(atCursor.st.D, 6)} m</b> · χ² <b>{fsig(atCursor.r.chi2, 3)}</b> · Function evaluations <b>{atCursor.r.nfev}</b>
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Layer</TableCell>
                  <TableCell align="right">Rh (Ω·m)</TableCell>
                  <TableCell align="right">Rv (Ω·m)</TableCell>
                  <TableCell align="right">True Rh</TableCell>
                  <TableCell align="right">True Rv</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {atCursor.r.rh.map((rh, k) => (
                  <TableRow key={k}>
                    <TableCell>Layer {k + 1}</TableCell>
                    <TableCell align="right">
                      {fsig(rh, 4)} ± {fsig(rh * (Math.exp(atCursor.r.sd[k]) - 1), 2)}
                    </TableCell>
                    <TableCell align="right">{fsig(atCursor.r.rv[k], 4)}</TableCell>
                    <TableCell align="right">{atCursor.t ? fsig(atCursor.t.rh[k], 4) : '–'}</TableCell>
                    <TableCell align="right">{atCursor.t ? fsig(atCursor.t.rv[k], 4) : '–'}</TableCell>
                  </TableRow>
                ))}
                {atCursor.r.zi.map((z, k) => (
                  <TableRow key={`b${k}`}>
                    <TableCell>Boundary {k + 1}</TableCell>
                    <TableCell align="right" colSpan={2}>
                      {fsig(z, 4)} ± {fsig(atCursor.r.zsd[k], 2)} m
                    </TableCell>
                    <TableCell align="right" colSpan={2}>
                      {atCursor.t ? `${fsig(atCursor.t.zi[k], 4)} m` : '–'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        )}
        <Panel title="Export">
          <Stack direction="row" spacing={1}>
            <Button size="small" disabled={!inv} onClick={() => exportInvCSV(inv)}>
              Inversion result as CSV
            </Button>
            <Button size="small" disabled={!fwd || !obs} onClick={() => exportObsCSV(fwd, obs)}>
              Noisy data as CSV
            </Button>
          </Stack>
        </Panel>
      </Stack>
    </Box>
  )
}
