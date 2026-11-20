// The film: timeline, camera moves and compositing. renderAt(t) draws the frame for time t (seconds) on the 2D
// canvas, the same way every time, so frames can be rendered offline in any order.
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { H, W, lerp, project, ramp, track, window_ } from './common.js'
import { ETA, LAYERS, bnd, tauBetween } from './earth.js'
import * as hud from './hud.js'
import { BIT_TIP, RX, TX, createToolScene } from './sceneTool.js'
import { createWellScene } from './sceneWell.js'

export const DURATION = 62
export const OUTPUT = 'well_em_inversion.mp4'

// Story beats, seconds.
const T = {
  dive: 3.0, cross0: 12.0, cross1: 13.6, fire: 19.6, layers: 24.5, receivers: 29.3, invert: 33.6, sweep0: 39.5, sweep1: 51.5,
  truth: 52.6, pulled: 57.5, card: 58.2,
}
const OMEGA = 5.2 // wavefronts per second * 2 pi
const SWEEP = 46 // metres drilled during the inversion sweep
const STATION_MD = 20300 // ft, where the descent stops on Z-20
const ITERATIONS = [34.4, 35.2, 36.0, 36.8, 37.6]

const CAPTIONS = [
  [3.9, 8.5, 'Travelling down the well', 'From the platform, 3.2 km down into the chalk reservoir'],
  [8.8, 12.7, 'The logged interval', 'Colour and width show the resistivity measured while drilling (well 2/4-Z-20)'],
  [14.0, 19.2, 'The LWD resistivity tool', 'Antennas built into the drill collar, a few metres behind the bit'],
  [19.6, 24.2, 'The transmitter sends electromagnetic waves into the rock', null],
  [24.5, 29.0, 'The layers shape the waves', 'Resistive rock: long waves that travel far. Conductive rock: short waves that die out quickly.'],
  [29.3, 33.3, 'The receivers record what arrives', 'How much the wave was weakened (attenuation) and delayed (phase shift)'],
  [33.6, 39.2, 'Inversion', 'Adjust a layered resistivity model until its simulated signals match the measured ones'],
  [39.6, 51.2, 'Repeated every few feet along the well', 'Each station adds one column of layers to the picture'],
  [51.7, 57.7, 'A resistivity map of the rock around the borehole', 'Dotted lines: the true layer boundaries, which the tool never touched'],
]

// Renderer, both scenes and their post-processing, shared by every version of the film.
export function createStage({ canvas3d, well }) {
  const renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: false, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(W, H, false)
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.0

  const wellScene = createWellScene(well)
  const toolScene = createToolScene(renderer)

  const compose = ({ scene, camera }, strength, radius, threshold) => {
    const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 }))
    composer.addPass(new RenderPass(scene, camera))
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), strength, radius, threshold))
    composer.addPass(new OutputPass())
    return composer
  }
  const wellComposer = compose(wellScene, 0.2, 0.4, 1.0)
  const toolComposer = compose(toolScene, 0.3, 0.5, 0.9)

  // A NaN anywhere in a shader spreads through the bloom blur and blanks the whole frame, which would silently
  // repeat the previous frame in the video. Sampling one pixel after each 3D render catches that.
  const gl = renderer.getContext()
  const pixel = new Uint8Array(4)
  const blank = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(W / 2, 40, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return pixel[0] + pixel[1] + pixel[2] === 0
  }
  return { wellScene, toolScene, wellComposer, toolComposer, blank }
}

