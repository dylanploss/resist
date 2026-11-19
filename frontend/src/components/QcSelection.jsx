import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, CircularProgress, Paper, Table, TableBody,
  TableCell, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material'
import { FREQ_LABEL, STATUS, api, compareGroup, fmt, runPath } from '../api.js'
import ApiStatus from './ApiStatus.jsx'
import ArOverlay from './ArOverlay.jsx'
import ChannelPicker from './ChannelPicker.jsx'
import CurveTrackPlot from './CurveTrackPlot.jsx'
import DoiNoiseScatter from './DoiNoiseScatter.jsx'
import QcTable from './QcTable.jsx'
import RunPicker from './RunPicker.jsx'
import SelectionSummary from './SelectionSummary.jsx'

const MAX_TRACKS = 12

function buildRows(qc) {
  const selected = new Set(qc.selected)
  const rejected = Object.fromEntries(qc.rejected.map((r) => [r.curve, r.reason]))
  const rows = Object.entries(qc.scores).map(([name, s]) => {
    const reason = qc.selected_reasons[name] ?? rejected[name] ?? ''
    let status = 'rejected'
    if (s.family === 'conventional') status = 'context'
    else if (selected.has(name)) status = 'auto'
    else if (reason.startsWith('clean but ranked')) status = 'candidate'
    else if (reason.startsWith('same measurement') || reason.startsWith('redundant')) status = 'duplicate'
    return { name, ...s, reason, status }
  })
  rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  let rank = 0
  return rows.map((r) => ({ ...r, rank: r.status === 'context' ? null : ++rank }))
}

const toggle = (list, name) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name])
const binsOf = (name) => (/^ZG|^ZR[HML]\d+[PA]$/.test(name) ? 32 : 1)

function Card({ title, extra, children, sx }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, ...sx }}>
      {title && (
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{title}</Typography>
          {extra && <Typography variant="caption" color="text.secondary">{extra}</Typography>}
        </Box>
      )}
      {children}
    </Paper>
  )
}

function Stat({ label, value }) {
  return (
    <Typography variant="body2" component="span" color="text.secondary">
      {label} <Box component="b" sx={{ color: 'text.primary' }}>{value}</Box>
    </Typography>
  )
}

