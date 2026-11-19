// ===================================================================================
// main.js -- application shell: tabs, mode switch, persistence, job control, status
// ===================================================================================
const TABS = [
  { id: 'tool', label: 'Tool', view: ToolView },
  { id: 'geo', label: 'Geology & well', view: GeoView },
  { id: 'fwd', label: 'Forward', view: FwdView },
  { id: 'inv', label: 'Inversion', view: InvView },
];
const STORE_KEY = 'udar-bench-v1', AUTO_LIMIT = 4000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function mergeDefaults(d, s) {
  if (d === null || d === undefined) return s === undefined ? d : s;
  if (s === undefined || s === null) return d;
  if (isObj(d)) { if (!isObj(s)) return d; if (Object.keys(d).length === 0) return s; const o = {}; for (const k of Object.keys(d)) o[k] = k in s ? mergeDefaults(d[k], s[k]) : d[k]; return o; }
  if (Array.isArray(d)) return Array.isArray(s) ? s : d;
  return typeof s === typeof d ? s : d;
}
function specFreeCount(spec) { return spec.layers.reduce((a, l) => a + (l.rh.free ? 1 : 0) + (l.kv.free ? 1 : 0), 0) + (spec.d1.free ? 1 : 0) + spec.t.reduce((a, p) => a + (p.free ? 1 : 0), 0); }
function disposeView(v) {
  if (v.dispose) { v.dispose(); return; }
  const kill = (o) => { if (o instanceof LineChart || o instanceof SectionChart) o.destroy(); };
  for (const k of Object.keys(v)) { const o = v[k]; kill(o); if (k === 'charts' && o && typeof o === 'object') for (const c of Object.values(o)) kill(c); }
}

