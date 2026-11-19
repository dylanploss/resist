'use strict';
const fs = require('fs'); const E = require('./ref_engine.js');
const cases = JSON.parse(fs.readFileSync(__dirname + '/../ref/layered_cases.json'));
const rows=[];
cases.forEach((c, ic) => {
  const M = { sh: c.res.map(r => 1 / r), sv: c.res.map((r, j) => 1 / (r * c.aniso[j] ** 2)), zi: c.depth };
  const T = E.hankelTensor({ omega: 2 * Math.PI * c.f, M, zs: c.zs, zr: c.zr, rho: c.rho, filter: process.argv[2]||'key_201_2012' });
  const s = E.layerIndex(M.zi, c.zs), r = E.layerIndex(M.zi, c.zr);
  const R = Math.hypot(c.rho, c.zr - c.zs), vac = 1 / (4 * Math.PI * R ** 3);
  let eD = 0, eQ = 0, dq = 0;
  for (const k of ['xx','yy','zz','xz','zx']) {
    const m=T[k], a=c.Hdlf[k], b=c.H[k];
    eD = Math.max(eD, Math.hypot(m[0]-a[0], m[1]-a[1]) / vac);
    eQ = Math.max(eQ, Math.hypot(m[0]-b[0], m[1]-b[1]) / vac);
    dq = Math.max(dq, Math.hypot(a[0]-b[0], a[1]-b[1]) / vac);
  }
  rows.push({ic, N:c.res.length, s, r, f:c.f, R:+R.toFixed(1), vsDLF:eD, vsQWE:eQ, dlfVsQwe:dq});
});
rows.sort((a,b)=>b.vsDLF-a.vsDLF);
console.log('worst vs empymod-DLF(same filter):'); rows.slice(0,6).forEach(r=>console.log(JSON.stringify({...r, vsDLF:+r.vsDLF.toExponential(2), vsQWE:+r.vsQWE.toExponential(2), dlfVsQwe:+r.dlfVsQwe.toExponential(2)})));
const med=(k)=>rows.map(r=>r[k]).sort((a,b)=>a-b)[Math.floor(rows.length/2)];
console.log('median err/vac: vsDLF', med('vsDLF').toExponential(2), ' vsQWE', med('vsQWE').toExponential(2), ' DLFvsQWE', med('dlfVsQwe').toExponential(2));
// breakdown by type
const types={};
rows.forEach(r=>{const t=(r.r===r.s?'same':(r.r<r.s?'above':'below')); (types[t]=types[t]||[]).push(r.vsDLF);});
for (const t in types) console.log(t, 'n=',types[t].length,'max vsDLF', Math.max(...types[t]).toExponential(2));
