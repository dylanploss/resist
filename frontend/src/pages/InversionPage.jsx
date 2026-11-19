import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Chip, CircularProgress, FormControl, FormControlLabel, InputLabel, LinearProgress, MenuItem,
  Paper, Select, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material'
import {
  getAutoSelection, getInversionDefaults, getInversionJob, getSavedSelection, postInversionJob, postInversionPlan,
} from '../api.js'
import { useApi } from '../hooks/useApi.js'
import ApiStatus from '../components/ApiStatus.jsx'
import RunPicker from '../components/RunPicker.jsx'
import CurtainPlot from '../components/inversion/CurtainPlot.jsx'
import InversionTracks from '../components/inversion/InversionTracks.jsx'

const BASE_SETTINGS = { step: 4, layers: 3, calibration: true, quick: false, sectionFt: '15' }
const ACTIVE = ['queued', 'running']

export function Card({ title, extra, children }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      {title && (
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{title}</Typography>
          {extra && <Typography variant="caption" color="text.secondary">{extra}</Typography>}
        </Box>
      )}
      {children}
    </Paper>
  )
}

export function Stat({ label, value }) {
  return (
    <Typography variant="body2" component="span" color="text.secondary">
      {label} <Box component="b" sx={{ color: 'text.primary' }}>{value}</Box>
    </Typography>
  )
}

// Curves come from the QC page: the live selection if the user visited it, else the saved selection, else auto-pick.
export function useQcCurves(run, liveSelection) {
  const live = liveSelection && liveSelection.length ? liveSelection : null
  const [fetched, setFetched] = useState({ run: null, curves: [], from: null, error: null })
  useEffect(() => {
    if (!run || live) return undefined
    let cancelled = false
    getSavedSelection(run)
      .then((s) => ({ run, curves: s.curves, from: `saved QC selection (${s.saved_at})`, error: null }))
      .catch(() => getAutoSelection(run)
        .then((q) => ({ run, curves: q.selected, from: 'QC auto-pick (nothing saved yet)', error: null })))
      .then((r) => !cancelled && setFetched(r))
      .catch((e) => !cancelled && setFetched({ run, curves: [], from: null, error: e.message }))
    return () => { cancelled = true }
  }, [run, live])
  if (live) return { curves: live, from: 'QC page (current selection)', loading: false, error: null }
  const current = fetched.run === run
  return { curves: current ? fetched.curves : [], from: current ? fetched.from : null,
    loading: Boolean(run) && !current, error: current ? fetched.error : null }
}

const KIND_TAG = { avg: '', top: ' top', bottom: ' bottom', geosignal: ' top' }
const KIND_COLOR = { avg: 'primary', top: 'success', bottom: 'secondary', geosignal: 'warning' }

