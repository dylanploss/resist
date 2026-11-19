// ===================================================================================
// invert.js -- noise model + per-station 1D inversion (bounded Levenberg-Marquardt, multi-start, continuation)
//   Needs: Engine, HANKEL_FILTERS, model.js helpers
// ===================================================================================
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gaussRng(rng) { let spare = null; return function () { if (spare !== null) { const s = spare; spare = null; return s; } let u = 0, v = 0; while (u === 0) u = rng(); v = rng(); const m = Math.sqrt(-2 * Math.log(u)); spare = m * Math.sin(2 * Math.PI * v); return m * Math.cos(2 * Math.PI * v); }; }

// noise = { ampDb, phaseDeg, floorPpm, biasDb, biasDeg, seed }   (normalised units: free-space ZZ coupling = 1)
function addNoise(data, nSt, nch, noise) {
  const g = gaussRng(mulberry32((noise.seed | 0) || 1)), out = new Float64Array(data.length);
  const bg = new Float64Array(nch), bp = new Float64Array(nch);
  for (let c = 0; c < nch; c++) { bg[c] = (noise.biasDb || 0) * g(); bp[c] = (noise.biasDeg || 0) * g(); }
  const fl = (noise.floorPpm || 0) * 1e-6;
  for (let i = 0; i < nSt; i++) for (let c = 0; c < nch; c++) {
    const k = 2 * (i * nch + c), re = data[k], im = data[k + 1];
    const amp = Math.hypot(re, im), ph = Math.atan2(im, re);
    const a2 = amp * Math.pow(10, ((noise.ampDb || 0) * g() + bg[c]) / 20), p2 = ph + ((noise.phaseDeg || 0) * g() + bp[c]) * D2R;
    out[k] = a2 * Math.cos(p2) + fl * g(); out[k + 1] = a2 * Math.sin(p2) + fl * g();
  }
  return out;
}

// ---------------------------------------------------------------- per-station inversion machinery ----
// prep: geometry of the selected channels at one station for an assumed formation normal
function prepInvStation(st, nrm, pch) {
  const combos = [], cmap = {}, chan = [];
  for (let c = 0; c < pch.length; c++) {
    const ch = pch[c]; let ci = cmap[ch.key];
    const pg = pairGeom(st, nrm, ch.L);
    if (ci === undefined) { ci = combos.length; cmap[ch.key] = ci; combos.push({ omega: 2 * Math.PI * ch.f, dzT: pg.dzT, dzR: pg.dzR, rho: pg.rho }); }
    chan.push({ ci, af: toFormation(st, pg, ch.a), bf: toFormation(st, pg, ch.b), sc: 2 * Math.PI * Math.abs(ch.L) ** 3 });
  }
  return { combos, chan, Ts: combos.map(() => new Float64Array(10)) };
}
function invForward(prep, mdl, filt, out) {
  const { combos, chan, Ts } = prep;
  for (let i = 0; i < combos.length; i++) { const c = combos[i]; Engine.tensor(c.omega, mdl, c.dzT, c.dzR, c.rho, 1, filt, Ts[i]); }
  for (let c = 0; c < chan.length; c++) { const ch = chan[c], v = chanFromT(Ts[ch.ci], ch.af, ch.bf); out[2 * c] = v[0] * ch.sc; out[2 * c + 1] = v[1] * ch.sc; }
}

// parameter set: spec = { layers:[{rh:{v,lo,hi,free}, kv:{...}}], d1:{...}, t:[{...}] }  (rh, kv, t in ln space internally)
function packSpec(spec) {
  const N = spec.layers.length, P = [];
  const add = (name, p, ln) => { const f = ln ? Math.log : (x) => x; P.push({ name, v: f(p.v), lo: f(p.lo), hi: f(p.hi), free: !!p.free, ln }); };
  for (let k = 0; k < N; k++) add('rh' + k, spec.layers[k].rh, true);
  for (let k = 0; k < N; k++) add('kv' + k, spec.layers[k].kv, true);
  if (N > 1) add('d1', spec.d1, false);
  for (let k = 0; k < N - 2; k++) add('t' + (k + 1), spec.t[k], true);
  return { N, P, x0: Float64Array.from(P.map(p => p.v)), lo: Float64Array.from(P.map(p => p.lo)), hi: Float64Array.from(P.map(p => p.hi)), free: P.map((p, i) => p.free ? i : -1).filter(i => i >= 0) };
}
function xToModel(N, x, mdl) {
  for (let k = 0; k < N; k++) { const rh = Math.exp(x[k]), rv = rh * Math.exp(x[N + k]); mdl.sh[k] = 1 / rh; mdl.sv[k] = 1 / rv; }
  if (N > 1) { mdl.zi[0] = x[2 * N]; for (let k = 1; k < N - 1; k++) mdl.zi[k] = mdl.zi[k - 1] + Math.exp(x[2 * N + k]); }
}
function modelToReport(N, x) {       // human-readable parameter values
  const rh = [], rv = [], zi = [];
  for (let k = 0; k < N; k++) { rh.push(Math.exp(x[k])); rv.push(Math.exp(x[k] + x[N + k])); }
  if (N > 1) { zi.push(x[2 * N]); for (let k = 1; k < N - 1; k++) zi.push(zi[k - 1] + Math.exp(x[2 * N + k])); }
  return { rh, rv, zi };
}

