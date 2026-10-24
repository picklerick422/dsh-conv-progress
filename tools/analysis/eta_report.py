#!/usr/bin/env python3
"""eta_report.py — report-grade numbers for the v3 strategy.

Trains the deployable-size quantile model (num_leaves=15, 250 trees) on the full
train split with the full feature set, then produces every table the write-up
needs:

  1. overall metrics vs the shipped v2
  2. per-duration / per-steps / per-session-warmup breakdown
  3. conformal interval calibration (calib residuals -> test coverage)
  4. confidence classes defined by relative interval width, with measured MAE
     and empirical coverage per class (the "confidence must be measurable" part)
  5. the empirical accuracy of the only pre-flight estimate we have today
     (the todo plan) and the cold-start subset where it matters most

Usage: TMPDIR=... python3 tools/analysis/eta_report.py [--trees 250] [--leaves 15]
"""
import argparse
import json
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
            "plan_n", "plan_done", "plan_has", "turn_index"]
TOOLS = ["turn_tools_bash", "turn_tools_edit", "turn_tools_read", "turn_tools_image", "turn_tools_agent"]
FEATURES = CORE + PACE + TURNMETA + TOOLS

# features that only exist because the session already had earlier turns
WARM_FEATURES = ["n_prev_turns", "prev_turn_dur_med", "prev_turn_steps_med"]


def fmt(v: float) -> str:
    v = float(v)
    return f"{v / 60_000:.1f}m" if abs(v) >= 60_000 else f"{v / 1000:.1f}s"


def score(pred, actual) -> dict:
    pred = np.asarray(pred, float)
    actual = np.asarray(actual, float)
    err = pred - actual
    abs_err = np.abs(err)
    rel = abs_err / np.maximum(3_000.0, actual)
    return {"n": int(len(err)), "mae": float(abs_err.mean()), "median_ae": float(np.median(abs_err)),
            "bias": float(err.mean()), "mape": float(np.minimum(rel, 5.0).mean()),
            "within30": float((abs_err <= 0.3 * np.maximum(actual, 3_000.0)).mean()),
            "within50": float((abs_err <= 0.5 * np.maximum(actual, 3_000.0)).mean()),
            "rmse": float(np.sqrt((err ** 2).mean()))}


def line(label: str, s: dict) -> str:
    return (f"{label:<22} n={s['n']:>7}  MAE={fmt(s['mae']):>7}  medAE={fmt(s['median_ae']):>7}"
            f"  bias={('+' if s['bias'] >= 0 else '-') + fmt(abs(s['bias'])):>8}  MAPE={s['mape']:.2f}"
            f"  ±30%={s['within30'] * 100:4.1f}%  ±50%={s['within50'] * 100:4.1f}%")


def load():
    cols = list(dict.fromkeys(FEATURES + ["total_steps", "v2_pred", "v2_conf", "remaining_ms",
                                          "dur_ms", "split", "sid", "turn", "plan_n", "plan_done"]))
    df = pd.read_csv(DATA, usecols=cols, dtype={c: "float32" for c in cols if c not in ("split", "sid")})
    df["log_remaining"] = np.log1p(df["remaining_ms"].astype(np.float64))
    return df


def fit(train, features, trees, leaves, cache_path=None):
    import lightgbm as lgb
    if cache_path:
        cache = Path(cache_path)
        if cache.exists():
            import os
            os.environ.setdefault("LIGHTGBM_SILENT", "1")
            print(f"  (loading cached booster {cache})")
            return lgb.Booster(model_file=str(cache))
    model = lgb.LGBMRegressor(objective="quantile", alpha=0.5, n_estimators=trees, learning_rate=0.06,
                              num_leaves=leaves, min_child_samples=60, subsample=0.9, subsample_freq=1,
                              colsample_bytree=0.8, reg_lambda=1.0, n_jobs=6, verbose=-1, random_state=11)
    model.fit(train[features].to_numpy(np.float32), train["log_remaining"].to_numpy(float))
    if cache_path:
        model.booster_.save_model(str(cache_path))
    return model


