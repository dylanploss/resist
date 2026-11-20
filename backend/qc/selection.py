"""Rank ADR curves for inversion: read as deep as possible, drop noisy and duplicate curves."""

import argparse
import json
import math

import numpy as np

from backend.qc import metrics

MIN_COVERAGE = 0.8
# A curve clipped at the tool limit on more than this fraction of its delivered samples in the interval is rejected.
MAX_CLIPPED = 0.5
MAX_JAGGEDNESS = 0.8
# Above 1 a curve is rougher than white noise and carries no usable signal.
MAX_FALLBACK_JAGGEDNESS = 1.0
# Random bins give purity about 2/31 and asymmetry about 1.1.
MIN_FALLBACK_PURITY = 0.25
MAX_FALLBACK_ASYMMETRY = 0.8
MAX_SPIKES = 0.025
MIN_GEOSIGNAL_PURITY = 0.5
MAX_GEOSIGNAL_ASYMMETRY = 0.5
MAX_CORRELATION = 0.98
MIN_OVERLAP = 100
SHALLOW_MAX_DOI = 2.0
MEDIUM_MAX_DOI = 8.0
DEFAULT_SELECT = 8
SELECT_RANGE = (5, 10)
# Filled in order before ranking, so every inversion gets a shallow anchor and deep geosignals.
# Several runs have no deep AR or no ZG, so resistivity slots also accept ZR images.
SLOTS = [(("AR", "ZR"), "deep"), (("ZG",), "deep"), (("AR",), "shallow"), (("ZG",), "deep"),
         (("AR", "ZR"), "medium"), (("ZG",), "medium")]


def doi_tier(doi: float) -> str:
    if doi <= SHALLOW_MAX_DOI:
        return "shallow"
    return "medium" if doi <= MEDIUM_MAX_DOI else "deep"


def _features(family: str, values: np.ndarray, tool_clipped: float = 0.0) -> dict:
    """Reduce a channel to the depth series used for noise and redundancy checks.

    ``tool_clipped`` is the fraction of delivered samples the loader masked as clip values; samples stuck at another
    limit (``metrics.mask_saturation``) count as clipped too."""
    if family in ("AR", "ZR"):
        masked, stuck = metrics.mask_saturation(values)
        logs = metrics.log_positive(masked)
        clipped = tool_clipped + (1 - tool_clipped) * _nan_to(stuck, 0.0)
        out = {"clipped": clipped, "range_ok": metrics.range_ok(masked)}
        if logs.ndim == 1:
            return {**out, "series": logs}
        h = metrics.harmonics(logs)
        return {**out, "series": h["mean"], "purity": h["purity"]}
    if np.ndim(values) == 1:
        return {"series": np.asarray(values, dtype=float), "clipped": 0.0, "range_ok": True}
    h = metrics.harmonics(values)
    return {"series": h["amplitude"], "purity": h["purity"], "clipped": 0.0, "range_ok": True,
            "asymmetry": metrics.antisymmetry(values)}


def score_curve(row: dict, values: np.ndarray, tool_clipped: float = 0.0) -> dict:
    """Quality is 1 - jaggedness, scaled by coverage and geosignal shape; score adds depth."""
    family = row["family"]
    f = _features(family, values, tool_clipped)
    series = f["series"]
    coverage = float(np.isfinite(series).mean())
    jagged = metrics.jaggedness(series)
    spikes = metrics.spike_fraction(series)
    doi = metrics.doi_index(row["spacing_in"], row["frequency_hz"], row["measurement"])

    quality = coverage * max(0.0, 1 - _nan_to(jagged, 1.0))
    quality *= 1 - 0.5 * min(1.0, _nan_to(spikes, 0.0) / MAX_SPIKES)
    if family == "ZG" and "purity" in f:
        quality *= _nan_to(f["purity"], 0.0) * (1 - min(1.0, _nan_to(f["asymmetry"], 1.0)))
    depth_weight = math.log1p(doi) / math.log1p(metrics.doi_index(112, 125_000, "attenuation"))
    return {
        "score": quality * depth_weight,
        "quality": quality,
        "coverage": coverage,
        "noise": jagged,
        "range_ok": f["range_ok"],
        "clipped": f["clipped"],
        "spikes": spikes,
        "harmonic_purity": f.get("purity"),
        "asymmetry": f.get("asymmetry"),
        "doi_index": doi,
        "doi_tier": doi_tier(doi),
        "family": family,
        "frequency_hz": row["frequency_hz"],
        "spacing_in": row["spacing_in"],
        "measurement": row["measurement"],
        "_series": series,
    }


def _nan_to(x, default):
    return default if x is None or not np.isfinite(x) else x


