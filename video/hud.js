// 2D overlay drawn on top of the rendered 3D frame: captions, labels, read-outs and small plots.
import { H, W, clamp } from './common.js'
import { PALETTE, RHO_MAX, RHO_MIN, paletteRgb, rhoToT } from './earth.js'

const FONT = '"SF Pro Display", "Helvetica Neue", system-ui, Arial, sans-serif'
const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`

function wrap(ctx, text, maxWidth) {
  const lines = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

export function caption(ctx, title, sub, alpha) {
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  const shade = ctx.createLinearGradient(0, H - 330, 0, H)
  shade.addColorStop(0, 'rgba(2,5,10,0)')
  shade.addColorStop(1, 'rgba(2,5,10,0.82)')
  ctx.fillStyle = shade
  ctx.fillRect(0, H - 330, W, 330)
  ctx.textBaseline = 'alphabetic'
  ctx.font = font(30)
  const subLines = sub ? wrap(ctx, sub, 1350) : []
  const base = H - 84 - subLines.length * 42
  ctx.fillStyle = '#5fd0ff'
  ctx.fillRect(96, base - 44, 5, 52)
  ctx.fillStyle = '#ffffff'
  ctx.font = font(50, 600)
  ctx.fillText(title, 120, base)
  ctx.font = font(30)
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  subLines.forEach((line, i) => ctx.fillText(line, 120, base + 52 + i * 42))
  ctx.restore()
}

// Label with a leader line from an anchor pixel; dx, dy offset the text box from the anchor.
export function label(ctx, anchor, text, alpha, { dx = 0, dy = -70, size = 26, chip = null, sub = null, accent = null } = {}) {
  if (alpha <= 0 || !anchor) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = font(size, 500)
  const tw = ctx.measureText(text).width
  ctx.font = font(size - 5)
  const sw = sub ? ctx.measureText(sub).width : 0
  const pad = 14
  const chipW = chip ? size + 8 : 0
  const w = Math.max(tw, sw) + pad * 2 + chipW
  const h = (sub ? size * 2.25 : size * 1.25) + pad
  const [ax, ay] = anchor
  const bx = ax + dx - (dx < 0 ? w : dx === 0 ? w / 2 : 0)
  const by = ay + dy - (dy < 0 ? h : dy === 0 ? h / 2 : 0)
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(ax, ay)
  ctx.lineTo(clamp(ax, bx, bx + w), clamp(ay, by, by + h))
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(ax, ay, 4, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(6,12,22,0.82)'
  ctx.beginPath()
  ctx.roundRect(bx, by, w, h, 8)
  ctx.fill()
  ctx.strokeStyle = accent ?? 'rgba(255,255,255,0.22)'
  ctx.lineWidth = accent ? 2.5 : 1
  ctx.stroke()
  if (chip) {
    ctx.fillStyle = `rgb(${chip.join(',')})`
    ctx.beginPath()
    ctx.roundRect(bx + pad, by + pad * 0.6, size, h - pad * 1.2, 4)
    ctx.fill()
  }
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#ffffff'
  ctx.font = font(size, 500)
  ctx.fillText(text, bx + pad + chipW, by + pad * 0.5 + size)
  if (sub) {
    ctx.font = font(size - 5)
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.fillText(sub, bx + pad + chipW, by + pad * 0.5 + size * 2.05)
  }
  ctx.restore()
}

function panel(ctx, x, y, w, h, title) {
  ctx.fillStyle = 'rgba(6,12,22,0.78)'
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 12)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = font(24, 600)
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(title, x + 22, y + 40)
}

export function depthReadout(ctx, mdFt, tvdFt, alpha) {
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  const fmt = (v) => Math.round(v / 10) * 10
  const rows = [['MEASURED DEPTH', fmt(mdFt)], ['TRUE VERTICAL DEPTH', fmt(tvdFt)]]
  rows.forEach(([name, value], i) => {
    const y = 110 + i * 112
    ctx.font = font(20, 600)
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fillText(name, 96, y)
    ctx.font = font(58, 300)
    ctx.fillStyle = '#ffffff'
    const text = value.toLocaleString('en-US')
    ctx.fillText(text, 96, y + 60)
    const w = ctx.measureText(text).width
    ctx.font = font(26)
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fillText('ft', 96 + w + 12, y + 60)
  })
  ctx.restore()
}

export function colorBar(ctx, alpha) {
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  const x = W - 150
  const y0 = 470
  const h = 330
  ctx.fillStyle = 'rgba(6,12,22,0.78)'
  ctx.beginPath()
  ctx.roundRect(x - 34, y0 - 76, 150, h + 110, 12)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.stroke()
  const grad = ctx.createLinearGradient(0, y0 + h, 0, y0)
  for (const [p, c] of PALETTE) grad.addColorStop(p, `rgb(${c.join(',')})`)
  ctx.fillStyle = grad
  ctx.fillRect(x - 12, y0, 26, h)
  ctx.font = font(21, 600)
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'left'
  ctx.fillText('Resistivity', x - 14, y0 - 42)
  ctx.font = font(19)
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.fillText('Ω·m', x - 14, y0 - 17)
  ctx.font = font(21)
  for (const rho of [RHO_MIN, 3, 10, 30, 100, RHO_MAX]) {
    const y = y0 + h * (1 - rhoToT(rho))
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillRect(x + 14, y - 1, 8, 2)
    ctx.fillText(String(rho), x + 30, y + 7)
  }
  ctx.restore()
}

// Two receiver traces over the last few seconds: the far receiver is weaker (attenuation) and later (phase shift).
export function scope(ctx, alpha, phase, tau1, tau2, ratio) {
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  const x = W - 620
  const y = 70
  const w = 524
  const h = 290
  panel(ctx, x, y, w, h, 'Signals at the two receivers')
  const px = x + 26
  const pw = w - 52
  const mid = y + 158
  const ampPx = 62
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'
  ctx.beginPath()
  ctx.moveTo(px, mid)
  ctx.lineTo(px + pw, mid)
  ctx.stroke()
  const SPAN = 9 // radians of phase shown across the plot
  const trace = (tau, amp, color, width) => {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.beginPath()
    for (let i = 0; i <= 160; i++) {
      const ph = phase - SPAN + (SPAN * i) / 160 - tau
      const v = ph > 0 ? Math.min(1, ph / 2) * Math.cos(ph) * amp : 0
      const X = px + (pw * i) / 160
      const Y = mid - v * ampPx
      if (i === 0) ctx.moveTo(X, Y)
      else ctx.lineTo(X, Y)
    }
    ctx.stroke()
  }
  trace(tau1, 1, '#4fe0ff', 3.5)
  trace(tau2, ratio, '#ffb347', 3.5)
  ctx.font = font(21, 500)
  ctx.fillStyle = '#4fe0ff'
  ctx.fillText('near receiver', px, y + h - 22)
  ctx.fillStyle = '#ffb347'
  ctx.fillText('far receiver: weaker and later', px + 170, y + h - 22)
  ctx.restore()
}

// Simulated vs measured values of six measurements; the simulated bars close in on the measured ticks as fit -> 1.
export function fitPanel(ctx, alpha, fit, iteration, stations) {
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  const x = W - 620
  const y = 70
  const w = 524
  const h = 300
  panel(ctx, x, y, w, h, 'Simulated vs measured signals')
  ctx.font = font(18)
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.fillText('white lines: measured     blue bars: simulated from the model', x + 22, y + 68)
  const measured = [0.72, 0.48, 0.86, 0.35, 0.61, 0.78]
  const start = [0.3, 0.8, 0.42, 0.7, 0.25, 0.4]
  const bx = x + 32
  const bw = (w - 64) / measured.length
  const base = y + 232
  const span = 130
  measured.forEach((m, i) => {
    const v = start[i] + (m - start[i]) * fit
    const X = bx + i * bw + bw * 0.2
    ctx.fillStyle = 'rgba(95,208,255,0.85)'
    ctx.fillRect(X, base - v * span, bw * 0.6, v * span)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(X - 6, base - m * span - 2, bw * 0.6 + 12, 4)
  })
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'
  ctx.beginPath()
  ctx.moveTo(x + 26, base + 0.5)
  ctx.lineTo(x + w - 26, base + 0.5)
  ctx.stroke()
  const misfit = 1 + 11 * Math.pow(1 - fit, 1.6)
  ctx.font = font(21, 500)
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  const left = stations > 0 ? `Stations inverted: ${stations}` : `Iteration ${iteration}`
  ctx.fillText(left, x + 32, y + h - 20)
  ctx.textAlign = 'right'
  ctx.fillText(`misfit ${misfit.toFixed(1)}`, x + w - 32, y + h - 20)
  ctx.restore()
}

export function note(ctx, text, alpha) {
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha * 0.6
  ctx.font = font(20)
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'right'
  ctx.fillText(text, W - 96, H - 40)
  ctx.restore()
}

export function title(ctx, main, sub, alpha, dim = 0) {
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  if (dim > 0) {
    ctx.fillStyle = `rgba(2,5,10,${dim})`
    ctx.fillRect(0, 0, W, H)
  }
  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffffff'
  ctx.font = font(104, 600)
  ctx.fillText(main, W / 2, H / 2 - 6)
  ctx.font = font(36)
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.fillText(sub, W / 2, H / 2 + 62)
  ctx.restore()
}

export function fade(ctx, alpha) {
  if (alpha <= 0) return
  ctx.fillStyle = `rgba(0,0,0,${clamp(alpha)})`
  ctx.fillRect(0, 0, W, H)
}

export const chipFor = (rho) => paletteRgb(rhoToT(rho))

// The black box: a dark cover over a region of the frame (outline as pixel points) with a padlock that can open.
export function blackBox(ctx, outline, alpha, open, text) {
  if (alpha <= 0 || outline.some((p) => !p)) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.beginPath()
  outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
  ctx.fillStyle = 'rgba(7,10,16,0.97)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.lineWidth = 2
  ctx.stroke()
  const cx = outline.reduce((a, p) => a + p[0], 0) / outline.length
  const cy = outline.reduce((a, p) => a + p[1], 0) / outline.length - 26
  // Padlock: shackle (lifts and swings when open) and body.
  ctx.strokeStyle = '#e8edf5'
  ctx.lineWidth = 11
  ctx.lineCap = 'round'
  ctx.save()
  ctx.translate(cx + 27, cy - 22 - 16 * open)
  ctx.rotate(0.6 * open)
  ctx.beginPath()
  ctx.moveTo(-54, 0)
  ctx.lineTo(-54, -18)
  ctx.arc(-27, -18, 27, Math.PI, 0)
  ctx.lineTo(0, 0)
  ctx.stroke()
  ctx.restore()
  ctx.fillStyle = '#e8edf5'
  ctx.beginPath()
  ctx.roundRect(cx - 46, cy - 24, 92, 70, 10)
  ctx.fill()
  ctx.fillStyle = 'rgba(7,10,16,0.97)'
  ctx.beginPath()
  ctx.arc(cx, cy + 4, 9, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillRect(cx - 3.5, cy + 6, 7, 22)
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = font(26, 600)
  ctx.letterSpacing = '4px'
  ctx.fillText(text, cx, cy + 96)
  ctx.restore()
}

// Rows with a red cross (state 0) turning into a green tick (state 1).
export function checklist(ctx, x, y, items, alpha, state) {
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  items.forEach((text, i) => {
    const top = y + i * 74
    ctx.font = font(28, 500)
    const w = ctx.measureText(text).width + 104
    ctx.fillStyle = 'rgba(6,12,22,0.85)'
    ctx.beginPath()
    ctx.roundRect(x, top, w, 58, 29)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'
    ctx.lineWidth = 1
    ctx.stroke()
    const cx = x + 34
    const cy = top + 29
    ctx.lineWidth = 5
    ctx.lineCap = 'round'
    ctx.globalAlpha = alpha * (1 - state)
    ctx.strokeStyle = '#ff5a52'
    ctx.beginPath()
    ctx.moveTo(cx - 10, cy - 10); ctx.lineTo(cx + 10, cy + 10)
    ctx.moveTo(cx + 10, cy - 10); ctx.lineTo(cx - 10, cy + 10)
    ctx.stroke()
    ctx.globalAlpha = alpha * state
    ctx.strokeStyle = '#4fd97a'
    ctx.beginPath()
    ctx.moveTo(cx - 12, cy + 1); ctx.lineTo(cx - 3, cy + 10); ctx.lineTo(cx + 13, cy - 9)
    ctx.stroke()
    ctx.globalAlpha = alpha
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, x + 68, top + 39)
  })
  ctx.restore()
}
