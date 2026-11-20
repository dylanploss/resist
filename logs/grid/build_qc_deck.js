// Build the inversion QC deck from logs/grid/deck_data.json.
//   NODE_PATH=<scratch>/deck/node_modules node build.js <deck_data.json> <out.pptx>
const pptxgen = require("pptxgenjs");
const fs = require("fs");
const { applyTheme } = require(process.env.SKILL_DIR + "/scripts/apply_theme.js");

const [dataPath, outPath] = process.argv.slice(2);
const D = JSON.parse(fs.readFileSync(dataPath, "utf8"));

const THEME = {
  name: "Resist QC",
  headFontFace: "Segoe UI Semibold",
  bodyFontFace: "Segoe UI",
  colors: {
    dk1: "1B2638", lt1: "FFFFFF", dk2: "1E2B45", lt2: "EEF2F7",
    accent1: "2E75B6", accent2: "E07A1F", accent3: "3A8F5C", accent4: "5A6478",
    accent5: "C0392B", accent6: "8FA8C8", hlink: "2E75B6", folHlink: "5A6478",
  },
};
const HEX = THEME.colors;
const AXIS = "5A6478", GRID = "E2E8F0";

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 in
pres.title = "Inversion QC: systematic discrepancies and fixes";
pres.author = "Resist team";
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
const C = pres.SchemeColor;

const W = 13.333, M = 0.6, CW = W - 2 * M; // content width 12.13
const FOOT = "Resist · inversion QC · 20 Nov 2026";

// ---------------------------------------------------------------- layouts
pres.defineSlideMaster({
  title: "DARK",
  background: { color: C.text2 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: M, y: 1.7, w: CW, h: 1.7, fontSize: 40, bold: true,
        color: C.background1, valign: "bottom", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: M, y: 3.6, w: CW, h: 1.1, fontSize: 18,
        color: C.accent6, valign: "top", align: "left", margin: 0 }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "CLOSING",
  background: { color: C.text2 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: M, y: 0.9, w: CW, h: 1.0, fontSize: 36, bold: true,
        color: C.background1, valign: "bottom", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: M, y: 2.05, w: CW, h: 0.6, fontSize: 18,
        color: C.accent6, valign: "top", align: "left", margin: 0 }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "CONTENT",
  background: { color: C.background1 },
  margin: [0.5, 0.6, 0.7, 0.6],
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: M, y: 0.35, w: CW, h: 0.75, fontSize: 30, bold: true,
        color: C.text2, valign: "middle", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: M, y: 1.08, w: CW, h: 0.45, fontSize: 16,
        color: C.accent4, valign: "top", align: "left", margin: 0 }, text: "" } },
    { text: { text: FOOT, options: { x: M, y: 7.0, w: 6, h: 0.3, fontSize: 10, color: C.accent4, margin: 0 } } },
  ],
  slideNumber: { x: W - M - 0.6, y: 7.0, w: 0.6, h: 0.3, fontSize: 10, color: C.accent4, align: "right" },
});

let n = 0;
function content(title, kicker, notes, section) {
  if (section) pres.addSection({ title: section });
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: content.section = section || content.section });
  s.addText(title, { placeholder: "title" });
  if (kicker) s.addText(kicker, { placeholder: "body" });
  if (notes) s.addNotes(notes);
  n++;
  return s;
}

// ---------------------------------------------------------------- helpers
function card(s, x, y, w, h, opts = {}) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y, w, h, rectRadius: 0.08, fill: { color: opts.fill || C.background2 }, line: { color: opts.fill || C.background2 },
    objectName: opts.name || "card",
  });
}
function badge(s, x, y, label, color) {
  s.addShape(pres.shapes.OVAL, { x, y, w: 0.5, h: 0.5, fill: { color }, line: { color }, objectName: "badge " + label });
  s.addText(label, { x, y, w: 0.5, h: 0.5, fontSize: 16, bold: true, color: C.background1, align: "center",
    valign: "middle", margin: 0, isTextBox: true, objectName: "badge text " + label });
}
function bullets(s, items, x, y, w, h, size = 15) {
  s.addText(items.map((t, i) => {
    const runs = Array.isArray(t) ? t : [{ text: t }];
    return runs.map((r, j) => ({ text: r.text, options: { ...(r.options || {}), bullet: j === 0 ? { indent: 15 } : undefined,
      breakLine: j === runs.length - 1 && i < items.length - 1, paraSpaceAfter: 8 } }));
  }).flat(), { x, y, w, h, fontSize: size, color: C.text1, valign: "top", margin: 0, isTextBox: true });
}
function fixBox(s, text, x, y, w, h) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.08, fill: { color: C.accent3, transparency: 88 },
    line: { color: C.accent3, width: 1 }, objectName: "fix box" });
  s.addText([{ text: "Fix  ", options: { bold: true, color: C.accent3 } }, { text, options: { color: C.text1 } }],
    { x: x + 0.2, y, w: w - 0.4, h, fontSize: 15, valign: "middle", margin: 0, isTextBox: true, objectName: "fix text" });
}
function chartBase(extra) {
  return {
    catAxisLabelFontFace: "+mn-lt", valAxisLabelFontFace: "+mn-lt", dataLabelFontFace: "+mn-lt",
    titleFontFace: "+mn-lt", legendFontFace: "+mn-lt",
    catAxisLabelColor: AXIS, valAxisLabelColor: AXIS, catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
    valGridLine: { color: GRID, size: 1 }, catGridLine: { style: "none" },
    catAxisLineShow: true, catAxisLineColor: "C9D2DE", valAxisLineShow: false,
    dataLabelFontSize: 10, dataLabelColor: "1B2638", titleColor: "1B2638", titleFontSize: 13, legendFontSize: 11,
    legendColor: "1B2638", ...extra,
  };
}
const invLabel = (() => {
  const count = {}, seen = {};
  D.inversions.forEach(i => (count[i.well] = (count[i.well] || 0) + 1));
  return i => {
    if (count[i.well] === 1) return i.well;
    seen[i.well] = (seen[i.well] || 0) + 1;
    return `${i.well} ${String.fromCharCode(96 + seen[i.well])}`;
  };
})();
const INV = D.inversions.map(i => ({ ...i, label: invLabel(i) }));

