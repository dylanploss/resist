import { useMemo } from 'react'
import PlotlyChart from '../PlotlyChart.jsx'

const MODEL = { phase: '#2a78d6', attenuation: '#e8710a' }
const channelOf = (label) => label.slice(0, -1)

// One log track per spacing/frequency channel with any used curve: measured (black) vs modelled (colour).
function InversionTracks({ result, showAll }) {
  const { data, layout } = useMemo(() => {
    const byChannel = {}
    for (const c of result.curves) (byChannel[channelOf(c.label)] ??= []).push(c)
    const channels = Object.keys(byChannel).filter((ch) => showAll || byChannel[ch].some((c) => c.used))
    const n = Math.max(1, channels.length)
    const gap = 0.012
    const width = (1 - gap * (n - 1)) / n
    const traces = []
    const axes = {}
    channels.forEach((ch, i) => {
      const axis = i === 0 ? 'x' : `x${i + 1}`
      axes[i === 0 ? 'xaxis' : `xaxis${i + 1}`] = {
        domain: [i * (width + gap), i * (width + gap) + width], type: 'log', title: { text: ch, font: { size: 12 } },
        side: 'top', tickfont: { size: 9 }, showgrid: true,
      }
      for (const c of byChannel[ch]) {
        const dash = c.measurement === 'phase' ? 'solid' : 'dash'
        const opacity = c.used ? 1 : 0.3
        const tag = `${c.label}${c.used ? ` w=${c.weight}` : ' (not used)'}`
        traces.push({
          type: 'scatter', mode: 'lines', xaxis: axis, yaxis: 'y', x: c.obs, y: result.md_ft, opacity,
          name: `${c.label} measured`, showlegend: false,
          line: { color: '#222', width: c.used ? 1.3 : 0.8, dash },
          hovertemplate: `${tag} measured %{x:.3g} Ω·m<extra>%{y:.1f} ft</extra>`,
        })
        traces.push({
          type: 'scatter', mode: 'lines', xaxis: axis, yaxis: 'y', x: c.pred, y: result.md_ft, opacity,
          name: `${c.label} model`, showlegend: false,
          line: { color: MODEL[c.measurement], width: c.used ? 2 : 1, dash },
          hovertemplate: `${tag} model${c.correction_applied ? ' (corrected)' : ''} %{x:.3g} Ω·m<extra>%{y:.1f} ft</extra>`,
        })
      }
    })
    const legend = [
      ['measured phase', '#222', 'solid'], ['measured attenuation', '#222', 'dash'],
      ['model phase', MODEL.phase, 'solid'], ['model attenuation', MODEL.attenuation, 'dash'],
    ].map(([name, color, dash]) => ({
      type: 'scatter', mode: 'lines', x: [null], y: [null], name, line: { color, dash, width: 2 }, hoverinfo: 'skip',
    }))
    return {
      data: [...traces, ...legend],
      layout: {
        height: 620, margin: { l: 60, r: 10, t: 60, b: 30 }, ...axes, uirevision: 'tracks',
        yaxis: { title: { text: 'MD (ft)' }, autorange: 'reversed' },
        legend: { orientation: 'h', x: 0, y: -0.02, yanchor: 'top', font: { size: 11 } },
      },
    }
  }, [result, showAll])

  return <PlotlyChart data={data} layout={layout} />
}

export default InversionTracks
