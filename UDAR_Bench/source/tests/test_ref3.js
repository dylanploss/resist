'use strict';
const fs = require('fs'); const E = require('./ref_engine.js');
const cases = JSON.parse(fs.readFileSync(__dirname + '/../ref/layered_cases.json'));
const filt = process.argv[2] || 'key_201_2012';
const rows=[];
cases.forEach((c, ic) => {
  const M = { sh: c.res.map(r => 1 / r), sv: c.res.map((r, j) => 1 / (r * c.aniso[j] ** 2)), zi: c.depth };
  const T = E.hankelTensor({ omega: 2 * Math.PI * c.f, M, zs: c.zs, zr: c.zr, rho: c.rho, filter: filt });
  const s = E.layerIndex(M.zi, c.zs), r = E.layerIndex(M.zi, c.zr);
  const R = Math.hypot(c.rho, c.zr - c.zs), vac = 1 / (4 * Math.PI * R ** 3);
  let worst=0, wk='', mag=0;
  for (const k of ['xx','yy','zz','xz','zx']) {
    const m=T[k], a=c.Hdlf[k];
    const mg=Math.hypot(a[0],a[1]); mag=Math.max(mag,mg);
    const rel = Math.hypot(m[0]-a[0], m[1]-a[1]) / Math.max(mg, 1e-3*vac*0+1e-300);
    if (rel>worst){worst=rel;wk=k;}
  }
  rows.push({ic,N:c.res.length,s,r,f:c.f,R:+R.toFixed(1),dz:+(c.zr-c.zs).toFixed(1),rho:+c.rho.toFixed(1),magOverVac:mag/vac,worstRel:worst,wk});
});
rows.sort((a,b)=>b.worstRel-a.worstRel);
rows.slice(0,10).forEach(r=>console.log(JSON.stringify({...r,magOverVac:+r.magOverVac.toExponential(1),worstRel:+r.worstRel.toExponential(2)})));
