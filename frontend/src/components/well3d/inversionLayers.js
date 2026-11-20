import { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { useApi } from '../../hooks/useApi.js'
import { DEFAULT_COLOR_RANGE, RH_STOPS, colorRange } from '../inversion/sectionModel.js'

// Inversion result in the 3D well view: the job's curtain section (per-slice layered models) draped along the well.
// Data comes from GET /inversion/jobs/{id}/layers (backend/inversion/layers.py), whose slices are the same per-slice
// fits the Inversion tab's curtain uses; the grid is built by the shared components/inversion/sectionModel.js.// Finished inversion jobs of the run (refreshed whenever the tab becomes active) and the picked job's geometry.
// The newest job is shown unless the user picked another one.
export function useInversionLayers(run, active) {
  const [list, setList] = useState({ run: null, jobs: [], error: null })
  useEffect(() => {
    if (!run || !active) return undefined
    let alive = true
    api(`/inversion/jobs?run=${encodeURIComponent(run)}`).then(
      (body) => alive && setList({ run, jobs: body.jobs, error: null }),
      (e) => alive && setList({ run, jobs: [], error: e.message }),
    )
    return () => {
      alive = false
    }
  }, [run, active])
  const jobs = list.run === run ? list.jobs : []
  const [pick, setPick] = useState({ run: null, id: null })
  const id = pick.run === run && jobs.some((j) => j.id === pick.id) ? pick.id : jobs[0]?.id ?? null
  const [show, setShow] = useState(true)
  // The inverted section draped along the well; fade hides the most uncertain cells first.
  const [curtain, setCurtain] = useState({ fade: 0, halfFt: 15, opacity: 0.85 })
  const geometry = useApi(() => api(`/inversion/jobs/${encodeURIComponent(id)}/layers`),
    id && show ? `inversion-layers|${id}` : null)
  return {
    jobs, id, show, setShow, curtain, setCurtain,
    setId: (value) => setPick({ run, id: value }),
    ready: list.run === run,
    layers: show ? geometry.data : null,
    loading: geometry.loading,
    error: list.run === run ? list.error ?? geometry.error?.message ?? null : null,
  }
}

// Curtain colours: the Inversion tab's Rh scale (RH_STOPS) over its default range, log10 Ω·m; spec for ColorBar.
export const CURTAIN_RANGE = colorRange(DEFAULT_COLOR_RANGE)
export const CURTAIN_COLOR_SPEC = {
  stops: RH_STOPS, log10: true, zmin: Math.log10(CURTAIN_RANGE[0]), zmax: Math.log10(CURTAIN_RANGE[1]),
}