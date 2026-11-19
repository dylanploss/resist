// ===================================================================================
// views_b.js -- Forward tab and Inversion tab
// ===================================================================================
const DB_FLOOR = 1e-9, PH_MIN_AMP = 1e-7;
const ampdb = (re, im) => 20 * Math.log10(Math.max(Math.hypot(re, im), DB_FLOOR));
function unwrapDeg(a) {
  let last = null;
  for (let i = 0; i < a.length; i++) { if (!isFinite(a[i])) continue; if (last !== null) a[i] -= 360 * Math.round((a[i] - last) / 360); last = a[i]; }
  return a;
}
// per-channel series from an interleaved (station, channel, re/im) array
function chanArrays(data, nSt, nch, c) {
  const re = new Float64Array(nSt), im = new Float64Array(nSt), amp = new Float64Array(nSt), ph = new Float64Array(nSt);
  for (let i = 0; i < nSt; i++) {
    const k = 2 * (i * nch + c); re[i] = data[k]; im[i] = data[k + 1];
    const a = Math.hypot(re[i], im[i]); amp[i] = ampdb(re[i], im[i]); ph[i] = a > PH_MIN_AMP ? Math.atan2(im[i], re[i]) * R2D : NaN;
  }
  unwrapDeg(ph); let f; for (let i = 0; i < nSt; i++) if (isFinite(ph[i])) { f = ph[i]; break; }
  if (f !== undefined) { const sh = 360 * Math.round(f / 360); if (sh) for (let i = 0; i < nSt; i++) ph[i] -= sh; }
  return { re, im, amp, ph };
}
const pairKey = (c) => fsig(c.L, 3) + ' m, ' + fsig(c.f / 1000, 3) + ' kHz';
function progressBar() { const i = h('i'); const el = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, i); el.set = (f) => { i.style.width = (100 * clamp(f, 0, 1)).toFixed(1) + '%'; el.setAttribute('aria-valuenow', Math.round(100 * clamp(f, 0, 1))); }; return el; }
function statusPill(kind) {
  const m = { none: ['Not run yet', ''], ok: ['Up to date', 'good'], stale: ['Out of date', 'warn'], busy: ['Running', ''] }[kind] || ['', ''];
  return h('span', { class: 'pill ' + m[1] }, m[0]);
}
function ampYlim(series) {                      // amplitude axis: avoid a few floor values stretching the axis
  let mx = -Infinity, mn = Infinity; for (const s of series) for (const v of s.y) if (isFinite(v)) { if (v > mx) mx = v; if (v < mn) mn = v; }
  if (!isFinite(mx)) return null; const lo = Math.max(mn, mx - 110); const pad = Math.max(1, (mx - lo) * 0.05); return [lo - pad, mx + pad];
}
function stIndex(cfg, nSt, md) { return clamp(Math.round((md - cfg.mdStart) / cfg.mdStep), 0, nSt - 1); }
function dataTable(heads, rows) {
  return h('div', { class: 'scroll-y' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, heads.map(x => h('th', null, x)))), h('tbody', null, rows.map(r => h('tr', null, r.map((c, i) => h('td', null, c)))))));
}

