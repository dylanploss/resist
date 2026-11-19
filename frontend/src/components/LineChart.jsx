import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import { fsig, logTicks, niceTicks, tickLabel } from '../udar/format.js'

const M = { l: 58, r: 12, t: 10, b: 38 }
const NO_LINES = []

function extent(series, axis, log, lim) {
  if (lim) return lim
  let lo = Infinity
  let hi = -Infinity
  for (const s of series) {
    for (const v of s[axis]) {
      if (v === null || !isFinite(v) || (log && v <= 0)) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  if (!isFinite(lo)) return log ? [1, 10] : [0, 1]
  if (log) {
    lo = Math.pow(10, Math.floor(Math.log10(lo) + 1e-9))
    hi = Math.pow(10, Math.ceil(Math.log10(hi) - 1e-9))
    if (hi <= lo) hi = lo * 10
    return [lo, hi]
  }
  if (hi === lo) return [lo - 1, hi + 1]
  const pad = (hi - lo) * 0.04
  return [lo - pad, hi + pad]
}

// Canvas line chart ported in spirit from UDAR_Bench/source/app/chart.js (LineChart).
// series: [{ name, color, x, y, dash, width }]; null and non-finite values break the line.
export default function LineChart({
  series,
  height = 220,
  xlog = false,
  ylog = false,
  yReverse = false,
  xlabel = '',
  ylabel = '',
  xlim = null,
  ylim = null,
  cursorX = null,
  cursorY = null,
  hlines = NO_LINES,
  onPick = null,
  legend = true,
}) {
  const boxRef = useRef(null)
  const canvasRef = useRef(null)
  const [width, setWidth] = useState(600)
  const [hover, setHover] = useState(null)

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

  const xr = useMemo(() => extent(series, 'x', xlog, xlim), [series, xlog, xlim])
  const yr = useMemo(() => extent(series, 'y', ylog, ylim), [series, ylog, ylim])

  const scale = useMemo(() => {
    const pw = Math.max(10, width - M.l - M.r)
    const ph = Math.max(10, height - M.t - M.b)
    const tf = (log) => (v) => (log ? Math.log10(v) : v)
    const fx = tf(xlog)
    const fy = tf(ylog)
    const [x0, x1] = [fx(xr[0]), fx(xr[1])]
    const [y0, y1] = [fy(yr[0]), fy(yr[1])]
    const sx = (v) => M.l + ((fx(v) - x0) / (x1 - x0 || 1)) * pw
    const syRaw = (v) => ((fy(v) - y0) / (y1 - y0 || 1)) * ph
    const sy = (v) => (yReverse ? M.t + syRaw(v) : M.t + ph - syRaw(v))
    const ix = (px) => {
      const t = x0 + ((px - M.l) / pw) * (x1 - x0)
      return xlog ? Math.pow(10, t) : t
    }
    const iy = (py) => {
      const f = yReverse ? (py - M.t) / ph : (M.t + ph - py) / ph
      const t = y0 + f * (y1 - y0)
      return ylog ? Math.pow(10, t) : t
    }
    return { pw, ph, sx, sy, ix, iy }
  }, [width, height, xr, yr, xlog, ylog, yReverse])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = width * dpr
    cv.height = height * dpr
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    const { pw, ph, sx, sy } = scale
    g.font = '11px system-ui, sans-serif'
    g.strokeStyle = '#e3e6ea'
    g.fillStyle = '#5f6670'
    g.lineWidth = 1
    const xt = xlog ? logTicks(xr[0], xr[1]) : niceTicks(xr[0], xr[1], Math.max(3, Math.floor(pw / 80)))
    const yt = ylog ? logTicks(yr[0], yr[1]) : niceTicks(yr[0], yr[1], Math.max(3, Math.floor(ph / 40)))
    g.textAlign = 'center'
    g.textBaseline = 'top'
    for (const v of xt) {
      const px = sx(v)
      g.beginPath()
      g.moveTo(px, M.t)
      g.lineTo(px, M.t + ph)
      g.stroke()
      g.fillText(xlog ? fsig(v, 2) : tickLabel(v, xr[1] - xr[0]), px, M.t + ph + 4)
    }
    g.textAlign = 'right'
    g.textBaseline = 'middle'
    for (const v of yt) {
      const py = sy(v)
      g.beginPath()
      g.moveTo(M.l, py)
      g.lineTo(M.l + pw, py)
      g.stroke()
      g.fillText(ylog ? fsig(v, 2) : tickLabel(v, yr[1] - yr[0]), M.l - 4, py)
    }
    g.strokeStyle = '#9aa1aa'
    g.strokeRect(M.l, M.t, pw, ph)
    g.textAlign = 'center'
    g.textBaseline = 'bottom'
    g.fillText(xlabel, M.l + pw / 2, height - 2)
    g.save()
    g.translate(12, M.t + ph / 2)
    g.rotate(-Math.PI / 2)
    g.textBaseline = 'middle'
    g.fillText(ylabel, 0, 0)
    g.restore()

    g.save()
    g.beginPath()
    g.rect(M.l, M.t, pw, ph)
    g.clip()
    for (const h of hlines) {
      g.strokeStyle = h.color || '#9aa1aa'
      g.setLineDash([4, 3])
      g.beginPath()
      g.moveTo(M.l, sy(h.y))
      g.lineTo(M.l + pw, sy(h.y))
      g.stroke()
    }
    for (const s of series) {
      g.strokeStyle = s.color
      g.globalAlpha = s.opacity ?? 1
      g.lineWidth = s.width || 1.6
      g.setLineDash(s.dash || [])
      const n = Math.min(s.x.length, s.y.length)
      if (s.marker) {
        g.fillStyle = s.color
        for (let i = 0; i < n; i++) {
          const xv = s.x[i]
          const yv = s.y[i]
          if (xv === null || yv === null || !isFinite(xv) || !isFinite(yv)) continue
          g.fillRect(sx(xv) - s.marker / 2, sy(yv) - s.marker / 2, s.marker, s.marker)
        }
        continue
      }
      g.beginPath()
      let pen = false
      for (let i = 0; i < n; i++) {
        const xv = s.x[i]
        const yv = s.y[i]
        const ok = xv !== null && yv !== null && isFinite(xv) && isFinite(yv) && (!xlog || xv > 0) && (!ylog || yv > 0)
        if (!ok) {
          pen = false
          continue
        }
        if (pen) g.lineTo(sx(xv), sy(yv))
        else g.moveTo(sx(xv), sy(yv))
        pen = true
      }
      g.stroke()
      if (s.band) {
        g.fillStyle = s.color
        g.globalAlpha = 0.15
        g.beginPath()
        for (let i = 0; i < n; i++) g.lineTo(sx(s.x[i]), sy(s.band[0][i]))
        for (let i = n - 1; i >= 0; i--) g.lineTo(sx(s.x[i]), sy(s.band[1][i]))
        g.closePath()
        g.fill()
      }
    }
    g.globalAlpha = 1
    g.setLineDash([])
    g.strokeStyle = '#d32f2f'
    g.lineWidth = 1
    if (cursorX !== null && isFinite(cursorX)) {
      g.beginPath()
      g.moveTo(sx(cursorX), M.t)
      g.lineTo(sx(cursorX), M.t + ph)
      g.stroke()
    }
    if (cursorY !== null && isFinite(cursorY)) {
      g.beginPath()
      g.moveTo(M.l, sy(cursorY))
      g.lineTo(M.l + pw, sy(cursorY))
      g.stroke()
    }
    g.restore()
  }, [series, width, height, scale, xr, yr, xlog, ylog, xlabel, ylabel, cursorX, cursorY, hlines])

  const toData = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    if (px < M.l || px > M.l + scale.pw || py < M.t || py > M.t + scale.ph) return null
    return { x: scale.ix(px), y: scale.iy(py) }
  }

  return (
    <Box ref={boxRef} sx={{ width: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height, display: 'block', cursor: onPick ? 'crosshair' : 'default' }}
        onMouseMove={(e) => setHover(toData(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const p = toData(e)
          if (p && onPick) onPick(p)
        }}
      />
      <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', minHeight: 20, px: 1 }} useFlexGap>
        {legend &&
          series
            .filter((s) => s.name && !s.hideLegend)
            .map((s) => (
              <Typography key={s.name} variant="caption" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Box component="span" sx={{ width: 14, height: 3, bgcolor: s.color, display: 'inline-block' }} />
                {s.name}
              </Typography>
            ))}
        {hover && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
            {xlabel || 'x'} {fsig(hover.x, 4)} · {ylabel || 'y'} {fsig(hover.y, 4)}
          </Typography>
        )}
      </Stack>
    </Box>
  )
}
