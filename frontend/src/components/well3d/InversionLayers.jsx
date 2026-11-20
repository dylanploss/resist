import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { buildTube, frameAt, nearestIndex } from './path.js'
import { colorFn } from './colormap.js'
import {
  boundaryColor, boundaryPoint, layerColorSpec, nearestReading, rgbCss, seenRuns, sideOffset, slicePath,
} from './inversionLayers.js'
import { buildSection, fadeAlpha, sectionCell } from '../inversion/sectionModel.js'

const RIBBON_OPACITY = 0.45
const SEEN_COLOR = '#d500f9'
const GLOW_SCALE = 1.5
const FT = 0.3048
const CURTAIN_ROWS = 41
const UP = new THREE.Vector3(0, 1, 0)

function newFrame() {
  return { pos: new THREE.Vector3(), tan: new THREE.Vector3(), high: new THREE.Vector3() }
}

// One ribbon per boundary: at each station the boundary point, extended ±halfWidth sideways
// (perpendicular to the well, horizontal, then tilted into the dipping plane). Gaps (null TVD) break it.
function buildRibbon(layers, k, path, exaggeration, halfWidth) {
  const frame = newFrame()
  const centre = new THREE.Vector3()
  const side = new THREE.Vector3()
  const vertices = []
  const trace = []
  const index = []
  let previous = -1
  let lastCentre = null
  layers.md_ft.forEach((md, j) => {
    if (md < path.md[0] || md > path.md[path.n - 1]) {
      previous = -1
      lastCentre = null
      return
    }
    frameAt(path, md, frame)
    if (!boundaryPoint(layers, k, j, frame, exaggeration, centre)) {
      previous = -1
      lastCentre = null
      return
    }
    sideOffset(frame.tan, layers.normal_ned, exaggeration, side)
    const v = vertices.length / 3
    vertices.push(...centre.clone().addScaledVector(side, -halfWidth).toArray(),
      ...centre.clone().addScaledVector(side, halfWidth).toArray())
    if (previous >= 0) index.push(previous, previous + 1, v, previous + 1, v + 1, v)
    if (lastCentre) trace.push(...lastCentre, ...centre.toArray())
    previous = v
    lastCentre = centre.toArray()
  })
  const surface = new THREE.BufferGeometry()
  surface.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  surface.setIndex(index)
  const line = new THREE.BufferGeometry()
  line.setAttribute('position', new THREE.Float32BufferAttribute(trace, 3))
  return { surface, line }
}

function Boundary({ layers, k, path, exaggeration, halfWidth, color }) {
  const { surface, line } = useMemo(
    () => buildRibbon(layers, k, path, exaggeration, halfWidth), [layers, k, path, exaggeration, halfWidth])
  useEffect(() => () => {
    surface.dispose()
    line.dispose()
  }, [surface, line])
  return (
    <group>
      <mesh geometry={surface} renderOrder={2}>
        <meshBasicMaterial color={color} transparent opacity={RIBBON_OPACITY} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments geometry={line}>
        <lineBasicMaterial color={color} />
      </lineSegments>
    </group>
  )
}

// Glow (a wider back-faced tube) over the well sections whose DOI reaches the nearest boundary.
function SeenGlow({ layers, data, path, radius }) {
  const geometries = useMemo(
    () => seenRuns(layers, data, path).map(([a, b]) => buildTube(slicePath(path, a, b), radius * GLOW_SCALE)),
    [layers, data, path, radius])
  useEffect(() => () => geometries.forEach((g) => g.dispose()), [geometries])
  return geometries.map((g, i) => (
    <mesh key={i} geometry={g} renderOrder={1}>
      <meshBasicMaterial color={SEEN_COLOR} transparent opacity={0.35} side={THREE.BackSide} depthWrite={false} />
    </mesh>
  ))
}

// Vertical connector from the travel point to the nearest boundary.
function Connector({ layers, data, path, md, exaggeration }) {
  const { geometry, color } = useMemo(() => {
    const reading = nearestReading(layers, data, nearestIndex(path, md), md)
    if (!reading || reading.boundary == null) return { geometry: null }
    const frame = frameAt(path, md, newFrame())
    const end = boundaryPoint(layers, reading.boundary, reading.station, frame, exaggeration, new THREE.Vector3())
    if (!end) return { geometry: null }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([...frame.pos.toArray(), ...end.toArray()], 3))
    return { geometry: g, color: reading.seen ? SEEN_COLOR : '#607d8b' }
  }, [layers, data, path, md, exaggeration])
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry) return null
  return (
    <lineSegments geometry={geometry} renderOrder={3}>
      <lineBasicMaterial color={color} depthTest={false} />
    </lineSegments>
  )
}

// The inverted section as a vertical curtain through the well (the 2D curtain section draped along the 3D path):
// one vertex column per section column, ±halfFt of TVD around the well, coloured by each slice's own Rh. Fade hides
// the most uncertain cells first, as on the Inversion tab.
function buildCurtain(layers, path, exaggeration, spec, halfFt, fade) {
  const grid = buildSection(layers, layers.slices, halfFt, 120)
  if (!grid) return null
  const color = colorFn(spec)
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
      const [r, g, b] = color(10 ** cell.logRh)
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

function Curtain({ layers, path, exaggeration, spec, halfFt = 15, fade = 0, opacity = 0.85 }) {
  const geometry = useMemo(() => buildCurtain(layers, path, exaggeration, spec, halfFt, fade),
    [layers, path, exaggeration, spec, halfFt, fade])
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry) return null
  return (
    <mesh geometry={geometry} renderOrder={1}>
      <meshBasicMaterial vertexColors transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

// Inversion boundaries around the well, coloured by the resistivity of the layer below.
export default function InversionLayers({ layers, data, path, exaggeration, radius, md, curtain }) {
  const spec = useMemo(() => layerColorSpec(layers, data.color), [layers, data.color])
  return (
    <group>
      {layers.boundaries.map((b) => (
        <Boundary key={b.index} layers={layers} k={b.index} path={path} exaggeration={exaggeration}
          halfWidth={2 * radius} color={rgbCss(boundaryColor(spec, b))} />
      ))}
      {curtain?.show && layers.slices?.length > 0 && (
        <Curtain layers={layers} path={path} exaggeration={exaggeration} spec={spec} halfFt={curtain.halfFt}
          fade={curtain.fade} opacity={curtain.opacity} />
      )}
      {data.doi_m && <SeenGlow layers={layers} data={data} path={path} radius={radius} />}
      <Connector layers={layers} data={data} path={path} md={md} exaggeration={exaggeration} />
    </group>
  )
}
