// ===================================================================================
// model.js -- well trajectory, tool/formation frames, 1D & local-1D geology, forward driver
//   Global frame: NED (x = North, y = East, z = Down).  Angles in degrees at the API, radians internally.
//   Needs: Engine (engine1d.js), HANKEL_FILTERS (filters.js)
// ===================================================================================
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const v3 = {
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  norm: (a) => Math.hypot(a[0], a[1], a[2]),
  unit: (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; },
};

// ---------------------------------------------------------------- trajectory (minimum curvature) ----
// def = { md0, N0, E0, D0, inc0, az0, sections:[{len, incEnd, azEnd}] }  (deg; inc/az vary linearly with MD in a section)
function buildTrajectory(def, ds) {
  ds = ds || 0.5;
  const md = [def.md0], N = [def.N0], E = [def.E0], D = [def.D0], I = [def.inc0 * D2R], A = [def.az0 * D2R];
  let I0 = def.inc0 * D2R, A0 = def.az0 * D2R;
  for (const s of def.sections) {
    const len = Math.max(1e-6, +s.len), n = Math.max(1, Math.ceil(len / ds - 1e-9));
    const I1 = s.incEnd * D2R, A1 = s.azEnd * D2R, dmd = len / n;
    for (let k = 1; k <= n; k++) {
      const f = k / n, Ik = I0 + (I1 - I0) * f, Ak = A0 + (A1 - A0) * f;
      const p = I.length - 1, Ip = I[p], Ap = A[p];
      const cb = Math.cos(Ik - Ip) - Math.sin(Ip) * Math.sin(Ik) * (1 - Math.cos(Ak - Ap));
      const beta = Math.acos(Math.min(1, Math.max(-1, cb)));
      const rf = beta < 1e-8 ? 1 : (2 / beta) * Math.tan(beta / 2);
      N.push(N[p] + 0.5 * dmd * (Math.sin(Ip) * Math.cos(Ap) + Math.sin(Ik) * Math.cos(Ak)) * rf);
      E.push(E[p] + 0.5 * dmd * (Math.sin(Ip) * Math.sin(Ap) + Math.sin(Ik) * Math.sin(Ak)) * rf);
      D.push(D[p] + 0.5 * dmd * (Math.cos(Ip) + Math.cos(Ik)) * rf);
      md.push(md[p] + dmd); I.push(Ik); A.push(Ak);
    }
    I0 = I1; A0 = A1;
  }
  return { md: Float64Array.from(md), N: Float64Array.from(N), E: Float64Array.from(E), D: Float64Array.from(D), inc: Float64Array.from(I), az: Float64Array.from(A) };
}
function trajEnd(tr) { return tr.md[tr.md.length - 1]; }
function trajAt(tr, m) {
  const md = tr.md, n = md.length;
  if (m <= md[0]) m = md[0]; else if (m >= md[n - 1]) m = md[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (md[mid] <= m) lo = mid; else hi = mid; }
  const f = md[hi] === md[lo] ? 0 : (m - md[lo]) / (md[hi] - md[lo]);
  const L = (a) => a[lo] + (a[hi] - a[lo]) * f;
  return { md: m, N: L(tr.N), E: L(tr.E), D: L(tr.D), inc: L(tr.inc), az: L(tr.az) };
}

