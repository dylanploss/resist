import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Box, Button, ButtonGroup, Chip, FormControl, InputLabel, LinearProgress, ListSubheader, MenuItem, Paper,
  Select, Slider, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material'
import ApiStatus from '../components/ApiStatus.jsx'
import RunPicker from '../components/RunPicker.jsx'
import ColorBar from '../components/well3d/ColorBar.jsx'
import { buildPath, locate, nearestIndex } from '../components/well3d/path.js'
import { STATUS, api, getCurves, runPath } from '../api.js'
import { useApi } from '../hooks/useApi.js'
import { useSelection } from '../selection.js'

const WellScene = lazy(() => import('../components/well3d/WellScene.jsx'))

const MAX_POINTS = 4000
const STEPS_FT = [10, 25, 50, 100, 250, 500]
const SPEEDS_FT_S = [25, 50, 100, 200, 500, 1000]
const EXAGGERATIONS = [1, 2, 5, 10, 20]
const TUBE_SCALES = [1, 2, 5, 10]
// Curves without a per-sample DOI (non-ADR channels) draw a fixed tube.
const FALLBACK_RADIUS_M = 3
const ZOOM_FACTOR = 0.3

function hasWebGL() {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

const fmtNum = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits))
const fmtValue = (v) => (v == null || !Number.isFinite(v) ? 'null' : Math.abs(v) >= 1000 ? v.toExponential(2) : v.toPrecision(4))
// Per-bin DOI shows the low and high side of the ring.
const fmtDoi = (r) => (Array.isArray(r) ? `${fmtNum(Math.min(...r), 2)}–${fmtNum(Math.max(...r), 2)}` : fmtNum(r, 2))

function sampleValue(data, i) {
  const row = data.values[i]
  if (!data.image) return { value: row, label: '' }
  const finite = (row ?? []).filter((v) => v != null && Number.isFinite(v))
  return { value: finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null, label: ' (mean of bins)' }
}

