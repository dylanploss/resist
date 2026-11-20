"""QC the stored inversions for systematic discrepancies.

    python logs/grid/qc_inversions.py [data/graph/inversions.json] [--json out.json]

Uses every current (non-superseded) record. Residuals are obs - pred in log10 (resistivity curves) or raw
units (geosignals); positive bias = the tool reads higher than the fitted model predicts.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import defaultdict
from statistics import median

import numpy as np

PIN_LO, PIN_HI = 0.11, 900.0          # within ~10% of the default Rh bounds 0.1 / 1000 ohm-m
MAX_BSTD = 50.0                       # service.MAX_BOUNDARY_STD_FT: boundary unresolved


def short(run: str) -> str:
    m = re.match(r"2_4-([A-Z]+-\d+(?:_[A-Z0-9]+)?)", run)
    rng = re.search(r"_(\d+)-(\d+)ft", run)
    return f"{m[1] if m else run[:12]}" + (f" ({rng[1]}-{rng[2]})" if rng else "")


def arr(xs):
    return np.array([np.nan if v is None else v for v in xs], float)


def curve_bias(c: dict) -> tuple[float, float] | None:
    """(signed mean residual in sigma units, rms in sigma units) over valid stations."""
    obs, pred = arr(c.get("obs") or []), arr(c.get("pred") or [])
    ok = np.isfinite(obs) & np.isfinite(pred)
    if c.get("unit") == "ohm.m":
        ok &= (obs > 0) & (pred > 0)
    if ok.sum() < 3 or not c.get("sigma"):
        return None
    r = (np.log10(obs[ok]) - np.log10(pred[ok])) if c.get("unit") == "ohm.m" else (obs[ok] - pred[ok])
    return float(np.mean(r) / c["sigma"]), float(np.sqrt(np.mean(r ** 2)) / c["sigma"])


def load(path):
    recs = json.load(open(path, encoding="utf-8"))["records"]
    return [r for r in recs if not r.get("superseded") and r.get("result")]


def analyse(recs):
    curves = defaultdict(list)      # (label, used) -> rows
    runs = []
    slice_rows = []
    for r in recs:
        res, q = r["result"], r["request"]
        tag = (f"{short(r['run'])} {q['md_min_ft']:.0f}-{q['md_max_ft']:.0f}{' Q' if q.get('quick') else ''}"
               f" #{r['job_id'][:4]}")
        for c in res["curves"]:
            b = curve_bias(c)
            if b is None:
                continue
            curves[(c["label"], bool(c["used"]))].append({
                "run": r["run"], "tag": tag, "group": c.get("group"), "kind": c.get("kind"),
                "measurement": c.get("measurement"), "bias_sigma": b[0], "rms_sigma": b[1],
                "bias_pct": c.get("mean_residual_percent"), "correction": c.get("correction_applied")})
        sl = res.get("slices") or []
        inc = arr(res.get("inclination_deg") or [])
        for s in sl:
            rh = [L["rh"] for L in s["layers"]]
            rv = [L["rv"] for L in s["layers"]]
            slice_rows.append({
                "run": r["run"], "tag": tag, "md": s["md_centre_ft"], "misfit": s.get("misfit_normalised"),
                "rh": rh, "rv": rv, "dip": s.get("dip_deg"), "dip_std": s.get("dip_std_deg"),
                "bstd": s.get("boundary_std_ft") or [], "rh_std_log": s.get("rh_std_log") or []})
        mis = [s.get("misfit_normalised") for s in sl if s.get("misfit_normalised") is not None]
        runs.append({"run": r["run"], "tag": tag, "quick": bool(q.get("quick")), "n_slices": len(sl),
                     "n_used": sum(c["used"] for c in res["curves"]),
                     "misfit": res.get("misfit_normalised"), "rms_used_pct": res.get("rms_percent_used"),
                     "slice_misfit_med": median(mis) if mis else None,
                     "frac_slices_misfit_gt2": (sum(m > 2 for m in mis) / len(mis)) if mis else None,
                     "inc_med": float(np.nanmedian(inc)) if inc.size else None,
                     "elapsed_s": res.get("elapsed_s")})
    return curves, runs, slice_rows


def summarise_curves(curves, min_runs=3):
    out = []
    for (label, used), rows in curves.items():
        wells = {}
        for row in rows:                                    # one value per run: mean over its windows
            wells.setdefault(row["run"], []).append(row)
        per_run = [float(np.mean([x["bias_sigma"] for x in v])) for v in wells.values()]
        rms = [float(np.mean([x["rms_sigma"] for x in v])) for v in wells.values()]
        pct = [x["bias_pct"] for x in rows if x["bias_pct"] is not None]
        n = len(per_run)
        pos = sum(b > 0 for b in per_run)
        out.append({"label": label, "used": used, "group": rows[0]["group"], "kind": rows[0]["kind"],
                    "measurement": rows[0]["measurement"], "n_runs": n,
                    "median_bias_sigma": median(per_run), "median_rms_sigma": median(rms),
                    "median_bias_pct": median(pct) if pct else None,
                    "same_sign_frac": max(pos, n - pos) / n,
                    "systematic": n >= min_runs and max(pos, n - pos) / n >= 0.8 and abs(median(per_run)) >= 1.0})
    return sorted(out, key=lambda d: (not d["systematic"], -abs(d["median_bias_sigma"])))


def physics_key(label: str, measurement: str) -> tuple:
    """ARH16P / ZRM48AT -> (measurement, freq letter, spacing); geosignals keep their label."""
    m = re.match(r"(AR|ZR)([HML])(\d+)", label)
    return (measurement, m[2], int(m[3])) if m else (measurement, label, 0)


def rollup(curves, used: bool):
    """Median bias% per (measurement, frequency, spacing) over all runs and curves of that family."""
    fam = defaultdict(lambda: defaultdict(list))
    for (label, u), rows in curves.items():
        if u != used:
            continue
        for row in rows:
            if row["bias_pct"] is not None:
                fam[physics_key(label, row["measurement"])][row["run"]].append(row["bias_pct"])
    out = []
    for key, by_run in fam.items():
        per_run = [float(np.median(v)) for v in by_run.values()]
        pos = sum(b > 0 for b in per_run)
        out.append({"measurement": key[0], "freq": key[1], "spacing_in": key[2], "n_runs": len(per_run),
                    "median_bias_pct": median(per_run), "min": min(per_run), "max": max(per_run),
                    "same_sign_frac": max(pos, len(per_run) - pos) / len(per_run)})
    return sorted(out, key=lambda d: (d["measurement"], "HML".find(d["freq"]), d["spacing_in"]))


Z20 = {"ARH16A": (0.0820, 0.1251), "ARH32A": (0.0567, 0.0871), "ARH48A": (0.0526, 0.0760)}   # invert.py
Z20_ALL = {**Z20, **{f"ZR{k[2:]}{b}": v for k, v in Z20.items() for b in "TB"}}              # service.py


def theory_log(c: dict) -> np.ndarray:
    """Uncorrected forward-model log10 Ra. ``pred`` includes the Z-20 correction when it was applied."""
    t = np.log10(np.where(arr(c["pred"]) > 0, arr(c["pred"]), np.nan))
    if c.get("correction_applied") and c["label"] in Z20_ALL:
        a, g = Z20_ALL[c["label"]]
        t = (t - a + g) / (1 + g)                 # pred = t + a + g (t - 1)
    return t


def well_of(run: str) -> str:
    m = re.match(r"2_4-([A-Z]+-\d+)", run)
    return m[1] if m else run


def correction_fits(recs, min_pts=8):
    """Per well and attenuation curve: least-squares a, g of log obs - log theory = a + g (log theory - 1)."""
    pts = defaultdict(lambda: ([], []))
    for r in recs:
        for c in r["result"]["curves"]:
            if c.get("unit") != "ohm.m" or c.get("measurement") != "attenuation":
                continue
            obs = np.log10(np.where(arr(c["obs"]) > 0, arr(c["obs"]), np.nan))
            t = theory_log(c)
            ok = np.isfinite(obs) & np.isfinite(t)
            xs, ys = pts[(well_of(r["run"]), c["label"])]
            xs.extend((t[ok] - 1).tolist())
            ys.extend((obs[ok] - t[ok]).tolist())
    out = []
    for (well, label), (x, y) in pts.items():
        x, y = np.array(x), np.array(y)
        if x.size < min_pts:
            continue
        spread = float(np.ptp(x))
        if spread > 0.15:                         # >~40% resistivity range: gain is constrained
            g, a = np.polyfit(x, y, 1)
        else:                                     # narrow range: constant factor only
            a, g = float(np.median(y)), float("nan")
        resid = y - (a + (0 if np.isnan(g) else g) * x)
        out.append({"well": well, "label": label, "n": int(x.size), "a": float(a), "g": float(g),
                    "factor_at_10": float(10 ** a),
                    "factor_at_40": float(10 ** (a + g * (np.log10(40) - 1))) if not np.isnan(g) else None,
                    "rt_min": float(10 ** (x.min() + 1)), "rt_max": float(10 ** (x.max() + 1)),
                    "scatter_pct": float(100 * (10 ** np.std(resid) - 1)),
                    "z20": Z20_ALL.get(label)})
    return sorted(out, key=lambda d: (d["label"], d["well"]))


def phase_bias_by_well(curves):
    out = defaultdict(lambda: defaultdict(list))
    for (label, used), rows in curves.items():
        for row in rows:
            if row["measurement"] == "phase" and row["bias_pct"] is not None and label[:2] in ("AR", "ZR"):
                out[well_of(row["run"])][(label[2], "fit" if used else "held")].append(row["bias_pct"])
    return {w: {f"{k[0]} {k[1]}": float(np.median(v)) for k, v in d.items()} for w, d in out.items()}


def saturation(recs):
    """Attenuation curves whose readings pile up at one ceiling value (tool clip) per well."""
    out = []
    for r in recs:
        for c in r["result"]["curves"]:
            if c.get("unit") != "ohm.m":
                continue
            v = arr(c["obs"])
            v = v[np.isfinite(v)]
            if v.size < 5:
                continue
            top = v.max()
            at_top = float(np.mean(np.isclose(v, top, rtol=1e-3)))
            if top > 200 or at_top > 0.2:
                out.append({"well": well_of(r["run"]), "label": c["label"], "max": float(top),
                            "frac_at_max": at_top, "median": float(np.median(v))})
    return out


def fitted_mix(recs):
    out = {}
    for r in recs:
        u = r["plan"]["used"]
        fams = defaultdict(int)
        for e in u:
            k = ("geo" if e["kind"] == "geosignal" else "AR" if e["kind"] == "avg" else
                 "ZR-LS(guessed)" if e.get("guessed_geometry") else "ZR")
            fams[f"{k} {e['label'][2] if e['kind'] != 'geosignal' else ''}{'P' if e['measurement'] == 'phase' else 'A'}"] += 1
        out[r["job_id"][:4]] = {"run": well_of(r["run"]), **dict(sorted(fams.items()))}
    return out


def model_checks(slices):
    per_run = defaultdict(lambda: defaultdict(int))
    for s in slices:
        d = per_run[s["tag"]]
        d["slices"] += 1
        d["pinned_rh"] += any(v <= PIN_LO or v >= PIN_HI for v in s["rh"])
        d["rv_lt_rh"] += any(v < 0.95 * h for h, v in zip(s["rh"], s["rv"]))
        d["aniso_gt10"] += any(v / h > 10 for h, v in zip(s["rh"], s["rv"]) if h > 0)
        d["boundary_unresolved"] += any(b is not None and b >= MAX_BSTD * 0.99 for b in s["bstd"])
        d["misfit_gt2"] += (s["misfit"] or 0) > 2
        d["dip_abs_gt30"] += abs(s["dip"] or 0) > 30
    return {k: dict(v) for k, v in per_run.items()}


def fmt(x, nd=2):
    return "-" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.{nd}f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("snapshot", nargs="?", default="data/graph/inversions.json")
    ap.add_argument("--json", help="write the full QC tables as JSON")
    a = ap.parse_args()
    recs = load(a.snapshot)
    curves, runs, slices = analyse(recs)
    cs = summarise_curves(curves)
    mc = model_checks(slices)

    print(f"{len(recs)} current inversions, {len({r['run'] for r in recs})} runs, {len(slices)} slices\n")
    print("== Per inversion ==")
    print(f"{'inversion':42} {'slices':>6} {'used':>4} {'misfit':>6} {'slice med':>9} {'>2':>5} {'rms%':>6} {'inc':>5}")
    for r in sorted(runs, key=lambda r: r["tag"]):
        print(f"{r['tag'][:42]:42} {r['n_slices']:6d} {r['n_used']:4d} {fmt(r['misfit']):>6} "
              f"{fmt(r['slice_misfit_med']):>9} {fmt(r['frac_slices_misfit_gt2'] and 100*r['frac_slices_misfit_gt2'],0):>4}% "
              f"{fmt(r['rms_used_pct'],1):>6} {fmt(r['inc_med'],0):>5}")

    for used in (True, False):
        print(f"\n== {'Fitted' if used else 'Held-out (not fitted)'} curves: bias per curve across runs "
              f"(+ = tool reads above model; bias/rms in sigma units) ==")
        print(f"{'curve':10} {'meas':>6} {'kind':>9} {'runs':>4} {'bias%':>6} {'bias':>6} {'rms':>6} {'sign':>5}  flag")
        for c in cs:
            if c["used"] != used:
                continue
            print(f"{c['label']:10} {str(c['measurement'])[:6]:>6} {str(c['kind'])[:9]:>9} "
                  f"{c['n_runs']:4d} {fmt(c['median_bias_pct'],1):>6} {fmt(c['median_bias_sigma']):>6} "
                  f"{fmt(c['median_rms_sigma']):>6} {100*c['same_sign_frac']:4.0f}%  {'SYSTEMATIC' if c['systematic'] else ''}")
        print(f"\n   roll-up by family ({'fitted' if used else 'held-out'}): median over runs of each run's median bias%")
        print(f"   {'meas':12} {'freq':>4} {'spc':>4} {'runs':>4} {'median%':>8} {'min%':>7} {'max%':>7} {'sign':>5}")
        for f in rollup(curves, used):
            print(f"   {f['measurement'][:12]:12} {f['freq']:>4} {f['spacing_in']:4d} {f['n_runs']:4d} "
                  f"{f['median_bias_pct']:8.1f} {f['min']:7.1f} {f['max']:7.1f} {100*f['same_sign_frac']:4.0f}%")

    print("\n== Model sanity per inversion (slice counts) ==")
    keys = ["slices", "misfit_gt2", "pinned_rh", "rv_lt_rh", "aniso_gt10", "boundary_unresolved", "dip_abs_gt30"]
    print(f"{'inversion':42} " + " ".join(f"{k[:10]:>10}" for k in keys))
    for tag in sorted(mc):
        print(f"{tag[:42]:42} " + " ".join(f"{mc[tag].get(k, 0):>10d}" for k in keys))

    fits = correction_fits(recs)
    print("\n== Attenuation correction per well: log Ra_meas - log Ra_theory = a + g (log Ra_theory - 1) ==")
    print(f"{'curve':9} {'well':6} {'n':>5} {'Rt range':>11} {'x@10':>6} {'x@40':>6} {'scat%':>6}   Z-20 x@10/x@40")
    for f in fits:
        z = f["z20"]
        zt = f"{10**z[0]:.2f}/{10**(z[0]+z[1]*(np.log10(40)-1)):.2f}" if z else "-"
        print(f"{f['label']:9} {f['well']:6} {f['n']:5d} {f['rt_min']:5.1f}-{f['rt_max']:<5.0f} "
              f"{f['factor_at_10']:6.2f} {fmt(f['factor_at_40']):>6} {f['scatter_pct']:6.1f}   {zt}")

    print("\n== Phase bias% by well (median; freq + fitted/held-out) ==")
    for w, d in sorted(phase_bias_by_well(curves).items()):
        print(f"   {w:6} " + "  ".join(f"{k}: {v:+.1f}" for k, v in sorted(d.items())))

    sat = saturation(recs)
    if sat:
        print("\n== Possible clipped / saturated resistivity readings ==")
        for s in sorted(sat, key=lambda s: (s["label"], s["well"])):
            print(f"   {s['label']:9} {s['well']:6} max {s['max']:9.1f}  at max {100*s['frac_at_max']:4.0f}%  median {s['median']:.1f}")

    print("\n== Channels fitted per inversion ==")
    for jid, m in fitted_mix(recs).items():
        print(f"   #{jid} {m.pop('run'):6} " + ", ".join(f"{k}x{v}" for k, v in m.items()))

    if a.json:
        json.dump({"runs": runs, "curves": cs, "model_checks": mc, "correction_fits": fits,
                   "phase_bias_by_well": phase_bias_by_well(curves), "saturation": sat, "fitted_mix": fitted_mix(recs),
                   "rollup_fitted": rollup(curves, True), "rollup_heldout": rollup(curves, False),
                   "slices": [{k: v for k, v in s.items()} for s in slices]}, open(a.json, "w"), indent=1)
        print(f"\nwrote {a.json}")


if __name__ == "__main__":
    main()