// ---------------------------------------------------------------- frames ----
// tool basis: z_t = bit-ward axis, x_t = high side rotated by toolface tf (toward t x h), y_t = z_t x x_t
function toolBasis(inc, az, tf) {
  const si = Math.sin(inc), ci = Math.cos(inc), sa = Math.sin(az), ca = Math.cos(az);
  const t = [si * ca, si * sa, ci], h = [ci * ca, ci * sa, -si], s = v3.cross(t, h);
  const c = Math.cos(tf), sn = Math.sin(tf);
  const xt = [c * h[0] + sn * s[0], c * h[1] + sn * s[1], c * h[2] + sn * s[2]];
  const yt = [c * s[0] - sn * h[0], c * s[1] - sn * h[1], c * s[2] - sn * h[2]];
  return { t, h, xt, yt, zt: t };
}
function dipNormal(dip, dipAz) {           // unit normal pointing down; plane descends toward dipAz
  const sd = Math.sin(dip), cd = Math.cos(dip);
  return [-sd * Math.cos(dipAz), -sd * Math.sin(dipAz), cd];
}
function makeStation(tr, md, tfDeg) {
  const p = trajAt(tr, md), b = toolBasis(p.inc, p.az, tfDeg * D2R);
  return { md: p.md, N: p.N, E: p.E, D: p.D, inc: p.inc, az: p.az, tf: tfDeg * D2R, r: [p.N, p.E, p.D], xt: b.xt, yt: b.yt, zt: b.zt, h: b.h };
}
function orientVec(o) {                    // antenna orientation in the tool frame
  const k = o.k;
  if (k === 'Z') return [0, 0, 1]; if (k === 'X') return [1, 0, 0]; if (k === 'Y') return [0, 1, 0];
  const th = (o.th || 0) * D2R, ph = (o.ph || 0) * D2R;
  return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
}

// geometry of a Tx-Rx pair relative to a layered medium with unit down-normal n; Tx/Rx at -/+ L/2 about the midpoint.
// returns dzT, dzR (normal coordinates relative to the midpoint), rho (bedding-parallel offset), and Rt = B^T-ready axes
function pairGeom(st, nrm, L) {
  const nt = v3.dot(nrm, st.zt);                       // cos(relative dip)
  const dzT = -0.5 * L * nt, dzR = 0.5 * L * nt;
  let d = v3.scale(v3.sub(st.zt, v3.scale(nrm, nt)), L);   // Rx - Tx projected on bedding
  let rho = v3.norm(d), xf;
  if (rho > 1e-9 * Math.abs(L)) xf = v3.scale(d, 1 / rho);
  else {                                               // tool axis along the normal: pick reference from the high side / x_t
    rho = 0;
    let c = v3.sub(st.xt, v3.scale(nrm, v3.dot(st.xt, nrm)));
    if (v3.norm(c) < 1e-6) c = v3.sub(st.yt, v3.scale(nrm, v3.dot(st.yt, nrm)));
    xf = v3.unit(c);
  }
  const yf = v3.cross(nrm, xf);
  return { dzT, dzR, rho: Math.abs(rho), xf, yf, zf: nrm, L };
}
// B[i][j] = (tool axis i) . (formation axis j);  vector v (tool comps) -> formation comps: vf_j = sum_i B[i][j] v_i
function toFormation(st, pg, v) {
  const ax = [st.xt, st.yt, st.zt], out = [0, 0, 0], fa = [pg.xf, pg.yf, pg.zf];
  for (let j = 0; j < 3; j++) { let s = 0; for (let i = 0; i < 3; i++) s += v[i] * v3.dot(ax[i], fa[j]); out[j] = s; }
  return out;
}

// formation-frame tensor T (xx,yy,zz,xz,zx re/im) -> channel value  b^T H a  (a,b in formation comps)
function chanFromT(T, af, bf) {
  const re = T[0] * bf[0] * af[0] + T[2] * bf[1] * af[1] + T[4] * bf[2] * af[2] + T[6] * bf[0] * af[2] + T[8] * bf[2] * af[0];
  const im = T[1] * bf[0] * af[0] + T[3] * bf[1] * af[1] + T[5] * bf[2] * af[2] + T[7] * bf[0] * af[2] + T[9] * bf[2] * af[0];
  return [re, im];
}

