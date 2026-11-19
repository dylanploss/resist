import { Alert, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material'
import { API_URL, getHealth } from '../api.js'
import { useApi } from '../hooks/useApi.js'
import ApiStatus from '../components/ApiStatus.jsx'

export default function OverviewPage({ runs }) {
  const health = useApi(getHealth, 'health')
  const list = runs.data ? runs.data.runs : []

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6">Backend</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {API_URL} (set with VITE_API_URL)
        </Typography>
        <ApiStatus state={health} label="Health check" onRetry={health.reload} />
        {health.data && <Alert severity="success">Backend status: {health.data.status}</Alert>}
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography variant="h6">Runs</Typography>
          {runs.data && <Chip size="small" label={`${list.length} runs`} />}
        </Stack>
        <ApiStatus state={runs} label="Runs" onRetry={runs.reload} />
        {list.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Run</TableCell>
                <TableCell>Well</TableCell>
                <TableCell align="right">Depth min (m)</TableCell>
                <TableCell align="right">Depth max (m)</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.run}>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{r.run}</TableCell>
                  <TableCell>{r.error ? <Typography color="error">{r.error}</Typography> : r.well}</TableCell>
                  <TableCell align="right">{r.depth_min_m === null ? '–' : r.depth_min_m.toFixed(1)}</TableCell>
                  <TableCell align="right">{r.depth_max_m === null ? '–' : r.depth_max_m.toFixed(1)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6">Pages</Typography>
        <Typography variant="body2">
          <b>Data</b>: curve inventory and curves vs depth for one run. <b>QC selection</b>: backend curve selection with reasons and scores.{' '}
          <b>Modelling (UDAR)</b>: the UDAR_Bench 1D forward model and inversion, running in Web Workers in this browser.
        </Typography>
      </Paper>
    </Stack>
  )
}
