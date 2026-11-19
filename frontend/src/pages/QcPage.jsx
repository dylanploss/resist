import { Paper, Stack } from '@mui/material'
import ApiStatus from '../components/ApiStatus.jsx'
import QcSelection from '../components/QcSelection.jsx'
import RunPicker from '../components/RunPicker.jsx'

export default function QcPage({ runs, run, onRunChange }) {
  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <ApiStatus state={runs} label="Runs" onRetry={runs.reload} />
        {runs.data && <RunPicker runs={runs.data.runs} value={run} onChange={onRunChange} />}
      </Paper>
      <QcSelection run={run} />
    </Stack>
  )
}
