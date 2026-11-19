import { useMemo } from 'react'
import PlotlyChart from '../PlotlyChart.jsx'

const TRACK = 120
const GAP = 28

function contrast(a, b) {
  return a.map((v, i) => (v > 0 && b[i] > 0 ? Math.log10(v / b[i]) : null))
}

// Per image: log10(bottom/top) and log10(right/left), measured vs modelled; geosignals: top and right sectors.
function rows(result) {
  const byLabel = Object.fromEntries(result.curves.map((c) => [c.label, c]))
  const out = []
  const images = [...new Set(result.curves.filter((c) => c.side && c.unit === 'ohm.m').map((c) => c.label.slice(0, -1)))]
  images.forEach((img) => {
    const [t, r, b, l] = ['T', 'R', 'B', 'L'].map((s) => byLabel[img + s])
    if (t && b) out.push({ name: `${img} bottom/top`, unit: 'log₁₀', obs: contrast(b.obs, t.obs), pred: contrast(b.pred, t.pred) })
    if (r && l) out.push({ name: `${img} right/left`, unit: 'log₁₀', obs: contrast(r.obs, l.obs), pred: contrast(r.pred, l.pred), lateral: true })
  })
  result.curves.filter((c) => c.kind === 'geosignal').forEach((c) => out.push({
    name: `${c.curve} ${c.side === 'R' ? 'right' : 'top'}`, unit: c.unit, obs: c.obs, pred: c.pred, lateral: c.side === 'R',
  }))
  return out
}

function LateralTracks({ result }) {
  const { data, layout } = useMemo(() => {
    const tracks = rows(result)
    const total = tracks.length * TRACK + Math.max(0, tracks.length - 1) * GAP
    const lay = { height: total + 60, margin: { l: 120, r: 20, t: 10, b: 45 }, showlegend: false, uirevision: 'lateral',
      xaxis: { title: { text: 'MD (ft)' }, anchor: tracks.length > 1 ? `y${tracks.length}` : 'y' } }
    const traces = []
    tracks.forEach((t, i) => {
      const top = i * (TRACK + GAP)
      const ref = i === 0 ? 'y' : `y${i + 1}`
      lay[i === 0 ? 'yaxis' : `yaxis${i + 1}`] = {
        domain: [1 - (top + TRACK) / total, 1 - top / total], zeroline: true,
        title: { text: `${t.name}<br>${t.unit}`, font: { size: 10, color: t.lateral ? '#d84315' : '#424242' } },
      }
      traces.push({ type: 'scatter', mode: 'lines', x: result.md_ft, y: t.obs, yaxis: ref, line: { color: '#616161', width: 1 },
        hovertemplate: `${t.name} measured %{y:.3f}<extra>%{x:.0f} ft</extra>` })
      traces.push({ type: 'scatter', mode: 'lines', x: result.md_ft, y: t.pred, yaxis: ref,
        line: { color: t.lateral ? '#d84315' : '#1565c0', width: 2 },
        hovertemplate: `${t.name} model %{y:.3f}<extra>%{x:.0f} ft</extra>` })
    })
    return { data: traces, layout: lay }
  }, [result])
  return <PlotlyChart data={data} layout={layout} />
}

export default LateralTracks
