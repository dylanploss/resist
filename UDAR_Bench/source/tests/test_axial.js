'use strict';
// near-axis behaviour: extrapolation vs direct evaluation at small rho; continuity at threshold; rho=0 exactly; sign of odd comps
const fs = require('fs');
const { Engine } = require('../src/engine1d.js');
const FILT = require('./ref_engine.js').FILT; const F = FILT.key_201_2012;
const cases = JSON.parse(fs.readFileSync(__dirname + '/../ref/layered_cases.json'));
let worst = 0, worstCont = 0, n = 0;
const names = ['xx','yy','zz','xz','zx'];
for (const c of cases) {
  const N = c.res.length;
  const mdl = { N, sh: c.res.map(r => 1 / r), sv: c.res.map((r, j) => 1 / (r * c.aniso[j] ** 2)), zi: c.depth };
  const om = 2 * Math.PI * c.f, dz = c.zr - c.zs; if (Math.abs(dz) < 0.5) continue;
  const R = Math.abs(dz);
  const Ta = new Float64Array(10), Tb = new Float64Array(10), Tc = new Float64Array(10);
  for (const frac of [0, 1e-4, 1e-3, 5e-3, 0.02, 0.04, 0.0499]) {
    const rho = frac * R;
    Engine.tensor(om, mdl, c.zs, c.zr, rho, 1, F, Ta);                    // extrapolated
    // "truth": direct core evaluation at tiny but safe rho (1e-3 R) with odd scaling, even comps unchanged (error ~1e-6 rel)
    const rhoT = Math.max(rho, 1e-3 * R);
    Engine.core(om, mdl, c.zs, c.zr, rhoT, F, Tb);
    const vac = 1 / (4 * Math.PI * R ** 3);
    let e = 0;
    for (let i = 0; i < 3; i++) e = Math.max(e, Math.hypot(Ta[2*i]-Tb[2*i], Ta[2*i+1]-Tb[2*i+1]) / vac);
    // odd: compare Ta / rho vs Tb / rhoT only when rho>0
    if (rho > 0) for (let i = 3; i < 5; i++) e = Math.max(e, Math.hypot(Ta[2*i]/rho-Tb[2*i]/rhoT, Ta[2*i+1]/rho-Tb[2*i+1]/rhoT) * rho / vac);
    // allowed discrepancy: truncation of 'truth' ~ (1e-3)^2 = 1e-6 relative ; so just record
    worst = Math.max(worst, e); n++;
  }
  // continuity across the 5% threshold
  Engine.tensor(om, mdl, c.zs, c.zr, 0.04999 * R, 1, F, Ta); Engine.tensor(om, mdl, c.zs, c.zr, 0.05001 * R, 1, F, Tb);
  let ec = 0; const vac = 1 / (4 * Math.PI * R ** 3);
  for (let i = 0; i < 10; i++) ec = Math.max(ec, Math.abs(Ta[i] - Tb[i]) / vac);
  worstCont = Math.max(worstCont, ec);
}
console.log('n evaluations', n, ' worst |extrap - direct@1e-3R|/vac =', worst.toExponential(2), ' worst jump across 5% threshold /vac =', worstCont.toExponential(2));
// convergence study for one case: direct evaluations at decreasing rho vs extrapolated value at rho=0
const c = cases.find(c => c.res.length >= 3 && Math.abs(c.zr - c.zs) > 1);
const N = c.res.length, mdl = { N, sh: c.res.map(r => 1 / r), sv: c.res.map((r, j) => 1 / (r * c.aniso[j] ** 2)), zi: c.depth };
const om = 2 * Math.PI * c.f, R = Math.abs(c.zr - c.zs), T0 = new Float64Array(10), T = new Float64Array(10);
Engine.tensor(om, mdl, c.zs, c.zr, 0, 1, F, T0);
console.log('rho=0 extrapolated zz,xx,yy:', Array.from(T0.slice(0,6)).map(v=>v.toExponential(6)).join(' '));
for (const f of [3e-2, 1e-2, 3e-3, 1e-3, 3e-4, 1e-4]) {
  Engine.core(om, mdl, c.zs, c.zr, f * R, F, T);
  const vac = 1 / (4 * Math.PI * R ** 3); let e = 0; for (let i = 0; i < 6; i++) e = Math.max(e, Math.abs(T[i] - T0[i]) / vac);
  console.log(' direct core at rho/R =', f, ' max|diff| even comps / vac =', e.toExponential(2));
}