export function createFilm({ canvas3d, ctx, well }) {
  const { wellScene, toolScene, wellComposer, toolComposer, blank } = createStage({ canvas3d, well })

  // Well scene tracks.
  const uStation = wellScene.arcAtMd(STATION_MD)
  const travel = track([[T.dive, -250], [5.0, 420], [8.6, wellScene.arcLogged - 320], [10.5, wellScene.arcLogged + 240],
    [12.5, uStation], [T.cross1, uStation + 25]])
  const chase = track([[T.dive, 3300], [5.6, 2300], [8.6, 1250], [10.5, 760], [12.2, 480], [T.cross1, 330]])

  // Tool scene tracks.
  const camAz = track([[12, -34], [14.6, -26], [18.8, -10], [21.2, -4], [26, 6], [33, 13], [T.sweep0, 10], [T.sweep1, 17], [T.pulled, -12], [62, -16]])
  const camEl = track([[12, 16], [14.6, 11], [18.8, 9], [21.2, 9], [26, 11], [33, 13], [T.sweep0, 12], [T.sweep1, 14], [T.pulled, 17], [62, 18]])
  const camDist = track([[12, 34], [14.6, 11.5], [18.8, 12.5], [21.4, 23], [26, 26], [33, 25], [T.sweep0, 25], [T.sweep1, 26], [T.pulled, 64], [62, 68]])
  const camFx = track([[12, 0.6], [18.8, 1.0], [21.2, -0.6], [33, -0.4], [T.sweep0, 0.5]])
  const camFy = track([[12, 0], [18.8, -0.1], [21.4, -0.7], [T.sweep1, -0.7], [T.pulled, -1.6]])
  const waveGain = track([[T.fire, 1], [33, 1], [35, 0.75], [T.sweep0, 0.6], [T.sweep1, 0.55], [54.5, 0.25], [58, 0.16]])
  const shellGain = track([[T.fire, 1], [30, 1], [34.5, 0.55], [T.sweep0, 0.5], [T.sweep1, 0.45], [54.5, 0]])
  const sheetGain = track([[12.5, 0], [14.5, 1], [52, 1], [56, 0.45]])

  function wellState(t) {
    return {
      u: travel(t), dist: chase(t), blend: ramp(t, 2.7, 5.8), drift: t / 3.2, fov: lerp(30, 9, ramp(t, T.cross0, T.cross1)),
      marker: ramp(t, 2.8, 3.5) * (1 - ramp(t, 12.4, 13.2)),
    }
  }

  function toolState(t) {
    const toolX = SWEEP * ramp(t, T.sweep0, T.sweep1)
    const pull = ramp(t, T.sweep1, T.pulled)
    const fit0 = ITERATIONS.reduce((sum, ti) => sum + ramp(t, ti, ti + 0.4), 0) / ITERATIONS.length
    return {
      toolX, spin: 0.9 * t,
      cam: { az: camAz(t), el: camEl(t), dist: camDist(t), fx: lerp(camFx(t) + toolX, 23, pull), fy: camFy(t), fov: 30 },
      waveT: OMEGA * (t - T.fire), waveGain: waveGain(t), shellGain: shellGain(t), sheetGain: sheetGain(t), glowGain: 1,
      inv: { alpha: ramp(t, T.invert, T.invert + 0.6), reveal: 1.0 + toolX, fit0 },
      truth: ramp(t, T.truth, T.truth + 1.4),
      fit0,
    }
  }

  function wellHud(t, depth) {
    const cam = wellScene.camera
    hud.title(ctx, 'Seeing the rock around a well', 'Ekofisk, North Sea · well 2/4-Z-20', window_(t, 0.4, 3.3, 0.6))
    hud.depthReadout(ctx, depth.md_ft, depth.tvd_ft, window_(t, 3.4, 12.6, 0.5))
    const a = window_(t, 9.3, 12.3, 0.5)
    if (a > 0) {
      wellScene.labels.forEach((l, i) => {
        if (i % 2 === 0) hud.label(ctx, project(cam, l.pos.x, l.pos.y, l.pos.z), l.text, a, { dx: 26, dy: -52, size: 22 })
      })
    }
  }

  function toolHud(t, s) {
    const cam = toolScene.camera
    const at = (x, y, z = 0) => project(cam, x, y, z)
    const parts = window_(t, 14.4, 19.2, 0.5)
    hud.label(ctx, at(s.toolX + TX, 0.17), 'Transmitter', parts, { dx: -30, dy: -90 })
    hud.label(ctx, at(s.toolX + (RX[0] + RX[1]) / 2, 0.17), 'Receivers', parts, { dx: 0, dy: -130 })
    hud.label(ctx, at(s.toolX + BIT_TIP - 0.3, 0.2), 'Drill bit', parts, { dx: -30, dy: -110 })

    const layers = window_(t, T.layers, 33.3, 0.6)
    if (layers > 0) {
      const x = s.cam.fx - 0.37 * s.cam.dist
      LAYERS.forEach((layer, i) => {
        const top = i === 0 ? bnd(0, x) + 1.5 : bnd(i - 1, x)
        const bottom = i === LAYERS.length - 1 ? bnd(i - 1, x) - 1.9 : bnd(i, x)
        hud.label(ctx, at(x, (top + bottom) / 2, -0.2), layer.label, layers,
          { dx: 34, dy: 0, size: 23, chip: hud.chipFor(layer.rho), sub: layer.note })
      })
    }

    const tx = s.toolX + TX
    const tau1 = tauBetween(tx, 0, s.toolX + RX[0], 0, 24)
    const tau2 = tauBetween(tx, 0, s.toolX + RX[1], 0, 24)
    hud.scope(ctx, window_(t, T.receivers, T.invert + 0.2, 0.5), s.waveT, tau1, tau2, Math.exp(-ETA * (tau2 - tau1)) * 0.72)
    const sweeping = t > T.sweep0
    const stations = sweeping ? 3 + Math.floor(s.toolX / 0.8) : 0
    const fit = sweeping ? 0.97 + 0.03 * Math.sin(t * 7) : s.fit0
    hud.fitPanel(ctx, window_(t, T.invert + 0.3, T.sweep1 + 0.6, 0.5), fit, ITERATIONS.filter((ti) => t >= ti).length, stations)
    hud.colorBar(ctx, window_(t, T.invert + 0.3, T.card, 0.6))
    hud.note(ctx, 'Illustration: wavelengths are shortened so the waves can be seen', window_(t, T.fire + 0.4, T.sweep0, 0.6))
  }

  // Returns false when a 3D frame came out blank.
  function renderAt(t) {
    let ok = true
    const wWell = 1 - ramp(t, T.cross0, T.cross1)
    let depth = null
    let tool = null
    ctx.globalAlpha = 1
    if (wWell > 0) {
      depth = wellScene.update(wellState(t))
      wellComposer.render()
      ok &&= !blank()
      ctx.drawImage(canvas3d, 0, 0)
    }
    if (wWell < 1) {
      tool = toolState(t)
      toolScene.update(tool)
      toolComposer.render()
      ok &&= !blank()
      ctx.globalAlpha = 1 - wWell
      ctx.drawImage(canvas3d, 0, 0)
      ctx.globalAlpha = 1
    }
    if (depth && wWell > 0.5) wellHud(t, depth)
    if (tool && wWell <= 0.5) toolHud(t, tool)
    for (const [t0, t1, main, sub] of CAPTIONS) hud.caption(ctx, main, sub, window_(t, t0, t1, 0.45))
    const card = ramp(t, T.card, T.card + 1.0)
    hud.title(ctx, 'resist', 'Resistivity QC and inversion for Ekofisk well data', card, 0.62)
    hud.fade(ctx, 1 - ramp(t, 0, 0.9))
    hud.fade(ctx, ramp(t, DURATION - 0.7, DURATION - 0.05))
    return ok
  }

  return { renderAt }
}
