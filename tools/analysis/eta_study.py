#!/usr/bin/env python3
"""eta_study.py — offline error decomposition + strategy search for the dsh ETA.

Reads data/samples.csv (produced by tools/dump-samples.mjs), which contains the
exact replay samples used by the Node evaluator plus a feature vector that is
available to the live plugin at prediction time, and the v2 prediction.

Sections
  1. baseline (v2) accuracy on the test split, same samples as Node eval
  2. error decomposition: bias vs variance, per-segment breakdown
  3. information limit: how much of the remaining spread is reachable from
     (k, elapsed) alone, and what the oracle/open-loop bounds look like
  4. new-input value: quantile LightGBM ablations (session pace / prompt /
     plan / tool state) + simulated "pre-flight prior on total steps"
  5. confidence calibration: what the current low/medium/high labels are worth,
     and conformal interval coverage for the new model

Usage: python3 tools/analysis/eta_study.py [--stage all|base|gbt|prior]
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data/samples.csv"

FEATURE_GROUPS = {
    "core": ["k", "elapsed_ms", "step_elapsed_ms", "step_open", "step_has_tools",
             "tools_done_in_step", "pending_tools", "last_tool_cat", "since_last_evt_ms"],
    "pace": ["prev_step_mean_ms", "prev_step_max_ms", "step_ms_ema",
             "n_prev_turns", "prev_turn_dur_med", "prev_turn_steps_med"],
    "prompt": ["prompt_chars", "prompt_lines", "prompt_code_fences", "prompt_commands",
               "prompt_mentions", "prompt_questions", "prompt_has_image", "prompt_cjk_ratio"],
    "plan": ["plan_n", "plan_done", "plan_has"],
    "tools": ["turn_tools_bash", "turn_tools_edit", "turn_tools_read", "turn_tools_image",
              "turn_tools_agent"],
    "struct": ["turn_index"],
}
ALL_FEATURES = [f for group in FEATURE_GROUPS.values() for f in group]
EVAL_ONLY = {"remaining_ms", "dur_ms", "total_steps", "reason_ok", "v2_pred",
             "v2_conf", "v2_reliability", "v2_cell_samples", "split", "sid", "turn", "t_rel"}


def fmt_ms(v: float) -> str:
    v = float(v)
    if abs(v) >= 60_000:
        return f"{v / 60_000:.1f}m"
    if abs(v) >= 1_000:
        return f"{v / 1000:.1f}s"
    return f"{v:.0f}ms"


def score(pred: np.ndarray, actual: np.ndarray) -> dict:
    err = pred - actual
    abs_err = np.abs(err)
    rel = abs_err / np.maximum(3_000.0, actual)
    return {
        "n": int(len(pred)),
        "mae": float(abs_err.mean()),
        "median_ae": float(np.median(abs_err)),
        "rmse": float(math.sqrt((err ** 2).mean())),
        "bias": float(err.mean()),
        "p10": float(np.quantile(err, 0.10)),
        "p50": float(np.quantile(err, 0.50)),
        "p90": float(np.quantile(err, 0.90)),
        "mape": float(np.minimum(rel, 5.0).mean()),
    }


def score_line(label: str, s: dict) -> str:
    return (f"{label:<26} n={s['n']:>7}  MAE={fmt_ms(s['mae']):>8}  medAE={fmt_ms(s['median_ae']):>8}"
            f"  bias={('+' if s['bias'] >= 0 else '-') + fmt_ms(abs(s['bias'])):>9}"
            f"  p10-p90={fmt_ms(s['p10'])}..{fmt_ms(s['p90'])}  MAPE={s['mape']:.2f}")


def load() -> pd.DataFrame:
    dtypes = {c: "float32" for c in ALL_FEATURES}
    dtypes.update({"remaining_ms": "float32", "dur_ms": "float32", "total_steps": "float32",
                   "v2_pred": "float32", "v2_conf": "int8", "v2_reliability": "float16",
                   "v2_cell_samples": "float32", "k": "float32", "turn": "int32", "t_rel": "int32"})
    df = pd.read_csv(DATA, dtype=dtypes, usecols=["split", "sid", "turn", "t_rel", "v2_conf",
                                                  "remaining_ms", "dur_ms", "total_steps", "v2_pred",
                                                  "v2_reliability", "v2_cell_samples"] + ALL_FEATURES)
    df["log_remaining"] = np.log1p(df["remaining_ms"].astype(np.float64))
    return df


def buckets():
    return [
        ("elapsed", [0, 15_000, 60_000, 180_000, 600_000, float("inf")],
         ["<15s", "15-60s", "1-3m", "3-10m", ">10m"]),
        ("k", [0, 1, 3, 8, 20, 50, float("inf")], ["0", "1-2", "3-7", "8-19", "20-49", "50+"]),
        ("dur_ms", [0, 30_000, 120_000, 300_000, 900_000, float("inf")],
         ["<30s", "30-120s", "2-5m", "5-15m", ">15m"]),
        ("prompt_chars", [0, 120, 400, 1_200, 4_000, float("inf")],
         ["0-120", "120-400", "400-1.2k", "1.2k-4k", ">4k"]),
        ("plan_has", [0, 1, 2], ["no-plan", "plan"]),
        ("v2_conf", [0, 1, 2, 3], ["low", "medium", "high"]),
    ]


def segment_report(df: pd.DataFrame, pred_col: str = "v2_pred") -> None:
    for column, edges, labels in buckets():
        if column not in df.columns:
            continue
        subset = df[df[column].notna()]
        groups = pd.cut(subset[column], bins=edges, labels=labels, right=False)
        print(f"\n-- by {column} --")
        for label, part in subset.groupby(groups, observed=True):
            s = score(part[pred_col].to_numpy(float), part["remaining_ms"].to_numpy(float))
            print(score_line(str(label), s))


def mse_decomposition(pred: np.ndarray, actual: np.ndarray) -> dict:
    err = pred - actual
    return {"mse": float((err ** 2).mean()), "bias2": float(err.mean() ** 2),
            "var": float(err.var()), "mae": float(np.abs(err).mean())}


def info_limit(df: pd.DataFrame) -> None:
    """How much of the remaining-time spread is reachable from (k, elapsed)?"""
    test = df[df.split == "test"]
    k = test["k"].to_numpy(int)
    e = test["elapsed_ms"].to_numpy(float)
    rem = test["remaining_ms"].to_numpy(float)

    # within-cell spread: same (k, elapsed 30 s bucket) → IQR of remaining time
    cell = np.floor((e / 30_000)).astype(int) * 1000 + np.minimum(k, 200)
    frame = pd.DataFrame({"cell": cell, "rem": rem})
    grouped = frame.groupby("cell")["rem"]
    iqr = grouped.quantile(0.75) - grouped.quantile(0.25)
    med = grouped.median()
    sizes = grouped.size()
    strong = sizes[sizes >= 40].index
    ratio = (iqr[strong] / np.maximum(1.0, med[strong])).replace([np.inf, -np.inf], np.nan).dropna()
    within = frame[frame.cell.isin(strong)].copy()
    within["cell_med"] = within["cell"].map(med)
    within["v2_pred"] = test.loc[within.index, "v2_pred"].to_numpy(float)
    print("\n== (k, elapsed) information limit ==")
    print(f"cells with >=40 samples: {len(strong)}  covered samples: {len(within)}"
          f"  ({100 * len(within) / len(frame):.1f}% of test)")
    print(f"within-cell IQR / cell median: p50={ratio.quantile(0.5):.2f} p90={ratio.quantile(0.9):.2f}")
    cell_med_mae = np.abs(within["cell_med"].to_numpy(float) - within["rem"].to_numpy(float)).mean()
    cell_med_bias = (within["cell_med"].to_numpy(float) - within["rem"].to_numpy(float)).mean()
    print(f"cell-median oracle MAE on covered samples: {fmt_ms(cell_med_mae)}  bias={fmt_ms(cell_med_bias)}")
    print(f"v2 MAE on same covered samples: {fmt_ms(np.abs(within['v2_pred'].to_numpy(float) - within['rem'].to_numpy(float)).mean())}")

    # oracle re-fit on test itself (upper bound of what this feature space can express)
    oracle = pd.DataFrame({"cell": cell, "rem": rem}).groupby("cell")["rem"].median()
    pred = pd.Series(cell).map(oracle).to_numpy(float)
    print(f"test-refit cell-median (oracle) MAE: {fmt_ms(np.abs(pred - rem).mean())}")
    print(f"v2 MAE (whole test):                {fmt_ms(np.abs(test['v2_pred'].to_numpy(float) - rem).mean())}")

    # how much of the remaining variance is cross-turn (unknown turn length) vs within-turn noise
    turn_med = test.groupby("sid")["dur_ms"].transform("median") if False else None
    print("\n== remaining-time dispersion ==")
    print(f"remaining_ms: mean={fmt_ms(rem.mean())} median={fmt_ms(np.median(rem))}"
          f"  p10={fmt_ms(np.quantile(rem, .1))} p90={fmt_ms(np.quantile(rem, .9))}"
          f"  mean/median={rem.mean() / max(1, np.median(rem)):.2f}")


def make_gbt(params, features, train, calib, test, target="log_remaining"):
    import lightgbm as lgb

    X = train[features].to_numpy(np.float32)
    y = train[target].to_numpy(np.float64)
    model = lgb.LGBMRegressor(objective="quantile", alpha=0.5, n_estimators=params.get("trees", 400),
                              learning_rate=params.get("lr", 0.05), num_leaves=params.get("leaves", 31),
                              min_child_samples=params.get("min_child", 40), subsample=0.9,
                              subsample_freq=1, colsample_bytree=0.9, reg_lambda=1.0,
                              n_jobs=4, verbose=-1, random_state=7)
    model.fit(X, y)
    out = {}
    for name, frame in (("test", test), ("calib", calib)):
        pred = np.expm1(model.predict(frame[features].to_numpy(np.float32)))
        pred = np.clip(pred, 3_000.0, 4 * 3600_000.0)
        out[name] = (pred, frame)
    return model, out


def gbt_ablation(df: pd.DataFrame) -> None:
    train = df[df.split == "train"]
    calib = df[df.split == "calib"]
    test = df[df.split == "test"]
    print(f"\n== quantile GBM ablations (train={len(train)}, calib={len(calib)}, test={len(test)}) ==")
    print(score_line("v2 baseline (test)", score(test["v2_pred"].to_numpy(float),
                                                test["remaining_ms"].to_numpy(float))))
    results = {}
    for name, extra in (("core", []), ("+pace", ["pace"]), ("+prompt", ["prompt"]),
                        ("+plan", ["plan"]), ("+tools", ["tools"]),
                        ("all", ["pace", "prompt", "plan", "tools", "struct"])):
        features = list(FEATURE_GROUPS["core"])
        for group in extra:
            if group == "struct":
                continue
            features += FEATURE_GROUPS[group]
        models, out = make_gbt({}, features, train, calib, test)
        pred, frame = out["test"]
        s = score(pred, frame["remaining_ms"].to_numpy(float))
        results[name] = s
        print(score_line(f"gbt {name}", s))
    return results


def prior_simulation(df: pd.DataFrame) -> dict:
    """Value of an external prior on total work (the 'ask the model first' idea).

    total_steps is the true number of steps of the turn — evaluation only. We
    add it (a) exactly, (b) degraded with multiplicative log-normal noise, which
    is how an LLM-supplied pre-flight estimate would look.
    """
    import lightgbm as lgb

    train = df[df.split == "train"].copy()
    test = df[df.split == "test"].copy()
    base_features = list(FEATURE_GROUPS["core"]) + FEATURE_GROUPS["pace"] + FEATURE_GROUPS["prompt"] + FEATURE_GROUPS["plan"]

    def fit_eval(features, train_frame, test_frame):
        model = lgb.LGBMRegressor(objective="quantile", alpha=0.5, n_estimators=400, learning_rate=0.05,
                                  num_leaves=31, min_child_samples=40, subsample=0.9, subsample_freq=1,
                                  colsample_bytree=0.9, reg_lambda=1.0, n_jobs=4, verbose=-1, random_state=7)
        model.fit(train_frame[features].to_numpy(np.float32), train_frame["log_remaining"].to_numpy(float))
        pred = np.clip(np.expm1(model.predict(test_frame[features].to_numpy(np.float32))), 3_000.0, 4 * 3600_000.0)
        return score(pred, test_frame["remaining_ms"].to_numpy(float)), pred

    base = fit_eval(base_features, train, test)
    print("\n== pre-flight prior on total steps (simulated LLM estimate) ==")
    print(score_line("no prior (model only)", base[0]))
    rng = np.random.default_rng(11)
    rows = []
    for sigma in (0.0, 0.15, 0.3, 0.45, 0.6, 0.9):
        tr = train.copy()
        te = test.copy()
        tr["prior_total"] = np.maximum(1.0, tr["total_steps"] * np.exp(rng.normal(0, sigma, len(tr))))
        te["prior_total"] = np.maximum(1.0, te["total_steps"] * np.exp(rng.normal(0, sigma, len(te))))
        # only the prior, not the truth, is a feature
        s, _ = fit_eval(base_features + ["prior_total"], tr, te)
        rows.append((sigma, s))
        print(score_line(f"prior sigma={sigma:.2f}", s))
    # the prior alone, without any live observables (turn-start decision only)
    tr = train.copy()
    te = test.copy()
    tr["prior_total"] = tr["total_steps"]
    te["prior_total"] = te["total_steps"]
    s, _ = fit_eval(["prior_total"], tr, te)
    print(score_line("prior only (perfect)", s))
    return {"base": base[0], "prior_rows": [(sigma, s) for sigma, s in rows]}


def calibration_report(df: pd.DataFrame) -> None:
    test = df[df.split == "test"]
    actual = test["remaining_ms"].to_numpy(float)
    pred = test["v2_pred"].to_numpy(float)
    print("\n== current confidence labels vs realised error ==")
    for label, code in (("low", 0), ("medium", 1), ("high", 2)):
        part = actual[test["v2_conf"].to_numpy() == code]
        p = pred[test["v2_conf"].to_numpy() == code]
        if len(part) == 0:
            continue
        s = score(p, part)
        print(score_line(f"v2 conf={label}", s))
    rel = test["v2_reliability"].to_numpy(float)
    print(f"reliability (table support) p10={np.quantile(rel, .1):.2f} p50={np.quantile(rel, .5):.2f} p90={np.quantile(rel, .9):.2f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all", choices=["all", "base", "gbt", "prior"])
    args = ap.parse_args()
    df = load()
    print(f"rows={len(df)} splits={df.split.value_counts().to_dict()}")
    test = df[df.split == "test"]
    actual = test["remaining_ms"].to_numpy(float)
    print("\n== v2 baseline on these samples ==")
    print(score_line("v2 (test)", score(test["v2_pred"].to_numpy(float), actual)))
    dec = mse_decomposition(test["v2_pred"].to_numpy(float), actual)
    print(f"MSE decomposition: mse={dec['mse']:.3e}  bias²={dec['bias2']:.3e}  var={dec['var']:.3e}")
    if args.stage in ("all", "base"):
        segment_report(test)
        info_limit(df)
        calibration_report(df)
    if args.stage in ("all", "gbt"):
        gbt_ablation(df)
    if args.stage in ("all", "prior"):
        prior_simulation(df)


if __name__ == "__main__":
    main()
