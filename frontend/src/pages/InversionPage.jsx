import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, FormControl, FormControlLabel, IconButton, InputLabel, LinearProgress,
  MenuItem, Paper, Select, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, ToggleButton,
  ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material'
import {
  getAutoSelection, getInversionDefaults, getInversionJob, getInversionJobs, getInversionTargets, getSavedSelection,
  postInversionJob, postInversionPlan, postInversionSection,
} from '../api.js'
import { useApi } from '../hooks/useApi.js'
import ApiStatus from '../components/ApiStatus.jsx'
import RunPicker from '../components/RunPicker.jsx'
import SectionWorkbench from '../components/inversion/SectionWorkbench.jsx'
import { DEFAULT_COLOR_RANGE, apparentDip, horizontalDisplacement } from '../components/inversion/sectionModel.js'

const BASE_SETTINGS = { step: 4, layers: 3, calibration: true, quick: false, sectionFt: '15', sliceFt: '4', windowFt: '20',
  rhMin: '0.1', rhMax: '1000' }
const ACTIVE = ['queued', 'running']
const LINE_OPTIONS = { apply: true, dipSigma: 2, boundarySigma: 2, downweight: true, partial: true }
const DIP_SIGMAS = [[0.5, 'very strong (±0.5°)'], [1, 'strong (±1°)'], [2, 'medium (±2°)'], [5, 'weak (±5°)'], [10, 'hint (±10°)']]
const BOUNDARY_SIGMAS = [1, 2, 5, 10]
// A partial re-run copies the base job's slices, so these settings must be unchanged.
const RERUN_MATCH = ['md_min_ft', 'md_max_ft', 'step_ft', 'layers', 'slice_ft', 'window_ft']
// Dip lines per run survive a reload.
const LINES_KEY = 'resist.dipLines'

