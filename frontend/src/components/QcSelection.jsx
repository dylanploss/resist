import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, CircularProgress, FormControl, InputLabel, MenuItem, Paper, Select, Typography,
} from '@mui/material'
import { api, compareGroup, runPath } from '../api.js'
import CurveTrackPlot from './CurveTrackPlot.jsx'
import DoiNoiseScatter from './DoiNoiseScatter.jsx'
import QcTable from './QcTable.jsx'
import SelectionSummary from './SelectionSummary.jsx'

const MAX_TRACKS = 8
const INITIAL_TRACKS = 4

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

// The run comes from the shared run picker on the QC page.
function QcSelection({ run }) {
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
        setPlotted(body.selected.slice(0, INITIAL_TRACKS))
        setFocus(null)
        setSave({ saving: false, saved: null, error: null })
      })
      .catch((error) => !cancelled && setQc({ key: qcKey, body: null, error: error.message }))
    return () => { cancelled = true }
  }, [run, nSelect, qcKey])

  const rows = useMemo(() => (qc.body ? buildRows(qc.body) : []), [qc.body])
  const statusOf = useCallback(
    (name) => (checked.includes(name) ? 'auto' : rows.find((r) => r.name === name)?.status),
    [checked, rows])
  const togglePlotted = (name) => setPlotted((list) => toggle(list, name).slice(-MAX_TRACKS))
  const byName = useMemo(() => Object.fromEntries(rows.map((r) => [r.name, r])), [rows])
  const orderedPlotted = useMemo(
    () => plotted.map((n) => byName[n]).filter(Boolean).sort(compareGroup).map((r) => r.name),
    [plotted, byName])
  const showCurve = useCallback((name) => {
    setPlotted((list) => (list.includes(name) ? list : [...list, name].slice(-MAX_TRACKS)))
    setFocus({ name, nonce: Date.now() })
  }, [])
  const showCurves = useCallback((names) => {
    const picked = names.map((n) => byName[n]).filter(Boolean).sort(compareGroup)
      .slice(0, MAX_TRACKS).map((r) => r.name)
    setPlotted(picked)
    setFocus({ name: picked[0], nonce: Date.now() })
  }, [byName])
  const loading = Boolean(run) && qc.key !== qcKey

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

  return (
    <Paper sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <Typography variant="h6" sx={{ mr: 1 }}>QC selection</Typography>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>Auto-pick</InputLabel>
          <Select label="Auto-pick" value={nSelect} onChange={(e) => setNSelect(e.target.value)}>
            {[5, 6, 7, 8, 9, 10].map((n) => <MenuItem key={n} value={n}>{n} curves</MenuItem>)}
          </Select>
        </FormControl>
        {loading && <><CircularProgress size={20} /><Typography variant="caption">Running QC…</Typography></>}
      </Box>

      {!run && <Typography color="text.secondary">Pick a run first.</Typography>}
      {qc.error && <Alert severity="error" sx={{ mb: 2 }}>{qc.error}</Alert>}
      {save.error && <Alert severity="error" sx={{ mb: 2 }}>Save failed: {save.error}</Alert>}
      {qc.body?.warnings.map((w) => <Alert key={w} severity="warning" sx={{ mb: 1 }}>{w}</Alert>)}

      {qc.body && !loading && (
        <>
          <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 3fr) minmax(0, 2fr)' }, mb: 3 }}>
            <QcTable rows={rows} checked={checked} plotted={plotted} focus={focus?.name}
              onToggleChecked={(name) => setChecked((list) => toggle(list, name))}
              onTogglePlotted={togglePlotted} onShowCurve={showCurve} />
            <Box>
              <DoiNoiseScatter rows={rows} checked={checked} focus={focus?.name}
                onShowCurve={showCurve} onShowCurves={showCurves} />
              <SelectionSummary rows={rows} checked={checked} saving={save.saving} saved={save.saved}
                onRemove={(name) => setChecked((list) => list.filter((n) => n !== name))}
                onReset={() => setChecked(qc.body.selected)} onSave={saveSelection}
                onPlot={() => showCurves(checked)} />
            </Box>
          </Box>
          <Typography variant="subtitle2" gutterBottom>Curves vs measured depth</Typography>
          <CurveTrackPlot key={run} run={run} names={orderedPlotted} statusOf={statusOf} focus={focus} />
        </>
      )}
    </Paper>
  )
}

export default QcSelection
