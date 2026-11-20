import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Box, Button, Checkbox, FormControl, FormControlLabel, InputLabel, ListItemText, MenuItem, Select, Slider, Switch,
  TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material'
import {
  RH_TICKS, apparentDip, buildSection, colorRange as clampRange, fadeAlpha, horizontalDisplacement, interp, interpPairs,
  rhRgb, sectionCell,
} from './sectionModel.js'

// Custom (canvas + SVG) curtain section with QC tracks underneath on the same MD axis. A shared cursor runs through
// the section and every track; dip lines can be drawn and edited on the section (they constrain the next inversion).

const ML = 64
const MR = 64
const MT = 10
const MB = 24
const TRACK_GAP = 6
const HIT_PX = 8
const MIN_SPAN_FT = 5
const KIND = {
  avg: { model: '#2a78d6', data: '#222222' },
  top: { model: '#2e9e4f', data: '#1b5e20' },
  bottom: { model: '#a142f4', data: '#4a148c' },
  geosignal: { model: '#e8710a', data: '#5d4037' },
}
const KIND_SHORT = { avg: 'avg', top: 'top', bottom: 'bot', geosignal: 'geo' }
const LINE_COLOR = '#111'
const SELECTED_COLOR = '#d500f9'
const SECTION_HEIGHTS = [240, 320, 420, 560]
const TRACK_HEIGHTS = [70, 100, 140, 200]

let lineCounter = 0
const newLineId = () => `line-${Date.now().toString(36)}-${lineCounter++}`

function niceStep(span, target) {
  const raw = span / Math.max(1, target)
  const p = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p
}

function ticks(a, b, target) {
  const step = niceStep(b - a, target)
  const out = []
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Number(v.toFixed(6)))
  return out
}

function logTicks(lo, hi) {
  const out = []
  for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
    for (const m of [1, 2, 5]) {
      const v = Math.log10(m) + e
      if (v >= lo - 1e-9 && v <= hi + 1e-9) out.push(v)
    }
  }
  return out.length > 8 ? out.filter((v) => Math.abs(v - Math.round(v)) < 1e-9) : out
}

const fmtVal = (v) => (v == null || !Number.isFinite(v) ? '–' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2))

function useWidth(ref) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    setWidth(Math.floor(el.getBoundingClientRect().width))
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

