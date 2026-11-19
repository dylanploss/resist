"""Misfit and correction-factor study for one well interval.

Example (hackathon default, Z-20 good interval):

    python -m backend.inversion.misfit_study --well Z-20 --md-min 20100 --md-max 20500 \
        --split 20300 --output out/z20_misfit

Experiments:
  E1  1.5D layered fit, no correction                       -> raw theory-vs-tool misfit
  E2  same with free per-curve log-bias (correction factor)  -> how much a correction explains
  E3  hold-out: biases calibrated on one half, applied to the other half (both directions)
  E4  residual-vs-level regression on E1 (does the mismatch scale with resistivity?)
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from backend.inversion.adr_forward import ADRForward
from backend.inversion.invert import (FitConfig, Inverter, LevelCorrection, default_run_path, default_starts,
                                      load_interval)


def fit_window(data, k, fit_bias=False, fixed_bias=None, x0=None, receiver_sep_in=8.0, coarse=True, max_nfev=25,
               weights=None):
    cfg = FitConfig(n_layers=k, fit_bias=fit_bias, fixed_bias=fixed_bias, max_nfev=max_nfev, curve_weights=weights)
    if x0 is None and coarse and len(data.md_ft) > 60:
        sub = data.subset(np.arange(len(data.md_ft)) % 2 == 0)
        with Inverter(sub, FitConfig(n_layers=k, fit_bias=False, fixed_bias=fixed_bias, max_nfev=12,
                                     curve_weights=weights), receiver_sep_in) as inv:
            best = inv.multistart(default_starts(inv, sub, k))
        x0 = best.x
        if fit_bias:
            x0 = np.concatenate([x0, np.zeros(data.obs.shape[1])])
    with Inverter(data, cfg, receiver_sep_in) as inv:
        if x0 is None:
            return inv.multistart(default_starts(inv, data, k, np.zeros(data.obs.shape[1]) if fit_bias else None))
        return inv.fit(x0)


def residual_level_regression(res):
    """Slope/intercept of residual (decades) against modelled log10 resistivity, per curve."""
    out = {}
    for j, lab in enumerate(res.labels):
        A = np.column_stack([np.ones(len(res.theory)), res.theory[:, j]])
        coef, *_ = np.linalg.lstsq(A, res.residual[:, j], rcond=None)
        out[lab] = {"intercept": round(float(coef[0]), 4), "slope": round(float(coef[1]), 4)}
    return out


def phase_only_attenuation_check(data, k, split, receiver_sep_in):
    """E5: earth model from phase curves only; calibrate attenuation corrections on one half of the
    interval and score them on the other half (constant factor vs resistivity-dependent gain)."""
    phase = [lab for lab in data.labels if lab.endswith("P")]
    atten = [lab for lab in data.labels if lab.endswith("A")]
    fit = fit_window(data, k, receiver_sep_in=receiver_sep_in, weights={lab: 0.0 for lab in atten})
    halves = {"upper": data.md_ft < split, "lower": data.md_ft >= split}
    ja = [data.labels.index(lab) for lab in atten]

    def rms(theory, obs, mask):
        r = (obs - theory)[mask][:, ja]
        return dict(zip(atten, (100 * (10 ** np.sqrt(np.mean(r ** 2, axis=0)) - 1)).round(2).tolist()))

    out = {"phase_only_model": fit.summary(), "holdout": {}}
    for cal, test in (("upper", "lower"), ("lower", "upper")):
        mc, mt = halves[cal], halves[test]
        entry = {"none": rms(fit.theory, data.obs, mt)}
        for name, gain in (("constant", False), ("gain", True)):
            corr = LevelCorrection.fit(fit.theory[mc], data.obs[mc], data.labels, atten, gain=gain)
            entry[name] = rms(corr.apply_to_theory(fit.theory), data.obs, mt)
            entry[f"{name}_parameters"] = corr.to_measured_frame()
        out["holdout"][f"calibrate_{cal}_test_{test}"] = entry
    full = LevelCorrection.fit(fit.theory, data.obs, data.labels, atten, gain=True)
    out["recommended_gain_correction_full_interval"] = full.to_measured_frame()
    return fit, out


def plot(data, preds, model, path, title):
    """preds: {name: (log10 prediction array, color)}; model supplies boundaries for the TVD track."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    labels = data.labels
    n = len(labels) // 2
    fig, axes = plt.subplots(1, n + 1, figsize=(3 * (n + 1), 9), sharey=True)
    md = data.md_ft
    for j in range(n):
        ax = axes[j]
        for col, style in ((j, "-"), (j + n, "--")):
            ax.plot(10 ** data.obs[:, col], md, "k" + style, lw=1, label=f"{labels[col]} data")
            for name, (pred, color) in preds.items():
                ax.plot(10 ** pred[:, col], md, style, color=color, lw=0.9, label=f"{labels[col]} {name}")
        ax.set_xscale("log"); ax.set_title(labels[j][:-1]); ax.grid(alpha=0.3)
        if j == 0:
            ax.legend(fontsize=6)
    ax = axes[-1]
    ax.plot(data.tvd_ft, md, "k", lw=1)
    for b in model.boundaries_m / 0.3048 + data.ref_ned[2] / 0.3048:
        ax.axvline(b, color="tab:blue", ls=":")
    ax.set_title("TVD and model boundaries (ref N/E)"); ax.grid(alpha=0.3)
    axes[0].invert_yaxis(); axes[0].set_ylabel("MD (ft)")
    fig.suptitle(title)
    fig.tight_layout(); fig.savefig(path, dpi=110); plt.close(fig)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data-dir", default="data")
    p.add_argument("--well", default="Z-20")
    p.add_argument("--md-min", type=float, default=20100)
    p.add_argument("--md-max", type=float, default=20500)
    p.add_argument("--split", type=float, default=20300)
    p.add_argument("--step-ft", type=float, default=2.0)
    p.add_argument("--layers", type=int, default=3)
    p.add_argument("--corrected", action="store_true", help="use the vendor 'C' curves")
    p.add_argument("--receiver-sep-in", type=float, default=8.0)
    p.add_argument("--output", default="out/misfit_study")
    p.add_argument("--experiments", default="E1,E2,E3,E4,E5", help="comma list of E1..E5")
    a = p.parse_args(argv)
    todo = {e.strip().upper() for e in a.experiments.split(",")}

    out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
    fwd = ADRForward(receiver_sep_in=a.receiver_sep_in)
    path = default_run_path(a.data_dir, a.well)
    data = load_interval(path, a.md_min, a.md_max, fwd, a.step_ft, a.corrected)
    print(f"{data.well}: {len(data.md_ft)} stations, curves {data.labels}", flush=True)

    report_path = out / "report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    report.update({
        "well": data.well, "run": path.name, "md_ft": [a.md_min, a.md_max], "split_md_ft": a.split,
        "curves": "corrected (C)" if a.corrected else "raw",
        "assumptions": {"receiver_sep_in": a.receiver_sep_in, "transform": "homogeneous isotropic whole space",
                        "averaged_curve_physics": "ZZ coupling (azimuthal mean of tilted receiver)",
                        "reference_curves_zero_mean_bias": list(FitConfig().reference)},
    })
    meta = {"step_ft": a.step_ft, "stations": int(len(data.md_ft))}
    res = {}
    if todo & {"E1", "E2", "E4"}:
        res["E1"] = fit_window(data, a.layers, receiver_sep_in=a.receiver_sep_in)
        report["E1_no_correction"] = {**meta, **res["E1"].summary()}
        print("E1", json.dumps(report["E1_no_correction"]), flush=True)
    if "E2" in todo:
        x0 = np.concatenate([res["E1"].x, np.zeros(data.obs.shape[1])])
        res["E2"] = fit_window(data, a.layers, fit_bias=True, x0=x0, receiver_sep_in=a.receiver_sep_in)
        report["E2_constant_correction"] = {**meta, **res["E2"].summary()}
        print("E2", json.dumps(report["E2_constant_correction"]), flush=True)
    if "E3" in todo:
        report["E3_holdout_constant_correction"] = holdout_constant(data, a)
    if "E4" in todo:
        report["E4_residual_vs_level_E1"] = residual_level_regression(res["E1"])
    if "E5" in todo:
        res["E5"], report["E5_phase_only_attenuation_check"] = phase_only_attenuation_check(
            data, a.layers, a.split, a.receiver_sep_in)
        report["E5_phase_only_attenuation_check"]["phase_only_model"].update(meta)
        print("E5", json.dumps(report["E5_phase_only_attenuation_check"]), flush=True)
    report_path.write_text(json.dumps(report, indent=2))

    colors = {"E1": "tab:red", "E2": "tab:blue", "E5": "tab:green"}
    preds = {k: (r.pred, colors[k]) for k, r in res.items()}
    if "E5" in res:
        atten = [lab for lab in data.labels if lab.endswith("A")]
        corr = LevelCorrection.fit(res["E5"].theory, data.obs, data.labels, atten, gain=True)
        preds["E5+gain"] = (corr.apply_to_theory(res["E5"].theory), "tab:purple")
    if preds:
        model = (res.get("E2") or res.get("E5") or res["E1"]).model
        name = "_".join(sorted(res))
        plot(data, preds, model, out / f"fit_{name}.png",
             f"{data.well}: " + ", ".join(f"{k}={c}" for k, (_, c) in preds.items()))
        import pandas as pd
        cols = {"md_ft": data.md_ft, "tvd_ft": data.tvd_ft, "gr": data.gr}
        for j, lab in enumerate(data.labels):
            cols[f"{lab}_obs"] = 10 ** data.obs[:, j]
            for k, (pred, _) in preds.items():
                cols[f"{lab}_{k}"] = 10 ** pred[:, j]
        pd.DataFrame(cols).to_csv(out / f"fit_{name}.csv", index=False)
    print("wrote", out)


