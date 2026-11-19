// ===================================================================================
// fdsolve.js -- sparse direct solver for the 2.5D finite-difference systems
//   Complex-symmetric multifrontal LDL^T (no pivoting) with geometric nested dissection on a regular lattice.
//   Lattice node (i,j), id n = i*NZ + j, three unknowns per node (dof = 3*n + c). The matrix is given as a block stencil:
//   S[((n*9 + o)*3 + c)*3 + c2] = A[(n,c),(n+off(o),c2)], o = (di+1)*3 + (dj+1), di,dj in {-1,0,1}  (re and im arrays).
// ===================================================================================
const FDSolve = (function () {
  const planCache = new Map();

  function buildPlan(NX, NZ, leafMax) {
    const key = NX + 'x' + NZ + 'x' + leafMax;
    const hit = planCache.get(key); if (hit) return hit;
    const fronts = [], pos = new Int32Array(NX * NZ).fill(-1);
    function rec(i0, i1, j0, j1) {
      const w = i1 - i0, h = j1 - j0, f = { i0, i1, j0, j1, S: [], B: [], kids: [], parent: -1, id: -1 };
      if (w * h <= leafMax || (w <= 2 && h <= 2)) {
        for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) f.S.push(i * NZ + j);
      } else if (w >= h) {
        const is = i0 + (w >> 1);
        for (let j = j0; j < j1; j++) f.S.push(is * NZ + j);
        if (is > i0) f.kids.push(rec(i0, is, j0, j1));
        if (is + 1 < i1) f.kids.push(rec(is + 1, i1, j0, j1));
      } else {
        const js = j0 + (h >> 1);
        for (let i = i0; i < i1; i++) f.S.push(i * NZ + js);
        if (js > j0) f.kids.push(rec(i0, i1, j0, js));
        if (js + 1 < j1) f.kids.push(rec(i0, i1, js + 1, j1));
      }
      for (let i = Math.max(0, i0 - 1); i <= Math.min(NX - 1, i1); i++)
        for (let j = Math.max(0, j0 - 1); j <= Math.min(NZ - 1, j1); j++)
          if (!(i >= i0 && i < i1 && j >= j0 && j < j1)) f.B.push(i * NZ + j);
      f.id = fronts.length; fronts.push(f);
      for (const k of f.kids) fronts[k].parent = f.id;
      return f.id;
    }
    const root = rec(0, NX, 0, NZ);
    for (const f of fronts) {
      const nS = f.S.length, nB = f.B.length, nodes = f.S.concat(f.B);
      f.nS = nS; f.nB = nB; f.nsD = 3 * nS; f.nbD = 3 * nB; f.nD = 3 * (nS + nB);
      f.dofS = new Int32Array(3 * nS); f.dofB = new Int32Array(3 * nB);
      for (let a = 0; a < nS; a++) for (let c = 0; c < 3; c++) f.dofS[3 * a + c] = 3 * f.S[a] + c;
      for (let a = 0; a < nB; a++) for (let c = 0; c < 3; c++) f.dofB[3 * a + c] = 3 * f.B[a] + c;
      for (let a = 0; a < nodes.length; a++) pos[nodes[a]] = a;
      // assembly triples (rows in S)
      const tri = [];
      for (let ls = 0; ls < nS; ls++) {
        const s = f.S[ls], si = (s / NZ) | 0, sj = s - si * NZ;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const ni = si + di, nj = sj + dj; if (ni < 0 || ni >= NX || nj < 0 || nj >= NZ) continue;
          const ln = pos[ni * NZ + nj]; if (ln < 0) continue;
          if (ln < nS && ln > ls) continue;                       // upper part of the S-S block: supplied by the other node
          tri.push(ls, ln, (s * 9 + (di + 1) * 3 + (dj + 1)) * 9);
        }
      }
      f.asm = Int32Array.from(tri);
      f.mapParent = null;
      for (let a = 0; a < nodes.length; a++) pos[nodes[a]] = -1;
    }
    // child -> parent maps of border nodes
    for (const f of fronts) {
      if (f.parent < 0) continue;
      const p = fronts[f.parent], pn = p.S.concat(p.B);
      for (let a = 0; a < pn.length; a++) pos[pn[a]] = a;
      f.mapParent = new Int32Array(f.nB); for (let a = 0; a < f.nB; a++) { f.mapParent[a] = pos[f.B[a]]; if (f.mapParent[a] < 0) throw new Error('fdsolve: border node missing in parent'); }
      for (let a = 0; a < pn.length; a++) pos[pn[a]] = -1;
    }
    let flops = 0, mem = 0;
    for (const f of fronts) { const ns = f.nsD, n = f.nD; for (let k = 0; k < ns; k++) flops += (n - k) * (n - k + 1) / 2; mem += n * ns; }
    const plan = { NX, NZ, fronts, root, order: fronts.map((f) => f.id), flops, mem, ndof: 3 * NX * NZ };
    planCache.set(key, plan);
    return plan;
  }

  // ---- dense kernel: partial LDL^T on the first ns pivots of an n x n symmetric matrix (lower triangle, row-major, split re/im)
  let Wr = new Float64Array(4 * 512), Wi = new Float64Array(4 * 512);
  function partialLDL(Fr, Fi, n, ns) {
    if (Wr.length < 4 * n) { Wr = new Float64Array(4 * n); Wi = new Float64Array(4 * n); }
    let k = 0;
    while (k < ns) {
      const kb = Math.min(4, ns - k);
      for (let p = 0; p < kb; p++) {
        const kk = k + p;
        for (let q = 0; q < p; q++) {
          const kq = k + q, dR = Fr[kq * n + kq], dI = Fi[kq * n + kq];
          const lkR = Fr[kk * n + kq], lkI = Fi[kk * n + kq];
          const tR = dR * lkR - dI * lkI, tI = dR * lkI + dI * lkR;
          for (let i = kk; i < n; i++) {
            const lR = Fr[i * n + kq], lI = Fi[i * n + kq];
            Fr[i * n + kk] -= lR * tR - lI * tI; Fi[i * n + kk] -= lR * tI + lI * tR;
          }
        }
        const dR = Fr[kk * n + kk], dI = Fi[kk * n + kk], den = dR * dR + dI * dI, iR = dR / den, iI = -dI / den;
        for (let i = kk + 1; i < n; i++) {
          const aR = Fr[i * n + kk], aI = Fi[i * n + kk];
          Fr[i * n + kk] = aR * iR - aI * iI; Fi[i * n + kk] = aR * iI + aI * iR;
        }
      }
      const k1 = k + kb;
      for (let p = 0; p < kb; p++) {
        const kp = k + p, dR = Fr[kp * n + kp], dI = Fi[kp * n + kp];
        for (let j = k1; j < n; j++) { const lR = Fr[j * n + kp], lI = Fi[j * n + kp]; Wr[p * n + j] = dR * lR - dI * lI; Wi[p * n + j] = dR * lI + dI * lR; }
      }
      if (kb === 4) {
        for (let i = k1; i < n; i++) {
          const ro = i * n, a0r = Fr[ro + k], a0i = Fi[ro + k], a1r = Fr[ro + k + 1], a1i = Fi[ro + k + 1], a2r = Fr[ro + k + 2], a2i = Fi[ro + k + 2], a3r = Fr[ro + k + 3], a3i = Fi[ro + k + 3];
          for (let j = k1; j <= i; j++) {
            const w0r = Wr[j], w0i = Wi[j], w1r = Wr[n + j], w1i = Wi[n + j], w2r = Wr[2 * n + j], w2i = Wi[2 * n + j], w3r = Wr[3 * n + j], w3i = Wi[3 * n + j];
            Fr[ro + j] -= a0r * w0r - a0i * w0i + a1r * w1r - a1i * w1i + a2r * w2r - a2i * w2i + a3r * w3r - a3i * w3i;
            Fi[ro + j] -= a0r * w0i + a0i * w0r + a1r * w1i + a1i * w1r + a2r * w2i + a2i * w2r + a3r * w3i + a3i * w3r;
          }
        }
      } else {
        for (let i = k1; i < n; i++) {
          const ro = i * n;
          for (let p = 0; p < kb; p++) {
            const ar = Fr[ro + k + p], ai = Fi[ro + k + p], wo = p * n;
            for (let j = k1; j <= i; j++) { const wr = Wr[wo + j], wi = Wi[wo + j]; Fr[ro + j] -= ar * wr - ai * wi; Fi[ro + j] -= ar * wi + ai * wr; }
          }
        }
      }
      k = k1;
    }
  }

  // ---- buffer pool
  const pool = new Map();
  function getBuf(len) { const a = pool.get(len); if (a && a.length) { const b = a.pop(); b.fill(0); return b; } return new Float64Array(len); }
  function putBuf(b) { let a = pool.get(b.length); if (!a) { a = []; pool.set(b.length, a); } if (a.length < 6) a.push(b); }

  function Factorization(plan) {
    this.plan = plan;
    this.L = plan.fronts.map((f) => ({ lr: new Float64Array(f.nD * f.nsD), li: new Float64Array(f.nD * f.nsD), dr: new Float64Array(f.nsD), di: new Float64Array(f.nsD) }));
    this.ok = false;
  }
  // SR, SI : block stencil (Float64Array(NX*NZ*81))
  Factorization.prototype.factor = function (SR, SI) {
    const plan = this.plan, fronts = plan.fronts, FR = new Array(fronts.length), FI = new Array(fronts.length);
    for (let t = 0; t < fronts.length; t++) {                    // fronts are stored in post-order
      const f = fronts[t], n = f.nD, ns = f.nsD, nsN = f.nS;
      const Fr = getBuf(n * n), Fi = getBuf(n * n);
      // original entries
      const asm = f.asm;
      for (let q = 0; q < asm.length; q += 3) {
        const ls = asm[q], ln = asm[q + 1], src = asm[q + 2];
        if (ln >= nsN) {                                         // S-B block: store transposed in the (B,S) lower block
          for (let c = 0; c < 3; c++) for (let c2 = 0; c2 < 3; c2++) {
            const r = 3 * ln + c2, cc = 3 * ls + c;
            Fr[r * n + cc] += SR[src + c * 3 + c2]; Fi[r * n + cc] += SI[src + c * 3 + c2];
          }
        } else if (ln < ls) {                                    // S-S, lower block
          for (let c = 0; c < 3; c++) for (let c2 = 0; c2 < 3; c2++) {
            const r = 3 * ls + c, cc = 3 * ln + c2;
            Fr[r * n + cc] += SR[src + c * 3 + c2]; Fi[r * n + cc] += SI[src + c * 3 + c2];
          }
        } else {                                                 // diagonal node block: lower part only
          for (let c = 0; c < 3; c++) for (let c2 = 0; c2 <= c; c2++) {
            const r = 3 * ls + c, cc = 3 * ls + c2;
            Fr[r * n + cc] += SR[src + c * 3 + c2]; Fi[r * n + cc] += SI[src + c * 3 + c2];
          }
        }
      }
      // children updates
      for (const kid of f.kids) {
        const c = fronts[kid], mp = c.mapParent, Cr = FR[kid], Ci = FI[kid], cn = c.nD, cs = c.nsD, nb = c.nB;
        for (let a = 0; a < nb; a++) {
          const pa = mp[a];
          for (let b = 0; b <= a; b++) {
            const pb = mp[b];
            for (let ca = 0; ca < 3; ca++) {
              const cmax = a === b ? ca : 2;
              for (let cb = 0; cb <= cmax; cb++) {
                const vr = Cr[(cs + 3 * a + ca) * cn + cs + 3 * b + cb], vi = Ci[(cs + 3 * a + ca) * cn + cs + 3 * b + cb];
                let r = 3 * pa + ca, cc = 3 * pb + cb; if (r < cc) { const t2 = r; r = cc; cc = t2; }
                Fr[r * n + cc] += vr; Fi[r * n + cc] += vi;
              }
            }
          }
        }
        putBuf(Cr); putBuf(Ci); FR[kid] = null; FI[kid] = null;
      }
      partialLDL(Fr, Fi, n, ns);
      const Lf = this.L[t];
      for (let i = 0; i < n; i++) {
        const ro = i * n, lo = i * ns, lim = Math.min(ns, i + 1);
        for (let p = 0; p < lim; p++) { Lf.lr[lo + p] = Fr[ro + p]; Lf.li[lo + p] = Fi[ro + p]; }
      }
      for (let p = 0; p < ns; p++) { Lf.dr[p] = Fr[p * n + p]; Lf.di[p] = Fi[p * n + p]; }
      if (f.nB > 0) { FR[t] = Fr; FI[t] = Fi; } else { putBuf(Fr); putBuf(Fi); }
    }
    this.ok = true;
  };

  // Solve A x = b for nrhs right-hand sides. BR,BI: Float64Array(ndof*nrhs), dof-major (index dof*nrhs + r). Result overwrites BR,BI.
  Factorization.prototype.solve = function (BR, BI, nrhs) {
    const plan = this.plan, fronts = plan.fronts, nr = nrhs;
    // forward
    for (let t = 0; t < fronts.length; t++) {
      const f = fronts[t], Lf = this.L[t], ns = f.nsD, nb = f.nbD, dofS = f.dofS, dofB = f.dofB, lr = Lf.lr, li = Lf.li;
      for (let i = 0; i < ns; i++) {
        const gi = dofS[i] * nr, lo = i * ns;
        for (let p = 0; p < i; p++) {
          const lR = lr[lo + p], lI = li[lo + p]; if (lR === 0 && lI === 0) continue;
          const gp = dofS[p] * nr;
          for (let r = 0; r < nr; r++) { const yR = BR[gp + r], yI = BI[gp + r]; BR[gi + r] -= lR * yR - lI * yI; BI[gi + r] -= lR * yI + lI * yR; }
        }
      }
      for (let i = 0; i < nb; i++) {
        const gi = dofB[i] * nr, lo = (ns + i) * ns;
        for (let p = 0; p < ns; p++) {
          const lR = lr[lo + p], lI = li[lo + p]; if (lR === 0 && lI === 0) continue;
          const gp = dofS[p] * nr;
          for (let r = 0; r < nr; r++) { const yR = BR[gp + r], yI = BI[gp + r]; BR[gi + r] -= lR * yR - lI * yI; BI[gi + r] -= lR * yI + lI * yR; }
        }
      }
    }
    // backward (parents first)
    for (let t = fronts.length - 1; t >= 0; t--) {
      const f = fronts[t], Lf = this.L[t], ns = f.nsD, nb = f.nbD, dofS = f.dofS, dofB = f.dofB, lr = Lf.lr, li = Lf.li;
      for (let p = 0; p < ns; p++) {                           // z = y / D
        const dR = Lf.dr[p], dI = Lf.di[p], den = dR * dR + dI * dI, iR = dR / den, iI = -dI / den, gp = dofS[p] * nr;
        for (let r = 0; r < nr; r++) { const a = BR[gp + r], b = BI[gp + r]; BR[gp + r] = a * iR - b * iI; BI[gp + r] = a * iI + b * iR; }
      }
      for (let i = 0; i < nb; i++) {                           // z_S -= L21^T x_B
        const gi = dofB[i] * nr, lo = (ns + i) * ns;
        for (let p = 0; p < ns; p++) {
          const lR = lr[lo + p], lI = li[lo + p]; if (lR === 0 && lI === 0) continue;
          const gp = dofS[p] * nr;
          for (let r = 0; r < nr; r++) { const xR = BR[gi + r], xI = BI[gi + r]; BR[gp + r] -= lR * xR - lI * xI; BI[gp + r] -= lR * xI + lI * xR; }
        }
      }
      for (let i = ns - 1; i >= 0; i--) {                      // L11^T back substitution
        const gi = dofS[i] * nr;
        for (let p = i + 1; p < ns; p++) {
          const lR = lr[p * ns + i], lI = li[p * ns + i]; if (lR === 0 && lI === 0) continue;
          const gp = dofS[p] * nr;
          for (let r = 0; r < nr; r++) { const xR = BR[gp + r], xI = BI[gp + r]; BR[gi + r] -= lR * xR - lI * xI; BI[gi + r] -= lR * xI + lI * xR; }
        }
      }
    }
  };

  return { buildPlan, Factorization };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { FDSolve };
