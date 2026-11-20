// The illustrative layered earth around the horizontal well in the tool scene, in JS and (identically) in GLSL.
// Local frame: x along the well (drilling direction), y up, z across. The tool axis is y = 0, z = 0. Metres.
//
// Wave picture: a wave from the transmitter reaches point p with phase tau = integral of k ds along the straight
// path, k = K0 / sqrt(rho), and amplitude exp(-ETA * tau). That keeps the real trends of skin depth
// (503 * sqrt(rho / f) metres): wavelength, speed and reach all grow with sqrt(rho). K0 and ETA are chosen for
// visibility, not for a real frequency: real 2 MHz wavelengths in 100 ohm.m rock are ~25 m, and a real wave dies
// within about one wavelength.

// Layers from top to bottom; BOUNDARIES[i] separates layer i (above) from layer i + 1 (below).
export const LAYERS = [
  { rho: 2.5, label: 'Conductive cap', note: '2.5 Ω·m' },
  { rho: 25, label: 'Tight rock', note: '25 Ω·m' },
  { rho: 120, label: 'Resistive reservoir', note: '120 Ω·m' },
  { rho: 8, label: 'Transition zone', note: '8 Ω·m' },
  { rho: 1.2, label: 'Conductive, water-filled rock', note: '1.2 Ω·m' },
]
export const K0 = 21.5
export const ETA = 0.095
export const RHO_MIN = 1
export const RHO_MAX = 300
export const DOI = 4.6 // half-height of the inverted curtain around the well, metres (the app's default is 15 ft)
export const COLUMN = 0.8 // width of one inverted 1D model along the well, metres

// Per-film variations, set before the tool scene is created (its shaders bake these in).
//   dip:   extra depth (m) of the dip in the reservoir roof around x = 38 (the floor follows by half of it), so a
//          straight well would leave the reservoir
//   steer: how far (m) the well is steered down between steerFrom and steerTo to stay inside it
export const model = { dip: 0, steer: 0, steerFrom: 20, steerTo: 46 }

// Height of the well axis at x, and its slope.
export function wellY(x) {
  const u = Math.min(1, Math.max(0, (x - model.steerFrom) / (model.steerTo - model.steerFrom)))
  return -model.steer * u * u * (3 - 2 * u)
}
export function wellSlope(x) {
  const span = model.steerTo - model.steerFrom
  const u = Math.min(1, Math.max(0, (x - model.steerFrom) / span))
  return (-model.steer * 6 * u * (1 - u)) / span
}

export function bnd(i, x) {
  if (i === 0) return 4.4 + 0.45 * Math.sin(0.085 * x + 1.0)
  if (i === 1) {
    const g = (x - 38) / 9
    return 1.9 - (1.25 + model.dip) * Math.exp(-g * g) + 0.22 * Math.sin(0.21 * x + 0.5)
  }
  if (i === 2) {
    const g = (x - 38) / 9
    return -1.7 + 0.4 * Math.sin(0.12 * x + 2.0) - 0.012 * x - 0.5 * model.dip * Math.exp(-g * g)
  }
  return -3.9 + 0.35 * Math.sin(0.07 * x + 4.0)
}

export function layerAt(x, y) {
  if (y > bnd(0, x)) return 0
  if (y > bnd(1, x)) return 1
  if (y > bnd(2, x)) return 2
  if (y > bnd(3, x)) return 3
  return 4
}

export const rhoAt = (x, y) => LAYERS[layerAt(x, y)].rho
export const kAt = (x, y) => K0 / Math.sqrt(rhoAt(x, y))

// Phase delay between two points of the section (straight path, midpoint rule).
export function tauBetween(ax, ay, bx, by, steps = 64) {
  const dx = (bx - ax) / steps
  const dy = (by - ay) / steps
  const len = Math.hypot(dx, dy)
  let tau = 0
  for (let i = 0; i < steps; i++) tau += kAt(ax + dx * (i + 0.5), ay + dy * (i + 0.5)) * len
  return tau
}

