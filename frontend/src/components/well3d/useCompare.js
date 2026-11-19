import { useMemo, useState } from 'react'
import { api, runPath } from '../../api.js'
import { useApi } from '../../hooks/useApi.js'
import { doiRange, orderByDepth, sameSamples, scaleRadii, suggestCompare } from './compare.js'

// Second well3d response for "Compare with". Returns the curve to draw as the solid inner tube
// (`inner`) and, when comparing, the deeper one as a transparent shell (`outer`), with radii scaled by
// tubeScale. Without a comparison, inner is `primary` and outer is null. fallback is the fixed radius
// for curves without DOI.
export function useCompare({ run, shown, names, selected, scores, primary, maxPoints, tubeScale, fallback }) {
  const [pick, setPick] = useState({ run: null, curve: '' })
  const value = pick.run === run && pick.curve !== shown && names.includes(pick.curve) ? pick.curve : ''
  const setValue = (curve) => setPick({ run, curve })
  const suggestion = useMemo(() => suggestCompare(shown, selected, scores), [shown, selected, scores])

  const other = useApi(
    () => api(`${runPath(run)}/well3d?curve=${encodeURIComponent(value)}&max_points=${maxPoints}`),
    run && value ? `${run}|${value}|${maxPoints}` : null)
  const second = other.data && primary && sameSamples(primary, other.data) ? other.data : null
  const mismatch = Boolean(other.data && primary && !second)

  const layout = useMemo(() => {
    if (!primary) return null
    const { inner, outer } = second ? orderByDepth(primary, second) : { inner: primary, outer: null }
    const size = (d) => {
      const range = doiRange(d.doi_m)
      return { range, radii: scaleRadii(d.doi_m, tubeScale) ?? fallback * tubeScale,
        max: (range ? range.max : fallback) * tubeScale }
    }
    const a = size(inner)
    const b = outer ? size(outer) : null
    return {
      inner, innerRadii: a.radii, outer, shell: outer ? { data: outer, radii: b.radii } : null,
      radius: Math.max(a.max, b?.max ?? 0),
    }
  }, [primary, second, tubeScale, fallback])

  return { value, setValue, suggestion, loading: other.loading, error: other.error, mismatch, layout }
}
