import { useMemo } from 'react'
import PlotlyChart from '../PlotlyChart.jsx'

const COLORS = ['#d84315', '#6a1b9a', '#00838f']

// Boundary TVD along a window follows its along-well dip; the band shows the TVD spread across the +/- corridor.
function FacetSection({ result }) {
  const { data, layout } = useMemo(() => {
    const traces = [{
      type: 'scatter', mode: 'lines', name: 'well', x: result.md_ft, y: result.tvd_ft,
      line: { color: '#212121', width: 2 }, hovertemplate: 'well %{y:.1f} ft TVD<extra>%{x:.0f} ft MD</extra>',
    }]
    const shown = new Set()
    result.windows.forEach((w) => {
      const slope = Math.tan((w.along_dip_deg * Math.PI) / 180)
      w.boundaries.forEach((b) => {
        const color = COLORS[b.index % COLORS.length]
        const xs = [w.md_min_ft, w.md_max_ft]
        const mid = xs.map((md) => b.tvd_at_well_ft + slope * (md - w.md_centre_ft))
        const right = mid.map((z) => z - b.rise_to_right_ft)
        const left = mid.map((z) => z + b.rise_to_right_ft)
        const name = `boundary ${b.index + 1}`
        traces.push({
          type: 'scatter', mode: 'lines', x: [...xs, ...xs.slice().reverse()], y: [...left, ...right.slice().reverse()],
          fill: 'toself', fillcolor: `${color}22`, line: { width: 0 }, hoverinfo: 'skip', showlegend: false,
        })
        traces.push({
          type: 'scatter', mode: 'lines', x: xs, y: mid, name, legendgroup: name, showlegend: !shown.has(name),
          line: { color, width: 2 },
          hovertemplate: `${name}: %{y:.1f} ft TVD<br>${b.distance_from_well_ft > 0 ? 'below' : 'above'} well by `
            + `${Math.abs(b.distance_from_well_ft).toFixed(1)} ft<br>rises ${b.rise_to_right_ft.toFixed(1)} ft over `
            + `${result.corridor_m} m to the right<br>cross-dip ${w.cross_dip_deg}°<extra>window ${w.md_centre_ft} ft</extra>`,
        })
        shown.add(name)
      })
    })
    return {
      data: traces,
      layout: {
        height: 360, margin: { l: 70, r: 20, t: 10, b: 45 },
        xaxis: { title: { text: 'MD (ft)' } }, yaxis: { title: { text: 'TVD (ft)' }, autorange: 'reversed' },
        legend: { orientation: 'h', y: 1.08 }, uirevision: 'section',
      },
    }
  }, [result])
  return <PlotlyChart data={data} layout={layout} />
}

export default FacetSection