def _ineligible_reason(s: dict, best_coverage: float) -> tuple[str, str] | None:
    """Return (kind, reason); kind is 'clipped', 'coverage', 'range' or 'noisy'."""
    if _nan_to(s["clipped"], 0.0) > MAX_CLIPPED:
        return "clipped", f"mostly clipped: tool-limit values on {s['clipped']:.0%} of samples in the interval"
    if s["coverage"] < MIN_COVERAGE * best_coverage:
        if _nan_to(s["clipped"], 0.0) > 0.05:
            return "coverage", f"clipped at tool limit on {s['clipped']:.0%} of samples"
        return "coverage", (f"coverage {s['coverage']:.2f} below {MIN_COVERAGE:.0%} "
                            f"of the run's best ({best_coverage:.2f})")
    if not s["range_ok"]:
        return "range", "values outside plausible resistivity range"
    if _nan_to(s["noise"], 1.0) > MAX_JAGGEDNESS:
        return "noisy", f"static: sample-to-sample jumps look like noise (jaggedness {_fmt(s['noise'])})"
    if _nan_to(s["spikes"], 0.0) > MAX_SPIKES:
        return "noisy", f"spiky: {s['spikes']:.1%} of samples are isolated spikes"
    if s["family"] == "ZG" and s["harmonic_purity"] is not None:
        if _nan_to(s["harmonic_purity"], 0.0) < MIN_GEOSIGNAL_PURITY:
            return "noisy", (f"noisy geosignal: bins do not follow one sinusoid "
                             f"(purity {_fmt(s['harmonic_purity'])})")
        if _nan_to(s["asymmetry"], 1.0) > MAX_GEOSIGNAL_ASYMMETRY:
            return "noisy", (f"noisy geosignal: opposite bins do not mirror "
                             f"(asymmetry {_fmt(s['asymmetry'])})")
    return None


def _fmt(x) -> str:
    return "n/a" if x is None or not np.isfinite(x) else f"{x:.2f}"


def _correlation(a: np.ndarray, b: np.ndarray) -> float:
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < MIN_OVERLAP or np.std(a[ok]) == 0 or np.std(b[ok]) == 0:
        return np.nan
    return float(np.corrcoef(a[ok], b[ok])[0, 1])


def _redundant_with(name: str, scores: dict, chosen: list[str]) -> tuple[str, float] | None:
    """Only same-spacing curves can be redundant; longer spacings differ where it matters, near boundaries."""
    for other in chosen:
        if (scores[other]["family"] == "ZG") != (scores[name]["family"] == "ZG") or \
                scores[other]["spacing_in"] != scores[name]["spacing_in"]:
            continue
        r = _correlation(scores[name]["_series"], scores[other]["_series"])
        if np.isfinite(r) and abs(r) > MAX_CORRELATION:
            return other, r
    return None


def _usable_fallback(s: dict) -> bool:
    """Noisy but still carrying signal: not rougher than white noise, and not random bins."""
    if _nan_to(s["noise"], np.inf) > MAX_FALLBACK_JAGGEDNESS:
        return False
    if s["family"] == "ZG" and s["harmonic_purity"] is not None:
        return (_nan_to(s["harmonic_purity"], 0.0) >= MIN_FALLBACK_PURITY
                and _nan_to(s["asymmetry"], np.inf) <= MAX_FALLBACK_ASYMMETRY)
    return True


def _measurement_key(s: dict) -> tuple:
    """AR, ZR images, quadrants and C twins of one measurement share a key; ZG is separate."""
    kind = "geosignal" if s["family"] == "ZG" else "resistivity"
    return kind, s["frequency_hz"], s["spacing_in"], s["measurement"]