// residual weights from assumed noise and observed values
function makeWeights(obs, nch, an) {
  const a = Math.log(10) / 20 * (an.ampDb || 0), p = (an.phaseDeg || 0) * D2R, fl = Math.max(1e-9, (an.floorPpm || 0) * 1e-6);
  const dir = new Float64Array(2 * nch), wr = new Float64Array(nch), wt = new Float64Array(nch);
  for (let c = 0; c < nch; c++) {
    const re = obs[2 * c], im = obs[2 * c + 1], amp = Math.hypot(re, im);
    if (amp > 1e-12) { dir[2 * c] = re / amp; dir[2 * c + 1] = im / amp; } else { dir[2 * c] = 1; dir[2 * c + 1] = 0; }
    wr[c] = 1 / Math.sqrt((amp * a) ** 2 + fl * fl); wt[c] = 1 / Math.sqrt((amp * p) ** 2 + fl * fl);
  }
  return { dir, wr, wt };
}
function residuals(sim, obs, nch, W, r) {
  for (let c = 0; c < nch; c++) {
    const dr = sim[2 * c] - obs[2 * c], di = sim[2 * c + 1] - obs[2 * c + 1], ux = W.dir[2 * c], uy = W.dir[2 * c + 1];
    r[2 * c] = (dr * ux + di * uy) * W.wr[c]; r[2 * c + 1] = (-dr * uy + di * ux) * W.wt[c];
  }
}

function solveSym(A, b, n) {           // Gaussian elimination with partial pivoting; A (n x n, row-major) destroyed
  for (let i = 0; i < n; i++) {
    let p = i, m = Math.abs(A[i * n + i]); for (let k = i + 1; k < n; k++) { const v = Math.abs(A[k * n + i]); if (v > m) { m = v; p = k; } }
    if (m < 1e-300) return false;
    if (p !== i) { for (let j = 0; j < n; j++) { const t = A[i * n + j]; A[i * n + j] = A[p * n + j]; A[p * n + j] = t; } const t = b[i]; b[i] = b[p]; b[p] = t; }
    for (let k = i + 1; k < n; k++) { const f = A[k * n + i] / A[i * n + i]; if (f === 0) continue; for (let j = i; j < n; j++) A[k * n + j] -= f * A[i * n + j]; b[k] -= f * b[i]; }
  }
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i * n + j] * b[j]; b[i] = s / A[i * n + i]; }
  return true;
}
function invertSym(A0, n) {            // inverse via Gauss-Jordan (small n)
  const A = Float64Array.from(A0), I = new Float64Array(n * n); for (let i = 0; i < n; i++) I[i * n + i] = 1;
  for (let i = 0; i < n; i++) {
    let p = i, m = Math.abs(A[i * n + i]); for (let k = i + 1; k < n; k++) { const v = Math.abs(A[k * n + i]); if (v > m) { m = v; p = k; } }
    if (m < 1e-300) return null;
    if (p !== i) for (let j = 0; j < n; j++) { let t = A[i * n + j]; A[i * n + j] = A[p * n + j]; A[p * n + j] = t; t = I[i * n + j]; I[i * n + j] = I[p * n + j]; I[p * n + j] = t; }
    const d = A[i * n + i]; for (let j = 0; j < n; j++) { A[i * n + j] /= d; I[i * n + j] /= d; }
    for (let k = 0; k < n; k++) if (k !== i) { const f = A[k * n + i]; if (f !== 0) for (let j = 0; j < n; j++) { A[k * n + j] -= f * A[i * n + j]; I[k * n + j] -= f * I[i * n + j]; } }
  }
  return I;
}

