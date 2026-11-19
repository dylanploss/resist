// ===================================================================================
// engine1d.js  --  layered TIV (Rh/Rv) magnetic-dipole engine, frequency domain
//   convention: e^{-i w t}, z positive downward, layer 0 = top half-space, per unit dipole moment (A.m^2)
//   H_ij = field component i at the receiver due to a unit source along j, formation frame
//   (x along the receiver offset projected onto the bedding, y = z x x, z = down-normal)
//   Only 5 components are non-zero: xx, yy, zz, xz, zx
// ===================================================================================
const MU0 = 4e-7 * Math.PI;
const MAXN = 24;

const Engine = (function () {
  const gR = new Float64Array(2 * MAXN), gI = new Float64Array(2 * MAXN);
  const YR = new Float64Array(2 * MAXN), YI = new Float64Array(2 * MAXN);
  const EdR = new Float64Array(2 * MAXN), EdI = new Float64Array(2 * MAXN);
  const E2R = new Float64Array(2 * MAXN), E2I = new Float64Array(2 * MAXN);
  const RDR = new Float64Array(2 * MAXN), RDI = new Float64Array(2 * MAXN);
  const RUR = new Float64Array(2 * MAXN), RUI = new Float64Array(2 * MAXN);
  const topZ = new Float64Array(MAXN), botZ = new Float64Array(MAXN), thick = new Float64Array(MAXN);
  const kap2 = new Float64Array(MAXN), wms = new Float64Array(MAXN), invSh = new Float64Array(MAXN);
  const outG = new Float64Array(16);
  let cr = 0, ci = 0;
  function mul(a, b, c, d) { cr = a * c - b * d; ci = a * d + b * c; }
  function div(a, b, c, d) { const t = c * c + d * d; cr = (a * c + b * d) / t; ci = (b * c - a * d) / t; }
  function ex(gr, gi, x) {            // e^{-g x}
    if (x === Infinity) { cr = 0; ci = 0; return; }
    const e = Math.exp(-gr * x), ph = -gi * x; cr = e * Math.cos(ph); ci = e * Math.sin(ph);
  }

  function setupMode(m, N, lam2) {
    const o = m * MAXN;
    for (let j = 0; j < N; j++) {
      const a = m === 0 ? lam2 : kap2[j] * lam2, b = -wms[j];
      const mag = Math.sqrt(a * a + b * b);
      const re = Math.sqrt(0.5 * (mag + a));
      let im = Math.sqrt(Math.max(0, 0.5 * (mag - a))); if (b < 0) im = -im;
      gR[o + j] = re; gI[o + j] = im;
      if (m === 0) { YR[o + j] = re; YI[o + j] = im; } else { YR[o + j] = re * invSh[j]; YI[o + j] = im * invSh[j]; }
      const d = thick[j];
      if (d === Infinity) { EdR[o + j] = 0; EdI[o + j] = 0; E2R[o + j] = 0; E2I[o + j] = 0; }
      else {
        const e = Math.exp(-re * d), ph = -im * d, cR = e * Math.cos(ph), cI = e * Math.sin(ph);
        EdR[o + j] = cR; EdI[o + j] = cI; E2R[o + j] = cR * cR - cI * cI; E2I[o + j] = 2 * cR * cI;
      }
    }
    // R^D_j (bottom interface of layer j), R^D_{N-1}=0
    RDR[o + N - 1] = 0; RDI[o + N - 1] = 0;
    for (let j = N - 2; j >= 0; j--) {
      const y0R = YR[o + j], y0I = YI[o + j], y1R = YR[o + j + 1], y1I = YI[o + j + 1];
      div(y0R - y1R, y0I - y1I, y0R + y1R, y0I + y1I); const rR = cr, rI = ci;       // r_{j,j+1}
      mul(RDR[o + j + 1], RDI[o + j + 1], E2R[o + j + 1], E2I[o + j + 1]); const tR = cr, tI = ci;
      mul(rR, rI, tR, tI);
      div(rR + tR, rI + tI, 1 + cr, ci);
      RDR[o + j] = cr; RDI[o + j] = ci;
    }
    // R^U_j (top interface of layer j), R^U_0=0
    RUR[o] = 0; RUI[o] = 0;
    for (let j = 1; j < N; j++) {
      const y0R = YR[o + j], y0I = YI[o + j], y1R = YR[o + j - 1], y1I = YI[o + j - 1];
      div(y0R - y1R, y0I - y1I, y0R + y1R, y0I + y1I); const rR = cr, rI = ci;       // r_{j,j-1}
      mul(RUR[o + j - 1], RUI[o + j - 1], E2R[o + j - 1], E2I[o + j - 1]); const tR = cr, tI = ci;
      mul(rR, rI, tR, tI);
      div(rR + tR, rI + tI, 1 + cr, ci);
      RUR[o + j] = cr; RUI[o + j] = ci;
    }
  }

  // writes outG[oo..oo+7] = G, Gz, Gs, Gzs (re,im)
  function greensMode(m, N, s, r, zs, zr, scat, oo) {
    const o = m * MAXN;
    const gsR = gR[o + s], gsI = gI[o + s];
    div(1, 0, 2 * gsR, 2 * gsI); const i2R = cr, i2I = ci;
    ex(gsR, gsI, zs - topZ[s]); const EaR = cr, EaI = ci;
    ex(gsR, gsI, botZ[s] - zs); const EbR = cr, EbI = ci;
    const RupR = RUR[o + s], RupI = RUI[o + s], RdnR = RDR[o + s], RdnI = RDI[o + s];
    const EdsR = EdR[o + s], EdsI = EdI[o + s], E2sR = E2R[o + s], E2sI = E2I[o + s];
    mul(RupR, RupI, RdnR, RdnI); mul(cr, ci, E2sR, E2sI); const DeR = 1 - cr, DeI = -ci;
    mul(RdnR, RdnI, EdsR, EdsI); mul(cr, ci, EbR, EbI); const RdEbR = cr, RdEbI = ci;
    mul(RupR, RupI, EdsR, EdsI); mul(cr, ci, EaR, EaI); const RuEaR = cr, RuEaI = ci;
    mul(RupR, RupI, i2R, i2I); const t1R = cr, t1I = ci;
    mul(t1R, t1I, EaR + RdEbR, EaI + RdEbI); div(cr, ci, DeR, DeI); const DtR = cr, DtI = ci;      // D_top
    mul(RdnR, RdnI, i2R, i2I); const t2R = cr, t2I = ci;
    mul(t2R, t2I, EbR + RuEaR, EbI + RuEaI); div(cr, ci, DeR, DeI); const UbR = cr, UbI = ci;      // U_bot
    mul(RupR, RupI, EaR - RdEbR, EaI - RdEbI); div(cr, ci, DeR, DeI); const dDR = -0.5 * cr, dDI = -0.5 * ci;
    mul(RdnR, RdnI, EbR - RuEaR, EbI - RuEaI); div(cr, ci, DeR, DeI); const dUR = 0.5 * cr, dUI = 0.5 * ci;

    let GR, GI, GzR, GzI, GsR, GsI, GzsR, GzsI;
    if (r === s) {
      let EdirR = 0, EdirI = 0;
      if (!scat) { ex(gsR, gsI, Math.abs(zr - zs)); EdirR = cr; EdirI = ci; }
      const sg = zr > zs ? 1 : (zr < zs ? -1 : 0);
      ex(gsR, gsI, zr - topZ[s]); const Ez1R = cr, Ez1I = ci;
      ex(gsR, gsI, botZ[s] - zr); const Ez2R = cr, Ez2I = ci;
      mul(EdirR, EdirI, i2R, i2I); GR = cr; GI = ci;
      mul(DtR, DtI, Ez1R, Ez1I); const p1R = cr, p1I = ci; GR += cr; GI += ci;
      mul(UbR, UbI, Ez2R, Ez2I); const p2R = cr, p2I = ci; GR += cr; GI += ci;
      mul(gsR, gsI, p2R - p1R, p2I - p1I); GzR = -0.5 * sg * EdirR + cr; GzI = -0.5 * sg * EdirI + ci;
      mul(dDR, dDI, Ez1R, Ez1I); const q1R = cr, q1I = ci;
      mul(dUR, dUI, Ez2R, Ez2I); const q2R = cr, q2I = ci;
      GsR = 0.5 * sg * EdirR + q1R + q2R; GsI = 0.5 * sg * EdirI + q1I + q2I;
      mul(gsR, gsI, q2R - q1R, q2I - q1I); const w1R = cr, w1I = ci;
      mul(gsR, gsI, EdirR, EdirI); GzsR = -0.5 * cr + w1R; GzsI = -0.5 * ci + w1I;
    } else if (r < s) {
      mul(EaR, EaI, i2R, i2I); let UtR = cr, UtI = ci;
      mul(UbR, UbI, EdsR, EdsI); UtR += cr; UtI += ci;
      mul(dUR, dUI, EdsR, EdsI); const dUtR = -0.5 * EaR + cr, dUtI = -0.5 * EaI + ci;
      mul(RUR[o + s - 1], RUI[o + s - 1], E2R[o + s - 1], E2I[o + s - 1]);
      div(1 + RUR[o + s], RUI[o + s], 1 + cr, ci); let CR = cr, CI = ci;
      for (let j = s - 2; j >= r; j--) {
        mul(EdR[o + j + 1], EdI[o + j + 1], 1 + RUR[o + j + 1], RUI[o + j + 1]); const aR = cr, aI = ci;
        mul(RUR[o + j], RUI[o + j], E2R[o + j], E2I[o + j]);
        div(aR, aI, 1 + cr, ci);
        mul(CR, CI, cr, ci); CR = cr; CI = ci;
      }
      const grR = gR[o + r], grI = gI[o + r];
      ex(grR, grI, botZ[r] - zr); const upR = cr, upI = ci;
      ex(grR, grI, zr - topZ[r]); const dnR = cr, dnI = ci;
      mul(RUR[o + r], RUI[o + r], EdR[o + r], EdI[o + r]); const reR = cr, reI = ci;
      mul(reR, reI, dnR, dnI); const rdR = cr, rdI = ci;
      const WR = upR + rdR, WI = upI + rdI;
      mul(grR, grI, upR - rdR, upI - rdI); const WzR = cr, WzI = ci;
      mul(UtR, UtI, CR, CI); const aR = cr, aI = ci;
      mul(dUtR, dUtI, CR, CI); const bR = cr, bI = ci;
      mul(aR, aI, WR, WI); GR = cr; GI = ci;
      mul(bR, bI, WR, WI); GsR = cr; GsI = ci;
      mul(aR, aI, WzR, WzI); GzR = cr; GzI = ci;
      mul(bR, bI, WzR, WzI); GzsR = cr; GzsI = ci;
    } else {
      mul(EbR, EbI, i2R, i2I); let DbR = cr, DbI = ci;
      mul(DtR, DtI, EdsR, EdsI); DbR += cr; DbI += ci;
      mul(dDR, dDI, EdsR, EdsI); const dDbR = 0.5 * EbR + cr, dDbI = 0.5 * EbI + ci;
      mul(RDR[o + s + 1], RDI[o + s + 1], E2R[o + s + 1], E2I[o + s + 1]);
      div(1 + RDR[o + s], RDI[o + s], 1 + cr, ci); let CR = cr, CI = ci;
      for (let j = s + 1; j <= r - 1; j++) {
        mul(EdR[o + j], EdI[o + j], 1 + RDR[o + j], RDI[o + j]); const aR = cr, aI = ci;
        mul(RDR[o + j + 1], RDI[o + j + 1], E2R[o + j + 1], E2I[o + j + 1]);
        div(aR, aI, 1 + cr, ci);
        mul(CR, CI, cr, ci); CR = cr; CI = ci;
      }
      const grR = gR[o + r], grI = gI[o + r];
      ex(grR, grI, zr - topZ[r]); const dnR = cr, dnI = ci;
      ex(grR, grI, botZ[r] - zr); const upR = cr, upI = ci;
      mul(RDR[o + r], RDI[o + r], EdR[o + r], EdI[o + r]); const reR = cr, reI = ci;
      mul(reR, reI, upR, upI); const ruR = cr, ruI = ci;
      const VR = dnR + ruR, VI = dnI + ruI;
      mul(grR, grI, ruR - dnR, ruI - dnI); const VzR = cr, VzI = ci;
      mul(DbR, DbI, CR, CI); const aR = cr, aI = ci;
      mul(dDbR, dDbI, CR, CI); const bR = cr, bI = ci;
      mul(aR, aI, VR, VI); GR = cr; GI = ci;
      mul(bR, bI, VR, VI); GsR = cr; GsI = ci;
      mul(aR, aI, VzR, VzI); GzR = cr; GzI = ci;
      mul(bR, bI, VzR, VzI); GzsR = cr; GzsI = ci;
    }
    outG[oo] = GR; outG[oo + 1] = GI; outG[oo + 2] = GzR; outG[oo + 3] = GzI;
    outG[oo + 4] = GsR; outG[oo + 5] = GsI; outG[oo + 6] = GzsR; outG[oo + 7] = GzsI;
  }

  // closed-form direct tensor in the source layer (full-space TIV), rho > 0; adds into T (10 doubles)
  function addDirect(omega, sh, sv, rho, dz, T) {
    const kap = Math.sqrt(sh / sv);
    const wmh = omega * MU0 * sh, wmv = omega * MU0 * sv;
    // k = sqrt(i w mu sigma) = sqrt(w mu sigma /2) (1 + i)
    const khr = Math.sqrt(0.5 * wmh), khi = khr, kvr = Math.sqrt(0.5 * wmv), kvi = kvr;
    const R = Math.hypot(rho, dz), Rv = Math.hypot(rho, kap * dz);
    // e^{i k R} = e^{-ki R} (cos(kr R) + i sin(kr R))
    let e = Math.exp(-khi * R); const ehR = e * Math.cos(khr * R), ehI = e * Math.sin(khr * R);
    e = Math.exp(-kvi * Rv); const evR = e * Math.cos(kvr * Rv), evI = e * Math.sin(kvr * Rv);
    const phR = ehR / R, phI = ehI / R;
    const kh2R = khr * khr - khi * khi, kh2I = 2 * khr * khi;             // = 0 + i wmh
    // f1 = (i kh - 1/R) phi
    const aR = -khi - 1 / R, aI = khr;
    const f1R = aR * phR - aI * phI, f1I = aR * phI + aI * phR;
    // f1p = phi * (-kh^2 - 2 i kh/R + 2/R^2)
    const bR = -kh2R + 2 * khi / R + 2 / (R * R), bI = -kh2I - 2 * khr / R;
    const f1pR = bR * phR - bI * phI, f1pI = bR * phI + bI * phR;
    const c1 = 1 / R - dz * dz / (R * R * R), c2 = dz * dz / (R * R);
    const d2zR = c1 * f1R + c2 * f1pR, d2zI = c1 * f1I + c2 * f1pI;
    const c3 = rho * dz / (R * R);
    const drR = c3 * (f1pR - f1R / R), drI = c3 * (f1pI - f1I / R);
    const psR = evR / Rv, psI = evI / Rv;
    const kv2R = kvr * kvr - kvi * kvi, kv2I = 2 * kvr * kvi;
    const q = 1 / (4 * Math.PI);
    // zz = q (d2z + kh2 phi)
    T[4] += q * (d2zR + kh2R * phR - kh2I * phI); T[5] += q * (d2zI + kh2R * phI + kh2I * phR);
    T[6] += q * drR; T[7] += q * drI; T[8] += q * drR; T[9] += q * drI;
    // coef = i kh q / rho^2 ; diff = eh - ev
    const cfR = -khi * q / (rho * rho), cfI = khr * q / (rho * rho);
    const dfR = ehR - evR, dfI = ehI - evI;
    const cdR = cfR * dfR - cfI * dfI, cdI = cfR * dfI + cfI * dfR;
    // xx = -q (d2z + f1/R) + coef*diff
    T[0] += -q * (d2zR + f1R / R) + cdR; T[1] += -q * (d2zI + f1I / R) + cdI;
    // yy = q (f1/R + kap kv2 psi) - coef*diff
    T[2] += q * (f1R / R + kap * (kv2R * psR - kv2I * psI)) - cdR; T[3] += q * (f1I / R + kap * (kv2R * psI + kv2I * psR)) - cdI;
  }

  // main entry. mdl = {N, sh, sv, zi} (typed or plain arrays; zi length N-1, ascending);
  // zs, zr positions (z down), rho = |horizontal offset| >= 0 ; sgnx = +1/-1 sign of horizontal offset.
  // T receives 10 doubles: xx,yy,zz,xz,zx (re,im)
  function core(omega, mdl, zs, zr, rhoC, filt, T) {
    const N = mdl.N, zi = mdl.zi;
    let s = 0; while (s < N - 1 && zi[s] < zs) s++;
    let r = 0; while (r < N - 1 && zi[r] < zr) r++;
    for (let j = 0; j < N; j++) {
      topZ[j] = j >= 1 ? zi[j - 1] : -Infinity; botZ[j] = j <= N - 2 ? zi[j] : Infinity;
      thick[j] = (j >= 1 && j <= N - 2) ? zi[j] - zi[j - 1] : Infinity;
      kap2[j] = mdl.sh[j] / mdl.sv[j]; wms[j] = omega * MU0 * mdl.sh[j]; invSh[j] = 1 / mdl.sh[j];
    }
    const k2I = wms[s];                                    // k_h,s^2 = i * k2I
    const scat = (r === s);
    const base = filt.base, w0a = filt.j0, w1a = filt.j1, nf = base.length;
    let zzR = 0, zzI = 0, zxR = 0, zxI = 0, xzR = 0, xzI = 0, x0R = 0, x0I = 0, x1R = 0, x1I = 0, y0R = 0, y0I = 0, y1R = 0, y1I = 0;
    for (let i = 0; i < nf; i++) {
      const lam = base[i] / rhoC, lam2 = lam * lam, w0 = w0a[i], w1 = w1a[i];
      setupMode(0, N, lam2); setupMode(1, N, lam2);
      greensMode(0, N, s, r, zs, zr, scat, 0);
      greensMode(1, N, s, r, zs, zr, scat, 8);
      // TE: G(0,1) Gz(2,3) Gs(4,5) Gzs(6,7) ; TM: G at 8,9 -> k^2 Gm = i k2I * Gm
      const GmR = -k2I * outG[9], GmI = k2I * outG[8];
      const l3 = lam2 * lam;
      zzR += l3 * w0 * outG[0]; zzI += l3 * w0 * outG[1];
      zxR += lam2 * w1 * outG[4]; zxI += lam2 * w1 * outG[5];
      xzR -= lam2 * w1 * outG[2]; xzI -= lam2 * w1 * outG[3];
      x0R += lam * w0 * outG[6]; x0I += lam * w0 * outG[7];
      x1R += w1 * (GmR - outG[6]); x1I += w1 * (GmI - outG[7]);
      y0R += lam * w0 * GmR; y0I += lam * w0 * GmI;
      y1R += w1 * (outG[6] - GmR); y1I += w1 * (outG[7] - GmI);
    }
    const q = 1 / (2 * Math.PI), ir = 1 / rhoC;
    T[4] = q * ir * zzR; T[5] = q * ir * zzI;
    T[8] = q * ir * zxR; T[9] = q * ir * zxI;
    T[6] = q * ir * xzR; T[7] = q * ir * xzI;
    T[0] = q * (ir * x0R + ir * ir * x1R); T[1] = q * (ir * x0I + ir * ir * x1I);
    T[2] = q * (ir * y0R + ir * ir * y1R); T[3] = q * (ir * y0I + ir * ir * y1I);
    if (r === s) addDirect(omega, mdl.sh[s], mdl.sv[s], rhoC, zr - zs, T);
  }

  // Public entry. Near the axis (rho < 5% of the Tx-Rx distance) the even components (xx,yy,zz,xz/rho,zx/rho) are smooth
  // functions of rho^2: evaluate at three safe nodes and extrapolate (quadratic Lagrange in rho^2; error ~1e-9 of
  // free-space scale). xz,zx are odd in the (signed) horizontal offset: T_odd = sgnx * rho * f(rho^2).
  const Tn = [new Float64Array(10), new Float64Array(10), new Float64Array(10)];
  const NODE = [0.02, 0.035, 0.05];
  function tensor(omega, mdl, zs, zr, rho, sgnx, filt, T) {
    const dz = zr - zs, Rg = Math.hypot(rho, dz);
    if (!(Rg > 1e-9)) { for (let i = 0; i < 10; i++) T[i] = 0; return; }
    if (rho >= 0.05 * Rg) {
      core(omega, mdl, zs, zr, rho, filt, T);
      if (sgnx < 0) { T[6] = -T[6]; T[7] = -T[7]; T[8] = -T[8]; T[9] = -T[9]; }
      return;
    }
    const x = rho * rho, xs = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const rk = NODE[k] * Rg; xs[k] = rk * rk;
      core(omega, mdl, zs, zr, rk, filt, Tn[k]);
      for (let c = 6; c < 10; c++) Tn[k][c] /= rk;           // odd comps -> even functions of rho
    }
    const w0 = (x - xs[1]) * (x - xs[2]) / ((xs[0] - xs[1]) * (xs[0] - xs[2]));
    const w1 = (x - xs[0]) * (x - xs[2]) / ((xs[1] - xs[0]) * (xs[1] - xs[2]));
    const w2 = (x - xs[0]) * (x - xs[1]) / ((xs[2] - xs[0]) * (xs[2] - xs[1]));
    for (let c = 0; c < 10; c++) T[c] = w0 * Tn[0][c] + w1 * Tn[1][c] + w2 * Tn[2][c];
    const sc = rho * (sgnx < 0 ? -1 : 1);
    T[6] *= sc; T[7] *= sc; T[8] *= sc; T[9] *= sc;
  }

  return { tensor, core, MAXN };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { Engine, MU0 };
