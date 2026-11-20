// Tool scene: the LWD resistivity tool in a horizontal well, a cut section through the layered rock behind it,
// EM wavefronts (on the section and as 3D shells in front of it) and the inverted resistivity curtain.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { backgroundTexture } from './common.js'
import { ETA, earthGlsl, kAt, model, tauBetween, wellSlope, wellY } from './earth.js'

// Antenna positions along the tool, metres from the tool centre (+ = towards the bit).
export const TX = -1.7
export const RX = [-0.2, 0.5]
const ANTENNAS = [{ s: -2.6, kind: 'idle' }, { s: TX, kind: 'tx' }, { s: RX[0], kind: 'rx' }, { s: RX[1], kind: 'rx' },
  { s: 1.9, kind: 'idle' }, { s: 2.7, kind: 'idle' }]
export const TOOL_HALF = 3.8
export const BIT_TIP = TOOL_HALF + 1.75 // bit nose, metres ahead of the tool centre
const R_TOOL = 0.15
const R_HOLE = 0.19
export const SECTION = { x0: -18, x1: 78, y0: -14, y1: 14, z: -0.2 }

const GREEN = [0.35, 1.0, 0.4]
const BLUE = [0.2, 0.5, 1.0]

const sectionFragment = () => /* glsl */ `
uniform float uWaveT, uWaveGain, uReveal, uRevealMin, uSweepStart, uFit0, uInvAlpha, uTruth, uBitX, uRock, uPlan;
uniform vec2 uTx;
uniform vec4 uExtent;
varying vec2 vP;
${earthGlsl()}
const vec3 ROCK[5] = vec3[5](vec3(0.075, 0.085, 0.11), vec3(0.16, 0.155, 0.145), vec3(0.26, 0.245, 0.215),
  vec3(0.13, 0.14, 0.15), vec3(0.05, 0.06, 0.085));

void main() {
  vec2 p = vP;
  int li = layerAt(p);
  float top = li == 0 ? 20.0 : bnd(li - 1, p.x);
  float bot = li == 4 ? -20.0 : bnd(li, p.x);
  float ref = li == 0 ? bot : li == 4 ? top : 0.5 * (top + bot);
  float lam = fbm(vec2(p.x * 0.8 + float(li) * 13.0, (p.y - ref) * 5.0));
  float grain = vnoise(p * 34.0);
  vec3 col = ROCK[li] * (0.7 + 0.55 * lam) * (0.92 + 0.16 * grain) * uRock;
  float dB = min(abs(p.y - top), abs(p.y - bot));
  col += vec3(0.05, 0.055, 0.065) * smoothstep(0.05, 0.0, dB) * uRock;

  // Inverted curtain: one 1D layered model per column, visible within the depth of investigation.
  float colI = floor(p.x / COLUMN);
  float xc = (colI + 0.5) * COLUMN;
  float vis = step(uRevealMin, xc) * smoothstep(0.0, 0.5, uReveal - xc);
  float fit = xc < uSweepStart ? uFit0 : clamp((uReveal - xc) / 3.2, 0.0, 1.0);
  fit = fit * fit * (3.0 - 2.0 * fit);
  float ib[4];
  for (int i = 0; i < 4; i++) {
    float tb = bnd(i, xc);
    float err = (hash11(colI * 7.3 + float(i) * 3.1) - 0.5) * 0.2 * (1.0 + 0.4 * abs(tb));
    ib[i] = mix(3.3 - 2.2 * float(i), tb + err, fit);
  }
  int il = p.y > ib[0] ? 0 : p.y > ib[1] ? 1 : p.y > ib[2] ? 2 : p.y > ib[3] ? 3 : 4;
  float jit = (hash11(colI * 3.7 + float(il) * 5.9) - 0.5) * 0.3;
  float lr = mix(log(10.0), log(RHO[il]) + jit, fit);
  vec3 ic = toLinear(palette(rhoToT(exp(lr))));
  float edge = abs(fract(p.x / COLUMN) - 0.5) * 2.0;
  ic *= 1.0 - 0.16 * smoothstep(0.88, 1.0, edge);
  float a = vis * smoothstep(DOI, DOI - 0.9, abs(p.y - wellY(xc))) * uInvAlpha;
  col = mix(col, ic * 0.9, a * 0.95);

  if (uTruth > 0.0) {
    float dmin = 1e3;
    for (int i = 0; i < 4; i++) dmin = min(dmin, abs(p.y - bnd(i, p.x)));
    float dash = step(fract(p.x * 1.4), 0.55);
    float line = smoothstep(0.085, 0.04, dmin) * dash * uTruth;
    col = mix(col, mix(vec3(0.85), vec3(0.0), a), line);
  }

  // Planned straight path (dashed), drawn where the steered well leaves it.
  if (uPlan > 0.0) {
    float on = smoothstep(${(model.steerFrom - 4).toFixed(1)}, ${(model.steerFrom + 2).toFixed(1)}, p.x) * smoothstep(60.0, 56.0, p.x);
    float planLine = smoothstep(0.13, 0.085, abs(p.y)) * step(fract(p.x * 0.55), 0.62) * on * uPlan;
    col = mix(col, vec3(1.0), planLine * 0.9);
  }

  float bh = smoothstep(${(R_HOLE + 0.015).toFixed(3)}, ${(R_HOLE - 0.005).toFixed(3)}, abs(p.y - wellY(p.x))) * smoothstep(uBitX + 0.05, uBitX - 0.05, p.x);
  col = mix(col, vec3(0.01, 0.012, 0.018), bh);

  if (uWaveGain > 0.0) {
    vec2 d = p - uTx;
    float r = length(d);
    float tau = tauBetween(uTx, p);
    float ph = uWaveT - tau;
    float arrived = smoothstep(-0.6, 0.9, ph);
    float crest = pow(0.5 + 0.5 * cos(ph), 9.0);
    float amp = exp(-ETA * tau);
    float cosT = abs(d.x) / max(r, 1e-3);
    float pat = sqrt(1.0 - 0.72 * cosT * cosT);
    float spread = 1.0 / (1.0 + 0.09 * r);
    float I = uWaveGain * arrived * pow(amp, 0.85) * pat * spread * (0.035 + crest);
    vec3 wc = mix(vec3(${GREEN.join(', ')}), vec3(${BLUE.join(', ')}), smoothstep(0.55, 0.95, cosT));
    wc = mix(wc, vec3(1.0), a * 0.75);
    col += toLinear(wc) * I * 2.9 * (1.0 - bh);
  }

  float ax = smoothstep(uExtent.x, uExtent.x + 7.0, p.x) * smoothstep(uExtent.y, uExtent.y - 7.0, p.x);
  float ay = smoothstep(uExtent.z, uExtent.z + 5.0, p.y) * smoothstep(uExtent.w, uExtent.w - 5.0, p.y);
  gl_FragColor = vec4(col, ax * ay);
}
`

