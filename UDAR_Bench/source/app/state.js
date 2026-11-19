// ===================================================================================
// state.js -- application state, presets, config builders, section/curtain data
// ===================================================================================
const PRESETS_TOOL = {
  'Generic UDAR: 3 spacings, ZZ/ZX/XZ/XX': { spacings: [8, 16, 30], freqs: [100, 24, 6], comps: ['ZZ', 'ZX', 'XZ', 'XX'], pair: true },
  'Deep reading: 4 spacings, 2-24 kHz': { spacings: [10, 20, 30, 40], freqs: [24, 12, 6, 2], comps: ['ZZ', 'ZX', 'XZ'], pair: true },
  'Triaxial: 2 spacings × 2 frequencies': { spacings: [12, 24], freqs: [24, 6], comps: ['ZZ', 'XX', 'YY', 'ZX', 'XZ', 'XY', 'YX'], pair: false },
  'Axial only: ZZ at 3 spacings': { spacings: [8, 16, 30], freqs: [100, 24, 6], comps: ['ZZ'], pair: true },
};
function makeChannels(spec) {
  const rows = [];
  const cmp = (c) => ({ k: c, th: 0, ph: 0 });
  spec.spacings.forEach((L, i) => {
    const fl = spec.pair ? [spec.freqs[Math.min(i, spec.freqs.length - 1)]] : spec.freqs;
    for (const f of fl) for (const c of spec.comps) rows.push({ on: true, L, f, tx: cmp(c[0]), rx: cmp(c[1]) });
  });
  return rows;
}
const PRESETS_GEO1 = {
  'Thin sand in shale': { dip: 1.5, dipAz: 180, z0: 2000, layers: [{ rh: 2, rv: 3, tvt: 0 }, { rh: 60, rv: 80, tvt: 8 }, { rh: 2, rv: 3, tvt: 0 }] },
  'Thick reservoir over water leg': { dip: 0.5, dipAz: 180, z0: 1996, layers: [{ rh: 2.5, rv: 4, tvt: 0 }, { rh: 90, rv: 110, tvt: 14 }, { rh: 1.2, rv: 1.5, tvt: 0 }] },
  'Five layers with laminated shale': { dip: 2, dipAz: 180, z0: 1999, layers: [{ rh: 3, rv: 6, tvt: 0 }, { rh: 25, rv: 40, tvt: 5 }, { rh: 100, rv: 120, tvt: 7 }, { rh: 8, rv: 12, tvt: 6 }, { rh: 1.5, rv: 2, tvt: 0 }] },
  'Homogeneous (reference)': { dip: 0, dipAz: 0, z0: 2000, layers: [{ rh: 10, rv: 10, tvt: 0 }] },
};
const PRESETS_GEO2 = {
  'Undulating sand, lateral resistivity drop': {
    azSec: 0,
    horizons: [{ pts: [[-50, 2001], [0, 2000], [80, 1997.5], [160, 1994.8], [240, 1993.2], [320, 1993.8], [420, 1996]] }, { pts: [[-50, 2009], [0, 2008], [80, 2005.3], [160, 2002.6], [240, 2001.2], [320, 2001.6], [420, 2004]] }],
    layers: [{ props: [[0, 2, 3]] }, { props: [[-50, 60, 80], [260, 60, 80], [300, 20, 28]] }, { props: [[0, 2, 3]] }],
  },
  'Normal fault, 6 m throw': {
    azSec: 0,
    horizons: [{ pts: [[-50, 2002], [150, 1998.6], [150, 1992.6], [420, 1990]] }, { pts: [[-50, 2010], [150, 2006.6], [150, 2000.6], [420, 1998]] }],
    layers: [{ props: [[0, 2, 3]] }, { props: [[0, 60, 80]] }, { props: [[0, 2, 3]] }],
  },
  'Pinch-out wedge': {
    azSec: 0,
    horizons: [{ pts: [[-50, 2000], [420, 1993]] }, { pts: [[-50, 2012], [200, 2005], [300, 1999], [420, 1993]] }],
    layers: [{ props: [[0, 2, 3]] }, { props: [[0, 50, 70]] }, { props: [[0, 2, 3]] }],
  },
};

