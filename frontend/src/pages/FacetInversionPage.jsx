import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Chip, CircularProgress, FormControl, FormControlLabel, InputLabel, LinearProgress, MenuItem,
  Paper, Select, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material'
import { getFacetDefaults, getFacetJob, postFacetJob, postFacetPlan } from '../api.js'
import { useApi } from '../hooks/useApi.js'
import ApiStatus from '../components/ApiStatus.jsx'
import RunPicker from '../components/RunPicker.jsx'
import Facet3D from '../components/inversion3d/Facet3D.jsx'
import FacetDips from '../components/inversion3d/FacetDips.jsx'
import FacetSection from '../components/inversion3d/FacetSection.jsx'
import LateralTracks from '../components/inversion3d/LateralTracks.jsx'
import { Card, Stat, useQcCurves } from './InversionPage.jsx'

const BASE_SETTINGS = { step: 4, window: 100, layers: 2, maxDip: 45, rotation: 1, calibration: true, compare: false, quick: true }
const ACTIVE = ['queued', 'running']
const KIND_COLOR = { avg: 'primary', top: 'success', bottom: 'secondary', right: 'error', left: 'error', geosignal: 'warning' }

function PlanView({ plan }) {
  return (
    <Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
        {plan.used.map((u) => (
          <Tooltip key={u.label} title={`${u.label}: ${u.measurement}, ${u.kind}${u.side ? ` (${u.side} sector)` : ''}, `
            + `from ${u.source}, weight ${u.weight}${u.correction ? ', Z-20 correction' : ''}`}>
            <Chip size="small" variant={u.measurement === 'phase' ? 'outlined' : 'filled'} color={KIND_COLOR[u.kind]}
              sx={{ fontFamily: 'monospace' }} label={`${u.label} · w${u.weight}`} />
          </Tooltip>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
        Top/bottom quadrants place boundaries above or below the well; right/left quadrants (red) tilt them sideways.
        All quadrants are 90° sectors of the image, as in the forward model.
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

function WindowTable({ windows, maxDip }) {
  const compare = windows.some((w) => w.misfit_normalised_1d5 != null)
  const atBound = (v) => maxDip != null && Math.abs(Math.abs(v) - maxDip) < 0.05
  return (
    <Table size="small" sx={{ '& td, & th': { whiteSpace: 'nowrap', px: 1 } }}>
      <TableHead>
        <TableRow>
          {['Window (ft MD)', 'Along dip', 'Cross dip', 'Dip / azimuth', 'Boundaries: distance from well (ft), rise to right',
            'Rh (Ω·m)', 'Misfit/σ', ...(compare ? ['1.5D misfit/σ'] : [])].map((h) => (
            <TableCell key={h} sx={{ fontWeight: 600 }}>{h}</TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {windows.map((w) => (
          <TableRow key={w.md_centre_ft}>
            <TableCell>{w.md_min_ft}–{w.md_max_ft}</TableCell>
            <TableCell sx={{ color: atBound(w.along_dip_deg) ? 'warning.main' : undefined }}>
              {w.along_dip_deg}°{atBound(w.along_dip_deg) ? ' (at limit)' : ''}
            </TableCell>
            <TableCell sx={{ color: atBound(w.cross_dip_deg) ? 'warning.main' : Math.abs(w.cross_dip_deg) >= 3 ? 'error.main' : undefined }}>
              {w.cross_dip_deg}°{atBound(w.cross_dip_deg) ? ' (at limit)' : ''}
            </TableCell>
            <TableCell>{w.dip_deg}° / {w.dip_azimuth_deg}°</TableCell>
            <TableCell>
              {w.boundaries.map((b) => `${b.distance_from_well_ft > 0 ? '+' : ''}${b.distance_from_well_ft}, ${b.rise_to_right_ft}`).join(' | ')}
            </TableCell>
            <TableCell>{w.layers.map((l) => l.rh.toFixed(1)).join(' / ')}</TableCell>
            <TableCell>{w.misfit_normalised}</TableCell>
            {compare && (
              <TableCell sx={{ color: w.misfit_normalised_1d5 > 1.1 * w.misfit_normalised ? 'success.main' : undefined }}>
                {w.misfit_normalised_1d5 ?? '–'}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function FacetInversionPage({ runs, run, onRunChange, liveSelection, onOpenQc, onOpen1d5 }) {
  const qcCurves = useQcCurves(run, liveSelection)
  const defaults = useApi(() => getFacetDefaults(run), run || null)
  const [settingsByRun, setSettingsByRun] = useState({})
  const [plan, setPlan] = useState({ key: null, body: null, error: null })
  const [job, setJob] = useState(null)
  const [submitError, setSubmitError] = useState(null)

  const settings = useMemo(() => settingsByRun[run] ?? (defaults.data
    ? { ...BASE_SETTINGS, mdMin: String(defaults.data.md_min_ft), mdMax: String(defaults.data.md_max_ft) } : null),
  [settingsByRun, run, defaults.data])
  const update = (patch) => setSettingsByRun((s) => ({ ...s, [run]: { ...settings, ...patch } }))

  const request = useMemo(() => (settings && qcCurves.curves.length ? {
    run, curves: qcCurves.curves, md_min_ft: Number(settings.mdMin), md_max_ft: Number(settings.mdMax),
    step_ft: settings.step, window_ft: settings.window, layers: settings.layers, max_dip_deg: settings.maxDip,
    rotation: settings.rotation,
    calibration: settings.calibration, compare: settings.compare, quick: settings.quick,
  } : null), [run, qcCurves.curves, settings])
  const planKey = request ? JSON.stringify(request) : null

  useEffect(() => {
    if (!planKey) return undefined
    let cancelled = false
    postFacetPlan(JSON.parse(planKey))
      .then((body) => !cancelled && setPlan({ key: planKey, body, error: null }))
      .catch((e) => !cancelled && setPlan({ key: planKey, body: null, error: e.message }))
    return () => { cancelled = true }
  }, [planKey])

  const jobId = job?.id
  const jobActive = ACTIVE.includes(job?.status)
  useEffect(() => {
    if (!jobId || !jobActive) return undefined
    const timer = setTimeout(() => {
      getFacetJob(jobId).then(setJob).catch((e) => setJob((j) => ({ ...j, status: 'error', error: e.message })))
    }, 2000)
    return () => clearTimeout(timer)
  }, [jobId, jobActive, job])

  const currentPlan = plan.key === planKey ? plan.body : null
  const tooMany = currentPlan && defaults.data && currentPlan.windows > defaults.data.max_windows
  const canRun = Boolean(request && currentPlan && currentPlan.used.length && !jobActive && !tooMany)
  const start = () => {
    setSubmitError(null)
    postFacetJob(request).then(setJob).catch((e) => setSubmitError(e.message))
  }
  const result = job?.run === run && job?.status === 'done' ? job.result : null

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
          {run && <Button size="small" onClick={onOpenQc} sx={{ mt: 0.5 }}>Edit selection in QC</Button>}
        </Card>

        {run && (
          <Card title="Facet settings" extra="windowed layers with a free dip azimuth">
            <ApiStatus state={defaults} label="Defaults" onRetry={defaults.reload} />
            {settings && (
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
                <TextField size="small" label="MD from (ft)" type="number" value={settings.mdMin}
                  onChange={(e) => update({ mdMin: e.target.value })} />
                <TextField size="small" label="MD to (ft)" type="number" value={settings.mdMax}
                  onChange={(e) => update({ mdMax: e.target.value })} />
                <FormControl size="small">
                  <InputLabel id="f-window">Window</InputLabel>
                  <Select labelId="f-window" label="Window" value={settings.window}
                    onChange={(e) => update({ window: e.target.value })}>
                    {[60, 100, 150, 200].map((s) => <MenuItem key={s} value={s}>{s} ft (50% overlap)</MenuItem>)}
                  </Select>
                </FormControl>
                <FormControl size="small">
                  <InputLabel id="f-step">Station step</InputLabel>
                  <Select labelId="f-step" label="Station step" value={settings.step}
                    onChange={(e) => update({ step: e.target.value })}>
                    {[2, 4, 5, 8].map((s) => <MenuItem key={s} value={s}>{s} ft</MenuItem>)}
                  </Select>
                </FormControl>
                <FormControl size="small">
                  <InputLabel id="f-layers">Layers</InputLabel>
                  <Select labelId="f-layers" label="Layers" value={settings.layers}
                    onChange={(e) => update({ layers: e.target.value })}>
                    {[1, 2, 3].map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}
                  </Select>
                </FormControl>
                <Tooltip title="Bound on the dip along and across the well. Ekofisk chalk can dip steeply relative to the well (e.g. Z-20); a window that ends at the bound is flagged.">
                  <FormControl size="small">
                    <InputLabel id="f-dip">Max dip</InputLabel>
                    <Select labelId="f-dip" label="Max dip" value={settings.maxDip}
                      onChange={(e) => update({ maxDip: e.target.value })}>
                      {[15, 30, 45, 60].map((d) => <MenuItem key={d} value={d}>{d}°</MenuItem>)}
                    </Select>
                  </FormControl>
                </Tooltip>
                <Tooltip title="Which image side is the well's right is not vendor-confirmed. 'Mirrored' assumes bin 8 looks left; every facet flips across the well.">
                  <FormControl size="small">
                    <InputLabel id="f-rot">Left/right</InputLabel>
                    <Select labelId="f-rot" label="Left/right" value={settings.rotation}
                      onChange={(e) => update({ rotation: e.target.value })}>
                      <MenuItem value={1}>bin 8 = right</MenuItem>
                      <MenuItem value={-1}>mirrored</MenuItem>
                    </Select>
                  </FormControl>
                </Tooltip>
                <Tooltip title="Refit each window with the dip locked to the well azimuth (1.5D) and report both misfits. Doubles the run time.">
                  <FormControlLabel sx={{ gridColumn: '1 / -1' }} control={
                    <Switch checked={settings.compare} onChange={(e) => update({ compare: e.target.checked })} />}
                    label="Compare with 1.5D per window" />
                </Tooltip>
                <FormControlLabel sx={{ gridColumn: '1 / -1' }} control={
                  <Switch checked={settings.calibration} onChange={(e) => update({ calibration: e.target.checked })} />}
                  label="Tool calibration (Z-20)" />
                <FormControlLabel sx={{ gridColumn: '1 / -1' }} control={
                  <Switch checked={settings.quick} onChange={(e) => update({ quick: e.target.checked })} />}
                  label="Quick (fewer iterations)" />
              </Box>
            )}
            {defaults.data?.reason && (
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
                Default interval: {defaults.data.reason}
              </Typography>
            )}
            {currentPlan && (
              <Typography variant="caption" color={tooMany ? 'error' : 'text.secondary'} component="div">
                {currentPlan.windows} windows, about {currentPlan.estimated_stations} stations
                {tooMany ? ` (max ${defaults.data.max_windows} windows: shorten the interval or widen the windows)` : ''}
              </Typography>
            )}
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1.5 }}>
              <Button variant="contained" onClick={start} disabled={!canRun}>
                {jobActive ? 'Inverting…' : 'Run facet inversion'}
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
        <Alert severity="info">
          3D facets extend the <Button size="small" onClick={onOpen1d5} sx={{ p: 0, minWidth: 0, verticalAlign: 'baseline' }}>
          1D/1.5D inversion</Button>: each window's beds may also tilt across the well, fitted to the right/left image
          quadrants. Facets are drawn ±6 m around the well, about the tool's depth of detection; the tool cannot see
          further sideways. Only one inversion runs at a time across both pages.
        </Alert>
        {!result && (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
            {!run ? 'Pick a run, select ZR images in QC, then run the facet inversion here.'
              : jobActive ? 'Inverting window by window. A 400 ft interval in 100 ft windows takes several minutes.'
                : 'Check the curves and interval on the left, then press Run facet inversion.'}
          </Paper>
        )}
        {result && (
          <>
            <Card title="Facet summary" extra={result.orientation_note}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 3, rowGap: 0.5, mb: 1 }}>
                <Stat label="Well" value={result.well} />
                <Stat label="Interval" value={`${job.request.md_min_ft}–${job.request.md_max_ft} ft MD`} />
                <Stat label="Windows" value={result.windows.length} />
                <Stat label="Stations" value={result.stations} />
                <Stat label="Max |cross dip|" value={`${Math.max(...result.windows.map((w) => Math.abs(w.cross_dip_deg))).toFixed(1)}°`} />
                <Stat label="Run time" value={`${result.elapsed_s}s`} />
              </Box>
              <WindowTable windows={result.windows} maxDip={job.request.max_dip_deg} />
            </Card>
            <Card title="Section along the well" extra="boundary at the well (line) and its spread across ±6 m (band): a wide band = strong sideways tilt">
              <FacetSection result={result} />
            </Card>
            <Card title="Dip along and across the well" extra="cross-dip > 0: beds deepen to the right of the heading">
              <FacetDips result={result} />
            </Card>
            <Card title="3D corridor" extra="drag to rotate; facets span each window and ±6 m across the well">
              <Facet3D result={result} />
            </Card>
            <Card title="Directional contrasts: measured (grey) vs model" extra="red = lateral (right/left) data that only the 3D facets can fit">
              <LateralTracks result={result} />
            </Card>
          </>
        )}
      </Box>
    </Box>
  )
}

export default FacetInversionPage
