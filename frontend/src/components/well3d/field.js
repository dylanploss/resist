import * as THREE from 'three'
import { buildPath } from './path.js'

// Tube radius as a fraction of the field's horizontal extent, so tubes stay visible at field scale.
const TUBE_FRACTION = 0.003

// Scene frame: X = east and Z = south (metres from the field centre), Y = up from the shallowest
// logged TVD times the vertical exaggeration, as in path.js.
export function buildField(field, exaggeration) {
  const { east_m: cx, north_m: cy } = field.centre
  let top = Infinity
  for (const r of field.runs) for (const t of r.tvd_m) if (t < top) top = t
  const box = new THREE.Box3()
  const wells = field.runs.map((r) => {
    const data = {
      md_ft: r.md_ft,
      x_m: r.east_m.map((e) => e - cx),
      y_m: r.north_m.map((n) => n - cy),
      z_m: r.tvd_m.map((t) => top - t),
      image: false,
      values: r.values ?? r.md_ft.map(() => null),
      color: field.color ?? { scale: 'Jet', reverse: false, log10: true, zmin: 0, zmax: 1 },
    }
    const path = buildPath(data, exaggeration)
    box.union(path.box)
    // Wells logged in more than one run get the MD range in their label.
    const shared = field.runs.filter((o) => o.well === r.well).length > 1
    const [md0, md1] = r.md_range_ft.map((v) => Math.round(v))
    return { run: r.run, label: shared ? `${r.well} ${md0}–${md1} ft` : r.well, data, path }
  })
  const size = box.getSize(new THREE.Vector3())
  const radius = Math.max(2, TUBE_FRACTION * Math.max(size.x, size.z))
  return { wells, box, radius }
}
