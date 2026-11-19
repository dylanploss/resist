"""Offline, two-sided transition evidence; not a forward model or inversion."""

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .loader import measurement_metadata


def load_rules(path: Path) -> dict:
    rules = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(rules, dict) or not isinstance(rules.get("reference"), str) or not rules["reference"].strip():
        raise ValueError("Rules require a nonempty calibration reference")
    if not isinstance(rules.get("rules"), list) or not rules["rules"]:
        raise ValueError("Rules require a nonempty rules list")
    labels = set()
    for rule in rules["rules"]:
        if not isinstance(rule, dict):
            raise ValueError("Each rule must be an object")
        label = rule.get("label")
        if not isinstance(label, str) or not label.strip() or label in labels or label in ("unknown", "ambiguous"):
            raise ValueError("Rule labels must be unique nonempty strings, not unknown/ambiguous")
        labels.add(label)
        if not isinstance(rule.get("conditions"), list) or not rule["conditions"]:
            raise ValueError(f"{label}: conditions cannot be empty")
        for condition in rule["conditions"]:
            if not isinstance(condition, dict):
                raise ValueError(f"{label}: each condition must be an object")
            if set(condition) - {"curve", "unit", "min", "max"}:
                raise ValueError(f"{label}: unsupported condition keys")
            if not all(isinstance(condition.get(k), str) and condition[k] for k in ("curve", "unit")):
                raise ValueError(f"{label}: each condition requires curve and unit")
            bounds = [condition[k] for k in ("min", "max") if k in condition]
            if not bounds or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not np.isfinite(v) for v in bounds):
                raise ValueError(f"{label}: requires finite numeric min and/or max")
            if condition.get("min", -np.inf) > condition.get("max", np.inf):
                raise ValueError(f"{label}: min exceeds max")
    return rules


def classify(run, rules):
    labels = np.full(len(run.depth_m), "unknown", dtype=object)
    warnings = []
    if rules is None:
        return labels, ["No geological calibration supplied; labels remain unknown."]
    units = run.metadata.set_index("curve")["unit"].to_dict()
    matches = np.zeros(len(labels), dtype=int)
    for rule in rules["rules"]:
        mask = np.ones(len(labels), dtype=bool)
        for condition in rule["conditions"]:
            name = condition["curve"]
            if name not in run.curves:
                warnings.append(f"{rule['label']}: missing {name}; rule unavailable in this run")
                mask[:] = False
                continue
            if units[name] != condition["unit"] or run.curves[name].ndim != 1:
                raise ValueError(f"{run.path}: rule requires scalar {name} in {condition['unit']}; stored unit {units[name]}")
            v = run.curves[name]
            mask &= np.isfinite(v) & (v >= condition.get("min", -np.inf)) & (v <= condition.get("max", np.inf))
        matches += mask
        labels[mask] = rule["label"]
    labels[matches > 1] = "ambiguous"
    return labels, warnings


def features(run):
    values, groups, floors, warnings = {}, {}, {}, []
    for row in run.metadata.to_dict("records"):
        name, family = row["curve"], row["family"]
        v = run.curves[name].copy()
        if family in ("AR", "ZR"):
            if row["unit"] != "ohmm":
                raise ValueError(f"{name}: expected ohmm, got {row['unit']}")
            info = measurement_metadata(name)
            if family == "AR" and not info["suffix"] and name + "C" in run.curves:
                continue
            if family == "ZR" and v.ndim != 2:
                continue
            v[v <= 0] = np.nan
            v = np.log10(v)
            if v.ndim == 2:
                # Require all bins; no inferred azimuth zero or reconstruction of geosignals.
                complete = np.isfinite(v).all(axis=1)
                mean = np.mean(v, axis=1)
                harmonic = np.abs(np.sum(v * np.exp(-2j * np.pi * np.arange(32) / 32), axis=1)) * 2 / 32
                for suffix, reduced in (("mean_log10", mean), ("harmonic_log10", harmonic)):
                    key = f"{name}:{suffix}"
                    values[key] = np.where(complete, reduced, np.nan)
                    groups[key], floors[key] = "ZR", 0.05
                continue
            floor = 0.05
        elif family == "ZG":
            expected = "deg" if measurement_metadata(name)["measurement"] == "phase" else "dB"
            if row["unit"] != expected:
                raise ValueError(f"{name}: expected {expected}, got {row['unit']}")
            if v.ndim == 2:
                v = np.sqrt(np.mean(v ** 2, axis=1))
            floor = 0.5 if expected == "deg" else 0.05
        elif name == "GR" and row["unit"] == "gAPI" and v.ndim == 1:
            floor, family = 3.0, "GR"
        else:
            continue
        values[name], groups[name], floors[name] = v, family, floor
    if not any(group == "ZG" for group in groups.values()):
        warnings.append("No ZG measurements; directional boundary evidence unavailable.")
    if not values:
        raise ValueError(f"{run.path}: no supported transition measurements")
    return pd.DataFrame(values, index=run.depth_m), groups, pd.Series(floors), warnings


