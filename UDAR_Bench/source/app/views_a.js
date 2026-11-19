// ===================================================================================
// views_a.js -- Tool tab and Geology & well tab
// ===================================================================================
const COMP_OPTS = [['Z', 'Z'], ['X', 'X'], ['Y', 'Y'], ['T', 'Tilt']];
function parseList(s) { return String(s).split(/[,\s;]+/).map(parseFloat).filter(v => isFinite(v) && v > 0); }
function chkCell(row, key) { const i = h('input', { type: 'checkbox', checked: !!row[key], 'aria-label': key }); i.addEventListener('change', () => { row[key] = i.checked; App.changed(); }); return i; }
function antCell(o, rerender) {
  const s = h('select', { 'aria-label': 'Antenna orientation', title: 'Z lies along the tool axis, X and Y are transverse, Tilt is a tilted antenna' }, COMP_OPTS.map(c => h('option', { value: c[0] }, c[1]))); s.value = o.k;
  s.addEventListener('change', () => { o.k = s.value; rerender(); App.changed(); });
  if (o.k !== 'T') return s;
  const tt = numInput(o, 'th', { step: 5 }), pp = numInput(o, 'ph', { step: 5 }); tt.title = 'Tilt from the tool axis (°)'; pp.title = 'Azimuth about the tool axis from X (°)';
  tt.style.width = pp.style.width = '54px';
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, s, h('div', { style: { display: 'flex', gap: '3px' } }, tt, pp));
}