def predict_eta(model, frame, features):
    pred = np.expm1(model.predict(frame[features].to_numpy(np.float32)))
    return np.clip(pred, 3_000.0, 4 * 3600_000.0)


def tree_to_flat(node) -> list:
    """Flatten a LightGBM tree into pre-order node slots; node 0 is the root.

    Node encoding: [split_feature, threshold, left, right]; leaves are
    [-1, leaf_value, -1, -1].  Missing values go left (LightGBM's default),
    which the JS evaluator must mirror.
    """
    flat: list = []

    def build(n) -> int:
        pos = len(flat)
        flat.append(None)
        if "leaf_value" in n:
            flat[pos] = [-1, float(n["leaf_value"]), -1, -1]
            return pos
        left = build(n["left_child"])
        right = build(n["right_child"])
        flat[pos] = [int(n["split_feature"]), float(n["threshold"]), left, right]
        return pos

    if build(node) != 0:
        raise RuntimeError("tree root is not at slot 0")
    return flat


def find_init(model, features, train) -> float:
    """Recover LightGBM's init score (boost_from_average) by difference."""
    import lightgbm as lgb
    frame = train[features].head(5).to_numpy(np.float32)
    raw = model.booster_.predict(frame, raw_score=True)
    dump = model.booster_.dump_model()

    def tree_sum(tree, row):
        node = tree["tree_structure"]
        while "leaf_value" not in node:
            f = node["split_feature"]
            node = node["left_child"] if row[f] <= node["threshold"] else node["right_child"]
        return node["leaf_value"]

    diffs = [raw[i] - sum(tree_sum(t, frame[i]) for t in dump["tree_info"]) for i in range(len(frame))]
    return float(np.median(diffs))


