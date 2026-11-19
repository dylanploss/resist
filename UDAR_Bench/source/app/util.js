// ===================================================================================
// util.js -- DOM helpers, formatting, ticks, colour ramps
// ===================================================================================
const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
function h(tag, attrs, ...kids) {
  const el = tag.startsWith('s:') ? document.createElementNS(SVGNS, tag.slice(2)) : document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k]; if (v == null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'value' && !tag.startsWith('s:')) el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) { if (c == null || c === false) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return el;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
function getp(o, path) { let c = o; for (const k of String(path).split('.')) { if (c == null) return undefined; c = c[k]; } return c; }
function setp(o, path, v) { const ks = String(path).split('.'); let c = o; for (let i = 0; i < ks.length - 1; i++) c = c[ks[i]]; c[ks[ks.length - 1]] = v; }
function debounce(fn, ms) { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function fmt(v, d) {                       // fixed decimals, trimmed
  if (v === undefined || v === null || Number.isNaN(v)) return '–';
  if (!isFinite(v)) return v > 0 ? '∞' : '−∞';
  d = d === undefined ? 2 : d; let s = v.toFixed(d);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s.replace('-', '−');
}
function fsig(v, n) {                      // significant digits, no exponent for moderate values
  if (v === undefined || v === null || Number.isNaN(v)) return '–'; if (!isFinite(v)) return v > 0 ? '∞' : '−∞'; if (v === 0) return '0';
  const a = Math.abs(v); n = n || 3;
  if (a >= 1e5 || a < 1e-3) return v.toExponential(n - 1).replace('e+', 'e').replace('-', '−');
  const d = Math.max(0, n - 1 - Math.floor(Math.log10(a))); return fmt(v, d);
}
function fmtDur(sec) {                     // durations for status lines
  if (!isFinite(sec)) return '–'; if (sec < 1) return fsig(sec, 2) + ' s'; if (sec < 60) return Math.round(sec) + ' s';
  if (sec < 3600) return fsig(sec / 60, 2) + ' min'; return fsig(sec / 3600, 2) + ' h';
}
function niceStep(range, n) {
  const raw = range / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
function niceTicks(lo, hi, n) {
  if (!(hi > lo)) return [lo]; const st = niceStep(hi - lo, n || 6), out = [];
  for (let v = Math.ceil(lo / st - 1e-9) * st; v <= hi + st * 1e-9; v += st) out.push(Math.abs(v) < st * 1e-9 ? 0 : +v.toPrecision(12));
  return out;
}
function logTicks(lo, hi) {                // decades (and 2,5 when few decades)
  const out = [], a = Math.floor(Math.log10(lo)), b = Math.ceil(Math.log10(hi)), few = b - a <= 3;
  for (let e = a; e <= b; e++) for (const m of (few ? [1, 2, 5] : [1])) { const v = m * Math.pow(10, e); if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v); }
  return out;
}
function tickLabel(v, span) {
  if (v === 0) return '0'; const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(0).replace('e+', 'e').replace('-', '−');
  const dec = span !== undefined && span > 0 ? Math.max(0, -Math.floor(Math.log10(span / 5))) : 0;
  return fmt(v, Math.min(6, dec));
}

// ---- colour: sequential resistivity ramp (validated blue ramp); light theme: low R light -> high R dark, dark theme reversed
const BLUE = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
function hex2rgb(x) { return [parseInt(x.slice(1, 3), 16), parseInt(x.slice(3, 5), 16), parseInt(x.slice(5, 7), 16)]; }
const BLUE_RGB = BLUE.map(hex2rgb);
function rampColor(t, dark) {
  t = clamp(t, 0, 1); if (dark) t = 1 - t; const x = t * (BLUE_RGB.length - 1), i = Math.min(BLUE_RGB.length - 2, Math.floor(x)), f = x - i;
  const a = BLUE_RGB[i], b = BLUE_RGB[i + 1];
  let r = a[0] + (b[0] - a[0]) * f, g = a[1] + (b[1] - a[1]) * f, bl = a[2] + (b[2] - a[2]) * f;
  if (dark) { r *= 0.8; g *= 0.8; bl *= 0.8; }
  return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(bl) + ')';
}
const isDark = () => { const t = document.documentElement.getAttribute('data-theme'); return t ? t === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; };
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// pick-a-name helpers for channels
const COMP = { Z: 'Z', X: 'X', Y: 'Y', T: 'T' };
function antName(o) { return o.k === 'T' ? 'T(' + fmt(o.th, 0) + '°,' + fmt(o.ph, 0) + '°)' : o.k; }
function chanName(c) { return antName(c.tx) + antName(c.rx) + ' ' + fmt(c.L, 2) + ' m ' + fmt(c.f, 3) + ' kHz'; }
function chanShort(c) { return antName(c.tx) + antName(c.rx); }

function toCSV(rows) { return rows.map(r => r.map(v => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n'); }
