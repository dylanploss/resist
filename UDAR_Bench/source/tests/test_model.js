'use strict';
const C = require('./load_core.js')();
const { Engine, HANKEL_FILTERS, makeStation, buildTrajectory, buildLocal1D, prepChannels, evalStation, D2R } = C;
const F = HANKEL_FILTERS.key_201_2012;
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const U = (a, b) => a + (b - a) * rnd();
const cx = { mul: (a, b) => [a[0]*b[0]-a[1]*b[1], a[0]*b[1]+a[1]*b[0]], add: (a,b)=>[a[0]+b[0],a[1]+b[1]], sc:(a,s)=>[a[0]*s,a[1]*s] };
function cexpi(re, im) { const e = Math.exp(re); return [e*Math.cos(im), e*Math.sin(im)]; }

// ---- Test 1: homogeneous isotropic medium (3 identical layers) vs Jackson 9.35 (e^{-iwt}) for random geometry/antennas
let worst1 = 0;
for (let it = 0; it < 300; it++) {
  const res = 10 ** U(-0.3, 2.3), f = [400, 2000, 12000, 24000, 100000][Math.floor(rnd() * 5)], L = (rnd() < 0.5 ? -1 : 1) * U(1, 30);
  const geo1 = { dip: U(0, 60), dipAz: U(0, 360), z0: U(-5, 5), layers: [{ rh: res, rv: res }, { rh: res, rv: res, tvt: U(1, 6) }, { rh: res, rv: res }] };
  const loc = buildLocal1D(geo1);
  const inc = U(0, 180) , az = U(0, 360), tf = U(0, 360);
  const st = makeStation({ md: [0, 1], N: [0, 0], E: [0, 0], D: [0, 0], inc: [inc * D2R, inc * D2R], az: [az * D2R, az * D2R] }, 0, tf);
  st.r = [U(-3, 3), U(-3, 3), U(-3, 8)];
  const tx = { k: 'T', th: U(0, 180), ph: U(0, 360) }, rx = { k: 'T', th: U(0, 180), ph: U(0, 360) };
  const chans = [{ L, f, tx, rx }];
  const pch = prepChannels(chans), out = new Float64Array(2);
  evalStation(st, loc, pch, F, out);
  // Jackson: field at receiver, along tool z (rhat = sign(L) zt), distance |L|, source moment a (tool frame)
  const w = 2 * Math.PI * f, MU = 4e-7 * Math.PI, sig = 1 / res;
  const kk = Math.sqrt(0.5 * w * MU * sig); // k = kk(1+i)
  const R = Math.abs(L), rh = [0, 0, Math.sign(L)], a = pch[0].a, b = pch[0].b;
  const ra = rh[2] * a[2];
  // (n x a) x n = a - n (n.a)
  const perp = [a[0] - rh[0]*ra, a[1] - rh[1]*ra, a[2] - rh[2]*ra];
  const ph = cexpi(-kk * R, kk * R);           // e^{ikR}, k=kk(1+i)
  const k2 = [0, 2 * kk * kk];                 // k^2 = i w mu sigma
  const c1 = [1/R**3 + kk/R**2, -kk/R**2 + 0];  // 1/R^3 - i k /R^2 = 1/R^3 - i kk(1+i)/R^2 = (1/R^3 + kk/R^2) - i kk/R^2
  c1[1] = -kk / R ** 2;
  const Hv = [0, 1, 2].map(i => {
    const sph = [3 * rh[i] * ra - a[i], 0]; // 3 n (n.a) - a
    const t1 = cx.sc(cx.mul(k2, [1, 0]), perp[i] / R);                 // k^2/R * perp
    const t2 = cx.mul(sph, c1);
    return cx.sc(cx.mul(ph, cx.add(t1, t2)), 1 / (4 * Math.PI));
  });
  const jv = [0, 1].map(c => b[0] * Hv[0][c] + b[1] * Hv[1][c] + b[2] * Hv[2][c]);
  const sc = 2 * Math.PI * R ** 3;
  const e = Math.hypot(out[0] - jv[0] * sc, out[1] - jv[1] * sc);
  // error relative to the largest coupling scale (1 for normalised ZZ vac) 
  worst1 = Math.max(worst1, e);
}
console.log('Test1 homogeneous-isotropic vs Jackson: max abs err of normalised coupling =', worst1.toExponential(2));