def select_curves(run, n_select: int = DEFAULT_SELECT, md_min_ft: float | None = None,
                  md_max_ft: float | None = None) -> dict:
    """Return the QC selection JSON for one WellRun from backend.data.loader, scored on the samples between
    ``md_min_ft`` and ``md_max_ft`` (default: the whole run)."""
    if not SELECT_RANGE[0] <= n_select <= SELECT_RANGE[1]:
        raise ValueError(f"n_select must be between {SELECT_RANGE[0]} and {SELECT_RANGE[1]}")
    md = np.asarray(run.curves["DEPT"], float) if "DEPT" in run.curves else run.depth_m / 0.3048
    rows = (md >= (-np.inf if md_min_ft is None else md_min_ft)) & (md <= (np.inf if md_max_ft is None else md_max_ft))
    if not rows.any():
        raise ValueError(f"no samples between {md_min_ft} and {md_max_ft} ft MD")
    scores, rejected, noisy = {}, {}, set()
    for row in run.metadata.to_dict("records"):
        name = row["curve"]
        if row.get("family") not in ("AR", "ZR", "ZG"):
            rejected[name] = "no resistivity or geosignal information"
            scores[name] = {"score": 0.0, "coverage": row.get("valid_fraction"),
                            "noise": None, "range_ok": None, "family": "conventional"}
            continue
        clipped = run.clipped_fraction(name, rows) if hasattr(run, "clipped_fraction") else 0.0
        scores[name] = score_curve(row, run.curves[name][rows], clipped)
    candidates = [n for n, s in scores.items() if s["family"] != "conventional"]
    best_coverage = max((scores[n]["coverage"] for n in candidates), default=0.0)
    for name in candidates:
        verdict = _ineligible_reason(scores[name], best_coverage)
        if verdict:
            rejected[name] = verdict[1]
            if verdict[0] == "noisy":
                noisy.add(name)

    ranked = sorted((n for n in candidates if n not in rejected),
                    key=lambda n: scores[n]["score"], reverse=True)
    selected, reasons, warnings = [], {}, []

    def try_add(name: str, why: str) -> bool:
        if name in selected or name in rejected:
            return False
        key = _measurement_key(scores[name])
        same = next((o for o in selected if _measurement_key(scores[o]) == key), None)
        if same:
            rejected[name] = f"same measurement as {same}"
            return False
        dup = _redundant_with(name, scores, selected)
        if dup:
            rejected[name] = f"redundant with {dup[0]} (r={dup[1]:.3f})"
            return False
        selected.append(name)
        reasons[name] = why
        return True

    fallback_used = set()
    deepest_first = sorted(ranked, key=lambda n: (-scores[n]["spacing_in"], -scores[n]["score"]))
    for families, tier in SLOTS:
        if len(selected) >= n_select:
            break
        if tier == "deep":
            filled = any(try_add(n, f"longest clean spacing ({scores[n]['spacing_in']:g} in) for deep "
                                    f"{scores[n]['family']}") for n in deepest_first
                         if scores[n]["family"] in families and scores[n]["doi_tier"] == tier)
        else:
            filled = any(try_add(n, f"best clean {tier} {scores[n]['family']} curve") for n in ranked
                         if scores[n]["family"] in families and scores[n]["doi_tier"] == tier)
        if filled:
            continue
        if tier != "deep" or families in fallback_used or any(
                scores[n]["family"] in families and scores[n]["doi_tier"] == tier for n in selected):
            continue
        fallback_used.add(families)
        fallback = sorted((n for n in noisy if scores[n]["family"] in families
                           and scores[n]["doi_tier"] == tier and _usable_fallback(scores[n])),
                          key=lambda n: _nan_to(scores[n]["noise"], np.inf))
        for name in fallback:
            reason = rejected.pop(name)
            if try_add(name, f"fallback: least noisy deep {scores[name]['family']} curve"):
                noisy.discard(name)
                warnings.append(f"{name} kept despite noise ({reason}); no clean deep "
                                f"{'/'.join(families)} curve in this run")
                break
            rejected.setdefault(name, reason)
        else:
            warnings.append(f"no usable deep {'/'.join(families)} curve in this run")
    for freq in sorted({scores[n]["frequency_hz"] for n in ranked}):
        if len(selected) >= n_select:
            break
        if not any(scores[n]["frequency_hz"] == freq for n in selected):
            any(try_add(n, f"adds {freq / 1000:g} kHz coverage") for n in ranked
                if scores[n]["frequency_hz"] == freq)
    for name in ranked:
        if len(selected) >= n_select:
            break
        try_add(name, "next best depth-weighted quality")
    for name in ranked:
        if name not in selected and name not in rejected:
            rejected[name] = f"clean but ranked below selection (score {scores[name]['score']:.2f})"
    if len(selected) < SELECT_RANGE[0]:
        warnings.append(f"only {len(selected)} curves passed QC; minimum is {SELECT_RANGE[0]}")

    for s in scores.values():
        s.pop("_series", None)
    return _json_safe({
        "well": run.well,
        "run": run.path.stem,
        "md_min_ft": float(md[rows][0]),
        "md_max_ft": float(md[rows][-1]),
        "selected": selected,
        "selected_reasons": reasons,
        "rejected": [{"curve": n, "reason": r} for n, r in rejected.items()],
        "scores": scores,
        "warnings": warnings,
    })


def _json_safe(x):
    if isinstance(x, dict):
        return {k: _json_safe(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_json_safe(v) for v in x]
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    if isinstance(x, (float, np.floating)):
        return float(x) if np.isfinite(x) else None
    if isinstance(x, np.integer):
        return int(x)
    return x


def main():
    from backend.data.loader import load_run

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dlis")
    parser.add_argument("-n", "--n-select", type=int, default=DEFAULT_SELECT)
    args = parser.parse_args()
    print(json.dumps(select_curves(load_run(args.dlis), args.n_select), indent=2))


if __name__ == "__main__":
    main()
