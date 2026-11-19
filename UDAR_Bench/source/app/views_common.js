// ===================================================================================
// views_common.js -- form helpers shared by the tabs
// ===================================================================================
let _uid = 0;
const uid = () => 'f' + (++_uid);
function field(label, input, o) { o = o || {}; return h('label', { class: 'fld', title: o.title || null }, h('span', null, label, o.unit ? h('small', null, o.unit) : null), input); }
function numInput(obj, key, o) {
  o = o || {}; const inp = h('input', { type: 'number', step: o.step === undefined ? 'any' : o.step, min: o.min, max: o.max, value: obj[key], id: uid() });
  inp.addEventListener('input', () => { const v = parseFloat(inp.value); if (isFinite(v)) { obj[key] = v; (o.onchange || App.changed.bind(App))(inp); } });
  inp.addEventListener('change', () => { if (!isFinite(parseFloat(inp.value))) inp.value = obj[key]; });
  inp.sync = () => { if (document.activeElement !== inp) inp.value = obj[key]; };
  return inp;
}
function num(label, obj, key, o) { o = o || {}; return field(label, numInput(obj, key, o), o); }
function selInput(obj, key, options, o) {
  o = o || {}; const inp = h('select', { id: uid() }, options.map(op => h('option', { value: op[0] }, op[1])));
  inp.value = obj[key]; inp.addEventListener('change', () => { const v = o.num ? parseFloat(inp.value) : inp.value; obj[key] = v; (o.onchange || App.changed.bind(App))(inp); });
  return inp;
}
function sel(label, obj, key, options, o) { o = o || {}; return field(label, selInput(obj, key, options, o), o); }
function chk(label, obj, key, o) {
  o = o || {}; const inp = h('input', { type: 'checkbox', checked: !!obj[key], id: uid() });
  inp.addEventListener('change', () => { obj[key] = inp.checked; (o.onchange || App.changed.bind(App))(inp); });
  return h('label', { class: 'chk', title: o.title || null }, inp, label);
}
function btn(label, fn, cls, title) { return h('button', { type: 'button', class: 'btn ' + (cls || ''), onclick: fn, title: title || null }, label); }
function card(title, body, o) {
  o = o || {}; const c = h('section', { class: 'card' + (o.collapsed ? ' collapsed' : '') });
  const hd = h('header', null, h('h3', null, title), ...(o.actions || []));
  if (o.collapsible) { const t = h('button', { type: 'button', class: 'icon-btn', title: 'Collapse or expand', style: { width: '24px', height: '22px' }, onclick: () => c.classList.toggle('collapsed') }, '⌄'); hd.append(t); }
  c.append(hd, h('div', { class: 'body' }, body)); return c;
}
function panel(title, sub, ...kids) { return h('section', { class: 'panel' }, h('div', { class: 'ph' }, h('h3', null, title), sub ? h('span', { class: 'sub' }, sub) : null, h('span', { class: 'grow' })), ...kids); }

// editable table of row objects. cols: [{label, w, cell:(row,i,rerender)=>element}]
function tableEditor(rows, cols, o) {
  o = o || {}; const wrap = h('div', { class: 'tbl-wrap' });
  const build = () => {
    const tb = h('tbody');
    rows.forEach((row, i) => {
      const tr = h('tr');
      for (const c of cols) tr.append(h('td', { style: c.w ? { width: c.w } : null }, c.cell(row, i, build)));
      if (!o.fixed && (o.min === undefined || rows.length > o.min)) tr.append(h('td', { class: 'x' }, h('button', { type: 'button', class: 'rm', title: 'Remove row', onclick: () => { rows.splice(i, 1); build(); (o.onchange || App.changed.bind(App))(); if (o.onstruct) o.onstruct(); } }, '×')));
      else tr.append(h('td', { class: 'x' }));
      tb.append(tr);
    });
    const table = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, cols.map(c => h('th', null, c.label)), h('th'))), tb);
    wrap.replaceChildren(table);
  };
  build(); wrap.rebuild = build; return wrap;
}
function cellNum(key, o) { o = o || {}; return (row) => numInput(row, key, o); }
function cellNumAt(idx, o) { o = o || {}; return (row) => numInput(row, idx, o); }

// modal text dialog (copy / save fallback)
function showDialog(title, text, filename) {
  const ta = h('textarea', { readonly: true }); ta.value = text;
  const close = () => back.remove();
  const back = h('div', { class: 'dialog-back', onclick: (e) => { if (e.target === back) close(); } }, h('div', { class: 'dialog', role: 'dialog', 'aria-label': title },
    h('div', { class: 'row sp' }, h('h3', null, title), btn('Close', close, 'small')), ta,
    h('div', { class: 'row' }, btn('Copy to clipboard', async () => { try { await navigator.clipboard.writeText(text); } catch (e) { ta.select(); document.execCommand && document.execCommand('copy'); } }, 'primary'), h('span', { class: 'hint' }, filename ? 'Suggested file name: ' + filename : ''))));
  document.body.append(back); ta.focus(); ta.select();
}
async function saveFile(filename, text) {
  try { if (window.claude && window.claude.use) { const d = await window.claude.use('downloads'); if (d) { await d.save({ filename, data: text }); return; } } } catch (e) { if (e && e.code === 'declined') return; }
  showDialog('Export: ' + filename, text, filename);
}