function pathD(xs, ys, X, Y, a, b) {
  let d = ''
  let pen = false
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]
    const y = ys[i]
    if (x == null || y == null || !Number.isFinite(y) || x < a - 50 || x > b + 50) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`
    pen = true
  }
  return d
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// Values shown in a track: measured/modelled resistivity (log axis) or geosignal (linear), or residuals.
function trackSeries(curve, mode) {
  const isRes = curve.unit === 'ohm.m'
  if (mode === 'residual') {
    if (!curve.pred) return null
    const r = curve.obs.map((o, i) => {
      const p = curve.pred[i]
      if (o == null || p == null) return null
      return isRes ? 100 * (p / o - 1) : p - o
    })
    return { residual: r, log: false, unit: isRes ? '% (model/measured − 1)' : curve.unit }
  }
  const tr = (v) => (v == null ? null : isRes ? (v > 0 ? Math.log10(v) : null) : v)
  return { obs: curve.obs.map(tr), pred: curve.pred?.map(tr) ?? null, log: isRes, unit: curve.unit }
}

function Track({ group, curves, md, width, height, X, a, b, mode, cursor, onMove, onLeave, last }) {
  const clipId = useId()
  const series = useMemo(() => curves.map((c) => ({ c, s: trackSeries(c, mode) })).filter((x) => x.s), [curves, mode])
  const { lo, hi, log } = useMemo(() => {
    let mn = Infinity
    let mx = -Infinity
    for (const { s } of series) {
      for (const arr of [s.obs, s.pred, s.residual]) {
        if (!arr) continue
        arr.forEach((v, i) => {
          if (v == null || md[i] == null || md[i] < a || md[i] > b) return
          if (v < mn) mn = v
          if (v > mx) mx = v
        })
      }
    }
    if (!Number.isFinite(mn)) return { lo: 0, hi: 1, log: false }
    const pad = Math.max((mx - mn) * 0.08, series[0]?.s.log ? 0.05 : 1e-3)
    return { lo: mn - pad, hi: mx + pad, log: series[0]?.s.log ?? false }
  }, [series, md, a, b])
  const h = height
  const Y = (v) => MT + (1 - (v - lo) / (hi - lo || 1)) * (h - MT - 4)
  const yt = log ? logTicks(lo, hi) : ticks(lo, hi, 4)
  const total = h + (last ? MB : 0)
  const at = cursor == null ? null : series.map(({ c, s }) => {
    const arr = s.residual ?? s.pred ?? s.obs
    const v = interp(md, arr, cursor)
    const shown = v == null ? null : log ? 10 ** v : v
    return { c, v: shown }
  })
  return (
    <svg width={width} height={total} style={{ display: 'block' }}
      onMouseMove={(e) => onMove(e, null)} onMouseLeave={onLeave}>
      <rect x={ML} y={MT} width={width - ML - MR} height={h - MT - 4} fill="#fff" stroke="#bdbdbd" />
      {yt.map((v) => (
        <g key={v}>
          <line x1={ML} x2={width - MR} y1={Y(v)} y2={Y(v)} stroke="#eee" />
          <text x={ML - 4} y={Y(v) + 3} fontSize={9} textAnchor="end" fill="#555">{log ? fmtVal(10 ** v) : fmtVal(v)}</text>
        </g>
      ))}
      {mode === 'residual' && lo < 0 && hi > 0 && <line x1={ML} x2={width - MR} y1={Y(0)} y2={Y(0)} stroke="#999" />}
      <clipPath id={clipId}><rect x={ML} y={MT} width={width - ML - MR} height={h - MT - 4} /></clipPath>
      <g clipPath={`url(#${clipId})`}>
        {series.map(({ c, s }) => {
          const style = KIND[c.kind] ?? KIND.avg
          const dash = c.measurement === 'attenuation' ? '5,3' : undefined
          const dw = c.downweight_factor != null && c.downweight_factor < 0.95
          const opacity = c.used === false ? 0.3 : dw ? 0.55 : 1
          return (
            <g key={c.label} opacity={opacity}>
              {s.obs && <path d={pathD(md, s.obs, X, Y, a, b)} fill="none" stroke={style.data} strokeWidth={1.1} strokeDasharray={dash} />}
              {s.pred && <path d={pathD(md, s.pred, X, Y, a, b)} fill="none" stroke={style.model} strokeWidth={2} strokeDasharray={dash} />}
              {s.residual && <path d={pathD(md, s.residual, X, Y, a, b)} fill="none" stroke={style.model} strokeWidth={1.5} strokeDasharray={dash} />}
            </g>
          )
        })}
      </g>
      <text x={ML + 4} y={MT + 11} fontSize={11} fontWeight={600} fill="#333">
        {group}{log ? ' (Ω·m)' : series[0] ? ` (${series[0].s.unit})` : ''}
      </text>
      {at && (
        <text x={width - MR - 4} y={MT + 11} fontSize={10} textAnchor="end" fill="#333">
          {at.map(({ c, v }) => `${KIND_SHORT[c.kind] ?? c.kind}${c.measurement === 'attenuation' ? ' att' : ''} ${fmtVal(v)}${c.downweight_factor < 0.95 ? ` (w×${c.downweight_factor})` : ''}`).join('  ')}
        </text>
      )}
      {cursor != null && cursor >= a && cursor <= b && (
        <line x1={X(cursor)} x2={X(cursor)} y1={MT} y2={h - 4} stroke="#d32f2f" strokeWidth={1} pointerEvents="none" />
      )}
      {last && <MdAxis X={X} a={a} b={b} y={h} width={width} />}
    </svg>
  )
}

function MdAxis({ X, a, b, y, width }) {
  const xt = ticks(a, b, Math.max(3, Math.floor((width - ML - MR) / 90)))
  return (
    <g>
      {xt.map((v) => (
        <g key={v}>
          <line x1={X(v)} x2={X(v)} y1={y} y2={y + 4} stroke="#555" />
          <text x={X(v)} y={y + 15} fontSize={10} textAnchor="middle" fill="#555">{v}</text>
        </g>
      ))}
      <text x={width - MR} y={y + 15} fontSize={10} textAnchor="start" dx={4} fill="#555">MD ft</text>
    </g>
  )
}

