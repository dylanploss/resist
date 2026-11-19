import { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist-min'

function PlotlyChart({ data, layout, onClick, onRelayout }) {
  const ref = useRef(null)
  const handlers = useRef({})

  useEffect(() => {
    handlers.current = { onClick, onRelayout }
  }, [onClick, onRelayout])

  useEffect(() => {
    const element = ref.current
    Plotly.react(element, data, layout, { responsive: true, displaylogo: false }).then(() => {
      element.removeAllListeners?.('plotly_click')
      element.removeAllListeners?.('plotly_relayout')
      element.on('plotly_click', (event) => handlers.current.onClick?.(event))
      element.on('plotly_relayout', (event) => handlers.current.onRelayout?.(event))
    })
  }, [data, layout])

  useEffect(() => {
    const element = ref.current
    return () => Plotly.purge(element)
  }, [])

  return <div ref={ref} style={{ width: '100%' }} />
}

export default PlotlyChart