function defaultState() {
  return {
    v: 1, mode: '1d', tab: 'tool', theme: 'auto', auto: true,
    tool: { channels: makeChannels(PRESETS_TOOL['Generic UDAR: 3 spacings, ZZ/ZX/XZ/XX']), gen: { spacings: '8, 16, 30', freqs: '100, 24, 6', pair: true, comps: { ZZ: true, ZX: true, XZ: true, XX: true, YY: false, XY: false, YX: false, YZ: false, ZY: false } } },
    filter: 'key_201_2012',
    well: { md0: 0, N0: 0, E0: 0, D0: 1993, inc0: 88, az0: 0, sections: [{ len: 150, incEnd: 90, azEnd: 0 }, { len: 150, incEnd: 92, azEnd: 0 }], tf: 0, mdStart: 20, mdEnd: 280, mdStep: 2 },
    geo1: clone(PRESETS_GEO1['Thin sand in shale']),
    geo2: clone(PRESETS_GEO2['Undulating sand, lateral resistivity drop']),
    engine2d: 'fd', fd: { q: 'std', step: 25 }, cmpLocal: true,
    cursorMd: 150, chartQty: 'ap', fwdSel: {},
    inv: {
      noise: { ampDb: 0.1, phaseDeg: 0.5, floorPpm: 100, biasDb: 0, biasDeg: 0, seed: 1 }, assumedSame: true, assumed: { ampDb: 0.1, phaseDeg: 0.5, floorPpm: 100 },
      off: [], specAuto: true, specKey: '', nLayers: 3, perturb: { rho: 2, d: 3 }, spec: null, nStarts: 4, maxIter: 40, filter: 'key_101_2012', dipErr: 0, dipAzErr: 0, continuation: true, acceptChi2: 1.6, fitChan: 0, anisoFree: false,
    },
  };
}

// ---- derived config for the core -------------------------------------------------------------------------
function angDiff(a, b) { let d = ((a - b) % 360 + 540) % 360 - 180; return d; }
function snapAz(az, azSec) { return Math.abs(angDiff(az, azSec)) <= Math.abs(angDiff(az, azSec + 180)) ? azSec : azSec + 180; }
function cfgFromState(S) {
  const w = S.well, mode = S.mode;
  const traj = { md0: w.md0, N0: w.N0, E0: w.E0, D0: w.D0, inc0: w.inc0, az0: w.az0, sections: w.sections.map(s => ({ len: Math.max(0.5, s.len), incEnd: s.incEnd, azEnd: s.azEnd })) };
  if (mode === '2d') { const a = S.geo2.azSec; traj.az0 = snapAz(traj.az0, a); traj.sections.forEach(s => { s.azEnd = snapAz(s.azEnd, a); }); }
  let mdEnd = w.md0; for (const s of traj.sections) mdEnd += s.len;
  const mdStart = clamp(w.mdStart, w.md0, mdEnd), mdStop = clamp(w.mdEnd, mdStart, mdEnd), mdStep = Math.max(0.1, w.mdStep);
  const channels = S.tool.channels.filter(c => c.on).map(c => ({ L: c.L, f: c.f * 1000, tx: clone(c.tx), rx: clone(c.rx), name: chanName(c), sig: chanSigRow(c) }));
  const g1 = clone(S.geo1); g1.refN = traj.N0; g1.refE = traj.E0;
  const g2 = { azSec: S.geo2.azSec, horizons: clone(S.geo2.horizons).map(hz => { hz.pts.sort((p, q) => p[0] - q[0]); return hz; }),
    layers: S.geo2.layers.map(l => ({ rh: l.props.map(p => [p[0], p[1]]).sort((p, q) => p[0] - q[0]), rv: l.props.map(p => [p[0], p[2]]).sort((p, q) => p[0] - q[0]) })) };
  const eng2d = mode === '2d' ? (S.engine2d === 'local' ? 'local' : 'fd') : null;
  return { traj, tf: w.tf, mdStart, mdEnd: mdStop, mdStep, channels, mode, geo1: g1, geo2: g2, filter: S.filter, slopeWin: 5, eng2d, fd: eng2d === 'fd' ? { q: S.fd.q, step: S.fd.step } : null };
}
function chanSigRow(c) { return [c.L, c.f, antName(c.tx), antName(c.rx)].join('|'); }   // tool-table row (f in kHz)
function chanSig(c) { return [c.L, c.f, antName(c.tx), antName(c.rx)].join('|'); }
function enabledChannels(S) { return S.tool.channels.filter(c => c.on); }
function chanStyles(chs) {                           // colour by (spacing, frequency) pair, dash by configuration
  const pairs = [], cfgs = [], out = [];
  for (const c of chs) {
    const pk = c.L + '|' + c.f, ck = chanShort(c); let pi = pairs.indexOf(pk); if (pi < 0) { pairs.push(pk); pi = pairs.length - 1; }
    let ci = cfgs.indexOf(ck); if (ci < 0) { cfgs.push(ck); ci = cfgs.length - 1; }
    out.push({ color: 'var(' + SERIES_VARS[pi % 8] + ')', dash: DASHES[ci % 4], pair: pi, cfg: ci });
  }
  return out;
}
function cssColor(v) { const m = /var\((--[\w-]+)\)/.exec(v); return m ? css(m[1]) : v; }

