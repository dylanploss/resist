'use strict';
process.env.CORE_FILES = 'filters.js,engine1d.js,model.js,invert.js';
process.env.CORE_EXPORTS = 'Engine,HANKEL_FILTERS,buildTrajectory,trajAt,makeStation,stationList,forwardLocal,addNoise,invertRange,truthAt,D2R,R2D';
const C = require('./load_core.js')();
const { buildTrajectory, forwardLocal, addNoise, invertRange, truthAt, stationList } = C;
const cfg = {
  traj: { md0: 0, N0: 0, E0: 0, D0: 1993, inc0: 88, az0: 0, sections: [{ len: 150, incEnd: 90, azEnd: 0 }, { len: 150, incEnd: 92, azEnd: 0 }] },
  tf: 20, mdStart: 20, mdEnd: 280, mdStep: 20, mode: '1d', filter: 'key_201_2012',
  geo1: { dip: 1.5, dipAz: 180, z0: 2000, layers: [{ rh: 2, rv: 3 }, { rh: 60, rv: 80, tvt: 8 }, { rh: 2, rv: 3 }] },
  channels: []
};
for (const [L, f] of [[10, 100e3], [20, 24e3], [30, 6e3]]) for (const [a, b] of [['Z', 'Z'], ['Z', 'X'], ['X', 'Z'], ['X', 'X']]) cfg.channels.push({ L, f, tx: { k: a }, rx: { k: b } });
const tr = buildTrajectory(cfg.traj, 0.5);
let t0 = Date.now();
const fw = forwardLocal(cfg, tr);
console.log('forward', fw.stations.length, 'stations x', cfg.channels.length, 'ch:', Date.now() - t0, 'ms');
const nSt = fw.stations.length, nch = cfg.channels.length;
const noisy = addNoise(fw.data, nSt, nch, { ampDb: 0.1, phaseDeg: 0.5, floorPpm: 100, biasDb: 0, biasDeg: 0, seed: 5 });
const mk = (v, lo, hi, free) => ({ v, lo, hi, free });
const icfg = {
  spec: { layers: [{ rh: mk(5, 0.3, 1000, true), kv: mk(1.5, 1, 6, false) }, { rh: mk(30, 0.3, 1000, true), kv: mk(1.5, 1, 6, false) }, { rh: mk(5, 0.3, 1000, true), kv: mk(1.5, 1, 6, false) }],
          d1: mk(-3, -40, 40, true), t: [mk(6, 0.5, 40, true)] },
  channels: cfg.channels.map((_, i) => i), assumed: { ampDb: 0.1, phaseDeg: 0.5, floorPpm: 100 }, nStarts: 4, maxIter: 40, filter: process.argv[2] || 'key_101_2012',
  dipErr: 0, dipAzErr: 0, continuation: true, startSpread: { lnRho: 1.2, d: 8 }, seed: 3, acceptChi2: 1.6
};
t0 = Date.now(); const res = [];
invertRange(cfg, icfg, tr, fw.stations, noisy, 0, nSt, res);
console.log('inversion', nSt, 'stations:', Date.now() - t0, 'ms  (' + ((Date.now() - t0) / nSt).toFixed(0) + ' ms/station)');
for (const r of res) {
  const st = fw.stations[r.i], tt = truthAt(cfg, st);
  console.log('md', st.md.toFixed(0), ' chi2', r.chi2.toFixed(2), ' nfev', r.nfev,
    '| rh', r.rh.map(v => v.toFixed(1)).join('/'), '(true', tt.rh.map(v => v.toFixed(0)).join('/') + ')',
    '| d', r.zi.map(v => v.toFixed(2)).join('/'), '(true', tt.zi.map(v => v.toFixed(2)).join('/') + ')',
    '| sd d1', r.sd[6].toFixed(2));
}