// ---------------------------------------------------------------- 1. title
pres.addSection({ title: "Summary" });
content.section = "Summary";
{
  const s = pres.addSlide({ masterName: "DARK", sectionTitle: "Summary" });
  s.addText("Inversion QC: systematic discrepancies and how to fix them", { placeholder: "title" });
  s.addText("Halliburton ADR, 1.5D curtain inversion · 6 Ekofisk wells · 20 Nov 2026", { placeholder: "body" });
  const stats = [[String(D.n_inversions), "inversions QC'd"], [String(D.wells.length), "wells of 11"], [String(D.n_slices), "fitted slices"]];
  stats.forEach(([v, l], k) => {
    const x = M + k * 3.2;
    s.addText(v, { x, y: 5.0, w: 3.0, h: 0.9, fontSize: 48, bold: true, color: C.background1, margin: 0, isTextBox: true,
      fontFace: THEME.headFontFace, objectName: "stat " + l });
    s.addText(l, { x, y: 5.9, w: 3.0, h: 0.4, fontSize: 14, color: C.accent6, margin: 0, isTextBox: true, objectName: "stat label " + l });
  });
  s.addNotes("QC of the 1.5D curtain inversions stored in data/graph/inversions.json: 5 new full-quality runs " +
    "(one 40 ft window per well, 30-minute budget) plus 8 earlier runs on VC-2 and Z-20. Scripts and raw tables: logs/grid/.");
}

// ---------------------------------------------------------------- 2. summary
{
  const s = content("Five systematic discrepancies, two of them break fits", null,
    "Severity: 1 and 2 change results directly (a failed inversion; a biased channel family that also distorts anisotropy). " +
    "3 is a consequence of 2. 4 affects every fit's weighting. 5 is weaker evidence and needs an A/B test.");
  const items = [
    ["1", "Clipped readings are fitted as data", "2000 Ω·m tool ceilings pass the loader. The VC-3 fit failed (misfit 14).", C.accent2],
    ["2", "2 MHz attenuation reads high", "×1.0 at 3 Ω·m up to ×1.66 near 10 Ω·m. Matches a dielectric effect, not one calibration.", C.accent2],
    ["3", "Anisotropy hits its lower bound","8 of 13 inversions end with Rv/Rh below 1.2. All of them fit 2 MHz attenuation.", C.accent1],
    ["4", "Noise sigmas are too small", "Fitted channels miss by 1.1–1.6× their sigma, 500 kHz ZR attenuation by 3.3×.", C.accent1],
    ["5", "Phase offsets (lower confidence)", "Held-out 2 MHz phase reads 6–13% high in VC-1, VC-2 and Z-20. Two causes.", C.accent4],
  ];
  const cw = (CW - 2 * 0.3) / 3, ch = 2.45, y0 = 1.35;
  items.forEach(([num, head, body, col], k) => {
    const x = M + (k % 3) * (cw + 0.3), y = y0 + Math.floor(k / 3) * (ch + 0.3);
    card(s, x, y, cw, ch, { name: "finding " + num });
    badge(s, x + 0.25, y + 0.25, num, col);
    s.addText(head, { x: x + 0.9, y: y + 0.2, w: cw - 1.1, h: 0.62, fontSize: 17, bold: true, color: C.text2, valign: "middle",
      margin: 0, isTextBox: true, objectName: "finding head " + num });
    s.addText(body, { x: x + 0.25, y: y + 0.95, w: cw - 0.5, h: ch - 1.15, fontSize: 15, color: C.text1, valign: "top",
      margin: 0, isTextBox: true, objectName: "finding body " + num });
  });
  const x = M + 2 * (cw + 0.3), y = y0 + ch + 0.3;
  card(s, x, y, cw, ch, { fill: C.text2, name: "fix order" });
  s.addText("Fix order", { x: x + 0.25, y: y + 0.2, w: cw - 0.5, h: 0.45, fontSize: 17, bold: true, color: C.background1,
    margin: 0, isTextBox: true });
  s.addText([
    { text: "Mask clipped values", options: { bullet: { type: "number" }, breakLine: true } },
    { text: "Realistic noise sigmas", options: { bullet: { type: "number" }, breakLine: true } },
    { text: "Model permittivity", options: { bullet: { type: "number" }, breakLine: true } },
    { text: "Re-weight, then A/B test", options: { bullet: { type: "number" } } },
  ], { x: x + 0.25, y: y + 0.75, w: cw - 0.5, h: ch - 0.95, fontSize: 15, color: C.background1, valign: "top", margin: 0,
    paraSpaceAfter: 4, isTextBox: true, objectName: "fix order list" });
}

