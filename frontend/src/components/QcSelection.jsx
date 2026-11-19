import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, CircularProgress, FormControl, InputLabel, MenuItem, Paper, Select, Typography,
} from '@mui/material'
import { api, runPath } from '../api.js'
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

function QcSelection() {
  const [runs, setRuns] = useState([])
  const [run, setRun] = useState('')
  const [nSelect, setNSelect] = useState(8)
  const [qc, setQc] = useState({ key: null, body: null, error: null })
  const [checked, setChecked] = useState([])
  const [plotted, setPlotted] = useState([])
  const [save, setSave] = useState({ saving: false, saved: null, error: null })
  const qcKey = `${run}|${nSelect}`

  useEffect(() => {
    api('/runs')
      .then((body) => {
        setRuns(body.runs)
        setRun(body.runs[0]?.run ?? '')
      })
      .catch((error) => setQc({ key: null, body: null, error: error.message }))
  }, [])

  useEffect(() => {
    if (!run) return undefined
    let cancelled = false
    api(`${runPath(run)}/qc?n_select=${nSelect}`)
      .then((body) => {
        if (cancelled) return
        setQc({ key: qcKey, body, error: null })
        setChecked(body.selected)
        setPlotted(body.selected.slice(0, INITIAL_TRACKS))
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
        <FormControl size="small" sx={{ minWidth: 340 }}>
          <InputLabel>Run</InputLabel>
          <Select label="Run" value={run} onChange={(e) => setRun(e.target.value)}>
            {runs.map((r) => <MenuItem key={r.run} value={r.run}>{r.label}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>Auto-pick</InputLabel>
          <Select label="Auto-pick" value={nSelect} onChange={(e) => setNSelect(e.target.value)}>
            {[5, 6, 7, 8, 9, 10].map((n) => <MenuItem key={n} value={n}>{n} curves</MenuItem>)}
          </Select>
        </FormControl>
        {loading && <><CircularProgress size={20} /><Typography variant="caption">Running QC…</Typography></>}
      </Box>

      {qc.error && <Alert severity="error" sx={{ mb: 2 }}>{qc.error}</Alert>}
      {save.error && <Alert severity="error" sx={{ mb: 2 }}>Save failed: {save.error}</Alert>}
      {qc.body?.warnings.map((w) => <Alert key={w} severity="warning" sx={{ mb: 1 }}>{w}</Alert>)}

      {qc.body && !loading && (
        <>
          <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 3fr) minmax(0, 2fr)' }, mb: 3 }}>
            <QcTable rows={rows} checked={checked} plotted={plotted}
              onToggleChecked={(name) => setChecked((list) => toggle(list, name))}
              onTogglePlotted={togglePlotted} />
            <Box>
              <DoiNoiseScatter rows={rows} checked={checked} onTogglePlotted={togglePlotted} />
              <SelectionSummary rows={rows} checked={checked} saving={save.saving} saved={save.saved}
                onRemove={(name) => setChecked((list) => list.filter((n) => n !== name))}
                onReset={() => setChecked(qc.body.selected)} onSave={saveSelection} />
            </Box>
          </Box>
          <Typography variant="subtitle2" gutterBottom>Curves vs measured depth</Typography>
          <CurveTrackPlot key={run} run={run} names={plotted} statusOf={statusOf} />
        </>
      )}
    </Paper>
  )
}

export default QcSelection