// ---- Test 2: reciprocity (layered TIV, dipping, random orientations): channel(L,a,b) == channel(-L,b,a)
let worst2 = 0;
for (let it = 0; it < 200; it++) {
  const N = 2 + Math.floor(rnd() * 4);
  const layers = []; for (let k = 0; k < N; k++) layers.push({ rh: 10 ** U(-0.3, 2.5), rv: 0, tvt: U(1.5, 12) }); layers.forEach(l => l.rv = l.rh * U(1, 4));
  const geo1 = { dip: U(0, 80), dipAz: U(0, 360), z0: U(-10, 10), layers };
  const loc = buildLocal1D(geo1);
  const inc = U(0, 180), az = U(0, 360), tf = U(0, 360);
  const st = makeStation({ md: [0, 1], N: [0, 0], E: [0, 0], D: [0, 0], inc: [inc * D2R, inc * D2R], az: [az * D2R, az * D2R] }, 0, tf);
  st.r = [U(-3, 3), U(-3, 3), U(-6, 14)];
  const tx = { k: 'T', th: U(0, 180), ph: U(0, 360) }, rx = { k: 'T', th: U(0, 180), ph: U(0, 360) };
  const L = U(1, 25), f = [2000, 12000, 100000][Math.floor(rnd() * 3)];
  const o1 = new Float64Array(2), o2 = new Float64Array(2);
  evalStation(st, loc, prepChannels([{ L, f, tx, rx }]), F, o1);
  evalStation(st, loc, prepChannels([{ L: -L, f, tx: rx, rx: tx }]), F, o2);
  worst2 = Math.max(worst2, Math.hypot(o1[0] - o2[0], o1[1] - o2[1]));
}
console.log('Test2 reciprocity: max abs diff of normalised coupling =', worst2.toExponential(2));

// ---- Test 3: toolface rotation invariants (xx+yy trace, zz unchanged) & azimuth-rotation invariance
let worst3 = 0, worst4 = 0;
for (let it = 0; it < 100; it++) {
  const N = 3; const layers = []; for (let k = 0; k < N; k++) layers.push({ rh: 10 ** U(-0.3, 2.5), rv: 0, tvt: U(2, 10) }); layers.forEach(l => l.rv = l.rh * U(1, 3));
  const dip = U(0, 70), dipAz = U(0, 360), z0 = U(-8, 8);
  const inc = U(20, 160), az = U(0, 360), L = U(2, 20), f = 24000;
  const mk = (tfd, azz, dza) => {
    const st = makeStation({ md: [0, 1], N: [0, 0], E: [0, 0], D: [0, 0], inc: [inc * D2R, inc * D2R], az: [azz * D2R, azz * D2R] }, 0, tfd);
    const c = Math.cos(dza * D2R), s = Math.sin(dza * D2R); const p0 = [2, -1, 3];
    st.r = [c * p0[0] - s * p0[1], s * p0[0] + c * p0[1], p0[2]];
    return st;
  };
  const chs = ['X','Y','Z'].map(k => ({ L, f, tx: { k }, rx: { k } }));
  const run = (tfd, rot) => { const loc = buildLocal1D({ dip, dipAz: dipAz + rot, z0, layers }); const o = new Float64Array(6); evalStation(mk(tfd, az + rot, rot), loc, prepChannels(chs), F, o); return o; };
  const a = run(0, 0), b = run(U(0, 360), 0);
  worst3 = Math.max(worst3, Math.abs(a[0] + a[2] - b[0] - b[2]), Math.abs(a[1] + a[3] - b[1] - b[3]), Math.abs(a[4] - b[4]), Math.abs(a[5] - b[5]));
  const c = run(30, 0), d = run(30, 77.7);
  for (let i = 0; i < 6; i++) worst4 = Math.max(worst4, Math.abs(c[i] - d[i]));
}
console.log('Test3 toolface trace invariance: ', worst3.toExponential(2), '  Test4 rotation about vertical axis invariance:', worst4.toExponential(2));