const ToolView = {
  build(side, main) {
    const S = App.S, T = S.tool;
    const tbl = tableEditor(T.channels, [
      { label: 'On', w: '26px', cell: (r) => chkCell(r, 'on') },
      { label: 'Spacing (m)', w: '72px', cell: cellNum('L', { step: 0.5 }) },
      { label: 'Freq (kHz)', w: '72px', cell: cellNum('f', { min: 0.01 }) },
      { label: 'Tx axis', cell: (r, i, rb) => antCell(r.tx, rb) },
      { label: 'Rx axis', cell: (r, i, rb) => antCell(r.rx, rb) },
    ], { min: 1, onchange: () => { App.changed(); ToolView.update(); } });
    const gen = T.gen;
    const spIn = h('input', { type: 'text', value: gen.spacings }), fIn = h('input', { type: 'text', value: gen.freqs });
    spIn.addEventListener('input', () => { gen.spacings = spIn.value; }); fIn.addEventListener('input', () => { gen.freqs = fIn.value; });
    const compChips = h('div', { class: 'chips' });
    for (const c of Object.keys(gen.comps)) {
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(gen.comps[c]), title: 'Tx axis ' + c[0] + ', Rx axis ' + c[1] }, c);
      b.addEventListener('click', () => { gen.comps[c] = !gen.comps[c]; b.setAttribute('aria-pressed', String(gen.comps[c])); }); compChips.append(b);
    }
    const doGen = (append) => {
      const sp = parseList(gen.spacings), fr = parseList(gen.freqs), comps = Object.keys(gen.comps).filter(c => gen.comps[c]);
      if (!sp.length || !fr.length || !comps.length) return;
      const rows = makeChannels({ spacings: sp, freqs: fr, comps, pair: gen.pair });
      if (append) T.channels.push(...rows); else T.channels.splice(0, T.channels.length, ...rows);
      tbl.rebuild(); App.changed(); ToolView.update();
    };
    const presetSel = h('select', null, h('option', { value: '' }, 'Load a preset…'), Object.keys(PRESETS_TOOL).map(k => h('option', { value: k }, k)));
    presetSel.addEventListener('change', () => {
      const p = PRESETS_TOOL[presetSel.value]; if (!p) return;
      T.channels.splice(0, T.channels.length, ...makeChannels(p)); gen.spacings = p.spacings.join(', '); gen.freqs = p.freqs.join(', '); gen.pair = p.pair;
      for (const c of Object.keys(gen.comps)) gen.comps[c] = p.comps.indexOf(c) >= 0; presetSel.value = ''; App.rebuild(); App.changed();
    });
    side.append(
      card('Channels', [
        h('div', { class: 'hint' }, 'Each channel is one transmitter–receiver pair at one frequency. Spacing is signed: a negative value puts the receiver behind the transmitter. Channels are depth-shifted to a common measure point (the pair midpoint).'),
        tbl,
        h('div', { class: 'row' }, btn('Add channel', () => { const l = T.channels[T.channels.length - 1] || { L: 10, f: 24, tx: { k: 'Z', th: 0, ph: 0 }, rx: { k: 'Z', th: 0, ph: 0 } }; T.channels.push(clone(Object.assign({}, l, { on: true }))); tbl.rebuild(); App.changed(); ToolView.update(); }), presetSel),
      ]),
      card('Generate a channel set', [
        h('div', { class: 'grid2' }, field('Spacings', spIn, { unit: 'm' }), field('Frequencies', fIn, { unit: 'kHz' })),
        chk('Pair the n-th spacing with the n-th frequency', gen, 'pair', { onchange: () => { } }),
        h('div', null, h('div', { class: 'lbl', style: { marginBottom: '4px' } }, 'Components (Tx axis, Rx axis)'), compChips),
        h('div', { class: 'row' }, btn('Replace channel list', () => doGen(false), 'primary'), btn('Add to list', () => doGen(true))),
      ], { collapsible: true }),
      card('Numerical accuracy', [
        sel('Hankel transform filter', S, 'filter', [['key_201_2012', '201 points (accurate)'], ['key_101_2012', '101 points (about 2× faster)']], { onchange: () => App.changed() }),
        h('div', { class: 'hint' }, 'Over 120 test models the 201-point filter differs from the empymod package by at most 2.2e-8 of the free-space coupling, and the 101-point filter by at most 1.7e-5.'),
      ], { collapsible: true }),
    );
    this.diag = h('div'); this.charts = { a: null, b: null };
    const ca = h('div'), cb = h('div');
    main.append(
      panel('Transmitter and receiver layout', 'nested spacings share one measure point', this.diag),
      panel('Axial (ZZ) coupling in a homogeneous formation', 'free-space coupling = 0 dB, 0°', h('div', { class: 'charts2' }, ca, cb)),
      h('div', { class: 'note' }, 'Couplings are magnetic-dipole fields per unit moment, normalised by the free-space ZZ coupling at the same spacing, 1/(2π|L|³). Tx and Rx are point dipoles on a rigid straight tool; borehole, mandrel and displacement currents are neglected.'),
    );
    this.charts.a = new LineChart(ca, { height: 230, xlog: true, xlabel: 'Resistivity (Ω·m)', ylabel: 'Amplitude (dB)', toggle: false, xfmt: (v) => fsig(v, 2) });
    this.charts.b = new LineChart(cb, { height: 230, xlog: true, xlabel: 'Resistivity (Ω·m)', ylabel: 'Phase (°)', toggle: false, xfmt: (v) => fsig(v, 2) });
    this.update();
  },
  update() {
    const S = App.S, chs = enabledChannels(S); const D = this.diag; D.replaceChildren();
    if (!chs.length) { D.append(h('div', { class: 'empty' }, 'No channels are enabled. Turn a channel on in the table.')); return; }
    const Ls = Array.from(new Set(chs.map(c => Math.abs(c.L)))).sort((a, b) => b - a), Lmax = Ls[0], W = Math.max(300, D.clientWidth || 600), rowH = 26, H = 26 + Ls.length * rowH + 24;
    const x0 = 120, x1 = W - 150, xm = (x0 + x1) / 2, sx = (p) => xm + p / Lmax * (x1 - x0) / 2 * 0.92;
    const svg = h('s:svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, style: { width: '100%' }, class: 'chart' });
    svg.append(h('s:rect', { x: x0 - 12, y: 8, width: x1 - x0 + 24, height: 10, rx: 5, fill: css('--grid'), stroke: css('--axis') }));
    svg.append(h('s:text', { x: x0 - 20, y: 17, 'text-anchor': 'end' }, 'tool body'));
    svg.append(h('s:line', { x1: xm, x2: xm, y1: 4, y2: H - 8, stroke: css('--muted'), 'stroke-dasharray': '2 3' }));
    svg.append(h('s:text', { x: xm, y: H - 5, 'text-anchor': 'middle' }, 'measure point'));
    const glyph = (cx, cy, kind, role) => {
      const g = h('s:g'); g.append(h('s:circle', { cx, cy, r: 7, fill: role === 'T' ? css('--s2') : css('--surface'), stroke: css('--ink'), 'stroke-width': 1.3 }));
      g.append(h('s:text', { x: cx, y: cy + 3.5, 'text-anchor': 'middle', style: { fill: role === 'T' ? '#fff' : css('--ink'), fontSize: '9.5px', fontWeight: 600 } }, role));
      return g;
    };
    Ls.forEach((L, i) => {
      const y = 38 + i * rowH; svg.append(h('s:line', { x1: sx(-L / 2), x2: sx(L / 2), y1: y, y2: y, stroke: css('--axis'), 'stroke-width': 1.5 }));
      svg.append(glyph(sx(-L / 2), y, '', 'T'), glyph(sx(L / 2), y, '', 'R'));
      svg.append(h('s:text', { x: 8, y: y + 4 }, fsig(L, 3) + ' m'));
      const here = chs.filter(c => Math.abs(c.L) === L), fs = Array.from(new Set(here.map(c => c.f))).sort((a, b) => b - a);
      const label = fs.map(f => fsig(f, 3) + ' kHz: ' + here.filter(c => c.f === f).map(chanShort).join(' ')).join('   ');
      svg.append(h('s:text', { x: x1 + 20, y: y + 4 }, label));
    });
    D.append(svg);
    // homogeneous-formation response curves
    const pairs = []; for (const c of chs) { const k = Math.abs(c.L) + '|' + c.f; if (!pairs.some(p => p.k === k)) pairs.push({ k, L: Math.abs(c.L), f: c.f }); }
    const sty = chanStyles(pairs.map(p => ({ L: p.L, f: p.f, tx: { k: 'Z' }, rx: { k: 'Z' } }))), filt = HANKEL_FILTERS[S.filter], T = new Float64Array(10);
    const rs = []; for (let i = 0; i <= 40; i++) rs.push(Math.pow(10, -1 + 4 * i / 40));
    const A = [], B = [];
    pairs.forEach((p, j) => {
      const a = [], ph = [];
      for (const r of rs) { const m = { N: 1, sh: Float64Array.of(1 / r), sv: Float64Array.of(1 / r), zi: new Float64Array(0) }; Engine.tensor(2 * Math.PI * p.f * 1000, m, 0, p.L, 0, 1, filt, T); const sc = 2 * Math.PI * p.L ** 3, re = T[4] * sc, im = T[5] * sc; a.push(20 * Math.log10(Math.hypot(re, im))); ph.push(Math.atan2(im, re) * R2D); }
      for (let i = ph.length - 2; i >= 0; i--) ph[i] -= 360 * Math.round((ph[i] - ph[i + 1]) / 360);   // unwrap from the resistive end (0°)
      const nm = fsig(p.L, 3) + ' m, ' + fsig(p.f, 3) + ' kHz';
      A.push({ name: nm, color: cssColor(sty[j].color), x: rs, y: a }); B.push({ name: nm, color: cssColor(sty[j].color), x: rs, y: ph });
    });
    this.charts.a.set(A, { tipfmt: (s, v) => fsig(v, 3) + ' dB' }); this.charts.b.set(B, { tipfmt: (s, v) => fsig(v, 3) + '°' });
  },
};

