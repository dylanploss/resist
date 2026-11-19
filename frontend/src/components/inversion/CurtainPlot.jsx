import { useMemo } from 'react'
import PlotlyChart from '../PlotlyChart.jsx'

// Low to high resistivity (log scale, 1 to 300 ohm-m).
const STOPS = [[0, [69, 117, 180]], [0.35, [145, 191, 219]], [0.55, [254, 224, 144]], [0.75, [252, 141, 89]], [1, [215, 48, 39]]]

function colorFor(rh) {
  const t = Math.min(1, Math.max(0, Math.log10(rh) / Math.log10(300)))
  const i = STOPS.findIndex(([s]) => s >= t)
  const [s1, c1] = STOPS[Math.max(0, i)]
  const [s0, c0] = STOPS[Math.max(0, i - 1)]
  const f = s1 === s0 ? 0 : (t - s0) / (s1 - s0)
  return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * f)).join(',')})`
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Curtain section along the well: layers between dipping boundaries, filled by Rh, shown only within
// +/- halfWindowFt of TVD around the well path.
function CurtainPlot({ result, halfWindowFt = 15, height = 360 }) {
  const { data, layout } = useMemo(() => {
    const md = result.md_ft
    const tvd = result.tvd_ft
    const h = Math.max(1, Number(halfWindowFt) || 15)
    const upper = tvd.map((z) => z - h)
    const lower = tvd.map((z) => z + h)
    const bounds = result.model.boundary_tvd_ft
    const layers = result.model.layers
    const traces = []
    layers.forEach((layer, i) => {
      const top = md.map((_, s) => clamp(i === 0 ? upper[s] : bounds[i - 1][s], upper[s], lower[s]))
      const bottom = md.map((_, s) => clamp(i === layers.length - 1 ? lower[s] : bounds[i][s], upper[s], lower[s]))
      traces.push({ type: 'scatter', mode: 'lines', x: md, y: top, line: { width: 0 }, hoverinfo: 'skip', showlegend: false })
      traces.push({
        type: 'scatter', mode: 'lines', x: md, y: bottom, fill: 'tonexty', fillcolor: colorFor(layer.rh),
        line: { width: 0 }, name: `Layer ${i + 1}: Rh ${layer.rh.toFixed(1)} / Rv ${layer.rv.toFixed(1)} Ω·m`,
        hovertemplate: `Layer ${i + 1}<br>Rh ${layer.rh.toFixed(2)} Ω·m<br>Rv ${layer.rv.toFixed(2)} Ω·m<extra></extra>`,
      })
    })
    bounds.forEach((b, i) => traces.push({
      type: 'scatter', mode: 'lines', x: md, showlegend: false, name: `Boundary ${i + 1}`,
      y: b.map((z, s) => (z != null && z >= upper[s] && z <= lower[s] ? z : null)),
      line: { color: '#333', width: 1.2, dash: 'dot' },
      hovertemplate: `Boundary ${i + 1} %{y:.1f} ft TVD<extra>%{x:.1f} ft MD</extra>`,
    }))
    for (const [edge, name] of [[upper, `well − ${h} ft`], [lower, `well + ${h} ft`]]) {
      traces.push({
        type: 'scatter', mode: 'lines', x: md, y: edge, name, showlegend: false, hoverinfo: 'skip',
        line: { color: '#9e9e9e', width: 1, dash: 'dash' },
      })
    }
    traces.push({
      type: 'scatter', mode: 'lines', x: md, y: tvd, name: 'Well path',
      line: { color: '#000', width: 2.5 },
      customdata: result.inclination_deg,
      hovertemplate: 'TVD %{y:.1f} ft<br>INC %{customdata:.1f}°<extra>%{x:.1f} ft MD</extra>',
    })
    const lo = Math.min(...upper) - 1
    const hi = Math.max(...lower) + 1
    return {
      data: traces,
      layout: {
        height, margin: { l: 70, r: 10, t: 10, b: 40 }, uirevision: 'curtain',
        xaxis: { title: { text: 'MD (ft)' } },
        yaxis: { title: { text: 'TVD (ft)' }, range: [hi, lo] },
        legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 11 } },
      },
    }
  }, [result, halfWindowFt, height])

  return <PlotlyChart data={data} layout={layout} />
}

export default CurtainPlot
