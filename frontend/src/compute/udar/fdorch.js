// ===================================================================================
// fdorch.js -- planning of a 2.5D run: station selection along the well, detection of jumps of the local-1D baseline,
//   interpolation of the 2D-minus-1D difference tensors along the well and assembly of the channel data.
//   data(2.5D) = data(local 1D, exact) + interpolated [FD(2D model) - FD(local-1D model)]
//   Needs: model.js (v3, orientVec, chanFromT, prepChannels, buildLocal2D, layerProps2D, secX, D2R) and fd25d.js
// ===================================================================================
const FDORCH = (function () {
  const QUALITY = {
    // grid / quadrature settings of each solve, and the refinement tolerances along the well (fractions of the free-space coupling)
    draft: { label: 'Draft', res: 6, sres: 2.5, nk: 6, sub: 6, nodeBudget: 4500, ext: 1.25, secs: 1.5, ref: { refineThr: 0.1, absTol: 0.01, curvTol: 0.006, curvThr: 0.03, rounds: 2 } },
    std: { label: 'Standard', res: 8, sres: 3.5, nk: 8, sub: 8, nodeBudget: 9000, ext: 1.2, secs: 5, ref: { refineThr: 0.05, absTol: 0.004, curvTol: 0.002, curvThr: 0.01 } },
    fine: { label: 'Fine', res: 12, sres: 5, nk: 10, sub: 8, nodeBudget: 16000, ext: 1.15, secs: 16, ref: { refineThr: 0.04, absTol: 0.003, curvTol: 0.0015, curvThr: 0.008 } },
  };
  function options(cfg) {
    const f = cfg.fd || {}, q = QUALITY[f.q] || QUALITY.std, fd = Object.assign({}, q); delete fd.label; delete fd.secs; delete fd.ref;
    return Object.assign({ q: QUALITY[f.q] ? f.q : 'std', step: Math.max(2, +f.step || 25), rounds: 4, maxStations: 400, fd, secs: q.secs }, q.ref);
  }
  // ---- frames -------------------------------------------------------------------------------------------------
  function secFrame(cfg) { const a = cfg.geo2.azSec * D2R, c = Math.cos(a), s = Math.sin(a); return { ex: [c, s, 0], ey: [-s, c, 0], ez: [0, 0, 1] }; }
  function antSec(st, fr, a) {                      // antenna vector in tool components -> (x_sec, y_sec, z) components
    const v = [a[0] * st.xt[0] + a[1] * st.yt[0] + a[2] * st.zt[0], a[0] * st.xt[1] + a[1] * st.yt[1] + a[2] * st.zt[1], a[0] * st.xt[2] + a[1] * st.yt[2] + a[2] * st.zt[2]];
    return [v3.dot(v, fr.ex), v3.dot(v, fr.ey), v3.dot(v, fr.ez)];
  }
  function stationAxis(cfg, st) { const fr = secFrame(cfg); return { ax: [v3.dot(st.zt, fr.ex), st.zt[2]], off: v3.dot(st.zt, fr.ey) }; }
  // largest out-of-plane component of the tool axis along the well (the 2.5D solver needs the well to stay in the section plane)
  function maxOutOfPlane(cfg, tr) {
    const a = cfg.geo2.azSec * D2R, s = Math.sin(a), c = Math.cos(a); let m = 0;
    for (let i = 0; i < tr.md.length; i += 4) { const si = Math.sin(tr.inc[i]); m = Math.max(m, Math.abs(si * (-s * Math.cos(tr.az[i]) + c * Math.sin(tr.az[i])))); }
    return m;
  }
  // ---- channel pairs and frequency groups ------------------------------------------------------------------------
  function groups(cfg) {
    const pairs = [], index = {}, byF = new Map();
    cfg.channels.forEach((c) => { const k = c.L + '|' + c.f; if (!(k in index)) { index[k] = pairs.length; pairs.push({ L: c.L, f: c.f, key: k }); } });
    pairs.forEach((p, i) => { if (!byF.has(p.f)) byF.set(p.f, { f: p.f, Ls: [], pidx: [] }); const g = byF.get(p.f); g.Ls.push(p.L); g.pidx.push(i); });
    return { pairs, index, byF: Array.from(byF.values()) };
  }
  // ---- jumps of the local-1D baseline (vertical steps of horizons, nearest-horizon switches, steep property jumps) ----
  function analyse(cfg, st) {
    const g = cfg.geo2, n = st.length, xm = new Float64Array(n), kn = new Int16Array(n);
    for (let i = 0; i < n; i++) { xm[i] = secX(g, st[i].r[0], st[i].r[1]); kn[i] = buildLocal2D(g, st[i], cfg.slopeWin).kn; }
    const steps = []; for (const hz of g.horizons) for (let q = 1; q < hz.pts.length; q++) if (Math.abs(hz.pts[q][0] - hz.pts[q - 1][0]) < 1e-9 && Math.abs(hz.pts[q][1] - hz.pts[q - 1][1]) > 1e-6) steps.push(hz.pts[q][0]);
    const brk = new Uint8Array(Math.max(0, n - 1));
    for (let i = 0; i < n - 1; i++) {
      const a = Math.min(xm[i], xm[i + 1]), b = Math.max(xm[i], xm[i + 1]); let jump = kn[i] !== kn[i + 1];
      for (const xs of steps) if (xs > a && xs <= b) jump = true;
      for (let k = 0; k < g.layers.length && !jump; k++) {
        const p0 = layerProps2D(g, k, xm[i]), p1 = layerProps2D(g, k, xm[i + 1]);
        if (Math.abs(Math.log(p1.rh / p0.rh)) > 0.3 || Math.abs(Math.log(p1.rv / p0.rv)) > 0.3) jump = true;
      }
      brk[i] = jump ? 1 : 0;
    }
    const seg = new Int32Array(n), segs = []; let s0 = 0, id = 0;
    for (let i = 0; i < n; i++) { seg[i] = id; if (i === n - 1 || brk[i]) { segs.push([s0, i]); s0 = i + 1; id++; } }
    return { xm, kn, brk, seg, segs, steps };
  }
  // initial FD stations: both ends of every segment plus every `step` metres inside a segment
  function initial(cfg, st, an, opt) {
    const ds = cfg.mdStep, k = Math.max(1, Math.round(opt.step / ds)), out = nearJumps(cfg, st, an, opt);
    for (const [a, b] of an.segs) {
      out.push(a); if (b === a) continue;
      let last = a; for (let i = a + k; i < b; i += k) { if (b - i < k / 2) break; out.push(i); last = i; }
      out.push(b);
    }
    return Array.from(new Set(out)).sort((p, q) => p - q);
  }
  // refinement: bisect an interval (inside a segment) when the difference tensors change across it by more than tolD, or when a
  // neighbouring solver station deviates from the straight line through its own neighbours by more than tolE (curvature)
  function refine(cfg, st, an, have, vec, opt) {
    let mx = 0; for (const v of vec.values()) for (let k = 0; k < v.length; k++) mx = Math.max(mx, Math.abs(v[k]));
    const tolD = Math.max(opt.absTol, opt.refineThr * mx), tolE = Math.max(opt.curvTol, opt.curvThr * mx), md = (i) => st[i].md;
    const idx = have.slice().sort((p, q) => p - q), n = idx.length, add = new Set();
    const dev = (p, a, b) => {            // deviation of station a from the line through p and b
      const vp = vec.get(p), va = vec.get(a), vb = vec.get(b), t = (md(a) - md(p)) / (md(b) - md(p)); let d = 0;
      for (let k = 0; k < va.length; k++) d = Math.max(d, Math.abs(va[k] - (vp[k] + t * (vb[k] - vp[k]))));
      return d;
    };
    for (let q = 0; q + 1 < n; q++) {
      const a = idx[q], b = idx[q + 1]; if (an.seg[a] !== an.seg[b] || b - a < 2) continue;
      const va = vec.get(a), vb = vec.get(b); let d = 0; for (let k = 0; k < va.length; k++) d = Math.max(d, Math.abs(va[k] - vb[k]));
      let curv = 0;
      if (q > 0 && an.seg[idx[q - 1]] === an.seg[a]) curv = Math.max(curv, dev(idx[q - 1], a, b));
      if (q + 2 < n && an.seg[idx[q + 2]] === an.seg[b]) curv = Math.max(curv, dev(a, b, idx[q + 2]));
      if (d > tolD || curv > tolE) add.add(Math.round((a + b) / 2));
    }
    return Array.from(add);
  }
  // extra solver stations close to each jump of the local model, where the 2D effect usually changes fastest
  function nearJumps(cfg, st, an, opt) {
    const out = [], ds = cfg.mdStep, offs = [2, 4, 8, 16];
    for (let s = 0; s + 1 < an.segs.length; s++) {
      const left = an.segs[s][1], right = an.segs[s + 1][0];
      for (const o of offs) { const k = Math.round(o / ds); if (left - k >= an.segs[s][0]) out.push(left - k); if (right + k <= an.segs[s + 1][1]) out.push(right + k); }
    }
    return out;
  }
  // ---- PCHIP interpolation ---------------------------------------------------------------------------------------
  function endSlope(h0, h1, d0, d1) { let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1); if (m * d0 <= 0) m = 0; else if (d0 * d1 <= 0 && Math.abs(m) > 3 * Math.abs(d0)) m = 3 * d0; return m; }
  function pchip(t, y, tq, out, o0, stride) {
    const n = t.length, nq = tq.length;
    if (n === 1) { for (let q = 0; q < nq; q++) out[o0 + q * stride] = y[0]; return; }
    const h = new Float64Array(n - 1), del = new Float64Array(n - 1), d = new Float64Array(n);
    for (let k = 0; k < n - 1; k++) { h[k] = t[k + 1] - t[k]; del[k] = (y[k + 1] - y[k]) / h[k]; }
    if (n === 2) { d[0] = d[1] = del[0]; }
    else {
      for (let k = 1; k < n - 1; k++) { if (del[k - 1] * del[k] > 0) { const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1]; d[k] = (w1 + w2) / (w1 / del[k - 1] + w2 / del[k]); } else d[k] = 0; }
      d[0] = endSlope(h[0], h[1], del[0], del[1]); d[n - 1] = endSlope(h[n - 2], h[n - 3], del[n - 2], del[n - 3]);
    }
    let k = 0;
    for (let q = 0; q < nq; q++) {
      const x = tq[q]; while (k < n - 2 && x > t[k + 1]) k++;
      const s = Math.min(1, Math.max(0, (x - t[k]) / h[k])), s2 = s * s, s3 = s2 * s;
      out[o0 + q * stride] = y[k] * (2 * s3 - 3 * s2 + 1) + h[k] * d[k] * (s3 - 2 * s2 + s) + y[k + 1] * (-2 * s3 + 3 * s2) + h[k] * d[k + 1] * (s3 - s2);
    }
  }
  // ---- assembly --------------------------------------------------------------------------------------------------
  // base: Float64Array(nSt * nch * 2) local-1D data; vec: Map(station index -> Float64Array(nPairs * 10)) normalised difference tensors
  // (pair-major, components xx,yy,zz,xz,zx, re/im, already multiplied by 2 pi |L|^3). Returns the corrected data and the interpolated tensors.
  function assemble(cfg, st, an, base, vec, grp) {
    const n = st.length, nch = cfg.channels.length, nP = grp.pairs.length, ns = nP * 10, D = new Float64Array(n * ns);
    const md = Float64Array.from(st, (s) => s.md);
    for (const [a, b] of an.segs) {
      const nodes = []; for (const i of vec.keys()) if (i >= a && i <= b) nodes.push(i); nodes.sort((p, q) => p - q);
      if (!nodes.length) continue;
      const t = Float64Array.from(nodes, (i) => md[i]), tq = md.subarray(a, b + 1), y = new Float64Array(nodes.length);
      for (let s = 0; s < ns; s++) { for (let q = 0; q < nodes.length; q++) y[q] = vec.get(nodes[q])[s]; pchip(t, y, tq, D, a * ns + s, ns); }
    }
    const fr = secFrame(cfg), pch = prepChannels(cfg.channels), out = Float64Array.from(base), T = new Float64Array(10);
    for (let i = 0; i < n; i++) {
      const A = new Map();
      for (let c = 0; c < nch; c++) {
        const ch = pch[c], p = grp.index[cfg.channels[c].L + '|' + cfg.channels[c].f];
        let ab = A.get(c); if (!ab) { ab = [antSec(st[i], fr, ch.a), antSec(st[i], fr, ch.b)]; A.set(c, ab); }
        for (let k = 0; k < 10; k++) T[k] = D[i * ns + p * 10 + k];
        const v = chanFromT(T, ab[0], ab[1]); out[2 * (i * nch + c)] += v[0]; out[2 * (i * nch + c) + 1] += v[1];
      }
    }
    return { data: out, D };
  }
  // per-run summary of the solver diagnostics
  function summarize(infos, nFD, nFreq) {
    let solved = 0, skipped = 0, qmin = Infinity, qmax = 0, secs = 0, maxNodes = 0; const poor = [];
    for (const r of infos) {
      secs += r.secs || 0; if (r.skip) { skipped++; continue; } solved++;
      const q = r.info.quality; qmin = Math.min(qmin, q); qmax = Math.max(qmax, q); maxNodes = Math.max(maxNodes, r.info.nodes); if (q < 0.7) poor.push(r);
    }
    return { jobs: infos.length, solved, skipped, qmin: isFinite(qmin) ? qmin : null, qmax, secs, maxNodes, poor, nFD, nFreq };
  }
  return { QUALITY, options, secFrame, antSec, stationAxis, maxOutOfPlane, groups, analyse, initial, nearJumps, refine, pchip, assemble, summarize };
})();
