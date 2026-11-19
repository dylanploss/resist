import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { AppBar, Box, Container, CssBaseline, LinearProgress, Tab, Tabs, ThemeProvider, Toolbar, Typography, createTheme } from '@mui/material'
import { getRuns } from './api.js'
import { useApi } from './hooks/useApi.js'
import DataPage from './pages/DataPage.jsx'
import OverviewPage from './pages/OverviewPage.jsx'
import { SelectionContext } from './selection.js'

// Lazy pages load on first visit: Modelling bundles the UDAR core, QC bundles Plotly, 3D well bundles three.js.
const ModellingPage = lazy(() => import('./pages/ModellingPage.jsx'))
const QcPage = lazy(() => import('./pages/QcPage.jsx'))
const Well3dPage = lazy(() => import('./pages/Well3dPage.jsx'))

const theme = createTheme({ palette: { primary: { main: '#2a78d6' } } })

const PAGES = [
  { id: 'overview', label: 'Overview' },
  { id: 'data', label: 'Data' },
  { id: 'qc', label: 'QC selection' },
  { id: '3d', label: '3D well' },
  { id: 'udar', label: 'Modelling (UDAR)' },
]

// ?tab=3d&run=<run>&curve=<curve> opens a page directly, so a 3D view can be bookmarked.
function initialQuery() {
  const query = new URLSearchParams(window.location.search)
  const tab = query.get('tab')
  const page = PAGES.some((p) => p.id === tab) ? tab : 'overview'
  return { page, run: query.get('run') ?? '', curve: query.get('curve') ?? '' }
}

function syncQuery(page, run, curve) {
  const query = new URLSearchParams(window.location.search)
  const set = (key, value) => (value ? query.set(key, value) : query.delete(key))
  set('tab', page === 'overview' ? '' : page)
  set('run', run)
  set('curve', page === '3d' ? curve : '')
  const search = query.toString()
  const url = window.location.pathname + (search ? `?${search}` : '') + window.location.hash
  window.history.replaceState(window.history.state, '', url)
}

function App() {
  const [initial] = useState(initialQuery)
  const [page, setPage] = useState(initial.page)
  const [opened, setOpened] = useState({ [initial.page]: true })
  const [run, setRun] = useState(initial.run)
  const [curve, setCurve] = useState(initial.curve)
  const runs = useApi(getRuns, 'runs')

  const openPage = useCallback((v) => {
    setPage(v)
    setOpened((o) => (o[v] ? o : { ...o, [v]: true }))
  }, [])

  const selection = useMemo(() => ({
    run,
    setRun,
    curve,
    setCurve,
    openWell3d: (r, c) => {
      setRun(r)
      setCurve(c)
      openPage('3d')
      window.scrollTo({ top: 0 })
    },
  }), [run, curve, openPage])

  useEffect(() => syncQuery(page, run, curve), [page, run, curve])

  return (
    <ThemeProvider theme={theme}>
      <SelectionContext value={selection}>
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
          <Box hidden={page !== '3d'}>
            {opened['3d'] && (
              <Suspense fallback={<LinearProgress />}>
                <Well3dPage runs={runs} active={page === '3d'} />
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
      </SelectionContext>
    </ThemeProvider>
  )
}

export default App