def export_js(model, features, path: Path, meta: dict, init: float) -> None:
    """Compact LightGBM dump -> pure-JS-friendly JSON (leaf values in log space)."""
    dump = model.booster_.dump_model()
    trees = [tree_to_flat(tree["tree_structure"]) for tree in dump["tree_info"]]
    payload = {"schema": "eta-v3-quantile-v1", "features": list(features),
               "quantiles": {"q050": {"init": init, "trees": trees}},
               "calibration": meta.pop("calibration", {}), "meta": meta}
    text = json.dumps(payload, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    print(f"exported {path}  trees={len(trees)}  bytes={len(text)}")
    js_path = path.with_suffix(".js")
    js_path.write_text("export const ETA_V3_MODEL = " + text + ";\n", encoding="utf-8")
    print(f"exported {js_path}  bytes={js_path.stat().st_size}")


def conformal(pred_cal, act_cal, pred_test, act_test) -> dict:
    edges = [0, 60_000, 180_000, 600_000, 1_800_000, 3_600_000, np.inf]
    labels = ["<1m", "1-3m", "3-10m", "10-30m", "30-60m", ">60m"]
    cal_buckets = pd.cut(pd.Series(np.maximum(pred_cal, 3_000.0)), bins=edges, labels=labels, right=False)
    resid = act_cal - pred_cal
    rel = resid / np.maximum(pred_cal, 3_000.0)
    table = {}
    for label in labels:
        part = rel[(cal_buckets == label).to_numpy()]
        if len(part) < 300:
            continue
        table[label] = {f"q{q:.2f}": float(np.quantile(part, q))
                        for q in (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95)}
        table[label]["n"] = int(len(part))
        mask = (cal_buckets == label).to_numpy()
        rel_err = np.abs(pred_cal[mask] - act_cal[mask]) / np.maximum(3_000.0, act_cal[mask])
        table[label]["mape_calib"] = float(np.minimum(rel_err, 5.0).mean())
    test_buckets = pd.cut(pd.Series(np.maximum(pred_test, 3_000.0)), bins=edges, labels=labels, right=False)
    print("\n== conformal intervals (hit-rate by predicted bucket, 80% / 90% nominal) ==")
    cov = {}
    for label in labels:
        mask = (test_buckets == label).to_numpy()
        if label not in table or mask.sum() == 0:
            continue
        t = table[label]
        lo80 = pred_test * (1 + t["q0.10"])
        hi80 = pred_test * (1 + t["q0.90"])
        lo90 = pred_test * (1 + t["q0.05"])
        hi90 = pred_test * (1 + t["q0.95"])
        actual = act_test[mask]
        c80 = ((actual >= lo80[mask]) & (actual <= hi80[mask])).mean()
        c90 = ((actual >= lo90[mask]) & (actual <= hi90[mask])).mean()
        width80 = np.median((hi80 - lo80)[mask])
        cov[label] = {"n": int(mask.sum()), "cover80": float(c80), "cover90": float(c90),
                      "median_width80": float(width80),
                      "median_rel_width80": float(np.median((hi80 - lo80)[mask] / np.maximum(pred_test[mask], 3_000.0)))}
        print(f"  {label:<7} n={mask.sum():>6}  cover80={c80 * 100:5.1f}%  cover90={c90 * 100:5.1f}%"
              f"  median rel-width80={cov[label]['median_rel_width80']:5.2f}")
    return {"table": table, "coverage": cov}


def confidence_classes(pred, act, bucket_mape):
    """Confidence = calibrated *expected relative error* for this ETA bucket.

    The 80% interval is always calibrated to ~80% coverage by construction, so it
    cannot itself rank trustworthiness; what differs between buckets is how large
    a relative error a user should expect. We map the calib MAPE per bucket onto
    three levels (documented cut points) and then measure each level on test.
    """
    levels = []
    for eta in pred:
        mape = bucket_mape.get(bucket_of(eta), 1.0)
        levels.append("high" if mape <= 0.35 else "medium" if mape <= 0.90 else "low")
    levels = np.array(levels)
    print("\n== confidence classes (calibrated expected relative error) ==")
    print("  cut points: high <=0.35, medium <=0.90, low >0.90  (bucket MAPE from calib)")
    rows = {}
    for name in ("high", "medium", "low"):
        mask = levels == name
        if mask.sum() < 50:
            print(f"  {name:<6} n={int(mask.sum()):>6}  (insufficient samples)")
            continue
        sc = score(pred[mask], act[mask])
        rows[name] = sc
        print(line(f"  {name} ({int(mask.sum())})", sc))
    return rows


def bucket_of(ms: float) -> str:
    for limit, label in ((60_000, "<1m"), (180_000, "1-3m"), (600_000, "3-10m"),
                         (1_800_000, "10-30m"), (3_600_000, "30-60m")):
        if ms < limit:
            return label
    return ">60m"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trees", type=int, default=250)
    ap.add_argument("--leaves", type=int, default=15)
    ap.add_argument("--export", default="")
    ap.add_argument("--cache-model", default="data/eta-v3-booster.txt")
    args = ap.parse_args()

    df = load()
    train = df[df.split == "train"]
    calib = df[df.split == "calib"]
    test = df[df.split == "test"]
    actual = test["remaining_ms"].to_numpy(float)
    print(f"train={len(train)} calib={len(calib)} test={len(test)}  config: trees={args.trees} leaves={args.leaves}")
    print("\n== 1. overall ==")
    print(line("v2 (shipped)", score(test["v2_pred"].to_numpy(float), actual)))
    model = fit(train, FEATURES, args.trees, args.leaves, args.cache_model or None)
    pred_test = predict_eta(model, test, FEATURES)
    pred_cal = predict_eta(model, calib, FEATURES)
    s_v3 = score(pred_test, actual)
    print(line("v3 (quantile gbm)", s_v3))
    gain = model.booster_.feature_importance(importance_type="gain")
    order = np.argsort(gain)[::-1]
    total = max(1.0, float(gain.sum()))
    print("  top features (gain %):")
    print("   " + ", ".join(f"{FEATURES[i]}={100 * gain[i] / total:.1f}" for i in order[:14]))

    print("\n== 2. breakdown ==")
    groups = [
        ("dur_ms", [0, 30_000, 120_000, 300_000, 900_000, np.inf], ["<30s", "30-120s", "2-5m", "5-15m", ">15m"]),
        ("k", [0, 1, 3, 8, 20, 50, np.inf], ["0", "1-2", "3-7", "8-19", "20-49", "50+"]),
        ("n_prev_turns", [0, 1, 2, 3, 5, np.inf], ["0 (cold)", "1", "2", "3-4", "5+"]),
    ]
    for column, edges, labels in groups:
        print(f"\n-- by {column} --")
        group = pd.cut(test[column], bins=edges, labels=labels, right=False)
        for label in labels:
            mask = (group == label).to_numpy()
            if mask.sum() < 50:
                continue
            print(line(f"  {label}", score(pred_test[mask], actual[mask])))

    cal = conformal(pred_cal, calib["remaining_ms"].to_numpy(float), pred_test, actual)
    bucket_mape = {label: info.get("mape_calib", 1.0) for label, info in cal["table"].items()}
    classes = confidence_classes(pred_test, actual, bucket_mape)

    # the only pre-flight estimate available today: the todo plan
    print("\n== 5. quality of today's pre-flight estimate (todo plan) ==")
    plan_train = train[train["plan_has"] > 0]
    if len(plan_train) > 200:
        sp = (plan_train["total_steps"] / np.maximum(plan_train["plan_n"], 1)).to_numpy(float)
        sp = sp[np.isfinite(sp)]
        print(f"  turns with plan (train): {len(plan_train)}  steps-per-todo median={np.median(sp):.1f}"
              f"  p10={np.quantile(sp, .1):.1f} p90={np.quantile(sp, .9):.1f}")
        test_plan = test[test["plan_has"] > 0]
        if len(test_plan):
            prior = test_plan["plan_n"].to_numpy(float) * np.median(sp)
            truth = test_plan["total_steps"].to_numpy(float)
            ratio = np.maximum(prior, 1) / np.maximum(truth, 1)
            sig = np.log(ratio[np.isfinite(ratio) & (ratio > 0)])
            print(f"  implied prior error on plan turns: sigma={sig.std():.2f}  median ratio={np.median(ratio):.2f}"
                  f"  |log ratio| p50={np.median(np.abs(sig)):.2f} p90={np.quantile(np.abs(sig), .9):.2f}")
            print(line("  v2 on plan turns", score(test_plan["v2_pred"].to_numpy(float),
                                                    test_plan["remaining_ms"].to_numpy(float))))
            mask = (test["plan_has"] > 0).to_numpy()
            print(line("  v3 on plan turns", score(pred_test[mask], test_plan["remaining_ms"].to_numpy(float))))
            cold_mask = mask & (test["n_prev_turns"].to_numpy() == 0)
            if cold_mask.sum() > 100:
                print(line("  v2 cold+plan", score(test["v2_pred"].to_numpy(float)[cold_mask], actual[cold_mask])))
                print(line("  v3 cold+plan", score(pred_test[cold_mask], actual[cold_mask])))

    if args.export:
        init = find_init(model, FEATURES, train)
        meta = {"generated_at": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
                "source": "data/samples.csv", "target": "log1p(remaining_ms)", "objective": "quantile alpha=0.5",
                "config": {"trees": args.trees, "leaves": args.leaves, "learning_rate": 0.06,
                           "min_child_samples": 60, "subsample": 0.9, "colsample_bytree": 0.8},
                "rows": {"train": int(len(train)), "calib": int(len(calib)), "test": int(len(test))},
                "test_metrics": {k: round(float(v), 3) for k, v in s_v3.items()},
                "conformal_coverage": cal["coverage"], "confidence_classes": classes,
                "calibration": cal["table"],
                "feature_set": {"core": CORE, "pace": PACE, "turnmeta": TURNMETA, "tools": TOOLS}}
        export_js(model, FEATURES, Path(args.export), meta, init)


if __name__ == "__main__":
    main()
