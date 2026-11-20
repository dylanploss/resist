---
theme: default
title: Resist — Resistivity QC and Inversion
info: Hackathon presentation, 4 minutes. Kept up to date through the hackathon.
class: text-center
transition: slide-left
mdc: true
---

# Resist

Resistivity QC and inversion platform for the Ekofisk well data

<div class="pt-8 text-sm opacity-70">
Hackathon demo · 20 November 2026 · 14:00
</div>

<!--
~20 s. One-liner: we take raw deep-reading resistivity logs from Ekofisk and turn them into
something a geoscientist can trust and invert, in the browser.
-->

---
title: The problem
---

# The problem

<div class="grid grid-cols-2 gap-8 text-base pt-4">
<div>

<div class="font-bold pb-2">Geosteering</div>

- Wells are steered in real time on deep-reading resistivity
- The inversion behind that picture decides where the bit goes

</div>
<div>

<div class="font-bold pb-2">Inversion is service-company bound</div>

- Resistivity inversions live inside each vendor's software
- Vendors don't want to change methods or add features
- **Operators can release data** to open up and improve this domain

</div>
</div>

<!--
~40 s.
- Geosteering: the well path is adjusted while drilling, based on deep resistivity inversions.
- Today that inversion is a black box owned by the service company. Same data, one method,
  no room for operators to try alternatives or add features.
- The lever is the data: operators own it and can release it, so anyone can build and compare inversions.
-->

---
title: Our goal
---

# Our goal

A web app where **the user runs the inversion**

<div class="grid grid-cols-3 gap-5 text-sm pt-6">
<div class="border rounded p-4">

<div class="font-bold text-base pb-2">1 · QC input curves</div>

From **~50 curves to 8**, with a reason for every kept and rejected curve

</div>
<div class="border rounded p-4">

<div class="font-bold text-base pb-2">2 · Soft boundaries</div>

Give the inversion soft boundaries (dip lines) to follow

</div>
<div class="border rounded p-4">

<div class="font-bold text-base pb-2">3 · QC the result</div>

Present QC metrics of the inversion: misfit, measured vs modelled logs

</div>
</div>

<!--
~30 s.
- The user, not the vendor, drives the inversion.
- QC: each run has ~50 curves; we rank them and keep 8 that are fit to invert.
- Soft boundaries: interpreted dip lines guide the layered model without forcing it.
- QC metrics: show how well the model explains the measured curves, so the result can be trusted.
-->

---
title: What we built
---

# What we built

<div class="grid grid-cols-5 gap-5 text-sm pt-1">
<div class="col-span-2">

<div class="font-bold pb-1">The problem</div>

- 10 Ekofisk wells, 11 DLIS runs, ~50 curves each
- Which curves are fit to invert? Where do they see?

<div class="font-bold pt-3 pb-1">Our answer: one web app</div>

| Tab | What you get |
|-----|--------------|
| QC | **~50 → 8 curves**, a reason for each |
| Inversion | 1.5D layered model, curtain, log fit |
| Modelling | UDAR 1D model in the browser |
| 3D well | Real well path, DOI-sized tube |

</div>
<div class="col-span-3">

<img src="/well3d-compare.png" class="w-full h-80 object-cover object-left rounded border border-gray-300" />

<div class="text-xs opacity-70 pt-1">Z-19 · shallow ARH16P (solid) inside deep ZRL48A (shell) · the tube is the estimated depth of investigation</div>

</div>
</div>

<!--
~1 min.
- Data: FastAPI reads the DLIS files directly; runs, curve inventory and curve data.
- QC: scores every curve, keeps 8 of ~50, explains every rejection.
- Inversion: windowed Levenberg-Marquardt 1.5D fit of the QC selection: layered model, curtain section, measured vs modelled logs.
- Modelling: unchanged copy of the UDAR_Bench compute core in a web worker.
- 3D well: the curve along the real UTM/TVD path in the QC colours. The tube radius is a per-sample
  DOI estimate: skin depth 503·√(ρ/f), soft cap at 3 spacings. For 32-bin images it bulges toward
  the resistive (red) bins; ZG geosignals borrow that shape from the matching ZR image.
- Picture: Compare with: the shallower curve is the solid inner tube, the deeper one the transparent shell.
Say: "The DOI is a physics estimate, not a vendor figure."
-->

---
title: How it works and the future
---

# How it works · the future

<div class="grid grid-cols-5 gap-5 text-sm pt-1">
<div class="col-span-2">

<div class="font-bold pb-1">How it works</div>

- **Backend:** Python + FastAPI on the real DLIS files
- **Frontend:** React, Material UI, three.js
- **Physics:** 1D layered VTI model at the true tool position
- **3D:** inversion layers glow magenta where the DOI reaches them

<div class="font-bold pt-3 pb-1">The future</div>

- **Release ground-truth interpretations and inversions** alongside the data
- Inversion over all 11 runs, stitched windows
- 32-bin images reduced to mean, amplitude, phase
- Vendor DOI figures instead of the estimate

</div>
<div class="col-span-3 flex flex-col gap-2">

<img src="/well3d-layers.png" class="w-full h-38 object-cover rounded border border-gray-300" />

<img src="/well3d-field.png" class="w-full h-38 object-cover rounded border border-gray-300" />

</div>
</div>

<div class="pt-3 text-center text-base">

**Live demo →** QC → Inversion → 3D: ★ Demo · Compare · Layers · Field

</div>

<!--
~30 s, then ~2 min live demo. Total ≈ 4 min.
Demo flow:
1. QC selection: open VC-2, show the ranked table and the kept curves; click "Invert this selection →".
2. Inversion: MD 17202–17322 ft, 3 layers; show the layered model and measured vs modelled logs.
   (Run it before the talk too: jobs live in backend memory.)
3. 3D well on Z-19, ZRL48A: press ★ Demo; the captions stop at the conductive and resistive zones
   and TD. Escape stops it.
4. Compare with ARH16P: shallow solid tube inside the deep shell.
5. Switch to VC-2: Inversion layers on; the magenta glow is where a boundary is inside the DOI,
   and the panel reads the nearest-boundary distance.
6. Field: all 11 runs at their UTM positions; click a well to open it. Save PNG if asked.
- 1D is exact for planar beds at oblique tool angles; dip comes from the well trajectory.
- Full 11-run inversion estimated at 1–8 hours on a laptop with 50 % window overlap.
Close: "From raw DLIS to a trusted curve set, an inverted model and a 3D picture of what the tool sees — in the browser."
-->