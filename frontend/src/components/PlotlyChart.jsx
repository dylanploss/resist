import { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist-min'

function PlotlyChart({ data, layout, events }) {
  const ref = useRef(null)
  const handlers = useRef({})

  useEffect(() => {
    handlers.current = events ?? {}
  }, [events])

  useEffect(() => {
    const element = ref.current
    Plotly.react(element, data, layout, { responsive: true, displaylogo: false }).then(() => {
      for (const name of ['plotly_click', 'plotly_relayout', 'plotly_selected']) {
        element.removeAllListeners?.(name)
        element.on(name, (event) => handlers.current[name]?.(event))
      }
    })
  }, [data, layout])

  useEffect(() => {
    const element = ref.current
    return () => Plotly.purge(element)
  }, [])

  return <div ref={ref} style={{ width: '100%' }} />
}

export default PlotlyChart