// ---------------------------------------------------------------- 3. what we ran
{
  const s = content("What we ran: one short window per well, plus earlier runs",
    "Normalised misfit per inversion (1 = fits to the stated noise)",
    "Misfit is the RMS of residual divided by sigma over the fitted channels. VC-3 is the outlier because it fitted clipped values " +
    "(slide 4). The Z-20 runs are quick mode and longer intervals, which explains part of their higher misfit.", "Findings");
  const colors = INV.map(i => (i.well === "VC-3" ? HEX.accent2 : i.quick ? HEX.accent6 : HEX.accent1));
  s.addChart(pres.charts.BAR, [{ name: "Misfit", labels: INV.map(i => i.label), values: INV.map(i => i.misfit) }],
    chartBase({ x: M, y: 1.6, w: 7.6, h: 5.2, barDir: "col", chartColors: colors, showValue: true, dataLabelPosition: "outEnd",
      dataLabelFormatCode: "0.0", showLegend: false, valAxisMinVal: 0, valAxisMaxVal: 16, valAxisMajorUnit: 4, catAxisLabelRotate: -45,
      objectName: "misfit chart", altText: "Column chart of normalised misfit per inversion; VC-3 is 14.2, the others 1.2 to 4.1." }));
  const x = M + 7.9, w = CW - 7.9;
  card(s, x, 1.6, w, 5.2, { name: "setup card" });
  s.addText("Setup", { x: x + 0.3, y: 1.8, w: w - 0.6, h: 0.4, fontSize: 17, bold: true, color: C.text2, margin: 0, isTextBox: true });
  bullets(s, [
    "3 layers, 4 ft slices, 20 ft sliding window, calibration on",
    [{ text: "New, full quality: ", options: { bold: true } }, { text: "40 ft mid-run in VB-5, VC-1, VC-2, VC-3, Z-19" }],
    [{ text: "Earlier: ", options: { bold: true } }, { text: "VC-2 (3 × 120 ft), Z-20 quick mode (5 runs, light blue)" }],
    [{ text: "Not reached: ", options: { bold: true } }, { text: "Z-6, Z-26, Z-31 and both Z-25 runs" }],
    "Curves: each run's QC auto-pick",
  ], x + 0.3, 2.35, w - 0.6, 4.3, 15);
}