function SelectedTable({ rows, checked, focus, onShowCurve }) {
  const chosen = checked.map((n) => rows.find((r) => r.name === n)).filter(Boolean).sort(compareGroup)
  if (!chosen.length) return <Typography color="text.secondary" variant="body2">Nothing selected.</Typography>
  return (
    <Table size="small" sx={{ '& td, & th': { whiteSpace: 'nowrap', px: 1 } }}>
      <TableHead>
        <TableRow>
          {['Channel', 'Measurement', 'Depth', 'Noise', 'Coverage', 'Score', 'QC'].map((h) => (
            <TableCell key={h} sx={{ fontWeight: 600 }}>{h}</TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {chosen.map((r) => (
          <TableRow key={r.name} hover onClick={() => onShowCurve(r.name)} sx={{ cursor: 'pointer',
            ...(r.name === focus ? { outline: '2px solid #ffb300', outlineOffset: -2 } : {}) }}>
            <TableCell sx={{ fontFamily: 'monospace' }}>{r.name}</TableCell>
            <TableCell>{FREQ_LABEL[r.frequency_hz]} · {r.spacing_in} in · {r.measurement}</TableCell>
            <TableCell>{r.doi_tier ?? '–'}</TableCell>
            <TableCell sx={{ color: r.noise > 0.8 ? 'error.main' : undefined }}>{fmt(r.noise)}</TableCell>
            <TableCell>{r.coverage == null ? '–' : `${Math.round(100 * r.coverage)}%`}</TableCell>
            <TableCell>{fmt(r.score)}</TableCell>
            <TableCell>
              <Tooltip title={r.reason || ''} placement="left">
                <Box component="span" sx={{ color: STATUS[r.status].color, fontSize: 12 }}>{STATUS[r.status].label}</Box>
              </Tooltip>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function QcSelection({ runs, run, onRunChange, onSelectionChange, onOpenInversion }) {
  const [nSelect, setNSelect] = useState(8)
  const [qc, setQc] = useState({ key: null, body: null, error: null })
  const [checked, setChecked] = useState([])
  const [plotted, setPlotted] = useState([])
  const [focus, setFocus] = useState(null)
  const [save, setSave] = useState({ saving: false, saved: null, error: null })
  const qcKey = `${run}|${nSelect}`

  useEffect(() => {
    if (!run) return undefined
    let cancelled = false
    api(`${runPath(run)}/qc?n_select=${nSelect}`)
      .then((body) => {
        if (cancelled) return
        setQc({ key: qcKey, body, error: null })
        setChecked(body.selected)
        setPlotted(body.selected.slice(0, MAX_TRACKS))
        setFocus(null)
        setSave({ saving: false, saved: null, error: null })
      })
      .catch((error) => !cancelled && setQc({ key: qcKey, body: null, error: error.message }))
    return () => { cancelled = true }
  }, [run, nSelect, qcKey])

  const rows = useMemo(() => (qc.body ? buildRows(qc.body) : []), [qc.body])
  const byName = useMemo(() => Object.fromEntries(rows.map((r) => [r.name, r])), [rows])
  const statusOf = useCallback(
    (name) => (checked.includes(name) ? 'auto' : byName[name]?.status), [checked, byName])
  const togglePlotted = useCallback((name) => setPlotted((list) => toggle(list, name).slice(-MAX_TRACKS)), [])
  const orderedPlotted = useMemo(
    () => plotted.map((n) => byName[n]).filter(Boolean).sort(compareGroup).map((r) => r.name),
    [plotted, byName])
  const showCurves = useCallback((names) => {
    const list = Array.isArray(names) ? names : [names]
    setPlotted((p) => [...p, ...list.filter((n) => !p.includes(n))].slice(-MAX_TRACKS))
    setFocus({ name: list[0], nonce: Date.now() })
  }, [])
  const plotGroup = useCallback((names) => {
    const picked = names.map((n) => byName[n]).filter(Boolean).sort(compareGroup).slice(0, MAX_TRACKS).map((r) => r.name)
    setPlotted(picked)
    setFocus({ name: picked[0], nonce: Date.now() })
  }, [byName])
  const setSelection = useCallback((next, add, remove) => {
    setChecked(next)
    setPlotted((p) => [...p.filter((n) => !remove.includes(n)), ...add.filter((n) => !p.includes(n))].slice(-MAX_TRACKS))
  }, [])
  const resetSelection = () => {
    setChecked(qc.body.selected)
    setPlotted(qc.body.selected.slice(0, MAX_TRACKS))
  }
  const loading = Boolean(run) && qc.key !== qcKey
  const ready = qc.body && !loading

  // The Inversion tab inverts exactly what is checked here.
  useEffect(() => {
    if (ready && run) onSelectionChange?.(run, checked)
  }, [ready, run, checked, onSelectionChange])
  const runInfo = runs.data?.runs.find((r) => r.run === run)
  const arChecked = useMemo(() => checked.filter((n) => byName[n]?.family === 'AR').sort(), [checked, byName])

  const saveSelection = () => {
    setSave({ saving: true, saved: null, error: null })
    api(`${runPath(run)}/selection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curves: checked, n_select: nSelect }),
    })
      .then((saved) => setSave({ saving: false, saved, error: null }))
      .catch((error) => setSave({ saving: false, saved: null, error: error.message }))
  }

  const measured = rows.filter((r) => r.status !== 'context')
  return (
    <Box sx={{ display: 'grid', gap: 2, alignItems: 'start',
      gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: '400px minmax(0, 1fr)' } }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5,
        position: { lg: 'sticky' }, top: { lg: 80 }, maxHeight: { lg: 'calc(100vh - 96px)' }, overflowY: { lg: 'auto' },
        pr: { lg: 0.5 } }}>
        <Card title="Run">
          <ApiStatus state={runs} label="Runs" onRetry={runs.reload} />
          {runs.data && <RunPicker fullWidth runs={runs.data.runs} value={run} onChange={onRunChange} />}
        </Card>
        <Card title="Channels to invert" extra={ready ? `${checked.length} selected` : undefined}>
          {!run && <Typography color="text.secondary" variant="body2">Pick a run first.</Typography>}
          {loading && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={18} /><Typography variant="caption">Running QC…</Typography>
            </Box>
          )}
          {ready && (
            <ChannelPicker rows={rows} checked={checked} plotted={plotted} focus={focus?.name}
              nSelect={nSelect} onNSelect={setNSelect} onSetChecked={setSelection} onReset={resetSelection}
              onShow={showCurves} onTogglePlotted={togglePlotted} />
          )}
        </Card>
        {ready && (
          <Card>
            <SelectionSummary rows={rows} checked={checked} saving={save.saving} saved={save.saved}
              onRemove={(name) => setSelection(checked.filter((n) => n !== name), [], [name])}
              onSave={saveSelection} />
            {save.error && <Alert severity="error" sx={{ mt: 1 }}>Save failed: {save.error}</Alert>}
            {onOpenInversion && (
              <Button variant="outlined" size="small" sx={{ mt: 1 }} disabled={!checked.length}
                onClick={onOpenInversion}>
                Invert this selection →
              </Button>
            )}
          </Card>
        )}
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {qc.error && <Alert severity="error">{qc.error}</Alert>}
        {!ready && !qc.error && (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
            {run ? 'Scoring the channels of this run…' : 'Pick a run on the left to score its channels.'}
          </Paper>
        )}
        {ready && (
          <>
            <Card title="Well">
              <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 3, rowGap: 0.5 }}>
                <Stat label="Well" value={qc.body.well || '–'} />
                {runInfo?.depth_min_m != null && (
                  <Stat label="MD" value={`${(runInfo.depth_min_m / 0.3048).toFixed(0)}–${(runInfo.depth_max_m / 0.3048).toFixed(0)} ft`} />
                )}
                <Stat label="ADR channels" value={measured.length} />
                <Stat label="Passed QC" value={measured.filter((r) => r.status !== 'rejected').length} />
                <Stat label="Auto-picked" value={qc.body.selected.length} />
                <Stat label="Selected" value={checked.length} />
                <Stat label="Values per depth" value={checked.reduce((s, n) => s + binsOf(n), 0)} />
              </Box>
              {qc.body.warnings.map((w) => <Alert key={w} severity="warning" sx={{ mt: 1, py: 0 }}>{w}</Alert>)}
            </Card>
            <Card title="Scoring" extra="click a point or row to view its log">
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'minmax(0, 1fr)',
                '@media (min-width: 1700px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' } }}>
                <DoiNoiseScatter rows={rows} checked={checked} focus={focus?.name}
                  onShowCurve={showCurves} onShowCurves={plotGroup} />
                <Box sx={{ overflowX: 'auto' }}>
                  <Typography variant="subtitle2" gutterBottom>Selected channels</Typography>
                  <SelectedTable rows={rows} checked={checked} focus={focus?.name} onShowCurve={showCurves} />
                </Box>
              </Box>
            </Card>
            <Card title="Selected averaged resistivities" extra="measured; DISKOS deep resistivity dashed for comparison">
              <ArOverlay run={run} names={arChecked} hasReference={Boolean(byName.RDEP)} onShowCurve={showCurves} />
            </Card>
            <Card title="Curves vs measured depth" extra="follows the selection; click a score on the left to add a curve">
              <CurveTrackPlot key={run} run={run} names={orderedPlotted} statusOf={statusOf} focus={focus} />
            </Card>
            <Accordion variant="outlined" disableGutters>
              <AccordionSummary expandIcon={<span aria-hidden>▾</span>}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>All curves: detailed QC scores</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <QcTable rows={rows} checked={checked} plotted={plotted} focus={focus?.name}
                  onToggleChecked={(name) => (checked.includes(name)
                    ? setSelection(checked.filter((n) => n !== name), [], [name])
                    : setSelection([...checked, name], [name], []))}
                  onTogglePlotted={togglePlotted} onShowCurve={showCurves} />
              </AccordionDetails>
            </Accordion>
          </>
        )}
      </Box>
    </Box>
  )
}

export default QcSelection
