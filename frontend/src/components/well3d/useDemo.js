import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { demoScript } from './demoScript.js'

const OVERVIEW_MS = 3000
const FOLLOW_MS = 1200
const STOP_MS = 2500
const POLL_MS = 100
const ARRIVE_FT = 1

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Scripted fly-through of the 3D well: overview → Follow travel with captioned stops → overview.
// The page owns the travel state; the demo drives it through setTravel/setMode/scene and, while
// running, overrides the travel speed and end MD (`overrides`). Stop, Escape, a run/curve change or
// any manual travel (space, arrows, slider) cancels the demo and hands control back.
export function useDemo({ data, path, active, scene, md, playing, mdStart, mdEnd, setTravel, setMode }) {
  const [demo, setDemo] = useState(null)
  const token = useRef(0)
  const live = useRef({})
  useEffect(() => {
    live.current = { md, playing }
  })

  const stop = useCallback(() => {
    token.current += 1
    setDemo(null)
    setTravel((t) => ({ ...t, playing: false }))
  }, [setTravel])

  const start = useCallback(async () => {
    if (!data || !path) return
    const mine = ++token.current
    const alive = () => token.current === mine
    const finish = () => setDemo((d) => (d?.token === mine ? null : d))
    const { speed, stops } = demoScript(data, mdStart, mdEnd)
    const show = (patch) => alive() && setDemo((d) => ({ ...d, ...patch, token: mine }))
    // Waits ms while the travel state stays as the demo left it (sampled after the first poll, once
    // React has rendered the demo's own update); false means cancelled or taken over by the user.
    const hold = async (ms) => {
      await sleep(POLL_MS)
      const { md: md0 } = live.current
      for (let t = POLL_MS; t < ms; t += POLL_MS) {
        await sleep(POLL_MS)
        const now = live.current
        if (!alive() || now.playing || Math.abs(now.md - md0) > ARRIVE_FT) return false
      }
      return alive()
    }
    const travelTo = async (target) => {
      const limit = ((target - live.current.md) / speed) * 1000 + 5000
      setDemo((d) => ({ ...d, stopAt: target, token: mine }))
      setTravel((t) => ({ ...t, data, playing: true }))
      for (let t = 0; t < limit; t += POLL_MS) {
        await sleep(POLL_MS)
        if (!alive()) return false
        const now = live.current
        if (now.md >= target - ARRIVE_FT && !now.playing) return true
        if (t > 3 * POLL_MS && !now.playing) return false
      }
      return false
    }

    setDemo({ token: mine, speed, stopAt: null, step: 0, total: stops.length, caption: {
      title: 'Overview',
      text: `${data.well} · ${data.curve} · MD ${Math.round(mdStart).toLocaleString('en-US')}–` +
        `${Math.round(mdEnd).toLocaleString('en-US')} ft · colour = value, tube radius = DOI estimate`,
    } })
    setTravel({ data, md: mdStart, playing: false })
    setMode('free')
    scene.current?.fit()
    if (!(await hold(OVERVIEW_MS))) return finish()

    show({ caption: { title: 'Follow', text: 'Travelling down the well behind the tool' } })
    setMode('follow')
    if (!(await hold(FOLLOW_MS))) return finish()

    for (const [k, s] of stops.entries()) {
      show({ caption: null })
      if (s.md > live.current.md + ARRIVE_FT && !(await travelTo(s.md))) return finish()
      show({ step: k + 1, caption: { title: s.title, text: s.text } })
      if (!(await hold(STOP_MS))) return finish()
    }

    show({ step: 0, caption: { title: 'Overview', text: 'Back to the whole well. Drag to orbit, or press Demo again.' } })
    setMode('free')
    scene.current?.fit()
    await hold(OVERVIEW_MS)
    finish()
  }, [data, path, mdStart, mdEnd, scene, setTravel, setMode])

  // A new run/curve or leaving the tab ends the script; its loop clears the state on the next poll.
  useEffect(() => () => {
    token.current += 1
  }, [data, active])

  const running = Boolean(demo) && active
  const speed = demo?.speed
  const stopAt = demo?.stopAt
  const overrides = useMemo(() => (running ? { speed, ...(stopAt != null && { mdEnd: stopAt }) } : null),
    [running, speed, stopAt])
  useEffect(() => {
    if (!running) return undefined
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, stop])

  return {
    running,
    start,
    stop,
    caption: running ? demo.caption : null,
    step: running ? demo.step : 0,
    total: running ? demo.total : 0,
    overrides,
  }
}
