import { useCallback, useEffect, useMemo, useRef } from 'react'
import { UdarPool } from './udarWorker.js'
import { getCore } from './udarCore.js'

// Forward model and 1D inversion on the UDAR worker pool. Chunking follows UDAR_Bench/source/app/main.js.
export function useUdarWorker() {
  const poolRef = useRef(null)

  const pool = useCallback(() => {
    if (!poolRef.current) poolRef.current = new UdarPool()
    return poolRef.current
  }, [])

  useEffect(
    () => () => {
      if (poolRef.current) poolRef.current.dispose()
      poolRef.current = null
    },
    [],
  )

  const forward = useCallback(
    async (cfg, onProgress) => {
      const p = pool()
      const { buildTrajectory, stationList } = getCore()
      const tr = buildTrajectory(cfg.traj, 0.5)
      const st = stationList(cfg, tr)
      const nSt = st.length
      const nch = cfg.channels.length
      const t0 = performance.now()
      const nChunk = Math.min(nSt, Math.max(1, p.n * 3))
      const size = Math.ceil(nSt / nChunk)
      const payloads = []
      for (let i0 = 0; i0 < nSt; i0 += size) payloads.push({ cfg, i0, i1: Math.min(nSt, i0 + size) })
      const res = await p.run('fwd', payloads, onProgress)
      const data = new Float64Array(nSt * nch * 2)
      let o = 0
      for (const r of res) {
        data.set(r.out, o)
        o += r.out.length
      }
      return { cfg, tr, st, data, nSt, nch, ms: performance.now() - t0 }
    },
    [pool],
  )

  const invert = useCallback(
    async (fwd, icfg, obs, onProgress) => {
      const p = pool()
      const t0 = performance.now()
      const size = Math.max(12, Math.ceil(fwd.nSt / (p.n * 3)))
      const payloads = []
      for (let i0 = 0; i0 < fwd.nSt; i0 += size) payloads.push({ cfg: fwd.cfg, icfg, obs, i0, i1: Math.min(fwd.nSt, i0 + size) })
      const out = await p.run('inv', payloads, onProgress)
      const res = []
      for (const chunk of out) for (const r of chunk.res) res.push(r)
      res.sort((a, b) => a.i - b.i)
      return { res, icfg, ms: performance.now() - t0 }
    },
    [pool],
  )

  const cancel = useCallback(() => {
    if (poolRef.current) poolRef.current.cancel()
  }, [])

  return useMemo(() => ({ forward, invert, cancel }), [forward, invert, cancel])
}
