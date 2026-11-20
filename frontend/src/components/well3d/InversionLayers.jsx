import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { frameAt } from './path.js'
import { buildSection, fadeAlpha, rhRgb, sectionCell } from '../inversion/sectionModel.js'
import { CURTAIN_RANGE } from './inversionLayers.js'

const FT = 0.3048
const CURTAIN_ROWS = 41
const UP = new THREE.Vector3(0, 1, 0)

// The inverted section as a vertical curtain through the well (the Inversion tab's curtain section draped along the
// 3D path): one vertex column per section column, ±halfFt of TVD around the well, coloured by each slice's own Rh with
// the Inversion tab's colour scale. Fade hides the most uncertain cells first, as on the Inversion tab.
function buildCurtain(layers, path, exaggeration, halfFt, fade) {
  const grid = buildSection(layers, layers.slices, halfFt, 120)
  if (!grid) return null
  const tmp = new THREE.Color()
  const frame = { pos: new THREE.Vector3(), tan: new THREE.Vector3(), high: new THREE.Vector3() }
  const positions = []
  const colors = []
  const index = []
  let prevBase = -1
  for (let c = 0; c < grid.nx; c++) {
    const md = grid.x0 + (c + 0.5) * grid.dx
    const well = grid.wellAt[c]
    if (md < path.md[0] || md > path.md[path.n - 1] || well == null || Number.isNaN(well)) {
      prevBase = -1
      continue
    }
    frameAt(path, md, frame)
    const base = positions.length / 3
    for (let j = 0; j < CURTAIN_ROWS; j++) {
      const offset = -halfFt + (2 * halfFt * j) / (CURTAIN_ROWS - 1)
      const p = frame.pos.clone().addScaledVector(UP, -offset * FT * exaggeration)
      positions.push(p.x, p.y, p.z)
      const cell = sectionCell(grid, md, well + offset, 'slices')
      if (!cell) {
        colors.push(0, 0, 0, 0)
        continue
      }
      const [r, g, b] = rhRgb(cell.logRh, CURTAIN_RANGE)
      // Vertex colours are linear in three.js; the colour scale is sRGB like the tube textures.
      tmp.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace)
      colors.push(tmp.r, tmp.g, tmp.b, fadeAlpha(cell.rank, fade))
    }
    if (prevBase >= 0) {
      for (let j = 0; j < CURTAIN_ROWS - 1; j++) {
        const a0 = prevBase + j
        const b0 = base + j
        index.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1)
      }
    }
    prevBase = base
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  geometry.setIndex(index)
  return geometry
}

// With inversion layers on, the 3D view shows only the inversion result: the curtain section along the well.
export default function InversionLayers({ layers, path, exaggeration, curtain }) {
  const { halfFt = 15, fade = 0, opacity = 0.85 } = curtain ?? {}
  const geometry = useMemo(() => (layers.slices?.length ? buildCurtain(layers, path, exaggeration, halfFt, fade) : null),
    [layers, path, exaggeration, halfFt, fade])
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry) return null
  return (
    <mesh geometry={geometry} renderOrder={1} name="inversion-curtain">
      <meshBasicMaterial vertexColors transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}