// generic bounded LM on the free parameters. ctx: {N, prep, filt, obs, nch, W, mdl, sim, r, rn, lo, hi, free, hstep}
function lmRun(ctx, x0, maxIter) {
  const { N, prep, filt, nch, W, obs, mdl, sim, free, lo, hi } = ctx, nf = free.length, nr = 2 * nch;
  const x = Float64Array.from(x0), r = new Float64Array(nr), rn = new Float64Array(nr), J = new Float64Array(nr * nf), xt = new Float64Array(x.length);
  const evalR = (xx, rr) => { xToModel(N, xx, mdl); invForward(prep, mdl, filt, sim); residuals(sim, obs, nch, W, rr); let s = 0; for (let i = 0; i < nr; i++) s += rr[i] * rr[i]; return s; };
  let cost = evalR(x, r), mu = 1e-2, it = 0, nfev = 1;
  const A = new Float64Array(nf * nf), g = new Float64Array(nf), dlt = new Float64Array(nf);
  const jac = () => {
    for (let a = 0; a < nf; a++) {
      const i = free[a]; xt.set(x); const h = (ctx.hstep[i]) * (x[i] + ctx.hstep[i] > hi[i] ? -1 : 1);
      xt[i] = x[i] + h; xToModel(N, xt, mdl); invForward(prep, mdl, filt, sim); residuals(sim, obs, nch, W, rn); nfev++;
      for (let k = 0; k < nr; k++) J[k * nf + a] = (rn[k] - r[k]) / h;
    }
  };
  for (; it < maxIter; it++) {
    jac();
    for (let a = 0; a < nf; a++) { let s = 0; for (let k = 0; k < nr; k++) s += J[k * nf + a] * r[k]; g[a] = s; for (let b = a; b < nf; b++) { let q = 0; for (let k = 0; k < nr; k++) q += J[k * nf + a] * J[k * nf + b]; A[a * nf + b] = q; A[b * nf + a] = q; } }
    let accepted = false, cn = cost;
    for (let tr = 0; tr < 12; tr++) {
      const M = Float64Array.from(A); for (let a = 0; a < nf; a++) M[a * nf + a] += mu * (A[a * nf + a] + 1e-12);
      for (let a = 0; a < nf; a++) dlt[a] = -g[a];
      if (!solveSym(M, dlt, nf)) { mu *= 10; continue; }
      xt.set(x); for (let a = 0; a < nf; a++) { const i = free[a]; xt[i] = Math.min(hi[i], Math.max(lo[i], x[i] + dlt[a])); }
      cn = evalR(xt, rn); nfev++;
      if (cn < cost) { accepted = true; break; } mu *= 5;
    }
    if (!accepted) break;
    const dec = cost - cn; x.set(xt); r.set(rn); cost = cn; mu = Math.max(mu / 4, 1e-10);
    if (dec < 1e-6 * cost + 1e-10) { it++; break; }
  }
  return { x, cost, it, nfev };
}

function stationUncertainty(ctx, x, cost) {
  // covariance of free parameters from the Gauss-Newton Hessian of the weighted residuals at the solution
  const { N, prep, filt, nch, W, obs, mdl, sim, free } = ctx, nf = free.length, nr = 2 * nch;
  const r = new Float64Array(nr), rn = new Float64Array(nr), J = new Float64Array(nr * nf), xt = Float64Array.from(x);
  xToModel(N, x, mdl); invForward(prep, mdl, filt, sim); residuals(sim, obs, nch, W, r);
  for (let a = 0; a < nf; a++) { const i = free[a], h = ctx.hstep[i]; xt.set(x); xt[i] += h; xToModel(N, xt, mdl); invForward(prep, mdl, filt, sim); residuals(sim, obs, nch, W, rn); for (let k = 0; k < nr; k++) J[k * nf + a] = (rn[k] - r[k]) / h; }
  const A = new Float64Array(nf * nf); for (let a = 0; a < nf; a++) for (let b = 0; b < nf; b++) { let q = 0; for (let k = 0; k < nr; k++) q += J[k * nf + a] * J[k * nf + b]; A[a * nf + b] = q + (a === b ? 1e-12 : 0); }
  const C = invertSym(A, nf), sd = new Float64Array(x.length).fill(0);
  if (C) for (let a = 0; a < nf; a++) sd[free[a]] = Math.sqrt(Math.max(0, C[a * nf + a]));
  return { sd, C };
}