function loadLines() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LINES_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

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
          {['Channel', 'Kind', 'Source', 'Used', 'Weight', 'Line down-weight', 'Noise σ', 'Correction', 'RMS misfit', 'RMS / σ'].map((h) => (
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
            <TableCell sx={{ color: c.downweight_factor < 0.95 ? 'warning.main' : undefined }}>
              {c.downweight_factor == null ? '–' : `×${c.downweight_factor}`}
            </TableCell>
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

function DipLinesCard({ lines, onLinesChange, options, onOptionsChange, path, partial }) {
  const hd = useMemo(() => (path ? horizontalDisplacement(path) : null), [path])
  const set = (patch) => onOptionsChange({ ...options, ...patch })
  return (
    <Card title="Geology dip lines" extra="draw on the section with Draw dip line">
      {!lines.length && (
        <Typography variant="body2" color="text.secondary">
          No lines yet. Draw bed boundaries or bedding trends on the section (before or after inverting); the next
          inversion is pulled toward their dip, and anchored lines also pull a boundary onto the line.
        </Typography>
      )}
      {lines.map((l, i) => {
        const dip = path && hd ? apparentDip(l, path, hd) : null
        return (
          <Box key={l.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" sx={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}>
              {i + 1}. MD {l.md1_ft.toFixed(0)}–{l.md2_ft.toFixed(0)} · {dip == null ? '–' : `${dip >= 0 ? '+' : ''}${dip.toFixed(1)}°`}
            </Typography>
            <Tooltip title="Anchored: also pull the nearest boundary onto the line. Off: constrain the dip only">
              <FormControlLabel sx={{ mr: 0 }} label={<Typography variant="caption">anchor</Typography>}
                control={<Switch size="small" checked={l.anchor}
                  onChange={(e) => onLinesChange(lines.map((x) => (x.id === l.id ? { ...x, anchor: e.target.checked } : x)))} />} />
            </Tooltip>
            <IconButton size="small" aria-label={`Delete line ${i + 1}`} onClick={() => onLinesChange(lines.filter((x) => x.id !== l.id))}>
              ✕
            </IconButton>
          </Box>
        )
      })}
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5, mt: 1.5 }}>
        <FormControlLabel sx={{ gridColumn: '1 / -1' }} label="Apply lines to the next run"
          control={<Switch checked={options.apply} onChange={(e) => set({ apply: e.target.checked })} />} />
        <FormControl size="small">
          <InputLabel id="dip-sigma">Dip constraint</InputLabel>
          <Select labelId="dip-sigma" label="Dip constraint" value={options.dipSigma} onChange={(e) => set({ dipSigma: e.target.value })}>
            {DIP_SIGMAS.map(([v, label]) => <MenuItem key={v} value={v}>{label}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small">
          <InputLabel id="bnd-sigma">Anchor ± ft</InputLabel>
          <Select labelId="bnd-sigma" label="Anchor ± ft" value={options.boundarySigma} onChange={(e) => set({ boundarySigma: e.target.value })}>
            {BOUNDARY_SIGMAS.map((v) => <MenuItem key={v} value={v}>±{v} ft</MenuItem>)}
          </Select>
        </FormControl>
        <Tooltip title="Inside the lines' range, curves whose misfit/noise is an outlier against the line-constrained model are down-weighted and the slice is refitted">
          <FormControlLabel sx={{ gridColumn: '1 / -1' }} label="Down-weight curves that disagree"
            control={<Switch checked={options.downweight} onChange={(e) => set({ downweight: e.target.checked })} />} />
        </Tooltip>
        <Tooltip title="Keep the current result outside the lines' MD range (± half a data window) and recompute only inside it">
          <FormControlLabel sx={{ gridColumn: '1 / -1' }} label="Re-run only the lines' range"
            control={<Switch checked={options.partial} onChange={(e) => set({ partial: e.target.checked })} />} />
        </Tooltip>
      </Box>
      {options.partial && lines.length > 0 && (
        <Typography variant="caption" color="text.secondary" component="div">
          {partial
            ? `Partial re-run: MD ${partial.md_min_ft.toFixed(0)}–${partial.md_max_ft.toFixed(0)} ft recomputed, the rest kept from ${partial.base_job_id.slice(0, 6)}.`
            : 'No matching finished inversion to keep (same interval, step, layers, slice and window): the next run is a full run.'}
        </Typography>
      )}
      {lines.length > 0 && (
        <Button size="small" color="error" onClick={() => onLinesChange([])} sx={{ mt: 0.5 }}>Clear all lines</Button>
      )}
    </Card>
  )
}

function InversionPage({ runs, run, onRunChange, liveSelection, onOpenQc }) {
  const qcCurves = useQcCurves(run, liveSelection)
  const defaults = useApi(() => getInversionDefaults(run), run || null)
  const [settingsByRun, setSettingsByRun] = useState({})
  const [plan, setPlan] = useState({ key: null, body: null, error: null })
  const [preview, setPreview] = useState({ key: null, body: null, error: null })
  const [job, setJob] = useState(null)
  const [submitError, setSubmitError] = useState(null)
  const [colorRange, setColorRange] = useState(DEFAULT_COLOR_RANGE.map(String))
  const [force, setForce] = useState(false)
  const targets = useApi(getInversionTargets, run || 'none')
  const [target, setTarget] = useState('local')
  const server = targets.data?.server
  const serverReady = Boolean(server?.available)
  const runOn = target === 'server' && serverReady ? 'server' : 'local'
  const [linesByRun, setLinesByRun] = useState(loadLines)
  useEffect(() => {
    try {
      window.localStorage.setItem(LINES_KEY, JSON.stringify(linesByRun))
    } catch { /* storage full or disabled: lines stay in memory */ }
  }, [linesByRun])
  const [lineOptions, setLineOptions] = useState(LINE_OPTIONS)
  const lines = useMemo(() => linesByRun[run] ?? [], [linesByRun, run])
  const setLines = (next) => setLinesByRun((s) => ({ ...s, [run]: next }))
  // Curves of a loaded inversion replace the QC selection until the user switches back.
  const [loadedCurves, setLoadedCurves] = useState(null)
  const curveSource = loadedCurves?.run === run && loadedCurves.live === liveSelection
    ? { curves: loadedCurves.curves, from: `inversion ${loadedCurves.id.slice(0, 6)}` } : qcCurves
  const [previous, setPrevious] = useState({ run: null, jobs: [], error: null })
  const [loading, setLoading] = useState(null)

  const settings = useMemo(() => settingsByRun[run] ?? (defaults.data
    ? { ...BASE_SETTINGS, mdMin: String(defaults.data.md_min_ft), mdMax: String(defaults.data.md_max_ft) } : null),
  [settingsByRun, run, defaults.data])
  const update = (patch) => setSettingsByRun((s) => ({ ...s, [run]: { ...settings, ...patch } }))

  const request = useMemo(() => (settings && curveSource.curves.length ? {
    run, curves: curveSource.curves, md_min_ft: Number(settings.mdMin), md_max_ft: Number(settings.mdMax),
    step_ft: settings.step, layers: settings.layers, calibration: settings.calibration, quick: settings.quick,
    slice_ft: Number(settings.sliceFt ?? 4), window_ft: Number(settings.windowFt ?? 20),
    rh_min_ohmm: Number(settings.rhMin ?? 0.1), rh_max_ohmm: Number(settings.rhMax ?? 1000),
  } : null), [run, curveSource.curves, settings])
  const planKey = request ? JSON.stringify(request) : null

  useEffect(() => {
    if (!planKey) return undefined
    let cancelled = false
    postInversionPlan(JSON.parse(planKey))
      .then((body) => !cancelled && setPlan({ key: planKey, body, error: null }))
      .catch((e) => !cancelled && setPlan({ key: planKey, body: null, error: e.message }))
    return () => { cancelled = true }
  }, [planKey])

  // The well section and measured channels of the interval, so lines can be drawn before anything is inverted.
  const previewKey = request ? JSON.stringify({ run: request.run, curves: request.curves, md_min_ft: request.md_min_ft,
    md_max_ft: request.md_max_ft, step_ft: request.step_ft, calibration: request.calibration }) : null
  useEffect(() => {
    if (!previewKey) return undefined
    let cancelled = false
    const timer = setTimeout(() => {
      postInversionSection(JSON.parse(previewKey))
        .then((body) => !cancelled && setPreview({ key: previewKey, body, error: null }))
        .catch((e) => !cancelled && setPreview({ key: previewKey, body: null, error: e.message }))
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [previewKey])

  const jobId = job?.id
  const jobActive = ACTIVE.includes(job?.status)
  const jobDone = job?.status === 'done'
  useEffect(() => {
    if (!run) return undefined
    let cancelled = false
    getInversionJobs(run)
      .then((body) => !cancelled && setPrevious({ run, jobs: body.jobs, error: null }))
      .catch((e) => !cancelled && setPrevious({ run, jobs: [], error: e.message }))
    return () => { cancelled = true }
  }, [run, jobId, jobDone])

  // Show a stored inversion and put every setting it was run with back into the form.
  const loadInversion = (id) => {
    setLoading(id)
    setSubmitError(null)
    getInversionJob(id).then((j) => {
      const req = j.request
      setSettingsByRun((s) => ({ ...s, [j.run]: { ...BASE_SETTINGS, ...(s[j.run] ?? {}),
        mdMin: String(req.md_min_ft), mdMax: String(req.md_max_ft), step: Number(req.step_ft), layers: req.layers,
        calibration: req.calibration, quick: req.quick, sliceFt: String(req.slice_ft ?? 4),
        windowFt: String(req.window_ft ?? 20), rhMin: String(req.rh_min_ohmm ?? 0.1), rhMax: String(req.rh_max_ohmm ?? 1000) } }))
      setLoadedCurves({ run: j.run, id: j.id, curves: req.curves, live: liveSelection })
      const used = req.lines ?? []
      if (used.length) {
        setLinesByRun((s) => ({ ...s, [j.run]: used.map((l, i) => ({ id: `${j.id}-${i}`, anchor: true, ...l })) }))
      }
      setLineOptions((o) => ({ ...o, apply: used.length > 0, partial: Boolean(req.base_job_id),
        dipSigma: req.dip_sigma_deg ?? o.dipSigma, boundarySigma: req.boundary_sigma_ft ?? o.boundarySigma,
        downweight: req.downweight_misfit ?? o.downweight }))
      if (req.target === 'server' || req.target === 'local') setTarget(req.target)
      setForce(false)
      setJob(j)
    }).catch((e) => setSubmitError(`Could not load inversion ${id}: ${e.message}`))
      .finally(() => setLoading(null))
  }

  useEffect(() => {
    if (!jobId || !jobActive) return undefined
    const timer = setTimeout(() => {
      getInversionJob(jobId).then(setJob).catch((e) => setJob((j) => ({ ...j, status: 'error', error: e.message })))
    }, 1500)
    return () => clearTimeout(timer)
  }, [jobId, jobActive, job])

  const currentPlan = plan.key === planKey ? plan.body : null
  const tooMany = currentPlan && defaults.data && (currentPlan.estimated_stations > defaults.data.max_stations
    || currentPlan.estimated_slices > defaults.data.max_slices)
  const canRun = Boolean(request && currentPlan && currentPlan.used.length && !jobActive && !tooMany)

  const result = job?.run === run && job?.status === 'done' ? job.result : null
  const live = job?.run === run && jobActive && job.partial ? job.partial : null
  const sectionFt = Math.max(1, Number(settings?.sectionFt ?? 15) || 15)
  const previewBody = preview.key === previewKey ? preview.body : null

  const applyLines = lineOptions.apply && lines.length > 0
  // Partial re-run: keep the shown result outside the lines' MD range, when it was run with the same layout.
  const partial = useMemo(() => {
    if (!lineOptions.partial || !lines.length || !request || !result?.slices?.length || !job?.request) return null
    if (RERUN_MATCH.some((k) => Number(job.request[k]) !== Number(request[k]))) return null
    const half = request.window_ft / 2
    return { base_job_id: job.id,
      md_min_ft: Math.min(...lines.map((l) => Math.min(l.md1_ft, l.md2_ft))) - half,
      md_max_ft: Math.max(...lines.map((l) => Math.max(l.md1_ft, l.md2_ft))) + half }
  }, [lineOptions.partial, lines, request, result, job])

  const start = () => {
    setSubmitError(null)
    let body = force ? { ...request, force: true } : { ...request }
    if (runOn === 'server') body.target = 'server'
    if (applyLines) {
      body = { ...body, lines: lines.map((l) => ({ md1_ft: l.md1_ft, tvd1_ft: l.tvd1_ft, md2_ft: l.md2_ft,
        tvd2_ft: l.tvd2_ft, anchor: l.anchor })), dip_sigma_deg: lineOptions.dipSigma,
        boundary_sigma_ft: lineOptions.boundarySigma, downweight_misfit: lineOptions.downweight }
      if (partial) {
        body = { ...body, base_job_id: partial.base_job_id, rerun_md_min_ft: Number(partial.md_min_ft.toFixed(2)),
          rerun_md_max_ft: Number(partial.md_max_ft.toFixed(2)) }
      }
    }
    postInversionJob(body).then(setJob).catch((e) => setSubmitError(e.message))
  }

  const shown = result ?? live
  const path = shown?.md_ft ? shown : previewBody
  const tracks = result?.curves ? { md: result.md_ft, curves: result.curves }
    : previewBody ? { md: previewBody.md_ft, curves: previewBody.curves } : null
  const rerunShade = shown?.rerun ?? (applyLines && partial ? partial : null)

  return (
    <Box sx={{ display: 'grid', gap: 2, alignItems: 'start',
      gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: '400px minmax(0, 1fr)' } }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5,
        position: { lg: 'sticky' }, top: { lg: 80 }, maxHeight: { lg: 'calc(100vh - 96px)' }, overflowY: { lg: 'auto' } }}>
        <Card title="Run">
          <ApiStatus state={runs} label="Runs" onRetry={runs.reload} />
          {runs.data && <RunPicker fullWidth runs={runs.data.runs} value={run} onChange={onRunChange} />}
        </Card>

        {run && (
          <Card title="Previous inversions" extra="load one to show it and restore its settings">
            {previous.run === run && previous.error && <Alert severity="error">{previous.error}</Alert>}
            {previous.run === run && !previous.jobs.length && !previous.error && (
              <Typography variant="body2" color="text.secondary">No finished inversions for this run yet.</Typography>
            )}
            {previous.run === run && previous.jobs.length > 0 && (
              <FormControl size="small" fullWidth disabled={jobActive}>
                <InputLabel id="inv-previous">Inversion</InputLabel>
                <Select labelId="inv-previous" label="Inversion" value={job?.run === run && previous.jobs.some((p) => p.id === job.id) ? job.id : ''}
                  onChange={(e) => loadInversion(e.target.value)}>
                  {previous.jobs.map((p) => (
                    <MenuItem key={p.id} value={p.id} dense>
                      <Box>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                          {p.md_min_ft}–{p.md_max_ft} ft · {p.layers} layers · {p.step_ft ?? '?'}/{p.slice_ft ?? '?'}/{p.window_ft ?? '?'} ft
                          {p.quick ? ' · quick' : ''}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {p.id.slice(0, 6)}
                          {p.finished ? ` · ${new Date(p.finished * 1000).toLocaleString()}` : ''}
                          {` · ${p.curves} curves`}
                          {p.misfit_normalised != null ? ` · misfit/noise ${p.misfit_normalised}` : ''}
                          {p.lines ? ` · ${p.lines} dip line(s)` : ''}
                          {p.base_job_id ? ' · partial re-run' : ''}
                        </Typography>
                      </Box>
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
            {loading && <LinearProgress sx={{ mt: 1 }} />}
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
              Step / slice / window shown in ft. Loading sets the interval, settings, curves and dip lines it used.
            </Typography>
          </Card>
        )}

        <Card title={curveSource === qcCurves ? 'Curves from QC selection' : 'Curves from loaded inversion'}
          extra={curveSource.from ?? undefined}>
          {!run && <Typography variant="body2" color="text.secondary">Pick a run first.</Typography>}
          {qcCurves.loading && curveSource === qcCurves && <LinearProgress />}
          {qcCurves.error && curveSource === qcCurves && <Alert severity="error">{qcCurves.error}</Alert>}
          {plan.error && plan.key === planKey && <Alert severity="error">{plan.error}</Alert>}
          {currentPlan && <PlanView plan={currentPlan} />}
          {run && curveSource !== qcCurves && (
            <Button size="small" onClick={() => setLoadedCurves(null)} sx={{ mt: 0.5, mr: 1 }}>Use QC selection instead</Button>
          )}
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
                <TextField size="small" label="Slice width (ft)" type="number"
                  value={settings.sliceFt ?? '4'} slotProps={{ htmlInput: { min: 1, step: 1 } }}
                  helperText="one model per slice"
                  onChange={(e) => update({ sliceFt: e.target.value })} />
                <TextField size="small" label="Data window (ft)" type="number"
                  value={settings.windowFt ?? '20'} slotProps={{ htmlInput: { min: 2, step: 1 } }}
                  helperText="sliding, centred on each slice"
                  onChange={(e) => update({ windowFt: e.target.value })} />
                <TextField size="small" label="Rh min (Ω·m)" type="number"
                  value={settings.rhMin ?? '0.1'} slotProps={{ htmlInput: { min: 0.01, step: 'any' } }}
                  helperText="lowest Rh a layer may take"
                  onChange={(e) => update({ rhMin: e.target.value })} />
                <TextField size="small" label="Rh max (Ω·m)" type="number"
                  value={settings.rhMax ?? '1000'} slotProps={{ htmlInput: { min: 0.01, step: 'any' } }}
                  helperText="highest Rh a layer may take"
                  onChange={(e) => update({ rhMax: e.target.value })} />
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
                About {currentPlan.estimated_stations} stations, {currentPlan.estimated_slices} slices,
                {` ~${currentPlan.stations_per_window} stations per data window`}
                {tooMany ? ` (max ${defaults.data.max_stations} stations / ${defaults.data.max_slices} slices: shorten the interval or increase the step/slice)` : ''}
              </Typography>
            )}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', mt: 1.5 }}>
              <Button variant="contained" onClick={start} disabled={!canRun}>
                {jobActive ? 'Inverting…' : applyLines ? (partial ? 'Re-run lines range' : 'Run with dip lines') : 'Run inversion'}
              </Button>
              {jobActive && <CircularProgress size={18} />}
              <ToggleButtonGroup size="small" exclusive value={runOn} aria-label="Run on"
                onChange={(_, v) => v && setTarget(v)}>
                <ToggleButton value="local" title="Compute in this backend">Local</ToggleButton>
                <Tooltip title={serverReady
                  ? `Compute on the inversion server ${server.url}${server.workers ? ` (${server.workers} inversion workers)` : ''}`
                  : `Inversion server unavailable: ${server?.reason ?? targets.error?.message ?? 'checking…'}`}>
                  <span>
                    <ToggleButton value="server" disabled={!serverReady} selected={runOn === 'server'}
                      onChange={(e, v) => setTarget(v)}>
                      Server (72 cores)
                    </ToggleButton>
                  </span>
                </Tooltip>
              </ToggleButtonGroup>
              <Tooltip title="Stored results are returned instantly; tick to compute this request again and replace the stored one">
                <FormControlLabel sx={{ ml: 'auto' }} label="Force re-run"
                  control={<Checkbox size="small" checked={force} onChange={(e) => setForce(e.target.checked)} />} />
              </Tooltip>
            </Box>
            {job?.run === run && job?.status === 'done' && (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1 }}>
                {job.source === 'graph'
                  ? <Chip size="small" color="info" label="from graph" title="Returned from the inversion store without computing" />
                  : <Chip size="small" variant="outlined" label={job.target === 'server' ? 'computed on server' : 'computed'} />}
                <Typography variant="caption" color="text.secondary">{job.message}</Typography>
              </Box>
            )}
            {jobActive && (
              <Box sx={{ mt: 1 }}>
                <LinearProgress variant="determinate" value={100 * (job.progress || 0)} />
                <Typography variant="caption" color="text.secondary">
                  {job.target === 'server' ? 'Server · ' : 'Local · '}{job.message} · {job.elapsed_s}s
                </Typography>
              </Box>
            )}
            {submitError && <Alert severity="error" sx={{ mt: 1 }}>{submitError}</Alert>}
            {job?.status === 'error' && <Alert severity="error" sx={{ mt: 1 }}>{job.error}</Alert>}
          </Card>
        )}
        {run && (
          <DipLinesCard lines={lines} onLinesChange={setLines} options={lineOptions} onOptionsChange={setLineOptions}
            path={path} partial={partial} />
        )}
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {path && (
          <Card title={result ? 'Curtain section and QC' : live ? 'Live curtain section and QC' : 'Well section (before inversion)'}
            extra={live
              ? `slice ${live.slice} of ${live.n_slices} · evaluation ${live.evaluation}`
                + (live.misfit_normalised != null ? ` · last slice misfit/noise ${live.misfit_normalised}` : '')
              : result
                ? `${result.slices?.length ?? 0} slices of ${result.slice_ft} ft on ${result.window_ft} ft sliding windows · ±${sectionFt} ft around the well`
                : 'measured channels of the interval · draw dip lines now to constrain the first run'}>
            {live && <LinearProgress variant="determinate" value={100 * (job.progress || 0)} sx={{ mb: 1 }} />}
            <SectionWorkbench path={path} slices={shown?.slices} tracks={tracks} lines={lines} onLinesChange={setLines}
              halfWindowFt={sectionFt} colorRange={colorRange} onColorRangeChange={setColorRange} rerun={rerunShade}
              rerunLabel={shown?.rerun ? 're-run range' : 'next re-run range'} />
            {preview.error && preview.key === previewKey && !shown && <Alert severity="warning">{preview.error}</Alert>}
          </Card>
        )}
        {!path && (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
            {!run ? 'Pick a run, select curves on the QC page, then run the inversion here.'
              : jobActive ? 'Inversion running. The curtain appears after the first slice; a 400 ft interval at 4 ft steps takes several minutes.'
                : preview.error && preview.key === previewKey ? preview.error : 'Loading the well section of the interval…'}
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
                {result.rerun && (
                  <Stat label="Partial re-run" value={`MD ${result.rerun.md_min_ft}–${result.rerun.md_max_ft} ft, `
                    + `${result.rerun.recomputed_slices} slices recomputed, ${result.rerun.kept_slices} kept`} />
                )}
                {result.constraints && (
                  <Stat label="Dip lines" value={`${result.constraints.lines.length} line(s), ${result.constraints.constrained_slices} slices constrained`} />
                )}
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
