import { Paper, Typography } from '@mui/material'

function CurveInventory() {
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6">Curve inventory</Typography>
      <Typography variant="body2" color="text.secondary">
        Not connected yet. Shown once GET /curves returns data (Step 8).
      </Typography>
    </Paper>
  )
}

export default CurveInventory
