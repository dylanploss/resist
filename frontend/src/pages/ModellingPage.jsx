import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Snackbar, Stack, Tab, Tabs, Typography } from '@mui/material'
import { getCore } from '../compute/udarCore.js'
import { useUdarWorker } from '../compute/useUdarWorker.js'
import { clone } from '../udar/format.js'
import { cfgFromState, clearState, defaultSpec, defaultState, icfgFromState, loadState, saveState, specFreeCount, stationCount, validate } from '../udar/state.js'
import FwdView from './modelling/FwdView.jsx'
import GeoView from './modelling/GeoView.jsx'
import InvView from './modelling/InvView.jsx'
import ToolView from './modelling/ToolView.jsx'

const TABS = [
  { id: 'tool', label: 'Tool' },
  { id: 'geo', label: 'Geology & well' },
  { id: 'fwd', label: 'Forward' },
  { id: 'inv', label: 'Inversion' },
]
const AUTO_LIMIT = 4000

// UDAR_Bench (1D mode) inside the platform: same tabs, presets and controls; compute runs in Web Workers.
export default function ModellingPage() {
  const worker = useUdarWorker()
  const [S, setS] = useState(loadState)
  const [fwd, setFwd] = useState(null)
  const [inv, setInv] = useState(null)
  const [busy, setBusy] = useState(null)
  const [progress, setProgress] = useState(null)
  const [toast, setToast] = useState(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [autoBlockedKey, setAutoBlockedKey] = useState(null)
  const runToken = useRef(0)

  const update = useCallback(
    (fn) =>
      setS((prev) => {
        const d = clone(prev)
        fn(d)
        return d
      }),
    [],
  )
  const setCursor = useCallback((md) => update((d) => (d.cursorMd = md)), [update])

  useEffect(() => {
    const t = setTimeout(() => saveState(S), 500)
    return () => clearTimeout(t)
  }, [S])

  const cfgKey = JSON.stringify(cfgFromState(S))
  const cfg = useMemo(() => JSON.parse(cfgKey), [cfgKey])
  const cfgError = validate(cfg)
  const tr = useMemo(() => {
    try {
      return getCore().buildTrajectory(cfg.traj, 0.5)
    } catch {
      return null
    }
  }, [cfg])

  const specKey = JSON.stringify([S.inv.perturb, S.inv.anisoFree, S.inv.nLayers])
  const spec = useMemo(() => {
    const [perturb, anisoFree, nL] = JSON.parse(specKey)
    try {
      return defaultSpec({ inv: { perturb, anisoFree } }, cfg, nL)
    } catch {
      return null
    }
  }, [specKey, cfg])

  const noiseKey = JSON.stringify(S.inv.noise)
  const obs = useMemo(() => (fwd ? getCore().addNoise(fwd.data, fwd.nSt, fwd.nch, JSON.parse(noiseKey)) : null), [fwd, noiseKey])
  const icfgKey = spec ? JSON.stringify(icfgFromState(S, cfg, spec)) : ''
  const invKey = JSON.stringify([cfgKey, noiseKey, icfgKey])

  const fwdStatus = busy === 'fwd' ? 'busy' : !fwd ? 'none' : fwd.key === cfgKey ? 'ok' : 'stale'
  const invStatus = busy === 'inv' ? 'busy' : !inv ? 'none' : inv.key === invKey ? 'ok' : 'stale'

  const onProgress = (token, t0) => (f) => {
    if (token === runToken.current) setProgress({ f, elapsed: (performance.now() - t0) / 1000 })
  }

  const runForward = async (auto) => {
    if (busy) return null
    if (cfgError) {
      if (!auto) setToast(cfgError)
      return null
    }
    const token = ++runToken.current
    setBusy('fwd')
    setProgress({ f: 0, elapsed: 0 })
    try {
      const r = await worker.forward(cfg, onProgress(token, performance.now()))
      if (token !== runToken.current) return null
      const result = { ...r, key: cfgKey }
      setFwd(result)
      return result
    } catch (e) {
      if (token === runToken.current && e.message !== 'cancelled') setToast(`Forward model failed: ${String(e.message).split('\n')[0]}`)
      if (auto) setAutoBlockedKey(cfgKey)
      return null
    } finally {
      if (token === runToken.current) setBusy(null)
    }
  }

  const runInversion = async () => {
    if (busy) return
    if (cfgError) {
      setToast(cfgError)
      return
    }
    if (!spec) {
      setToast('The starting model could not be built.')
      return
    }
    const icfg = icfgFromState(S, cfg, spec)
    if (!icfg.channels.length) {
      setToast('Select at least one channel for the inversion.')
      return
    }
    if (!specFreeCount(icfg.spec)) {
      setToast('No parameter is free.')
      return
    }
    const f = fwdStatus === 'ok' ? fwd : await runForward(false)
    if (!f) return
    const core = getCore()
    const noisy = core.addNoise(f.data, f.nSt, f.nch, S.inv.noise)
    const token = ++runToken.current
    setBusy('inv')
    setProgress({ f: 0, elapsed: 0 })
    try {
      const r = await worker.invert(f, icfg, noisy, onProgress(token, performance.now()))
      if (token !== runToken.current) return
      const N = r.res.length ? r.res[0].rh.length : 0
      const truth = N === f.cfg.geo1.layers.length ? f.st.map((s) => core.truthAt(f.cfg, s)) : null
      setInv({ key: invKey, cfg: f.cfg, st: f.st, tr: f.tr, obs: noisy, clean: f.data, nch: f.nch, res: r.res, icfg, ms: r.ms, truth })
    } catch (e) {
      if (token === runToken.current && e.message !== 'cancelled') setToast(`Inversion failed: ${String(e.message).split('\n')[0]}`)
    } finally {
      if (token === runToken.current) setBusy(null)
    }
  }

  const cancel = () => {
    runToken.current++
    worker.cancel()
    setAutoBlockedKey(cfgKey)
    if (busy) setToast('Cancelled.')
    setBusy(null)
  }

  const autoRun = useEffectEvent(() => runForward(true))
  const cost = stationCount(cfg) * new Set(cfg.channels.map((c) => `${c.L}|${c.f}`)).size
  const wantAuto = S.auto && !busy && (S.tab === 'fwd' || S.tab === 'inv') && fwdStatus !== 'ok' && !cfgError && cost <= AUTO_LIMIT && autoBlockedKey !== cfgKey
  useEffect(() => {
    if (!wantAuto) return undefined
    const t = setTimeout(() => autoRun(), 300)
    return () => clearTimeout(t)
  }, [wantAuto, cfgKey])

  const reset = () => {
    cancel()
    clearState()
    setS(defaultState())
    setFwd(null)
    setInv(null)
    setConfirmReset(false)
  }

  return (
    <Stack spacing={2}>
      <Box sx={{ display: 'flex', alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={S.tab} onChange={(e, v) => update((d) => (d.tab = v))} aria-label="UDAR workflow">
          {TABS.map((t) => (
            <Tab key={t.id} value={t.id} label={t.label} />
          ))}
        </Tabs>
        <Typography variant="body2" color="text.secondary" sx={{ ml: 'auto', mr: 1 }}>
          Forward model: 1D
        </Typography>
        <Button size="small" onClick={() => setConfirmReset(true)}>
          Reset all settings
        </Button>
      </Box>
      {S.tab === 'tool' && <ToolView S={S} update={update} />}
      {S.tab === 'geo' && <GeoView S={S} update={update} cfg={cfg} cfgError={cfgError} setCursor={setCursor} />}
      {S.tab === 'fwd' && (
        <FwdView S={S} update={update} cfg={cfg} cfgError={cfgError} fwd={fwd} status={fwdStatus} progress={progress} onRun={runForward} onCancel={cancel} setCursor={setCursor} tr={tr} />
      )}
      {S.tab === 'inv' && (
        <InvView
          S={S}
          update={update}
          cfg={cfg}
          spec={spec}
          fwd={fwd}
          obs={obs}
          inv={inv}
          status={invStatus}
          busy={busy}
          progress={progress}
          onRun={runInversion}
          onCancel={cancel}
          setCursor={setCursor}
          tr={tr}
        />
      )}
      <Snackbar open={Boolean(toast)} autoHideDuration={5000} onClose={() => setToast(null)}>
        <Alert severity="error" onClose={() => setToast(null)} variant="filled">
          {toast}
        </Alert>
      </Snackbar>
      <Dialog open={confirmReset} onClose={() => setConfirmReset(false)}>
        <DialogTitle>Reset all settings?</DialogTitle>
        <DialogContent>The tool, well, geology and inversion settings return to their defaults, and the computed results are cleared.</DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmReset(false)}>Keep my settings</Button>
          <Button variant="contained" onClick={reset}>
            Reset
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
