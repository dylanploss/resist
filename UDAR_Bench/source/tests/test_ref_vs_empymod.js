'use strict';
const fs = require('fs');
const E = require('./ref_engine.js');
const cases = JSON.parse(fs.readFileSync(__dirname + '/../ref/layered_cases.json'));
const filt = process.argv[2] || 'key_201_2012';
let worst = 0, worstCase = null; const rows = [];
cases.forEach((c, ic) => {
  const N = c.res.length;
  const M = { sh: c.res.map(r => 1 / r), sv: c.res.map((r, j) => 1 / (r * c.aniso[j] * c.aniso[j])), zi: c.depth };
  const omega = 2 * Math.PI * c.f;
  let dz = c.zr - c.zs;
  const T = E.hankelTensor({ omega, M, zs: c.zs, zr: c.zr, rho: c.rho, filter: filt });
  const s = E.layerIndex(M.zi, c.zs), r = E.layerIndex(M.zi, c.zr);
  // scale: compare each component with component-wise relative error against the ZZ/XX scale (max abs of the 5 comps)
  const scale = Math.max(...Object.keys(T).map(k => Math.hypot(c.H[k][0], c.H[k][1])));
  let wc = 0; const det = {};
  for (const k of ['xx', 'yy', 'zz', 'xz', 'zx']) {
    const e = Math.hypot(T[k][0] - c.H[k][0], T[k][1] - c.H[k][1]);
    const rel = e / scale;                     // error relative to the largest component
    const relc = e / Math.max(Math.hypot(c.H[k][0], c.H[k][1]), 1e-30);  // component-wise
    det[k] = [rel, relc];
    wc = Math.max(wc, rel);
  }
  rows.push({ ic, N, s, r, f: c.f, rho: c.rho, dz, wc, det });
  if (wc > worst) { worst = wc; worstCase = ic; }
});
rows.sort((a, b) => b.wc - a.wc);
console.log('filter', filt, ' cases', cases.length, ' worst (err/maxcomp) = %s (case %d)', worst.toExponential(2), worstCase);
for (const r of rows.slice(0, 8)) console.log(JSON.stringify({ ic: r.ic, N: r.N, s: r.s, r: r.r, f: r.f, rho: +r.rho.toFixed(1), dz: +r.dz.toFixed(2), wc: +r.wc.toExponential(2), xx: r.det.xx.map(v => +v.toExponential(1)), zz: r.det.zz.map(v => +v.toExponential(1)), xz: r.det.xz.map(v => +v.toExponential(1)) }));
const med = rows.map(r => r.wc).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
console.log('median err/maxcomp = %s', med.toExponential(2));
