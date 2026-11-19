import { useMemo } from 'react'
import PlotlyChart from '../PlotlyChart.jsx'

function FacetDips({ result }) {
  const { data, layout } = useMemo(() => {
    const w = result.windows
    const md = w.map((x) => x.md_centre_ft)
    const traces = [
      { type: 'scatter', mode: 'lines+markers', name: 'along-well dip', x: md, y: w.map((x) => x.along_dip_deg),
        line: { color: '#1565c0' }, hovertemplate: 'along %{y:.2f}°<extra>%{x} ft</extra>' },
      { type: 'scatter', mode: 'lines+markers', name: 'cross-dip (+ deepens to the right)', x: md,
        y: w.map((x) => x.cross_dip_deg), line: { color: '#d84315' }, hovertemplate: 'cross %{y:.2f}°<extra>%{x} ft</extra>' },
      { type: 'bar', name: 'misfit / noise, 3D facets', x: md, y: w.map((x) => x.misfit_normalised), yaxis: 'y2',
        marker: { color: '#43a047' }, opacity: 0.6 },
    ]
    if (w.some((x) => x.misfit_normalised_1d5 != null)) {
      traces.push({ type: 'bar', name: 'misfit / noise, 1.5D (dip along well only)', x: md,
        y: w.map((x) => x.misfit_normalised_1d5), yaxis: 'y2', marker: { color: '#9e9e9e' }, opacity: 0.6 })
    }
    return {
      data: traces,
      layout: {
        height: 340, margin: { l: 60, r: 20, t: 10, b: 45 }, barmode: 'group',
        xaxis: { title: { text: 'Window centre MD (ft)' }, anchor: 'y2' },
        yaxis: { title: { text: 'Dip (°)' }, domain: [0.45, 1], zeroline: true },
        yaxis2: { title: { text: 'Misfit / σ' }, domain: [0, 0.35], rangemode: 'tozero' },
        legend: { orientation: 'h', y: 1.12 }, uirevision: 'dips',
      },
    }
  }, [result])
  return <PlotlyChart data={data} layout={layout} />
}

export default FacetDips
