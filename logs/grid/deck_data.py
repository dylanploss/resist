"""Collect the numbers for the QC slide deck from the inversion store + the dielectric forward test.

    python logs/grid/deck_data.py > logs/grid/deck_data.json
"""

import json
import re
import sys

import numpy as np

sys.path.insert(0, "logs/grid")
import qc_inversions as qc                      # noqa: E402
from dielectric_test import run as dielectric   # noqa: E402

recs = qc.load("data/graph/inversions.json")
curves, runs, slices = qc.analyse(recs)


def well(run):
    return qc.well_of(run)


def arr(xs):
    return np.array([np.nan if v is None else v for v in xs], float)


out = {"n_inversions": len(recs), "wells": sorted({well(r["run"]) for r in recs}),
       "n_slices": len(slices), "all_wells": 11}

# --- per inversion
inv = []
for r in recs:
    res, q = r["result"], r["request"]
    ratio = float(np.median([s["layers"][0]["rv"] / s["layers"][0]["rh"] for s in res["slices"]]))
    hp = [c["mean_residual_percent"] for c in res["curves"]
          if c["label"][:3] in ("ARH", "ZRH") and c["measurement"] == "phase" and not c["used"]
          and c["mean_residual_percent"] is not None]
    clipped_fit = 0
    for c in res["curves"]:
        if c["used"] and c["unit"] == "ohm.m":
            clipped_fit += int(np.sum(arr(c["obs"]) >= 1999))
    inv.append({"well": well(r["run"]), "md": f"{q['md_min_ft']:.0f}-{q['md_max_ft']:.0f}",
                "quick": bool(q.get("quick")), "job": r["job_id"][:4], "misfit": res["misfit_normalised"],
                "rms_pct": res["rms_percent_used"], "rv_rh": round(ratio, 2),
                "hphase_heldout_bias": round(float(np.median(hp)), 1) if hp else None,
                "fits_2mhz_atten": any(e["label"][2] == "H" and e["measurement"] == "attenuation"
                                       and e["kind"] != "geosignal" for e in r["plan"]["used"]),
                "guessed_ls": sum(bool(e.get("guessed_geometry")) for e in r["plan"]["used"]),
                "clipped_fitted_values": clipped_fit, "n_used": len(r["plan"]["used"])})
out["inversions"] = sorted(inv, key=lambda d: (d["well"], d["md"]))

# --- attenuation factor at 10 ohm-m per well (AR 2 MHz), excluding VC-3 (fit failed on clipped data)
fits = qc.correction_fits(recs)
out["atten_factor"] = {lab: {f["well"]: round(f["factor_at_10"], 2) for f in fits
                             if f["label"] == lab and f["well"] != "VC-3"} for lab in ("ARH16A", "ARH32A", "ARH48A")}
out["atten_rt_range"] = {f["well"]: [round(f["rt_min"], 1), round(f["rt_max"], 1)] for f in fits if f["label"] == "ARH16A"}
out["z20_table_at10"] = {k: round(10 ** v[0], 2) for k, v in qc.Z20.items()}

# --- clipping: share of stations at the 2000 ohm-m ceiling per well and curve family (all curves, used or not)
clip = {}
for r in recs:
    w = well(r["run"])
    for c in r["result"]["curves"]:
        if c["unit"] != "ohm.m":
            continue
        v = arr(c["obs"])
        v = v[np.isfinite(v)]
        if v.size:
            clip.setdefault(w, {}).setdefault(c["label"], []).append(float(np.mean(v >= 1999)))
out["clipping"] = {w: {k: round(100 * max(v), 0) for k, v in d.items() if max(v) >= 0.05} for w, d in clip.items()}

# --- noise: normalised rms of FITTED channels by family, from well-behaved inversions (misfit < 3, not VC-3)
fam = {}
for r in recs:
    if well(r["run"]) == "VC-3" or (r["result"]["misfit_normalised"] or 99) >= 3:
        continue
    for c in r["result"]["curves"]:
        if not c["used"] or c["rms_normalised"] is None:
            continue
        lab = c["label"]
        if lab.startswith("ZG"):
            key = "ZG geosignal " + ("phase" if c["measurement"] == "phase" else "atten")
        elif c.get("guessed_geometry"):
            key = "ZR 50/66/82 (guessed geom.)"
        else:
            key = f"{lab[:2]} {'2 MHz' if lab[2] == 'H' else '500 kHz' if lab[2] == 'M' else '125 kHz'} " \
                  f"{'phase' if c['measurement'] == 'phase' else 'atten'}"
        fam.setdefault(key, {"rms": [], "sigma": []})
        fam[key]["rms"].append(c["rms_normalised"])
        fam[key]["sigma"].append(c["sigma"])
out["noise"] = {k: {"median_rms_sigma": round(float(np.median(v["rms"])), 2), "n": len(v["rms"]),
                    "sigma": round(float(np.median(v["sigma"])), 3)} for k, v in sorted(fam.items())}

# --- per-slice misfit split by whether guessed LS channels were fitted
ls = {"with": [], "without": []}
for r in recs:
    if well(r["run"]) == "VC-3":
        continue
    k = "with" if any(e.get("guessed_geometry") for e in r["plan"]["used"]) else "without"
    ls[k] += [s["misfit_normalised"] for s in r["result"]["slices"] if s.get("misfit_normalised") is not None]
out["ls_misfit"] = {k: {"median": round(float(np.median(v)), 2), "n": len(v)} for k, v in ls.items()}

# --- dielectric forward test: apparent / true at 10 ohm-m, isotropic, eps_r sweep
eps = [1, 10, 20, 40, 60, 100, 150]
dt = {}
for e in eps:
    fp, fa, names = dielectric(10.0, float(e))
    for n, p, a in zip(names, fp, fa):
        dt.setdefault(n[2:] + "P", []).append(round(float(p), 3))
        dt.setdefault(n[2:] + "A", []).append(round(float(a), 3))
out["dielectric"] = {"eps": eps, "R_ohmm": 10, **{k: dt[k] for k in ("H16A", "H32A", "H48A", "M16A", "H16P", "H48P", "M16P")}}

json.dump(out, sys.stdout, indent=1)
