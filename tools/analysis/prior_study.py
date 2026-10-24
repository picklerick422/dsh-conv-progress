#!/usr/bin/env python3
"""
prior_study.py — does an up-front LLM prior actually improve the ETA model?

Protocol
--------
1. `tools/extract-prompts.mjs` sampled real turns and kept their user prompt text.
2. `tools/gen-priors.mjs` asked an LLM (deepseek-flash) for a work-size estimate
   *before* the turn ran — the "prompt-injection prior".
3. This script joins those priors onto `data/samples.csv`, measures how accurate
   the prior itself is, and then trains two models on the SAME train rows:

     v3r : the 32 production features (prior absent)
     v3p : the 32 features + prior features

   both evaluated on the SAME test rows, next to the shipped v3 model
   (`data/v3-pred.csv`) restricted to the same rows.

Only turns present in the prior file are used, so the comparison is paired.

Usage:
  python3 tools/analysis/prior_study.py --priors data/priors.jsonl
  python3 tools/analysis/prior_study.py --priors data/priors-v2.jsonl
"""
import argparse
import json
import math
import os
import sys

import numpy as np
import pandas as pd

try:
    import lightgbm as lgb
except ImportError:  # pragma: no cover
    print("lightgbm missing: pip install --user lightgbm", file=sys.stderr)
    raise

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "data")

BASE_FEATURES = [
    "k", "elapsed_ms", "step_elapsed_ms", "step_open", "step_has_tools",
    "tools_done_in_step", "pending_tools", "last_tool_cat", "since_last_evt_ms",
    "prev_step_mean_ms", "prev_step_max_ms", "step_ms_ema", "n_prev_turns",
    "prev_turn_dur_med", "prev_turn_steps_med",
    "prompt_chars", "prompt_lines", "prompt_code_fences", "prompt_commands",
    "prompt_mentions", "prompt_questions", "prompt_has_image", "prompt_cjk_ratio",
    "plan_n", "plan_done", "plan_has", "turn_index",
    "turn_tools_bash", "turn_tools_edit", "turn_tools_read", "turn_tools_image", "turn_tools_agent",
]
PRIOR_FEATURES = ["prior_log_steps", "prior_log_minutes", "prior_conf", "prior_steps_per_elapsed_min"]

LGB_PARAMS = dict(
    objective="quantile", alpha=0.5, verbosity=-1, num_leaves=31,
    learning_rate=0.06, min_child_samples=60, subsample=0.9,
    subsample_freq=1, colsample_bytree=0.8, n_estimators=400,
)


def load_priors(path):
    priors = {}
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        if "error" in row or "pred" not in row:
            continue
        priors[(row["sid"], int(row["turn"]))] = row["pred"]
    return priors


def load_turn_truth(path):
    """(sid, turn) -> total steps / duration, from the turn-level dataset."""
    truth = {}
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        if row.get("durMs", 0) > 2 * 3600 * 1000:
            continue
        truth[(row["sid"], int(row["turn"]))] = {
            "total_steps": len(row["steps"]),
            "dur_ms": row["durMs"],
            "bucket": None,
        }
    return truth


def load_samples(keys):
    """Stream samples.csv and keep only rows whose turn has a prior."""
    cols = BASE_FEATURES + ["split", "sid", "turn", "t_rel", "remaining_ms", "dur_ms", "total_steps"]
    frames = []
    for chunk in pd.read_csv(os.path.join(DATA, "samples.csv"), usecols=cols, chunksize=250_000):
        keep = chunk.apply(lambda r: (r["sid"], int(r["turn"])) in keys, axis=1)
        frames.append(chunk[keep])
    if not frames:
        raise SystemExit("no matching rows")
    return pd.concat(frames, ignore_index=True)


def metrics(actual, pred):
    err = pred - actual
    rel = np.abs(err) / np.maximum(actual, 1)
    return {
        "n": int(len(actual)),
        "mae_s": float(np.mean(np.abs(err)) / 1000),
        "medae_s": float(np.median(np.abs(err)) / 1000),
        "bias_s": float(np.mean(err) / 1000),
        "mape": float(np.mean(np.minimum(rel, 5.0))),
        "within30": float(np.mean(rel <= 0.30)),
        "within50": float(np.mean(rel <= 0.50)),
    }