// ---- geometry helpers for display ------------------------------------------------------------------------
function sectionAz(cfg, tr) {
  if (cfg.mode === '2d') return cfg.geo2.azSec * D2R;
  const n = tr.md.length - 1, dN = tr.N[n] - tr.N[0], dE = tr.E[n] - tr.E[0];
  if (Math.hypot(dN, dE) > 1) return Math.atan2(dE, dN);
  return cfg.geo1.dipAz * D2R;
}
function vsOf(cfg, az, N, E) { return cfg.mode === '2d' ? secX(cfg.geo2, N, E) : (N - cfg.traj.N0) * Math.cos(az) + (E - cfg.traj.E0) * Math.sin(az); }
function boundaryDepths(cfg, az, x, out) {           // depths of all boundaries along the section line at section coordinate x
  if (cfg.mode === '2d') return horizonZ(cfg.geo2, x, out);
  const loc = cfg._loc1 || (cfg._loc1 = buildLocal1D(cfg.geo1)), n = loc.nrm, N = cfg.traj.N0 + x * Math.cos(az), E = cfg.traj.E0 + x * Math.sin(az);
  out = out || new Float64Array(loc.zi.length);
  for (let k = 0; k < loc.zi.length; k++) out[k] = (loc.zi[k] - n[0] * N - n[1] * E) / n[2];
  return out;
}
function layerRh(cfg, k, x) { return cfg.mode === '2d' ? layerProps2D(cfg.geo2, k, x).rh : 1 / buildLocal1D(cfg.geo1).sh[k]; }
function layerRv(cfg, k, x) { return cfg.mode === '2d' ? layerProps2D(cfg.geo2, k, x).rv : 1 / buildLocal1D(cfg.geo1).sv[k]; }
function nLayersOf(cfg) { return cfg.mode === '2d' ? cfg.geo2.horizons.length + 1 : cfg.geo1.layers.length; }

function wellPoints(cfg, tr, az, maxPts) {
  const n = tr.md.length, step = Math.max(1, Math.floor(n / (maxPts || 600))), pts = [];
  for (let i = 0; i < n; i += step) pts.push([vsOf(cfg, az, tr.N[i], tr.E[i]), tr.D[i], tr.md[i]]);
  const l = n - 1; if ((l % step) !== 0) pts.push([vsOf(cfg, az, tr.N[l], tr.E[l]), tr.D[l], tr.md[l]]);
  return pts;
}
function resRange(cfg) {
  const nl = nLayersOf(cfg); let lo = Infinity, hi = -Infinity;
  if (cfg.mode === '2d') for (const l of cfg.geo2.layers) for (const p of l.rh) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
  else for (const l of cfg.geo1.layers) { lo = Math.min(lo, l.rh); hi = Math.max(hi, l.rh); }
  lo = Math.pow(10, Math.floor(Math.log10(lo) + 1e-9)); hi = Math.pow(10, Math.ceil(Math.log10(hi) - 1e-9)); if (hi <= lo) hi = lo * 10;
  return [lo, hi];
}
function buildSection(S, cfg, tr, withTool) {
  const az = sectionAz(cfg, tr), well = wellPoints(cfg, tr, az, 700), dark = isDark();
  let xa = Infinity, xb = -Infinity, za = Infinity, zb = -Infinity; for (const p of well) { xa = Math.min(xa, p[0]); xb = Math.max(xb, p[0]); za = Math.min(za, p[1]); zb = Math.max(zb, p[1]); }
  const padx = Math.max(15, (xb - xa) * 0.06); xa -= padx; xb += padx;
  const nl = nLayersOf(cfg), nh = nl - 1, nx = 140, [rlo, rhi] = resRange(cfg);
  const zh = []; for (let i = 0; i <= nx; i++) zh.push(Array.from(boundaryDepths(cfg, az, xa + (xb - xa) * i / nx, new Float64Array(nh))));
  // z window: well +- margin, widened so nearby boundaries stay visible
  let zl = za - 22, zu = zb + 22; if (zu - zl < 60) { const m = (zu + zl) / 2; zl = m - 30; zu = m + 30; }
  const slices = [], col = (rh) => rampColor((Math.log10(rh) - Math.log10(rlo)) / (Math.log10(rhi) - Math.log10(rlo)), dark);
  for (let i = 0; i < nx; i++) {
    const x0 = xa + (xb - xa) * i / nx, x1 = xa + (xb - xa) * (i + 1) / nx, xm = 0.5 * (x0 + x1);
    for (let k = 0; k < nl; k++) {
      const t0 = k === 0 ? zl - 50 : zh[i][k - 1], t1 = k === 0 ? zl - 50 : zh[i + 1][k - 1], b0 = k === nl - 1 ? zu + 50 : zh[i][k], b1 = k === nl - 1 ? zu + 50 : zh[i + 1][k];
      if (b0 - t0 <= 0 && b1 - t1 <= 0) continue;
      slices.push({ x0, x1, zt0: t0, zt1: t1, zb0: b0, zb1: b1, color: col(layerRh(cfg, k, xm)) });
    }
  }
  const lines = [];
  for (let k = 0; k < nh; k++) lines.push({ pts: zh.map((a, i) => [xa + (xb - xa) * i / nx, a[k]]), color: css('--ink-2'), w: 1, opacity: 0.8, name: 'Boundary ' + (k + 1) });
  const sec = { x0: xa, x1: xb, z0: zl, z1: zu, slices, lines, well, cbar: { min: rlo, max: rhi, color: (t) => rampColor(t, dark) }, az, cfg };
  sec.probe = (x, z) => {
    const d = boundaryDepths(cfg, az, x, new Float64Array(nh)); let k = 0; while (k < nh && z > d[k]) k++;
    return 'Layer ' + (k + 1) + '  Rh ' + fsig(layerRh(cfg, k, x), 3) + '  Rv ' + fsig(layerRv(cfg, k, x), 3) + ' Ω·m';
  };
  if (withTool) {
    const md = clamp(S.cursorMd, tr.md[0], trajEnd(tr)), st = makeStation(tr, md, cfg.tf), Lmax = Math.max(1, ...cfg.channels.map(c => Math.abs(c.L)));
    const P = (s) => [vsOf(cfg, az, st.r[0] + s * st.zt[0], st.r[1] + s * st.zt[1]), st.r[2] + s * st.zt[2]];
    sec.tool = { pts: [P(-Lmax / 2), P(Lmax / 2)], dots: [P(-Lmax / 2), P(0), P(Lmax / 2)] };
  }
  return sec;
}

