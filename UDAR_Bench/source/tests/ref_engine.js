'use strict';
// Straightforward (slow, allocation-heavy) reference implementation of the layered TIV engine.
// Convention: e^{-i w t}; z positive downward; layer 0 = top half-space; per unit magnetic dipole moment.
const fs = require('fs');
const FILT = JSON.parse(fs.readFileSync(__dirname + '/../ref/filters.json'));
const MU0 = 4e-7 * Math.PI;

const cadd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const csub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
const cs = (a, s) => [a[0] * s, a[1] * s];
const cexp = (a) => { const e = Math.exp(a[0]); return [e * Math.cos(a[1]), e * Math.sin(a[1])]; };
const csqrt = (a) => { const m = Math.hypot(a[0], a[1]); const re = Math.sqrt((m + a[0]) / 2); let im = Math.sqrt(Math.max(0, (m - a[0]) / 2)); if (a[1] < 0) im = -im; return [re, im]; };
const C1 = [1, 0], C0 = [0, 0];
const INF = Infinity;

function layerIndex(zi, z) { let j = 0; while (j < zi.length && zi[j] < z) j++; return j; }

// Green's function pieces for one mode ('TE' | 'TM'); returns {G,Gz,Gs,Gzs}
function modeGreens(mode, lam, omega, M, s, zs, r, zr, scatOnly) {
  const N = M.sh.length, zi = M.zi;
  const g = [], Y = [];
  for (let j = 0; j < N; j++) {
    const wms = omega * MU0 * M.sh[j];
    let g2;
    if (mode === 'TE') g2 = [lam * lam, -wms];
    else g2 = [(M.sh[j] / M.sv[j]) * lam * lam, -wms];
    g[j] = csqrt(g2);
    Y[j] = mode === 'TE' ? g[j] : cs(g[j], 1 / M.sh[j]);
  }
  const top = (j) => (j >= 1 ? zi[j - 1] : -INF);
  const bot = (j) => (j <= N - 2 ? zi[j] : INF);
  const dth = (j) => ((j >= 1 && j <= N - 2) ? zi[j] - zi[j - 1] : INF);
  const ex = (gam, x) => ((x === INF || x === -INF) ? C0 : cexp(cs(gam, -x)));
  const Ed = [], E2 = [];
  for (let j = 0; j < N; j++) { Ed[j] = ex(g[j], dth(j)); E2[j] = cmul(Ed[j], Ed[j]); }
  const RD = new Array(N).fill(0).map(() => [0, 0]);
  for (let j = N - 2; j >= 0; j--) {
    const rr = cdiv(csub(Y[j], Y[j + 1]), cadd(Y[j], Y[j + 1]));
    const t = cmul(RD[j + 1], E2[j + 1]);
    RD[j] = cdiv(cadd(rr, t), cadd(C1, cmul(rr, t)));
  }
  const RU = new Array(N).fill(0).map(() => [0, 0]);
  for (let j = 1; j < N; j++) {
    const rr = cdiv(csub(Y[j], Y[j - 1]), cadd(Y[j], Y[j - 1]));
    const t = cmul(RU[j - 1], E2[j - 1]);
    RU[j] = cdiv(cadd(rr, t), cadd(C1, cmul(rr, t)));
  }
  const gs = g[s];
  const a = zs - top(s), b = bot(s) - zs;
  const Ea = ex(gs, a), Eb = ex(gs, b);
  const Rup = RU[s], Rdn = RD[s];
  const Delta = csub(C1, cmul(cmul(Rup, Rdn), E2[s]));
  const inv2g = cdiv(C1, cs(gs, 2));
  const RdnEdEb = cmul(cmul(Rdn, Ed[s]), Eb), RupEdEa = cmul(cmul(Rup, Ed[s]), Ea);
  const Dtop = cdiv(cmul(cmul(Rup, inv2g), cadd(Ea, RdnEdEb)), Delta);
  const Ubot = cdiv(cmul(cmul(Rdn, inv2g), cadd(Eb, RupEdEa)), Delta);
  const dD = cdiv(cs(cmul(Rup, csub(Ea, RdnEdEb)), -0.5), Delta);
  const dU = cdiv(cs(cmul(Rdn, csub(Eb, RupEdEa)), 0.5), Delta);

  let G, Gz, Gs, Gzs;
  if (r === s) {
    const Edir = scatOnly ? C0 : ex(gs, Math.abs(zr - zs));
    const sg = Math.sign(zr - zs);
    const Ez1 = ex(gs, zr - top(s)), Ez2 = ex(gs, bot(s) - zr);
    G = cadd(cadd(cmul(Edir, inv2g), cmul(Dtop, Ez1)), cmul(Ubot, Ez2));
    Gz = cadd(cadd(cs(Edir, -0.5 * sg), cs(cmul(gs, cmul(Dtop, Ez1)), -1)), cmul(gs, cmul(Ubot, Ez2)));
    Gs = cadd(cadd(cs(Edir, 0.5 * sg), cmul(dD, Ez1)), cmul(dU, Ez2));
    Gzs = cadd(cadd(cmul(gs, cs(Edir, -0.5)), cs(cmul(gs, cmul(dD, Ez1)), -1)), cmul(gs, cmul(dU, Ez2)));
  } else if (r < s) {
    const Utop = cadd(cmul(Ea, inv2g), cmul(Ubot, Ed[s]));
    const dUtop = cadd(cs(Ea, -0.5), cmul(dU, Ed[s]));
    let C = cdiv(cadd(C1, RU[s]), cadd(C1, cmul(RU[s - 1], E2[s - 1])));
    for (let j = s - 2; j >= r; j--) {
      C = cmul(C, cdiv(cmul(Ed[j + 1], cadd(C1, RU[j + 1])), cadd(C1, cmul(RU[j], E2[j]))));
    }
    // up-going: exp(g (zr - bot)) = ex(g, bot - zr)
    const upg = ex(g[r], bot(r) - zr);
    const dng = ex(g[r], zr - top(r));
    const RUEd = cmul(RU[r], Ed[r]);
    const W = cadd(upg, cmul(RUEd, dng));
    const Wz = cmul(g[r], csub(upg, cmul(RUEd, dng)));
    G = cmul(cmul(Utop, C), W); Gs = cmul(cmul(dUtop, C), W);
    Gz = cmul(cmul(Utop, C), Wz); Gzs = cmul(cmul(dUtop, C), Wz);
  } else {
    const Dbot = cadd(cmul(Eb, inv2g), cmul(Dtop, Ed[s]));
    const dDbot = cadd(cs(Eb, 0.5), cmul(dD, Ed[s]));
    let C = cdiv(cadd(C1, RD[s]), cadd(C1, cmul(RD[s + 1], E2[s + 1])));
    for (let j = s + 1; j <= r - 1; j++) {
      C = cmul(C, cdiv(cmul(Ed[j], cadd(C1, RD[j])), cadd(C1, cmul(RD[j + 1], E2[j + 1]))));
    }
    const dng = ex(g[r], zr - top(r));
    const upg = ex(g[r], bot(r) - zr);
    const RDEd = cmul(RD[r], Ed[r]);
    const V = cadd(dng, cmul(RDEd, upg));
    const Vz = cmul(g[r], csub(cmul(RDEd, upg), dng));
    G = cmul(cmul(Dbot, C), V); Gs = cmul(cmul(dDbot, C), V);
    Gz = cmul(cmul(Dbot, C), Vz); Gzs = cmul(cmul(dDbot, C), Vz);
  }
  return { G, Gz, Gs, Gzs };
}

