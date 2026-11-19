'use strict';
// Runs the complete 2.5D pipeline (local-1D pass + FD rounds + assembly) in Node on the default 2D preset,
// then checks the interpolation by solving a few extra stations directly.
const fs = require('fs'), path = require('path');
const core = ['filters.js', 'engine1d.js', 'model.js', 'fdsolve.js', 'fd25d.js', 'fdorch.js', 'invert.js', 'jobs.js'].map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
const fdrun = fs.readFileSync(path.join(__dirname, '..', 'app', 'fdrun.js'), 'utf8');
const C = new Function('"use strict";\n' + core + '\n' + fdrun + '\nreturn { handleJob, runFD2D, fdPlanPreview, buildTrajectory, stationList, FDORCH, forwardRange };')();
const preset = process.env.PRESET || 'sand';
const G = {
  sand: { azSec: 0, horizons: [[[-50, 2001], [0, 2000], [80, 1997.5], [160, 1994.8], [240, 1993.2], [320, 1993.8], [420, 1996]], [[-50, 2009], [0, 2008], [80, 2005.3], [160, 2002.6], [240, 2001.2], [320, 2001.6], [420, 2004]]], props: [[[0, 2, 3]], [[-50, 60, 80], [260, 60, 80], [300, 20, 28]], [[0, 2, 3]]] },
  fault: { azSec: 0, horizons: [[[-50, 2002], [150, 1998.6], [150, 1992.6], [420, 1990]], [[-50, 2010], [150, 2006.6], [150, 2000.6], [420, 1998]]], props: [[[0, 2, 3]], [[0, 60, 80]], [[0, 2, 3]]] },
}[preset];
const geo2 = { azSec: G.azSec, horizons: G.horizons.map(p => ({ pts: p })), layers: G.props.map(pr => ({ rh: pr.map(p => [p[0], p[1]]), rv: pr.map(p => [p[0], p[2]]) })) };
const comps = ['ZZ', 'ZX', 'XZ', 'XX'], channels = [];
[[8, 100], [16, 24], [30, 6]].forEach(([L, f]) => comps.forEach(c => channels.push({ L, f: f * 1000, tx: { k: c[0], th: 0, ph: 0 }, rx: { k: c[1], th: 0, ph: 0 }, name: c + ' ' + L })));
const q = process.env.Q || 'std';
const cfg = { traj: { md0: 0, N0: 0, E0: 0, D0: 1993, inc0: 88, az0: 0, sections: [{ len: 150, incEnd: 90, azEnd: 0 }, { len: 150, incEnd: 92, azEnd: 0 }] }, tf: 0, mdStart: +(process.env.MDA || 20), mdEnd: +(process.env.MDB || 280), mdStep: 2,
  channels, mode: '2d', geo1: null, geo2, filter: 'key_201_2012', slopeWin: 5, eng2d: 'fd', fd: { q, step: +(process.env.STEP || 25) } };
