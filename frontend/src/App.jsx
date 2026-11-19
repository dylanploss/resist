import { useEffect, useState } from 'react'
import { Alert, AppBar, Box, Container, Toolbar, Typography } from '@mui/material'
import CurveInventory from './components/CurveInventory.jsx'
import QcSelection from './components/QcSelection.jsx'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000'

function App() {
  const [health, setHealth] = useState({ state: 'loading' })

  useEffect(() => {
    fetch(`${API_URL}/health`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((body) => setHealth({ state: 'ok', status: body.status }))
      .catch((error) => setHealth({ state: 'error', message: error.message }))
  }, [])

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6">Resist QC and Inversion</Typography>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 3 }}>
        {health.state === 'loading' && <Alert severity="info">Checking backend…</Alert>}
        {health.state === 'ok' && <Alert severity="success">Backend status: {health.status}</Alert>}
        {health.state === 'error' && (
          <Alert severity="error">Backend not reachable: {health.message}</Alert>
        )}
        <Box sx={{ mt: 3 }}>
          <CurveInventory />
        </Box>
        <Box sx={{ mt: 3 }}>
          <QcSelection />
        </Box>
      </Container>
    </Box>
  )
}

export default App
