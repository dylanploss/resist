import { useState } from 'react'
import { Paper, Stack } from '@mui/material'
import ApiStatus from '../components/ApiStatus.jsx'
import CurveInventory from '../components/CurveInventory.jsx'
import CurvePlot from '../components/CurvePlot.jsx'
import RunPicker from '../components/RunPicker.jsx'

export default function DataPage({ runs, run, onRunChange }) {
  const [selection, setSelection] = useState({ run: null, curves: [] })
  const selected = selection.run === run ? selection.curves : []
  const setSelected = (curves) => setSelection({ run, curves })

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <ApiStatus state={runs} label="Runs" onRetry={runs.reload} />
        {runs.data && <RunPicker runs={runs.data.runs} value={run} onChange={onRunChange} />}
      </Paper>
      <CurveInventory run={run} selected={selected} onSelectedChange={setSelected} />
      <CurvePlot run={run} curves={selected} />
    </Stack>
  )
}
