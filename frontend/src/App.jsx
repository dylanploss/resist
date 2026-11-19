import { Suspense, lazy, useState } from 'react'
import { AppBar, Box, Container, CssBaseline, LinearProgress, Tab, Tabs, ThemeProvider, Toolbar, Typography, createTheme } from '@mui/material'
import { getRuns } from './api.js'
import { useApi } from './hooks/useApi.js'
import DataPage from './pages/DataPage.jsx'
import OverviewPage from './pages/OverviewPage.jsx'

// Lazy pages load on first visit: Modelling bundles the UDAR core, QC bundles Plotly.
const ModellingPage = lazy(() => import('./pages/ModellingPage.jsx'))
const QcPage = lazy(() => import('./pages/QcPage.jsx'))

const theme = createTheme({ palette: { primary: { main: '#2a78d6' } } })

const PAGES = [
  { id: 'overview', label: 'Overview' },
  { id: 'data', label: 'Data' },
  { id: 'qc', label: 'QC selection' },
  { id: 'udar', label: 'Modelling (UDAR)' },
]

function App() {
  const [page, setPage] = useState('overview')
  const [opened, setOpened] = useState({})
  const [run, setRun] = useState('')
  const runs = useApi(getRuns, 'runs')

  const openPage = (v) => {
    setPage(v)
    setOpened((o) => (o[v] ? o : { ...o, [v]: true }))
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="sticky">
        <Toolbar sx={{ gap: 3 }}>
          <Typography variant="h6" sx={{ whiteSpace: 'nowrap' }}>
            Resist QC and Inversion
          </Typography>
          <Tabs value={page} onChange={(e, v) => openPage(v)} textColor="inherit" indicatorColor="secondary" aria-label="Pages">
            {PAGES.map((p) => (
              <Tab key={p.id} value={p.id} label={p.label} />
            ))}
          </Tabs>
        </Toolbar>
      </AppBar>
      <Container maxWidth={false} sx={{ py: 2 }}>
        <Box hidden={page !== 'overview'}>
          <OverviewPage runs={runs} />
        </Box>
        <Box hidden={page !== 'data'}>
          <DataPage runs={runs} run={run} onRunChange={setRun} />
        </Box>
        <Box hidden={page !== 'qc'}>
          {opened.qc && (
            <Suspense fallback={<LinearProgress />}>
              <QcPage runs={runs} run={run} onRunChange={setRun} />
            </Suspense>
          )}
        </Box>
        <Box hidden={page !== 'udar'}>
          {opened.udar && (
            <Suspense fallback={<LinearProgress />}>
              <ModellingPage />
            </Suspense>
          )}
        </Box>
      </Container>
    </ThemeProvider>
  )
}

export default App
