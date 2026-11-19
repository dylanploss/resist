// ===================================================================================
// jobs.js -- job handlers shared by the Web Worker and the main-thread fallback
// ===================================================================================
const _cache = { key: null, tr: null, st: null };
function _traj(cfg) {
  const key = JSON.stringify([cfg.traj, cfg.tf, cfg.mdStart, cfg.mdEnd, cfg.mdStep]);
  if (_cache.key !== key) { _cache.key = key; _cache.tr = buildTrajectory(cfg.traj, 0.5); _cache.st = stationList(cfg, _cache.tr); }
  return _cache;
}
const JOBS = {
  fwd(p, progress) {
    const { cfg, i0, i1 } = p, c = _traj(cfg), out = new Float64Array((i1 - i0) * cfg.channels.length * 2);
    forwardRange(cfg, c.tr, c.st, i0, i1, out);
    return { out };
  },
  fdst(p, progress) {                      // one 2.5D solve: difference tensors of all spacings at one frequency and one station
    const { cfg, md, f, Ls, opt } = p, c = _traj(cfg), t0 = Date.now();
    const st = makeStation(c.tr, md, cfg.tf), loc = buildLocal2D(cfg.geo2, st, cfg.slopeWin), sa = FDORCH.stationAxis(cfg, st);
    if (Math.abs(sa.off) > 0.02) throw new Error('The 2.5D solver needs the well to stay in the section plane.');
    const nrm = Math.hypot(sa.ax[0], sa.ax[1]), ax = [sa.ax[0] / nrm, sa.ax[1] / nrm], mid = [secX(cfg.geo2, st.r[0], st.r[1]), st.r[2]];
    const plan = FD.planGroup(cfg.geo2, loc, mid, ax, Ls.map((L) => ({ L, f })), opt);
    if (plan.skip) return { md, f, skip: true, secs: (Date.now() - t0) / 1000 };
    const r = FD.runGroup(plan, progress), delta = r.delta;
    for (let q = 0; q < Ls.length; q++) { const sc = 2 * Math.PI * Math.abs(Ls[q]) ** 3; for (let k = 0; k < 10; k++) delta[q * 10 + k] *= sc; }
    return { md, f, skip: false, delta, info: r.info, secs: (Date.now() - t0) / 1000 };
  },
  inv(p, progress) {
    const { cfg, icfg, obs, i0, i1 } = p, c = _traj(cfg), res = [];
    invertRange(cfg, icfg, c.tr, c.st, obs, i0, i1, res, progress);
    return { res };
  },
};
function handleJob(type, payload, progress) { if (!JOBS[type]) throw new Error('unknown job ' + type); return JOBS[type](payload, progress); }

// worker glue (only active inside a Worker)
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (e) => {
    const { id, type, payload } = e.data;
    try {
      const r = handleJob(type, payload, (a, b) => self.postMessage({ id, progress: [a, b] }));
      const tr = []; if (r.out) tr.push(r.out.buffer);
      self.postMessage({ id, result: r }, tr);
    } catch (err) { self.postMessage({ id, error: String(err && err.stack || err) }); }
  };
}
