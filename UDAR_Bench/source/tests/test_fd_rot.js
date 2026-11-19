'use strict';
// End-to-end check of the 2.5D difference path including tool-frame rotations and TTI anisotropy:
// true model = planar dipping layers (dip a), baseline = the same layers with a wrong dip b (rotated about the points above/below the tool).
// Exact: H_1D(dip a) - H_1D(dip b) from the layered-earth engine.  FD: planGroup/runGroup with the wrong-dip baseline.
const load = require('./load_core.js');
const C = load(['fdsolve.js', 'fd25d.js', 'fdorch.js'], ['FD', 'FDSolve', 'FDORCH', 'layerProps2D', 'horizonZ', 'dipNormal']);
const { FD, FDORCH, buildTrajectory, makeStation, buildLocal2D, prepChannels, evalStation, HANKEL_FILTERS, chanFromT, v3, D2R, dipNormal, layerProps2D } = C;
const opt = JSON.parse(process.argv[2] || '{}');
const dipA = +(process.env.DIPA || 4), dipB = +(process.env.DIPB || 7), inc = +(process.env.INC || 86), tf = +(process.env.TF || 30);
const sA = Math.tan(dipA * D2R);
const geo2 = { azSec: 0, horizons: [{ pts: [[-2000, 2000 - 2000 * sA], [2000, 2000 + 2000 * sA]] }, { pts: [[-2000, 2010 - 2000 * sA], [2000, 2010 + 2000 * sA]] }],
  layers: process.env.ISO ? [{ rh: [[0, 2]], rv: [[0, 2]] }, { rh: [[0, 60]], rv: [[0, 60]] }, { rh: [[0, 2]], rv: [[0, 2]] }] : [{ rh: [[0, 2]], rv: [[0, 3]] }, { rh: [[0, 60]], rv: [[0, 80]] }, { rh: [[0, 2]], rv: [[0, 3]] }] };
const tr = buildTrajectory({ md0: 0, N0: -50 * Math.sin(inc * D2R), E0: 0, D0: 2005 - 50 * Math.cos(inc * D2R), inc0: inc, az0: 0, sections: [{ len: 100, incEnd: inc, azEnd: 0 }] }, 0.5);
const st = makeStation(tr, 50, tf);
function locWithDip(dipDeg) {      // buildLocal2D with an imposed dip (planes through the horizon points at the tool x)
  const l = buildLocal2D(geo2, st, 5), xm = st.r[0], ds = dipDeg * D2R, nrm = dipNormal(Math.abs(ds), ds >= 0 ? 0 : Math.PI);
  const zh = C.horizonZ(geo2, xm), zi = new Float64Array(zh.length); for (let k = 0; k < zh.length; k++) zi[k] = v3.dot(nrm, [xm, 0, zh[k]]);
  return Object.assign({}, l, { nrm, zi, zm: v3.dot(nrm, [xm, 0, st.r[2]]), dip: Math.abs(ds), dipAz: ds >= 0 ? 0 : Math.PI });
}
const locA = buildLocal2D(geo2, st, 5), locB = locWithDip(dipB);
console.log('true dip from buildLocal2D', (locA.dip / D2R).toFixed(3), 'deg; wrong-dip baseline', dipB, 'deg');
const comps = ['ZZ', 'XX', 'YY', 'ZX', 'XZ', 'XY', 'YX', 'YZ', 'ZY'];
const chans = []; for (const [L, f] of [[16, 24000], [30, 6000]]) for (const c of comps) chans.push({ L, f, tx: { k: c[0] }, rx: { k: c[1] }, name: c + ' ' + L + 'm ' + f / 1000 + 'kHz' });
const pch = prepChannels(chans), filt = HANKEL_FILTERS.key_201_2012, oA = new Float64Array(2 * chans.length), oB = new Float64Array(2 * chans.length);
evalStation(st, locA, pch, filt, oA, locA.zm); evalStation(st, locB, pch, filt, oB, locB.zm);
const cfg = { geo2, channels: chans }, fr = FDORCH.secFrame(cfg), sa = FDORCH.stationAxis(cfg, st), mid = [st.r[0], st.r[2]];
let worst = 0; const t0 = Date.now(); const rows = [];
for (const f of [24000, 6000]) {
  const Ls = [f === 24000 ? 16 : 30], plan = FD.planGroup(geo2, locB, mid, sa.ax, Ls.map((L) => ({ L, f })), opt);
  if (plan.skip) { console.log('skip?!'); continue; }
  const r = FD.runGroup(plan), sc = 2 * Math.PI * Ls[0] ** 3, T = Array.from(r.delta, (v) => v * sc);
  let dmax = 0, emax = 0;
  chans.forEach((c, i) => {
    if (c.f !== f) return; const v = chanFromT(T, FDORCH.antSec(st, fr, pch[i].a), FDORCH.antSec(st, fr, pch[i].b));
    const ex = [oA[2 * i] - oB[2 * i], oA[2 * i + 1] - oB[2 * i + 1]]; dmax = Math.max(dmax, Math.hypot(ex[0], ex[1])); emax = Math.max(emax, Math.hypot(v[0] - ex[0], v[1] - ex[1]));
    rows.push([c.name, ex[0].toExponential(3), ex[1].toExponential(3), v[0].toExponential(3), v[1].toExponential(3)]);
  });
  console.log('f', f, 'h0', r.info.h0.toFixed(3), 'nodes', r.info.nodes, 'quality', r.info.quality.toFixed(2), 'max|delta|', dmax.toExponential(3), 'max err', emax.toExponential(3), 'rel', (100 * emax / dmax).toFixed(2) + '%');
  worst = Math.max(worst, emax / dmax);
}
if (process.env.VERBOSE) for (const r of rows) console.log(r.join('  '));
console.log('worst rel err ' + (100 * worst).toFixed(2) + '%  time ' + (Date.now() - t0) + ' ms');
