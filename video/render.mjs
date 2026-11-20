// Renders the explainer video with the installed Google Chrome (headless): no ffmpeg needed.
// The page (index.html + scene.js) draws every frame deterministically, encodes H.264 with WebCodecs,
// muxes an MP4 with mp4-muxer and POSTs the file back to this script, which writes it to video/out/.
//
//   node video/render.mjs stills 2,10,24.5     -> video/out/still_<t>.png   (quick look at single frames)
//   node video/render.mjs video                -> video/out/well_em_inversion.mp4
//   node video/render.mjs video 20 30          -> only seconds 20-30 (video/out/clip_20_30.mp4)
//   node video/render.mjs check                -> render every frame without encoding, report blank (NaN) frames
//   Add --problem to any of these for the problem-statement version (out/geosteering_problem.mp4).
//   node video/render.mjs serve                -> just serve; open the printed URL in Chrome to preview live
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, 'out')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' }

const film = process.argv.includes('--problem') ? '&film=problem' : ''
const [mode = 'video', a, b] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
mkdirSync(OUT, { recursive: true })

let finish
const done = new Promise((r) => { finish = r })

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'POST') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (url.pathname === '/log') console.log(body.toString())
      else if (url.pathname === '/done') finish(body.toString())
      else if (url.pathname.startsWith('/out/')) {
        const file = join(OUT, basename(decodeURIComponent(url.pathname)))
        writeFileSync(file, body)
        console.log(`wrote ${file} (${(body.length / 1e6).toFixed(2)} MB)`)
      }
      res.writeHead(204).end()
    })
    return
  }
  const path = normalize(join(ROOT, decodeURIComponent(url.pathname)))
  if (!path.startsWith(ROOT) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  createReadStream(path).pipe(res)
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/video/${process.env.PAGE ?? "index.html"}`

if (mode === 'serve') {
  console.log(`preview: ${base}  (problem version: ${base}?film=problem)`)
} else {
  const query = (mode === 'stills' ? `?stills=${a ?? '0'}` : mode === 'check' ? '?check=1' : `?render=1${a ? `&from=${a}&to=${b}` : ''}`) + film
  const profile = mkdtempSync(join(tmpdir(), 'resist-video-'))
  const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1920,1080', '--hide-scrollbars', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', base + query], { stdio: 'ignore' })
  const started = Date.now()
  const result = await Promise.race([done, new Promise((r) => chrome.on('exit', () => r('chrome exited early')))])
  console.log(`${result} after ${((Date.now() - started) / 1000).toFixed(0)} s`)
  chrome.kill()
  await new Promise((r) => setTimeout(r, 500))
  rmSync(profile, { recursive: true, force: true })
  server.close()
  process.exit(result === 'ok' ? 0 : 1)
}
