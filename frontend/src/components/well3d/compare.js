// Helpers for drawing a second curve as a transparent shell around the first (Compare with).

const OPPOSITE = { shallow: ['deep', 'medium'], medium: ['deep', 'shallow'], deep: ['shallow', 'medium'] }

// Min and max of doi_m (per-sample numbers or per-bin rows); null without DOI.
export function doiRange(doiM) {
  if (!doiM) return null
  let min = Infinity
  let max = -Infinity
  for (const r of doiM.flat()) {
    if (r < min) min = r
    if (r > max) max = r
  }
  return { min, max }
}

// Tube radii from doi_m times the tube scale, in the shapes buildTube accepts.
export const scaleRadii = (doiM, scale) => (doiM
  ? doiM.map((r) => (Array.isArray(r) ? r.map((b) => b * scale) : r * scale))
  : null)

// QC auto-pick with the opposite DOI tier of `curve` (shallow <-> deep; medium -> deep, else shallow).
export function suggestCompare(curve, selected, scores) {
  const tier = scores?.[curve]?.doi_tier
  for (const want of OPPOSITE[tier] ?? []) {
    const hit = selected.find((n) => n !== curve && scores?.[n]?.doi_tier === want)
    if (hit) return hit
  }
  return null
}

const median = (doiM) => {
  const v = doiM.flat().filter(Number.isFinite).sort((a, b) => a - b)
  return v.length ? v[v.length >> 1] : 0
}

// Shallower curve is the solid inner tube, deeper is the shell: QC DOI index, then median doi_m.
export function orderByDepth(a, b) {
  const depth = (d) => [d.doi_index ?? 0, d.doi_m ? median(d.doi_m) : 0]
  const [ia, ma] = depth(a)
  const [ib, mb] = depth(b)
  const aDeeper = ia !== ib ? ia > ib : ma > mb
  return aDeeper ? { inner: b, outer: a } : { inner: a, outer: b }
}

// Both responses come from the same path with the same max_points, so samples line up; guard anyway.
export const sameSamples = (a, b) => a.md_ft.length === b.md_ft.length
  && a.md_ft[0] === b.md_ft[0] && a.md_ft.at(-1) === b.md_ft.at(-1)