// ---------------------------------------------------------------- 4. clipping
{
  const s = content("Tool ceilings at 2000 Ω·m are fitted as real readings",
    "Share of stations at the 2000 Ω·m (5000 Ω·m per bin) ceiling, per curve",
    "The loader (invert.py interval_from_run) keeps any positive value, so a ceiling value enters the fit as a real, extreme " +
    "resistivity. Image sectors average bins as conductivity, so a clipped bin also shifts a top/bottom sector. VC-3 fitted " +
    "ARH32A at up to 9675 Ω·m and ZRM50PT at 5000 Ω·m on 4 of 11 stations; its fit failed with misfit 14 and RMS 127%.");
  // stat callout
  card(s, M, 1.6, 3.9, 3.5, { name: "stat card" });
  s.addText("9,675 Ω·m", { x: M + 0.3, y: 1.85, w: 3.4, h: 0.9, fontSize: 40, bold: true, color: C.accent2, margin: 0,
    isTextBox: true, fontFace: THEME.headFontFace, objectName: "stat value" });
  s.addText("ARH32A value fitted in VC-3, where the formation reads 16–50 Ω·m. That fit failed: misfit 14, RMS 127%.",
    { x: M + 0.3, y: 2.8, w: 3.3, h: 2.1, fontSize: 15, color: C.text1, valign: "top", margin: 0, isTextBox: true });
  // table
  const rows = [
    ["VB-5", "ARM16A, ZRM16A top + bottom", "100%", "no"],
    ["VC-2", "ARM16A, ARL48A, ZRM16A top + bottom", "100%", "no"],
    ["VC-2", "ZRL48A top / bottom", "74% / 90%", "no"],
    ["VC-3", "ARH16A", "55%", "no"],
    ["VC-3", "ZRM50PT (5000 Ω·m bins)", "36%", "yes"],
    ["VC-3", "ARH32A", "18%", "yes"],
    ["VC-1, Z-19, Z-20", "none above 5%", "–", "–"],
  ];
  const hdr = ["Well", "Curve", "At ceiling", "Fitted"].map(t => ({ text: t, options: { bold: true, color: C.background1, fill: { color: C.text2 } } }));
  const body = rows.map(r => r.map((t, j) => ({ text: t, options: j === 3 && t === "yes"
    ? { bold: true, color: C.accent2 } : {} })));
  s.addTable([hdr, ...body], { x: M + 4.2, y: 1.6, w: CW - 4.2, colW: [1.7, 4.03, 1.2, 1.0], fontSize: 14, color: C.text1,
    border: { type: "solid", pt: 0.75, color: "D5DCE6" }, rowH: 0.43, valign: "middle", margin: [0, 0.08, 0, 0.08],
    objectName: "clipping table" });
  fixBox(s, "treat values ≥ 1999 Ω·m (and 5000 Ω·m image bins) as missing before the log transform and before sector " +
    "averaging. Reject curves with more than 10% clipped stations in the QC auto-pick.", M, 5.45, CW, 1.25);
}

// ---------------------------------------------------------------- 5. attenuation factors
{
  const order = ["VC-1", "Z-19", "VB-5", "VC-2", "Z-20"];
  const rng = D.atten_rt_range;
  const labels = order.map(w => `${w} (${rng[w][0].toFixed(0)}–${rng[w][1].toFixed(0)} Ω·m)`);
  const series = ["ARH16A", "ARH32A", "ARH48A"].map(k => ({ name: k, labels, values: order.map(w => D.atten_factor[k][w]) }));
  const s = content("2 MHz attenuation reads high, by a varying factor",
    "Attenuation factor = tool ÷ forward model, near 10 Ω·m (low-resistivity wells: as measured)",
    "Factor fitted per well as log Ra_meas − log Ra_theory = a + g·(log Ra_theory − 1), using raw theory (the Z-20 correction " +
    "is undone where it was applied). For VC-1 and Z-19 the resistivity range is too narrow for a gain, so the factor is the " +
    "constant measured at about 3 Ω·m. VC-3 is excluded because its fit failed on clipped data.");
  s.addChart(pres.charts.BAR, series, chartBase({ x: M, y: 1.6, w: 7.9, h: 5.2, barDir: "col", barGrouping: "clustered",
    chartColors: [HEX.accent2, HEX.accent1, HEX.accent6], showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: "0.00",
    showLegend: true, legendPos: "t", valAxisMinVal: 0.8, valAxisMaxVal: 1.8, valAxisMajorUnit: 0.2, valAxisLabelFormatCode: "0.0",
    objectName: "attenuation factor chart",
    altText: "Clustered columns of 2 MHz attenuation factor by well, ordered by resistivity; about 1.0-1.1 in VC-1 and Z-19, up to 1.66 in VC-2." }));
  const x = M + 8.2, w = CW - 8.2;
  card(s, x, 1.6, w, 5.2, { name: "attenuation notes" });
  s.addText("Z-20 table today", { x: x + 0.3, y: 1.8, w: w - 0.6, h: 0.4, fontSize: 17, bold: true, color: C.text2, margin: 0, isTextBox: true });
  s.addText(`×${D.z20_table_at10.ARH16A.toFixed(2)} · ×${D.z20_table_at10.ARH32A.toFixed(2)} · ×${D.z20_table_at10.ARH48A.toFixed(2)}` +
    "  (16 / 32 / 48 in, at 10 Ω·m)", { x: x + 0.3, y: 2.2, w: w - 0.6, h: 0.6, fontSize: 14, color: C.accent4, margin: 0, isTextBox: true });
  bullets(s, [
    "Around 3 Ω·m (VC-1, Z-19) the factor is ×1.0–1.1",
    "At 7–35 Ω·m it is ×1.04–1.66, largest at 16 in",
    "At 16 in the table under-corrects VB-5 and VC-2 by 26–37%",
    "So the bias grows with resistivity and differs by well",
  ], x + 0.3, 3.0, w - 0.6, 3.6, 15);
}