// closed-form direct (full-space, source-layer properties) TIV tensor; rho>0
function directTIV(omega, sh, sv, rho, dz) {
  const kap = Math.sqrt(sh / sv);
  const kh = csqrt([0, omega * MU0 * sh]);
  const kv = csqrt([0, omega * MU0 * sv]);
  const R = Math.hypot(rho, dz), Rv = Math.hypot(rho, kap * dz);
  // exp(i kh R) = exp(i*(a+ib)R) = exp(-b R) (cos aR + i sin aR)
  const eh = cexp([-kh[1] * R, kh[0] * R]);
  const ev = cexp([-kv[1] * Rv, kv[0] * Rv]);
  const phi = cs(eh, 1 / R);
  const ikh = [-kh[1], kh[0]]; // i*kh
  const kh2 = cmul(kh, kh);
  const f1 = cmul(csub(ikh, [1 / R, 0]), phi);
  const f1p = cmul(phi, csub(csub(cs(kh2, -1), cs(ikh, 2 / R)), [-2 / (R * R), 0]));
  const d2z = cadd(cs(f1, 1 / R - dz * dz / (R * R * R)), cs(f1p, dz * dz / (R * R)));
  const drdz = cs(csub(f1p, cs(f1, 1 / R)), rho * dz / (R * R));
  const psi = cs(ev, 1 / Rv);
  const kv2 = cmul(kv, kv);
  const q = 1 / (4 * Math.PI);
  const zz = cs(cadd(d2z, cmul(kh2, phi)), q);
  const xz = cs(drdz, q);
  const diff = csub(eh, ev);
  const coef = cs(cmul([0, 1], kh), q / (rho * rho)); // i kh /(4 pi rho^2)
  const xx = cadd(cs(cadd(d2z, cs(f1, 1 / R)), -q), cmul(coef, diff));
  const yy = cadd(cs(cadd(cs(f1, 1 / R), cs(cmul(kv2, psi), kap)), q), cmul(coef, cs(diff, -1)));
  return { xx, yy, zz, xz, zx: xz };
}

