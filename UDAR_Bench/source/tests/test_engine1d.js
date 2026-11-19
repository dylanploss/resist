'use strict';
// compare production engine vs reference engine and vs empymod cases
const fs = require('fs');
const { Engine } = require('../src/engine1d.js');
const REF = require('./ref_engine.js');
const FILT = REF.FILT;
const cases = JSON.parse(fs.readFileSync(__dirname + '/../ref/layered_cases.json'));
const fname = process.argv[2] || 'key_201_2012';
const names = ['xx', 'yy', 'zz', 'xz', 'zx'];
let maxVsRef = 0, maxVsEmp = 0; const rows = [];
cases.forEach((c, ic) => {
  const N = c.res.length;
  const mdl = { N, sh: c.res.map(r => 1 / r), sv: c.res.map((r, j) => 1 / (r * c.aniso[j] ** 2)), zi: c.depth };
  const T = new Float64Array(10);
  Engine.tensor(2 * Math.PI * c.f, mdl, c.zs, c.zr, c.rho, 1, FILT[fname], T);
  const Tr = REF.hankelTensor({ omega: 2 * Math.PI * c.f, M: { sh: mdl.sh, sv: mdl.sv, zi: mdl.zi }, zs: c.zs, zr: c.zr, rho: c.rho, filter: fname });
  const R = Math.hypot(c.rho, c.zr - c.zs), vac = 1 / (4 * Math.PI * R ** 3);
  let eR = 0, eE = 0;
  names.forEach((k, i) => {
    eR = Math.max(eR, Math.hypot(T[2 * i] - Tr[k][0], T[2 * i + 1] - Tr[k][1]) / vac);
    const a = c.Hdlf[k]; eE = Math.max(eE, Math.hypot(T[2 * i] - a[0], T[2 * i + 1] - a[1]) / vac);
  });
  maxVsRef = Math.max(maxVsRef, eR); maxVsEmp = Math.max(maxVsEmp, eE);
  rows.push({ ic, N, eR, eE });
});
rows.sort((a, b) => b.eR - a.eR);
console.log('filter', fname, ' max |prod - ref|/vac =', maxVsRef.toExponential(2), '  max |prod - empymodDLF|/vac =', maxVsEmp.toExponential(2));
console.log('worst vs ref:', rows.slice(0, 3).map(r => JSON.stringify({ ic: r.ic, N: r.N, eR: +r.eR.toExponential(2), eE: +r.eE.toExponential(2) })).join('\n'));
// timing
for (const fn of ['key_101_2012', 'key_201_2012']) {
  const c = cases.find(c => c.res.length === 4) || cases[0];
  const N = c.res.length;
  const mdl = { N, sh: c.res.map(r => 1 / r), sv: c.res.map((r, j) => 1 / (r * c.aniso[j] ** 2)), zi: c.depth };
  const T = new Float64Array(10), om = 2 * Math.PI * c.f, F = FILT[fn];
  for (let i = 0; i < 200; i++) Engine.tensor(om, mdl, c.zs, c.zr, c.rho, 1, F, T);
  const t0 = process.hrtime.bigint(); const n = 3000;
  for (let i = 0; i < n; i++) Engine.tensor(om, mdl, c.zs, c.zr, c.rho * (1 + 1e-6 * i), 1, F, T);
  const t1 = process.hrtime.bigint();
  console.log(fn, 'N=', N, ((Number(t1 - t0) / 1e6) / n).toFixed(3), 'ms / tensor');
}
