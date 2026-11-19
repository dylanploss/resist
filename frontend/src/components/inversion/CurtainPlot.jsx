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

// Curtain section along the well: layers between dipping boundaries, filled by Rh, with the well path on top.
function CurtainPlot({ result }) {
  const { data, layout } = useMemo(() => {
    const md = result.md_ft
    const bounds = result.model.boundary_tvd_ft
    const all = [...result.tvd_ft, ...bounds.flat()].filter((v) => v != null)
    const lo = Math.min(...all) - 8
    const hi = Math.max(...all) + 8
    const layers = result.model.layers
    const traces = []
    layers.forEach((layer, i) => {
      const top = i === 0 ? md.map(() => lo) : bounds[i - 1]
      const bottom = i === layers.length - 1 ? md.map(() => hi) : bounds[i]
      traces.push({ type: 'scatter', mode: 'lines', x: md, y: top, line: { width: 0 }, hoverinfo: 'skip', showlegend: false })
      traces.push({
        type: 'scatter', mode: 'lines', x: md, y: bottom, fill: 'tonexty', fillcolor: colorFor(layer.rh),
        line: { width: 0 }, name: `Layer ${i + 1}: Rh ${layer.rh.toFixed(1)} / Rv ${layer.rv.toFixed(1)} Ω·m`,
        hovertemplate: `Layer ${i + 1}<br>Rh ${layer.rh.toFixed(2)} Ω·m<br>Rv ${layer.rv.toFixed(2)} Ω·m<extra></extra>`,
      })
    })
    bounds.forEach((b, i) => traces.push({
      type: 'scatter', mode: 'lines', x: md, y: b, name: `Boundary ${i + 1}`, showlegend: false,
      line: { color: '#333', width: 1, dash: 'dot' },
      hovertemplate: `Boundary ${i + 1} %{y:.1f} ft TVD<extra>%{x:.1f} ft MD</extra>`,
    }))
    traces.push({
      type: 'scatter', mode: 'lines', x: md, y: result.tvd_ft, name: 'Well path',
      line: { color: '#000', width: 2.5 },
      customdata: result.inclination_deg,
      hovertemplate: 'TVD %{y:.1f} ft<br>INC %{customdata:.1f}°<extra>%{x:.1f} ft MD</extra>',
    })
    return {
      data: traces,
      layout: {
        height: 360, margin: { l: 70, r: 10, t: 10, b: 40 }, uirevision: 'curtain',
        xaxis: { title: { text: 'MD (ft)' } },
        yaxis: { title: { text: 'TVD (ft)' }, range: [hi, lo] },
        legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 11 } },
      },
    }
  }, [result])

  return <PlotlyChart data={data} layout={layout} />
}

export default CurtainPlot