// ---------------------------------------------------------------------------------------------------------------
const GeoView = {
  build(side, main) {
    const S = App.S, w = S.well, mode = S.mode;
    const secRows = tableEditor(w.sections, [
      { label: 'Length (m)', cell: cellNum('len', { min: 1, step: 5 }) }, { label: 'End inc (°)', cell: cellNum('incEnd', { step: 0.5 }) }, { label: 'End azi (°)', cell: cellNum('azEnd', { step: 1 }) },
    ], { min: 1, onchange: () => { App.changed(); } });
    const wellCard = card('Wellbore', [
      h('div', { class: 'hint' }, 'Minimum-curvature trajectory. Inclination and azimuth change linearly with measured depth inside each section, so the build and turn rates are constant per section.'),
      h('div', { class: 'grid3' }, num('Start MD', w, 'md0', { unit: 'm' }), num('Start North', w, 'N0', { unit: 'm' }), num('Start East', w, 'E0', { unit: 'm' }),
        num('Start TVD', w, 'D0', { unit: 'm' }), num('Start inclination', w, 'inc0', { unit: '°', step: 0.5 }), num('Start azimuth', w, 'az0', { unit: '°' })),
      secRows, btn('Add section', () => { const l = w.sections[w.sections.length - 1]; w.sections.push({ len: 100, incEnd: l.incEnd, azEnd: l.azEnd }); secRows.rebuild(); App.changed(); }),
      mode === '2d' ? h('div', { class: 'note' }, 'In 2D mode the wellbore stays in the section plane: azimuths snap to the section azimuth or its opposite.') : null,
    ]);
    const logCard = card('Logging interval and tool rotation', [
      h('div', { class: 'grid3' }, num('From MD', w, 'mdStart', { unit: 'm' }), num('To MD', w, 'mdEnd', { unit: 'm' }), num('Step', w, 'mdStep', { unit: 'm', min: 0.25, step: 0.5 })),
      num('Toolface', w, 'tf', { unit: '° from high side, clockwise looking down-hole', step: 5 }),
    ]);
    const gc = mode === '1d' ? [this.geo1Card()] : this.geo2Card();
    side.append(wellCard, logCard, ...gc);
    // main
    this.secHost = h('div'); this.slider = h('input', { type: 'range', min: 0, max: 100, step: 0.5, 'aria-label': 'Tool position along the well' }); this.cursorLbl = h('span', { class: 'sub' });
    this.slider.addEventListener('input', () => App.setCursor(parseFloat(this.slider.value)));
    this.angHost = h('div'); this.stats = h('div', { class: 'stat' });
    main.append(
      panel('Section view', 'click the well to place the tool', this.secHost, h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'lbl' }, 'Tool position'), h('div', { style: { flex: 1, minWidth: '160px' } }, this.slider), this.cursorLbl), this.stats),
      panel('Tool angle to bedding', 'positive when the tool heads toward deeper layers', this.angHost),
    );
    this.sec = new SectionChart(this.secHost, { height: 320, onPick: (md) => App.setCursor(md) });
    this.ang = new LineChart(this.angHost, { height: 170, xlabel: 'Measured depth (m)', ylabel: 'Angle (°)', group: 'md', toggle: false, xname: 'MD', tipfmt: (s, v) => fsig(v, 4) + '°' });
    this.update();
  },
  geo1Card() {
    const S = App.S, g = S.geo1, L = g.layers;
    const preset = h('select', null, h('option', { value: '' }, 'Load a preset…'), Object.keys(PRESETS_GEO1).map(k => h('option', { value: k }, k)));
    preset.addEventListener('change', () => { const p = PRESETS_GEO1[preset.value]; if (!p) return; S.geo1 = clone(p); App.rebuild(); App.changed(); });
    const tbl = tableEditor(L, [
      { label: '#', w: '22px', cell: (r, i) => h('span', { class: 'hint' }, String(i + 1)) },
      { label: 'Rh (Ω·m)', cell: cellNum('rh', { min: 0.01 }) }, { label: 'Rv (Ω·m)', cell: cellNum('rv', { min: 0.01 }) },
      { label: 'Thickness TVT (m)', cell: (r, i) => (i === 0 || i === L.length - 1) ? h('span', { class: 'hint' }, 'half-space') : numInput(r, 'tvt', { min: 0.1, step: 0.5 }) },
    ], { min: 1, onchange: () => { App.changed(); }, onstruct: () => { tbl.rebuild(); } });
    return card('Geology: planar dipping layers', [
      preset,
      h('div', { class: 'grid3' }, num('Dip', g, 'dip', { unit: '°', min: 0, max: 89, step: 0.5 }), num('Dip azimuth', g, 'dipAz', { unit: '°' }), num('Top of layer 2 at well start', g, 'z0', { unit: 'm TVD' })),
      h('div', { class: 'hint' }, 'Layer 1 is the upper half-space. The dip azimuth is the direction in which the layers get deeper. Rh is the resistivity along bedding, Rv across it.'),
      tbl, btn('Add layer below', () => { if (L.length >= 2) L[L.length - 1].tvt = L[L.length - 1].tvt || 6; const l = L[L.length - 1]; L.push({ rh: l.rh, rv: l.rv, tvt: 0 }); tbl.rebuild(); App.changed(); }),
    ]);
  },
  geo2Card() {
    const S = App.S, g = S.geo2;
    const preset = h('select', null, h('option', { value: '' }, 'Load a preset…'), Object.keys(PRESETS_GEO2).map(k => h('option', { value: k }, k)));
    preset.addEventListener('change', () => { const p = PRESETS_GEO2[preset.value]; if (!p) return; S.geo2 = clone(p); App.rebuild(); App.changed(); });
    const hz = g.horizons.map((H, k) => {
      const t = tableEditor(H.pts, [{ label: 'Section x (m)', cell: cellNumAt(0, { step: 5 }) }, { label: 'TVD z (m)', cell: cellNumAt(1, { step: 0.5 }) }], { min: 1, onchange: () => App.changed() });
      return h('div', null, h('div', { class: 'row sp' }, h('b', null, 'Boundary ' + (k + 1) + ' ', h('span', { class: 'hint' }, '(between layers ' + (k + 1) + ' and ' + (k + 2) + ')')), btn('Add point', () => { const l = H.pts[H.pts.length - 1]; H.pts.push([l[0] + 50, l[1]]); t.rebuild(); App.changed(); }, 'small')), t);
    });
    const ly = g.layers.map((Ly, k) => {
      const t = tableEditor(Ly.props, [{ label: 'x (m)', cell: cellNumAt(0, { step: 5 }) }, { label: 'Rh (Ω·m)', cell: cellNumAt(1, { min: 0.01 }) }, { label: 'Rv (Ω·m)', cell: cellNumAt(2, { min: 0.01 }) }], { min: 1, onchange: () => App.changed() });
      return h('div', null, h('div', { class: 'row sp' }, h('b', null, 'Layer ' + (k + 1)), btn('Add point', () => { const l = Ly.props[Ly.props.length - 1]; Ly.props.push([l[0] + 50, l[1], l[2]]); t.rebuild(); App.changed(); }, 'small')), t);
    });
    return [
      card('Geology: 2D section', [
        preset, num('Section azimuth', g, 'azSec', { unit: '° (x increases toward this azimuth)' }),
        h('div', { class: 'hint' }, 'Boundaries are piecewise-linear polylines z(x). Two points with the same x make a vertical fault step. Where a lower boundary crosses an upper one, the layer between them pinches out. Resistivity varies log-linearly between the control points of each layer.'),
        h('div', { class: 'row' }, btn('Add layer below', () => { const hzl = g.horizons[g.horizons.length - 1]; g.horizons.push({ pts: hzl.pts.map(p => [p[0], p[1] + 10]) }); const l = g.layers[g.layers.length - 1]; g.layers.push({ props: clone(l.props) }); App.rebuild(); App.changed(); }), btn('Remove last layer', () => { if (g.layers.length > 1) { g.horizons.pop(); g.layers.pop(); App.rebuild(); App.changed(); } })),
      ]),
      card('Boundaries', hz, { collapsible: true }), card('Layer resistivity', ly, { collapsible: true }),
    ];
  },
  cfgNow() { const cfg = cfgFromState(App.S); const tr = buildTrajectory(cfg.traj, 0.5); return { cfg, tr }; },
  update() { this.updateSection(true); },
  cursor() { this.updateSection(false); },
  updateSection(full) {
    const S = App.S, { cfg, tr } = this.cfgNow(), end = trajEnd(tr);
    S.cursorMd = clamp(S.cursorMd, tr.md[0], end); this.slider.min = tr.md[0]; this.slider.max = end; this.slider.value = S.cursorMd;
    this.cursorLbl.textContent = 'MD ' + fsig(S.cursorMd, 5) + ' m';
    this.sec.set(buildSection(S, cfg, tr, true));
    if (!full) return;
    const st = stationList(cfg, tr), ang = stationAngles(cfg, st);
    this.ang.set([{ name: 'Tool angle to bedding', color: cssColor('var(--s1)'), x: st.map(s => s.md), y: ang }], { hlines: [{ y: 0 }] });
    let dmin = Infinity, dmax = -Infinity; for (const p of st) { dmin = Math.min(dmin, p.D); dmax = Math.max(dmax, p.D); }
    this.stats.replaceChildren(h('span', null, 'Well length ', h('b', null, fsig(trajEnd(tr) - tr.md[0], 4) + ' m')), h('span', null, 'TVD ', h('b', null, fsig(dmin, 5) + ' to ' + fsig(dmax, 5) + ' m')), h('span', null, 'Stations ', h('b', null, String(st.length))), h('span', null, 'Layers ', h('b', null, String(nLayersOf(cfg)))));
  },
};
