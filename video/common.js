import * as THREE from 'three'

export const W = 1920
export const H = 1080
export const FPS = 30

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
export const lerp = (a, b, t) => a + (b - a) * t
export const smooth = (t) => { const x = clamp(t); return x * x * (3 - 2 * x) }
// 0 before a, 1 after b, smooth in between.
export const ramp = (t, a, b) => smooth((t - a) / (b - a))
// 1 inside [a, b] with soft edges of width e.
export const window_ = (t, a, b, e = 0.4) => ramp(t, a, a + e) * (1 - ramp(t, b - e, b))

// Smooth curve through keyframes [[time, value], ...] (cubic Hermite, finite-difference tangents, clamped ends).
export function track(keys) {
  const n = keys.length
  const slope = keys.map((k, i) => {
    if (i === 0 || i === n - 1) return 0
    return (keys[i + 1][1] - keys[i - 1][1]) / (keys[i + 1][0] - keys[i - 1][0])
  })
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1]
    if (t >= keys[n - 1][0]) return keys[n - 1][1]
    let i = 0
    while (t > keys[i + 1][0]) i++
    const [t0, v0] = keys[i]
    const [t1, v1] = keys[i + 1]
    const h = t1 - t0
    const u = (t - t0) / h
    const u2 = u * u
    const u3 = u2 * u
    return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * h * slope[i] + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * h * slope[i + 1]
  }
}

// Dark vertical gradient shared by both scenes, so they cross-fade without a jump.
export function backgroundTexture() {
  const c = document.createElement('canvas')
  c.width = 16
  c.height = 512
  const g = c.getContext('2d')
  const grad = g.createLinearGradient(0, 0, 0, 512)
  grad.addColorStop(0, '#0b1626')
  grad.addColorStop(0.55, '#070d18')
  grad.addColorStop(1, '#04070d')
  g.fillStyle = grad
  g.fillRect(0, 0, 16, 512)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// World point -> pixel position on the W x H frame; null when behind the camera.
const tmp = new THREE.Vector3()
export function project(camera, x, y, z) {
  tmp.set(x, y, z).project(camera)
  if (tmp.z > 1 || tmp.z < -1) return null
  return [(tmp.x * 0.5 + 0.5) * W, (-tmp.y * 0.5 + 0.5) * H]
}
