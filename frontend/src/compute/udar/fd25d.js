// ===================================================================================
// fd25d.js -- 2.5D (x,z section + wavenumber ky) frequency-domain finite-difference engine for magnetic-dipole tools
//   e^{-i w t}, z down, quasi-static (mu = mu0), conductivity tensor in the x-z plane (TTI), y out of the section.
//   Yee-type staggered grid, PEC outer box, three E components per lattice node (Ex,Ey,Ez), the y-derivative is i*ky.
//   The Ey unknown is scaled (Ey = i*ey, y-row times -i) so that the matrix is complex-symmetric (see fdsolve.js).
//   Needs: FDSolve (fdsolve.js), model.js (horizon helpers)
// ===================================================================================
const FD = (function () {
  const MU = 4e-7 * Math.PI;

  // ------------------------------------------------------------------ grid
  function gradedAxis(c0, c1, h, W0, W1, stretch) {
    const n = Math.max(1, Math.ceil((c1 - c0) / h - 1e-9)), hh = (c1 - c0) / n, left = [], right = [];
    let x = c0, s = hh; while (c0 - x < W0 - 1e-9) { s *= stretch; x -= s; left.push(x); }
    x = c1; s = hh; while (x - c1 < W1 - 1e-9) { s *= stretch; x += s; right.push(x); }
    const out = new Float64Array(left.length + n + 1 + right.length); let p = 0;
    for (let i = left.length - 1; i >= 0; i--) out[p++] = left[i];
    for (let i = 0; i <= n; i++) out[p++] = c0 + hh * i;
    for (let i = 0; i < right.length; i++) out[p++] = right[i];
    return out;
  }
  function makeGrid(xn, zn) {
    const nx = xn.length - 1, nz = zn.length - 1, NX = nx + 1, NZ = nz + 1;
    const hx = new Float64Array(nx), hz = new Float64Array(nz), xc = new Float64Array(nx), zc = new Float64Array(nz);
    for (let i = 0; i < nx; i++) { hx[i] = xn[i + 1] - xn[i]; xc[i] = 0.5 * (xn[i] + xn[i + 1]); }
    for (let j = 0; j < nz; j++) { hz[j] = zn[j + 1] - zn[j]; zc[j] = 0.5 * (zn[j] + zn[j + 1]); }
    const hxc = new Float64Array(NX), hzc = new Float64Array(NZ);
    for (let i = 1; i < nx; i++) hxc[i] = 0.5 * (hx[i - 1] + hx[i]);
    for (let j = 1; j < nz; j++) hzc[j] = 0.5 * (hz[j - 1] + hz[j]);
    return { xn, zn, nx, nz, NX, NZ, hx, hz, xc, zc, hxc, hzc };
  }

  // ------------------------------------------------------------------ models (section coordinates x, z)
  // A model object: column(x) fills an internal per-layer table; layer(z) returns the layer index; tensor(layer, out4)
  function segSlope(pts, x) {
    const n = pts.length; if (n < 2 || x < pts[0][0] || x >= pts[n - 1][0]) return 0;
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= x) lo = m; else hi = m; }
    const dx = pts[hi][0] - pts[lo][0]; return dx > 0 ? (pts[hi][1] - pts[lo][1]) / dx : 0;
  }
  function tensorFrom(sh, sv, nx, nz, out) {
    const d = sv - sh; out[0] = sh + d * nx * nx; out[1] = sh; out[2] = sh + d * nz * nz; out[3] = d * nx * nz;
  }
  // true 2D model from geo2 (horizons, laterally varying layer properties); bedding normal of layer k from its bounding horizons
  function model2D(geo2) {
    const nh = geo2.horizons.length, N = nh + 1, zh = new Float64Array(nh), sh = new Float64Array(N), sv = new Float64Array(N), nxA = new Float64Array(N), nzA = new Float64Array(N);
    const sl = new Float64Array(Math.max(1, nh));
    return {
      N, nh,
      column(x) {
        horizonZ(geo2, x, zh);
        for (let k = 0; k < nh; k++) sl[k] = segSlope(geo2.horizons[k].pts, x);
        for (let k = 0; k < N; k++) {
          const pr = layerProps2D(geo2, k, x); sh[k] = 1 / pr.rh; sv[k] = 1 / pr.rv;
          const s = nh === 0 ? 0 : k === 0 ? sl[0] : k === nh ? sl[nh - 1] : 0.5 * (sl[k - 1] + sl[k]);
          const th = Math.atan(s); nxA[k] = -Math.sin(th); nzA[k] = Math.cos(th);
        }
      },
      layer(x, z) { let k = 0; while (k < nh && z > zh[k]) k++; return k; },
      tensor(k, out) { tensorFrom(sh[k], sv[k], nxA[k], nzA[k], out); },
    };
  }
  // local-1D baseline (the object returned by buildLocal2D): parallel planes with a single dip, in-plane normal
  function modelBase(loc, geo2) {
    const a = geo2.azSec * D2R, ca = Math.cos(a), sa = Math.sin(a);
    const nx = loc.nrm[0] * ca + loc.nrm[1] * sa, nz = loc.nrm[2], zi = loc.zi, nh = zi.length, N = loc.N;
    let xcur = 0;
    return {
      N, nh, nx, nz,
      column(x) { xcur = x; },
      layer(x, z) { const zn = nx * x + nz * z; let k = 0; while (k < nh && zn > zi[k]) k++; return k; },
      tensor(k, out) { tensorFrom(loc.sh[k], loc.sv[k], nx, nz, out); },
    };
  }
  // cell-averaged tensor arrays (sub x sub samples per cell). Cells crossed by an interface use laminate (Backus-type) averaging:
  // tangential components arithmetic, normal component harmonic (normal estimated from the sample gradient) -> 2nd-order interface accuracy.
  function cellTensors(g, mdl, sub, lam) {
    if (lam === undefined) lam = true;
    const nx = g.nx, nz = g.nz, sxx = new Float64Array(nx * nz), syy = new Float64Array(nx * nz), szz = new Float64Array(nx * nz), sxz = new Float64Array(nx * nz);
    const ns = sub * sub, t = [0, 0, 0, 0], w = 1 / ns, zs = new Float64Array(nz * sub);
    const Sxx = new Float64Array(ns), Syy = new Float64Array(ns), Szz = new Float64Array(ns), Sxz = new Float64Array(ns), Px = new Float64Array(ns), Pz = new Float64Array(ns);
    for (let j = 0; j < nz; j++) for (let b = 0; b < sub; b++) zs[j * sub + b] = g.zn[j] + (b + 0.5) / sub * g.hz[j];
    const cols = [];                                    // per cell column: model tensors for all (a, z-sample)
    for (let i = 0; i < nx; i++) {
      const colT = [];
      for (let a = 0; a < sub; a++) {
        const x = g.xn[i] + (a + 0.5) / sub * g.hx[i]; mdl.column(x);
        const arr = new Float64Array(nz * sub * 4);
        for (let jb = 0; jb < nz * sub; jb++) { const k = mdl.layer(x, zs[jb]); mdl.tensor(k, t); arr[4 * jb] = t[0]; arr[4 * jb + 1] = t[1]; arr[4 * jb + 2] = t[2]; arr[4 * jb + 3] = t[3]; }
        colT.push({ x, arr });
      }
      for (let j = 0; j < nz; j++) {
        let p = 0, uniform = true;
        for (let a = 0; a < sub; a++) for (let b = 0; b < sub; b++) {
          const arr = colT[a].arr, o = 4 * (j * sub + b);
          Sxx[p] = arr[o]; Syy[p] = arr[o + 1]; Szz[p] = arr[o + 2]; Sxz[p] = arr[o + 3]; Px[p] = colT[a].x; Pz[p] = zs[j * sub + b];
          if (p > 0 && (Sxx[p] !== Sxx[0] || Szz[p] !== Szz[0] || Sxz[p] !== Sxz[0])) uniform = false;
          p++;
        }
        const c = i * nz + j;
        let done = false;
        if (uniform) { sxx[c] = Sxx[0]; syy[c] = Syy[0]; szz[c] = Szz[0]; sxz[c] = Sxz[0]; done = true; }
        else if (lam) {
          // gradient of ln(sxx+szz) over the samples -> interface normal
          let mx = 0, mz = 0, ms = 0; const sv = Px.length ? new Float64Array(ns) : null;
          for (let q = 0; q < ns; q++) { sv[q] = Math.log(Sxx[q] + Szz[q]); mx += Px[q]; mz += Pz[q]; ms += sv[q]; }
          mx /= ns; mz /= ns; ms /= ns;
          let gx = 0, gz = 0, vx = 0, vz = 0;
          for (let q = 0; q < ns; q++) { gx += (Px[q] - mx) * (sv[q] - ms); gz += (Pz[q] - mz) * (sv[q] - ms); vx += (Px[q] - mx) ** 2; vz += (Pz[q] - mz) ** 2; }
          gx /= vx; gz /= vz; const gn = Math.hypot(gx, gz);
          if (gn > 1e-12) {
            const nxn = gx / gn, nzn = gz / gn, txn = -nzn, tzn = nxn;
            let ia = 0, ib = 0, st = 0, sq = 0, syA = 0;
            for (let q = 0; q < ns; q++) {
              const a = Sxx[q], bb = Sxz[q], d = Szz[q];
              const snn = a * nxn * nxn + 2 * bb * nxn * nzn + d * nzn * nzn, stt = a * txn * txn + 2 * bb * txn * tzn + d * tzn * tzn, snt = a * nxn * txn + bb * (nxn * tzn + nzn * txn) + d * nzn * tzn;
              ia += 1 / snn; ib += snt / snn; st += stt; sq += snt * snt / snn; syA += Syy[q];
            }
            ia /= ns; ib /= ns; st /= ns; sq /= ns; syA /= ns;
            const Snn = 1 / ia, Snt = ib / ia, Stt = st - sq + ib * ib / ia;
            sxx[c] = Snn * nxn * nxn + 2 * Snt * nxn * txn + Stt * txn * txn; szz[c] = Snn * nzn * nzn + 2 * Snt * nzn * tzn + Stt * tzn * tzn;
            sxz[c] = Snn * nxn * nzn + Snt * (nxn * tzn + nzn * txn) + Stt * txn * tzn; syy[c] = syA; done = true;
          }
        }
        if (!done) { let a = 0, b = 0, d = 0, e = 0; for (let q = 0; q < ns; q++) { a += Sxx[q]; b += Syy[q]; d += Szz[q]; e += Sxz[q]; } sxx[c] = a * w; syy[c] = b * w; szz[c] = d * w; sxz[c] = e * w; }
      }
    }
    return { sxx, syy, szz, sxz };
  }

  // weighted laminate (Backus-type) average of in-plane tensors: normal from the structure tensor of the sample differences.
  // S: samples [sxx, syy, szz, sxz]*n, W: weights (sum 1), lattice na x nb (row-major a*nb+b) with spacings dx, dz. out: [sxx, syy, szz, sxz]
  function lamAvg(S, W, na, nb, dx, dz, out) {
    let jxx = 0, jxz = 0, jzz = 0;
    for (let a = 0; a < na; a++) for (let b = 0; b < nb; b++) {
      const q = a * nb + b, v = Math.log(S[4 * q] + S[4 * q + 2]);
      if (a + 1 < na) { const g = (Math.log(S[4 * (q + nb)] + S[4 * (q + nb) + 2]) - v) / dx; jxx += g * g; }
      if (b + 1 < nb) { const g = (Math.log(S[4 * (q + 1)] + S[4 * (q + 1) + 2]) - v) / dz; jzz += g * g; }
      if (a + 1 < na && b + 1 < nb) { const g1 = (Math.log(S[4 * (q + nb + 1)] + S[4 * (q + nb + 1) + 2]) - v), g2 = (Math.log(S[4 * (q + nb)] + S[4 * (q + nb) + 2]) - Math.log(S[4 * (q + 1)] + S[4 * (q + 1) + 2]));
        // diagonal differences give the mixed term: (g1^2 - g2^2)/4 = gx*gz*dx*dz  (for a linear field)
        jxz += (g1 * g1 - g2 * g2) / (4 * dx * dz); }
    }
    // principal direction of [[jxx, jxz], [jxz, jzz]]
    const th = 0.5 * Math.atan2(2 * jxz, jxx - jzz), nxn = Math.cos(th), nzn = Math.sin(th), txn = -nzn, tzn = nxn;
    let ia = 0, ib = 0, st = 0, sq = 0, sy = 0;
    for (let q = 0, n = na * nb; q < n; q++) {
      const w = W[q], a = S[4 * q], bb = S[4 * q + 3], d = S[4 * q + 2];
      const snn = a * nxn * nxn + 2 * bb * nxn * nzn + d * nzn * nzn, stt = a * txn * txn + 2 * bb * txn * tzn + d * tzn * tzn, snt = a * nxn * txn + bb * (nxn * tzn + nzn * txn) + d * nzn * tzn;
      ia += w / snn; ib += w * snt / snn; st += w * stt; sq += w * snt * snt / snn; sy += w * S[4 * q + 1];
    }
    const Snn = 1 / ia, Snt = ib / ia, Stt = st - sq + ib * ib / ia;
    out[0] = Snn * nxn * nxn + 2 * Snt * nxn * txn + Stt * txn * txn; out[2] = Snn * nzn * nzn + 2 * Snt * nzn * tzn + Stt * tzn * tzn;
    out[3] = Snn * nxn * nzn + Snt * (nxn * tzn + nzn * txn) + Stt * txn * tzn; out[1] = sy;
  }
  // Edge-based conductivities (finite-integration style): each unknown gets the laminate average of the model over its own
  // dual support with linear (hat) weights along the directions in which the unknown is staggered at nodes.
  //   exx: Ex edge (i, j)  -> support cell column i (uniform in x) x cells j-1, j (hat in z)          index i*(nz+1)+j
  //   ezz: Ez edge (i, j)  -> cells i-1, i (hat in x) x cell row j (uniform in z)                     index i*nz+j
  //   eyy: Ey node (i, j)  -> hat in x and z over the four surrounding cells                          index i*(nz+1)+j
  //   sxz: per cell (uniform weights), used for the cross coupling
  function edgeTensors(g, mdl, sub) {
    sub = Math.max(2, sub | 0); if (sub % 2) sub++;
    const nx = g.nx, nz = g.nz, NS = nz * sub, t = [0, 0, 0, 0], out = [0, 0, 0, 0];
    const exx = new Float64Array(nx * (nz + 1)), ezz = new Float64Array((nx + 1) * nz), eyy = new Float64Array((nx + 1) * (nz + 1)), sxz = new Float64Array(nx * nz);
    const zs = new Float64Array(NS); for (let j = 0; j < nz; j++) for (let b = 0; b < sub; b++) zs[j * sub + b] = g.zn[j] + (b + 0.5) / sub * g.hz[j];
    const col = [new Float64Array(sub * NS * 4), new Float64Array(sub * NS * 4)], uni = [new Uint8Array(nz), new Uint8Array(nz)];
    const S = new Float64Array(4 * 4 * sub * sub), W = new Float64Array(4 * sub * sub), sp = new Float64Array(sub);
    for (let a = 0; a < sub; a++) sp[a] = (a + 0.5) / sub;
    const same = (A, o1, B, o2) => A[o1] === B[o2] && A[o1 + 1] === B[o2 + 1] && A[o1 + 2] === B[o2 + 2] && A[o1 + 3] === B[o2 + 3];
    // gather samples of the cell block (columns ia0..ia0+nca-1 relative to the current pair, rows jb0..) with weights wx(a)*wz(b)
    function region(i, cx, j0, nzc, wxf, wzf, dx, dz, o) {
      // cx: list of [colBufIndex, cellI]; rows: cells j0..j0+nzc-1
      const na = cx.length * sub, nb = nzc * sub; let p = 0, sw = 0;
      for (let ci = 0; ci < cx.length; ci++) for (let a = 0; a < sub; a++) {
        const buf = col[cx[ci][0]], wx = wxf(ci, a);
        for (let cj = 0; cj < nzc; cj++) for (let b = 0; b < sub; b++) {
          const jb = (j0 + cj) * sub + b, src = 4 * (a * NS + jb), w = wx * wzf(cj, b);
          S[4 * p] = buf[src]; S[4 * p + 1] = buf[src + 1]; S[4 * p + 2] = buf[src + 2]; S[4 * p + 3] = buf[src + 3]; W[p] = w; sw += w; p++;
        }
      }
      for (let q = 0; q < p; q++) W[q] /= sw;
      lamAvg(S, W, na, nb, dx, dz, o);
    }
    for (let i = 0; i < nx; i++) {
      const cb = i & 1, pb = cb ^ 1, buf = col[cb], u = uni[cb];
      for (let a = 0; a < sub; a++) {
        const x = g.xn[i] + sp[a] * g.hx[i]; mdl.column(x);
        for (let jb = 0; jb < NS; jb++) { const k = mdl.layer(x, zs[jb]); mdl.tensor(k, t); const o = 4 * (a * NS + jb); buf[o] = t[0]; buf[o + 1] = t[1]; buf[o + 2] = t[2]; buf[o + 3] = t[3]; }
      }
      for (let j = 0; j < nz; j++) {           // uniform-cell flags
        let ok = true; const o0 = 4 * (j * sub);
        for (let a = 0; a < sub && ok; a++) for (let b = 0; b < sub; b++) if (!same(buf, 4 * (a * NS + j * sub + b), buf, o0)) { ok = false; break; }
        u[j] = ok ? 1 : 0;
      }
      const dxs = g.hx[i] / sub;
      // cells: sxz
      for (let j = 0; j < nz; j++) {
        if (u[j]) { sxz[i * nz + j] = buf[4 * (j * sub) + 3]; continue; }
        region(i, [[cb, i]], j, 1, () => 1, () => 1, dxs, g.hz[j] / sub, out); sxz[i * nz + j] = out[3];
      }
      // Ex edges of column i
      for (let j = 1; j < nz; j++) {
        if (u[j - 1] && u[j] && same(buf, 4 * ((j - 1) * sub), buf, 4 * (j * sub))) { exx[i * (nz + 1) + j] = buf[4 * (j * sub)]; continue; }
        const hm = g.hz[j - 1], hp = g.hz[j];
        region(i, [[cb, i]], j - 1, 2, () => 1, (cj, b) => cj === 0 ? sp[b] * hm : (1 - sp[b]) * hp, dxs, Math.min(hm, hp) / sub, out); exx[i * (nz + 1) + j] = out[0];
      }
      if (i === 0) continue;
      const bp = col[pb], up = uni[pb], hxm = g.hx[i - 1], hxp = g.hx[i], wxh = (ci, a) => ci === 0 ? sp[a] * hxm : (1 - sp[a]) * hxp, dxh = Math.min(hxm, hxp) / sub;
      // Ez edges at x_i
      for (let j = 0; j < nz; j++) {
        if (up[j] && u[j] && same(bp, 4 * (j * sub), buf, 4 * (j * sub))) { ezz[i * nz + j] = buf[4 * (j * sub) + 2]; continue; }
        region(i, [[pb, i - 1], [cb, i]], j, 1, wxh, () => 1, dxh, g.hz[j] / sub, out); ezz[i * nz + j] = out[2];
      }
      // Ey nodes at x_i
      for (let j = 1; j < nz; j++) {
        const o1 = 4 * ((j - 1) * sub), o2 = 4 * (j * sub);
        if (up[j - 1] && up[j] && u[j - 1] && u[j] && same(bp, o1, buf, o1) && same(bp, o1, bp, o2) && same(bp, o1, buf, o2)) { eyy[i * (nz + 1) + j] = buf[o1 + 1]; continue; }
        const hm = g.hz[j - 1], hp = g.hz[j];
        region(i, [[pb, i - 1], [cb, i]], j - 1, 2, wxh, (cj, b) => cj === 0 ? sp[b] * hm : (1 - sp[b]) * hp, dxh, Math.min(hm, hp) / sub, out); eyy[i * (nz + 1) + j] = out[1];
      }
    }
    return { exx, ezz, eyy, sxz, edge: true };
  }

  // ------------------------------------------------------------------ matrix assembly (block stencil, symmetrised)
  // row scale sr = (1,-i,1), column scale sc = (1,i,1): product table P[c][c2] = sr[c]*sc[c2]
  // ((Ex,Ey)=i, (Ey,Ex)=-i, (Ey,Ez)=-i, (Ez,Ey)=i, all others 1)
  const PR = [[1, 0, 1], [0, 1, 0], [1, 0, 1]], PI = [[0, 1, 0], [-1, 0, -1], [0, 1, 0]];
  function assemble(g, ten, omega, k, SR, SI) {
    SR.fill(0); SI.fill(0);
    const NX = g.NX, NZ = g.NZ, nx = g.nx, nz = g.nz, hx = g.hx, hz = g.hz, hxc = g.hxc, hzc = g.hzc, q = omega * MU, k2 = k * k;
    const { sxx, syy, szz, sxz } = ten;
    // add value (vr + i vi) to A[(ri,rj,rc),(ci,cj,cc)] (unscaled matrix); scaling applied here
    function add(ri, rj, rc, ci, cj, cc, vr, vi) {
      const o = ((ri * NZ + rj) * 9 + (ci - ri + 1) * 3 + (cj - rj + 1)) * 9 + rc * 3 + cc;
      const pr = PR[rc][cc], pi = PI[rc][cc];
      SR[o] += vr * pr - vi * pi; SI[o] += vr * pi + vi * pr;
    }
    const vEx = (i, j) => i >= 0 && i <= nx - 1 && j >= 1 && j <= nz - 1;
    const vEy = (i, j) => i >= 1 && i <= nx - 1 && j >= 1 && j <= nz - 1;
    const vEz = (i, j) => i >= 1 && i <= nx - 1 && j >= 0 && j <= nz - 1;
    // Ex rows
    for (let i = 0; i < nx; i++) for (let j = 1; j < nz; j++) {
      const hxi = hx[i], hzm = hz[j - 1], hzp = hz[j], hzcj = hzc[j], V = hxi * hzcj;
      const vxx = ten.edge ? hxi * hzcj * ten.exx[i * (nz + 1) + j] : hxi * (hzm * sxx[i * nz + j - 1] + hzp * sxx[i * nz + j]) / 2;
      add(i, j, 0, i, j, 0, k2 * V + hxi / hzp + hxi / hzm, -q * vxx);
      if (vEx(i, j + 1)) add(i, j, 0, i, j + 1, 0, -hxi / hzp, 0);
      if (vEx(i, j - 1)) add(i, j, 0, i, j - 1, 0, -hxi / hzm, 0);
      if (vEy(i + 1, j)) add(i, j, 0, i + 1, j, 1, 0, k * hzcj);
      if (vEy(i, j)) add(i, j, 0, i, j, 1, 0, -k * hzcj);
      if (vEz(i + 1, j)) add(i, j, 0, i + 1, j, 2, 1, 0);
      if (vEz(i, j)) add(i, j, 0, i, j, 2, -1, 0);
      if (vEz(i + 1, j - 1)) add(i, j, 0, i + 1, j - 1, 2, -1, 0);
      if (vEz(i, j - 1)) add(i, j, 0, i, j - 1, 2, 1, 0);
    }
    // Ey rows
    for (let i = 1; i < nx; i++) for (let j = 1; j < nz; j++) {
      const hxm = hx[i - 1], hxp = hx[i], hzm = hz[j - 1], hzp = hz[j], hxci = hxc[i], hzcj = hzc[j];
      const vyy = ten.edge ? hxci * hzcj * ten.eyy[i * (nz + 1) + j] : (hxm * hzm * syy[(i - 1) * nz + j - 1] + hxp * hzm * syy[i * nz + j - 1] + hxm * hzp * syy[(i - 1) * nz + j] + hxp * hzp * syy[i * nz + j]) / 4;
      add(i, j, 1, i, j, 1, hxci / hzp + hxci / hzm + hzcj / hxp + hzcj / hxm, -q * vyy);
      if (vEy(i, j + 1)) add(i, j, 1, i, j + 1, 1, -hxci / hzp, 0);
      if (vEy(i, j - 1)) add(i, j, 1, i, j - 1, 1, -hxci / hzm, 0);
      if (vEy(i + 1, j)) add(i, j, 1, i + 1, j, 1, -hzcj / hxp, 0);
      if (vEy(i - 1, j)) add(i, j, 1, i - 1, j, 1, -hzcj / hxm, 0);
      if (vEz(i, j)) add(i, j, 1, i, j, 2, 0, k * hxci);
      if (vEz(i, j - 1)) add(i, j, 1, i, j - 1, 2, 0, -k * hxci);
      if (vEx(i, j)) add(i, j, 1, i, j, 0, 0, k * hzcj);
      if (vEx(i - 1, j)) add(i, j, 1, i - 1, j, 0, 0, -k * hzcj);
    }
    // Ez rows
    for (let i = 1; i < nx; i++) for (let j = 0; j < nz; j++) {
      const hxm = hx[i - 1], hxp = hx[i], hzj = hz[j], hxci = hxc[i], V = hxci * hzj;
      const vzz = ten.edge ? hxci * hzj * ten.ezz[i * nz + j] : hzj * (hxm * szz[(i - 1) * nz + j] + hxp * szz[i * nz + j]) / 2;
      add(i, j, 2, i, j, 2, k2 * V + hzj / hxp + hzj / hxm, -q * vzz);
      if (vEz(i + 1, j)) add(i, j, 2, i + 1, j, 2, -hzj / hxp, 0);
      if (vEz(i - 1, j)) add(i, j, 2, i - 1, j, 2, -hzj / hxm, 0);
      if (vEx(i, j + 1)) add(i, j, 2, i, j + 1, 0, 1, 0);
      if (vEx(i, j)) add(i, j, 2, i, j, 0, -1, 0);
      if (vEx(i - 1, j + 1)) add(i, j, 2, i - 1, j + 1, 0, -1, 0);
      if (vEx(i - 1, j)) add(i, j, 2, i - 1, j, 0, 1, 0);
      if (vEy(i, j + 1)) add(i, j, 2, i, j + 1, 1, 0, k * hxci);
      if (vEy(i, j)) add(i, j, 2, i, j, 1, 0, -k * hxci);
    }
    // conductivity cross term sigma_xz (per cell, both orderings)
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const c = hx[i] * hz[j] * sxz[i * nz + j] / 4; if (c === 0) continue;
      for (let dj = 0; dj <= 1; dj++) for (let di = 0; di <= 1; di++) {
        if (vEx(i, j + dj) && vEz(i + di, j)) { add(i, j + dj, 0, i + di, j, 2, 0, -q * c); add(i + di, j, 2, i, j + dj, 0, 0, -q * c); }
      }
    }
    // identity rows for unused unknowns
    for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
      if (!vEx(i, j)) add(i, j, 0, i, j, 0, 1, 0);
      if (!vEy(i, j)) add(i, j, 1, i, j, 1, 1, 0);
      if (!vEz(i, j)) add(i, j, 2, i, j, 2, 1, 0);
    }
  }

  // ------------------------------------------------------------------ sources and receivers
  function bilin(ax, p) {           // index i and weights (1-t, t) for linear interpolation on the sorted points ax
    let lo = 0, hi = ax.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ax[m] < p) lo = m; else hi = m; }
    // numpy-like: i = clip(searchsorted(ax,p)-1, 0, n-2) ; here lo is the last index with ax[lo] < p
    const i = Math.min(Math.max(lo, 0), ax.length - 2), t = (p - ax[i]) / (ax[i + 1] - ax[i]);
    return [i, 1 - t, t];
  }
  // RHS of the (scaled) system for a unit magnetic dipole along `ori` (0=x,1=y,2=z) at pos=(x,z); written into BR,BI at column `col` of nrhs
  function sourceRHS(g, omega, k, pos, ori, BR, BI, col, nrhs) {
    const NX = g.NX, NZ = g.NZ, nx = g.nx, nz = g.nz, q = omega * MU;
    const Mx = new Float64Array(NX * NZ), My = new Float64Array(NX * NZ), Mz = new Float64Array(NX * NZ);
    const dxn = new Float64Array(NX), dzn = new Float64Array(NZ);
    for (let i = 0; i < nx; i++) { dxn[i] += g.hx[i] / 2; dxn[i + 1] += g.hx[i] / 2; }
    for (let j = 0; j < nz; j++) { dzn[j] += g.hz[j] / 2; dzn[j + 1] += g.hz[j] / 2; }
    const xs = pos[0], zs = pos[1];
    let [i0, a0, a1] = bilin(g.xn, xs), [j0, b0, b1] = bilin(g.zc, zs);
    if (ori === 0) for (const [di, wi] of [[0, a0], [1, a1]]) for (const [dj, wj] of [[0, b0], [1, b1]]) { const i = i0 + di, j = j0 + dj; Mx[i * NZ + j] += wi * wj / (dxn[i] * g.hz[j]); }
    [i0, a0, a1] = bilin(g.xc, xs); [j0, b0, b1] = bilin(g.zn, zs);
    if (ori === 2) for (const [di, wi] of [[0, a0], [1, a1]]) for (const [dj, wj] of [[0, b0], [1, b1]]) { const i = i0 + di, j = j0 + dj; Mz[i * NZ + j] += wi * wj / (g.hx[i] * dzn[j]); }
    [i0, a0, a1] = bilin(g.xc, xs); [j0, b0, b1] = bilin(g.zc, zs);
    if (ori === 1) for (const [di, wi] of [[0, a0], [1, a1]]) for (const [dj, wj] of [[0, b0], [1, b1]]) { const i = i0 + di, j = j0 + dj; My[i * NZ + j] += wi * wj / (g.hx[i] * g.hz[j]); }
    // b = i q * (curl M * V) ; Ey row multiplied by (-i) (scaling)
    const put = (n, c, re, im) => { const d = (3 * n + c) * nrhs + col; if (c === 1) { const t = re; re = im; im = -t; } BR[d] = re; BI[d] = im; };   // (-i)(re+i im) = im - i re
    for (let i = 0; i < nx; i++) for (let j = 1; j < nz; j++) {                                  // Ex rows: i q ( ik hx hzc Mz - hx (My[i,j]-My[i,j-1]) )
      const n = i * NZ + j, a = g.hx[i] * g.hzc[j] * Mz[n], bb = g.hx[i] * (My[n] - My[n - 1]);
      // value = i q ( i k a - bb ) = -q k a - i q bb
      put(n, 0, -q * k * a, -q * bb);
    }
    for (let i = 1; i < nx; i++) for (let j = 1; j < nz; j++) {                                  // Ey rows: i q ( hxc (Mx[i,j]-Mx[i,j-1]) - hzc (Mz[i,j]-Mz[i-1,j]) )
      const n = i * NZ + j, v = g.hxc[i] * (Mx[n] - Mx[n - 1]) - g.hzc[j] * (Mz[n] - Mz[n - NZ]);
      put(n, 1, 0, q * v);
    }
    for (let i = 1; i < nx; i++) for (let j = 0; j < nz; j++) {                                  // Ez rows: i q ( hz (My[i,j]-My[i-1,j]) - ik hxc hz Mx[i,j] )
      const n = i * NZ + j, a = g.hz[j] * (My[n] - My[n - NZ]), bb = g.hxc[i] * g.hz[j] * Mx[n];
      // value = i q a - i q i k bb = i q a + q k bb
      put(n, 2, q * k * bb, q * a);
    }
  }
  // receiver functionals: three sparse rows (Hx', Hy', Hz') over the scaled unknowns. Returns {idx:[Int32Array x3], re:[..], im:[..]}
  function receiverRows(g, omega, k, pos) {
    const NZ = g.NZ, q = omega * MU, xs = pos[0], zs = pos[1], rows = [];
    const dof = (c, i, j) => 3 * (i * NZ + j) + c;
    function build(terms) {                                            // terms: [dof, re, im, escale(1 if Ey: multiply by i)]
      const m = new Map();
      for (const [d, re, im, ey] of terms) {          // coefficient = (re + i im) * [i if Ey] * (-i)   (H = curl E / (i w mu))
        let r = re, ii = im; if (ey) { r = -im; ii = re; }
        const o = m.get(d) || [0, 0]; o[0] += ii; o[1] += -r; m.set(d, o);
      }
      const idx = new Int32Array(m.size), rr = new Float64Array(m.size), ri = new Float64Array(m.size); let p = 0;
      for (const [d, o] of m) { idx[p] = d; rr[p] = o[0]; ri[p] = o[1]; p++; }
      return { idx, re: rr, im: ri };
    }
    // Hx' = ( ik Ez[i,j] - (Ey[i,j+1]-Ey[i,j])/hz[j] ) / q  at (x_i, zc_j)
    let [i0, a0, a1] = bilin(g.xn, xs), [j0, b0, b1] = bilin(g.zc, zs), T = [];
    for (const [di, wi] of [[0, a0], [1, a1]]) for (const [dj, wj] of [[0, b0], [1, b1]]) {
      const i = i0 + di, j = j0 + dj, w = wi * wj / q;
      T.push([dof(2, i, j), 0, k * w, 0]); T.push([dof(1, i, j + 1), -w / g.hz[j], 0, 1]); T.push([dof(1, i, j), w / g.hz[j], 0, 1]);
    }
    rows.push(build(T));
    // Hy' = ( (Ex[i,j+1]-Ex[i,j])/hz[j] - (Ez[i+1,j]-Ez[i,j])/hx[i] ) / q  at (xc_i, zc_j)
    [i0, a0, a1] = bilin(g.xc, xs); [j0, b0, b1] = bilin(g.zc, zs); T = [];
    for (const [di, wi] of [[0, a0], [1, a1]]) for (const [dj, wj] of [[0, b0], [1, b1]]) {
      const i = i0 + di, j = j0 + dj, w = wi * wj / q;
      T.push([dof(0, i, j + 1), w / g.hz[j], 0, 0]); T.push([dof(0, i, j), -w / g.hz[j], 0, 0]); T.push([dof(2, i + 1, j), -w / g.hx[i], 0, 0]); T.push([dof(2, i, j), w / g.hx[i], 0, 0]);
    }
    rows.push(build(T));
    // Hz' = ( (Ey[i+1,j]-Ey[i,j])/hx[i] - ik Ex[i,j] ) / q  at (xc_i, z_j)
    [i0, a0, a1] = bilin(g.xc, xs); [j0, b0, b1] = bilin(g.zn, zs); T = [];
    for (const [di, wi] of [[0, a0], [1, a1]]) for (const [dj, wj] of [[0, b0], [1, b1]]) {
      const i = i0 + di, j = j0 + dj, w = wi * wj / q;
      T.push([dof(1, i + 1, j), w / g.hx[i], 0, 1]); T.push([dof(1, i, j), -w / g.hx[i], 0, 1]); T.push([dof(0, i, j), 0, -k * w, 0]);
    }
    rows.push(build(T));
    return rows;
  }

  // ------------------------------------------------------------------ wavenumber quadrature
  // 1/pi * integral_0^inf f(k) dk  with k = k0 sinh(u), Gauss-Legendre in u on [0, asinh(kmax/k0)]
  const GL = {};
  function gaussLegendre(n) {
    if (GL[n]) return GL[n];
    const x = new Float64Array(n), w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let z = Math.cos(Math.PI * (i + 0.75) / (n + 0.5)), pp = 0;
      for (let it = 0; it < 100; it++) {
        let p1 = 1, p2 = 0; for (let j = 1; j <= n; j++) { const p3 = p2; p2 = p1; p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j; }
        pp = n * (z * p1 - p2) / (z * z - 1); const dz = p1 / pp; z -= dz; if (Math.abs(dz) < 1e-15) break;
      }
      x[i] = -z; w[i] = 2 / ((1 - z * z) * pp * pp);
    }
    return (GL[n] = { x, w });
  }
  function kNodes2(n, dLo, dHi) {          // k = k0 sinh(u), k0 = 0.2/dHi, kmax = 3/dLo, Gauss-Legendre in u
    const { x, w } = gaussLegendre(n), k0 = 0.2 / dHi, kmax = 3 / dLo, umax = Math.asinh(kmax / k0), ks = new Float64Array(n), wk = new Float64Array(n);
    for (let i = 0; i < n; i++) { const u = 0.5 * umax * (x[i] + 1); ks[i] = k0 * Math.sinh(u); wk[i] = 0.5 * umax * w[i] * k0 * Math.cosh(u) / Math.PI; }
    return { ks, wk };
  }
  function kNodes(n, dstar, k0f, kmf) {
    const { x, w } = gaussLegendre(n), k0 = k0f / dstar, kmax = kmf / dstar, umax = Math.asinh(kmax / k0), ks = new Float64Array(n), wk = new Float64Array(n);
    for (let i = 0; i < n; i++) { const u = 0.5 * umax * (x[i] + 1); ks[i] = k0 * Math.sinh(u); wk[i] = 0.5 * umax * w[i] * k0 * Math.cosh(u) / Math.PI; }
    return { ks, wk };
  }


  // ------------------------------------------------------------------ one station: difference field (2D model minus local-1D baseline)
  // Returns, for each (L,f) pair, the 5 complex tensor components of  H_2D - H_1D  in the section frame (x_sec, y_sec, z down):
  //   comps order: xx, yy, zz, xz, zx   (H_ij = component i due to a unit dipole along j)
  const DEF = { res: 8, sres: 3.5, nk: 8, sub: 8, nodeBudget: 9000, hMin: 0.2, thr: 0.02, ext: 1.2, scanN: 110, mf: 1.5, mL: 0, Dfac: 3 };
  function skinDepth(rho, f) { return 503.3 * Math.sqrt(rho / f); }
  function segDist(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
    return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
  }
  // scan a box on an ns x ns lattice for cells where the 2D model differs from the local-1D model.
  // dmin: distance from the antennas to the nearest flagged cell; dbnd: distance to the nearest flagged cell on the boundary of the
  // flagged region (where the difference starts or stops sharply) -- the scale that the grid has to resolve.
  function scanAnomaly(m2, mb, box, ns, thr, seg, fl) {
    const t2 = [0, 0, 0, 0], tb = [0, 0, 0, 0], dx = (box[1] - box[0]) / ns, dz = (box[3] - box[2]) / ns, F = new Uint8Array(ns * ns), D = new Float64Array(ns * ns);
    let dmin = Infinity, dbnd = Infinity, cnt = 0;
    for (let i = 0; i < ns; i++) {
      const x = box[0] + (i + 0.5) * dx; m2.column(x); mb.column(x);
      for (let j = 0; j < ns; j++) {
        const z = box[2] + (j + 0.5) * dz, k2 = m2.layer(x, z), kb = mb.layer(x, z); m2.tensor(k2, t2); mb.tensor(kb, tb);
        const sc = Math.max(t2[0], t2[2], tb[0], tb[2]), dd = Math.max(Math.abs(t2[0] - tb[0]), Math.abs(t2[2] - tb[2]), Math.abs(t2[3] - tb[3]));
        if (dd > thr * sc) {
          cnt++; let d = Infinity; for (let q = 0; q < seg.length; q += 2) d = Math.min(d, Math.hypot(x - seg[q], z - seg[q + 1]));
          F[i * ns + j] = 1; D[i * ns + j] = d; if (d < dmin) dmin = d;
          if (fl) fl.push(d, Math.max(t2[0], t2[1], t2[2], tb[0], tb[1], tb[2]), Math.min(t2[0], t2[1], t2[2], tb[0], tb[1], tb[2]));
        }
      }
    }
    for (let i = 0; i < ns; i++) for (let j = 0; j < ns; j++) {
      const c = i * ns + j; if (!F[c] || D[c] >= dbnd) continue;
      if ((i > 0 && !F[c - ns]) || (i < ns - 1 && !F[c + ns]) || (j > 0 && !F[c - 1]) || (j < ns - 1 && !F[c + 1])) dbnd = D[c];
    }
    return { dmin, dbnd, cnt };
  }
  // geo2: 2D geology; loc: local-1D baseline (buildLocal2D result); mid=(x,z); ax=(ax,az) unit tool axis (bit-ward) in section coords;
  // pairs: [{L,f}] with signed spacing; f in Hz. All pairs must share the same frequency here.
  function planGroup(geo2, loc, mid, ax, pairs, opt) {
    opt = Object.assign({}, DEF, opt || {});
    const f = pairs[0].f, m2 = model2D(geo2), mb = modelBase(loc, geo2);
    let Lmax = 0, Lmin = Infinity; for (const p of pairs) { Lmax = Math.max(Lmax, Math.abs(p.L)); Lmin = Math.min(Lmin, Math.abs(p.L)); }
    const ex = [mid[0] - 0.5 * Lmax * ax[0], mid[0] + 0.5 * Lmax * ax[0]], ez = [mid[1] - 0.5 * Lmax * ax[1], mid[1] + 0.5 * Lmax * ax[1]];
    const bx0 = Math.min(ex[0], ex[1]), bx1 = Math.max(ex[0], ex[1]), bz0 = Math.min(ez[0], ez[1]), bz1 = Math.max(ez[0], ez[1]);
    const seg = []; for (const p of pairs) for (const sgn of [-0.5, 0.5]) seg.push(mid[0] + sgn * p.L * ax[0], mid[1] + sgn * p.L * ax[1]);   // antenna points
    // skin depths of the baseline layers
    let dMin = Infinity, dMax = 0; for (let k = 0; k < loc.N; k++) { const rho = 1 / Math.max(loc.sh[k], loc.sv[k]), rho2 = 1 / Math.min(loc.sh[k], loc.sv[k]); dMin = Math.min(dMin, skinDepth(rho, f)); dMax = Math.max(dMax, skinDepth(rho2, f)); }
    for (let k = 0; k < m2.N; k++) { const pr = layerProps2D(geo2, k, mid[0]); dMin = Math.min(dMin, skinDepth(Math.min(pr.rh, pr.rv), f)); }
    // anomaly scan (three nested boxes)
    const R = Math.min(150, Math.max(25, 1.5 * Lmax + 2.5 * Math.min(dMax, 60)));
    let dmin0 = Infinity, dbnd = Infinity, cnt = 0; const fl = [];
    for (const r of [R, R / 4, R / 16]) { const s = scanAnomaly(m2, mb, [bx0 - r, bx1 + r, bz0 - r, bz1 + r], opt.scanN, opt.thr, seg, fl); cnt += s.cnt; dmin0 = Math.min(dmin0, s.dmin); dbnd = Math.min(dbnd, s.dbnd); }
    if (!(cnt > 0)) return { skip: true, f, dmin: Infinity, R };
    // the grid has to resolve the distance from the antennas to where the difference starts; an antenna inside a smoothly
    // differing region (no boundary in reach) only needs the tool scale
    const dmin = isFinite(dbnd) ? dbnd : Math.max(dmin0, 0.5 * Lmax);
    // resolution: the skin depth of the most conductive laterally-varying zone that the field can still reach (within 2.5 background skin depths
    // behind the nearest anomalous cell) sets the cell size, in addition to the layer skin depths at the tool
    let sgmax = 0, sgmin = Infinity; const rel = dmin0 + 2.5 * Math.min(dMax, 60);
    for (let q = 0; q < fl.length; q += 3) if (fl[q] <= rel) { if (fl[q + 1] > sgmax) sgmax = fl[q + 1]; if (fl[q + 2] < sgmin) sgmin = fl[q + 2]; }
    const dRes = Math.min(dMin, sgmax > 0 ? skinDepth(1 / sgmax, f) : Infinity);
    if (sgmin > 0 && isFinite(sgmin)) dMax = Math.max(dMax, skinDepth(1 / sgmin, f));        // resistive zones across a lateral boundary widen the box
    const hHi = Math.min(Lmin / 6, dRes / opt.sres, 4);
    let h0 = Math.min(Math.max(dmin / opt.res, opt.hMin), Math.max(hHi, opt.hMin));
    const D = Math.min(250, Math.max(40, opt.Dfac * Math.min(dMax, 80)));
    let grid;
    for (let it = 0; it < 40; it++) {
      const M = Math.max(12 * h0, opt.mf * dmin, opt.mL * Lmax), s = opt.ext;
      const xn = gradedAxis(bx0 - M, bx1 + M, h0, D, D, s), zn = gradedAxis(bz0 - M, bz1 + M, h0, D, D, s);
      grid = { xn, zn, h0, M, D, nodes: xn.length * zn.length };
      if (grid.nodes <= opt.nodeBudget) break;
      h0 *= 1.12;
    }
    return { skip: false, f, dmin, R, h0, grid, m2, mb, loc, Lmin, Lmax, dMin, dMax, dRes, opt, mid, ax, pairs };
  }
  function runGroup(plan, onProgress) {
    const { grid, m2, mb, opt, mid, ax, pairs, dmin, h0, dRes } = plan, g = makeGrid(grid.xn, grid.zn), f = plan.f, omega = 2 * Math.PI * f;
    const NN = g.NX * g.NZ, nd = 3 * NN, SR = new Float64Array(NN * 81), SI = new Float64Array(NN * 81);
    const ten2 = opt.edge === false ? cellTensors(g, m2, opt.sub, opt.lam) : edgeTensors(g, m2, opt.sub), tenB = opt.edge === false ? cellTensors(g, mb, opt.sub, opt.lam) : edgeTensors(g, mb, opt.sub);
    const planS = FDSolve.buildPlan(g.NX, g.NZ, 16), fac = new FDSolve.Factorization(planS);
    // unique transmitter / receiver positions
    const np = pairs.length, txp = pairs.map((p) => [mid[0] - 0.5 * p.L * ax[0], mid[1] - 0.5 * p.L * ax[1]]), rxp = pairs.map((p) => [mid[0] + 0.5 * p.L * ax[0], mid[1] + 0.5 * p.L * ax[1]]);
    const dLo = Math.max(dmin, 2 * h0), dHi = Math.max(dLo, 0.5 * plan.Lmax), nkE = opt.nk + Math.round(2.35 * Math.log(dHi / dLo));
    const { ks, wk } = kNodes2(nkE, dLo, dHi);
    const nrhs = 3 * np, acc = new Float64Array(np * 5 * 2), BR = new Float64Array(nd * nrhs), BI = new Float64Array(nd * nrhs);
    const BR2 = new Float64Array(nd * nrhs), BI2 = new Float64Array(nd * nrhs), comps = [[0, 0], [1, 1], [2, 2], [0, 2], [2, 0]];   // (rx comp, src comp): xx, yy, zz, xz, zx
    const Hs = (rows, B_R, B_I, comp, col, out2) => { const r = rows[comp]; let re = 0, im = 0; for (let t = 0; t < r.idx.length; t++) { const d = r.idx[t] * nrhs + col; re += r.re[t] * B_R[d] - r.im[t] * B_I[d]; im += r.re[t] * B_I[d] + r.im[t] * B_R[d]; } out2[0] = re; out2[1] = im; };
    const h2 = [0, 0], h1 = [0, 0]; let nfac = 0;
    for (let q = 0; q < ks.length; q++) {
      const k = ks[q], w = wk[q];
      BR.fill(0); BI.fill(0);
      for (let p = 0; p < np; p++) for (let s = 0; s < 3; s++) sourceRHS(g, omega, k, txp[p], s, BR, BI, 3 * p + s, nrhs);
      BR2.set(BR); BI2.set(BI);
      assemble(g, ten2, omega, k, SR, SI); fac.factor(SR, SI); fac.solve(BR, BI, nrhs);
      assemble(g, tenB, omega, k, SR, SI); fac.factor(SR, SI); fac.solve(BR2, BI2, nrhs);
      nfac += 2;
      for (let p = 0; p < np; p++) {
        const rows = receiverRows(g, omega, k, rxp[p]);
        for (let c = 0; c < 5; c++) {
          Hs(rows, BR, BI, comps[c][0], 3 * p + comps[c][1], h2); Hs(rows, BR2, BI2, comps[c][0], 3 * p + comps[c][1], h1);
          acc[(p * 5 + c) * 2] += w * (h2[0] - h1[0]); acc[(p * 5 + c) * 2 + 1] += w * (h2[1] - h1[1]);
        }
      }
      if (onProgress) onProgress(q + 1, ks.length);
    }
    return { delta: acc, info: { f, dmin, h0, nx: g.nx, nz: g.nz, nodes: NN, nk: ks.length, nfac, dRes, quality: Math.min(dmin / (opt.res * h0), dRes / (opt.sres * h0)), qd: dmin / h0, qs: dRes / h0 } };
  }

  return { MU, gradedAxis, makeGrid, model2D, modelBase, cellTensors, edgeTensors, lamAvg, assemble, sourceRHS, receiverRows, kNodes, gaussLegendre, bilin, planGroup, runGroup, skinDepth, DEF };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { FD };