// ---------------------------------------------------------------- channels ----
// channel = { L (m, signed: Rx at +L/2 from midpoint along the bit-ward axis), f (Hz), tx:{k,th,ph}, rx:{k,th,ph}, on }
function prepChannels(chs) {
  return chs.map((c, i) => ({ idx: i, L: +c.L, f: +c.f, a: orientVec(c.tx), b: orientVec(c.rx), key: (+c.L) + '|' + (+c.f) }));
}
// evaluate all channels at one station given a local layered model {N, sh, sv, zi, nrm} whose normal coordinate of the
// tool midpoint is zm (boundaries zi are in the same coordinate). out: Float64Array(2*nch), normalised by 1/(2 pi |L|^3)
const _T = new Float64Array(10);
function evalStation(st, loc, pch, filt, out, zmOverride) {
  const zm = zmOverride !== undefined ? zmOverride : v3.dot(loc.nrm, st.r);
  const cache = {};
  for (let c = 0; c < pch.length; c++) {
    const ch = pch[c];
    let e = cache[ch.key];
    if (!e) {
      const pg = pairGeom(st, loc.nrm, ch.L);
      Engine.tensor(2 * Math.PI * ch.f, loc, zm + pg.dzT, zm + pg.dzR, pg.rho, 1, filt, _T);
      e = { pg, T: Float64Array.from(_T) }; cache[ch.key] = e;
    }
    const af = toFormation(st, e.pg, ch.a), bf = toFormation(st, e.pg, ch.b);
    const v = chanFromT(e.T, af, bf), sc = 2 * Math.PI * Math.abs(ch.L) ** 3;
    out[2 * c] = v[0] * sc; out[2 * c + 1] = v[1] * sc;
  }
}

// ---------------------------------------------------------------- 1D (planar dipping layers) geology ----
// geo1 = { dip, dipAz, z0 (TVD of boundary 1 at N=E=0), layers:[{rh, rv, tvt}] }  (tvt = vertical thickness of interior layers)
function buildLocal1D(geo1) {
  const L = geo1.layers, N = L.length, dip = geo1.dip * D2R, dipAz = geo1.dipAz * D2R, nrm = dipNormal(dip, dipAz), cd = Math.cos(dip);
  const zi = new Float64Array(Math.max(0, N - 1)), sh = new Float64Array(N), sv = new Float64Array(N);
  const z1 = v3.dot(nrm, [geo1.refN || 0, geo1.refE || 0, geo1.z0]);      // normal coordinate of boundary 1 (plane through (refN, refE, z0))
  for (let k = 0; k < N - 1; k++) zi[k] = k === 0 ? z1 : zi[k - 1] + Math.max(1e-3, L[k].tvt) * cd;
  for (let k = 0; k < N; k++) { sh[k] = 1 / L[k].rh; sv[k] = 1 / L[k].rv; }
  return { N, sh, sv, zi, nrm, dip, dipAz };
}

