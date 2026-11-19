import * as THREE from 'three'
import { colorFn } from './colormap.js'

// Scene axes: three X = east, Y = up (z_m x exaggeration), Z = south (so north is -Z).
const UP = new THREE.Vector3(0, 1, 0)
const NORTH = new THREE.Vector3(0, 0, -1)

// Positions, tangents and high-side / right-side frames per sample. The high side is world up
// projected off the tangent; on vertical sections, where that is undefined, north is used instead.
export function buildPath(data, exaggeration) {
  const n = data.md_ft.length
  const pos = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    pos[3 * i] = data.x_m[i]
    pos[3 * i + 1] = data.z_m[i] * exaggeration
    pos[3 * i + 2] = -data.y_m[i]
  }
  const tan = new Float32Array(3 * n)
  const high = new Float32Array(3 * n)
  const right = new Float32Array(3 * n)
  const t = new THREE.Vector3()
  const h = new THREE.Vector3()
  const r = new THREE.Vector3()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const last = new THREE.Vector3(0, -1, 0)
  for (let i = 0; i < n; i++) {
    a.fromArray(pos, 3 * Math.max(0, i - 1))
    b.fromArray(pos, 3 * Math.min(n - 1, i + 1))
    t.subVectors(b, a)
    if (t.lengthSq() < 1e-12) t.copy(last)
    t.normalize()
    last.copy(t)
    h.copy(UP).addScaledVector(t, -UP.dot(t))
    if (h.lengthSq() < 1e-6) h.copy(NORTH).addScaledVector(t, -NORTH.dot(t))
    h.normalize()
    r.crossVectors(t, h).normalize()
    t.toArray(tan, 3 * i)
    h.toArray(high, 3 * i)
    r.toArray(right, 3 * i)
  }
  const box = new THREE.Box3().setFromArray(pos)
  return { n, md: data.md_ft, pos, tan, high, right, box }
}

// Fractional sample index for a measured depth (md_ft is ascending).
export function locate(path, md) {
  const { md: mds, n } = path
  if (n < 2 || md <= mds[0]) return { i: 0, f: 0 }
  if (md >= mds[n - 1]) return { i: n - 2, f: 1 }
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (mds[mid] <= md) lo = mid
    else hi = mid
  }
  return { i: lo, f: (md - mds[lo]) / (mds[hi] - mds[lo] || 1) }
}

function lerpInto(out, arr, i, f) {
  const j = Math.min(i + 1, arr.length / 3 - 1)
  return out.set(
    arr[3 * i] + (arr[3 * j] - arr[3 * i]) * f,
    arr[3 * i + 1] + (arr[3 * j + 1] - arr[3 * i + 1]) * f,
    arr[3 * i + 2] + (arr[3 * j + 2] - arr[3 * i + 2]) * f,
  )
}

export function frameAt(path, md, out) {
  const { i, f } = locate(path, md)
  lerpInto(out.pos, path.pos, i, f)
  lerpInto(out.tan, path.tan, i, f).normalize()
  lerpInto(out.high, path.high, i, f).normalize()
  return out
}

export const nearestIndex = (path, md) => {
  const { i, f } = locate(path, md)
  return Math.min(path.n - 1, f < 0.5 ? i : i + 1)
}

// Tube with one ring per sample. u runs clockwise from the high side looking down-hole (0..1),
// v is the sample index, so a texture row per sample colours the tube exactly at each sample.
// `radius` is a number or one radius per sample.
export function buildTube(path, radius, radial = 32) {
  const { n, pos, high, right } = path
  const ring = radial + 1
  const vertices = new Float32Array(3 * n * ring)
  const uv = new Float32Array(2 * n * ring)
  for (let i = 0; i < n; i++) {
    const v = n > 1 ? (i + 0.5) / n : 0.5
    const ri = typeof radius === 'number' ? radius : radius[i]
    for (let k = 0; k < ring; k++) {
      const phi = (2 * Math.PI * k) / radial
      const c = Math.cos(phi) * ri
      const s = Math.sin(phi) * ri
      const o = 3 * (i * ring + k)
      for (let d = 0; d < 3; d++) vertices[o + d] = pos[3 * i + d] + c * high[3 * i + d] + s * right[3 * i + d]
      uv[2 * (i * ring + k)] = k / radial
      uv[2 * (i * ring + k) + 1] = v
    }
  }
  const index = new Uint32Array(6 * Math.max(0, n - 1) * radial)
  let w = 0
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = i * ring + k
      const b = (i + 1) * ring + k
      index.set([a, b, a + 1, b, b + 1, a + 1], w)
      w += 6
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.computeBoundingSphere()
  return geometry
}

// One texel row per sample: width 1 for scalar curves, `bins` for azimuthal images.
// Image bin 1 is centred on the high side (top of hole) and bins increase clockwise looking down-hole.
export function buildTexture(data) {
  const n = data.md_ft.length
  const width = data.image ? data.bins : 1
  const color = colorFn(data.color)
  const pixels = new Uint8Array(4 * width * n)
  for (let i = 0; i < n; i++) {
    const row = data.values[i]
    for (let k = 0; k < width; k++) {
      const [r, g, b] = color(data.image ? row?.[k] : row)
      pixels.set([r, g, b, 255], 4 * (i * width + k))
    }
  }
  const texture = new THREE.DataTexture(pixels, width, n, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.wrapS = THREE.RepeatWrapping
  texture.offset.set(data.image ? 0.5 / width : 0, 0)
  texture.needsUpdate = true
  return texture
}