function PickSelect({ label, value, onChange, options, suffix, width = 110 }) {
  const id = `well3d-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <FormControl size="small" sx={{ minWidth: width }}>
      <InputLabel id={id}>{label}</InputLabel>
      <Select labelId={id} label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((o) => <MenuItem key={o} value={o}>{o}{suffix}</MenuItem>)}
      </Select>
    </FormControl>
  )
}

function CurvePicker({ value, onChange, selected, names, statusOf }) {
  const others = names.filter((n) => !selected.includes(n))
  const item = (n) => (
    <MenuItem key={n} value={n} sx={{ fontFamily: 'monospace', color: STATUS[statusOf(n)]?.color }}>{n}</MenuItem>
  )
  return (
    <FormControl size="small" sx={{ minWidth: 220 }}>
      <InputLabel id="well3d-curve-label">Curve</InputLabel>
      <Select labelId="well3d-curve-label" label="Curve" value={value} onChange={(e) => onChange(e.target.value)}
        sx={{ fontFamily: 'monospace' }}>
        {selected.length > 0 && <ListSubheader>QC auto-picks</ListSubheader>}
        {selected.map(item)}
        {others.length > 0 && <ListSubheader>All curves</ListSubheader>}
        {others.map(item)}
        {!names.includes(value) && value && <MenuItem value={value} sx={{ display: 'none' }}>{value}</MenuItem>}
      </Select>
    </FormControl>
  )
}

// Run and curve come from the shared selection, so "View in 3D" on the QC tab opens that curve here.
export default function Well3dPage({ runs, active }) {
  const { run, setRun, curve, setCurve } = useSelection()
  const [webgl] = useState(hasWebGL)
  const curves = useApi(() => getCurves(run), run || null)
  const qc = useApi(() => api(`${runPath(run)}/qc`), run ? `qc|${run}` : null)
  const names = useMemo(() => curves.data?.curves.map((c) => c.curve) ?? [], [curves.data])
  const selected = useMemo(() => qc.data?.selected ?? [], [qc.data])
  const rejected = useMemo(() => new Set(qc.data?.rejected.map((r) => r.curve) ?? []), [qc.data])
  const statusOf = useCallback(
    (n) => (selected.includes(n) ? 'auto' : rejected.has(n) ? 'rejected' : 'context'), [selected, rejected])
  const curveValid = curves.data ? names.includes(curve) : Boolean(curve)
  const shown = curveValid ? curve : selected[0] ?? ''

  const well = useApi(
    () => api(`${runPath(run)}/well3d?curve=${encodeURIComponent(shown)}&max_points=${MAX_POINTS}`),
    run && shown ? `${run}|${shown}` : null)
  const data = well.data

  const [exaggeration, setExaggeration] = useState(1)
  const [tubeScale, setTubeScale] = useState(1)
  // DOI in metres from the backend: one value per sample, or per bin for azimuthal images; see well3d.doi_profile.
  const radii = useMemo(() => (data?.doi_m
    ? data.doi_m.map((r) => (Array.isArray(r) ? r.map((b) => b * tubeScale) : r * tubeScale))
    : null), [data, tubeScale])
  const doiRange = useMemo(() => {
    if (!data?.doi_m) return null
    let min = Infinity
    let max = -Infinity
    for (const r of data.doi_m.flat()) {
      if (r < min) min = r
      if (r > max) max = r
    }
    return { min, max }
  }, [data])
  const radius = doiRange ? doiRange.max * tubeScale : FALLBACK_RADIUS_M * tubeScale
  const [step, setStep] = useState(50)
  const [speed, setSpeed] = useState(100)
  const [mode, setMode] = useState('free')
  const [travel, setTravel] = useState({ data: null, md: 0, playing: false })
  const scene = useRef(null)

  const path = useMemo(() => (data && data.md_ft.length > 1 ? buildPath(data, exaggeration) : null), [data, exaggeration])
  const mdStart = path ? path.md[0] : 0
  const mdEnd = path ? path.md[path.n - 1] : 0
  const current = travel.data === data
  const md = current ? travel.md : mdStart
  const isPlaying = current && travel.playing
  const setMd = useCallback((value) => setTravel((t) => ({
    data, md: Math.min(mdEnd, Math.max(mdStart, value)), playing: t.data === data && t.playing,
  })), [data, mdStart, mdEnd])

  const move = useCallback((sign) => setMd(md + sign * step), [md, setMd, step])
  const togglePlay = useCallback(() => setTravel((t) => (isPlaying
    ? { ...t, playing: false }
    : { data, md: md >= mdEnd ? mdStart : md, playing: true })), [data, isPlaying, md, mdEnd, mdStart])
  const zoom = useCallback((sign) => scene.current?.zoom(sign * ZOOM_FACTOR), [])
  const reset = useCallback(() => {
    setMode('free')
    scene.current?.fit()
  }, [])

  useEffect(() => {
    if (!active || !path) return undefined
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, [role="slider"], [role="combobox"], [role="listbox"]')) return
      const actions = {
        ArrowDown: () => move(1), ArrowUp: () => move(-1), ' ': togglePlay,
        '+': () => zoom(1), '=': () => zoom(1), '-': () => zoom(-1), _: () => zoom(-1),
      }
      const action = actions[e.key]
      if (!action) return
      e.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, path, move, togglePlay, zoom])

  const travelProps = useMemo(() => ({
    md, mdEnd, playing: isPlaying, speed, mode,
    onMd: setMd,
    onEnd: () => setTravel((t) => ({ ...t, playing: false })),
  }), [md, mdEnd, isPlaying, speed, mode, setMd])

  const readout = useMemo(() => {
    if (!path) return null
    const i = nearestIndex(path, md)
    const { i: lo, f } = locate(path, md)
    const tvd0 = data.tvd_ft[lo]
    const tvd1 = data.tvd_ft[Math.min(lo + 1, path.n - 1)]
    const tvd = tvd0 != null && tvd1 != null ? tvd0 + (tvd1 - tvd0) * f : null
    return { i, tvd, inc: data.inc_deg[i], azi: data.azi_deg[i], ...sampleValue(data, i) }
  }, [path, data, md])

  const status = STATUS[statusOf(shown)]

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <ApiStatus state={runs} label="Runs" onRetry={runs.reload} />
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          {runs.data && <RunPicker runs={runs.data.runs} value={run} onChange={setRun} />}
          {run && <CurvePicker value={shown} onChange={setCurve} selected={selected} names={names} statusOf={statusOf} />}
          {shown && status && (
            <Chip size="small" variant="outlined" label={status.label} sx={{ borderColor: status.color, color: status.color }} />
          )}
          {data && (
            <Typography variant="caption" color="text.secondary">
              {data.well} · {data.md_ft.length} samples ({data.stride > 1 ? `1 in ${data.stride}` : 'full resolution'}) · path from{' '}
              {data.path_source === 'utm' ? 'UTMX/UTMY + TVD' : 'INC/AZI (minimum curvature)'}
            </Typography>
          )}
        </Box>
      </Paper>

      {!webgl && <Alert severity="error">WebGL is not available in this browser, so the 3D view cannot be drawn.</Alert>}
      {!run && <Typography color="text.secondary">Pick a run, or use View in 3D on the QC selection tab.</Typography>}
      {run && !shown && qc.loading && <LinearProgress />}
      {well.loading && <LinearProgress />}
      {well.error && <Alert severity="error">{well.error.message}</Alert>}
      {data && !path && <Alert severity="warning">This curve has fewer than two samples with a well position.</Alert>}

      {webgl && path && (
        <Paper sx={{ p: 2 }}>
          <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mb: 1.5 }}>
            <ButtonGroup size="small" variant="outlined" aria-label="Travel">
              <Tooltip title="Back (↑)"><Button onClick={() => move(-1)} disabled={md <= mdStart}>◀ Back</Button></Tooltip>
              <Tooltip title="Play / pause (space)">
                <Button onClick={togglePlay} variant={isPlaying ? 'contained' : 'outlined'}>{isPlaying ? '❚❚ Pause' : '▶ Play'}</Button>
              </Tooltip>
              <Tooltip title="Forward (↓)"><Button onClick={() => move(1)} disabled={md >= mdEnd}>Forward ▶</Button></Tooltip>
            </ButtonGroup>
            <PickSelect label="Step" value={step} onChange={setStep} options={STEPS_FT} suffix=" ft" width={95} />
            <PickSelect label="Speed" value={speed} onChange={setSpeed} options={SPEEDS_FT_S} suffix=" ft/s" width={110} />
            <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && setMode(v)} aria-label="Camera">
              <ToggleButton value="follow">Follow</ToggleButton>
              <ToggleButton value="free">Free</ToggleButton>
            </ToggleButtonGroup>
            <ButtonGroup size="small" variant="outlined" aria-label="Zoom">
              <Tooltip title="Zoom in (+)"><Button onClick={() => zoom(1)}>Zoom in</Button></Tooltip>
              <Tooltip title="Zoom out (−)"><Button onClick={() => zoom(-1)}>Zoom out</Button></Tooltip>
              <Tooltip title="Fit the whole well (free camera)"><Button onClick={reset}>Reset view</Button></Tooltip>
            </ButtonGroup>
            <PickSelect label="Vertical exag." value={exaggeration} onChange={setExaggeration} options={EXAGGERATIONS} suffix="×" width={120} />
            <PickSelect label="Tube scale" value={tubeScale} onChange={setTubeScale} options={TUBE_SCALES} suffix="×" width={110} />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 1 }}>
            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>MD (ft)</Typography>
            <Slider size="small" aria-label="Measured depth" value={md} min={mdStart} max={mdEnd} step={0.5}
              onChange={(_, v) => setMd(v)} valueLabelDisplay="auto" valueLabelFormat={(v) => `${v.toFixed(1)} ft`} />
          </Box>
          <Box sx={{ position: 'relative', height: { xs: 480, lg: 640 }, mt: 1, border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
            <Suspense fallback={<LinearProgress />}>
              <WellScene ref={scene} data={data} path={path} radius={radius} radii={radii} active={active} travel={travelProps} />
            </Suspense>
            <Box sx={{ position: 'absolute', top: 8, left: 8, bgcolor: 'rgba(255,255,255,0.85)', p: 1, borderRadius: 1,
              borderLeft: 4, borderColor: status?.color ?? 'grey.500', pointerEvents: 'none' }}>
              <Typography variant="subtitle2" sx={{ fontFamily: 'monospace' }}>{data.curve} ({data.unit})</Typography>
              <Typography variant="body2" data-testid="well3d-readout">
                MD {fmtNum(md)} ft · TVD {fmtNum(readout.tvd)} ft<br />
                Value {fmtValue(readout.value)} {data.unit}{readout.label}<br />
                INC {fmtNum(readout.inc)}° · AZI {fmtNum(readout.azi)}°
              </Typography>
              <Typography variant="body2" data-testid="well3d-doi">
                {data.doi_m
                  ? `DOI here ≈ ${fmtDoi(data.doi_m[readout.i])} m (estimate, from ${data.doi_source}) · ` +
                    `run ${fmtNum(doiRange.min, 2)}–${fmtNum(doiRange.max, 2)} m · ` +
                    `QC index ${fmtNum(data.doi_index)} (${data.doi_tier})`
                  : `No DOI (non-ADR curve) · fixed tube radius ${fmtNum(radius)} m`}
                {tubeScale > 1 && ` · ${tubeScale}× scale`}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                ↑/↓ travel · +/− zoom · space play · drag to orbit (Free)
              </Typography>
            </Box>
            <Box sx={{ position: 'absolute', top: 8, right: 8, pointerEvents: 'none' }}>
              <ColorBar spec={data.color} unit={data.unit} />
            </Box>
          </Box>
          {data.image && (
            <Typography variant="caption" color="text.secondary">
              Image bins are wrapped around the tube: bin 1 is centred on the high side (top of hole) and the bins
              run clockwise looking down-hole, 11.25° each.
            </Typography>
          )}
        </Paper>
      )}
    </Stack>
  )
}
