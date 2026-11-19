// ===================================================================================
// chart.js -- small SVG chart kit: LineChart (hover readout, linked cursor), SectionChart (layers, well, tool)
// ===================================================================================
const SERIES_VARS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
const DASHES = ['', '7 3', '2 3', '8 3 2 3'];

class LineChart {
  constructor(host, o) {
    this.o = Object.assign({ height: 230, ml: 58, mr: 14, mt: 8, mb: 38, xlabel: '', ylabel: '', ylog: false, xlim: null, ylim: null, toggle: true, group: null, xfmt: null, yfmt: null, tipfmt: null, legend: true, xlog: false }, o || {});
    this.series = []; this.hidden = new Set(); this.syncX = null;
    this.legendEl = h('div', { class: 'legend' }); this.svg = h('s:svg'); this.tip = h('div', { class: 'tip', style: { display: 'none' } });
    this.wrap = h('div', { class: 'chart' }, this.legendEl, this.svg, this.tip); host.append(this.wrap);
    this.W = 0; this.ro = new ResizeObserver(() => { if (this.wrap.clientWidth !== this.W) this.draw(); }); this.ro.observe(this.wrap);
    this.svg.addEventListener('pointermove', (e) => this.move(e)); this.svg.addEventListener('pointerleave', () => this.leave());
    this.svg.addEventListener('click', () => { if (this.o.onClick && this.lastX !== undefined && this.lastX !== null) this.o.onClick(this.lastX); });
    if (this.o.group) { (LineChart.groups[this.o.group] = LineChart.groups[this.o.group] || new Set()).add(this); }
  }
  destroy() { this.ro.disconnect(); if (this.o.group && LineChart.groups[this.o.group]) LineChart.groups[this.o.group].delete(this); this.wrap.remove(); }
  set(series, opts) { this.series = series; if (opts) Object.assign(this.o, opts); this.draw(); }
  vis() { return this.series.filter(s => !this.hidden.has(s.name) && s.x && s.x.length); }
  ranges() {
    const o = this.o, vs = this.vis(); let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of vs) {
      for (let i = 0; i < s.x.length; i++) { const x = s.x[i]; if (x < x0) x0 = x; if (x > x1) x1 = x; }
      const ys = [s.y]; if (s.band) ys.push(s.band.lo, s.band.hi);
      for (const arr of ys) if (arr) for (let i = 0; i < arr.length; i++) { const y = arr[i]; if (!isFinite(y) || (o.ylog && y <= 0)) continue; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (o.xlim) { x0 = o.xlim[0]; x1 = o.xlim[1]; }
    else if (o.xlog && isFinite(x0) && x0 > 0) { x0 = Math.pow(10, Math.floor(Math.log10(x0) + 1e-9)); x1 = Math.pow(10, Math.ceil(Math.log10(x1) - 1e-9)); }
    if (!isFinite(x0) || x1 <= x0) { if (!isFinite(x0)) { x0 = 0; x1 = 1; } else { x0 -= 0.5; x1 += 0.5; } }
    if (!isFinite(y0)) { y0 = o.ylog ? 1 : 0; y1 = o.ylog ? 10 : 1; }
    if (o.ylim) { if (o.ylim[0] !== null && o.ylim[0] !== undefined) y0 = o.ylim[0]; if (o.ylim[1] !== null && o.ylim[1] !== undefined) y1 = o.ylim[1]; }
    else if (o.ylog) { y0 = Math.pow(10, Math.floor(Math.log10(y0) + 1e-9)); y1 = Math.pow(10, Math.ceil(Math.log10(y1) - 1e-9)); if (y1 <= y0) y1 = y0 * 10; }
    else { const pad = (y1 - y0) * 0.06 || Math.abs(y0) * 0.1 || 0.5; y0 -= pad; y1 += pad; }
    return { x0, x1, y0, y1 };
  }
  mkLegend() {
    const o = this.o; this.legendEl.replaceChildren(); this.legendEl.style.display = (o.legend && this.series.length > 1) || (o.legend && this.series.some(s => s.name && !s.noLegend && this.series.length > 1)) ? '' : 'none';
    if (this.series.length <= 1) this.legendEl.style.display = 'none';
    for (const s of this.series) {
      if (s.noLegend) continue;
      const k = h('s:svg', { viewBox: '0 0 22 8' }, h('s:line', { x1: 0, y1: 4, x2: 22, y2: 4, stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': s.dash || null, 'stroke-linecap': 'round' }));
      if (s.marker && s.line === false) { k.replaceChildren(h('s:circle', { cx: 11, cy: 4, r: 3, fill: s.color })); }
      const b = h('button', { type: 'button', 'aria-pressed': this.hidden.has(s.name) ? 'false' : 'true', title: o.toggle ? 'Show or hide' : '' }, k, s.name);
      if (o.toggle) b.addEventListener('click', () => { if (this.hidden.has(s.name)) this.hidden.delete(s.name); else this.hidden.add(s.name); this.draw(); if (this.o.onToggle) this.o.onToggle(s.name, !this.hidden.has(s.name)); });
      this.legendEl.append(b);
    }
  }
  draw() {
    const o = this.o, W = this.wrap.clientWidth; this.W = W; if (!W) return;
    this.mkLegend();
    const H = o.height, pw = W - o.ml - o.mr, ph = H - o.mt - o.mb, R = this.ranges(); this.R = R;
    const sx = o.xlog ? (x) => o.ml + (Math.log10(Math.max(x, 1e-300)) - Math.log10(R.x0)) / (Math.log10(R.x1) - Math.log10(R.x0)) * pw : (x) => o.ml + (x - R.x0) / (R.x1 - R.x0) * pw;
    const sy = o.ylog ? (y) => o.mt + ph - (Math.log10(Math.max(y, 1e-300)) - Math.log10(R.y0)) / (Math.log10(R.y1) - Math.log10(R.y0)) * ph : (y) => o.mt + ph - (y - R.y0) / (R.y1 - R.y0) * ph;
    this.sx = sx; this.sy = sy; this.pw = pw; this.ph = ph;
    const kids = [];
    const yt = o.ylog ? logTicks(R.y0, R.y1) : niceTicks(R.y0, R.y1, Math.max(3, Math.floor(ph / 42))), xt = o.xlog ? logTicks(R.x0, R.x1) : niceTicks(R.x0, R.x1, Math.max(3, Math.floor(pw / 80)));
    for (const v of yt) { const y = sy(v); kids.push(h('s:line', { class: 'gridline', x1: o.ml, x2: o.ml + pw, y1: y, y2: y })); kids.push(h('s:text', { x: o.ml - 7, y: y + 4, 'text-anchor': 'end' }, o.yfmt ? o.yfmt(v) : (o.ylog ? fsig(v, 2) : tickLabel(v, R.y1 - R.y0)))); }
    for (const v of xt) { const x = sx(v); kids.push(h('s:line', { class: 'gridline', x1: x, x2: x, y1: o.mt, y2: o.mt + ph })); kids.push(h('s:text', { x, y: o.mt + ph + 15, 'text-anchor': 'middle' }, o.xfmt ? o.xfmt(v) : (o.xlog ? fsig(v, 2) : tickLabel(v, R.x1 - R.x0)))); }
    kids.push(h('s:line', { class: 'axisline', x1: o.ml, x2: o.ml + pw, y1: o.mt + ph, y2: o.mt + ph }));
    kids.push(h('s:line', { class: 'axisline', x1: o.ml, x2: o.ml, y1: o.mt, y2: o.mt + ph }));
    if (o.xlabel) kids.push(h('s:text', { x: o.ml + pw / 2, y: H - 5, 'text-anchor': 'middle' }, o.xlabel));
    if (o.ylabel) kids.push(h('s:text', { x: 0, y: 0, transform: 'translate(12,' + (o.mt + ph / 2) + ') rotate(-90)', 'text-anchor': 'middle' }, o.ylabel));
    if (o.hlines) for (const hl of o.hlines) { if (hl.y < R.y0 || hl.y > R.y1) continue; kids.push(h('s:line', { x1: o.ml, x2: o.ml + pw, y1: sy(hl.y), y2: sy(hl.y), stroke: css('--ink-2'), 'stroke-width': 1, 'stroke-opacity': 0.6 })); if (hl.label) kids.push(h('s:text', { x: o.ml + pw - 3, y: sy(hl.y) - 4, 'text-anchor': 'end' }, hl.label)); }
    kids.push(h('s:clipPath', { id: 'cp' + (this.uid = this.uid || Math.random().toString(36).slice(2, 8)) }, h('s:rect', { x: o.ml, y: o.mt - 2, width: pw, height: ph + 4 })));
    const g = h('s:g', { 'clip-path': 'url(#cp' + this.uid + ')' });
    for (const s of this.vis()) {
      if (s.band) {
        let d = '', n = s.x.length, started = false;
        for (let i = 0; i < n; i++) { const lo = s.band.lo[i], hi = s.band.hi[i]; if (!isFinite(lo) || !isFinite(hi)) continue; d += (started ? 'L' : 'M') + sx(s.x[i]).toFixed(1) + ' ' + sy(hi).toFixed(1); started = true; }
        for (let i = n - 1; i >= 0; i--) { const lo = s.band.lo[i], hi = s.band.hi[i]; if (!isFinite(lo) || !isFinite(hi)) continue; d += 'L' + sx(s.x[i]).toFixed(1) + ' ' + sy(lo).toFixed(1); }
        if (d) g.append(h('s:path', { d: d + 'Z', fill: s.color, 'fill-opacity': 0.14 }));
      }
      if (s.line !== false) {
        let d = '', pen = false, py = null;
        for (let i = 0; i < s.x.length; i++) {
          const y = s.y[i]; if (!isFinite(y) || (o.ylog && y <= 0)) { pen = false; continue; }
          const px = sx(s.x[i]), qy = sy(y);
          if (!pen) { d += 'M' + px.toFixed(1) + ' ' + qy.toFixed(1); pen = true; }
          else if (s.step) d += 'L' + px.toFixed(1) + ' ' + py.toFixed(1) + 'L' + px.toFixed(1) + ' ' + qy.toFixed(1);
          else d += 'L' + px.toFixed(1) + ' ' + qy.toFixed(1);
          py = qy;
        }
        if (d) g.append(h('s:path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-dasharray': s.dash || null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: s.opacity || 1 }));
      }
      if (s.marker) {
        const r = typeof s.marker === 'number' ? s.marker : 2.2, step = Math.max(1, Math.floor(s.x.length / 600)); let d = '';
        for (let i = 0; i < s.x.length; i += step) { const y = s.y[i]; if (!isFinite(y) || (o.ylog && y <= 0)) continue; const px = sx(s.x[i]), qy = sy(y); d += 'M' + (px - r).toFixed(1) + ' ' + qy.toFixed(1) + 'a' + r + ' ' + r + ' 0 1 0 ' + (2 * r) + ' 0a' + r + ' ' + r + ' 0 1 0 ' + (-2 * r) + ' 0'; }
        if (d) g.append(h('s:path', { d, fill: s.color, stroke: css('--surface'), 'stroke-width': 0.8 }));
      }
    }
    kids.push(g);
    this.xhair = h('s:line', { class: 'xhair', y1: o.mt, y2: o.mt + ph, style: { display: 'none' } });
    this.syncLine = h('s:line', { class: 'sync', y1: o.mt, y2: o.mt + ph, style: { display: 'none' } });
    this.curLine = h('s:line', { class: 'cur', y1: o.mt, y2: o.mt + ph, style: { display: 'none' } });
    kids.push(this.curLine, this.syncLine, this.xhair);
    this.svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); this.svg.setAttribute('height', H); this.svg.replaceChildren(...kids);
    if (this.syncX !== null) this.setSync(this.syncX);
    if (this.curX !== undefined) this.setCursorX(this.curX);
  }
  setCursorX(x) {
    this.curX = x; if (!this.curLine) return;
    if (x === null || x === undefined || !this.R || x < this.R.x0 || x > this.R.x1) { this.curLine.style.display = 'none'; return; }
    const X = this.sx(x); this.curLine.setAttribute('x1', X); this.curLine.setAttribute('x2', X); this.curLine.style.display = '';
  }
  nearest(s, x) {                                     // binary search in ascending x
    const a = s.x; let lo = 0, hi = a.length - 1; if (a[hi] < a[0]) return -1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m; else hi = m; }
    return Math.abs(a[lo] - x) <= Math.abs(a[hi] - x) ? lo : hi;
  }
  move(e) {
    if (!this.R) return; const o = this.o, r = this.svg.getBoundingClientRect(), px = (e.clientX - r.left) * (this.W / r.width);
    if (px < o.ml || px > o.ml + this.pw) return this.leave();
    let x = this.R.x0 + (px - o.ml) / this.pw * (this.R.x1 - this.R.x0), vs = this.vis(); if (!vs.length) return;
    if (o.xlog) x = Math.pow(10, Math.log10(this.R.x0) + (px - o.ml) / this.pw * (Math.log10(this.R.x1) - Math.log10(this.R.x0)));
    const i0 = this.nearest(vs[0], x); if (i0 < 0) return; const xs = vs[0].x[i0], X = this.sx(xs); this.lastX = xs;
    this.xhair.setAttribute('x1', X); this.xhair.setAttribute('x2', X); this.xhair.style.display = '';
    const tipc = [h('div', { class: 'tx' }, (o.xname || o.xlabel || 'x') + ' ' + (o.xfmt ? o.xfmt(xs) : fsig(xs, 5)))];
    for (const s of vs) {
      if (s.noTip) continue; const i = this.nearest(s, xs); if (i < 0) continue; const v = s.y[i]; if (!isFinite(v)) continue;
      const txt = o.tipfmt ? o.tipfmt(s, v, i) : fsig(v, 4);
      tipc.push(h('div', { class: 'tr' }, h('span', { class: 'k', style: { borderColor: s.color, borderTopStyle: s.dash ? 'dashed' : 'solid' } }), h('b', null, txt), h('span', { class: 'n' }, s.name)));
    }
    this.tip.replaceChildren(...tipc); this.tip.style.display = '';
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight; let tx = X + 12; if (tx + tw > this.W - 4) tx = X - 12 - tw;
    const ty = Math.max(4, Math.min(o.height - th - 4, (e.clientY - r.top) - th / 2)); this.tip.style.left = tx + 'px'; this.tip.style.top = (ty + (this.legendEl.offsetHeight || 0) + (this.legendEl.style.display === 'none' ? 0 : 6)) + 'px';
    if (o.group) for (const c of LineChart.groups[o.group]) if (c !== this) c.setSync(xs);
    if (o.onHover) o.onHover(xs);
  }
  leave() {
    this.xhair && (this.xhair.style.display = 'none'); this.tip.style.display = 'none';
    if (this.o.group) for (const c of LineChart.groups[this.o.group]) if (c !== this) c.setSync(null);
  }
  setSync(x) {
    this.syncX = x; if (!this.syncLine) return;
    if (x === null || !this.R || x < this.R.x0 || x > this.R.x1) { this.syncLine.style.display = 'none'; return; }
    const X = this.sx(x); this.syncLine.setAttribute('x1', X); this.syncLine.setAttribute('x2', X); this.syncLine.style.display = '';
  }
}
LineChart.groups = {};

// ---------------------------------------------------------------------------------------------------------
// SectionChart: vertical section (x = along-section distance, z = TVD down).  sec = {
//   x0,x1,z0,z1, slices:[{x0,x1,zt0,zb0,zt1,zb1,color}], lines:[{pts,color,w,dash,name}], well:[[x,z,md]...], tool:{pts, dots},
//   points:[{x,z,color,r}], probe:(x,z)=>string }
class SectionChart {
  constructor(host, o) {
    this.o = Object.assign({ height: 300, ml: 58, mr: 14, mt: 8, mb: 36 }, o || {});
    this.svg = h('s:svg'); this.tip = h('div', { class: 'tip', style: { display: 'none' } }); this.cb = h('div');
    this.wrap = h('div', { class: 'chart' }, this.svg, this.tip, this.cb); host.append(this.wrap); this.sec = null; this.W = 0;
    this.ro = new ResizeObserver(() => { if (this.wrap.clientWidth !== this.W) this.draw(); }); this.ro.observe(this.wrap);
    this.svg.addEventListener('pointermove', (e) => this.move(e)); this.svg.addEventListener('pointerleave', () => { this.tip.style.display = 'none'; });
    this.svg.addEventListener('click', (e) => this.click(e));
  }
  set(sec) { this.sec = sec; this.draw(); }
  destroy() { this.ro.disconnect(); this.wrap.remove(); }
  draw() {
    const sec = this.sec, o = this.o, W = this.wrap.clientWidth; this.W = W; if (!sec || !W) return;
    const H = o.height, pw = W - o.ml - o.mr, ph = H - o.mt - o.mb;
    const sx = (x) => o.ml + (x - sec.x0) / (sec.x1 - sec.x0) * pw, sz = (z) => o.mt + (z - sec.z0) / (sec.z1 - sec.z0) * ph;
    this.sx = sx; this.sz = sz; this.pw = pw; this.ph = ph;
    const kids = [], uid = this.uid = this.uid || Math.random().toString(36).slice(2, 8);
    kids.push(h('s:clipPath', { id: 'sp' + uid }, h('s:rect', { x: o.ml, y: o.mt, width: pw, height: ph })));
    const g = h('s:g', { 'clip-path': 'url(#sp' + uid + ')' });
    const byColor = new Map();
    for (const q of sec.slices || []) {
      const d = 'M' + sx(q.x0).toFixed(1) + ' ' + sz(q.zt0).toFixed(1) + 'L' + sx(q.x1).toFixed(1) + ' ' + sz(q.zt1).toFixed(1) + 'L' + sx(q.x1).toFixed(1) + ' ' + sz(q.zb1).toFixed(1) + 'L' + sx(q.x0).toFixed(1) + ' ' + sz(q.zb0).toFixed(1) + 'Z';
      byColor.set(q.color, (byColor.get(q.color) || '') + d);
    }
    for (const [c, d] of byColor) g.append(h('s:path', { d, fill: c, stroke: c, 'stroke-width': 0.6 }));
    for (const l of sec.lines || []) {
      let d = ''; l.pts.forEach((p, i) => { d += (i ? 'L' : 'M') + sx(p[0]).toFixed(1) + ' ' + sz(p[1]).toFixed(1); });
      g.append(h('s:path', { d, fill: 'none', stroke: l.color, 'stroke-width': l.w || 1.2, 'stroke-dasharray': l.dash || null, 'stroke-linejoin': 'round', opacity: l.opacity || 1 }));
    }
    if (sec.well && sec.well.length) {
      let d = ''; sec.well.forEach((p, i) => { d += (i ? 'L' : 'M') + sx(p[0]).toFixed(1) + ' ' + sz(p[1]).toFixed(1); });
      g.append(h('s:path', { d, fill: 'none', stroke: css('--surface'), 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      g.append(h('s:path', { d, fill: 'none', stroke: css('--ink'), 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    for (const p of sec.points || []) g.append(h('s:circle', { cx: sx(p.x), cy: sz(p.z), r: p.r || 2.5, fill: p.color, stroke: css('--surface'), 'stroke-width': 0.8, opacity: p.opacity || 1 }));
    if (sec.tool) {
      const t = sec.tool; let d = ''; t.pts.forEach((p, i) => { d += (i ? 'L' : 'M') + sx(p[0]).toFixed(1) + ' ' + sz(p[1]).toFixed(1); });
      g.append(h('s:path', { d, fill: 'none', stroke: css('--surface'), 'stroke-width': 8, 'stroke-linecap': 'round' }));
      g.append(h('s:path', { d, fill: 'none', stroke: css('--s2'), 'stroke-width': 5, 'stroke-linecap': 'round' }));
      for (const p of t.dots || []) g.append(h('s:circle', { cx: sx(p[0]), cy: sz(p[1]), r: 3.4, fill: css('--surface'), stroke: css('--ink'), 'stroke-width': 1.4 }));
    }
    kids.push(g);
    const zt = niceTicks(sec.z0, sec.z1, Math.max(3, Math.floor(ph / 40))), xt = niceTicks(sec.x0, sec.x1, Math.max(3, Math.floor(pw / 90)));
    for (const v of zt) { const y = sz(v); kids.push(h('s:line', { x1: o.ml - 4, x2: o.ml, y1: y, y2: y, class: 'axisline' })); kids.push(h('s:text', { x: o.ml - 7, y: y + 4, 'text-anchor': 'end' }, tickLabel(v, sec.z1 - sec.z0))); }
    for (const v of xt) { const x = sx(v); kids.push(h('s:line', { x1: x, x2: x, y1: o.mt + ph, y2: o.mt + ph + 4, class: 'axisline' })); kids.push(h('s:text', { x, y: o.mt + ph + 16, 'text-anchor': 'middle' }, tickLabel(v, sec.x1 - sec.x0))); }
    kids.push(h('s:rect', { x: o.ml, y: o.mt, width: pw, height: ph, fill: 'none', class: 'axisline' }));
    kids.push(h('s:text', { x: o.ml + pw / 2, y: H - 5, 'text-anchor': 'middle' }, sec.xlabel || 'Vertical section (m)'));
    kids.push(h('s:text', { x: 0, y: 0, transform: 'translate(12,' + (o.mt + ph / 2) + ') rotate(-90)', 'text-anchor': 'middle' }, 'TVD (m)'));
    const ve = (ph / (sec.z1 - sec.z0)) / (pw / (sec.x1 - sec.x0)); kids.push(h('s:text', { x: o.ml + pw - 4, y: o.mt + 13, 'text-anchor': 'end' }, 'vertical exaggeration ×' + fsig(ve, 2)));
    this.xhair = h('s:g', { style: { display: 'none' } }, h('s:line', { class: 'xhair', y1: o.mt, y2: o.mt + ph }), h('s:line', { class: 'xhair', x1: o.ml, x2: o.ml + pw }));
    kids.push(this.xhair);
    this.svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); this.svg.setAttribute('height', H); this.svg.replaceChildren(...kids);
    // colour bar
    this.cb.replaceChildren();
    if (sec.cbar) {
      const c = sec.cbar, stops = []; for (let i = 0; i <= 12; i++) stops.push(c.color(i / 12) + ' ' + (i / 12 * 100).toFixed(0) + '%');
      const ticks = logTicks(c.min, c.max).filter((v, i, a) => a.length <= 6 || Math.log10(v) % 1 === 0);
      const lab = h('div', { style: { position: 'relative', height: '15px', marginLeft: o.ml + 'px', marginRight: o.mr + 'px' } });
      for (const v of ticks) { const f = (Math.log10(v) - Math.log10(c.min)) / (Math.log10(c.max) - Math.log10(c.min)); lab.append(h('span', { style: { position: 'absolute', left: (f * 100) + '%', transform: 'translateX(-50%)', fontSize: '11px', color: css('--muted') } }, fsig(v, 2))); }
      this.cb.append(h('div', { class: 'colorbar', style: { marginLeft: o.ml + 'px', marginRight: o.mr + 'px', marginTop: '6px', background: 'linear-gradient(90deg,' + stops.join(',') + ')' } }), lab, h('div', { class: 'lbl', style: { marginLeft: o.ml + 'px' } }, (c.label || 'Horizontal resistivity (Ω·m), log scale')));
    }
  }
  loc(e) { const r = this.svg.getBoundingClientRect(), px = (e.clientX - r.left) * (this.W / r.width), py = (e.clientY - r.top) * (this.o.height / r.height); return { px, py }; }
  move(e) {
    const sec = this.sec; if (!sec) return; const o = this.o, { px, py } = this.loc(e);
    if (px < o.ml || px > o.ml + this.pw || py < o.mt || py > o.mt + this.ph) { this.xhair.style.display = 'none'; this.tip.style.display = 'none'; return; }
    const x = sec.x0 + (px - o.ml) / this.pw * (sec.x1 - sec.x0), z = sec.z0 + (py - o.mt) / this.ph * (sec.z1 - sec.z0);
    const [v, hz] = this.xhair.children; v.setAttribute('x1', px); v.setAttribute('x2', px); hz.setAttribute('y1', py); hz.setAttribute('y2', py); this.xhair.style.display = '';
    const rows = [h('div', { class: 'tx' }, 'VS ' + fsig(x, 5) + ' m   TVD ' + fsig(z, 5) + ' m')];
    if (sec.probe) { const t = sec.probe(x, z); if (t) for (const line of String(t).split('\n')) rows.push(h('div', { class: 'tr' }, h('b', null, line))); }
    this.tip.replaceChildren(...rows); this.tip.style.display = '';
    const tw = this.tip.offsetWidth; let tx = px + 14; if (tx + tw > this.W - 4) tx = px - 14 - tw; this.tip.style.left = tx + 'px'; this.tip.style.top = Math.max(4, py - 20) + 'px';
  }
  click(e) {
    const sec = this.sec; if (!sec || !sec.well || !this.o.onPick) return; const { px, py } = this.loc(e); let best = null, bd = 28 * 28;
    for (const p of sec.well) { const dx = this.sx(p[0]) - px, dz = this.sz(p[1]) - py, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = p; } }
    if (best) this.o.onPick(best[2]);
  }
}