// angle between tool axis and the bedding plane (signed; + : tool heads toward deeper layers)
function stationAngles(cfg, stations) {
  const out = new Float64Array(stations.length);
  let nrm1 = null; if (cfg.mode === '1d') nrm1 = buildLocal1D(cfg.geo1).nrm;
  stations.forEach((st, i) => {
    const nrm = nrm1 || buildLocal2D(cfg.geo2, st, cfg.slopeWin).nrm;
    out[i] = Math.asin(clamp(v3.dot(nrm, st.zt), -1, 1)) * R2D;
  });
  return out;
}

// ---- inversion model template ----------------------------------------------------------------------------
function mkParam(v, lo, hi, free) { return { v, lo, hi, free: !!free }; }
function defaultSpec(S, cfg, nL) {
  // starting model derived from the true geology at the first station, perturbed by the user's initial error factors
  const pr = S.inv.perturb, hasTruth = nL === nLayersOf(cfg);
  const layers = [], t = [];
  const tr = buildTrajectory(cfg.traj, 1), st = makeStation(tr, cfg.mdStart, cfg.tf), tt = truthAt(cfg, st);
  for (let k = 0; k < nL; k++) {
    let rh, kv; if (hasTruth) { const f = Math.pow(Math.max(1.0001, pr.rho), k % 2 === 0 ? 1 : -1); rh = tt.rh[k] * f; kv = Math.max(1, tt.rv[k] / tt.rh[k]); } else { rh = Math.pow(10, 0.5 + 1.5 * (k % 2 === 0 ? 0 : 1)); kv = 1.3; }
    layers.push({ rh: mkParam(+rh.toPrecision(3), 0.1, 3000, true), kv: mkParam(+kv.toPrecision(3), 1, 8, S.inv.anisoFree) });
  }
  let d1 = hasTruth ? tt.zi[0] + pr.d : -5; d1 = +d1.toFixed(2);
  for (let k = 0; k < nL - 2; k++) t.push(mkParam(hasTruth ? +Math.max(1, (tt.zi[k + 1] - tt.zi[k]) * 0.8).toFixed(2) : 6, 0.3, 80, true));
  return { layers, d1: mkParam(d1, -60, 60, true), t };
}
function icfgFromState(S, cfg) {
  const iv = S.inv, sel = []; cfg.channels.forEach((c, i) => { if (iv.off.indexOf(c.sig) < 0) sel.push(i); });
  const spec = clone(iv.spec);
  return { spec, channels: sel, assumed: iv.assumedSame ? { ampDb: iv.noise.ampDb, phaseDeg: iv.noise.phaseDeg, floorPpm: iv.noise.floorPpm } : clone(iv.assumed), nStarts: iv.nStarts, maxIter: iv.maxIter, filter: iv.filter,
    dipErr: iv.dipErr, dipAzErr: iv.dipAzErr, continuation: iv.continuation, startSpread: { lnRho: 1.2, d: 6 }, seed: iv.noise.seed * 7 + 3, acceptChi2: iv.acceptChi2, screen: 60, refinePasses: 2 };
}
