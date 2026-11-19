import { useEffect, useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { fsig, niceTicks, rampColor } from '../../udar/format.js'

const M = { l: 58, r: 12, t: 10, b: 34 }
const NO_OVERLAYS = []

// 1D section view ported in spirit from SectionChart in UDAR_Bench/source/app/chart.js.
export default function SectionChart({ sec, height = 300, cursorMd = null, onPick = null, overlays = NO_OVERLAYS }) {
  const boxRef = useRef(null)
  const canvasRef = useRef(null)
  const [width, setWidth] = useState(600)

  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width)
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pw = Math.max(10, width - M.l - M.r)
  const ph = Math.max(10, height - M.t - M.b)
  const sx = (x) => M.l + ((x - sec.x0) / (sec.x1 - sec.x0)) * pw
  const sz = (z) => M.t + ((z - sec.z0) / (sec.z1 - sec.z0)) * ph

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = width * dpr
    cv.height = height * dpr
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    const X = (x) => M.l + ((x - sec.x0) / (sec.x1 - sec.x0)) * pw
    const Z = (z) => M.t + ((z - sec.z0) / (sec.z1 - sec.z0)) * ph
    const lo = Math.log10(Math.min(...sec.rh))
    const hi = Math.log10(Math.max(...sec.rh))
    const col = (r) => rampColor(hi > lo ? (Math.log10(r) - lo) / (hi - lo) : 0.5)
    g.save()
    g.beginPath()
    g.rect(M.l, M.t, pw, ph)
    g.clip()
    const nl = sec.rh.length
    const far = (sec.z1 - sec.z0) * 10
    for (let k = 0; k < nl; k++) {
      const top = k === 0 ? [[sec.x0, sec.z0 - far], [sec.x1, sec.z0 - far]] : sec.boundaries[k - 1]
      const bot = k === nl - 1 ? [[sec.x0, sec.z1 + far], [sec.x1, sec.z1 + far]] : sec.boundaries[k]
      g.fillStyle = col(sec.rh[k])
      g.beginPath()
      g.moveTo(X(top[0][0]), Z(top[0][1]))
      g.lineTo(X(top[1][0]), Z(top[1][1]))
      g.lineTo(X(bot[1][0]), Z(bot[1][1]))
      g.lineTo(X(bot[0][0]), Z(bot[0][1]))
      g.closePath()
      g.fill()
    }
    g.strokeStyle = '#37474f'
    g.lineWidth = 1
    g.setLineDash([5, 3])
    for (const b of sec.boundaries) {
      g.beginPath()
      g.moveTo(X(b[0][0]), Z(b[0][1]))
      g.lineTo(X(b[1][0]), Z(b[1][1]))
      g.stroke()
    }
    g.setLineDash([])
    for (const o of overlays) {
      g.strokeStyle = o.color
      g.lineWidth = 1.6
      g.beginPath()
      o.pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Z(p[1])) : g.moveTo(X(p[0]), Z(p[1]))))
      g.stroke()
    }
    g.strokeStyle = '#111'
    g.lineWidth = 2
    g.beginPath()
    sec.well.forEach((p, i) => (i ? g.lineTo(X(p[0]), Z(p[1])) : g.moveTo(X(p[0]), Z(p[1]))))
    g.stroke()
    if (cursorMd !== null) {
      let best = sec.well[0]
      for (const p of sec.well) if (Math.abs(p[2] - cursorMd) < Math.abs(best[2] - cursorMd)) best = p
      g.fillStyle = '#d32f2f'
      g.beginPath()
      g.arc(X(best[0]), Z(best[1]), 5, 0, 2 * Math.PI)
      g.fill()
    }
    g.restore()
    g.strokeStyle = '#9aa1aa'
    g.strokeRect(M.l, M.t, pw, ph)
    g.fillStyle = '#5f6670'
    g.font = '11px system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'top'
    for (const v of niceTicks(sec.x0, sec.x1, Math.max(3, Math.floor(pw / 90)))) g.fillText(fsig(v, 4), X(v), M.t + ph + 4)
    g.textBaseline = 'bottom'
    g.fillText('Distance along section (m)', M.l + pw / 2, height - 2)
    g.textAlign = 'right'
    g.textBaseline = 'middle'
    for (const v of niceTicks(sec.z0, sec.z1, Math.max(3, Math.floor(ph / 40)))) g.fillText(fsig(v, 5), M.l - 4, Z(v))
    g.save()
    g.translate(12, M.t + ph / 2)
    g.rotate(-Math.PI / 2)
    g.textAlign = 'center'
    g.fillText('TVD (m)', 0, 0)
    g.restore()
  }, [sec, width, height, pw, ph, cursorMd, overlays])

  const pick = (e) => {
    if (!onPick) return
    const r = canvasRef.current.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    let best = null
    let bd = Infinity
    for (const p of sec.well) {
      const d = Math.hypot(sx(p[0]) - px, sz(p[1]) - py)
      if (d < bd) {
        bd = d
        best = p
      }
    }
    if (best && bd < 30) onPick(best[2])
  }

  return (
    <Box ref={boxRef} sx={{ width: '100%' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height, display: 'block', cursor: onPick ? 'crosshair' : 'default' }} onClick={pick} />
      <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
        Colour: horizontal resistivity (light = low, dark = high).{' '}
        {sec.rh.map((r, k) => `Layer ${k + 1}: ${fsig(r, 3)} Ω·m`).join(' · ')}
        {onPick ? ' · Click the well to place the tool.' : ''}
      </Typography>
    </Box>
  )
}