def holdout_constant(data, a):
    """E3: constant per-curve biases calibrated on one half, applied to the other half."""
    upper = data.subset(data.md_ft < a.split)
    lower = data.subset(data.md_ft >= a.split)
    holdout = {}
    for cal_name, cal, test_name, test in (("upper", upper, "lower", lower), ("lower", lower, "upper", upper)):
        cal_fit = fit_window(cal, a.layers, receiver_sep_in=a.receiver_sep_in)
        cal_fit = fit_window(cal, a.layers, fit_bias=True, x0=np.concatenate([cal_fit.x, np.zeros(cal.obs.shape[1])]),
                             receiver_sep_in=a.receiver_sep_in)
        plain = fit_window(test, a.layers, receiver_sep_in=a.receiver_sep_in)
        corrected = fit_window(test, a.layers, fixed_bias=cal_fit.bias, x0=plain.x, receiver_sep_in=a.receiver_sep_in)
        key = f"calibrate_{cal_name}_test_{test_name}"
        holdout[key] = {
            "calibration_bias_percent": dict(zip(data.labels, (100 * (10 ** cal_fit.bias - 1)).round(2).tolist())),
            "test_rms_percent_without_correction": round(float(plain.rms_percent()), 2),
            "test_rms_percent_with_correction": round(float(corrected.rms_percent()), 2),
            "test_rms_by_curve_without": dict(zip(data.labels, plain.rms_percent(0).round(2).tolist())),
            "test_rms_by_curve_with": dict(zip(data.labels, corrected.rms_percent(0).round(2).tolist())),
            "test_model_without": plain.summary(), "test_model_with": corrected.summary(),
        }
        print("E3", key, holdout[key]["test_rms_percent_without_correction"], "->",
              holdout[key]["test_rms_percent_with_correction"], flush=True)
    return holdout


if __name__ == "__main__":
    main()

