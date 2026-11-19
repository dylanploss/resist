import { useCallback, useEffect, useRef } from 'react'

const FONT_PX = 14

// PNG data URL of the WebGL canvas inside `root`, with a one-line label in the bottom-left corner.
// Needs the canvas created with preserveDrawingBuffer so the last frame is still readable.
export function snapshotDataUrl(root, label) {
  const source = root?.querySelector('canvas')
  if (!source) return null
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const ctx = out.getContext('2d')
  ctx.drawImage(source, 0, 0)
  if (label) {
    const px = Math.round(FONT_PX * (source.width / Math.max(source.clientWidth, 1)))
    ctx.font = `${px}px Roboto, Arial, sans-serif`
    const pad = px / 2
    const w = ctx.measureText(label).width + 2 * pad
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillRect(0, out.height - px * 1.6, w, px * 1.6)
    ctx.fillStyle = '#263238'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, pad, out.height - px * 0.8)
  }
  return out.toDataURL('image/png')
}

const safe = (s) => String(s ?? '').replace(/[^\w.-]+/g, '-')

// Save PNG for the 3D view, also exposed as window.__well3dSnapshot() (returns the data URL) for
// automated screenshots while the tab is active.
export function useSnapshot({ viewport, active, run, curve, md }) {
  const info = useRef({})
  useEffect(() => {
    info.current = { viewport, run, curve, md }
  })
  const capture = useCallback(() => {
    const { viewport: v, run: r, curve: c, md: m } = info.current
    return snapshotDataUrl(v.current, `${r} · ${c} · MD ${m.toFixed(1)} ft`)
  }, [])

  const save = useCallback(() => {
    const url = capture()
    if (!url) return
    const { run: r, curve: c, md: m } = info.current
    const a = document.createElement('a')
    a.href = url
    a.download = `${safe(r)}_${safe(c)}_${Math.round(m)}ft.png`
    a.click()
  }, [capture])

  useEffect(() => {
    if (!active) return undefined
    window.__well3dSnapshot = capture
    return () => {
      if (window.__well3dSnapshot === capture) delete window.__well3dSnapshot
    }
  }, [active, capture])

  return save
}