function steelTexture(slots) {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 256
  const g = c.getContext('2d')
  g.fillStyle = '#aab0ba'
  g.fillRect(0, 0, c.width, c.height)
  // Faint machining lines around the circumference (texture v runs along the tool axis).
  for (let y = 0; y < c.height; y += 2) {
    g.fillStyle = `rgba(0,0,0,${0.03 + 0.05 * Math.random()})`
    g.fillRect(0, y, c.width, 1)
  }
  if (slots) {
    const n = 22
    const pitch = c.width / n
    for (let i = 0; i < n; i++) {
      for (const [y0, y1] of [[0.07, 0.46], [0.54, 0.93]]) {
        g.fillStyle = '#0b0c0f'
        g.beginPath()
        g.roundRect(i * pitch + pitch * 0.3, y0 * c.height, pitch * 0.4, (y1 - y0) * c.height, pitch * 0.2)
        g.fill()
      }
    }
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

function buildTool() {
  const tool = new THREE.Group()
  const spin = new THREE.Group()
  tool.add(spin)
  const steel = new THREE.MeshStandardMaterial({ color: 0xffffff, map: steelTexture(false), metalness: 1, roughness: 0.3 })
  const slotTex = steelTexture(true)
  const slotted = new THREE.MeshStandardMaterial({ color: 0xffffff, map: slotTex, bumpMap: slotTex, bumpScale: 2.5, metalness: 0.95, roughness: 0.36 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x4a4f58, metalness: 1, roughness: 0.42 })
  const pipe = new THREE.MeshStandardMaterial({ color: 0x5b626d, metalness: 0.9, roughness: 0.5 })
  const cyl = (r, len, x, material, parent = spin) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 64, 1), material)
    m.rotation.z = -Math.PI / 2
    m.position.x = x
    parent.add(m)
    return m
  }
  cyl(R_TOOL, TOOL_HALF * 2, 0, steel)
  const glows = []
  for (const a of ANTENNAS) {
    cyl(R_TOOL + 0.004, 0.62, a.s, slotted)
    cyl(R_TOOL + 0.014, 0.07, a.s - 0.345, dark)
    cyl(R_TOOL + 0.014, 0.07, a.s + 0.345, dark)
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    const ring = cyl(R_TOOL + 0.02, 0.6, a.s, material)
    glows.push({ ...a, material, ring })
  }
  // Threaded box end towards the surface and the connection to the bit.
  cyl(R_TOOL + 0.012, 0.5, -TOOL_HALF + 0.25, dark)
  cyl(R_TOOL + 0.012, 0.3, TOOL_HALF - 0.15, dark)
  cyl(R_TOOL * 0.86, 1.25, TOOL_HALF + 0.625, pipe)
  const bit = new THREE.Group()
  bit.position.x = TOOL_HALF + 1.25
  spin.add(bit)
  cyl(R_HOLE * 0.86, 0.32, 0.16, dark, bit)
  const nose = new THREE.Mesh(new THREE.SphereGeometry(R_HOLE * 0.86, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), dark)
  nose.rotation.z = -Math.PI / 2
  nose.scale.y = 1.1
  nose.position.x = 0.32
  bit.add(nose)
  const cutter = new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 1, roughness: 0.35 })
  for (let i = 0; i < 5; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.035), cutter)
    const ang = (i / 5) * Math.PI * 2
    blade.position.set(0.24, Math.cos(ang) * R_HOLE * 0.88, Math.sin(ang) * R_HOLE * 0.88)
    blade.rotation.x = ang
    bit.add(blade)
  }
  return { tool, spin, glows }
}

