import { useEffect, useEffectEvent, useState } from 'react'

// Runs fetcher() whenever key changes (null key = idle). reload() repeats the request.
export function useApi(fetcher, key) {
  const [result, setResult] = useState({ key: null, data: null, error: null })
  const [nonce, setNonce] = useState(0)
  const fullKey = key === null || key === undefined ? null : `${key}#${nonce}`
  const load = useEffectEvent(() => fetcher())

  useEffect(() => {
    if (fullKey === null) return undefined
    let alive = true
    load().then(
      (data) => alive && setResult({ key: fullKey, data, error: null }),
      (error) => alive && setResult({ key: fullKey, data: null, error }),
    )
    return () => {
      alive = false
    }
  }, [fullKey])

  const current = result.key === fullKey
  return {
    loading: fullKey !== null && !current,
    data: current ? result.data : null,
    error: current ? result.error : null,
    reload: () => setNonce((n) => n + 1),
  }
}