// ---------------------------------------------------------------- 6. dielectric
{
  const e = D.dielectric;
  const lab = e.eps.map(String);
  const series = [
    { name: "2 MHz atten 16 in", labels: lab, values: e.H16A },
    { name: "2 MHz atten 32 in", labels: lab, values: e.H32A },
    { name: "2 MHz atten 48 in", labels: lab, values: e.H48A },
    { name: "500 kHz atten 16 in", labels: lab, values: e.M16A },
    { name: "2 MHz phase 16 in", labels: lab, values: e.H16P },
    { name: "2 MHz phase 48 in", labels: lab, values: e.H48P },
  ];
  const s = content("A dielectric effect reproduces the attenuation pattern",
    `Apparent ÷ true resistivity vs relative permittivity, homogeneous ${e.R_ohmm} Ω·m, read through the inversion's ε = 1 transform`,
    "Computed with the repo's own forward model (ADRForward geometry and transform) with epermH/epermV passed to empymod " +
    "(logs/grid/dielectric_test.py). At 30 Ω·m and eps_r 60 the 16 in 2 MHz attenuation runs off the transform table, which is " +
    "the same mechanism as the 2000 Ω·m ceiling in the data. Phase moves the other way, so the 2 MHz phase offset in slide 9 " +
    "is not dielectric.");
  s.addChart(pres.charts.LINE, series, chartBase({ x: M, y: 1.6, w: 7.9, h: 5.2,
    chartColors: [HEX.accent2, "F2A65A", "F6CBA0", HEX.accent5, HEX.accent1, HEX.accent6], lineSize: 2.5, lineDataSymbol: "circle",
    lineDataSymbolSize: 6, showLegend: true, legendPos: "r", valAxisMinVal: 0.8, valAxisMaxVal: 1.9, valAxisMajorUnit: 0.1,
    valAxisLabelFormatCode: "0.0", showCatAxisTitle: true, catAxisTitle: "Relative permittivity ε", catAxisTitleColor: AXIS,
    catAxisTitleFontSize: 12, catAxisTitleFontFace: "+mn-lt", objectName: "dielectric chart",
    altText: "Line chart: attenuation curves rise with permittivity (2 MHz 16 in to 1.79 at eps 150), phase curves fall slightly." }));
  const x = M + 8.2, w = CW - 8.2;
  card(s, x, 1.6, w, 5.2, { name: "dielectric notes" });
  s.addText("Matches the data", { x: x + 0.3, y: 1.8, w: w - 0.6, h: 0.4, fontSize: 17, bold: true, color: C.accent3, margin: 0, isTextBox: true });
  bullets(s, ["Order 16 > 32 > 48 in", "Larger at 2 MHz than 500 kHz", "Grows with resistivity, then saturates at the ceiling"],
    x + 0.3, 2.25, w - 0.6, 1.7, 15);
  s.addText("Does not explain", { x: x + 0.3, y: 4.05, w: w - 0.6, h: 0.4, fontSize: 17, bold: true, color: C.accent2, margin: 0, isTextBox: true });
  bullets(s, ["2 MHz phase reading high: permittivity pushes phase low (×0.89–0.99)"], x + 0.3, 4.5, w - 0.6, 1.2, 15);
  s.addText("The forward model has no permittivity today (empymod default).", { x: x + 0.3, y: 5.75, w: w - 0.6, h: 0.9,
    fontSize: 14, italic: true, color: C.accent4, margin: 0, valign: "top", isTextBox: true });
}

// ---------------------------------------------------------------- 7. anisotropy
{
  const colors = INV.map(i => (i.rv_rh < 1.2 ? HEX.accent2 : HEX.accent1));
  const low = INV.filter(i => i.rv_rh < 1.2).length;
  const s = content("Fitting attenuation pins anisotropy at its lower bound",
    "Median Rv/Rh per inversion (bound 1–10); orange = below 1.2",
    "Rv/Rh is one value for all layers, bounded 1 to 10. Attenuation reading above phase cannot come from TIV anisotropy (team " +
    "note E1 in docs/inversion/HACKATHON_PLAN.md), so fitting 2 MHz attenuation drives Rv/Rh to the bound. Phase-only on Z-20 " +
    "gave about 1.8 (E5); the VC-2 windows that keep anisotropy reach 1.8-1.9.");
  s.addChart(pres.charts.BAR, [{ name: "Rv/Rh", labels: INV.map(i => i.label), values: INV.map(i => i.rv_rh) }],
    chartBase({ x: M, y: 1.6, w: 7.9, h: 5.2, barDir: "col", chartColors: colors, showValue: true, dataLabelPosition: "outEnd",
      dataLabelFormatCode: "0.00", showLegend: false, valAxisMinVal: 0, valAxisMaxVal: 2.5, valAxisMajorUnit: 0.5,
      valAxisLabelFormatCode: "0.0", catAxisLabelRotate: -45, objectName: "anisotropy chart",
      altText: `Columns of Rv/Rh per inversion; ${low} of ${INV.length} are below 1.2.` }));
  const x = M + 8.2, w = CW - 8.2;
  card(s, x, 1.6, w, 5.2, { name: "anisotropy notes" });
  s.addText(`${low} of ${INV.length}`, { x: x + 0.3, y: 1.8, w: w - 0.6, h: 0.9, fontSize: 44, bold: true, color: C.accent2,
    margin: 0, isTextBox: true, fontFace: THEME.headFontFace });
  s.addText("inversions end with Rv/Rh below 1.2. All 13 fitted 2 MHz attenuation.", { x: x + 0.3, y: 2.7, w: w - 0.6, h: 0.9,
    fontSize: 15, color: C.text1, margin: 0, valign: "top", isTextBox: true });
  bullets(s, ["Z-20 phase-only fit gave Rv/Rh ≈ 1.8","VC-2 windows reach 1.8–1.9",
    "Underestimated anisotropy biases Rh and boundary positions"], x + 0.3, 3.75, w - 0.6, 2.9, 15);
}

