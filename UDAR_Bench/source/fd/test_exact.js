'use strict';
const fs = require('fs');
const load = require('../tests/load_core.js');
const C = load(['fdsolve.js', 'fd25d.js'], ['FD', 'FDSolve']); const { FD, buildLocal2D } = C;
const cases = JSON.parse(fs.readFileSync('exact_cases.json', 'utf8'));
const names = ['xx', 'yy', 'zz', 'xz', 'zx'];
const optsets = process.argv[2] ? [JSON.parse(process.argv[2])] : [{ res: 6, nk: 6 }, { res: 8, nk: 8 }, { res: 12, nk: 10 }];
for (const opt of optsets) {
  console.log('=== options', JSON.stringify(opt));
  for (const c of cases) {
    const geo2 = { azSec: 0, horizons: [], layers: [{ rh: [[-1e4, c.rl], [c.x0, c.rl], [c.x0 + 1e-3, c.rr], [1e4, c.rr]], rv: [[-1e4, c.rl], [c.x0, c.rl], [c.x0 + 1e-3, c.rr], [1e4, c.rr]] }] };
    const a = c.ang * Math.PI / 180, ax = [Math.sin(a), Math.cos(a)];
    const loc = buildLocal2D(geo2, { r: [c.mid[0], 0, c.mid[1]] }, 5);
    const t0 = Date.now(); const plan = FD.planGroup(geo2, loc, c.mid, ax, [{ L: c.L, f: c.f }], opt);
    const res = FD.runGroup(plan), ms = Date.now() - t0, sc = 2 * Math.PI * c.L ** 3;
    let emax = 0, dmax = 0, line = '';
    names.forEach((nm, k) => { const d = [res.delta[2 * k] * sc, res.delta[2 * k + 1] * sc], r = c.delta[nm]; const e = Math.hypot(d[0] - r[0], d[1] - r[1]); emax = Math.max(emax, e); dmax = Math.max(dmax, Math.hypot(r[0], r[1])); line += ` ${nm}:${e.toExponential(1)}`; });
    console.log(`f=${(c.f / 1e3).toFixed(0).padStart(3)}k L=${String(c.L).padStart(2)} ang=${String(c.ang).padStart(2)} x0=${String(c.x0).padStart(2)} | max err ${emax.toExponential(2)}  rel ${(100 * emax / dmax).toFixed(1).padStart(5)}%  nodes ${String(res.info.nodes).padStart(5)} h0 ${res.info.h0.toFixed(2)} dmin ${res.info.dmin.toFixed(1)} ${String(ms).padStart(5)}ms |${line}`);
  }
}
