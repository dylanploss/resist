'use strict';
const fs = require('fs'), path = require('path');
const core = ['filters.js', 'engine1d.js', 'model.js', 'fdsolve.js', 'fd25d.js', 'fdorch.js', 'invert.js', 'jobs.js'].map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
const C = new Function('"use strict";\n' + core + '\nreturn { handleJob, buildTrajectory, stationList, makeStation, buildLocal2D, FDORCH, FD, secX, horizonZ };')();
const G = { azSec: 0, horizons: [[[-50, 2001], [0, 2000], [80, 1997.5], [160, 1994.8], [240, 1993.2], [320, 1993.8], [420, 1996]], [[-50, 2009], [0, 2008], [80, 2005.3], [160, 2002.6], [240, 2001.2], [320, 2001.6], [420, 2004]]], props: [[[0, 2, 3]], [[-50, 60, 80], [260, 60, 80], [300, 20, 28]], [[0, 2, 3]]] };
const geo2 = { azSec: 0, horizons: G.horizons.map(p => ({ pts: p })), layers: G.props.map(pr => ({ rh: pr.map(p => [p[0], p[1]]), rv: pr.map(p => [p[0], p[2]]) })) };
const channels = [{ L: 30, f: 6000, tx: { k: 'Z' }, rx: { k: 'Z' } }, { L: 16, f: 24000, tx: { k: 'Z' }, rx: { k: 'Z' } }];
const cfg = { traj: { md0: 0, N0: 0, E0: 0, D0: 1993, inc0: 88, az0: 0, sections: [{ len: 150, incEnd: 90, azEnd: 0 }, { len: 150, incEnd: 92, azEnd: 0 }] }, tf: 0, mdStart: 20, mdEnd: 280, mdStep: 2, channels, mode: '2d', geo2, slopeWin: 5, eng2d: 'fd', fd: { q: 'std', step: 25 } };
const tr = C.buildTrajectory(cfg.traj, 0.5), opt = C.FDORCH.options(cfg), extra = JSON.parse(process.argv[3] || '{}');
for (const md of (process.argv[2] || '124,131,138,144,150').split(',').map(Number)) {
  const st = C.makeStation(tr, md, 0), xm = C.secX(geo2, st.r[0], st.r[1]), zh = C.horizonZ(geo2, xm);
  const line = ['MD ' + md, 'x ' + xm.toFixed(1), 'z ' + st.r[2].toFixed(2), 'top ' + zh[0].toFixed(2), 'base ' + zh[1].toFixed(2)];
  for (const [L, f] of [[30, 6000], [16, 24000]]) {
    const r = C.handleJob('fdst', { cfg, md, f, Ls: [L], opt: Object.assign({}, opt.fd, extra) }, () => {});
    if (r.skip) { line.push(f / 1000 + 'kHz skip'); continue; }
    const zz = Math.hypot(r.delta[4], r.delta[5]), xx = Math.hypot(r.delta[0], r.delta[1]);
    line.push(f / 1000 + 'kHz dmin ' + r.info.dmin.toFixed(2) + ' h0 ' + r.info.h0.toFixed(2) + ' q ' + r.info.quality.toFixed(2) + ' |dxx| ' + xx.toExponential(2) + ' |dzz| ' + zz.toExponential(2) + ' ' + r.secs.toFixed(1) + 's');
  }
  console.log(line.join('  '));
}
