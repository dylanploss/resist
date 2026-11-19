// Check that components/well3d/colormap.js reproduces the Jet and RdBu scales of the installed Plotly bundle.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NULL_RGB, PLOTLY_SCALES, colorFn } from '../src/components/well3d/colormap.js'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'node_modules', 'plotly.js-dist-min', 'plotly.min.js')
const bundle = readFileSync(bundlePath, 'utf8')
const problems = []

function plotlyStops(name) {
  const match = bundle.match(new RegExp(`[{,]${name}:(\\[\\[[^\\]]*\\](?:,\\[[^\\]]*\\])*\\])`))
  if (!match) throw new Error(`${name} scale not found in ${bundlePath}`)
  const json = match[1].replace(/([[,])\./g, '$10.')
  return JSON.parse(json).map(([p, css]) => [p, css.match(/\d+/g).slice(0, 3).map(Number)])
}

// Plotly's flipScale walks the stops backwards with p -> 1 - p; fail if the bundle stops doing that.
if (!/\[\w+\]=\[1-(\w+)\[0\],\1\[1\]\]/.test(bundle)) problems.push('Plotly flipScale pattern [1 - p, colour] not found')

// Independent reference: d3 polylinear scale with clamping over the RGB channels.
function reference(stops, t) {
  const x = Math.min(1, Math.max(0, t))
  let k = stops.findIndex(([p], i) => i > 0 && x <= p)
  if (k < 1) k = stops.length - 1
  const [p0, c0] = stops[k - 1]
  const [p1, c1] = stops[k]
  return c0.map((c, j) => Math.round(c + (c1[j] - c) * ((x - p0) / (p1 - p0))))
}

for (const name of ['Jet', 'RdBu']) {
  const ours = PLOTLY_SCALES[name]
  const theirs = plotlyStops(name)
  if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
    problems.push(`${name} stops differ\n  ours:   ${JSON.stringify(ours)}\n  plotly: ${JSON.stringify(theirs)}`)
    continue
  }
  for (const reverse of [false, true]) {
    const stops = reverse ? theirs.slice().reverse().map(([p, c]) => [1 - p, c]) : theirs
    const linear = colorFn({ scale: name, reverse, log10: false, zmin: -2, zmax: 2 })
    const log = colorFn({ scale: name, reverse, log10: true, zmin: -1, zmax: 3 })
    for (let i = -10; i <= 210; i++) {
      const t = i / 200
      const want = reference(stops, t)
      const got = [linear(-2 + 4 * t), log(10 ** (-1 + 4 * t))]
      got.forEach((rgb, g) => {
        if (rgb.some((v, j) => Math.abs(v - want[j]) > 1)) {
          problems.push(`${name}${reverse ? ' reversed' : ''} ${g ? 'log10' : 'linear'} t=${t}: ${rgb} vs plotly ${want}`)
        }
      })
    }
    for (const bad of [null, undefined, Number.NaN, Infinity]) {
      if (linear(bad) !== NULL_RGB) problems.push(`${name}: ${bad} is not mapped to the null colour`)
    }
    if (log(0) !== NULL_RGB || log(-1) !== NULL_RGB) problems.push(`${name}: non-positive log10 value is not null`)
  }
}

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('Colour map matches Plotly Jet and RdBu (stops, reversescale, linear and log10 sampling).')