// ---------------------------------------------------------------- 8. noise
{
  const fam = Object.entries(D.noise).filter(([, v]) => v.n >= 3).sort((a, b) => b[1].median_rms_sigma - a[1].median_rms_sigma);
  const s = content("The stated noise is too small, by up to 3.3×",
    "Fitted channels: RMS residual ÷ sigma, median per family (1.0 = sigma is right); inversions with misfit < 3, VC-3 excluded",
    "Sigma today is a 0.02-decade floor (about 4.7%) or the sample-to-sample noise of the curve in the interval. Neither includes " +
    "model error (a 1.5D model of real geology, the unconfirmed geometry and transform). Families above 1 dominate the fit more " +
    "than they should, and every misfit number looks worse than the data quality is.");
  s.addChart(pres.charts.BAR, [{ name: "RMS / sigma", labels: fam.map(([k]) => k), values: fam.map(([, v]) => v.median_rms_sigma) }],
    chartBase({ x: M, y: 1.6, w: 7.9, h: 5.2, barDir: "bar", chartColors: fam.map(([, v]) => (v.median_rms_sigma >= 2 ? HEX.accent2 : HEX.accent1)),
      showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: "0.00", showLegend: false, valAxisMinVal: 0,
      valAxisMaxVal: 3.6, valAxisMajorUnit: 0.5, valAxisLabelFormatCode: "0.0", catAxisOrientation: "maxMin",
      objectName: "noise chart", altText: "Horizontal bars of fitted-channel RMS divided by sigma; 500 kHz ZR attenuation 3.33, others 0.98 to 1.56." }));
  const x = M + 8.2, w = CW - 8.2;
  card(s, x, 1.6, w, 5.2, { name: "noise notes" });
  s.addText("Sigma needed (σ × ratio)", { x: x + 0.3, y: 1.8, w: w - 0.6, h: 0.4, fontSize: 17, bold: true, color: C.text2, margin: 0, isTextBox: true });
  const sig = (k, unit, nd) => { const v = D.noise[k]; return (v.sigma * v.median_rms_sigma).toFixed(nd) + unit; };
  const rows = [
    ["AR phase", sig("AR 500 kHz phase", " dec", 3)],
    ["ZR 2 MHz atten", sig("ZR 2 MHz atten", " dec", 3)],
    ["ZR 500 kHz atten", sig("ZR 500 kHz atten", " dec", 3)],
    ["ZG phase", sig("ZG geosignal phase", "°", 1)],
  ];
  s.addTable(rows.map(r => [{ text: r[0] }, { text: r[1], options: { bold: true, align: "right" } }]),
    { x: x + 0.3, y: 2.35, w: w - 0.6, colW: [2.25, w - 0.6 - 2.25], fontSize: 15, color: C.text1, rowH: 0.42,
      border: { type: "none" }, margin: [0, 0, 0, 0], valign: "middle", objectName: "sigma table" });
  s.addText("Today: 0.020 dec floor for AR and the 500 kHz ZR curves.", { x: x + 0.3, y: 4.2, w: w - 0.6, h: 0.7, fontSize: 14,
    italic: true, color: C.accent4, margin: 0, valign: "top", isTextBox: true });
  s.addText("Add a model-error term per family rather than raising the floor for everything.",
    { x: x + 0.3, y: 5.0, w: w - 0.6, h: 1.6, fontSize: 15, color: C.text1, margin: 0, valign: "top", isTextBox: true });
}