// Drill string back towards the surface: a tube along the well path, clipped where the tool begins.
function buildString() {
  const points = []
  for (let x = -100; x <= 70; x += 0.5) points.push(new THREE.Vector3(x, wellY(x), 0))
  const clip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0)
  const material = new THREE.MeshStandardMaterial({ color: 0x5b626d, metalness: 0.9, roughness: 0.5, clippingPlanes: [clip] })
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 680, R_TOOL * 0.8, 24), material)
  return { mesh, clip }
}

function boundarySheet(index) {
  const geometry = new THREE.PlaneGeometry(SECTION.x1 - SECTION.x0, 7, 240, 1)
  geometry.rotateX(-Math.PI / 2)
  geometry.translate((SECTION.x0 + SECTION.x1) / 2, 0, 3.5 + SECTION.z)
  const material = new THREE.ShaderMaterial({
    uniforms: { uGain: { value: 1 }, uFocus: { value: 0 } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vW;
      ${earthGlsl()}
      void main() {
        vec3 p = position;
        p.y = bnd(${index}, p.x);
        vW = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uGain, uFocus;
      varying vec3 vW;
      void main() {
        float lx = smoothstep(0.06, 0.0, abs(fract(vW.x / 2.0 + 0.5) - 0.5) * 2.0);
        float lz = smoothstep(0.05, 0.0, abs(fract(vW.z + 0.5) - 0.5));
        float line = max(lx, lz);
        float fz = smoothstep(7.0, 0.3, vW.z);
        float fx = smoothstep(26.0, 6.0, abs(vW.x - uFocus));
        gl_FragColor = vec4(vec3(0.45, 0.62, 0.95), (0.035 + 0.16 * line) * fz * fx * uGain);
      }`,
  })
  return new THREE.Mesh(geometry, material)
}

// 3D wavefronts in front of the section: half-domes whose radius in every direction is where the phase delay
// from the transmitter reaches the front's value, so they bulge into resistive rock and stall in conductive rock.
function buildShells(scene) {
  const NT = 84
  const NP = 44
  const STEPS = 260
  const DR = 0.1
  const TAU_MAX = 25
  const POOL = 5
  const n = NT * NP
  const dirs = new Float32Array(n * 3)
  const pattern = new Float32Array(n)
  const cosT = new Float32Array(n)
  for (let i = 0; i < NT; i++) {
    const th = (Math.PI * i) / (NT - 1)
    for (let j = 0; j < NP; j++) {
      const ph = (Math.PI * j) / (NP - 1)
      const k = i * NP + j
      dirs[k * 3] = Math.cos(th)
      dirs[k * 3 + 1] = Math.sin(th) * Math.cos(ph)
      dirs[k * 3 + 2] = Math.sin(th) * Math.sin(ph)
      cosT[k] = Math.abs(Math.cos(th))
      pattern[k] = Math.sqrt(1 - 0.72 * cosT[k] * cosT[k])
    }
  }
  const index = []
  for (let i = 0; i < NT - 1; i++) {
    for (let j = 0; j < NP - 1; j++) {
      const a = i * NP + j
      index.push(a, a + NP, a + 1, a + 1, a + NP, a + NP + 1)
    }
  }
  const material = () => new THREE.ShaderMaterial({
    uniforms: { uAmp: { value: 0 } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aPattern, aCos, aFade;
      varying vec3 vN, vV;
      varying float vA, vCos;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalMatrix * normal;
        vV = normalize(-mv.xyz);
        vA = aPattern * aFade;
        vCos = aCos;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uAmp;
      varying vec3 vN, vV;
      varying float vA, vCos;
      void main() {
        // Guards: zero-length normals at the shell poles and |dot| a hair above 1 would both give NaN.
        vec3 nrm = vN / max(length(vN), 1e-5);
        float rim = pow(clamp(1.0 - abs(dot(nrm, normalize(vV))), 0.0, 1.0), 1.7);
        vec3 c = mix(vec3(${GREEN.join(', ')}), vec3(${BLUE.join(', ')}), smoothstep(0.55, 0.95, vCos));
        gl_FragColor = vec4(pow(c, vec3(2.2)), max(0.0, uAmp * vA) * (0.012 + 0.5 * rim));
      }`,
  })
  const shells = []
  for (let s = 0; s < POOL; s++) {
    const geometry = new THREE.BufferGeometry()
    geometry.setIndex(index)
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
    geometry.setAttribute('aPattern', new THREE.BufferAttribute(pattern, 1))
    geometry.setAttribute('aCos', new THREE.BufferAttribute(cosT, 1))
    geometry.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(n), 1))
    const mesh = new THREE.Mesh(geometry, material())
    mesh.frustumCulled = false
    mesh.visible = false
    mesh.renderOrder = 5
    scene.add(mesh)
    shells.push(mesh)
  }
  const table = new Float32Array(n * STEPS)
  let tableKey = null

  function fillTable(tx, ty) {
    if (tableKey === `${tx},${ty}`) return
    tableKey = `${tx},${ty}`
    for (let k = 0; k < n; k++) {
      const dx = dirs[k * 3]
      const dy = dirs[k * 3 + 1]
      let tau = 0
      const o = k * STEPS
      for (let s = 0; s < STEPS; s++) {
        const r = (s + 0.5) * DR
        tau += kAt(tx + dx * r, ty + dy * r) * DR
        table[o + s] = tau
      }
    }
  }

  // waveT: phase advance since the transmitter started (radians), gain: 0..1.
  function update(tx, ty, waveT, gain) {
    const live = gain > 0.002 && waveT > 0
    if (live) fillTable(tx, ty)
    const first = Math.max(0, Math.ceil((waveT - TAU_MAX) / (2 * Math.PI)))
    const used = new Set()
    if (live) {
      for (let m = first; m * 2 * Math.PI < waveT; m++) {
        const target = waveT - m * 2 * Math.PI
        const mesh = shells[m % POOL]
        used.add(mesh)
        const pos = mesh.geometry.attributes.position
        const fade = mesh.geometry.attributes.aFade
        for (let k = 0; k < n; k++) {
          const o = k * STEPS
          let lo = 0
          let hi = STEPS - 1
          while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (table[o + mid] < target) lo = mid + 1
            else hi = mid
          }
          const t1 = table[o + lo]
          const t0 = lo > 0 ? table[o + lo - 1] : 0
          const r = t1 > target ? (lo + (target - t0) / (t1 - t0)) * DR : STEPS * DR
          pos.array[k * 3] = tx + dirs[k * 3] * r
          pos.array[k * 3 + 1] = ty + dirs[k * 3 + 1] * r
          pos.array[k * 3 + 2] = dirs[k * 3 + 2] * r
          fade.array[k] = 1 / (1 + 0.09 * r)
        }
        pos.needsUpdate = true
        fade.needsUpdate = true
        mesh.geometry.computeVertexNormals()
        const birth = Math.min(1, target / 1.6)
        mesh.material.uniforms.uAmp.value = gain * birth * Math.exp(-ETA * target * 0.85)
        mesh.visible = true
      }
    }
    for (const mesh of shells) if (!used.has(mesh)) mesh.visible = false
  }
  return { update }
}

