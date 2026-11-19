"""Batch CLI: inventory, change evidence, optional geological rules and plots."""

import argparse
import gzip
import json
from pathlib import Path

import numpy as np

from .loader import load_run
from .transitions import analyze, load_rules


def plot_run(run, result, destination):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(3, 1, figsize=(14, 8), sharex=True)
    for row in run.metadata.to_dict("records"):
        name = row["curve"]
        if row["family"] == "AR" and run.curves[name].ndim == 1:
            values = run.curves[name].copy()
            values[values <= 0] = np.nan
            axes[0].plot(run.depth_m, values, alpha=0.4, linewidth=0.5)
    axes[0].set_yscale("log")
    axes[0].set_ylabel("AR (ohm m)")
    if "GR" in run.curves:
        axes[1].plot(run.depth_m, run.curves["GR"], linewidth=0.6)
    axes[1].set_ylabel("GR (stored unit)")
    for family in result["scores"].columns:
        axes[2].plot(run.depth_m, result["scores"][family], label=family, linewidth=0.7)
    axes[2].axhline(result["settings"]["threshold"], color="black", linestyle="--")
    axes[2].legend(loc="upper right")
    axes[2].set_ylabel("Change / local noise")
    axes[2].set_xlabel("Measured depth (m below RKB; release convention)")
    for event in result["events"]:
        for axis in axes:
            axis.axvline(event["depth_m"], color="red", alpha=0.25)
    fig.suptitle(f"{run.well} | {run.path.stem}\nCandidate changes, not validated geological boundaries")
    fig.tight_layout()
    fig.savefig(destination, dpi=120)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--window-m", type=float, default=3.0)
    parser.add_argument("--threshold", type=float, default=3.0)
    parser.add_argument("--min-families", type=int, default=2)
    parser.add_argument("--rules", type=Path, help="Calibrated geological classification JSON")
    parser.add_argument("--export-tidy", action="store_true", help="Write all samples/bins to CSV.gz")
    parser.add_argument("--no-plots", action="store_true")
    args = parser.parse_args()
    paths = sorted(args.data_dir.glob("*.dlis"))
    if not paths:
        parser.error(f"No .dlis files in {args.data_dir.resolve()}")
    rules = load_rules(args.rules) if args.rules else None
    args.output.mkdir(parents=True, exist_ok=True)
    summaries, inventories = [], []
    for path in paths:
        run = load_run(path)
        result = analyze(run, args.window_m, args.threshold, args.min_families, rules)
        folder = args.output / path.stem
        folder.mkdir(exist_ok=True)
        run.metadata.to_csv(folder / "inventory.csv", index=False)
        inventories.append(run.metadata)
        result["scores"].to_csv(folder / "change_scores.csv", index_label="depth_m")
        result["intervals"].to_csv(folder / "environments.csv", index=False)
        report = {key: value for key, value in result.items() if key not in ("scores", "intervals")}
        report.update(well=run.well, run=path.stem, source=str(path.resolve()),
                      parameters=run.parameters)
        (folder / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
        if args.export_tidy:
            with gzip.open(folder / "curves.csv.gz", "wt", encoding="utf-8", newline="") as stream:
                for i, table in enumerate(run.tidy()):
                    table.to_csv(stream, index=False, header=i == 0)
        if not args.no_plots:
            plot_run(run, result, folder / "overview.png")
        summaries.append({
            "well": run.well, "run": path.stem, "samples": len(run.depth_m),
            "curves": len(run.metadata), "candidate_transitions": len(result["events"]),
            "geological_transitions": len(result["geological_events"]),
        })
        print(f"{run.well}: {len(result['events'])} candidates; {folder}")
    import pandas as pd
    pd.concat(inventories, ignore_index=True).to_csv(args.output / "inventory.csv", index=False)
    summary = {
        "well_count": len({r["well"] for r in summaries}), "run_count": len(summaries),
        "runs": summaries, "calibration": rules,
        "interpretation": "Candidate changes only; geological labels unknown without calibrated rules.",
    }
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    main()
