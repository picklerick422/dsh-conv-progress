#!/usr/bin/env python3
"""eta_bounds.py — where does the ETA error come from, and what would extra inputs buy?

Experiments (all trained on `train`, validated/calibrated on `calib`, reported on `test`):

  A. feature-set ladder with a quantile-0.5 GBM (median is the MAE-optimal target)
       core           (k, elapsed, current step state)             <- what v2 can see
       +pace          (this session's tempo + history of turns)
       +turnmeta      (prompt features, plan presence, model id)
       +tools         (tool mix of the turn so far)
       +oracle_size   (true total_steps: an upper bound, not deployable)
     The gap core→turnmeta says how much a *pre-flight* estimate of the task is worth;
     the residual after +oracle_size is pacing noise that no input can remove.

  B. prior simulation for the "ask the LLM for an estimate first" idea
       prior_total = true_steps * exp(N(0, sigma))  for sigma in {0, .15, .3, .45, .6, .9}
     i.e. how accurate does the pre-flight estimate need to be to pay off.

  C. interval coverage for the current v2 model (conformal, conditioned on prediction size)

Usage: TMPDIR=... python3 tools/analysis/eta_bounds.py [--rows N]
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data/samples.csv"

CORE = ["k", "elapsed_ms", "step_elapsed_ms", "step_open", "step_has_tools",
        "tools_done_in_step", "pending_tools", "last_tool_cat", "since_last_evt_ms"]
PACE = ["prev_step_mean_ms", "prev_step_max_ms", "step_ms_ema",
        "n_prev_turns", "prev_turn_dur_med", "prev_turn_steps_med"]
TURNMETA = ["prompt_chars", "prompt_lines", "prompt_code_fences", "prompt_commands",
            "prompt_mentions", "prompt_questions", "prompt_has_image", "prompt_cjk_ratio",
            "plan_n", "plan_done", "plan_has", "model_code", "turn_index"]
TOOLS = ["turn_tools_bash", "turn_tools_edit", "turn_tools_read", "turn_tools_image", "turn_tools_agent"]
ALL = CORE + PACE + TURNMETA + TOOLS

EVAL_ONLY = {"remaining_ms", "dur_ms", "total_steps", "v2_pred", "v2_conf",
             "v2_reliability", "v2_cell_samples", "split", "sid", "turn", "t_rel"}


def fmt(v: float) -> str:
    v = float(v)
    return f"{v / 60_000:.1f}m" if abs(v) >= 60_000 else f"{v / 1000:.1f}s"


def score(pred, actual) -> dict:
    err = np.asarray(pred, float) - np.asarray(actual, float)
    abs_err = np.abs(err)
    return {"n": len(err), "mae": abs_err.mean(), "median_ae": np.median(abs_err),
            "bias": err.mean(), "mape": np.minimum(abs_err / np.maximum(3_000.0, actual), 5.0).mean(),
            "within30": (abs_err <= 0.3 * np.maximum(actual, 3_000.0)).mean(),
            "within50": (abs_err <= 0.5 * np.maximum(actual, 3_000.0)).mean()}


def line(label: str, s: dict) -> str:
    return (f"{label:<24} MAE={fmt(s['mae']):>7}  medAE={fmt(s['median_ae']):>7}"
            f"  bias={('+' if s['bias'] >= 0 else '-') + fmt(abs(s['bias'])):>8}"
            f"  MAPE={s['mape']:.2f}  within30={s['within30'] * 100:4.1f}%  within50={s['within50'] * 100:4.1f}%")


def load(rows: int | None):
    cols = list(dict.fromkeys(ALL + ["total_steps", "v2_pred", "v2_conf", "remaining_ms",
                                     "dur_ms", "split", "sid"]))
    df = pd.read_csv(DATA, usecols=cols, dtype={c: "float32" for c in cols if c not in ("split", "sid")})
    df["log_remaining"] = np.log1p(df["remaining_ms"].astype(np.float64))
    if rows:
        train = df[df.split == "train"]
        if len(train) > rows:
            df = pd.concat([train.sample(rows, random_state=7),
                            df[df.split == "calib"], df[df.split == "test"]], ignore_index=True)
    return df


def fit_predict(train, calib, test, features, extra=None, trees=350, leaves=31):
    import lightgbm as lgb

    frames = {"train": train, "calib": calib, "test": test}
    if extra is not None:
        frames = {k: v.copy() for k, v in frames.items()}
        for column, values in extra.items():
            for name in ("train", "calib", "test"):
                frames[name][column] = values[name]
            features = features + [column]
    tr = frames["train"]
    model = lgb.LGBMRegressor(objective="quantile", alpha=0.5, n_estimators=trees, learning_rate=0.06,
                              num_leaves=leaves, min_child_samples=50, subsample=0.9, subsample_freq=1,
                              colsample_bytree=0.9, reg_lambda=1.0, n_jobs=6, verbose=-1, random_state=7)
    model.fit(tr[features].to_numpy(np.float32), tr["log_remaining"].to_numpy(float))
    out = {}
    for name in ("calib", "test"):
        frame = frames[name]
        pred = np.expm1(model.predict(frame[features].to_numpy(np.float32)))
        out[name] = np.clip(pred, 3_000.0, 4 * 3600_000.0)
    return model, out


def interval_report(pred, actual, calib_pred, calib_actual) -> None:
    """Conditional conformal: residual quantiles by predicted-size bucket, from calib."""
    ratio = np.maximum(calib_pred, 3_000.0)
    resid = calib_actual - calib_pred
    edges = [0, 60_000, 180_000, 600_000, 1_800_000, 3_600_000, np.inf]
    labels = ["<1m", "1-3m", "3-10m", "10-30m", "30-60m", ">60m"]
    buckets = pd.cut(pd.Series(np.maximum(calib_pred, 3_000.0)), bins=edges, labels=labels, right=False)
    table = {}
    for label in labels:
        part = resid[buckets == label]
        if len(part) < 200:
            continue
        table[label] = {"q05": float(np.quantile(part, 0.05)), "q10": float(np.quantile(part, 0.10)),
                        "q50": float(np.quantile(part, 0.50)), "q90": float(np.quantile(part, 0.90)),
                        "q95": float(np.quantile(part, 0.95)), "n": int(len(part))}
    print("\n-- interval coverage on test (conformal residuals from calib) --")
    test_buckets = pd.cut(pd.Series(np.maximum(pred, 3_000.0)), bins=edges, labels=labels, right=False)
    for label in labels:
        part = test_buckets == label
        if label not in table or part.sum() == 0:
            continue
        t = table[label]
        lo, hi = pred[part] + t["q10"], pred[part] + t["q90"]
        lo90, hi90 = pred[part] + t["q05"], pred[part] + t["q95"]
        act = actual[part]
        print(f"  {label:<7} n={part.sum():>6}  cover80={(act >= lo).mean() * 100:5.1f}%"
              f"  cover90={(act >= lo90).mean() * 100:5.1f}%  median width80={fmt(np.median(hi - lo))}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=400_000, help="train row cap (default 400k)")
    args = ap.parse_args()

    df = load(args.rows)
    train = df[df.split == "train"]
    calib = df[df.split == "calib"]
    test = df[df.split == "test"]
    actual = test["remaining_ms"].to_numpy(float)
    print(f"train={len(train)} calib={len(calib)} test={len(test)}")
    print("\n== A. feature-set ladder (quantile GBM, alpha=0.5) ==")
    print(line("v2 (shipped)", score(test["v2_pred"].to_numpy(float), actual)))

    ladder = [("core", CORE), ("+pace", CORE + PACE), ("+turnmeta", CORE + PACE + TURNMETA),
              ("+tools", CORE + PACE + TURNMETA + TOOLS)]
    results = {}
    for name, feats in ladder:
        _, out = fit_predict(train, calib, test, feats)
        s = score(out["test"], actual)
        results[name] = s
        print(line(name, s))
        if name == "+tools":
            pred_test, pred_calib = out["test"], out["calib"]
            interval_report(pred_test, actual, pred_calib, calib["remaining_ms"].to_numpy(float))

    # oracle size: the upper bound an ideal pre-flight estimate could reach
    oracle = {name: frame["total_steps"].to_numpy() for name, frame in
              (("train", train), ("calib", calib), ("test", test))}
    _, out = fit_predict(train, calib, test, CORE + PACE + TURNMETA + TOOLS,
                         extra={"oracle_size": oracle})
    print(line("+oracle size", score(out["test"], actual)))

    print("\n== B. pre-flight prior with lognormal noise ==")
    rng = np.random.default_rng(11)
    for sigma in (0.0, 0.15, 0.3, 0.45, 0.6, 0.9):
        noise = {name: np.maximum(1.0, frame["total_steps"].to_numpy() * np.exp(rng.normal(0, sigma, len(frame))))
                 for name, frame in (("train", train), ("calib", calib), ("test", test))}
        _, out = fit_predict(train, calib, test, CORE + PACE + TURNMETA + TOOLS,
                             extra={"prior_total": noise})
        print(line(f"prior sigma={sigma:.2f}", score(out["test"], actual)))

    # a realistic stand-in for an LLM estimate that is already available today: todo plan size
    print("\n== C. where a pre-flight estimate has marginal value (cold start) ==")
    cold = test["n_prev_turns"].to_numpy() == 0
    warm = ~cold
    print(f"  cold-start samples (n_prev_turns==0): {cold.sum()}  warm: {warm.sum()}")
    print(line("v2 cold", score(test["v2_pred"].to_numpy(float)[cold], actual[cold])))
    print(line("v2 warm", score(test["v2_pred"].to_numpy(float)[warm], actual[warm])))
    plan_cold = cold & (test["plan_has"].to_numpy() > 0)
    plan_warm = warm & (test["plan_has"].to_numpy() > 0)
    print(f"  cold+plan samples: {plan_cold.sum()}  warm+plan: {plan_warm.sum()}")
    if plan_cold.sum() > 100:
        print(line("v2 cold+plan", score(test["v2_pred"].to_numpy(float)[plan_cold], actual[plan_cold])))
    # conformal coverage for the shipped v2 model, for the comparison table
    print("\n== D. interval coverage of the shipped v2 model ==")
    interval_report(test["v2_pred"].to_numpy(float), actual,
                    test["v2_pred"].to_numpy(float), actual)


if __name__ == "__main__":
    main()