// inversion config: icfg = { spec, channels (indices into tool channels), assumed:{ampDb,phaseDeg,floorPpm}, nStarts, maxIter, filter,
//                            dipErr, dipAzErr, continuation, startSpread:{lnRho, d}, seed, acceptChi2 }
// station truth used only for dip definition; geometry source: cfg (forward config) for the local normal
function assumedNormal(cfg, st, icfg) {
  let dip, dipAz;
  if (cfg.mode === '1d') { const l = buildLocal1D(cfg.geo1); dip = l.dip; dipAz = l.dipAz; }
  else { const l = buildLocal2D(cfg.geo2, st, cfg.slopeWin); dip = l.dip; dipAz = l.dipAz; }
  return dipNormal(Math.max(0, dip + (icfg.dipErr || 0) * D2R), dipAz + (icfg.dipAzErr || 0) * D2R);
}
function invertRange(cfg, icfg, tr, stations, obsAll, i0, i1, res, progress) {
  const nTool = cfg.channels.length, sel = icfg.channels, nch = sel.length;
  const pch = prepChannels(sel.map(i => cfg.channels[i])), filt = HANKEL_FILTERS[icfg.filter || 'key_101_2012'];
  const ps = packSpec(icfg.spec), N = ps.N, np = ps.x0.length;
  const rng = mulberry32((icfg.seed | 0) + 17 * i0 + 1);
  const mdl = { N, sh: new Float64Array(N), sv: new Float64Array(N), zi: new Float64Array(Math.max(0, N - 1)) };
  const hstep = new Float64Array(np).fill(1e-4); for (let i = 0; i < np; i++) if (!ps.P[i].ln) hstep[i] = 2e-3;
  const obs = new Float64Array(2 * nch), sim = new Float64Array(2 * nch), rtmp = new Float64Array(2 * nch);
  const ndof = Math.max(1, 2 * nch - ps.free.length), acc = icfg.acceptChi2 || 1.5;
  const ctxs = new Array(i1 - i0);                                   // per-station context (kept for refinement passes)
  const getCtx = (i) => {
    let c = ctxs[i - i0]; if (c) return c;
    const st = stations[i];
    const o = new Float64Array(2 * nch); for (let q = 0; q < nch; q++) { o[2 * q] = obsAll[2 * (i * nTool + sel[q])]; o[2 * q + 1] = obsAll[2 * (i * nTool + sel[q]) + 1]; }
    const nrm = assumedNormal(cfg, st, icfg), prep = prepInvStation(st, nrm, pch), W = makeWeights(o, nch, icfg.assumed);
    c = ctxs[i - i0] = { N, prep, filt, obs: o, nch, W, mdl, sim, lo: ps.lo, hi: ps.hi, free: ps.free, hstep, nrm };
    return c;
  };
  const costAt = (ctx, x) => { xToModel(N, x, mdl); invForward(ctx.prep, mdl, filt, sim); residuals(sim, ctx.obs, nch, ctx.W, rtmp); let c = 0; for (let q = 0; q < 2 * nch; q++) c += rtmp[q] * rtmp[q]; return c; };
  const solveOne = (i, startList, screen) => {
    const ctx = getCtx(i); let best = null, nfev = 0;
    const tryStart = (x) => { const out = lmRun(ctx, x, icfg.maxIter || 30); nfev += out.nfev; if (!best || out.cost < best.cost) best = out; return best.cost / ndof <= acc; };
    let done = false;
    for (const x of startList) { if (tryStart(x)) { done = true; break; } }
    if (!done && !tryStart(ps.x0) && screen && (icfg.nStarts | 0) > 0) {
      // global screening: cheap forward evaluations at random candidates (half near the start model, half over the full bounds)
      const K = icfg.screen === undefined ? 60 : icfg.screen | 0, cands = [], sp = icfg.startSpread || {};
      for (let k = 0; k < K; k++) {
        const x = Float64Array.from(ps.x0), wide = (k & 1) === 1;
        for (const j of ps.free) {
          const P = ps.P[j]; const v = wide ? ps.lo[j] + (ps.hi[j] - ps.lo[j]) * rng() : x[j] + (P.ln ? (sp.lnRho || 1) : (sp.d || 5)) * (rng() * 2 - 1);
          x[j] = Math.min(ps.hi[j], Math.max(ps.lo[j], v));
        }
        cands.push({ x, c: costAt(ctx, x) }); nfev++;
      }
      cands.sort((p, q) => p.c - q.c);
      for (let s = 0; s < Math.min(cands.length, icfg.nStarts | 0); s++) if (tryStart(cands[s].x)) break;
    }
    return { best, nfev };
  };
  const finish = (i, best, nfev) => {
    const ctx = getCtx(i), unc = stationUncertainty(ctx, best.x, best.cost), sd = unc.sd, rep = modelToReport(N, best.x);
    // 1-sigma of each boundary position zi_k = d1 + sum_{j<=k} exp(x_tj), propagated with the full covariance of the free parameters
    const nfree = ps.free.length, fpos = {}; ps.free.forEach((p, a) => { fpos[p] = a; });
    const zsd = new Float64Array(Math.max(0, N - 1));
    if (unc.C) for (let k = 0; k < N - 1; k++) {
      const g = []; if (fpos[2 * N] !== undefined) g.push([fpos[2 * N], 1]);
      for (let j = 1; j <= k; j++) if (fpos[2 * N + j] !== undefined) g.push([fpos[2 * N + j], Math.exp(best.x[2 * N + j])]);
      let v = 0; for (const p of g) for (const q of g) v += p[1] * q[1] * unc.C[p[0] * nfree + q[0]];
      zsd[k] = Math.sqrt(Math.max(0, v));
    }
    xToModel(N, best.x, mdl); invForward(ctx.prep, mdl, filt, sim);
    return { i, x: Float64Array.from(best.x), sd, zsd, chi2: best.cost / ndof, rh: rep.rh, rv: rep.rv, zi: rep.zi, nfev, sim: Float64Array.from(sim), nrm: ctx.nrm };
  };
  // pass 1: forward sweep with continuation
  let xPrev = null;
  for (let i = i0; i < i1; i++) {
    const { best, nfev } = solveOne(i, icfg.continuation && xPrev ? [xPrev] : [], true);
    xPrev = best.x; res.push(finish(i, best, nfev));
    if (progress) progress(i - i0 + 1, 2 * (i1 - i0));
  }
  // pass 2: re-start poorly fitting stations from the solutions of good neighbours (both sweep directions)
  const passes = icfg.refinePasses === undefined ? 2 : icfg.refinePasses | 0;
  for (let ps2 = 0; ps2 < passes; ps2++) {
    let improved = 0;
    for (let ii = 0; ii < i1 - i0; ii++) {
      const i = ps2 % 2 === 0 ? i0 + ii : i1 - 1 - ii, k = i - i0;
      if (res[k].chi2 <= acc) continue;
      const nb = []; for (const dk of [-1, 1, -2, 2, -3, 3]) { const j = k + dk; if (j >= 0 && j < res.length && res[j].chi2 <= Math.max(acc, res[k].chi2 * 0.5)) nb.push(res[j].x); }
      if (!nb.length) continue;
      const { best, nfev } = solveOne(i, nb, false);
      if (best && best.cost / ndof < res[k].chi2 * 0.98) { res[k] = finish(i, best, res[k].nfev + nfev); improved++; }
    }
    if (progress) progress(i1 - i0 + (ps2 + 1) * (i1 - i0) / Math.max(1, passes), 2 * (i1 - i0));
    if (!improved) break;
  }
  return res;
}

// truth in the inversion's parameterisation (distance to boundaries along the normal from the tool midpoint)
function truthAt(cfg, st) {
  let loc, zm;
  if (cfg.mode === '1d') { loc = buildLocal1D(cfg.geo1); zm = v3.dot(loc.nrm, st.r); } else { loc = buildLocal2D(cfg.geo2, st, cfg.slopeWin); zm = loc.zm; }
  const rh = [], rv = [], zi = [];
  for (let k = 0; k < loc.N; k++) { rh.push(1 / loc.sh[k]); rv.push(1 / loc.sv[k]); }
  for (let k = 0; k < loc.N - 1; k++) zi.push(loc.zi[k] - zm);
  return { rh, rv, zi, dip: loc.dip * R2D, dipAz: loc.dipAz * R2D, nrm: loc.nrm };
}