const tr = C.buildTrajectory(cfg.traj, 0.5), st = C.stationList(cfg, tr), nSt = st.length, nch = channels.length;
const base = new Float64Array(nSt * nch * 2); C.forwardRange(cfg, tr, st, 0, nSt, base);
const pre = C.fdPlanPreview(cfg, st);
console.log('preset', preset, 'stations', nSt, 'segments', pre.an.segs.length, 'initial FD stations', pre.idx.length, 'jobs', pre.jobs, 'quality', q);
const app = { runToken: 1, pool: { n: 1, async run(type, payloads, onp) { const out = []; for (let i = 0; i < payloads.length; i++) { out.push(C.handleJob(type, payloads[i], () => {})); onp((i + 1) / payloads.length); } return out; } } };
(async () => {
  const t0 = Date.now();
  const r = await C.runFD2D(app, cfg, st, base, 1, () => {});
  console.log('pipeline done in', ((Date.now() - t0) / 1000).toFixed(1), 's; FD stations', r.idx.length, 'solves', r.summary.jobs, 'skipped', r.summary.skipped, 'qmin', r.summary.qmin && r.summary.qmin.toFixed(2), 'poor', r.summary.poor.length, 'maxNodes', r.summary.maxNodes);
  console.log('FD station MDs:', r.idx.map(i => st[i].md).join(' '));
  if (process.env.SAVE) fs.writeFileSync(process.env.SAVE, JSON.stringify({ md: st.map(s => s.md), data: Array.from(r.data), base: Array.from(base), idx: r.idx, nch }));
  if (process.env.REF) {         // compare with a dense reference run (FD at every station)
    const R = JSON.parse(fs.readFileSync(process.env.REF, 'utf8')); let e = 0, emd = 0, dm = 0;
    for (let i = 0; i < nSt; i++) for (let c = 0; c < nch; c++) { const k = 2 * (i * nch + c), ee = Math.hypot(r.data[k] - R.data[k], r.data[k + 1] - R.data[k + 1]); if (ee > e) { e = ee; emd = st[i].md; } dm = Math.max(dm, Math.hypot(R.data[k] - base[k], R.data[k + 1] - base[k + 1])); }
    console.log('vs dense reference: max |interpolated - solved| =', e.toExponential(3), 'at MD', emd, '; max |correction| =', dm.toExponential(3));
  }
  // size of the correction
  let dmax = 0, dbmax = 0;
  for (let i = 0; i < nSt; i++) for (let c = 0; c < nch; c++) { const k = 2 * (i * nch + c); const a = Math.hypot(r.data[k], r.data[k + 1]), b = Math.hypot(base[k], base[k + 1]); dmax = Math.max(dmax, Math.hypot(r.data[k] - base[k], r.data[k + 1] - base[k + 1])); if (a > 1e-6 && b > 1e-6) dbmax = Math.max(dbmax, Math.abs(20 * Math.log10(a / b))); }
  console.log('max |2D - local 1D| (normalised)', dmax.toExponential(3), ' max amplitude difference', dbmax.toFixed(3), 'dB');
  // interpolation check: solve directly at stations halfway between FD stations
  const test = []; for (let q2 = 0; q2 + 1 < r.idx.length && test.length < (+process.env.NCHK || 4); q2 += Math.max(1, Math.floor(r.idx.length / 4))) { const m = Math.round((r.idx[q2] + r.idx[q2 + 1]) / 2); if (m !== r.idx[q2] && m !== r.idx[q2 + 1]) test.push(m); }
  const grp = C.FDORCH.groups(cfg), opt = C.FDORCH.options(cfg);
  for (const i of test) {
    const v = new Float64Array(grp.pairs.length * 10);
    for (const g of grp.byF) { const res = C.handleJob('fdst', { cfg, md: st[i].md, f: g.f, Ls: g.Ls, opt: opt.fd }, () => {}); if (!res.skip) g.pidx.forEach((p, m) => { for (let k = 0; k < 10; k++) v[p * 10 + k] = res.delta[m * 10 + k]; }); }
    const vec = new Map([[i, v]]), an1 = { segs: [[i, i]] }, one = C.FDORCH.assemble(cfg, [st[i]], { segs: [[0, 0]] }, base.subarray(i * nch * 2, (i + 1) * nch * 2), new Map([[0, v]]), grp).data;
    let e = 0, d = 0; for (let c = 0; c < nch; c++) { const k = 2 * c, K = 2 * (i * nch + c); e = Math.max(e, Math.hypot(r.data[K] - one[k], r.data[K + 1] - one[k + 1])); d = Math.max(d, Math.hypot(one[k] - base[K], one[k + 1] - base[K + 1])); }
    console.log('MD', st[i].md, 'direct |correction|', d.toExponential(3), ' interpolated vs direct', e.toExponential(3));
  }
})();