def fmt(m):
    return (f"n={m['n']:>6} MAE={m['mae_s']/60:5.2f}m medAE={m['medae_s']:6.1f}s "
            f"bias={m['bias_s']:+7.1f}s MAPE={m['mape']:5.3f} ±30%={m['within30']*100:5.1f}% ±50%={m['within50']*100:5.1f}%")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--priors", default=os.path.join(DATA, "priors.jsonl"))
    ap.add_argument("--turns", default=os.path.join(DATA, "turns2.jsonl"))
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    priors = load_priors(args.priors)
    truth = load_turn_truth(args.turns)
    keys = set(priors.keys())
    print(f"priors parsed: {len(priors)}  (turns known: {sum(1 for k in keys if k in truth)})")

    # ---- 1. how accurate is the prior itself? ---------------------------------
    pairs = [(k, priors[k], truth[k]) for k in keys if k in truth]
    log_steps = np.array([math.log(max(0.5, p["steps"]) / max(0.5, t["total_steps"])) for _, p, t in pairs if t["total_steps"] > 0])
    log_minutes = np.array([math.log(max(0.5, p["minutes"]) / max(0.5, t["dur_ms"] / 60000)) for _, p, t in pairs if t["dur_ms"] > 0])
    rank_a = np.argsort(np.argsort(np.array([t["total_steps"] for _, p, t in pairs])))
    rank_b = np.argsort(np.argsort(np.array([p["steps"] for _, p, t in pairs])))
    spearman = float(np.corrcoef(rank_a, rank_b)[0, 1])
    print("\n== prior quality (before the turn ran) ==")
    print(f"  steps   : log-ratio mean {log_steps.mean():+.3f} sd {log_steps.std():.3f} "
          f"(|log| p50 {np.median(np.abs(log_steps)):.3f})  spearman {spearman:.3f}")
    print(f"  minutes : log-ratio mean {log_minutes.mean():+.3f} sd {log_minutes.std():.3f} "
          f"(|log| p50 {np.median(np.abs(log_minutes)):.3f})")
    print("  interpretation: sd(log ratio) is the sigma used in the earlier noise simulation;")
    print("                  sigma<=0.30 is where a prior starts to pay off.")

    # ---- 2. paired model comparison -------------------------------------------
    frame = load_samples(keys)
    frame["prior_log_steps"] = [math.log(max(0.5, priors[(s, int(t))]["steps"])) for s, t in zip(frame["sid"], frame["turn"])]
    frame["prior_log_minutes"] = [math.log(max(0.5, priors[(s, int(t))]["minutes"])) for s, t in zip(frame["sid"], frame["turn"])]
    frame["prior_conf"] = [{"low": 0, "medium": 1, "high": 2}.get(priors[(s, int(t))].get("confidence"), 1) for s, t in zip(frame["sid"], frame["turn"])]
    frame["prior_steps_per_elapsed_min"] = [priors[(s, int(t))]["steps"] / max(1.0, e / 60000) for s, t, e in zip(frame["sid"], frame["turn"], frame["elapsed_ms"])]
    frame["target"] = np.log1p(frame["remaining_ms"].to_numpy(float))

    train = frame[frame["split"] == "train"]
    test = frame[frame["split"] == "test"]
    print(f"\n== paired rows ==\n  train {len(train):,} rows / {train['sid'].nunique()} sessions / {train[['sid','turn']].drop_duplicates().shape[0]} turns")
    print(f"  test  {len(test):,} rows / {test['sid'].nunique()} sessions / {test[['sid','turn']].drop_duplicates().shape[0]} turns")

    actual = test["remaining_ms"].to_numpy(float)
    results = {}

    # shipped v3 on the same rows
    shipped = pd.read_csv(os.path.join(DATA, "v3-pred.csv"),
                          usecols=["sid", "turn", "t_rel", "v3_pred", "v3_actual"])
    merged = test.merge(shipped, on=["sid", "turn", "t_rel"], how="left")
    mask = merged["v3_pred"].notna().to_numpy()
    if mask.any():
        results["v3 (shipped, all-train)"] = metrics(merged.loc[mask, "v3_actual"].to_numpy(float),
                                                     merged.loc[mask, "v3_pred"].to_numpy(float))

    def fit_eval(name, features):
        model = lgb.LGBMRegressor(**LGB_PARAMS)
        model.fit(train[features], train["target"], eval_set=[(test[features], test["target"])], callbacks=[])
        pred = np.expm1(model.predict(test[features]))
        results[name] = metrics(actual, pred)
        return model

    fit_eval("v3r (subset, no prior)", BASE_FEATURES)
    model_p = fit_eval("v3p (subset, + prior)", BASE_FEATURES + PRIOR_FEATURES)

    print("\n== paired test comparison ==")
    for name, m in results.items():
        print(f"  {name:<26} {fmt(m)}")

    importance = pd.Series(model_p.feature_importances_, index=BASE_FEATURES + PRIOR_FEATURES).sort_values(ascending=False)
    total = importance.sum()
    print("\n== prior feature gain share ==")
    for name in PRIOR_FEATURES:
        print(f"  {name:<28} {importance[name]:6.0f}  ({importance[name]/total*100:4.1f}%)")
    print("  top-6 overall:", ", ".join(f"{n} {v/total*100:.1f}%" for n, v in importance.head(6).items()))

    os.makedirs(DATA, exist_ok=True)
    out = os.path.join(DATA, "prior-study.json")
    json.dump({"priors": args.priors, "spearman": spearman,
               "sigma_steps": float(log_steps.std()), "sigma_minutes": float(log_minutes.std()),
               "results": results,
               "feature_gain": {n: float(v) for n, v in importance.items()}}, open(out, "w"), indent=2)
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