def analyze(run, window_m=3.0, threshold=3.0, min_families=2, rules=None):
    if not np.isfinite(window_m) or window_m <= 0 or not np.isfinite(threshold) or threshold <= 0:
        raise ValueError("window_m and threshold must be positive finite numbers")
    if min_families not in (1, 2, 3, 4):
        raise ValueError("min_families must be in 1..4")
    x, groups, floors, warnings = features(run)
    depth = run.depth_m
    step = float(np.median(np.diff(depth)))
    width = max(3, int(np.ceil(window_m / step)))
    if len(depth) < 2 * width:
        raise ValueError(f"{run.path}: fewer samples than two comparison windows")
    before = x.rolling(width, min_periods=width).median().shift(1)
    after = x.iloc[::-1].rolling(width, min_periods=width).median().iloc[::-1]
    smooth = x.rolling(width, center=True, min_periods=width).median()
    residual = (x - smooth).abs()
    noise = residual.rolling(2 * width + 1, center=True, min_periods=width).median() * 1.4826
    score = (after - before).abs() / noise.clip(lower=floors, axis="columns")
    # No comparison may cross a missing depth section, even if curve values exist.
    gaps = np.flatnonzero(np.diff(depth) > 1.5 * step) + 1
    for gap in gaps:
        score.iloc[max(0, gap - width):min(len(score), gap + width)] = np.nan
    family_scores = pd.DataFrame({
        family: score[[k for k, v in groups.items() if v == family]].median(axis=1)
        for family in sorted(set(groups.values()))
    }, index=depth)
    votes = (family_scores >= threshold).sum(axis=1)
    eligible = np.flatnonzero(votes.to_numpy() >= min_families)
    # Collapse each contiguous response zone before suppressing nearby peaks.
    strength = family_scores.fillna(0).sum(axis=1).to_numpy()
    zones = np.split(eligible, np.flatnonzero(np.diff(eligible) > 1) + 1)
    peaks = []
    for zone in zones:
        if len(zone):
            best = zone[np.isclose(strength[zone], strength[zone].max())]
            peaks.append(int(best[len(best) // 2]))
    selected = []
    for i in sorted(peaks, key=lambda i: (-strength[i], i)):
        if all(abs(depth[i] - depth[j]) >= window_m for j in selected):
            selected.append(int(i))
    labels, rule_warnings = classify(run, rules)
    warnings += rule_warnings

    def dominant(part):
        counts = pd.Series(part).value_counts()
        return str(counts.index[0]) if len(counts) and counts.iloc[0] >= 0.8 * len(part) else "unknown"

    events = []
    for i in sorted(selected):
        evidence = []
        for name in score.columns:
            s = score[name].iloc[i]
            if np.isfinite(s) and s >= threshold:
                evidence.append({
                    "curve_feature": name, "family": groups[name], "score": float(s),
                    "before": float(before[name].iloc[i]), "after": float(after[name].iloc[i]),
                    "scale": "log10(ohmm)" if groups[name] in ("AR", "ZR") else "stored unit",
                })
        events.append({
            "depth_m": float(depth[i]), "depth_ft": float(depth[i] / 0.3048),
            "support_start_m": float(depth[i - width]),
            "support_end_m": float(depth[i + width - 1]),
            "families": [g for g in family_scores if family_scores[g].iloc[i] >= threshold],
            "environment_before": dominant(labels[i - width:i]),
            "environment_after": dominant(labels[i:i + width]),
            "evidence": evidence,
        })
    breaks = sorted(set([0, len(labels), *gaps.tolist(),
                         *(np.flatnonzero(labels[1:] != labels[:-1]) + 1).tolist()]))
    intervals = []
    geological_events = []
    for start, stop in zip(breaks[:-1], breaks[1:]):
        intervals.append({
            "start_m": float(depth[start]), "end_m": float(depth[stop - 1]),
            "label": labels[start], "samples": stop - start,
        })
        if len(intervals) > 1 and start not in gaps:
            previous, current = intervals[-2:]
            if (min(previous["samples"], current["samples"]) >= width and
                    previous["label"] not in ("unknown", "ambiguous") and
                    current["label"] not in ("unknown", "ambiguous") and
                    previous["label"] != current["label"]):
                geological_events.append({
                    "depth_m": float(depth[start]), "from": previous["label"], "to": current["label"],
                    "basis": "user-supplied classification rules; not independently validated",
                })
    return {
        "settings": {"window_m": window_m, "window_samples": width, "threshold": threshold,
                     "min_families": min_families,
                     "noise_floors": {"log10_ohmm": 0.05, "ZG_deg": 0.5, "ZG_dB": 0.05, "GR_gAPI": 3.0}},
        "warnings": warnings,
        "limitations": [
            "Offline two-sided detector; requires future samples and is not real-time.",
            "Uncalibrated heuristic scores are not probabilities or geological validation.",
            "AR/ZR are correlated families; corroboration is not independent physical proof.",
            "Tool identity, bin zero, antenna mapping and C corrections remain unconfirmed.",
            "No conversion of resistivity images to raw phase/attenuation or boundary distance.",
        ],
        "calibration": rules, "events": events, "geological_events": geological_events,
        "scores": family_scores, "intervals": pd.DataFrame(intervals),
    }
