// Entry point. No query: live preview with a scrub bar. ?stills=t1,t2: post half-size JPEG stills to the render
// script. ?render=1[&from=..&to=..]: encode the MP4 with WebCodecs and post it to the render script.
import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import { FPS, H, W } from './common.js'

const params = new URLSearchParams(location.search)
// ?film=problem selects the problem-statement version (filmProblem.js); the default is the original film.
const { DURATION, OUTPUT, createFilm } = await import(params.get('film') === 'problem' ? './filmProblem.js' : './film.js')
const post = (path, body) => fetch(path, { method: 'POST', body })
const headless = ['stills', 'render', 'check'].some((k) => params.has(k))
const log = (message) => (headless ? post('/log', message) : console.log(message))
const fail = async (error) => {
  await log(`ERROR ${error?.stack ?? error}`)
  if (headless) await post('/done', 'failed')
}
if (headless) {
  for (const level of ['error', 'warn']) {
    const original = console[level]
    console[level] = (...args) => { original(...args); post('/log', `console.${level}: ${args.map(String).join(' ').slice(0, 1500)}`) }
  }
}
window.addEventListener('error', (e) => fail(e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => fail(e.reason))

const canvas3d = document.createElement('canvas')
const comp = document.getElementById('frame')
comp.width = W
comp.height = H
const ctx = comp.getContext('2d')
const well = await (await fetch('./data/well.json')).json()
const film = createFilm({ canvas3d, ctx, well })

async function stills(times) {
  const small = document.createElement('canvas')
  small.width = W / 2
  small.height = H / 2
  const g = small.getContext('2d')
  for (const t of times) {
    const t0 = performance.now()
    if (!film.renderAt(t)) await log(`BLANK 3D FRAME at ${t}`)
    g.drawImage(comp, 0, 0, small.width, small.height)
    const blob = await new Promise((r) => small.toBlob(r, 'image/jpeg', 0.88))
    await post(`/out/still_${t.toFixed(2).padStart(5, '0')}.jpg`, blob)
    await log(`still ${t} in ${(performance.now() - t0).toFixed(0)} ms`)
  }
}

async function render(from, to) {
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H, frameRate: FPS }, fastStart: 'in-memory' })
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail })
  encoder.configure({ codec: 'avc1.640028', width: W, height: H, bitrate: 10e6, framerate: FPS, latencyMode: 'quality', avc: { format: 'avc' } })
  const first = Math.round(from * FPS)
  const last = Math.round(to * FPS)
  const started = performance.now()
  let blanks = 0
  for (let f = first; f < last; f++) {
    if (!film.renderAt(f / FPS)) { blanks++; await log(`BLANK 3D FRAME at ${(f / FPS).toFixed(3)} s`) }
    const frame = new VideoFrame(comp, { timestamp: Math.round(((f - first) * 1e6) / FPS), duration: Math.round(1e6 / FPS) })
    encoder.encode(frame, { keyFrame: (f - first) % FPS === 0 })
    frame.close()
    while (encoder.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 2))
    if ((f - first) % 150 === 149) await log(`frame ${f - first + 1}/${last - first}, ${((performance.now() - started) / (f - first + 1)).toFixed(0)} ms/frame`)
  }
  await log(`${last - first} frames rendered, ${blanks} blank`)
  await encoder.flush()
  muxer.finalize()
  const name = from === 0 && to === DURATION ? OUTPUT : `clip_${from}_${to}_${OUTPUT}`
  await post(`/out/${name}`, new Blob([muxer.target.buffer]))
}

// Renders every frame without encoding and reports blank ones.
async function check() {
  let blanks = 0
  const started = performance.now()
  for (let f = 0; f < DURATION * FPS; f++) {
    if (!film.renderAt(f / FPS)) { blanks++; await log(`BLANK 3D FRAME at ${(f / FPS).toFixed(3)} s`) }
    if (f % 30 === 0) await new Promise((r) => setTimeout(r, 0))
  }
  await log(`checked ${DURATION * FPS} frames in ${((performance.now() - started) / 1000).toFixed(0)} s: ${blanks} blank`)
}

function preview() {
  const bar = document.getElementById('bar')
  const slider = document.getElementById('time')
  const button = document.getElementById('play')
  const readout = document.getElementById('readout')
  bar.hidden = false
  slider.max = DURATION
  let playing = true
  let t = 0
  let last = performance.now()
  button.onclick = () => { playing = !playing; button.textContent = playing ? 'Pause' : 'Play' }
  slider.oninput = () => { t = Number(slider.value) }
  const tick = (now) => {
    if (playing) t = (t + (now - last) / 1000) % DURATION
    last = now
    if (playing) slider.value = t
    readout.textContent = `${t.toFixed(1)} s`
    film.renderAt(t)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

try {
  if (params.has('stills')) {
    await stills(params.get('stills').split(',').map(Number))
    await post('/done', 'ok')
  } else if (params.has('check')) {
    await check()
    await post('/done', 'ok')
  } else if (params.has('render')) {
    await render(Number(params.get('from') ?? 0), Number(params.get('to') ?? DURATION))
    await post('/done', 'ok')
  } else preview()
} catch (error) {
  await fail(error)
}
