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
title: What we built
---

# What we built

<div class="grid grid-cols-2 gap-6 text-sm pt-2">
<div>

<div class="font-bold pb-1">The problem</div>

- 10 Ekofisk wells, 11 DLIS runs of ADR resistivity + geosignal
- ~50 candidate curves per run — which ones are fit to invert?
- Inversion tools are slow, opaque and desktop-bound

<div class="font-bold pt-4 pb-1">Our answer</div>

- One web app from raw DLIS to inversion
- QC picks **5–10 curves** with a reason for every keep and drop
- 1D forward model and inversion run **in the browser**

</div>
<div>

<div class="font-bold pb-1">The platform</div>

| Step | What you get |
|------|--------------|
| Data | Curve inventory, curves vs depth |
| QC | Ranked table, DOI-noise scatter, depth tracks |
| Modelling | UDAR 1D forward model and inversion |
| 3D well | Curve on the well path, DOI-sized tube *(in progress)* |

</div>
</div>

<!--
~1 min 30 s.
- Data: FastAPI backend reads the DLIS files directly and exposes runs, curve inventory and curve data.
- QC: scores each curve, keeps 5–10, explains every rejection; stable JSON contract between backend and UI.
- Modelling: unchanged copy of the UDAR_Bench compute core running in a web worker.
- 3D well: one QC curve drawn along the real UTM/TVD path with the same colour scale as the QC tab.
  Tube thickness follows the curve's QC depth of investigation, so deep curves show a wider sensed volume
  (an estimate scaled from the relative DOI index, not a measured reach).
Update this slide as features land.
-->

---
title: How it works and what's next
---

# How it works · what's next

<div class="grid grid-cols-2 gap-6 text-sm pt-2">
<div>

<div class="font-bold pb-1">How it works</div>

- **Backend:** Python + FastAPI on the real DLIS files
- **Frontend:** React + Material UI, compute in a web worker
- **Physics:** 1D layered VTI model at the true tool position
- **Speed:** milliseconds per station vs minutes for 2.5D

</div>
<div>

<div class="font-bold pb-1">What's next</div>

- Windowed Levenberg-Marquardt inversion over all 11 runs
- 32-bin azimuthal images reduced to mean, amplitude, phase
- Borehole image wrapped around the 3D well
- Several wells and horizons in one 3D scene

</div>
</div>

<div class="pt-10 text-center text-base">

**Demo →** QC selection → Modelling → 3D well

</div>

<!--
~1 min 30 s including the live demo hand-over.
- 1D is exact for planar beds at oblique tool angles; dip comes from the well trajectory.
- Harmonic reduction is 32:3 data reduction while keeping the physics.
- Full 11-run inversion estimated at 1–8 hours on a laptop with 50 % window overlap.
Close: "From raw DLIS to a trusted, invertible curve set — in the browser."
-->