// ---------------------------------------------------------------------------------------------------------------
const FwdView = {
  charts: [], built: false,
  build(side, main) {
    const S = App.S;
    this.pillHost = h('span'); this.info = h('div', { class: 'hint' }); this.prog = progressBar();
    this.runBtn = btn('Run forward model', () => App.runForward(), 'primary'); this.cancelBtn = btn('Cancel', () => App.cancel()); this.cancelBtn.hidden = true;
    this.pairHost = h('div', { class: 'chips' });
    side.append(
      card('Forward model', [
        h('div', { class: 'row sp' }, h('span', { class: 'lbl' }, 'Status'), this.pillHost), this.info,
        h('div', { class: 'row' }, this.runBtn, this.cancelBtn), this.prog,
        chk(S.mode === '2d' && S.engine2d !== 'local' ? 'Update after an edit when the job is small (not for 2.5D runs)' : 'Update after an edit when the job is small', S, 'auto', { onchange: () => { App.persist(); App.maybeAutoRun(); } }),
      ]),
      S.mode === '2d' ? this.solverCard(S) : null,
      card('Display', [
        sel('Quantity', S, 'chartQty', [['ap', 'Amplitude (dB) and phase (°)'], ['ri', 'Real and imaginary (free-space ZZ = 1)']], { onchange: () => { App.persist(); this.show(); } }),
        S.mode === '2d' && S.engine2d !== 'local' ? chk('Show the local-1D logs (dashed) for comparison', S, 'cmpLocal', { onchange: () => { App.persist(); this.show(); } }) : null,
        h('div', null, h('div', { class: 'lbl', style: { marginBottom: '4px' } }, 'Spacing and frequency pairs'), this.pairHost),
        h('div', { class: 'hint' }, 'Amplitude is 20·log10 of the coupling relative to the free-space ZZ coupling at the same spacing. Phase is the argument of that complex ratio (e^(−iωt) convention), unwrapped along the well.'),
      ]),
      card('Export', [
        h('div', { class: 'row' }, btn('Data as CSV', () => this.exportCSV()), btn('Data as JSON', () => this.exportJSON())),
        h('div', { class: 'hint' }, 'Noise-free data at every station and channel.'),
      ], { collapsible: true }),
    );
    this.secHost = h('div'); this.chartsHost = h('div', { class: 'stackcharts' }); this.tblHost = h('div');
    this.staleNote = h('div', { class: 'note warn', hidden: true }, 'The model has changed since this run, so the logs below show the previous model. Press Run forward model to update them.');
    this.fdHost = h('div');
    main.append(panel('Tool position', 'click the well or any log to move the tool', this.secHost), this.staleNote, this.chartsHost, panel('Values at the tool position', null, this.tblHost), this.fdHost);
    this.sec = new SectionChart(this.secHost, { height: 230, onPick: (md) => App.setCursor(md) });
    this.built = true; this.show(); this.update();
  },
  dispose() { for (const c of this.charts) c.destroy(); this.charts = []; if (this.sec) { this.sec.destroy(); this.sec = null; } this.built = false; },
  status() {
    if (!this.built) return; const k = App.fwdStatus(), f = App.fwd;
    this.pillHost.replaceChildren(statusPill(k)); this.runBtn.disabled = k === 'busy'; this.cancelBtn.hidden = k !== 'busy'; this.staleNote.hidden = k !== 'stale';
    if (k !== 'busy') this.prog.set(0);
    const { cfg } = App.getCfg(); const nSt = stationCount(cfg);
    if (k !== 'busy') this.info.textContent = nSt + ' stations, ' + cfg.channels.length + ' channels' + (f ? '; last run took ' + fmtDur(f.ms / 1000) : '');
    if (this.estHost) this.estimate();
  },
  solverCard(S) {
    const fd = S.engine2d !== 'local';
    this.estHost = fd ? h('div', { class: 'hint' }) : null;
    return card('2D solver', [
      sel('Solver', S, 'engine2d', [['fd', '2.5D finite difference'], ['local', 'Local 1D approximation (instant)']], { onchange: () => { App.rebuild(); App.changed(); } }),
      fd ? h('div', { class: 'grid2' },
        sel('Accuracy', S.fd, 'q', [['draft', 'Draft'], ['std', 'Standard'], ['fine', 'Fine']], { title: 'Grid resolution, wavenumber samples and grid size of each solve. Fine takes about 3–4× as long as Standard.' }),
        num('Solver stations every', S.fd, 'step', { unit: 'm', min: 2, step: 1, title: 'Spacing of the stations where the correction is solved before refinement' })) : null,
      this.estHost,
      fd ? h('div', { class: 'note' }, 'Each station gets the exact layered-earth response of its local-1D model plus a 2.5D finite-difference correction for what that model leaves out: faults, pinch-outs, lateral resistivity changes and boundary curvature. The correction is solved at the stations listed under 2.5D solver and interpolated along the well in between. Runs take minutes, so they start only when you press Run.')
        : h('div', { class: 'note warn' }, 'The local-1D approximation computes every station for the layered earth directly below the tool, with boundary depths and dip taken from the section at the tool position and resistivities that vary along the well. It leaves out coupling to faults, pinch-outs and lateral resistivity contrasts within the tool’s reach. Choose 2.5D finite difference to include them.'),
    ]);
  },
  estimate() {
    const { cfg, tr, key } = App.getTraj(); if (cfg.eng2d !== 'fd' || App.busy === 'fwd') return;
    if (this._estKey === key) return; this._estKey = key;
    let txt;
    try {
      if (App.validate(cfg)) { this.estHost.textContent = ''; return; }
      const pre = fdPlanPreview(cfg, stationList(cfg, tr)), nw = fdWorkers(App, pre.opt), e = fdEstimate(pre, nw);
      txt = 'First pass: ' + pre.idx.length + ' solver station' + (pre.idx.length === 1 ? '' : 's') + ' × ' + pre.nFreq + ' frequenc' + (pre.nFreq === 1 ? 'y' : 'ies') + ' = ' + pre.jobs + ' solves on ' + nw + ' worker' + (nw === 1 ? '' : 's') + ', roughly ' + fmtDur(e.lo) + ' to ' + fmtDur(e.hi) + '. Refinement then adds stations where the correction changes quickly; near a fault that can triple the count.';
    } catch (err) { txt = ''; }
    this.estHost.textContent = txt;
  },
  setFDProgress(p, t0) {
    if (!this.built) return;
    if (!p) { this.prog.set(0.02); this.info.textContent = 'Computing the local-1D logs…'; return; }
    const fr = p.total ? p.done / p.total : 0, el = (performance.now() - t0) / 1000, el2 = (performance.now() - p.t0) / 1000;
    this.prog.set(0.03 + 0.97 * fr);
    const left = p.done > 0.5 ? el2 * (p.total - p.done) / p.done : null;
    this.info.textContent = '2.5D solves: ' + Math.floor(p.done) + ' of ' + p.total + (p.round ? ' (refinement pass ' + p.round + ')' : '') + ', ' + fmtDur(el) + ' elapsed' + (left !== null ? ', about ' + fmtDur(left) + ' left in this pass' : '');
  },
  setProgress(f, t0) { if (!this.built) return; this.prog.set(f); this.info.textContent = 'Running: ' + Math.round(100 * f) + '% done, ' + fsig((performance.now() - t0) / 1000, 3) + ' s elapsed'; },
  update() { if (!this.built) return; this.status(); this.drawSection(); },
  drawSection() { const { cfg, tr } = App.getTraj(); this.sec.set(buildSection(App.S, cfg, tr, true)); },
  cursor() { if (!this.built) return; this.drawSection(); for (const c of this.charts) c.setCursorX(App.S.cursorMd); this.table(); },
  pairs() {
    const S = App.S, f = App.fwd, chs = f ? f.cfg.channels : App.getCfg().cfg.channels, seen = [], sty = chanStyles(chs); this.pairHost.replaceChildren();
    chs.forEach((c, i) => {
      const k = pairKey(c); if (seen.indexOf(k) >= 0) return; seen.push(k); const on = S.fwdSel[k] !== false;
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), title: 'Show or hide this pair on all logs' }, h('i', { style: { color: cssColor(sty[i].color) } }), k);
      b.addEventListener('click', () => { S.fwdSel[k] = !on; App.persist(); this.show(); });
      this.pairHost.append(b);
    });
  },
  show() {
    if (!this.built) return; const S = App.S, f = App.fwd;
    for (const c of this.charts) c.destroy(); this.charts = []; this.chartsHost.replaceChildren(); this.pairs(); this.status();
    if (!f) { this.chartsHost.append(h('div', { class: 'empty' }, 'No data yet. Press Run forward model.')); this.table(); return; }
    const chs = f.cfg.channels, sty = chanStyles(chs), md = Float64Array.from(f.st, s => s.md), qty = S.chartQty, groups = new Map();
    if (!f.arr) f.arr = chs.map((c, i) => chanArrays(f.data, f.nSt, f.nch, i));
    const cmp = !!(f.base && S.cmpLocal); if (cmp && !f.barr) f.barr = chs.map((c, i) => chanArrays(f.base, f.nSt, f.nch, i));
    chs.forEach((c, i) => { const k = chanShort(c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
    for (const [k, idxs] of groups) {
      const A = [], B = [];
      for (const i of idxs) {
        const pk = pairKey(chs[i]); if (S.fwdSel[pk] === false) continue; const a = f.arr[i], col = cssColor(sty[i].color);
        A.push({ name: pk, color: col, x: md, y: qty === 'ap' ? a.amp : a.re }); B.push({ name: pk, color: col, x: md, y: qty === 'ap' ? a.ph : a.im });
        if (cmp) { const b = f.barr[i], o = { color: col, dash: '5 4', width: 1.4, opacity: 0.8, x: md }; A.push(Object.assign({ name: pk + ', local 1D', y: qty === 'ap' ? b.amp : b.re }, o)); B.push(Object.assign({ name: pk + ', local 1D', y: qty === 'ap' ? b.ph : b.im }, o)); }
      }
      const ha = h('div'), hb = h('div'), c0 = chs[idxs[0]];
      this.chartsHost.append(panel(k + ' coupling', 'Tx ' + antName(c0.tx) + ', Rx ' + antName(c0.rx) + (cmp ? '; dashed: local 1D' : ''), h('div', { class: 'charts2' }, ha, hb)));
      const common = { height: 200, group: 'md', xlabel: 'Measured depth (m)', legend: false, toggle: false, xname: 'MD', onClick: (x) => App.setCursor(x) };
      const ca = new LineChart(ha, Object.assign({}, common, { ylabel: qty === 'ap' ? 'Amplitude (dB)' : 'Real part', tipfmt: (s, v) => fsig(v, 4) + (qty === 'ap' ? ' dB' : '') }));
      const cb = new LineChart(hb, Object.assign({}, common, { ylabel: qty === 'ap' ? 'Phase (°)' : 'Imaginary part', tipfmt: (s, v) => fsig(v, 4) + (qty === 'ap' ? '°' : '') }));
      ca.set(A, qty === 'ap' ? { ylim: ampYlim(A) } : { ylim: null }); cb.set(B); ca.setCursorX(S.cursorMd); cb.setCursorX(S.cursorMd); this.charts.push(ca, cb);
    }
    this.table(); this.solverPanel();
  },
  solverPanel() {
    const f = App.fwd, host = this.fdHost; if (!host) return; host.replaceChildren(); if (!f || !f.fd) return;
    const r = f.fd, sm = r.summary, rows = [];
    for (const x of r.infos) {
      const inf = x.info;
      rows.push([fsig(x.md, 6), fsig(x.f / 1000, 3), x.skip ? 'skipped: no 2D feature within reach' : (x.round ? 'solved (refinement)' : 'solved'), inf ? fsig(x.dmax, 2) : '0', inf ? fsig(inf.dmin, 3) : '–', inf ? fsig(inf.h0, 3) : '–', inf ? String(inf.nodes) : '–', inf ? Math.min(100, Math.round(100 * inf.quality)) + '%' : '–', fsig(x.secs, 3)]);
    }
    const msgs = [h('div', { class: 'stat' },
      h('span', null, 'Solver stations ', h('b', null, String(sm.nFD))), h('span', null, 'Solves ', h('b', null, String(sm.jobs))), h('span', null, 'Skipped ', h('b', null, String(sm.skipped))),
      h('span', null, 'Accuracy ', h('b', null, FDORCH.QUALITY[r.q].label)), h('span', null, 'Run time ', h('b', null, fmtDur(f.ms / 1000))), h('span', null, 'Solver time ', h('b', null, fmtDur(sm.secs)), ' (summed over workers)'))];
    if (sm.poor.length) { const big = Math.max(...sm.poor.map(p => p.dmax || 0)); msgs.push(h('div', { class: big > 0.01 ? 'note warn' : 'hint' }, sm.poor.length + ' solve' + (sm.poor.length === 1 ? '' : 's') + ' ran below 70% of the target resolution (MD ' + mdRanges(sm.poor.map(p => p.md)) + ' m), because a 2D feature or a very conductive zone is close to the antennas and the grid hit its size limit. The correction there is less accurate. Its largest value at those stations is ' + fsig(big, 2) + ' of the free-space coupling (about ' + fsig(20 * Math.log10(1 + big), 2) + ' dB at unit coupling). Fine accuracy raises the size limit.')); }
    if (r.breaks) msgs.push(h('div', { class: 'hint' }, 'The local-1D model jumps at ' + r.breaks + ' place' + (r.breaks === 1 ? '' : 's') + ' along the well (a fault step, a switch of the nearest boundary or a sharp resistivity change). The correction is solved on both sides of each jump and not interpolated across it.'));
    msgs.push(h('div', { class: 'hint' }, 'Correction is the largest 2D-minus-local-1D coupling at that station and frequency, as a fraction of the free-space coupling. Distance is from the nearest antenna to the nearest edge of the zone where the section differs from the local-1D model. Resolution compares the cell size with the accuracy target, which is set by that distance and by the skin depth.'));
    host.append(panel('2.5D solver', 'where the correction was solved', ...msgs, dataTable(['MD (m)', 'Frequency (kHz)', 'Result', 'Correction', 'Distance (m)', 'Cell size (m)', 'Grid nodes', 'Resolution', 'Time (s)'], rows)));
  },
  table() {
    const f = App.fwd, host = this.tblHost; host.replaceChildren(); if (!f) { host.append(h('div', { class: 'hint' }, 'Run the forward model to see values.')); return; }
    const i = stIndex(f.cfg, f.nSt, App.S.cursorMd), st = f.st[i], rows = [];
    const B = f.base;
    f.cfg.channels.forEach((c, j) => {
      const re = f.data[2 * (i * f.nch + j)], im = f.data[2 * (i * f.nch + j) + 1], row = [c.name, fsig(ampdb(re, im), 5), Math.hypot(re, im) > PH_MIN_AMP ? fsig(Math.atan2(im, re) * R2D, 5) : '–', fsig(re, 5), fsig(im, 5)];
      if (B) { const br = B[2 * (i * f.nch + j)], bi = B[2 * (i * f.nch + j) + 1], ok = Math.hypot(re, im) > PH_MIN_AMP && Math.hypot(br, bi) > PH_MIN_AMP; let dp = (Math.atan2(im, re) - Math.atan2(bi, br)) * R2D; dp -= 360 * Math.round(dp / 360); row.push(fsig(ampdb(re, im) - ampdb(br, bi), 3), ok ? fsig(dp, 3) : '–'); }
      rows.push(row);
    });
    host.append(h('div', { class: 'stat', style: { marginBottom: '6px' } }, h('span', null, 'MD ', h('b', null, fsig(st.md, 6) + ' m')), h('span', null, 'TVD ', h('b', null, fsig(st.D, 6) + ' m')), h('span', null, 'Inclination ', h('b', null, fsig(st.inc * R2D, 5) + '°')), h('span', null, 'Azimuth ', h('b', null, fsig(((st.az * R2D) % 360 + 360) % 360, 5) + '°'))),
      dataTable(['Channel', 'Amplitude (dB)', 'Phase (°)', 'Real', 'Imaginary'].concat(B ? ['2D − local 1D (dB)', '2D − local 1D (°)'] : []), rows));
  },
  exportCSV() {
    const f = App.fwd; if (!f) { App.toast('Run the forward model first.', 'bad'); return; }
    const hdr = ['MD_m', 'TVD_m', 'North_m', 'East_m', 'Inc_deg', 'Azi_deg']; f.cfg.channels.forEach(c => hdr.push(c.name + ' amp_dB', c.name + ' phase_deg', c.name + ' re', c.name + ' im'));
    const rows = [hdr];
    for (let i = 0; i < f.nSt; i++) {
      const s = f.st[i], r = [s.md, s.D, s.N, s.E, s.inc * R2D, s.az * R2D];
      for (let c = 0; c < f.nch; c++) { const re = f.data[2 * (i * f.nch + c)], im = f.data[2 * (i * f.nch + c) + 1]; r.push(ampdb(re, im), Math.atan2(im, re) * R2D, re, im); }
      rows.push(r.map(v => +v.toPrecision(9)));
    }
    saveFile('udar_forward.csv', toCSV(rows));
  },
  exportJSON() {
    const f = App.fwd; if (!f) { App.toast('Run the forward model first.', 'bad'); return; }
    const re = [], im = []; for (let i = 0; i < f.nSt; i++) { const a = [], b = []; for (let c = 0; c < f.nch; c++) { a.push(f.data[2 * (i * f.nch + c)]); b.push(f.data[2 * (i * f.nch + c) + 1]); } re.push(a); im.push(b); }
    const engine = f.cfg.mode === '1d' ? 'exact layered earth (1D)' : f.fd ? 'exact local 1D + 2.5D finite-difference correction (' + FDORCH.QUALITY[f.fd.q].label + ')' : 'local-1D approximation';
    const obj = { tool: 'UDAR Bench', note: 'normalised complex coupling, free-space ZZ coupling = 1, e^(-i omega t) convention', engine, solverStationsMd: f.fd ? f.fd.idx.map(i => f.st[i].md) : undefined, config: f.cfg, md: Array.from(f.st, s => s.md), tvd: Array.from(f.st, s => s.D), channels: f.cfg.channels.map(c => c.name), re, im };
    saveFile('udar_forward.json', JSON.stringify(obj));
  },
};
function mdRanges(list) {                    // 226, 230, 234, 236 ... -> "226–280"; gaps over 8 m start a new range
  const v = Array.from(new Set(list)).sort((a, b) => a - b), out = []; let a = v[0], b = v[0];
  for (let i = 1; i <= v.length; i++) { if (i < v.length && v[i] - b <= 8) { b = v[i]; continue; } out.push(a === b ? fsig(a, 5) : fsig(a, 5) + '–' + fsig(b, 5)); a = b = v[i]; }
  return out.join(', ');
}
function stationCount(cfg) { return Math.max(1, Math.floor((cfg.mdEnd - cfg.mdStart) / cfg.mdStep + 1e-9) + 1); }

// ---------------------------------------------------------------------------------------------------------------
const InvView = {
  charts: [], built: false,
  build(side, main) {
    const S = App.S, iv = S.inv, nz = iv.noise;
    this.pillHost = h('span'); this.info = h('div', { class: 'hint' }); this.prog = progressBar();
    this.runBtn = btn('Run inversion', () => App.runInversion(), 'primary'); this.cancelBtn = btn('Cancel', () => App.cancel()); this.cancelBtn.hidden = true;
    this.underNote = h('div', { class: 'note warn', hidden: true }, 'There are no more data values than free parameters, so the inversion is under-determined and can take much longer. Select more channels, fix some parameters or use fewer layers.');
    const seedIn = numInput(nz, 'seed', { step: 1, min: 1 });
    const asmHost = h('div'), drawAsm = () => asmHost.replaceChildren(iv.assumedSame ? h('div', { class: 'hint' }, 'The inversion weights the data with the noise levels that were added.') :
      h('div', { class: 'grid3' }, num('Amplitude', iv.assumed, 'ampDb', { unit: 'dB', min: 0, step: 0.01 }), num('Phase', iv.assumed, 'phaseDeg', { unit: '°', min: 0, step: 0.1 }), num('Floor', iv.assumed, 'floorPpm', { unit: 'ppm', min: 0, step: 10 })));
    drawAsm();
    this.chanHost = h('div', { class: 'chips' }); this.specHost = h('div'); this.specShown = null;
    const nLsel = sel('Layers in the inversion model', iv, 'nLayers', [2, 3, 4, 5, 6, 7].map(n => [n, String(n)]), { num: true, onchange: () => { iv.specAuto = true; App.changed(); } });
    side.append(
      card('Inversion', [
        h('div', { class: 'row sp' }, h('span', { class: 'lbl' }, 'Status'), this.pillHost), this.info,
        h('div', { class: 'row' }, this.runBtn, this.cancelBtn), this.prog, this.underNote,
        h('div', { class: 'hint' }, 'Each station is inverted on its own with a layered model whose layers lie parallel to the assumed bedding. The forward data are computed first if they are out of date.'),
      ]),
      card('Noise added to the synthetic data', [
        h('div', { class: 'grid3' }, num('Amplitude', nz, 'ampDb', { unit: 'dB, 1σ', min: 0, step: 0.01 }), num('Phase', nz, 'phaseDeg', { unit: '°, 1σ', min: 0, step: 0.1 }), num('Floor', nz, 'floorPpm', { unit: 'ppm', min: 0, step: 10 })),
        h('div', { class: 'grid3' }, num('Bias, amplitude', nz, 'biasDb', { unit: 'dB', min: 0, step: 0.01 }), num('Bias, phase', nz, 'biasDeg', { unit: '°', min: 0, step: 0.1 }), field('Seed', seedIn)),
        btn('New noise realisation', () => { nz.seed = 1 + Math.floor(Math.random() * 999999); seedIn.value = nz.seed; App.changed(); }),
        h('div', { class: 'hint' }, 'Gaussian noise on amplitude (dB) and phase, drawn independently per station and channel. The floor adds noise to the real and imaginary parts, in ppm of the free-space ZZ coupling. Bias is one random offset per channel, constant along the well. Changing the noise does not require a new forward run.'),
      ]),
      card('Noise assumed by the inversion', [chk('Same as the noise added', iv, 'assumedSame', { onchange: () => { drawAsm(); App.changed(); } }), asmHost,
        h('div', { class: 'grid2' }, num('Dip error', iv, 'dipErr', { unit: '° added to true dip', step: 0.5 }), num('Dip azimuth error', iv, 'dipAzErr', { unit: '°', step: 1 })),
        h('div', { class: 'hint' }, 'The inversion is told the formation dip and dip azimuth at each station. Add an error here to see how a wrong dip affects the result.')], { collapsible: true }),
      card('Tool channels used in the inversion', [this.chanHost,
        h('div', { class: 'row' }, btn('All', () => { iv.off = []; this.drawChan(); App.changed(); }, 'small'), btn('None', () => { iv.off = App.getCfg().cfg.channels.map(c => c.sig); this.drawChan(); App.changed(); }, 'small'),
          btn('ZZ only', () => { iv.off = App.getCfg().cfg.channels.filter(c => chanShort(c) !== 'ZZ').map(c => c.sig); this.drawChan(); App.changed(); }, 'small')),
        h('div', { class: 'hint' }, 'The channel list comes from the Tool tab. Switch channels off to test what a smaller tool configuration can resolve.')]),
      card('Layer model', [nLsel,
        h('div', { class: 'grid2' }, num('Initial Rh error', iv.perturb, 'rho', { unit: '× (alternating)', min: 1, step: 0.1, onchange: () => { iv.specAuto = true; App.changed(); } }), num('Initial boundary offset', iv.perturb, 'd', { unit: 'm', step: 0.5, onchange: () => { iv.specAuto = true; App.changed(); } })),
        chk('Invert the anisotropy ratio Rv/Rh', iv, 'anisoFree', { onchange: () => { iv.specAuto = true; App.changed(); } }),
        this.specHost,
        h('div', { class: 'row' }, btn('Reset starting model', () => { iv.specAuto = true; iv.specKey = ''; App.changed(); }, 'small')),
        h('div', { class: 'hint' }, 'The starting model is the true model with the errors above, so a synthetic test begins close to the answer. If a station fits poorly the solver also tries random starts. Rv/Rh is held at the true value unless you invert it. Boundary 1 is measured along the bedding normal from the tool; positive means below the tool.')]),
      card('Solver', [
        h('div', { class: 'grid3' }, num('Random starts', iv, 'nStarts', { min: 0, max: 20, step: 1 }), num('Iterations', iv, 'maxIter', { min: 5, max: 200, step: 5 }), num('Accept χ² below', iv, 'acceptChi2', { min: 1, step: 0.1 })),
        sel('Hankel filter', iv, 'filter', [['key_101_2012', '101 points (fast)'], ['key_201_2012', '201 points (same as the forward model)']]),
        chk('Start each station from the previous solution', iv, 'continuation'),
        h('div', { class: 'hint' }, 'The forward data use the filter chosen in the Tool tab. Using the same engine and filter for the inversion (an inverse crime) makes the recovery look better than real data would allow.')], { collapsible: true }),
    );
    this.stats = h('div', { class: 'stat' }); this.curtainHost = h('div'); this.rhHost = h('div'); this.dHost = h('div'); this.chiHost = h('div'); this.fitHost = h('div'); this.tblHost = h('div');
    this.fitSel = h('select', { 'aria-label': 'Channel to display' }); this.fitSel.addEventListener('change', () => { iv.fitChan = parseInt(this.fitSel.value, 10); App.persist(); this.drawFit(); });
    this.staleNote = h('div', { class: 'note warn', hidden: true }, 'Settings have changed since this inversion ran. The results below belong to the previous settings.');
    this.noResult = h('div', { class: 'empty' }, 'No inversion yet. Set the noise and the layer model, then press Run inversion.');
    main.append(
      this.staleNote,
      panel('Inverted section', 'colour is horizontal resistivity; dashed lines are the true boundaries; solid orange lines are the inverted boundaries', this.curtainHost, this.stats),
      panel('Layer resistivities', 'inverted (solid, with ±1σ band) and true (dashed)', this.rhHost),
      panel('Distance from the tool to each boundary', 'along the bedding normal, positive below the tool; bands are ±1σ from the linearised covariance', this.dHost),
      panel('Misfit', 'reduced χ² per station', this.chiHost),
      panel('Data fit', h('div', { class: 'sel-row' }, h('span', { class: 'lbl' }, 'Channel'), this.fitSel), this.fitHost),
      panel('Result at the tool position', null, this.tblHost),
      panel('Export', null, h('div', { class: 'row' }, btn('Inversion result as CSV', () => this.exportCSV()), btn('Noisy data as CSV', () => this.exportObs()))),
    );
    this.sec = new SectionChart(this.curtainHost, { height: 300, onPick: (md) => App.setCursor(md) });
    this.built = true; this.drawChan(); this.update(); this.show();
  },
  dispose() { for (const c of this.charts) c.destroy(); this.charts = []; if (this.sec) { this.sec.destroy(); this.sec = null; } this.built = false; },
  drawChan() {
    const S = App.S, iv = S.inv, chs = App.getCfg().cfg.channels, sty = chanStyles(chs); this.chanHost.replaceChildren();
    chs.forEach((c, i) => {
      const on = iv.off.indexOf(c.sig) < 0;
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), title: 'Use this channel in the inversion' }, h('i', { style: { color: cssColor(sty[i].color) } }), c.name);
      b.addEventListener('click', () => { const k = iv.off.indexOf(c.sig); if (k >= 0) iv.off.splice(k, 1); else iv.off.push(c.sig); this.drawChan(); App.changed(); });
      this.chanHost.append(b);
    });
    this.fillFitSel();
  },
  fillFitSel() {
    const chs = App.getCfg().cfg.channels, iv = App.S.inv; this.fitSel.replaceChildren(...chs.map((c, i) => h('option', { value: i }, c.name)));
    if (!(iv.fitChan >= 0 && iv.fitChan < chs.length)) iv.fitChan = 0; this.fitSel.value = iv.fitChan;
  },
  drawSpec() {
    const S = App.S, iv = S.inv, sp = iv.spec; this.specShown = sp; if (!sp) { this.specHost.replaceChildren(); return; }
    const edit = () => { iv.specAuto = false; App.changed(); };
    const rows = [];
    sp.layers.forEach((L, k) => rows.push({ label: 'Rh, layer ' + (k + 1) + ' (Ω·m)', p: L.rh }));
    sp.layers.forEach((L, k) => rows.push({ label: 'Rv/Rh, layer ' + (k + 1), p: L.kv }));
    rows.push({ label: 'Boundary 1 (m)', p: sp.d1 }); sp.t.forEach((p, k) => rows.push({ label: 'Thickness, layer ' + (k + 2) + ' (m)', p }));
    const fcell = (r) => { const i = h('input', { type: 'checkbox', checked: !!r.p.free, 'aria-label': 'Free: ' + r.label }); i.addEventListener('change', () => { r.p.free = i.checked; edit(); }); return i; };
    const t = tableEditor(rows, [{ label: 'Parameter', cell: (r) => h('span', { style: { whiteSpace: 'nowrap' } }, r.label) }, { label: 'Free', w: '34px', cell: fcell },
      { label: 'Start', cell: (r) => numInput(r.p, 'v', { onchange: edit }) }, { label: 'Min', cell: (r) => numInput(r.p, 'lo', { onchange: edit }) }, { label: 'Max', cell: (r) => numInput(r.p, 'hi', { onchange: edit }) }], { fixed: true });
    this.specHost.replaceChildren(t);
  },
  status() {
    if (!this.built) return; const k = App.invStatus(), r = App.inv;
    this.pillHost.replaceChildren(statusPill(k)); this.runBtn.disabled = App.busy !== null; this.cancelBtn.hidden = App.busy !== 'inv'; if (App.busy !== 'inv') this.prog.set(0);
    this.staleNote.hidden = k !== 'stale';
    const chs = App.getCfg().cfg.channels, nSel = chs.filter(c => App.S.inv.off.indexOf(c.sig) < 0).length, spec = App.ensureSpec(), nFree = spec ? specFreeCount(spec) : 0;
    this.underNote.hidden = !(nSel > 0 && 2 * nSel <= nFree);
    if (k !== 'busy') this.info.textContent = nSel + ' of ' + chs.length + ' channels selected: ' + 2 * nSel + ' data values per station, ' + nFree + ' free parameters' + (r ? '; last run took ' + fsig(r.ms / 1000, 3) + ' s' : '');
  },
  setProgress(p, t0) { if (!this.built) return; this.prog.set(p); this.info.textContent = 'Running: ' + Math.round(100 * p) + '% done, ' + fsig((performance.now() - t0) / 1000, 3) + ' s elapsed'; },
  update() { if (!this.built) return; App.ensureSpec(); if (this.specShown !== App.S.inv.spec) this.drawSpec(); this.status(); this.fillFitSel(); },
  cursor() { if (!this.built) return; for (const c of this.charts) c.setCursorX(App.S.cursorMd); this.drawCurtain(); this.table(); },
  // ---- results ----
  geomOf(inv) { return inv.cfg; },
  show() {
    if (!this.built) return; for (const c of this.charts) c.destroy(); this.charts = [];
    this.rhHost.replaceChildren(); this.dHost.replaceChildren(); this.chiHost.replaceChildren();
    const inv = App.inv; this.status();
    if (!inv) { this.stats.replaceChildren(); for (const hst of [this.rhHost, this.dHost, this.chiHost]) hst.append(h('div', { class: 'empty' }, 'No inversion yet.')); this.drawCurtain(); this.drawFit(); this.table(); return; }
    const res = inv.res, n = res.length, N = res[0].rh.length, md = Float64Array.from(inv.st, s => s.md), nL = nLayersOf(inv.cfg);
    const truth = N === nL ? inv.st.map(s => truthAt(inv.cfg, s)) : null; inv.truth = truth;
    const col = (k) => cssColor('var(' + SERIES_VARS[k % 8] + ')');
    const common = { height: 200, group: 'md', xlabel: 'Measured depth (m)', xname: 'MD', toggle: false, onClick: (x) => App.setCursor(x) };
    // resistivities
    const A = [];
    for (let k = 0; k < N; k++) {
      const y = Float64Array.from(res, r => r.rh[k]);
      A.push({ name: 'Layer ' + (k + 1), color: col(k), x: md, y, band: { lo: Float64Array.from(res, r => r.rh[k] * Math.exp(-r.sd[k])), hi: Float64Array.from(res, r => r.rh[k] * Math.exp(r.sd[k])) } });
      if (truth) A.push({ name: 'Layer ' + (k + 1) + ' true', color: col(k), dash: '6 3', width: 1.4, x: md, y: Float64Array.from(truth, t => t.rh[k]), noLegend: true });
    }
    const c1 = new LineChart(this.rhHost, Object.assign({}, common, { ylabel: 'Rh (Ω·m)', ylog: true, tipfmt: (s, v) => fsig(v, 3) + ' Ω·m' })); c1.set(A); this.charts.push(c1);
    // distances
    const B = [];
    for (let k = 0; k < N - 1; k++) {
      const y = Float64Array.from(res, r => r.zi[k]);
      B.push({ name: 'Boundary ' + (k + 1), color: col(k), x: md, y, band: { lo: Float64Array.from(res, r => r.zi[k] - r.zsd[k]), hi: Float64Array.from(res, r => r.zi[k] + r.zsd[k]) } });
      if (truth) B.push({ name: 'Boundary ' + (k + 1) + ' true', color: col(k), dash: '6 3', width: 1.4, x: md, y: Float64Array.from(truth, t => t.zi[k]), noLegend: true });
    }
    B.push({ name: 'Tool', color: css('--ink-2'), x: md, y: new Float64Array(n), width: 1, noLegend: true, noTip: true });
    const c2 = new LineChart(this.dHost, Object.assign({}, common, { ylabel: 'Distance (m)', tipfmt: (s, v) => fsig(v, 3) + ' m' })); c2.set(B); this.charts.push(c2);
    // chi2
    const acc = inv.icfg.acceptChi2, c3 = new LineChart(this.chiHost, Object.assign({}, common, { height: 150, ylabel: 'Reduced χ²', ylog: true, tipfmt: (s, v) => fsig(v, 3) }));
    c3.set([{ name: 'χ²', color: col(0), x: md, y: Float64Array.from(res, r => Math.max(r.chi2, 1e-3)), line: true, marker: 2 }], { hlines: [{ y: acc, label: 'accept ' + fsig(acc, 2) }] }); this.charts.push(c3);
    for (const c of this.charts) c.setCursorX(App.S.cursorMd);
    // stats
    const ok = res.filter(r => r.chi2 <= acc).length, mean = res.reduce((a, r) => a + r.chi2, 0) / n, med = Float64Array.from(res, r => r.chi2).sort()[Math.floor(n / 2)];
    this.stats.replaceChildren(h('span', null, 'Stations ', h('b', null, String(n))), h('span', null, 'Within accept level ', h('b', null, ok + ' (' + fsig(100 * ok / n, 3) + '%)')), h('span', null, 'Median χ² ', h('b', null, fsig(med, 3))), h('span', null, 'Mean χ² ', h('b', null, fsig(mean, 3))), h('span', null, 'Run time ', h('b', null, fsig(inv.ms / 1000, 3) + ' s')));
    this.drawCurtain(); this.drawFit(); this.table();
  },
  drawCurtain() {
    const inv = App.inv, S = App.S; if (!this.sec) return;
    if (!inv) { const { cfg, tr } = App.getTraj(); this.sec.set(buildSection(S, cfg, tr, true)); return; }
    const cfg = inv.cfg, tr = inv.tr, base = buildSection(S, cfg, tr, true), az = base.az, dark = isDark(), res = inv.res, N = res[0].rh.length;
    const [rlo, rhi] = resRange(cfg), colr = (rh) => rampColor((Math.log10(clamp(rh, rlo, rhi)) - Math.log10(rlo)) / (Math.log10(rhi) - Math.log10(rlo)), dark);
    const pos = res.map((r, i) => { const st = inv.st[i], nz = Math.max(0.05, r.nrm[2]); return { x: vsOf(cfg, az, st.N, st.E), D: st.D, nz, zi: r.zi, rh: r.rh }; });
    const top = base.z0 - 60, bot = base.z1 + 60, slices = [];
    for (let i = 0; i + 1 < pos.length; i++) {
      const a = pos[i], b = pos[i + 1];
      for (let k = 0; k < N; k++) {
        const t0 = k === 0 ? top : a.D + a.zi[k - 1] / a.nz, t1 = k === 0 ? top : b.D + b.zi[k - 1] / b.nz, b0 = k === N - 1 ? bot : a.D + a.zi[k] / a.nz, b1 = k === N - 1 ? bot : b.D + b.zi[k] / b.nz;
        slices.push({ x0: a.x, x1: b.x, zt0: t0, zt1: t1, zb0: b0, zb1: b1, color: colr(0.5 * (a.rh[k] + b.rh[k])) });
      }
    }
    const lines = base.lines.map(l => Object.assign({}, l, { dash: '5 3', color: css('--ink'), w: 1.2, opacity: 0.9 }));
    for (let k = 0; k < N - 1; k++) lines.push({ pts: pos.map(p => [p.x, p.D + p.zi[k] / p.nz]), color: css('--s2'), w: 1.6, name: 'Inverted boundary ' + (k + 1) });
    const sec = Object.assign({}, base, { slices, lines, cbar: { min: rlo, max: rhi, color: (t) => rampColor(t, dark) } });
    sec.probe = null; this.sec.set(sec);
  },
  fitData() {
    const inv = App.inv, f = App.fwd, S = App.S, ci = S.inv.fitChan;
    if (inv) { const j = inv.icfg.channels.indexOf(ci); return { st: inv.st, cfg: inv.cfg, nch: inv.nch, clean: inv.clean, obs: inv.obs, sim: j >= 0 ? inv.res : null, j, nsel: inv.icfg.channels.length }; }
    if (f && App.obs) return { st: f.st, cfg: f.cfg, nch: f.nch, clean: f.data, obs: App.obs.data, sim: null, j: -1, nsel: 0 };
    return null;
  },
  drawFit() {
    this.fitHost.replaceChildren(); const d = this.fitData(), S = App.S;
    if (!d) { this.fitHost.append(h('div', { class: 'empty' }, 'Run the forward model to see the noisy data.')); return; }
    const ci = clamp(S.inv.fitChan, 0, d.nch - 1), nSt = d.st.length, md = Float64Array.from(d.st, s => s.md);
    const co = chanArrays(d.clean, nSt, d.nch, ci), ob = chanArrays(d.obs, nSt, d.nch, ci); let mo = null;
    if (d.sim) { const buf = new Float64Array(nSt * 2); for (let i = 0; i < nSt; i++) { buf[2 * i] = d.sim[i].sim[2 * d.j]; buf[2 * i + 1] = d.sim[i].sim[2 * d.j + 1]; } mo = chanArrays(buf, nSt, 1, 0); }
    const mk = (key) => { const s = [{ name: 'Noisy data', color: css('--ink-2'), x: md, y: ob[key], line: false, marker: 2 }, { name: 'True (noise-free)', color: css('--s1'), x: md, y: co[key], width: 1.4, dash: '6 3' }]; if (mo) s.push({ name: 'Inverted model', color: css('--s2'), x: md, y: mo[key], width: 2 }); return s; };
    const ha = h('div'), hb = h('div'); this.fitHost.append(h('div', { class: 'charts2' }, ha, hb));
    const common = { height: 200, group: 'md', xlabel: 'Measured depth (m)', xname: 'MD', toggle: true, onClick: (x) => App.setCursor(x) };
    const A = mk('amp'), ca = new LineChart(ha, Object.assign({}, common, { ylabel: 'Amplitude (dB)', ylim: ampYlim(A), tipfmt: (s, v) => fsig(v, 4) + ' dB' })), cb = new LineChart(hb, Object.assign({}, common, { ylabel: 'Phase (°)', tipfmt: (s, v) => fsig(v, 4) + '°' }));
    ca.set(A); cb.set(mk('ph')); ca.setCursorX(S.cursorMd); cb.setCursorX(S.cursorMd); this.charts.push(ca, cb);
    if (!mo) this.fitHost.append(h('div', { class: 'hint' }, App.inv ? 'This channel is not used in the inversion, so there is no model curve for it.' : 'The inverted model curve appears here after the inversion has run.'));
  },
  table() {
    const inv = App.inv, host = this.tblHost; host.replaceChildren(); if (!inv) { host.append(h('div', { class: 'hint' }, 'Run the inversion to see values.')); return; }
    const i = stIndex(inv.cfg, inv.st.length, App.S.cursorMd), r = inv.res[i], st = inv.st[i], t = inv.truth ? inv.truth[i] : null, N = r.rh.length;
    const pm = (v, s) => fsig(v, 4) + ' ± ' + fsig(s, 2);
    const lay = []; for (let k = 0; k < N; k++) lay.push(['Layer ' + (k + 1), pm(r.rh[k], r.rh[k] * (Math.exp(r.sd[k]) - 1)), fsig(r.rv[k], 4), t ? fsig(t.rh[k], 4) : '–', t ? fsig(t.rv[k], 4) : '–']);
    const bnd = []; for (let k = 0; k < N - 1; k++) bnd.push(['Boundary ' + (k + 1), pm(r.zi[k], r.zsd[k]), t ? fsig(t.zi[k], 4) : '–']);
    host.append(h('div', { class: 'stat', style: { marginBottom: '6px' } }, h('span', null, 'MD ', h('b', null, fsig(st.md, 6) + ' m')), h('span', null, 'TVD ', h('b', null, fsig(st.D, 6) + ' m')), h('span', null, 'χ² ', h('b', null, fsig(r.chi2, 3))), h('span', null, 'Function evaluations ', h('b', null, String(r.nfev)))),
      dataTable(['Layer', 'Rh (Ω·m)', 'Rv (Ω·m)', 'True Rh', 'True Rv'], lay), h('div', { style: { height: '8px' } }), dataTable(['Boundary', 'Distance from tool (m)', 'True (m)'], bnd));
  },
  exportCSV() {
    const inv = App.inv; if (!inv) { App.toast('Run the inversion first.', 'bad'); return; }
    const N = inv.res[0].rh.length, hdr = ['MD_m', 'TVD_m', 'chi2']; for (let k = 0; k < N; k++) hdr.push('Rh' + (k + 1) + '_ohmm', 'Rv' + (k + 1) + '_ohmm'); for (let k = 0; k < N - 1; k++) hdr.push('dist_b' + (k + 1) + '_m', 'sd_b' + (k + 1) + '_m');
    if (inv.truth) { for (let k = 0; k < N; k++) hdr.push('true_Rh' + (k + 1)); for (let k = 0; k < N - 1; k++) hdr.push('true_dist_b' + (k + 1)); }
    const rows = [hdr];
    inv.res.forEach((r, i) => { const st = inv.st[i], row = [st.md, st.D, r.chi2]; for (let k = 0; k < N; k++) row.push(r.rh[k], r.rv[k]); for (let k = 0; k < N - 1; k++) row.push(r.zi[k], r.zsd[k]); if (inv.truth) { const t = inv.truth[i]; for (let k = 0; k < N; k++) row.push(t.rh[k]); for (let k = 0; k < N - 1; k++) row.push(t.zi[k]); } rows.push(row.map(v => +v.toPrecision(8))); });
    saveFile('udar_inversion.csv', toCSV(rows));
  },
  exportObs() {
    const f = App.fwd, o = App.obs; if (!f || !o) { App.toast('Run the forward model first.', 'bad'); return; }
    const hdr = ['MD_m', 'TVD_m']; f.cfg.channels.forEach(c => hdr.push(c.name + ' amp_dB', c.name + ' phase_deg')); const rows = [hdr];
    for (let i = 0; i < f.nSt; i++) { const s = f.st[i], r = [s.md, s.D]; for (let c = 0; c < f.nch; c++) { const re = o.data[2 * (i * f.nch + c)], im = o.data[2 * (i * f.nch + c) + 1]; r.push(ampdb(re, im), Math.atan2(im, re) * R2D); } rows.push(r.map(v => +v.toPrecision(9))); }
    saveFile('udar_noisy_data.csv', toCSV(rows));
  },
};
