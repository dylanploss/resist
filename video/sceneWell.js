// Well scene: the real logged interval of 2/4-Z-20 (UTM + TVD, coloured by ARH16P like the app's 3D well view)
// hanging below an illustrative path from the platform. three.js frame: x east, y up (0 = sea level), z south. Metres.
import * as THREE from 'three'
import { backgroundTexture, clamp, lerp } from './common.js'

const FT = 0.3048
// Plotly Jet, the scale the app uses for resistivity curves (frontend/src/components/well3d/colormap.js).
const JET = [[0, [0, 0, 131]], [0.125, [0, 60, 170]], [0.375, [5, 255, 255]], [0.625, [255, 255, 0]], [0.875, [250, 0, 0]],
  [1, [128, 0, 0]]]
function jet(t) {
  const x = clamp(t)
  let k = 1
  while (k < JET.length - 1 && x > JET[k][0]) k++
  const f = (x - JET[k - 1][0]) / (JET[k][0] - JET[k - 1][0])
  return [0, 1, 2].map((j) => (JET[k - 1][1][j] + (JET[k][1][j] - JET[k - 1][1][j]) * f) / 255)
}

function fadePlane(y, size, center, color, alpha, grid) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uAlpha: { value: alpha }, uGrid: { value: grid }, uRadius: { value: size / 2 } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vL;
      void main() { vL = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha, uGrid, uRadius;
      varying vec2 vL;
      void main() {
        float r = length(vL) / uRadius;
        float fade = smoothstep(1.0, 0.35, r);
        vec2 g = abs(fract(vL / uGrid + 0.5) - 0.5) * uGrid;
        float w = fwidth(vL.x) + fwidth(vL.y);
        float line = 1.0 - smoothstep(0.0, 1.5 * w, min(g.x, g.y));
        gl_FragColor = vec4(uColor * (1.0 + 0.6 * line), uAlpha * fade * (0.6 + 0.5 * line));
      }`,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(center.x, y, center.z)
  return mesh
}

function platform() {
  const g = new THREE.Group()
  const steel = new THREE.MeshStandardMaterial({ color: 0xd8a23a, metalness: 0.4, roughness: 0.6, emissive: 0x3a2a08 })
  const grey = new THREE.MeshStandardMaterial({ color: 0x9aa4b2, metalness: 0.6, roughness: 0.5, emissive: 0x1a1f28 })
  const deck = new THREE.Mesh(new THREE.BoxGeometry(150, 22, 150), grey)
  deck.position.y = 62
  g.add(deck)
  for (const [x, z] of [[-55, -55], [55, -55], [-55, 55], [55, 55]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 135, 12), steel)
    leg.position.set(x, -6, z)
    g.add(leg)
  }
  const derrick = new THREE.Mesh(new THREE.CylinderGeometry(6, 34, 150, 4, 3), new THREE.MeshBasicMaterial({ color: 0xffd27a, wireframe: true }))
  derrick.position.y = 148
  g.add(derrick)
  return g
}

export function createWellScene(well) {
  const scene = new THREE.Scene()
  scene.background = backgroundTexture()
  scene.add(new THREE.AmbientLight(0xffffff, 1.1))
  const sun = new THREE.DirectionalLight(0xffffff, 2.0)
  sun.position.set(3, 4, 2)
  scene.add(sun)
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 5, 60000)

  // Logged interval, real positions.
  const tvd0 = well.origin.tvd_m
  const n = well.md_ft.length
  const logged = []
  for (let i = 0; i < n; i++) logged.push(new THREE.Vector3(well.x_m[i], -tvd0 + well.z_m[i], -well.y_m[i]))
  const heading = logged[40].clone().sub(logged[0]).setY(0).normalize()
  const t0 = logged[6].clone().sub(logged[0]).normalize()

  // Illustrative path from the platform to the first logged sample (the data starts at 18,840 ft MD).
  const surface = logged[0].clone().addScaledVector(heading, -2600).setY(0)
  const m0 = new THREE.Vector3(0, -3400, 0)
  const m1 = t0.clone().multiplyScalar(3000)
  const upper = []
  const NU = 260
  for (let i = 0; i < NU; i++) {
    const u = i / NU
    const u2 = u * u
    const u3 = u2 * u
    upper.push(new THREE.Vector3()
      .addScaledVector(surface, 2 * u3 - 3 * u2 + 1).addScaledVector(m0, u3 - 2 * u2 + u)
      .addScaledVector(logged[0], -2 * u3 + 3 * u2).addScaledVector(m1, u3 - u2))
  }
  const points = [...upper, ...logged]
  const arc = [0]
  for (let i = 1; i < points.length; i++) arc.push(arc[i - 1] + points[i].distanceTo(points[i - 1]))
  const arcLogged = arc[NU]
  const total = arc.at(-1)
  // Measured depth along the whole path: linear above the data, the real MD inside it.
  const md = points.map((_, i) => (i < NU ? (arc[i] / arcLogged) * well.md_ft[0] : well.md_ft[i - NU]))

  function locate(s) {
    const x = clamp(s, 0, total)
    let lo = 0
    let hi = arc.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (arc[mid] <= x) lo = mid
      else hi = mid
    }
    return [lo, (x - arc[lo]) / (arc[hi] - arc[lo] || 1)]
  }
  const posAt = (s, out = new THREE.Vector3()) => {
    if (s < 0) return out.copy(surface).setY(-s)
    const [i, f] = locate(s)
    return out.lerpVectors(points[i], points[i + 1], f)
  }
  const mdAt = (s) => { const [i, f] = locate(s); return lerp(md[i], md[i + 1], f) }
  const arcAtMd = (mdFt) => {
    let i = 0
    while (i < md.length - 2 && md[i + 1] < mdFt) i++
    return lerp(arc[i], arc[i + 1], clamp((mdFt - md[i]) / (md[i + 1] - md[i] || 1)))
  }

  // Unlogged path: plain steel tube.
  const upperTube = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(upper.filter((_, i) => i % 4 === 0).concat(logged[0])), 300, 20, 12),
    new THREE.MeshStandardMaterial({ color: 0x8f9bb0, metalness: 0.5, roughness: 0.45, emissive: 0x222a38 }),
  )
  scene.add(upperTube)

  // Logged interval: tube radius from the depth-of-investigation estimate, colour from the curve (Jet, log10).
  const SEG = 14
  // Smoothed over ~9 samples so the tube swells and narrows instead of flickering between neighbouring samples.
  const rawDoi = well.doi_m.map((v) => v ?? 0.4)
  const doi = rawDoi.map((_, i) => {
    const part = rawDoi.slice(Math.max(0, i - 4), i + 5)
    return part.reduce((a, b) => a + b, 0) / part.length
  })
  const dmin = Math.min(...doi)
  const dmax = Math.max(...doi)
  const position = new Float32Array(n * SEG * 3)
  const color = new Float32Array(n * SEG * 3)
  const normal = new Float32Array(n * SEG * 3)
  const tangent = new THREE.Vector3()
  const side = new THREE.Vector3()
  const up = new THREE.Vector3()
  const ref = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < n; i++) {
    tangent.copy(logged[Math.min(n - 1, i + 1)]).sub(logged[Math.max(0, i - 1)]).normalize()
    side.crossVectors(tangent, ref).normalize()
    up.crossVectors(side, tangent).normalize()
    const radius = 10 + 36 * Math.pow((doi[i] - dmin) / (dmax - dmin), 1.2)
    const v = well.values[i]
    const rgb = v > 0 ? jet((Math.log10(v) - well.color.zmin) / (well.color.zmax - well.color.zmin)) : [0.3, 0.3, 0.3]
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2
      const nx = side.x * Math.cos(a) + up.x * Math.sin(a)
      const ny = side.y * Math.cos(a) + up.y * Math.sin(a)
      const nz = side.z * Math.cos(a) + up.z * Math.sin(a)
      const o = (i * SEG + j) * 3
      position[o] = logged[i].x + nx * radius
      position[o + 1] = logged[i].y + ny * radius
      position[o + 2] = logged[i].z + nz * radius
      normal[o] = nx; normal[o + 1] = ny; normal[o + 2] = nz
      color[o] = rgb[0] ** 2.2; color[o + 1] = rgb[1] ** 2.2; color[o + 2] = rgb[2] ** 2.2
    }
  }
  const index = []
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * SEG + j
      const b = i * SEG + ((j + 1) % SEG)
      index.push(a, a + SEG, b, b, a + SEG, b + SEG)
    }
  }
  const tube = new THREE.BufferGeometry()
  tube.setIndex(index)
  tube.setAttribute('position', new THREE.BufferAttribute(position, 3))
  tube.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  tube.setAttribute('color', new THREE.BufferAttribute(color, 3))
  const tubeMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.0, side: THREE.DoubleSide })
  tubeMaterial.onBeforeCompile = (shader) => {
    // Vertex colours are linear Jet values (max() guards MSAA extrapolation below zero); a little self-light keeps them vivid.
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
      'diffuseColor.rgb *= max(vColor.rgb, 0.0);').replace('#include <emissivemap_fragment>',
      'totalEmissiveRadiance += max(vColor.rgb, 0.0) * 0.18;')
  }
  scene.add(new THREE.Mesh(tube, tubeMaterial))

  // Sea, seabed, overburden and reservoir, as faint planes that fade out away from the well.
  const center = surface.clone().lerp(logged.at(-1), 0.5)
  const resTop = Math.max(...logged.map((p) => p.y)) + 70
  const resBase = Math.min(...logged.map((p) => p.y)) - 110
  scene.add(fadePlane(0, 16000, center, 0x2a7fd0, 0.2, 500))
  scene.add(fadePlane(-75, 16000, center, 0x6b5a3c, 0.16, 500))
  for (const y of [-900, -1750, -2500]) scene.add(fadePlane(y, 13000, center, 0x5d6b82, 0.07, 500))
  scene.add(fadePlane(resTop, 12000, center, 0xd9b36a, 0.07, 500))
  scene.add(fadePlane(resBase, 12000, center, 0x8a6a3a, 0.08, 500))
  const rig = platform()
  rig.position.copy(surface)
  rig.scale.setScalar(2.2)
  scene.add(rig)

  const marker = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.8, 1.0) }))
  scene.add(marker)

  const labels = []
  for (let mdFt = Math.ceil(well.md_ft[0] / 500) * 500; mdFt <= well.md_ft.at(-1); mdFt += 500) {
    labels.push({ text: `${mdFt.toLocaleString('en-US')} ft`, pos: posAt(arcAtMd(mdFt)) })
  }

  const eye = new THREE.Vector3()
  const look = new THREE.Vector3()
  const chaseEye = new THREE.Vector3()
  const chaseLook = new THREE.Vector3()
  const X = new THREE.Vector3(1, 0, 0)
  const wide = { eye: new THREE.Vector3(center.x + 8600, -900, center.z - 1500), look: new THREE.Vector3(center.x, -1650, center.z + 150) }

  // s: { u (arc length of the travel point), dist (chase distance), blend (0 wide shot .. 1 chase), drift, fov, marker }
  function update(s) {
    const p = posAt(s.u)
    marker.position.copy(p)
    marker.scale.setScalar(s.dist * 0.009 * s.marker)
    marker.visible = s.marker > 0.01
    chaseEye.copy(posAt(s.u - 0.25 * s.dist)).addScaledVector(X, 0.86 * s.dist).addScaledVector(heading, -0.3 * s.dist)
    chaseEye.y += 0.26 * s.dist
    posAt(Math.min(total, s.u + 0.12 * s.dist), chaseLook)
    eye.copy(wide.eye)
    eye.z += s.drift * 900
    eye.y += s.drift * 250
    eye.lerp(chaseEye, s.blend)
    look.copy(wide.look).lerp(chaseLook, s.blend)
    camera.fov = s.fov
    camera.near = Math.max(2, s.dist * 0.02)
    camera.position.copy(eye)
    camera.lookAt(look)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    return { md_ft: mdAt(Math.max(0, s.u)), tvd_ft: -p.y / FT }
  }

  return { scene, camera, update, labels, total, arcLogged, arcAtMd, surface, resTop, center }
}