// ---------------------------------------------------------------- 9. phase offsets
{
  const sel = INV.filter(i => i.well !== "VC-3" && i.hphase_heldout_bias !== null);
  const s = content("2 MHz phase reads high in three wells, from two causes",
    "Held-out 2 MHz phase: tool vs model, median % per inversion · lower confidence, needs an A/B test",
    "VC-2: the tool's own 2 MHz / 500 kHz phase ratio at 16 in is 13-16% above anything the fitted model produces, in every " +
    "window, so it is a shallow effect in that well (invasion or borehole). Z-20 and VC-1: the tool ratio matches the model " +
    `within a few %, yet all deeper phase sits above the model while the guessed 50/66/82 in channels are fitted below it ` +
    `(ZRM50 −4 to −7%). Median slice misfit is ${D.ls_misfit.with.median} with those channels and ${D.ls_misfit.without.median} ` +
    "without, but that comparison is confounded by well and mode. VB-5 fits 6 such channels and shows no offset.");
  s.addChart(pres.charts.BAR, [{ name: "Bias %", labels: sel.map(i => i.label), values: sel.map(i => i.hphase_heldout_bias) }],
    chartBase({ x: M, y: 1.6, w: 7.9, h: 5.2, barDir: "col", chartColors: sel.map(i => (i.hphase_heldout_bias > 5 ? HEX.accent2 : HEX.accent6)),
      showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: "+0.0;-0.0", showLegend: false, valAxisMinVal: -5,
      valAxisMaxVal: 15, valAxisMajorUnit: 5, catAxisLabelRotate: -45, objectName: "phase bias chart",
      altText: "Columns of held-out 2 MHz phase bias per inversion; +5.7 to +12.6% in VC-1, VC-2 and three Z-20 runs, near zero elsewhere." }));
  const x = M + 8.2, w = CW - 8.2;
  card(s, x, 1.6, w, 5.2, { name: "phase notes" });
  s.addText("VC-2: shallow effect", { x: x + 0.3, y: 1.8, w: w - 0.6, h: 0.4, fontSize: 17, bold: true, color: C.text2, margin: 0, isTextBox: true });
  s.addText("Relative to 500 kHz, the tool's 16 in 2 MHz phase is 13 to 16% above what the fitted models produce.",
    { x: x + 0.3, y: 2.25, w: w - 0.6, h: 1.25, fontSize: 15, color: C.text1, margin: 0, valign: "top", isTextBox: true });
  s.addText("Z-20, VC-1: model pulled low", { x: x + 0.3, y: 3.65, w: w - 0.6, h: 0.4, fontSize: 17, bold: true, color: C.text2, margin: 0, isTextBox: true });
  s.addText("The guessed-geometry 50/66/82 in channels are fitted below the model (ZRM50 −4% to −7%) while the other deep phase curves read above it.",
    { x: x + 0.3, y: 4.1, w: w - 0.6, h: 1.5, fontSize: 15, color: C.text1, margin: 0, valign: "top", isTextBox: true });
  s.addText("VB-5 fits 6 such channels with no offset.", { x: x + 0.3, y: 5.85, w: w - 0.6, h: 0.75, fontSize: 14, italic: true,
    color: C.accent4, margin: 0, valign: "top", isTextBox: true });
}

// ---------------------------------------------------------------- 10-11. recommendations
function recTable(s, rows, y) {
  const conf = { High: C.accent3, Medium: C.accent1, Low: C.accent4 };
  const hdr = ["#", "Change", "Where", "Evidence and effect", "Confidence"].map(t => ({ text: t,
    options: { bold: true, color: C.background1, fill: { color: C.text2 } } }));
  const body = rows.map(r => [
    { text: r[0], options: { bold: true, align: "center" } }, { text: r[1] },
    { text: r[2], options: { fontFace: "Consolas", fontSize: 12 } }, { text: r[3] },
    { text: r[4], options: { bold: true, color: conf[r[4]] } },
  ]);
  s.addTable([hdr, ...body], { x: M, y, w: CW, colW: [0.45, 3.95, 3.15, 3.13, 1.45], fontSize: 15, color: C.text1,
    border: { type: "solid", pt: 0.75, color: "D5DCE6" }, valign: "middle", margin: [0.08, 0.1, 0.08, 0.1],
    rowH: [0.5, ...rows.map(() => 1.0)], autoPage: false, objectName: "recommendation table" });
}
{
  const s = content("Changes to the data: clean clipped values, use honest noise", "Low-risk, apply first",
    "Rows 1-2 remove the failure mode seen in VC-3. Rows 3-4 make sigma reflect what the model can fit, so no channel family " +
    "dominates by accident; the starting values come from slide 8 and should be re-measured after the masking fix.", "Recommendations");
  recTable(s, [
    ["1", "Mask tool ceilings (≥ 1999 Ω·m; 5000 Ω·m image bins) before the log and before sector averaging",
      "invert.py interval_from_run, data/quadrants.py", "VC-3 fitted 9,675 and 5,000 Ω·m and failed", "High"],
    ["2", "Drop curves with > 10% clipped stations from the QC auto-pick", "qc/selection.py",
      "Up to 100% clipped at 500 kHz 16 in, in both VB‑5 and VC‑2", "High"],
    ["3", "Sigma = √(noise² + model²) per channel family", "service.py SIGMA_FLOOR, noise_estimate",
      "Fitted channels miss by 1.1 to 1.6 × their sigma", "High"],
    ["4", "Start model terms at: phase 0.027 dec, 2 MHz atten 0.054 dec, 500 kHz atten 0.067 dec, ZG phase 1.8°",
      "service.py", "Ratios on slide 8; re-measure after 1–2", "Medium"],
  ], 1.65);
}
{
  const s = content("Changes to the corrections and weights", "Do item 5 first, then 6–8 as A/B tests on the same windows",
    "Item 5 is the physics fix and should replace the empirical Z-20 table. Until it lands, item 6 stops attenuation from " +
    "pinning anisotropy. Items 7 and 8 are lower-confidence and must be A/B tested: rerun the same 13 windows and compare " +
    "held-out bias, Rv/Rh and misfit/sigma.");
  recTable(s, [
    ["5", "Model permittivity in the forward model and its transform; fit ε per slice or tie it to resistivity. Then retire the Z-20 table",
      "adr_forward.py _raw, tables; invert.py Z20_…", "Reproduces the attenuation pattern; table under-corrects by up to 37%", "High"],
    ["6", "Interim: 500 kHz / 125 kHz attenuation weight 0.25 → 0, and 2 MHz attenuation off when fitting anisotropy",
      "service.py CALIBRATED_ATTENUATION_WEIGHT", "8 of 13 fits pinned at Rv/Rh < 1.2; the team plan already says 0", "Medium"],
    ["7", "Guessed 50/66/82 in channels: weight 1.0 → 0.25", "service.py GUESSED_GEOMETRY_WEIGHT",
      "Fitted below model in Z-20 and VC-1; VB-5 unaffected", "Low"],
    ["8", "VC-2: leave the 16 in 2 MHz channels out", "QC selection for VC-2", "Shallow 13–16% offset in every window", "Medium"],
  ], 1.65);
}