function themeIcon(t) {
  const a = { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' };
  if (t === 'dark') return h('s:svg', a, h('s:path', { d: 'M12.6 9.8A5.2 5.2 0 1 1 6.2 3.4a4.2 4.2 0 0 0 6.4 6.4z', fill: 'currentColor' }));
  if (t === 'light') return h('s:svg', a, h('s:circle', { cx: 8, cy: 8, r: 3, fill: 'currentColor' }), h('s:path', { d: 'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', fill: 'none' }));
  return h('s:svg', a, h('s:circle', { cx: 8, cy: 8, r: 5.4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }), h('s:path', { d: 'M8 2.6a5.4 5.4 0 0 0 0 10.8z', fill: 'currentColor' }));
}

const App = {
  S: null, pool: null, fwd: null, obs: null, inv: null, busy: null, runToken: 0, panes: {}, _cfg: null,
  init(coreSrc) {
    this.S = this.load(); this.pool = new Pool(coreSrc);
    this.persist = debounce(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(this.S)); } catch (e) { /* storage may be unavailable */ } }, 500);
    this.buildShell(); this.applyTheme();
    try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (this.S.theme === 'auto') this.redrawAll(); }); } catch (e) { /* ignore */ }
    this.setTab(TABS.some(t => t.id === this.S.tab) ? this.S.tab : 'tool');
  },
  load() {
    const def = defaultState();
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) { const s = JSON.parse(raw); if (s && s.v === def.v) { const m = mergeDefaults(def, s); cfgFromState(m); buildTrajectory(cfgFromState(m).traj, 5); return m; } }
    } catch (e) { /* fall back to defaults */ }
    return def;
  },
  // ---- derived configuration (cached until the next edit) ----
  getCfg() { if (!this._cfg) { const cfg = cfgFromState(this.S); this._cfg = { cfg, key: JSON.stringify(cfg), tr: null }; } return this._cfg; },
  getTraj() { const c = this.getCfg(); if (!c.tr) c.tr = buildTrajectory(c.cfg.traj, 0.5); return { cfg: c.cfg, tr: c.tr, key: c.key }; },
  validate(cfg) {
    if (!cfg.channels.length) return 'Turn on at least one channel in the Tool tab.';
    for (const c of cfg.channels) if (!(Math.abs(c.L) > 0) || !(c.f > 0) || !isFinite(c.L) || !isFinite(c.f)) return 'Every channel needs a non-zero spacing and a positive frequency.';
    if (!(cfg.mdEnd >= cfg.mdStart)) return 'The logging interval is empty. Check the From and To depths.';
    if (stationCount(cfg) > 3000) return 'The logging interval has ' + stationCount(cfg) + ' stations. Increase the step to keep it below 3000.';
    for (const s of cfg.traj.sections) if (!isFinite(s.len) || !isFinite(s.incEnd) || !isFinite(s.azEnd)) return 'A wellbore section has a missing value.';
    if (cfg.mode === '1d') {
      const L = cfg.geo1.layers; if (!L.length) return 'Add at least one layer.';
      for (const l of L) if (!(l.rh > 0) || !(l.rv > 0)) return 'Resistivities must be positive.';
      for (let k = 1; k < L.length - 1; k++) if (!(L[k].tvt > 0)) return 'Interior layers need a positive thickness.';
    } else {
      const g = cfg.geo2; if (g.layers.length !== g.horizons.length + 1) return 'The number of layers must be one more than the number of boundaries.';
      for (const l of g.layers) for (const p of l.rh.concat(l.rv)) if (!(p[1] > 0)) return 'Resistivities must be positive.';
      for (const hz of g.horizons) if (!hz.pts.length) return 'Every boundary needs at least one point.';
      if (cfg.eng2d === 'fd') {
        if (!(cfg.fd.step >= 2)) return 'Set the solver station spacing to at least 2 m.';
        if (FDORCH.maxOutOfPlane(cfg, buildTrajectory(cfg.traj, 2)) > 0.02) return 'The 2.5D solver needs the well to stay in the section plane. Keep every azimuth at the section azimuth or its opposite and do not turn between them within a section.';
      }
    }
    return null;
  },
  // ---- change notification ----
  changed() {
    this._cfg = null; this.persist(); clearTimeout(this._t);
    this._t = setTimeout(() => this.afterChange(), 120);
  },
  afterChange() {
    const v = TABS.find(t => t.id === this.S.tab).view; if (this.panes[this.S.tab].built && v.update) v.update();
    FwdView.status(); InvView.status();
    if (this.refreshObs() && InvView.built) InvView.drawFit();
    this.maybeAutoRun();
  },
  setCursor(md) {
    this.S.cursorMd = md; this.persist();
    for (const t of TABS) if (this.panes[t.id].built && t.view.cursor) t.view.cursor();
  },
  estimateCost() { const { cfg } = this.getCfg(); return stationCount(cfg) * new Set(cfg.channels.map(c => c.L + '|' + c.f)).size; },
  maybeAutoRun() {
    const S = this.S; clearTimeout(this._auto);
    if (!S.auto || this.busy || (S.tab !== 'fwd' && S.tab !== 'inv') || this.getCfg().cfg.eng2d === 'fd') return;
    if (this.fwdStatus() === 'ok' || this.validate(this.getCfg().cfg) || this.estimateCost() > AUTO_LIMIT) return;
    this._auto = setTimeout(() => { if (!this.busy && this.fwdStatus() !== 'ok') this.runForward(true); }, 300);
  },
  fwdStatus() { if (this.busy === 'fwd') return 'busy'; if (!this.fwd) return 'none'; return this.fwd.key === this.getCfg().key ? 'ok' : 'stale'; },
  invStatus() { if (this.busy === 'inv') return 'busy'; if (!this.inv) return 'none'; return this.inv.key === this.invKeyNow() ? 'ok' : 'stale'; },
  invKeyNow() { const c = this.getCfg(); const spec = this.ensureSpec(); return JSON.stringify([c.key, this.S.inv.noise, spec ? icfgFromState(this.S, c.cfg) : null]); },
  ensureSpec() {
    const iv = this.S.inv, { cfg, key } = this.getCfg(), nL = iv.nLayers;
    const bad = !iv.spec || iv.spec.layers.length !== nL || iv.spec.t.length !== nL - 2;
    if (bad) iv.specAuto = true;
    if (iv.specAuto) {
      const k = JSON.stringify([key, iv.perturb, iv.anisoFree, nL]);
      if (bad || iv.specKey !== k) { try { iv.spec = defaultSpec(this.S, cfg, nL); iv.specKey = k; } catch (e) { /* keep the previous spec */ } }
    }
    return iv.spec;
  },
  refreshObs() {
    const f = this.fwd; if (!f) { this.obs = null; return false; }
    const key = f.key + '|' + JSON.stringify(this.S.inv.noise); if (this.obs && this.obs.key === key) return false;
    this.obs = { key, data: addNoise(f.data, f.nSt, f.nch, this.S.inv.noise) }; return true;
  },
  // ---- jobs ----
  async runForward(auto) {
    if (this.busy) return; const c = this.getCfg(), cfg = c.cfg, err = this.validate(cfg);
    if (err) { if (!auto) this.toast(err, 'bad'); return; }
    const token = ++this.runToken; this.busy = 'fwd'; FwdView.status(); InvView.status();
    const tr = buildTrajectory(cfg.traj, 0.5), st = stationList(cfg, tr), nSt = st.length, nch = cfg.channels.length, t0 = performance.now();
    const nChunk = Math.min(nSt, Math.max(1, this.pool.n * 3)), size = Math.ceil(nSt / nChunk), payloads = [];
    for (let i0 = 0; i0 < nSt; i0 += size) payloads.push({ cfg, i0, i1: Math.min(nSt, i0 + size) });
    try {
      const res = await this.pool.run('fwd', payloads, (f) => { if (token === this.runToken) FwdView.setProgress(f, t0); });
      if (token !== this.runToken) return;
      const data = new Float64Array(nSt * nch * 2); let o = 0; for (const r of res) { data.set(r.out, o); o += r.out.length; }
      let out = data, fd = null;
      if (cfg.eng2d === 'fd') {
        FwdView.setFDProgress(null, t0);
        fd = await runFD2D(this, cfg, st, data, token, (p) => FwdView.setFDProgress(p, t0));
        if (token !== this.runToken) return;
        out = fd.data;
      }
      this.fwd = { key: c.key, cfg, tr, st, data: out, base: fd ? data : null, fd, nSt, nch, ms: performance.now() - t0, arr: null, barr: null };
      this.refreshObs();
    } catch (e) { if (e && e.message !== 'cancelled' && token === this.runToken) this.toast('Forward model failed: ' + String(e.message || e).split('\n')[0], 'bad'); }
    finally { if (token === this.runToken) { this.busy = null; this.emit(); this.afterRun(); } }
  },
  afterRun() { this.maybeAutoRun(); },
  async runInversion() {
    if (this.busy) return;
    const c0 = this.getCfg(), err = this.validate(c0.cfg); if (err) { this.toast(err, 'bad'); return; }
    if (this.fwdStatus() !== 'ok') { await this.runForward(); if (this.fwdStatus() !== 'ok') return; }
    const f = this.fwd, S = this.S; this.refreshObs(); this.ensureSpec();
    const icfg = icfgFromState(S, f.cfg);
    if (!icfg.channels.length) { this.toast('Select at least one channel for the inversion.', 'bad'); return; }
    const nFree = specFreeCount(icfg.spec);
    if (!nFree) { this.toast('No parameter is free. Tick Free for at least one parameter.', 'bad'); return; }
    const token = ++this.runToken; this.busy = 'inv'; FwdView.status(); InvView.status(); const t0 = performance.now();
    const obs = this.obs.data, nSt = f.nSt, size = Math.max(12, Math.ceil(nSt / (this.pool.n * 3))), payloads = [];
    for (let i0 = 0; i0 < nSt; i0 += size) payloads.push({ cfg: f.cfg, icfg, obs, i0, i1: Math.min(nSt, i0 + size) });
    try {
      const out = await this.pool.run('inv', payloads, (p) => { if (token === this.runToken) InvView.setProgress(p, t0); });
      if (token !== this.runToken) return;
      const res = []; for (const o of out) for (const r of o.res) res.push(r); res.sort((a, b) => a.i - b.i);
      this.inv = { key: JSON.stringify([f.key, S.inv.noise, icfg]), cfg: f.cfg, st: f.st, tr: f.tr, obs: Float64Array.from(obs), clean: f.data, nch: f.nch, res, icfg, ms: performance.now() - t0, truth: null };
    } catch (e) { if (e && e.message !== 'cancelled' && token === this.runToken) this.toast('Inversion failed: ' + String(e.message || e).split('\n')[0], 'bad'); }
    finally { if (token === this.runToken) { this.busy = null; this.emit(); } }
  },
  cancel() { this.runToken++; this.pool.cancel(); const was = this.busy; this.busy = null; this.emit(); if (was) this.toast('Cancelled.'); },
  emit() { for (const v of [FwdView, InvView]) if (v.built) { v.show(); v.status(); } },
  redrawAll() { for (const t of TABS) if (this.panes[t.id].built) { if (t.view.show) t.view.show(); if (t.view.update) t.view.update(); } },
  toast(msg, kind) {
    clearTimeout(this._tt); if (this.toastEl) this.toastEl.remove();
    this.toastEl = h('div', { class: 'toast ' + (kind || ''), role: 'status' }, msg); document.body.append(this.toastEl);
    this._tt = setTimeout(() => { if (this.toastEl) this.toastEl.remove(); }, 5000);
  },
  // ---- shell ----
  buildShell() {
    const logo = h('s:svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
      h('s:circle', { cx: 5.5, cy: 12, r: 2.4, fill: 'var(--accent)', stroke: 'none' }), h('s:circle', { cx: 18.5, cy: 12, r: 2.4 }), h('s:path', { d: 'M8.6 12h7' }), h('s:path', { d: 'M9 6.4c2.1-2 4.4-2 6.5 0' }), h('s:path', { d: 'M9 17.6c2.1 2 4.4 2 6.5 0' }));
    this.tabBtns = {};
    const tabs = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Workflow' }, TABS.map(t => {
      const b = h('button', { type: 'button', class: 'tab', role: 'tab', id: 'tab-' + t.id, 'aria-selected': 'false', tabindex: '-1', onclick: () => this.setTab(t.id) }, t.label); this.tabBtns[t.id] = b; return b;
    }));
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; const i = TABS.findIndex(t => t.id === this.S.tab), j = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      this.setTab(TABS[j].id); this.tabBtns[TABS[j].id].focus(); e.preventDefault();
    });
    this.modeBtns = {};
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Forward model dimensionality' }, [['1d', '1D'], ['2d', '2D']].map(m => {
      const b = h('button', { type: 'button', 'aria-pressed': 'false', title: m[0] === '1d' ? 'Planar layers with a constant dip (exact layered-earth solution)' : 'Laterally varying section (2.5D finite-difference solver or local-1D approximation)', onclick: () => this.setMode(m[0]) }, m[1]); this.modeBtns[m[0]] = b; return b;
    }));
    this.themeBtn = h('button', { type: 'button', class: 'icon-btn', onclick: () => { const o = ['auto', 'light', 'dark']; this.S.theme = o[(o.indexOf(this.S.theme) + 1) % 3]; this.applyTheme(); this.persist(); this.redrawAll(); } });
    const top = h('header', { class: 'top' }, h('div', { class: 'brand' }, logo, 'UDAR Bench'), tabs,
      h('div', { class: 'top-r' }, h('span', { class: 'lbl' }, 'Forward model'), seg, this.themeBtn,
        h('button', { type: 'button', class: 'icon-btn', title: 'Reset all settings', 'aria-label': 'Reset all settings', onclick: () => this.confirmReset() }, '↺'),
        h('button', { type: 'button', class: 'icon-btn', title: 'About this model', 'aria-label': 'About this model', onclick: () => this.showAbout() }, '?')));
    const work = h('div', { class: 'work' });
    for (const t of TABS) { const side = h('aside', { class: 'side', hidden: true }), main = h('div', { class: 'main', hidden: true }); this.panes[t.id] = { side, main, built: false }; work.append(side, main); }
    document.body.replaceChildren(h('div', { class: 'app' }, top, work));
    this.updateModeBtns();
  },
  updateModeBtns() { for (const m of ['1d', '2d']) this.modeBtns[m].setAttribute('aria-pressed', String(this.S.mode === m)); },
  applyTheme() {
    const t = this.S.theme; if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    const label = { auto: 'Theme: follow system', light: 'Theme: light', dark: 'Theme: dark' }[t]; this.themeBtn.title = label; this.themeBtn.setAttribute('aria-label', label); this.themeBtn.replaceChildren(themeIcon(t));
  },
  setTab(id) {
    const S = this.S; S.tab = id;
    for (const t of TABS) { const on = t.id === id, b = this.tabBtns[t.id]; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; this.panes[t.id].side.hidden = !on; this.panes[t.id].main.hidden = !on; }
    const t = TABS.find(x => x.id === id), p = this.panes[id];
    if (!p.built) this.buildPane(id); else { if (t.view.update) t.view.update(); if (t.view.cursor) t.view.cursor(); }
    this.persist(); this.maybeAutoRun();
  },
  buildPane(id) {
    const t = TABS.find(x => x.id === id), p = this.panes[id]; p.side.replaceChildren(); p.main.replaceChildren();
    try { t.view.build(p.side, p.main); p.built = true; }
    catch (e) { p.main.append(h('div', { class: 'note warn' }, 'This tab failed to build: ' + String(e && e.message || e))); console.error(e); }
  },
  rebuild() {
    for (const t of TABS) { const p = this.panes[t.id]; if (p.built) { disposeView(t.view); p.built = false; } }
    this._cfg = null; this.buildPane(this.S.tab);
  },
  setMode(m) {
    if (this.S.mode === m) return; this.S.mode = m; this.updateModeBtns(); this.rebuild(); this.changed();
  },
  confirmReset() {
    const close = () => back.remove();
    const back = h('div', { class: 'dialog-back', onclick: (e) => { if (e.target === back) close(); } }, h('div', { class: 'dialog', role: 'dialog', 'aria-label': 'Reset all settings', style: { width: 'min(420px, 92vw)' } },
      h('h3', null, 'Reset all settings?'), h('div', { class: 'hint' }, 'The tool, well, geology and inversion settings return to their defaults, and the computed results are cleared.'),
      h('div', { class: 'row' }, btn('Reset', () => { close(); this.reset(); }, 'primary'), btn('Keep my settings', close))));
    document.body.append(back);
  },
  reset() {
    this.cancel(); this.S = defaultState(); this.fwd = this.obs = this.inv = null; this._cfg = null; try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    this.updateModeBtns(); this.applyTheme(); this.rebuild(); this.setTab('tool');
  },
  showAbout() {
    const close = () => back.remove();
    const li = (...t) => h('li', null, ...t);
    const body = h('div', { class: 'about scroll' },
      h('p', null, 'UDAR Bench generates synthetic ultra-deep azimuthal resistivity (UDAR) logs for a tool and a well that you define, and inverts them station by station with a layered 1D model.'),
      h('h4', null, 'Forward model'),
      h('ul', null,
        li('Transmitters and receivers are point magnetic dipoles on a rigid, straight tool whose axis follows the well. Each channel couples one transmitter axis to one receiver axis at one spacing and one frequency.'),
        li('Couplings are normalised by the free-space coaxial coupling at the same spacing, so a ZZ coupling in a vacuum is 1 (0 dB, 0°). The convention is e^(−iωt); z points down.'),
        li('Layers are transversely isotropic (horizontal resistivity Rh along bedding, vertical resistivity Rv across it), planar, and non-magnetic. The solution is quasi-static: displacement currents are ignored.'),
        li('The borehole, tool mandrel and tool body are not modelled. The signals are those of an idealised dipole tool in the formation.'),
        li('1D mode is a semi-analytic layered-earth solution (generalised reflection coefficients and a digital Hankel transform with Key 2012 filters) for planar layers with one constant dip. It was checked against the empymod package.'),
        li('Toolface is measured from the high side of the hole, increasing clockwise when looking down-hole.')),
      h('h4', null, '2D mode'),
      h('ul', null,
        li('The geology is a vertical section: boundaries are polylines and Rh, Rv vary along the section. It does not change perpendicular to the section, and the well must lie in the section plane, so azimuths snap to the section azimuth or its opposite.'),
        li('The 2.5D finite-difference solver gives the full response of that section. Every station first gets the exact layered-earth response of a local-1D model (the boundaries below the tool, with the dip of the nearest boundary). The solver then computes what that local model leaves out, faults, pinch-outs, lateral resistivity changes and boundary curvature, as the difference between two finite-difference solutions, one for the true section and one for the local model, on the same grid.'),
        li('The solver works in the frequency domain with a Fourier transform along strike, a staggered grid in the section that is refined around the tool and stretched outward, edge-based (laminate) averaging of the conductivity across boundaries, and a sparse direct solver. Taking the difference of two solutions on the same grid cancels most of the discretisation error close to the antennas.'),
        li('The correction is solved at selected stations, every 25 m by default, at both sides of every jump of the local model, and where it changes quickly. It is interpolated along the well in between. Stations with no 2D feature within reach are skipped.'),
        li('Accuracy at the Standard setting was checked against exact solutions for a vertical resistivity contrast in 23 cases: 5 to 40 m spacings, 1 to 100 kHz, 2 to 50 Ω·m on the tool side against 0.2 to 1000 Ω·m across the contrast, 1 to 20 m away or straddled by the antennas, with the tool parallel, oblique or perpendicular to it. The error of the correction was 0.2–2.5% of its peak value. Along the well the correction scatters by about 0.001 of the free-space coupling from station to station. Compared with solving every station, interpolation between solver stations added at most 0.004 next to a 6 m fault and 0.0002 across a lateral resistivity change. For small corrections, such as a dip that changes by a few degrees, the error is about 0.001 of the free-space coupling, roughly 0.01 dB. That can still be 10–20% of a small correction. Accuracy drops when a 2D feature is within a few grid cells of the antennas; the 2.5D solver table flags these stations.'),
        li('The local-1D approximation computes only the first step. It is instant but leaves out everything listed above, and it is least reliable close to faults, pinch-outs and lateral contrasts.')),
      h('h4', null, 'Inversion'),
      h('ul', null,
        li('Each station is inverted independently with a bounded Levenberg–Marquardt solver. The unknowns are Rh and Rv/Rh of each layer, the distance to the first boundary and the thickness of interior layers, measured along the bedding normal. The dip is taken as given, plus any error you add.'),
        li('Residuals are weighted by the noise you assume. The ±1σ values come from the linearised (Gauss–Newton) covariance at the solution. They are not a full posterior.'),
        li('The synthetic data and the inversion share the same forward engine, so the test is optimistic compared with field data (an inverse crime). By default the inversion uses a coarser Hankel filter than the forward model to soften this, but it does not remove it.')),
      h('h4', null, 'Data and storage'),
      h('ul', null, li('Everything runs in your browser. Settings are saved in this browser only when it allows local storage.')));
    const back = h('div', { class: 'dialog-back', onclick: (e) => { if (e.target === back) close(); } }, h('div', { class: 'dialog', role: 'dialog', 'aria-label': 'About this model' }, h('div', { class: 'row sp' }, h('h3', null, 'About UDAR Bench'), btn('Close', close, 'small')), body));
    document.body.append(back);
  },
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const d = document.querySelector('.dialog-back'); if (d) d.remove(); } });
App.init(document.getElementById('core-src').textContent);