function PlanView({ plan }) {
  return (
    <Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
        {plan.used.map((u) => (
          <Tooltip key={u.label} title={`${u.label}: ${u.measurement}, ${u.kind === 'avg' ? 'azimuthal average'
            : u.kind === 'geosignal' ? 'top-bin geosignal' : `${u.kind} bin`}, from ${u.source}, weight ${u.weight}`
            + (u.guessed_geometry ? '; GUESSED long-spacing antenna geometry (unconfirmed)' : '')
            + (u.correction
              ? `; Z-20 correction ×${u.correction.factor_at_10_ohmm} at 10 Ω·m, ×${u.correction.factor_at_40_ohmm} at 40 Ω·m` : '')}>
            <Chip size="small" variant={u.measurement === 'phase' ? 'outlined' : 'filled'}
              color={KIND_COLOR[u.kind]} sx={{ fontFamily: 'monospace', ...(u.guessed_geometry ? { borderStyle: 'dashed' } : {}) }}
              label={`${u.guessed_geometry ? '⚠ ' : ''}${u.curve}${KIND_TAG[u.kind]} · w${u.weight}${u.correction ? ' · corr' : ''}${u.guessed_geometry ? ' · guess' : ''}`} />
          </Tooltip>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
        {plan.azimuthal
          ? 'Directional data in use: top/bottom bins and geosignals place boundaries above or below the well.'
          : 'Averaged curves only: add ZR images or ZG geosignals in QC to resolve whether beds are above or below.'}
      </Typography>
      {plan.ignored.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="caption" color="text.secondary">Not used:</Typography>
          {plan.ignored.map((i) => (
            <Typography key={i.curve} variant="caption" component="div" color="text.secondary">
              <Box component="span" sx={{ fontFamily: 'monospace' }}>{i.curve}</Box> – {i.reason}
            </Typography>
          ))}
        </Box>
      )}
      {plan.warnings.map((w) => <Alert key={w} severity="warning" sx={{ py: 0, mb: 0.5 }}>{w}</Alert>)}
    </Box>
  )
}

function misfitText(c) {
  if (c.rms == null) return '–'
  if (c.unit === 'ohm.m') return `${c.rms_percent.toFixed(1)}%`
  return `${c.rms.toFixed(2)} ${c.unit}`
}

function MisfitTable({ curves }) {
  return (
    <Table size="small" sx={{ '& td, & th': { whiteSpace: 'nowrap', px: 1 } }}>
      <TableHead>
        <TableRow>
          {['Channel', 'Kind', 'Source', 'Used', 'Weight', 'Noise σ', 'Correction', 'RMS misfit', 'RMS / σ'].map((h) => (
            <TableCell key={h} sx={{ fontWeight: 600 }}>{h}</TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {curves.map((c) => (
          <TableRow key={c.label} sx={{ opacity: c.used ? 1 : 0.5 }}>
            <TableCell sx={{ fontFamily: 'monospace' }}>{c.label}</TableCell>
            <TableCell>{c.kind}{c.guessed_geometry ? ' ⚠ guessed geometry' : ''}</TableCell>
            <TableCell sx={{ fontFamily: 'monospace' }}>{c.source}</TableCell>
            <TableCell>{c.used ? 'yes' : 'no'}</TableCell>
            <TableCell>{c.weight}</TableCell>
            <TableCell>{c.unit === 'ohm.m' ? `${(100 * (10 ** c.sigma - 1)).toFixed(1)}%` : `${c.sigma} ${c.unit}`}</TableCell>
            <TableCell>{c.correction_applied ? 'Z-20 gain' : '–'}</TableCell>
            <TableCell>{misfitText(c)}</TableCell>
            <TableCell sx={{ color: c.used && c.rms_normalised > 3 ? 'error.main' : undefined }}>
              {c.rms_normalised == null ? '–' : c.rms_normalised.toFixed(2)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function InversionPage({ runs, run, onRunChange, liveSelection, onOpenQc }) {
  const qcCurves = useQcCurves(run, liveSelection)
  const defaults = useApi(() => getInversionDefaults(run), run || null)
  const [settingsByRun, setSettingsByRun] = useState({})
  const [plan, setPlan] = useState({ key: null, body: null, error: null })
  const [job, setJob] = useState(null)
  const [submitError, setSubmitError] = useState(null)
  const [showAll, setShowAll] = useState(false)

  const settings = useMemo(() => settingsByRun[run] ?? (defaults.data
    ? { ...BASE_SETTINGS, mdMin: String(defaults.data.md_min_ft), mdMax: String(defaults.data.md_max_ft) } : null),
  [settingsByRun, run, defaults.data])
  const update = (patch) => setSettingsByRun((s) => ({ ...s, [run]: { ...settings, ...patch } }))

  const request = useMemo(() => (settings && qcCurves.curves.length ? {
    run, curves: qcCurves.curves, md_min_ft: Number(settings.mdMin), md_max_ft: Number(settings.mdMax),
    step_ft: settings.step, layers: settings.layers, calibration: settings.calibration, quick: settings.quick,
  } : null), [run, qcCurves.curves, settings])
  const planKey = request ? JSON.stringify(request) : null

  useEffect(() => {
    if (!planKey) return undefined
    let cancelled = false
    postInversionPlan(JSON.parse(planKey))
      .then((body) => !cancelled && setPlan({ key: planKey, body, error: null }))
      .catch((e) => !cancelled && setPlan({ key: planKey, body: null, error: e.message }))
    return () => { cancelled = true }
  }, [planKey])

  const jobId = job?.id
  const jobActive = ACTIVE.includes(job?.status)
  useEffect(() => {
    if (!jobId || !jobActive) return undefined
    const timer = setTimeout(() => {
      getInversionJob(jobId).then(setJob).catch((e) => setJob((j) => ({ ...j, status: 'error', error: e.message })))
    }, 1500)
    return () => clearTimeout(timer)
  }, [jobId, jobActive, job])

  const currentPlan = plan.key === planKey ? plan.body : null
  const tooMany = currentPlan && defaults.data && currentPlan.estimated_stations > defaults.data.max_stations
  const canRun = Boolean(request && currentPlan && currentPlan.used.length && !jobActive && !tooMany)

  const start = () => {
    setSubmitError(null)
    postInversionJob(request).then(setJob).catch((e) => setSubmitError(e.message))
  }

  const result = job?.run === run && job?.status === 'done' ? job.result : null
  const live = job?.run === run && jobActive && job.partial ? job.partial : null
  const sectionFt = Math.max(1, Number(settings?.sectionFt ?? 15) || 15)

  return (
    <Box sx={{ display: 'grid', gap: 2, alignItems: 'start',
      gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: '400px minmax(0, 1fr)' } }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5,
        position: { lg: 'sticky' }, top: { lg: 80 }, maxHeight: { lg: 'calc(100vh - 96px)' }, overflowY: { lg: 'auto' } }}>
        <Card title="Run">
          <ApiStatus state={runs} label="Runs" onRetry={runs.reload} />
          {runs.data && <RunPicker fullWidth runs={runs.data.runs} value={run} onChange={onRunChange} />}
        </Card>

        <Card title="Curves from QC selection" extra={qcCurves.from ?? undefined}>
          {!run && <Typography variant="body2" color="text.secondary">Pick a run first.</Typography>}
          {qcCurves.loading && <LinearProgress />}
          {qcCurves.error && <Alert severity="error">{qcCurves.error}</Alert>}
          {plan.error && plan.key === planKey && <Alert severity="error">{plan.error}</Alert>}
          {currentPlan && <PlanView plan={currentPlan} />}
          {run && (
            <Button size="small" onClick={onOpenQc} sx={{ mt: 0.5 }}>Edit selection in QC</Button>
          )}
        </Card>

        {run && (
          <Card title="Inversion settings" extra="1.5D: dipping TIV layers along the real well path">
            <ApiStatus state={defaults} label="Defaults" onRetry={defaults.reload} />
            {settings && (
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
                <TextField size="small" label="MD from (ft)" type="number" value={settings.mdMin}
                  onChange={(e) => update({ mdMin: e.target.value })} />
                <TextField size="small" label="MD to (ft)" type="number" value={settings.mdMax}
                  onChange={(e) => update({ mdMax: e.target.value })} />
                <FormControl size="small">
                  <InputLabel id="inv-step">Station step</InputLabel>
                  <Select labelId="inv-step" label="Station step" value={settings.step}
                    onChange={(e) => update({ step: e.target.value })}>
                    {[1, 2, 4, 5, 10].map((s) => <MenuItem key={s} value={s}>{s} ft</MenuItem>)}
                  </Select>
                </FormControl>
                <FormControl size="small">
                  <InputLabel id="inv-layers">Layers</InputLabel>
                  <Select labelId="inv-layers" label="Layers" value={settings.layers}
                    onChange={(e) => update({ layers: e.target.value })}>
                    {[1, 2, 3, 4].map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}
                  </Select>
                </FormControl>
                <Tooltip title="Phase weight 1; 2 MHz attenuation weight 0.5 with the Z-20 resistivity-dependent correction; 500/125 kHz attenuation weight 0.25">
                  <FormControlLabel sx={{ gridColumn: '1 / -1' }} control={
                    <Switch checked={settings.calibration} onChange={(e) => update({ calibration: e.target.checked })} />}
                    label="Tool calibration (Z-20)" />
                </Tooltip>
                <FormControlLabel sx={{ gridColumn: '1 / -1' }} control={
                  <Switch checked={settings.quick} onChange={(e) => update({ quick: e.target.checked })} />}
                  label="Quick (fewer iterations)" />
                <TextField size="small" label="Section ± ft around well" type="number" sx={{ gridColumn: '1 / -1' }}
                  value={settings.sectionFt ?? '15'} slotProps={{ htmlInput: { min: 1, step: 1 } }}
                  helperText="TVD band shown in the cross-sections (display only)"
                  onChange={(e) => update({ sectionFt: e.target.value })} />
              </Box>
            )}
            {defaults.data?.reason && (
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
                Default interval: {defaults.data.reason}
              </Typography>
            )}
            {currentPlan && (
              <Typography variant="caption" color={tooMany ? 'error' : 'text.secondary'} component="div">
                About {currentPlan.estimated_stations} stations
                {tooMany ? ` (max ${defaults.data.max_stations}: shorten the interval or increase the step)` : ''}
              </Typography>
            )}
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1.5 }}>
              <Button variant="contained" onClick={start} disabled={!canRun}>
                {jobActive ? 'Inverting…' : 'Run inversion'}
              </Button>
              {jobActive && <CircularProgress size={18} />}
            </Box>
            {jobActive && (
              <Box sx={{ mt: 1 }}>
                <LinearProgress variant="determinate" value={100 * (job.progress || 0)} />
                <Typography variant="caption" color="text.secondary">{job.message} · {job.elapsed_s}s</Typography>
              </Box>
            )}
            {submitError && <Alert severity="error" sx={{ mt: 1 }}>{submitError}</Alert>}
            {job?.status === 'error' && <Alert severity="error" sx={{ mt: 1 }}>{job.error}</Alert>}
          </Card>
        )}
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {live && (
          <Card title="Live cross-section" extra={`best model so far · ${live.stage} stage · evaluation ${live.evaluation}`
            + ` · misfit/noise ${live.misfit_normalised} · ±${sectionFt} ft around the well`}>
            <LinearProgress variant="determinate" value={100 * (job.progress || 0)} sx={{ mb: 1 }} />
            <CurtainPlot result={live} halfWindowFt={sectionFt} />
            <Typography variant="caption" color="text.secondary">
              {live.model.layers.map((l, i) => `Layer ${i + 1}: Rh ${l.rh.toFixed(1)} / Rv ${l.rv.toFixed(1)} Ω·m`).join(' · ')}
              {` · dip ${live.model.dip_deg}°`}
            </Typography>
          </Card>
        )}
        {!result && !live && (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
            {!run ? 'Pick a run, select curves on the QC page, then run the inversion here.'
              : jobActive ? 'Inversion running. A 400 ft interval at 4 ft steps takes a few minutes.'
                : 'Check the curves and interval on the left, then press Run inversion.'}
          </Paper>
        )}
        {result && (
          <>
            <Card title="Inverted model" extra={result.model.reference_note}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 3, rowGap: 0.5, mb: 1 }}>
                <Stat label="Well" value={result.well} />
                <Stat label="Interval" value={`${job.request.md_min_ft}–${job.request.md_max_ft} ft MD`} />
                <Stat label="RMS misfit (used resistivities)" value={result.rms_percent_used == null ? '–' : `${result.rms_percent_used}%`} />
                <Stat label="Misfit / noise (all used)" value={result.misfit_normalised ?? '–'} />
                <Stat label="Dip" value={`${result.model.dip_deg}° toward ${result.model.dip_azimuth_deg}°`} />
                <Stat label="Stations" value={result.stations} />
                <Stat label="Run time" value={`${result.elapsed_s}s`} />
              </Box>
              <Table size="small" sx={{ maxWidth: 640 }}>
                <TableHead>
                  <TableRow>
                    {['Layer', 'Top TVD (ft)', 'Bottom TVD (ft)', 'Rh (Ω·m)', 'Rv (Ω·m)', 'Rv/Rh'].map((h) => (
                      <TableCell key={h} sx={{ fontWeight: 600 }}>{h}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {result.model.layers.map((l, i) => (
                    <TableRow key={i}>
                      <TableCell>{i + 1}</TableCell>
                      <TableCell>{l.top_tvd_ft ?? '–'}</TableCell>
                      <TableCell>{l.bottom_tvd_ft ?? '–'}</TableCell>
                      <TableCell>{l.rh.toFixed(2)}</TableCell>
                      <TableCell>{l.rv.toFixed(2)}</TableCell>
                      <TableCell>{(l.rv / l.rh).toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            <Card title="Curtain section" extra={`layers coloured by Rh (blue conductive → red resistive) · ±${sectionFt} ft around the well`}>
              <CurtainPlot result={result} halfWindowFt={sectionFt} />
            </Card>
            <Card title="Measured vs modelled" extra="bold = used in the fit; faint = shown for comparison">
              <FormControlLabel control={<Switch size="small" checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)} />} label="Show all channels" />
              <InversionTracks result={result} showAll={showAll} />
            </Card>
            <Card title="Misfit per curve">
              <MisfitTable curves={result.curves} />
            </Card>
          </>
        )}
      </Box>
    </Box>
  )
}

export default InversionPage
