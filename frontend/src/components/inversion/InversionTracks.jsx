import { useMemo } from 'react'
import PlotlyChart from '../PlotlyChart.jsx'

// Model colour per bin kind; measured data uses a darker shade of the same hue.
const KIND = {
  avg: { model: '#2a78d6', data: '#222222', label: 'average' },
  top: { model: '#2e9e4f', data: '#1b5e20', label: 'top bin' },
  bottom: { model: '#a142f4', data: '#4a148c', label: 'bottom bin' },
  geosignal: { model: '#e8710a', data: '#5d4037', label: 'geosignal top' },
}

// One track per spacing/frequency (average + top/bottom bins on a log axis) and one per geosignal (linear axis).
function InversionTracks({ result, showAll }) {
  const { data, layout } = useMemo(() => {
    const groups = {}
    for (const c of result.curves) (groups[c.group] ??= []).push(c)
    const names = Object.keys(groups).filter((g) => showAll || groups[g].some((c) => c.used))
    const n = Math.max(1, names.length)
    const gap = 0.015
    const width = (1 - gap * (n - 1)) / n
    const traces = []
    const axes = {}
    const kinds = new Set()
    names.forEach((g, i) => {
      const axis = i === 0 ? 'x' : `x${i + 1}`
      const curves = groups[g]
      const unit = curves[0].unit
      axes[i === 0 ? 'xaxis' : `xaxis${i + 1}`] = {
        domain: [i * (width + gap), i * (width + gap) + width], type: unit === 'ohm.m' ? 'log' : 'linear',
        title: { text: unit === 'ohm.m' ? g : `${g} (${unit})`, font: { size: 11 } },
        side: 'top', tickfont: { size: 9 }, showgrid: true, zeroline: unit !== 'ohm.m',
      }
      for (const c of curves) {
        kinds.add(c.kind)
        const style = KIND[c.kind]
        const dash = c.measurement === 'phase' ? 'solid' : 'dash'
        const opacity = c.used ? 1 : 0.3
        const tag = `${c.label}${c.used ? ` w=${c.weight}` : ' (not used)'}`
        const fmt = c.unit === 'ohm.m' ? '%{x:.3g} Ω·m' : `%{x:.2f} ${c.unit}`
        traces.push({
          type: 'scatter', mode: 'lines', xaxis: axis, yaxis: 'y', x: c.obs, y: result.md_ft, opacity, showlegend: false,
          line: { color: style.data, width: c.used ? 1.2 : 0.8, dash },
          hovertemplate: `${tag} measured ${fmt}<extra>%{y:.1f} ft</extra>`,
        })
        traces.push({
          type: 'scatter', mode: 'lines', xaxis: axis, yaxis: 'y', x: c.pred, y: result.md_ft, opacity, showlegend: false,
          line: { color: style.model, width: c.used ? 2.2 : 1, dash },
          hovertemplate: `${tag} model${c.correction_applied ? ' (corrected)' : ''} ${fmt}<extra>%{y:.1f} ft</extra>`,
        })
      }
    })
    const legend = [...kinds].flatMap((k) => [
      { name: `${KIND[k].label} measured`, color: KIND[k].data },
      { name: `${KIND[k].label} model`, color: KIND[k].model },
    ]).concat([{ name: 'phase', color: '#888', dash: 'solid' }, { name: 'attenuation', color: '#888', dash: 'dash' }])
      .map(({ name, color, dash }) => ({
        type: 'scatter', mode: 'lines', x: [null], y: [null], name, hoverinfo: 'skip',
        line: { color, dash: dash ?? 'solid', width: 2 },
      }))
    return {
      data: [...traces, ...legend],
      layout: {
        height: 640, margin: { l: 60, r: 10, t: 60, b: 30 }, ...axes, uirevision: 'tracks',
        yaxis: { title: { text: 'MD (ft)' }, autorange: 'reversed' },
        legend: { orientation: 'h', x: 0, y: -0.02, yanchor: 'top', font: { size: 11 } },
      },
    }
  }, [result, showAll])

  return <PlotlyChart data={data} layout={layout} />
}

export default InversionTracks
