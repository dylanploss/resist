// Second version of the film: the opening of the presentation, which states the problem. Shorter physics, then a
// geosteering decision made from the inversion, then: the inversion is a black box bound to service-company
// software, new methods do not get in, and operators can change that by releasing data.
import { H, W, lerp, project, ramp, track, window_ } from './common.js'
import { DOI, LAYERS, bnd, model, wellY } from './earth.js'
import { createStage } from './film.js'
import * as hud from './hud.js'
import { BIT_TIP, RX, TX, toolPoint } from './sceneTool.js'

export const DURATION = 58.5
export const OUTPUT = 'geosteering_problem.mp4'

// This version's rock model: the reservoir roof dips far enough that a straight well would leave the reservoir,
// and the well is steered down to stay inside. Must be set before the stage builds its shaders.
Object.assign(model, { dip: 1.5, steer: 1.45, steerFrom: 22, steerTo: 44 })

const T = {
  dive: 2.2, cross0: 7.6, cross1: 9.0, fire: 12.4, layers: 16.0, invert: 20.0, sweep0: 24.0, steer: 29.9, sweep1: 38.6,
  pulled: 42.6, box: 43.2, methods: 47.4, open: 51.8, card: 55.3,
}
const OMEGA = 5.2
const STATION_MD = 20300
const ITERATIONS = [20.5, 21.1, 21.7, 22.3, 22.9]
const CURTAIN = [-1.6, 47.2] // x range of the inverted curtain at the end of the sweep

const CAPTIONS = [
  [2.9, 5.4, 'Drilling 3.2 km below the sea', 'The well turns horizontal to stay inside the reservoir'],
  [5.6, 8.3, 'Nobody can see the rock down there', 'Only the logging tools behind the bit can sense it'],
  [9.4, 12.2, 'The LWD resistivity tool', 'Antennas in the drill collar, a few metres behind the bit'],
  [12.6, 15.8, 'It sends electromagnetic waves into the rock', null],
  [16.0, 19.8, 'The layers shape the waves', 'Far-reaching in resistive rock, quickly absorbed in conductive rock'],
  [20.1, 23.8, 'Inversion turns the signals into layers', 'A resistivity model is adjusted until it explains the measurements'],
  [24.2, 29.6, 'Station by station, it maps the rock around the well', null],
  [T.steer, 38.4, 'Geosteering decisions are made on the fly', 'The map shows the reservoir roof dropping, so the well is steered down to stay inside'],
  [38.8, 43.0, 'Every steering decision relies on this picture', 'White dashes: the planned path, which would have left the reservoir'],
  [43.3, 47.2, 'But the inversion is a black box', 'It is bound to the service company and its software'],
  [47.5, 51.6, 'New features and methods rarely get in', 'Service companies are reluctant to implement them'],
  [51.9, 55.4, 'Operators can change that', 'Releasing data lets the whole domain build and test better inversions'],
]

