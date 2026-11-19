// ===================================================================================
// fdrun.js -- main-thread driver of a 2.5D forward run:
//   local-1D data (exact, every station) + finite-difference correction solved at selected stations in the workers,
//   refined where it changes quickly, interpolated along the well in between.
// ===================================================================================
function fdPlanPreview(cfg, st) {
  const opt = FDORCH.options(cfg), an = FDORCH.analyse(cfg, st), grp = FDORCH.groups(cfg), idx = FDORCH.initial(cfg, st, an, opt);
  return { opt, an, grp, idx, nFreq: grp.byF.length, jobs: idx.length * grp.byF.length };
}
// rough single-thread seconds for the first pass (stations far from any 2D feature are skipped in well under a second)
function fdWorkers(app, opt) { return Math.min(app.pool.n, opt.q === 'fine' ? 4 : 6); }
function fdEstimate(pre, nWorkers) {
  const s = pre.jobs * pre.opt.secs, w = Math.max(1, nWorkers);
  return { lo: 0.35 * s / w, hi: 1.5 * s / w };
}
async function runFD2D(app, cfg, st, base, token, onProgress) {
  const pre = fdPlanPreview(cfg, st), { opt, an, grp } = pre, nP = grp.pairs.length, nF = grp.byF.length;
  if (pre.idx.length > opt.maxStations) throw new Error('The 2.5D run would need ' + pre.idx.length + ' solver stations. Increase the solver station spacing or the logging step.');
  let fdIdx = pre.idx.slice(); const vec = new Map(), infos = [], t0 = performance.now();
  let doneJobs = 0, totalJobs = 0;
  for (let round = 0; round <= opt.rounds; round++) {
    const todo = fdIdx.filter((i) => !vec.has(i)); if (!todo.length) break;
    const payloads = []; for (const i of todo) for (const g of grp.byF) payloads.push({ cfg, md: st[i].md, f: g.f, Ls: g.Ls, opt: opt.fd });
    totalJobs += payloads.length;
    // each solve holds a sparse factorization of 50-300 MB, so the number of parallel solves is capped
    const res = await app.pool.run('fdst', payloads, (fr) => { if (token === app.runToken) onProgress({ round, done: doneJobs + fr * payloads.length, total: totalJobs, t0 }); }, fdWorkers(app, opt));
    if (token !== app.runToken) throw new Error('cancelled');
    doneJobs += payloads.length;
    for (const i of todo) vec.set(i, new Float64Array(nP * 10));
    res.forEach((r, q) => {
      const i = todo[Math.floor(q / nF)], g = grp.byF[q % nF];
      let dmax = 0; if (!r.skip) for (let k = 0; k < r.delta.length; k += 2) dmax = Math.max(dmax, Math.hypot(r.delta[k], r.delta[k + 1]));
      infos.push({ i, md: st[i].md, f: g.f, round, skip: r.skip, info: r.info || null, secs: r.secs, dmax });
      if (!r.skip) { const v = vec.get(i); g.pidx.forEach((p, m) => { for (let k = 0; k < 10; k++) v[p * 10 + k] = r.delta[m * 10 + k]; }); }
    });
    if (round === opt.rounds) break;
    const add = FDORCH.refine(cfg, st, an, Array.from(vec.keys()), vec, opt).filter((i) => !vec.has(i));
    if (!add.length || vec.size + add.length > opt.maxStations) break;
    fdIdx = Array.from(new Set(fdIdx.concat(add))).sort((a, b) => a - b);
  }
  const asm = FDORCH.assemble(cfg, st, an, base, vec, grp);
  infos.sort((a, b) => a.md - b.md || b.f - a.f);
  return { data: asm.data, idx: Array.from(vec.keys()).sort((a, b) => a - b), infos, summary: FDORCH.summarize(infos, vec.size, nF), breaks: an.segs.length - 1, ms: performance.now() - t0, q: opt.q };
}