function ColorBar({ range, x, y, h }) {
  const gradId = useId()
  const [cmin, cmax] = range
  const la = Math.log10(cmin)
  const lb = Math.log10(cmax)
  const stops = Array.from({ length: 11 }, (_, i) => {
    const t = i / 10
    return { t, rgb: rhRgb(la + t * (lb - la), range) }
  })
  const Y = (v) => y + (1 - (v - la) / (lb - la)) * h
  return (
    <g>
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="1" y2="0">
          {stops.map((s) => <stop key={s.t} offset={s.t} stopColor={`rgb(${s.rgb.join(',')})`} />)}
        </linearGradient>
      </defs>
      <rect x={x} y={y} width={10} height={h} fill={`url(#${gradId})`} stroke="#999" />
      {RH_TICKS.filter((t) => t >= cmin && t <= cmax).map((t) => (
        <text key={t} x={x + 14} y={Y(Math.log10(t)) + 3} fontSize={9} fill="#555">{t}</text>
      ))}
      <text x={x} y={y - 2} fontSize={9} fill="#555">Rh Ω·m</text>
    </g>
  )
}

export default function SectionWorkbench({
  path, slices, tracks, lines = [], onLinesChange, halfWindowFt = 15, colorRange, onColorRangeChange, rerun,
  rerunLabel = 're-run range', canDraw = true,
}) {
  const outer = useRef(null)
  const sectionBox = useRef(null)
  const canvas = useRef(null)
  const width = useWidth(outer)
  const [view, setView] = useState('slices')
  const [fade, setFade] = useState(0)
  const [showBoundaries, setShowBoundaries] = useState(true)
  const [mode, setMode] = useState('pointer')
  const [trackMode, setTrackMode] = useState('values')
  const [sectionHeight, setSectionHeight] = useState(320)
  const [trackHeight, setTrackHeight] = useState(100)
  const [hiddenGroups, setHiddenGroups] = useState(null)
  const [zoom, setZoom] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [selected, setSelected] = useState(null)
  const [draft, setDraft] = useState(null)
  const [panning, setPanning] = useState(false)
  const drag = useRef(null)
  const clipId = useId()
  const h = Math.max(1, Number(halfWindowFt) || 15)
  const range = useMemo(() => clampRange(colorRange), [colorRange])

  const grid = useMemo(() => (slices?.length ? buildSection(path, slices, h) : null), [path, slices, h])
  const hd = useMemo(() => horizontalDisplacement(path), [path])
  const well = useMemo(() => {
    const x = []
    const y = []
    path.md_ft.forEach((m, i) => {
      if (m != null && path.tvd_ft[i] != null) {
        x.push(m)
        y.push(path.tvd_ft[i])
      }
    })
    return { x, y }
  }, [path])
  const full = useMemo(() => {
    let a = well.x[0] ?? 0
    let b = well.x.at(-1) ?? 1
    if (grid) {
      a = Math.min(a, grid.x0)
      b = Math.max(b, grid.x1)
    }
    return [a, b]
  }, [well, grid])
  const [a, b] = zoom ?? full
  const pw = Math.max(10, width - ML - MR)
  const X = useCallback((md) => ML + (md - a) / (b - a || 1) * pw, [a, b, pw])
  const mdAt = useCallback((px) => a + (px - ML) / pw * (b - a), [a, b, pw])

  const [ya, yb] = useMemo(() => {
    let mn = Infinity
    let mx = -Infinity
    for (let i = 0; i < well.x.length; i++) {
      if (well.x[i] < a - 5 || well.x[i] > b + 5) continue
      mn = Math.min(mn, well.y[i])
      mx = Math.max(mx, well.y[i])
    }
    for (const end of [a, b]) {
      const t = interpPairs(well, end)
      if (t != null) {
        mn = Math.min(mn, t)
        mx = Math.max(mx, t)
      }
    }
    if (!Number.isFinite(mn)) return [0, 1]
    return [mn - h, mx + h]
  }, [well, a, b, h])
  const SH = sectionHeight
  const ph = SH - MT - MB
  const Y = useCallback((tvd) => MT + (tvd - ya) / (yb - ya || 1) * ph, [ya, yb, ph])
  const tvdAt = useCallback((py) => ya + (py - MT) / ph * (yb - ya), [ya, yb, ph])

  // Heatmap pixels, with the fade slider thresholding the uncertainty rank of each cell.
  useEffect(() => {
    const el = canvas.current
    if (!el || width < 50) return
    el.width = pw
    el.height = ph
    const ctx = el.getContext('2d')
    ctx.clearRect(0, 0, pw, ph)
    if (!grid) return
    const img = ctx.createImageData(pw, ph)
    const values = view === 'mean' ? grid.mean : grid.own
    const rank = view === 'mean' ? grid.meanRank : grid.ownRank
    const cache = new Map()
    for (let px = 0; px < pw; px++) {
      const md = a + (px + 0.5) / pw * (b - a)
      const c = Math.floor((md - grid.x0) / grid.dx)
      if (c < 0 || c >= grid.nx) continue
      for (let py = 0; py < ph; py++) {
        const tvd = ya + (py + 0.5) / ph * (yb - ya)
        const r = Math.floor((tvd - grid.lo) / grid.dz)
        if (r < 0 || r >= grid.ny) continue
        const i = r * grid.nx + c
        const v = values[i]
        if (Number.isNaN(v)) continue
        const alpha = fadeAlpha(rank[i], fade)
        if (alpha <= 0) continue
        const key = Math.round(v * 200)
        let rgb = cache.get(key)
        if (!rgb) {
          rgb = rhRgb(key / 200, range)
          cache.set(key, rgb)
        }
        const o = 4 * (py * pw + px)
        img.data[o] = rgb[0]
        img.data[o + 1] = rgb[1]
        img.data[o + 2] = rgb[2]
        img.data[o + 3] = Math.round(255 * alpha)
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [grid, view, fade, range, a, b, ya, yb, pw, ph, width])

  // Wheel zoom around the pointer (a native listener: React's wheel handler is passive and cannot preventDefault).
  useEffect(() => {
    const el = outer.current
    if (!el) return undefined
    const onWheel = (e) => {
      if (!e.target.closest?.('svg[data-zoomable]')) return
      e.preventDefault()
      const rect = e.target.closest('svg').getBoundingClientRect()
      const md = a + (e.clientX - rect.left - ML) / pw * (b - a)
      const span = Math.min(full[1] - full[0], Math.max(MIN_SPAN_FT, (b - a) * Math.exp(e.deltaY * 0.0015)))
      const f = (md - a) / (b - a || 1)
      let na = md - f * span
      na = Math.max(full[0], Math.min(full[1] - span, na))
      setZoom(span >= full[1] - full[0] - 1e-6 ? null : [na, na + span])
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [a, b, pw, full])

  const updateLine = useCallback((id, patch) => onLinesChange?.(lines.map((l) => (l.id === id ? { ...l, ...patch } : l))),
    [lines, onLinesChange])
  const removeLine = useCallback((id) => {
    onLinesChange?.(lines.filter((l) => l.id !== id))
    setSelected(null)
  }, [lines, onLinesChange])

  const local = (e) => {
    const rect = sectionBox.current.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }
  const hit = (px, py) => {
    for (const l of [...lines].reverse()) {
      const x1 = X(l.md1_ft)
      const y1 = Y(l.tvd1_ft)
      const x2 = X(l.md2_ft)
      const y2 = Y(l.tvd2_ft)
      if (Math.hypot(px - x1, py - y1) < HIT_PX) return { id: l.id, part: 1 }
      if (Math.hypot(px - x2, py - y2) < HIT_PX) return { id: l.id, part: 2 }
      if (distToSegment(px, py, x1, y1, x2, y2) < HIT_PX / 1.5) return { id: l.id, part: 0 }
    }
    return null
  }

  const onDown = (e) => {
    if (e.button !== 0) return
    const [px, py] = local(e)
    const md = mdAt(px)
    const tvd = tvdAt(py)
    if (mode === 'draw' && canDraw) {
      setDraft({ md1_ft: md, tvd1_ft: tvd, md2_ft: md, tvd2_ft: tvd })
      drag.current = { kind: 'draw' }
      return
    }
    const target = canDraw ? hit(px, py) : null
    if (target) {
      setSelected(target.id)
      const line = lines.find((l) => l.id === target.id)
      drag.current = { kind: 'line', ...target, md, tvd, line }
      return
    }
    setSelected(null)
    setPanning(true)
    drag.current = { kind: 'pan', px, a, b }
  }

  const onMove = (e, inSection = true) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const md = mdAt(px)
    setCursor(md >= a && md <= b ? { md, tvd: inSection ? tvdAt(e.clientY - rect.top) : null } : null)
    const d = drag.current
    if (!d || !inSection) return
    const tvd = tvdAt(e.clientY - rect.top)
    if (d.kind === 'draw') {
      setDraft((dr) => (dr ? { ...dr, md2_ft: md, tvd2_ft: tvd } : dr))
    } else if (d.kind === 'line') {
      const dm = md - d.md
      const dz = tvd - d.tvd
      const l = d.line
      if (d.part === 1) updateLine(l.id, { md1_ft: l.md1_ft + dm, tvd1_ft: l.tvd1_ft + dz })
      else if (d.part === 2) updateLine(l.id, { md2_ft: l.md2_ft + dm, tvd2_ft: l.tvd2_ft + dz })
      else updateLine(l.id, { md1_ft: l.md1_ft + dm, tvd1_ft: l.tvd1_ft + dz, md2_ft: l.md2_ft + dm, tvd2_ft: l.tvd2_ft + dz })
    } else if (d.kind === 'pan') {
      const shift = (px - d.px) / pw * (d.b - d.a)
      const span = d.b - d.a
      if (span >= full[1] - full[0] - 1e-6) return
      const na = Math.max(full[0], Math.min(full[1] - span, d.a - shift))
      setZoom([na, na + span])
    }
  }

  const onUp = () => {
    const d = drag.current
    drag.current = null
    setPanning(false)
    if (d?.kind === 'draw' && draft) {
      if (Math.abs(draft.md2_ft - draft.md1_ft) >= 1) {
        const [p, q] = draft.md1_ft <= draft.md2_ft ? [1, 2] : [2, 1]
        const line = { id: newLineId(), md1_ft: draft[`md${p}_ft`], tvd1_ft: draft[`tvd${p}_ft`],
          md2_ft: draft[`md${q}_ft`], tvd2_ft: draft[`tvd${q}_ft`], anchor: true }
        onLinesChange?.([...lines, line])
        setSelected(line.id)
      }
      setDraft(null)
    }
  }

  const onKey = (e) => {
    if (selected && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      removeLine(selected)
    }
    if (e.key === 'Escape') {
      setDraft(null)
      drag.current = null
      setSelected(null)
    }
  }

  const boundaryPaths = useMemo(() => {
    if (!grid || !showBoundaries) return []
    const out = []
    for (const s of grid.prepared) {
      if (s.slice_max_ft < a || s.slice_min_ft > b) continue
      for (const bd of s.bnd) {
        const z1 = interpPairs(bd, s.slice_min_ft)
        const z2 = interpPairs(bd, s.slice_max_ft)
        if (z1 == null || z2 == null) continue
        out.push(`M${X(s.slice_min_ft).toFixed(1)},${Y(z1).toFixed(1)}L${X(s.slice_max_ft).toFixed(1)},${Y(z2).toFixed(1)}`)
      }
    }
    return out
  }, [grid, showBoundaries, a, b, X, Y])

  const groups = useMemo(() => {
    const g = {}
    for (const c of tracks?.curves ?? []) (g[c.group ?? c.label] ??= []).push(c)
    return g
  }, [tracks])
  const groupNames = Object.keys(groups)
  // Until the user picks, show only the tracks with a curve used in the fit.
  const hidden = hiddenGroups ?? groupNames.filter((g) => !groups[g].some((c) => c.used !== false))
  const shownGroups = groupNames.filter((g) => !hidden.includes(g))
  const cell = cursor?.tvd != null ? sectionCell(grid, cursor.md, cursor.tvd, view) : null
  const wellTvd = cursor ? interpPairs(well, cursor.md) : null
  const selLine = lines.find((l) => l.id === selected)
  const allLines = draft ? [...lines, { id: '__draft', ...draft, anchor: true }] : lines
  const constrained = grid ? grid.prepared.filter((s) => s.constraint) : []

  return (
    <Box ref={outer} tabIndex={0} onKeyDown={onKey} sx={{ outline: 'none', userSelect: 'none' }}>
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mb: 1 }}>
        {canDraw && (
          <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && setMode(v)}>
            <Tooltip title="Hover for the cursor, drag to pan, wheel to zoom MD, drag a line or its ends to edit it">
              <ToggleButton value="pointer">Pointer</ToggleButton>
            </Tooltip>
            <Tooltip title="Drag on the section to draw a bed boundary / dip line; it constrains the next inversion">
              <ToggleButton value="draw">Draw dip line</ToggleButton>
            </Tooltip>
          </ToggleButtonGroup>
        )}
        <ToggleButtonGroup size="small" exclusive value={view} onChange={(_, v) => v && setView(v)} disabled={!grid}>
          <Tooltip title="Each slice coloured by its own model"><ToggleButton value="slices">Slices</ToggleButton></Tooltip>
          <Tooltip title="Geometric mean over every slice whose data window covers the MD"><ToggleButton value="mean">Mean</ToggleButton></Tooltip>
        </ToggleButtonGroup>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: 220 }}>
          <Tooltip title="Fades the inversion: the most uncertain layers (posterior std of log Rh, plus disagreement between overlapping slices) disappear first">
            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>Fade uncertain</Typography>
          </Tooltip>
          <Slider size="small" value={Math.round(fade * 100)} min={0} max={100} disabled={!grid}
            onChange={(_, v) => setFade(v / 100)} valueLabelDisplay="auto" valueLabelFormat={(v) => `${v}%`}
            aria-label="Fade uncertain layers" />
        </Box>
        <FormControlLabel sx={{ mr: 0 }} label={<Typography variant="caption">Boundaries</Typography>}
          control={<Switch size="small" checked={showBoundaries} onChange={(e) => setShowBoundaries(e.target.checked)} />} />
        {onColorRangeChange && (
          <>
            <TextField size="small" type="number" label="Colour min Ω·m" sx={{ width: 120 }} value={colorRange[0]}
              slotProps={{ htmlInput: { min: 0.01, step: 'any' } }}
              onChange={(e) => onColorRangeChange([e.target.value, colorRange[1]])} />
            <TextField size="small" type="number" label="Colour max Ω·m" sx={{ width: 120 }} value={colorRange[1]}
              slotProps={{ htmlInput: { min: 0.01, step: 'any' } }}
              onChange={(e) => onColorRangeChange([colorRange[0], e.target.value])} />
          </>
        )}
        <FormControl size="small" sx={{ minWidth: 110 }}>
          <InputLabel id="wb-sh">Section</InputLabel>
          <Select labelId="wb-sh" label="Section" value={sectionHeight} onChange={(e) => setSectionHeight(e.target.value)}>
            {SECTION_HEIGHTS.map((v) => <MenuItem key={v} value={v}>{v}px</MenuItem>)}
          </Select>
        </FormControl>
        <Button size="small" onClick={() => setZoom(null)} disabled={!zoom}>Reset zoom</Button>
      </Box>

      <Box ref={sectionBox} sx={{ position: 'relative', height: SH, width: '100%' }}>
        <Box sx={{ position: 'absolute', left: ML, top: MT, width: pw, height: ph,
          backgroundImage: 'repeating-linear-gradient(45deg, #f5f5f5 0 6px, #ececec 6px 12px)' }} />
        <canvas ref={canvas} style={{ position: 'absolute', left: ML, top: MT, width: pw, height: ph, imageRendering: 'pixelated' }} />
        {width > 50 && (
          <svg data-zoomable width={width} height={SH} style={{ position: 'absolute', left: 0, top: 0,
            cursor: mode === 'draw' && canDraw ? 'crosshair' : panning ? 'grabbing' : 'default' }}
          onMouseDown={onDown} onMouseMove={(e) => onMove(e, true)} onMouseUp={onUp}
          onMouseLeave={() => { onUp(); setCursor(null) }} onDoubleClick={() => setZoom(null)}>
            <defs><clipPath id={clipId}><rect x={ML} y={MT} width={pw} height={ph} /></clipPath></defs>
            <rect x={ML} y={MT} width={pw} height={ph} fill="none" stroke="#9e9e9e" />
            {ticks(ya, yb, Math.max(3, Math.floor(ph / 45))).map((v) => (
              <g key={v}>
                <line x1={ML - 4} x2={ML} y1={Y(v)} y2={Y(v)} stroke="#555" />
                <text x={ML - 6} y={Y(v) + 3} fontSize={10} textAnchor="end" fill="#555">{v}</text>
              </g>
            ))}
            <text x={12} y={MT + ph / 2} fontSize={10} fill="#555" transform={`rotate(-90 12 ${MT + ph / 2})`} textAnchor="middle">TVD ft</text>
            <MdAxis X={X} a={a} b={b} y={MT + ph} width={width} />
            <ColorBar range={range} x={width - MR + 10} y={MT + 14} h={ph - 20} />
            <g clipPath={`url(#${clipId})`}>
              {rerun && (
                <g>
                  <rect x={X(rerun.md_min_ft)} y={MT} width={Math.max(0, X(rerun.md_max_ft) - X(rerun.md_min_ft))} height={ph}
                    fill="rgba(213,0,249,0.07)" stroke={SELECTED_COLOR} strokeDasharray="4,3" />
                  <text x={X(rerun.md_min_ft) + 4} y={MT + ph - 6} fontSize={10} fill={SELECTED_COLOR}>{rerunLabel}</text>
                </g>
              )}
              {constrained.map((s) => (
                <rect key={s.md_centre_ft} x={X(s.slice_min_ft)} y={MT} width={Math.max(1, X(s.slice_max_ft) - X(s.slice_min_ft))}
                  height={4} fill={SELECTED_COLOR} opacity={0.7}>
                  <title>{`constrained: line dip ${s.constraint.dip_deg}° · ${s.downweighted ? `down-weighted ${Object.keys(s.downweighted).join(', ')}` : 'no curve down-weighted'}`}</title>
                </rect>
              ))}
              {boundaryPaths.map((d, i) => <path key={i} d={d} stroke="#222" strokeWidth={1.1} fill="none" />)}
              {[-h, h].map((o) => (
                <path key={o} d={pathD(well.x, well.y.map((z) => z + o), X, Y, a, b)} stroke="#9e9e9e" strokeDasharray="4,4" fill="none" />
              ))}
              <path d={pathD(well.x, well.y, X, Y, a, b)} stroke="#000" strokeWidth={2.5} fill="none" />
              {allLines.map((l) => {
                const sel = l.id === selected || l.id === '__draft'
                const dip = apparentDip(l, path, hd)
                const x1 = X(l.md1_ft)
                const y1 = Y(l.tvd1_ft)
                const x2 = X(l.md2_ft)
                const y2 = Y(l.tvd2_ft)
                return (
                  <g key={l.id}>
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#fff" strokeWidth={5} opacity={0.7} />
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={sel ? SELECTED_COLOR : LINE_COLOR} strokeWidth={sel ? 3 : 2}
                      strokeDasharray={l.anchor ? undefined : '6,4'} />
                    {[[x1, y1], [x2, y2]].map(([x, y], i) => (
                      <circle key={i} cx={x} cy={y} r={4.5} fill="#fff" stroke={sel ? SELECTED_COLOR : LINE_COLOR} strokeWidth={1.5} />
                    ))}
                    {dip != null && (
                      <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 7} fontSize={11} fontWeight={600} textAnchor="middle"
                        fill={sel ? SELECTED_COLOR : LINE_COLOR} stroke="#fff" strokeWidth={3} paintOrder="stroke">
                        {`${dip >= 0 ? '+' : ''}${dip.toFixed(1)}°`}
                      </text>
                    )}
                  </g>
                )
              })}
              {cursor && (
                <line x1={X(cursor.md)} x2={X(cursor.md)} y1={MT} y2={MT + ph} stroke="#d32f2f" strokeWidth={1} pointerEvents="none" />
              )}
            </g>
          </svg>
        )}
        {cursor && (
          <Box sx={{ position: 'absolute', left: ML + 6, top: MT + 8, bgcolor: 'rgba(255,255,255,0.9)', px: 1, py: 0.5,
            borderRadius: 1, pointerEvents: 'none', fontSize: 12, lineHeight: 1.5, boxShadow: 1 }}>
            <div><b>MD {cursor.md.toFixed(1)} ft</b> · well TVD {fmtVal(wellTvd)} ft</div>
            {cursor.tvd != null && <div>cursor TVD {cursor.tvd.toFixed(1)} ft ({(cursor.tvd - (wellTvd ?? cursor.tvd)).toFixed(1)} ft from well)</div>}
            {cell && (
              <div>
                Rh {fmtVal(10 ** cell.logRh)} Ω·m · uncertainty ×{fmtVal(10 ** cell.unc)}
                {view === 'mean' && ` · ${cell.count} slices (±${Math.round(100 * (10 ** cell.spread - 1))}%)`}
              </div>
            )}
            {cell?.slice && (
              <div>
                slice dip {cell.slice.dip_deg}° · misfit/noise {cell.slice.misfit_normalised ?? '–'}
                {cell.slice.constraint && ` · line dip ${cell.slice.constraint.dip_deg}°`}
              </div>
            )}
          </Box>
        )}
      </Box>

      {groupNames.length > 0 && (
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mt: 1, mb: 0.5 }}>
          <FormControl size="small" sx={{ minWidth: 220, maxWidth: 420 }}>
            <InputLabel id="wb-groups">QC tracks</InputLabel>
            <Select labelId="wb-groups" label="QC tracks" multiple value={shownGroups}
              renderValue={(v) => `${v.length} of ${groupNames.length} tracks`}
              onChange={(e) => setHiddenGroups(groupNames.filter((g) => !e.target.value.includes(g)))}>
              {groupNames.map((g) => (
                <MenuItem key={g} value={g} dense>
                  <Checkbox size="small" checked={shownGroups.includes(g)} />
                  <ListItemText primary={g} secondary={groups[g].map((c) => c.kind).join(', ')} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <ToggleButtonGroup size="small" exclusive value={trackMode} onChange={(_, v) => v && setTrackMode(v)}>
            <ToggleButton value="values">Measured / model</ToggleButton>
            <ToggleButton value="residual" disabled={!tracks?.curves?.some((c) => c.pred)}>Residual</ToggleButton>
          </ToggleButtonGroup>
          <FormControl size="small" sx={{ minWidth: 100 }}>
            <InputLabel id="wb-th">Track</InputLabel>
            <Select labelId="wb-th" label="Track" value={trackHeight} onChange={(e) => setTrackHeight(e.target.value)}>
              {TRACK_HEIGHTS.map((v) => <MenuItem key={v} value={v}>{v}px</MenuItem>)}
            </Select>
          </FormControl>
          <Typography variant="caption" color="text.secondary">
            dark = measured, colour = model (average blue, top green, bottom purple, geosignal orange); dashed = attenuation;
            faded = down-weighted by the dip lines
          </Typography>
        </Box>
      )}
      {width > 50 && shownGroups.map((g, i) => (
        <Box key={g} sx={{ mt: `${TRACK_GAP}px` }}>
          <Track group={g} curves={groups[g]} md={tracks.md} width={width} height={trackHeight} X={X} a={a} b={b}
            mode={trackMode} cursor={cursor?.md ?? null} last={i === shownGroups.length - 1}
            onMove={(e) => onMove(e, false)} onLeave={() => setCursor(null)} />
        </Box>
      ))}

      {selLine && canDraw && (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1 }}>
          <Typography variant="caption">
            Selected line: MD {selLine.md1_ft.toFixed(0)}–{selLine.md2_ft.toFixed(0)} ft
          </Typography>
          <FormControlLabel sx={{ mr: 0 }} label={<Typography variant="caption">Anchor boundary</Typography>}
            control={<Switch size="small" checked={selLine.anchor}
              onChange={(e) => updateLine(selLine.id, { anchor: e.target.checked })} />} />
          <Button size="small" color="error" onClick={() => removeLine(selLine.id)}>Delete (Del)</Button>
        </Box>
      )}
    </Box>
  )
}