// Resistivity colours sampled from "figures for video/EM colours.png": purple (conductive) to dark red (resistive).
export const PALETTE = [
  [0.0, [70, 8, 150]], [0.1, [90, 5, 207]], [0.22, [40, 70, 225]], [0.36, [4, 196, 251]], [0.5, [29, 211, 5]],
  [0.64, [253, 246, 12]], [0.78, [250, 140, 20]], [0.9, [215, 20, 15]], [1.0, [130, 0, 0]],
]
export const rhoToT = (rho) => Math.min(1, Math.max(0, Math.log(rho / RHO_MIN) / Math.log(RHO_MAX / RHO_MIN)))

export function paletteRgb(t) {
  const x = Math.min(1, Math.max(0, t))
  let k = 1
  while (k < PALETTE.length - 1 && x > PALETTE[k][0]) k++
  const [p0, c0] = PALETTE[k - 1]
  const [p1, c1] = PALETTE[k]
  const f = (x - p0) / (p1 - p0)
  return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * f))
}

const f = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`)
const paletteGlsl = PALETTE.slice(1).map(([p1, c1], i) => {
  const [p0, c0] = PALETTE[i]
  const v = (c) => `vec3(${c.map((x) => f(x / 255)).join(', ')})`
  return `  if (t <= ${f(p1)}) return mix(${v(c0)}, ${v(c1)}, (t - ${f(p0)}) / ${f(p1 - p0)});`
}).join('\n')

// GLSL copy of the model above, with the current per-film variations baked in.
export const earthGlsl = () => /* glsl */ `
const float K0 = ${f(K0)};
const float ETA = ${f(ETA)};
const float DOI = ${f(DOI)};
const float COLUMN = ${f(COLUMN)};
const float RHO[5] = float[5](${LAYERS.map((l) => f(l.rho)).join(', ')});

float bnd(int i, float x) {
  if (i == 0) return 4.4 + 0.45 * sin(0.085 * x + 1.0);
  if (i == 1) { float g = (x - 38.0) / 9.0; return 1.9 - ${f(1.25 + model.dip)} * exp(-g * g) + 0.22 * sin(0.21 * x + 0.5); }
  if (i == 2) { float g = (x - 38.0) / 9.0; return -1.7 + 0.4 * sin(0.12 * x + 2.0) - 0.012 * x - ${f(0.5 * model.dip)} * exp(-g * g); }
  return -3.9 + 0.35 * sin(0.07 * x + 4.0);
}
float wellY(float x) {
  float u = clamp((x - ${f(model.steerFrom)}) / ${f(model.steerTo - model.steerFrom)}, 0.0, 1.0);
  return -${f(model.steer)} * u * u * (3.0 - 2.0 * u);
}
int layerAt(vec2 p) {
  if (p.y > bnd(0, p.x)) return 0;
  if (p.y > bnd(1, p.x)) return 1;
  if (p.y > bnd(2, p.x)) return 2;
  if (p.y > bnd(3, p.x)) return 3;
  return 4;
}
float kAt(vec2 p) { return K0 * inversesqrt(RHO[layerAt(p)]); }
float tauBetween(vec2 a, vec2 b) {
  const int N = 56;
  vec2 d = (b - a) / float(N);
  float len = length(d);
  float tau = 0.0;
  for (int i = 0; i < N; i++) tau += kAt(a + d * (float(i) + 0.5)) * len;
  return tau;
}
// sRGB palette stop colours; convert with toLinear before lighting maths.
vec3 palette(float t) {
  t = clamp(t, 0.0, 1.0);
${paletteGlsl}
  return vec3(${PALETTE.at(-1)[1].map((x) => f(x / 255)).join(', ')});
}
float rhoToT(float rho) { return clamp(log(rho / ${f(RHO_MIN)}) / log(${f(RHO_MAX / RHO_MIN)}), 0.0, 1.0); }
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
float hash11(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453123); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.3; a *= 0.5; }
  return s;
}
`
