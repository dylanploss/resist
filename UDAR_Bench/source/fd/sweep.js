'use strict';
const fs = require('fs');
const load = require('../tests/load_core.js');
const C = load(['fdsolve.js', 'fd25d.js'], ['FD', 'FDSolve']); const { FD, buildLocal2D } = C;
const cases = JSON.parse(fs.readFileSync(process.env.CASES || 'exact_cases.json', 'utf8')); const names = ['xx', 'yy', 'zz', 'xz', 'zx'];
const opt = JSON.parse(process.argv[2] || '{}'), list = process.argv[3] ? process.argv[3].split(',').map(Number) : cases.map((_, i) => i);
let worst = 0, tot = 0, nodes = 0; const rel = [];
for (const ci of list) {
  const c = cases[ci];
  const geo2 = { azSec: 0, horizons: [], layers: [{ rh: [[-1e4, c.rl], [c.x0, c.rl], [c.x0 + 1e-3, c.rr], [1e4, c.rr]], rv: [[-1e4, c.rl], [c.x0, c.rl], [c.x0 + 1e-3, c.rr], [1e4, c.rr]] }] };
  const a = c.ang * Math.PI / 180, ax = [Math.sin(a), Math.cos(a)], loc = buildLocal2D(geo2, { r: [c.mid[0], 0, c.mid[1]] }, 5);
  const t0 = Date.now(), plan = FD.planGroup(geo2, loc, c.mid, ax, [{ L: c.L, f: c.f }], opt), res = FD.runGroup(plan), ms = Date.now() - t0, sc = 2 * Math.PI * c.L ** 3;
  let emax = 0, dmax = 0; names.forEach((nm, k) => { const d = [res.delta[2 * k] * sc, res.delta[2 * k + 1] * sc], r = c.delta[nm]; emax = Math.max(emax, Math.hypot(d[0] - r[0], d[1] - r[1])); dmax = Math.max(dmax, Math.hypot(r[0], r[1])); });
  rel.push((100 * emax / dmax).toFixed(1)); worst = Math.max(worst, emax / dmax); tot += ms; nodes += res.info.nodes;
}
console.log(JSON.stringify(opt).padEnd(70), 'rel% per case', rel.join(' ').padEnd(40), 'worst', (100 * worst).toFixed(1) + '%', 'avg nodes', Math.round(nodes / list.length), 'time', tot + 'ms');