function hankelTensor(opts) {
  // opts: omega, M {sh,sv,zi}, zs, zr, rho (>0), filter name; returns {xx,yy,zz,xz,zx} complex [re,im]
  const { omega, M, zs, zr, rho } = opts;
  const F = FILT[opts.filter || 'key_201_2012'];
  const s = layerIndex(M.zi, zs), r = layerIndex(M.zi, zr);
  const k2 = [0, omega * MU0 * M.sh[s]];
  const acc = { zz: [0, 0], zx: [0, 0], xz: [0, 0], xx0: [0, 0], xx1: [0, 0], yy0: [0, 0], yy1: [0, 0] };
  const scat = (r === s);
  for (let i = 0; i < F.base.length; i++) {
    const lam = F.base[i] / rho;
    const te = modeGreens('TE', lam, omega, M, s, zs, r, zr, scat);
    const tm = modeGreens('TM', lam, omega, M, s, zs, r, zr, scat);
    const k2Gm = cmul(k2, tm.G);
    const w0 = F.j0[i], w1 = F.j1[i];
    acc.zz = cadd(acc.zz, cs(te.G, lam * lam * lam * w0));
    acc.zx = cadd(acc.zx, cs(te.Gs, lam * lam * w1));
    acc.xz = cadd(acc.xz, cs(te.Gz, -lam * lam * w1));
    acc.xx0 = cadd(acc.xx0, cs(te.Gzs, lam * w0));
    acc.xx1 = cadd(acc.xx1, cs(csub(k2Gm, te.Gzs), w1));
    acc.yy0 = cadd(acc.yy0, cs(k2Gm, lam * w0));
    acc.yy1 = cadd(acc.yy1, cs(csub(te.Gzs, k2Gm), w1));
  }
  const q = 1 / (2 * Math.PI);
  const out = {
    zz: cs(acc.zz, q / rho),
    zx: cs(acc.zx, q / rho),
    xz: cs(acc.xz, q / rho),
    xx: cs(cadd(cs(acc.xx0, 1 / rho), cs(acc.xx1, 1 / (rho * rho))), q),
    yy: cs(cadd(cs(acc.yy0, 1 / rho), cs(acc.yy1, 1 / (rho * rho))), q),
  };
  if (r === s) {
    const d = directTIV(omega, M.sh[s], M.sv[s], rho, zr - zs);
    for (const k of Object.keys(out)) out[k] = cadd(out[k], d[k]);
  }
  return out;
}

module.exports = { hankelTensor, directTIV, modeGreens, layerIndex, FILT, MU0 };
