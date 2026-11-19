import { Paper, Typography } from '@mui/material'

function QcSelection() {
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6">QC selection</Typography>
      <Typography variant="body2" color="text.secondary">
        Not connected yet. Shown once POST /qc/select returns data (Step 8).
      </Typography>
    </Paper>
  )
}

export default QcSelection