// ---------------------------------------------------------------- 2D geology (section plane) ----
// geo2 = { azSec, horizons:[{pts:[[x,z],...]}], layers:[{rh:[[x,v],..], rv:[[x,v],..]}] }
function interpPL(pts, x, logv) {
  const n = pts.length; if (n === 1) return pts[0][1];
  if (x <= pts[0][0]) return pts[0][1]; if (x >= pts[n - 1][0]) return pts[n - 1][1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= x) lo = m; else hi = m; }
  // vertical steps (equal x): take the upper (smaller index) value left of x, lower value from x on
  const x0 = pts[lo][0], x1 = pts[hi][0]; if (x1 === x0) return pts[hi][1];
  const f = (x - x0) / (x1 - x0), a = pts[lo][1], b = pts[hi][1];
  return logv ? Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * f) : a + (b - a) * f;
}
function horizonZ(geo2, x, out) {          // depths of all horizons at x, ordered (pinch-outs by running max)
  const H = geo2.horizons, n = H.length; out = out || new Float64Array(n); let prev = -Infinity;
  for (let k = 0; k < n; k++) { const z = interpPL(H[k].pts, x, false); out[k] = Math.max(z, prev); prev = out[k]; }
  return out;
}
function horizonSlope(geo2, k, x, w) {      // dz/dx of horizon k about x (central difference over +-w)
  const H = geo2.horizons[k].pts; return (interpPL(H, x + w, false) - interpPL(H, x - w, false)) / (2 * w);
}
function layerProps2D(geo2, k, x) { return { rh: interpPL(geo2.layers[k].rh, x, true), rv: interpPL(geo2.layers[k].rv, x, true) }; }
function layerAt2D(geo2, x, z, zh) {
  zh = horizonZ(geo2, x, zh); let k = 0; while (k < zh.length && z > zh[k]) k++; return k;
}
// station position -> section coordinates
function secX(geo2, N, E) { const a = geo2.azSec * D2R; return N * Math.cos(a) + E * Math.sin(a); }
// local-1D approximation of the 2D model at a station: boundary intercepts below the tool midpoint, dip of the nearest horizon
function buildLocal2D(geo2, st, win) {
  const xm = secX(geo2, st.r[0], st.r[1]), zm = st.r[2], zh = horizonZ(geo2, xm), nh = zh.length, N = nh + 1;
  win = win || 5;
  let kn = 0, best = Infinity; for (let k = 0; k < nh; k++) { const d = Math.abs(zh[k] - zm); if (d < best) { best = d; kn = k; } }
  const slope = nh ? horizonSlope(geo2, kn, xm, win) : 0, dipSigned = Math.atan(slope);   // + : deepens with +x
  const asec = geo2.azSec * D2R, dip = Math.abs(dipSigned), dipAz = dipSigned >= 0 ? asec : asec + Math.PI;
  const nrm = dipNormal(dip, dipAz), cd = Math.cos(dip);
  // plane through the point (xm, zh_k) with this dip: normal coordinate of boundary k = n . (point on boundary)
  const zi = new Float64Array(nh), sh = new Float64Array(N), sv = new Float64Array(N);
  const cA = Math.cos(asec), sA = Math.sin(asec);
  for (let k = 0; k < nh; k++) { const p = [xm * cA, xm * sA, zh[k]]; zi[k] = v3.dot(nrm, p); }
  for (let k = 0; k < N; k++) { const pr = layerProps2D(geo2, k, xm); sh[k] = 1 / pr.rh; sv[k] = 1 / pr.rv; }
  // the tool midpoint expressed in the same normal coordinate (in-plane positions: E offset ignored in 2D)
  const zmN = v3.dot(nrm, [xm * cA, xm * sA, zm]);
  return { N, sh, sv, zi, nrm, dip, dipAz, zm: zmN, kn };
}

// ---------------------------------------------------------------- forward drivers ----
// cfg = { traj:{...}, tf (deg), mdStart, mdEnd, mdStep, channels:[...], mode:'1d'|'2d-local', geo1, geo2, filter:'key_201_2012' }
function stationList(cfg, tr) {
  const out = []; const m0 = cfg.mdStart, m1 = cfg.mdEnd, ds = cfg.mdStep;
  const n = Math.max(1, Math.floor((m1 - m0) / ds + 1e-9) + 1);
  for (let i = 0; i < n; i++) out.push(makeStation(tr, m0 + i * ds, cfg.tf));
  return out;
}
function forwardRange(cfg, tr, stations, i0, i1, out) {          // out: Float64Array((i1-i0)*nCh*2), row (i-i0)
  const pch = prepChannels(cfg.channels), nch = pch.length, filt = HANKEL_FILTERS[cfg.filter || 'key_201_2012'];
  const loc1 = cfg.mode === '1d' ? buildLocal1D(cfg.geo1) : null, buf = new Float64Array(2 * nch);
  for (let i = i0; i < i1; i++) {
    const st = stations[i];
    let loc = loc1, zm;
    if (!loc1) { loc = buildLocal2D(cfg.geo2, st, cfg.slopeWin); zm = loc.zm; }
    evalStation(st, loc, pch, filt, buf, zm);
    out.set(buf, (i - i0) * 2 * nch);
  }
}
function forwardLocal(cfg, tr) {
  tr = tr || buildTrajectory(cfg.traj, 0.5);
  const st = stationList(cfg, tr), out = new Float64Array(st.length * cfg.channels.length * 2);
  forwardRange(cfg, tr, st, 0, st.length, out);
  return { stations: st, data: out };
}