export function createFilm({ canvas3d, ctx, well }) {
  const { wellScene, toolScene, wellComposer, toolComposer, blank } = createStage({ canvas3d, well })

  const uStation = wellScene.arcAtMd(STATION_MD)
  const travel = track([[T.dive, -250], [3.3, 420], [5.4, wellScene.arcLogged - 320], [6.6, wellScene.arcLogged + 240],
    [8.0, uStation], [T.cross1, uStation + 25]])
  const chase = track([[T.dive, 3300], [3.7, 2300], [5.4, 1250], [6.6, 760], [7.8, 480], [T.cross1, 330]])

  // Slower through the steering section, so the decision can be read.
  const toolTrack = track([[T.sweep0, 0], [29.5, 17], [36.5, 38], [T.sweep1, 46]])
  const camAz = track([[9, -34], [10.4, -26], [12.2, -12], [13.6, -4], [17, 6], [20, 12], [T.sweep0, 10], [T.sweep1, 16], [T.pulled, -10], [DURATION, -17]])
  const camEl = track([[9, 16], [10.4, 11], [12.2, 9], [13.6, 9], [17, 11], [20, 13], [T.sweep0, 12], [T.sweep1, 14], [T.pulled, 17], [DURATION, 19]])
  const camDist = track([[9, 34], [10.4, 11.5], [12.2, 12.5], [14.2, 23], [17, 26], [20, 25], [T.sweep0, 24], [T.sweep1, 24], [T.pulled, 58], [DURATION, 64]])
  const camFx = track([[9, 0.6], [12.2, 1.0], [13.8, -0.6], [20, -0.4], [T.sweep0, 0.5]])
  const camFy = track([[9, 0], [12.2, -0.1], [14.2, -0.7], [T.sweep1, -0.9], [T.pulled, -1.9]])
  const waveGain = track([[T.fire, 1], [20, 1], [21.5, 0.75], [T.sweep0, 0.6], [T.sweep1, 0.5], [41, 0.22], [44, 0.1]])
  const shellGain = track([[T.fire, 1], [19, 1], [21, 0.55], [T.sweep0, 0.5], [T.sweep1, 0.4], [41, 0]])
  const sheetGain = track([[9.3, 0], [10.6, 1], [39, 1], [42, 0.45]])

  function wellState(t) {
    return {
      u: travel(t), dist: chase(t), blend: ramp(t, 2.0, 4.0), drift: t / 2.4, fov: lerp(30, 9, ramp(t, T.cross0, T.cross1)),
      marker: ramp(t, 2.0, 2.6) * (1 - ramp(t, 8.0, 8.7)),
    }
  }

  function toolState(t) {
    const toolX = toolTrack(t)
    const pull = ramp(t, T.sweep1, T.pulled)
    const fit0 = ITERATIONS.reduce((sum, ti) => sum + ramp(t, ti, ti + 0.35), 0) / ITERATIONS.length
    return {
      toolX, spin: 0.9 * t,
      cam: { az: camAz(t), el: camEl(t), dist: camDist(t), fx: lerp(camFx(t) + toolX, 23, pull),
        fy: camFy(t) + 0.6 * wellY(toolX) * (1 - pull), fov: 30 },
      waveT: OMEGA * (t - T.fire), waveGain: waveGain(t), shellGain: shellGain(t), sheetGain: sheetGain(t), glowGain: 1,
      inv: { alpha: ramp(t, T.invert, T.invert + 0.5), reveal: 1.0 + toolX, fit0 },
      truth: ramp(t, 39.6, 41.0), plan: ramp(toolX, 19, 24),
      fit0,
    }
  }

  function wellHud(t, depth) {
    const cam = wellScene.camera
    hud.title(ctx, 'Steering a well you cannot see', 'Ekofisk, North Sea · well 2/4-Z-20', window_(t, 0.35, 2.6, 0.5))
    hud.depthReadout(ctx, depth.md_ft, depth.tvd_ft, window_(t, 2.7, 8.2, 0.4))
    const a = window_(t, 6.2, 7.9, 0.4)
    if (a > 0) {
      wellScene.labels.forEach((l, i) => {
        if (i % 2 === 0) hud.label(ctx, project(cam, l.pos.x, l.pos.y, l.pos.z), l.text, a, { dx: 26, dy: -52, size: 22 })
      })
    }
  }

  function toolHud(t, s) {
    const cam = toolScene.camera
    const at = (x, y, z = 0) => project(cam, x, y, z)
    const parts = window_(t, 10.5, 12.5, 0.4)
    hud.label(ctx, at(s.toolX + TX, 0.17), 'Transmitter', parts, { dx: -30, dy: -90 })
    hud.label(ctx, at(s.toolX + (RX[0] + RX[1]) / 2, 0.17), 'Receivers', parts, { dx: 0, dy: -130 })
    hud.label(ctx, at(s.toolX + BIT_TIP - 0.3, 0.2), 'Drill bit', parts, { dx: -30, dy: -110 })

    const layers = window_(t, T.layers, 19.9, 0.5)
    if (layers > 0) {
      const x = s.cam.fx - 0.37 * s.cam.dist
      LAYERS.forEach((layer, i) => {
        const top = i === 0 ? bnd(0, x) + 1.5 : bnd(i - 1, x)
        const bottom = i === LAYERS.length - 1 ? bnd(i - 1, x) - 1.9 : bnd(i, x)
        hud.label(ctx, at(x, (top + bottom) / 2, -0.2), layer.label, layers,
          { dx: 34, dy: 0, size: 23, chip: hud.chipFor(layer.rho), sub: layer.note })
      })
    }

    const sweeping = t > T.sweep0
    const stations = sweeping ? 3 + Math.floor(s.toolX / 0.8) : 0
    const fit = sweeping ? 0.97 + 0.03 * Math.sin(t * 7) : s.fit0
    hud.fitPanel(ctx, window_(t, T.invert + 0.2, 29.4, 0.5), fit, ITERATIONS.filter((ti) => t >= ti).length, stations)
    hud.colorBar(ctx, window_(t, T.invert + 0.2, T.box, 0.6))
    hud.note(ctx, 'Illustration: wavelengths are shortened so the waves can be seen', window_(t, T.fire + 0.4, T.sweep0, 0.5))

    // Geosteering: live distance from the well to the reservoir roof, and the steering call.
    const steering = window_(t, T.steer + 0.2, T.sweep1 - 0.2, 0.5)
    if (steering > 0) {
      const xr = s.toolX - 1.5
      const gap = bnd(1, s.toolX) - wellY(s.toolX)
      const close = gap < 1.25
      hud.label(ctx, at(xr, bnd(1, xr), -0.2), close ? 'Reservoir roof is dropping' : 'Reservoir roof', steering,
        { dx: -40, dy: -120, sub: `${gap.toFixed(1)} m above the well`, accent: close ? '#ffb347' : null })
      const [bx, by] = toolPoint(s.toolX, BIT_TIP)
      hud.label(ctx, at(bx, by - 0.2), 'Steer down', steering * ramp(s.toolX, 21, 23.5) * (1 - ramp(s.toolX, 40, 43)),
        { dx: -30, dy: 120, sub: 'to stay in the reservoir', accent: '#4fd97a' })
    }

    // The black box over the curtain, the two things that do not get in, and the box opening again.
    const box = ramp(t, T.box, T.box + 0.9) * (1 - ramp(t, T.open + 0.5, T.open + 1.6))
    if (box > 0) {
      const xs = Array.from({ length: 13 }, (_, i) => lerp(CURTAIN[0], CURTAIN[1], i / 12))
      const outline = [...xs.map((x) => at(x, wellY(x) + DOI, -0.2)), ...xs.reverse().map((x) => at(x, wellY(x) - DOI, -0.2))]
      hud.blackBox(ctx, outline, box, ramp(t, T.open, T.open + 0.7), 'SERVICE-COMPANY SOFTWARE')
    }
    hud.checklist(ctx, W - 560, 96, ['New inversion methods', 'New features'], window_(t, T.methods + 0.2, T.card, 0.5),
      ramp(t, T.open + 0.9, T.open + 1.5))
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
    for (const [t0, t1, main, sub] of CAPTIONS) hud.caption(ctx, main, sub, window_(t, t0, t1, 0.4))
    hud.title(ctx, 'resist', 'Resistivity QC and inversion on released Ekofisk data', ramp(t, T.card, T.card + 0.9), 0.62)
    hud.fade(ctx, 1 - ramp(t, 0, 0.8))
    hud.fade(ctx, ramp(t, DURATION - 0.6, DURATION - 0.05))
    return ok
  }

  return { renderAt }
}