// World position of a point s metres along the tool (from its centre) when the tool centre is at x = toolX.
export function toolPoint(toolX, s) {
  const tilt = Math.atan(wellSlope(toolX))
  return [toolX + s * Math.cos(tilt), wellY(toolX) + s * Math.sin(tilt)]
}

export function createToolScene(renderer) {
  renderer.localClippingEnabled = true
  const scene = new THREE.Scene()
  scene.background = backgroundTexture()
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture
  scene.environmentIntensity = 0.5
  const sun = new THREE.DirectionalLight(0xffffff, 1.2)
  sun.position.set(-4, 9, 12)
  scene.add(sun)

  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 600)

  const uniforms = {
    uWaveT: { value: 0 }, uWaveGain: { value: 0 }, uReveal: { value: -1e3 }, uRevealMin: { value: -1.6 },
    uSweepStart: { value: 0.8 }, uFit0: { value: 0 }, uInvAlpha: { value: 0 }, uTruth: { value: 0 }, uBitX: { value: 0 },
    uRock: { value: 1 }, uPlan: { value: 0 }, uTx: { value: new THREE.Vector2() },
    uExtent: { value: new THREE.Vector4(SECTION.x0, SECTION.x1, SECTION.y0, SECTION.y1) },
  }
  const section = new THREE.Mesh(
    new THREE.PlaneGeometry(SECTION.x1 - SECTION.x0, SECTION.y1 - SECTION.y0),
    new THREE.ShaderMaterial({
      uniforms, transparent: true,
      vertexShader: /* glsl */ `
        varying vec2 vP;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vP = w.xy;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: sectionFragment(),
    }),
  )
  section.position.set((SECTION.x0 + SECTION.x1) / 2, (SECTION.y0 + SECTION.y1) / 2, SECTION.z)
  section.renderOrder = -1
  scene.add(section)

  const sheets = [0, 1, 2, 3].map(boundarySheet)
  sheets.forEach((s) => { s.renderOrder = 2; scene.add(s) })

  const { tool, spin, glows } = buildTool()
  scene.add(tool)
  const string = buildString()
  scene.add(string.mesh)
  const shells = buildShells(scene)

  const TX_COLOR = [1.0, 0.55, 0.12]
  const RX_COLOR = [0.25, 0.85, 1.0]

  // s: { toolX, spin, cam: {az, el, dist, fx, fy, fov}, waveT, waveGain, shellGain, sheetGain, inv: {alpha, reveal, fit0}, truth }
  function update(s) {
    tool.position.set(s.toolX, wellY(s.toolX), 0)
    tool.rotation.z = Math.atan(wellSlope(s.toolX))
    string.clip.constant = s.toolX - TOOL_HALF + 0.1
    spin.rotation.x = s.spin
    const [tx, ty] = toolPoint(s.toolX, TX)
    uniforms.uTx.value.set(tx, ty)
    uniforms.uPlan.value = s.plan ?? 0
    uniforms.uBitX.value = s.toolX + BIT_TIP
    uniforms.uWaveT.value = s.waveT
    uniforms.uWaveGain.value = s.waveT > 0 ? s.waveGain : 0
    uniforms.uInvAlpha.value = s.inv.alpha
    uniforms.uReveal.value = s.inv.reveal
    uniforms.uFit0.value = s.inv.fit0
    uniforms.uTruth.value = s.truth
    for (const sheet of sheets) {
      sheet.material.uniforms.uGain.value = s.sheetGain
      sheet.material.uniforms.uFocus.value = s.cam.fx
    }
    shells.update(tx, ty, s.waveT, s.shellGain)

    const firing = s.waveT > 0 ? Math.min(1, s.waveT / 2) : 0
    for (const g of glows) {
      let level = 0
      let rgb = TX_COLOR
      if (g.kind === 'tx') level = firing * (0.5 + 0.9 * Math.pow(0.5 + 0.5 * Math.cos(s.waveT), 3))
      if (g.kind === 'rx') {
        rgb = RX_COLOR
        const tau = tauBetween(tx, ty, ...toolPoint(s.toolX, g.s), 24)
        const ph = s.waveT - tau
        level = ph > 0 ? Math.min(1, ph / 2) * (0.12 + 1.1 * Math.pow(0.5 + 0.5 * Math.cos(ph), 4)) * Math.exp(-ETA * tau * 0.5) : 0
      }
      level *= s.glowGain
      g.material.color.setRGB(rgb[0] * level, rgb[1] * level, rgb[2] * level)
      g.ring.visible = level > 0.001
    }

    const az = THREE.MathUtils.degToRad(s.cam.az)
    const el = THREE.MathUtils.degToRad(s.cam.el)
    camera.fov = s.cam.fov ?? 30
    camera.position.set(s.cam.fx + s.cam.dist * Math.sin(az) * Math.cos(el), s.cam.fy + s.cam.dist * Math.sin(el),
      s.cam.dist * Math.cos(az) * Math.cos(el))
    camera.lookAt(s.cam.fx, s.cam.fy, 0)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
  }

  return { scene, camera, update }
}
