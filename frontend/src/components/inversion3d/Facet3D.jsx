import { useMemo } from 'react'
import PlotlyChart from '../PlotlyChart.jsx'

const COLORS = ['#d84315', '#6a1b9a', '#00838f']

// One mesh per boundary: each window contributes a quad spanning its MD range and +/- the corridor across the well.
function Facet3D({ result }) {
  const { data, layout } = useMemo(() => {
    const path = result.path_e_n_tvd
    const traces = [{
      type: 'scatter3d', mode: 'lines', name: 'well', x: path.map((p) => p[0]), y: path.map((p) => p[1]),
      z: path.map((p) => p[2]), line: { color: '#212121', width: 6 },
      hovertemplate: 'E %{x:.1f} m<br>N %{y:.1f} m<br>TVD %{z:.1f} ft<extra>well</extra>',
    }]
    const meshes = {}
    result.windows.forEach((w) => w.boundaries.forEach((b) => {
      const m = meshes[b.index] ??= { x: [], y: [], z: [], i: [], j: [], k: [] }
      const base = m.x.length
      b.corners_e_n_tvd.forEach(([e, n, t]) => { m.x.push(e); m.y.push(n); m.z.push(t) })
      m.i.push(base, base); m.j.push(base + 1, base + 2); m.k.push(base + 2, base + 3)
    }))
    Object.entries(meshes).forEach(([idx, m]) => traces.push({
      type: 'mesh3d', name: `boundary ${Number(idx) + 1}`, showlegend: true, ...m, opacity: 0.55,
      color: COLORS[idx % COLORS.length], flatshading: true,
      hovertemplate: 'TVD %{z:.1f} ft<extra>boundary ' + (Number(idx) + 1) + '</extra>',
    }))
    return {
      data: traces,
      layout: {
        height: 480, margin: { l: 0, r: 0, t: 0, b: 0 }, legend: { orientation: 'h', y: 1 },
        scene: {
          xaxis: { title: { text: 'Easting (m)' } }, yaxis: { title: { text: 'Northing (m)' } },
          zaxis: { title: { text: 'TVD (ft)' }, autorange: 'reversed' },
          aspectmode: 'manual', aspectratio: { x: 1, y: 1, z: 0.5 },
        },
        uirevision: 'facets3d',
      },
    }
  }, [result])
  return <PlotlyChart data={data} layout={layout} />
}

export default Facet3D
