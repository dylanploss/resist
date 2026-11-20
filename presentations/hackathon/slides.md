---
theme: default
title: Resist — Resistivity QC and Inversion
info: Hackathon presentation, 4 minutes. Kept up to date through the hackathon.
class: text-center
transition: slide-left
mdc: true
---

<img src="/logo.png" class="mx-auto h-40 pb-4" alt="Dylan David Ove logo" />

# Resist

Resistivity QC and inversion platform for the Ekofisk well data

<div class="pt-6 text-sm opacity-70">
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

<div class="font-bold text-base pb-2">1 · QC input data and self diagnose</div>

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
title: Result
---

# Result

A working web app on the real Ekofisk data: **10 wells, 11 runs, read straight from DLIS**

<div class="grid grid-cols-3 gap-5 text-sm pt-4">
<div class="border rounded p-4">

<div class="font-bold text-base pb-2">1 · QC: ~50 → 8 curves</div>

- Scores every curve: coverage, noise, spikes, geosignal purity, duplicates
- Depth-of-investigation tier per curve
- Keeps a shallow anchor + deep geosignals, a reason for each

</div>
<div class="border rounded p-4">

<div class="font-bold text-base pb-2">2 · Soft boundaries</div>

- Draw dip lines on the section
- They enter the fit as soft priors, not hard limits
- Re-run the whole window or only part of it

</div>
<div class="border rounded p-4">

<div class="font-bold text-base pb-2">3 · Inversion QC metrics</div>

- RMS misfit, overall and per curve, flagged above 3σ
- Measured vs modelled logs
- Curtain fades the most uncertain cells

</div>
</div>

<div class="text-sm pt-5 opacity-80">

**Also:** windowed 1.5D Levenberg-Marquardt inversion · run locally or on a 72-core Azure server · results stored in a Cosmos graph · 3D well view with DOI tube and inversion curtain · Z-20 study: phase fits within ±2.3 %, 2 MHz attenuation reads 15–25 % high → resistivity-dependent correction

</div>

<!--
~1 min, then live demo.
- Data: FastAPI reads the 11 DLIS runs directly; no vendor software in the loop.
- QC: every curve is scored and ranked; slot rules make sure each inversion gets a shallow anchor and deep
  geosignals. The user can edit and save the selection, then press "Invert this selection".
- Soft boundaries: dip lines drawn on the section become Gaussian priors on dip and boundary depth, so the
  inversion follows the interpreter where the data allow it, and departs where they don't.
- QC metrics: per-curve RMS misfit and RMS/sigma (red above 3), measured vs modelled tracks, uncertainty fade.
- Z-20 misfit study (20100-20500 ft): phase is trustworthy as-is; 2 MHz attenuation needs a
  resistivity-dependent correction; 500 kHz / 125 kHz attenuation is used for QC only.
- Compute: local backend or the 72-core Azure F72s v2 inversion server; finished inversions stored in Cosmos.
-->