// ---------------------------------------------------------------- 12. validation
{
  pres.addSection({ title: "Next steps" });
  const s = pres.addSlide({ masterName: "CLOSING", sectionTitle: "Next steps" });
  s.addText("How to confirm: rerun the same 13 windows", { placeholder: "title" });
  s.addText("Compare held-out bias, Rv/Rh and misfit ÷ sigma before and after each change", { placeholder: "body" });
  const steps = [
    ["1", "Masking and sigma (items 1–4)", "Rerun VC-3 first; expect misfit near the others"],
    ["2", "Permittivity A/B (item 5)", "ε modelled vs Z-20 table vs phase-only"],
    ["3", "Weights A/B (items 6–8)", "One change at a time on the same windows"],
    ["4", "Extend coverage", "Z-6, Z-25, Z-26, Z-31: one 120 ft window each"],
  ];
  const cw = (CW - 3 * 0.3) / 4;
  steps.forEach(([num, head, body], k) => {
    const x = M + k * (cw + 0.3), y = 3.3;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: 1.75, rectRadius: 0.08, fill: { color: C.background1, transparency: 90 },
      line: { color: C.accent6, width: 0.75 }, objectName: "step " + num });
    badge(s, x + 0.2, y + 0.2, num, C.accent2);
    s.addText(head, { x: x + 0.85, y: y + 0.15, w: cw - 1.0, h: 0.6, fontSize: 15, bold: true, color: C.background1, valign: "middle",
      margin: 0, isTextBox: true });
    s.addText(body, { x: x + 0.2, y: y + 0.85, w: cw - 0.4, h: 0.85, fontSize: 14, color: C.accent6, valign: "top", margin: 0, isTextBox: true });
  });
  s.addText("Caveats", { x: M, y: 5.55, w: CW, h: 0.4, fontSize: 16, bold: true, color: C.background1, margin: 0, isTextBox: true });
  s.addText([
    { text: "One 40 ft window per new well; the earlier Z-20 runs are quick mode", options: { bullet: { indent: 15 }, breakLine: true } },
    { text: "Factors outside each well's sampled resistivity range are extrapolations", options: { bullet: { indent: 15 }, breakLine: true } },
    { text: "Five wells are not yet inverted", options: { bullet: { indent: 15 } } },
  ], { x: M, y: 5.95, w: CW, h: 1.1, fontSize: 14, color: C.accent6, margin: 0, paraSpaceAfter: 4, valign: "top", isTextBox: true,
    objectName: "caveats" });
  s.addNotes("Ops notes from this run: set OPENBLAS_NUM_THREADS=1 in the inversion worker processes (about 3x faster here and it " +
    "stopped out-of-memory failures), and close the backend's worker pool on exit (18 orphaned workers were found). A 120 ft " +
    "window takes about 6-10 minutes on a 16-core laptop with the thread fix.");
}

(async () => {
  await pres.writeFile({ fileName: outPath });
  await applyTheme(outPath, THEME);
  console.log("wrote", outPath);
})().catch(e => { console.error(e); process.exit(1); });
