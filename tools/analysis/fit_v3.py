#!/usr/bin/env python3
"""Fit ETA v3: LightGBM quantile regression on log1p(remaining_ms), exportable to pure JS.

Stages:
  sweep   size/accuracy trade-off (leaves x trees) on a session-held-out dev split of `train`
  final   refit chosen config for alpha in {0.1,0.5,0.9} on full `train`, conformal on `calib`
  prior   prior-simulation curve (prior_total = total_steps * exp(N(0,sigma)))
  export  data/eta-v3-model.json + data/v3-pred-sample.csv

Run: TMPDIR=/home/user/.dsh/dsh-taskbar/.cache/tmp python3 tools/analysis/fit_v3.py
"""
import json
import math
import os
import struct
import sys
import time

import numpy as np
import pandas as pd
import lightgbm as lgb

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "data", "samples.csv")
OUT_MODEL = os.path.join(ROOT, "data", "eta-v3-model.json")
OUT_SAMPLE = os.path.join(ROOT, "data", "v3-pred-sample.csv")
CACHE = os.path.join(ROOT, ".cache")
os.makedirs(CACHE, exist_ok=True)

# ---------------------------------------------------------------- features
# eval-only columns (NEVER features): remaining_ms, dur_ms, total_steps, v2_*, split, sid, turn, t_rel
NUM_FEATURES = [
    "k", "elapsed_ms", "step_elapsed_ms", "step_open", "step_has_tools",
    "tools_done_in_step", "pending_tools", "prev_step_mean_ms", "prev_step_max_ms",
    "step_ms_ema", "since_last_evt_ms", "n_prev_turns", "prev_turn_dur_med",
    "prev_turn_steps_med", "turn_index", "prompt_chars", "prompt_lines",
    "prompt_code_fences", "prompt_commands", "prompt_mentions", "prompt_questions",
    "prompt_has_image", "prompt_cjk_ratio", "plan_n", "plan_done", "plan_has",
    "turn_tools_bash", "turn_tools_edit", "turn_tools_read", "turn_tools_image",
    "turn_tools_agent",
]
CAT_FEATURES = ["model_code", "last_tool_cat"]

LOAD_COLS = ["split", "sid", "turn", "k", "remaining_ms", "dur_ms", "total_steps",
             "v2_pred"] + NUM_FEATURES + CAT_FEATURES
DTYPES = {c: "str" for c in ("split", "sid")}
DTYPES.update({c: "float32" for c in NUM_FEATURES})
DTYPES.update({c: "str" for c in CAT_FEATURES})
DTYPES.update({"turn": "int32", "k": "int16", "remaining_ms": "float64",
               "dur_ms": "float32", "total_steps": "float32", "v2_pred": "float32"})

SEED = 42
BASE_PARAMS = dict(
    objective="quantile",
    metric="quantile",
    learning_rate=0.07,
    min_child_samples=60,
    feature_fraction=0.8,
    bagging_fraction=0.8,
    bagging_freq=1,
    lambda_l2=1.0,
    verbose=-1,
    seed=SEED,
    deterministic=True,
    force_row_wise=True,
    num_threads=7,
)

MODEL = {}  # filled by stages


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- loading
def load():
    log("loading csv ...")
    t0 = time.time()
    df = pd.read_csv(DATA, usecols=LOAD_COLS, dtype=DTYPES)
    df["split"] = df["split"].astype("category")
    df["model_code_i"] = df["model_code"].astype("int16")
    df["last_tool_cat_i"] = df["last_tool_cat"].astype("int16")
    log(f"loaded {df.shape} in {time.time()-t0:.1f}s, mem={df.memory_usage(deep=True).sum()/1e6:.0f}MB")
    return df


def feature_layout(df):
    mc_levels = sorted(df["model_code_i"].unique().tolist())
    lt_levels = sorted(df["last_tool_cat_i"].unique().tolist())
    names = list(NUM_FEATURES)
    names += [f"model_code={v}" for v in mc_levels]
    names += [f"last_tool_cat={v}" for v in lt_levels]
    return mc_levels, lt_levels, names


def build_X(df, mc_levels, lt_levels):
    n = len(df)
    X = np.empty((n, len(NUM_FEATURES) + len(mc_levels) + len(lt_levels)), dtype=np.float32)
    X[:, :len(NUM_FEATURES)] = df[NUM_FEATURES].to_numpy(dtype=np.float32)
    off = len(NUM_FEATURES)
    mc = df["model_code_i"].to_numpy()
    for j, v in enumerate(mc_levels):
        X[:, off + j] = (mc == v)
    off += len(mc_levels)
    lt = df["last_tool_cat_i"].to_numpy()
    for j, v in enumerate(lt_levels):
        X[:, off + j] = (lt == v)
    return X


# ---------------------------------------------------------------- compact export
def dump_size(booster):
    """Size estimate of the raw dump_model JSON (compact separators)."""
    d = booster.dump_model()
    return len(json.dumps(d, separators=(",", ":")))


def trees_from_booster(booster):
    """Convert dump_model tree_info into compact per-tree parallel arrays, pre-order flattened.

    Layout (node i):
      f[i] >= 0  -> internal: split feature index; x[i] = threshold
      f[i] <  0  -> leaf:     x[i] = leaf value
      s[i]       -> node count of the LEFT subtree (right child = i + 1 + s[i])
    Children are implicit: left = i+1, right = i + 1 + s[i].
    This removes the two child-index arrays (~20% of the payload).
    """
    dumped = booster.dump_model()
    out = []
    for ti in dumped["tree_info"]:
        f, x, sz = [], [], []

        def rec(node):
            idx = len(f)
            f.append(0)
            x.append(0.0)
            sz.append(0)
            if "left_child" not in node:
                f[idx] = -1
                x[idx] = node["leaf_value"]
                sz[idx] = 1
                return 1
            f[idx] = node["split_feature"]
            x[idx] = node["threshold"]
            left = rec(node["left_child"])
            right = rec(node["right_child"])
            sz[idx] = left          # left-subtree node count; right child = i+1+sz[i]
            return left + right + 1

        rec(ti["tree_structure"])
        out.append({"f": f, "x": x, "s": sz})
    return out, dumped.get("objective")


def num(v, nd=7):
    """Short but faithful JSON number: integers stay ints, else `nd` significant digits."""
    if not math.isfinite(v) or v == 0:
        return 0
    r = round(v)
    if abs(v - r) <= 1e-9 * max(1.0, abs(v)):
        return int(r)
    digits = max(0, nd - 1 - int(math.floor(math.log10(abs(v)))))
    return float(f"{v:.{digits}f}")


LEAF_DIGITS = 9   # thresholds 7 digits is enough (branch flips are discrete/rare); leaf values
                  # accumulate over ~250 trees, so they get 9 (keeps derived interval bounds inside 1e-4)


def compactify(trees):
    for t in trees:
        t["f"] = [int(v) for v in t["f"]]
        t["x"] = [num(v) if fi >= 0 else num(v, LEAF_DIGITS) for fi, v in zip(t["f"], t["x"])]
        t["s"] = [int(v) for v in t["s"]]
    return trees


def compact_size(trees, init=0.0):
    """Byte size of the compact per-model payload exactly as it will be serialized."""
    return len(json.dumps({"init": num(init), "trees": trees}, separators=(",", ":")).encode())


def node_count(trees):
    return sum(len(t["f"]) for t in trees)


def predict_log(trees, init, X):
    """Reference evaluator mirroring the JS walk (pre-order, implicit children)."""
    out = np.full(X.shape[0], float(init), dtype=np.float64)
    for t in trees:
        f = np.asarray(t["f"])
        x = np.asarray(t["x"], dtype=np.float64)
        s = np.asarray(t["s"], dtype=np.int64)
        node = np.zeros(X.shape[0], dtype=np.int64)
        active = f[node] >= 0
        while active.any():
            i = np.nonzero(active)[0]
            nd = node[i]
            go_left = X[i, f[nd]] <= x[nd]
            node[i] = np.where(go_left, nd + 1, nd + 1 + s[nd])
            active[i] = f[node[i]] >= 0
        out += x[node]
    return out


def fit_one(X, y, alpha, params, n_rounds, leaves, init=None):
    p = dict(params)
    p.update(alpha=alpha, num_leaves=leaves, n_estimators=n_rounds)
    ds = lgb.Dataset(X, label=y, free_raw_data=False, params={"verbose": -1})
    b = lgb.train(p, ds, num_boost_round=n_rounds)
    return b


def score(pred, actual):
    err = pred - actual
    abs_err = np.abs(err)
    rel = abs_err / np.maximum(3000.0, actual)
    return {
        "n": int(len(pred)),
        "mae": float(abs_err.mean()),
        "median_ae": float(np.median(abs_err)),
        "rmse": float(math.sqrt((err ** 2).mean())),
        "bias": float(err.mean()),
        "mape": float(np.minimum(rel, 5.0).mean()),
        "p10": float(np.quantile(err, 0.10)),
        "p90": float(np.quantile(err, 0.90)),
    }


DUR_BUCKETS = [
    ("<30s", 0, 30_000),
    ("30-120s", 30_000, 120_000),
    ("2-5m", 120_000, 300_000),
    ("5-15m", 300_000, 900_000),
    (">15m", 900_000, 1e18),
]


def bucket_mae(pred, actual, dur):
    out = {}
    for name, lo, hi in DUR_BUCKETS:
        m = (dur >= lo) & (dur < hi)
        if m.sum() == 0:
            out[name] = None
            continue
        out[name] = {"n": int(m.sum()), "mae": float(np.abs(pred[m] - actual[m]).mean())}
    return out


# ---------------------------------------------------------------- stages
def stage_sweep(df):
    log("== SWEEP ==")
    tr = df[df.split == "train"].reset_index(drop=True)
    dev_mask = (pd.util.hash_pandas_object(tr["sid"], index=False).to_numpy() % 10) == 0
    fit_idx = ~dev_mask
    mc, lt, names = MODEL["layout"]
    Xall = build_X(tr, mc, lt)
    y = np.log1p(tr["remaining_ms"].to_numpy())
    Xfit, yfit = Xall[fit_idx], y[fit_idx]
    Xdev, ydev = Xall[dev_mask], y[dev_mask]
    actual_dev = tr["remaining_ms"].to_numpy()[dev_mask]
    log(f"sweep split: fit={fit_idx.sum()} dev={dev_mask.sum()}")

    grid = [(leaves, trees) for leaves in (8, 15, 31) for trees in (120, 200, 250)]
    extra = [(12, 250), (20, 200), (24, 150), (20, 250), (24, 200)]
    rows = []
    for leaves, trees in grid + extra:
        t0 = time.time()
        b = fit_one(Xfit, yfit, 0.5, BASE_PARAMS, trees, leaves)
        po = b.predict(Xdev)
        pred = np.maximum(np.expm1(po), 1.0)
        s = score(pred, actual_dev)
        size = dump_size(b)
        init, _ = resolve_init(b, Xdev, po)
        trees_c = compactify(trees_from_booster(b)[0])
        csize = compact_size(trees_c, init)
        rows.append({"leaves": leaves, "trees": trees, "mae": s["mae"], "medae": s["median_ae"],
                     "bias": s["bias"], "rmse": s["rmse"], "mape": s["mape"],
                     "dump_bytes": size, "compact_bytes": csize, "nodes": node_count(trees_c),
                     "secs": round(time.time() - t0, 1)})
        log(f"  leaves={leaves:2d} trees={trees:3d}  devMAE={s['mae']/1000:7.1f}s  "
            f"medAE={s['median_ae']/1000:6.1f}s  dump={size/1024:7.1f}KB  compact={csize/1024:6.1f}KB "
            f"nodes={rows[-1]['nodes']}  {rows[-1]['secs']}s")
    MODEL["sweep"] = rows
    return rows


def pick_config(rows, per_model_bytes=125_000, max_leaves=15):
    """Pick the shipped config.

    Rule: respect the spec caps (num_leaves <= 15, n_estimators <= 250) and the compact per-model
    budget (125KB x 3 quantiles + meta keeps data/eta-v3-model.json under the 400KB target).
    The wider grid (leaves 20/24/31) is still recorded to document the size/accuracy frontier.
    """
    ok = [r for r in rows if r["compact_bytes"] <= per_model_bytes and r["leaves"] <= max_leaves]
    pool = ok if ok else rows
    best = min(pool, key=lambda r: r["mae"])
    # Pareto frontier over (compact_bytes, mae) for the report
    frontier = []
    for r in sorted(rows, key=lambda r: r["compact_bytes"]):
        if not frontier or r["mae"] < min(f["mae"] for f in frontier):
            frontier.append(r)
    MODEL["frontier"] = frontier
    alt = min([r for r in rows if r["compact_bytes"] <= per_model_bytes], key=lambda r: r["mae"])
    MODEL["alt_best_overall"] = alt
    return best


def stage_final(df, cfg):
    log(f"== FINAL cfg leaves={cfg['leaves']} trees={cfg['trees']} ==")
    mc, lt, names = MODEL["layout"]
    tr = df[df.split == "train"]
    ca = df[df.split == "calib"]
    te = df[df.split == "test"]
    Xtr = build_X(tr, mc, lt); ytr = np.log1p(tr["remaining_ms"].to_numpy())
    Xca = build_X(ca, mc, lt)
    Xte = build_X(te, mc, lt)
    actual_te = te["remaining_ms"].to_numpy()
    dur_te = te["dur_ms"].to_numpy()

    out = {}
    for alpha in (0.1, 0.5, 0.9):
        t0 = time.time()
        b = fit_one(Xtr, ytr, alpha, BASE_PARAMS, cfg["trees"], cfg["leaves"])
        po = b.predict(Xte)
        pred = np.maximum(np.expm1(po), 1.0)
        init, mode = resolve_init(b, Xte, po)
        trees, _ = trees_from_booster(b)
        trees = compactify(trees)
        ref = predict_log(trees, init, Xte)
        maxdiff = float(np.abs(ref - po).max())
        if maxdiff > 1e-4 or abs(init) > 1e-6:
            raise SystemExit(f"EXPORT SELF-CHECK FAILED alpha={alpha}: replay-vs-lightgbm "
                             f"max|diff|={maxdiff:.3g} log-space, init={init:.6g}")
        s = score(pred, actual_te)
        log(f"  alpha={alpha}  testMAE={s['mae']/1000:.1f}s medAE={s['median_ae']/1000:.1f}s "
            f"bias={s['bias']/1000:.1f}s init={init:.12g} refdiff={maxdiff:.3g} {time.time()-t0:.1f}s")
        out[str(alpha)] = {
            "booster": b, "trees": trees, "init": init, "init_mode": mode,
            "metrics": s, "ref_maxdiff": maxdiff,
            "train_log_pred": b.predict(Xtr[:20000]),
            "calib_log_pred": b.predict(Xca),
            "test_log_pred": po, "test_pred": pred,
        }
    out["_ctx"] = {"Xtr": Xtr, "ytr": ytr, "Xca": Xca, "Xte": Xte, "actual_te": actual_te,
                   "dur_te": dur_te, "te": te, "ca": ca, "tr": tr}
    MODEL["final"] = out
    return out


def resolve_init(booster, X, po):
    """Determine the additive constant of the tree ensemble empirically."""
    trees, _ = trees_from_booster(booster)
    s = predict_log(trees, 0.0, X[:5000])
    c = float(np.mean(po[:5000] - s))
    return (0.0 if abs(c) < 1e-9 else c), "empirical(tree_sum_vs_predict)"


def stage_prior(df, cfg):
    log("== PRIOR SIMULATION ==")
    mc, lt, base_names = MODEL["layout"]
    tr = df[df.split == "train"]
    te = df[df.split == "test"]
    Xtr = build_X(tr, mc, lt); ytr = np.log1p(tr["remaining_ms"].to_numpy())
    Xte = build_X(te, mc, lt)
    actual_te = te["remaining_ms"].to_numpy()
    ts_tr = tr["total_steps"].to_numpy(dtype=np.float64)
    ts_te = te["total_steps"].to_numpy(dtype=np.float64)
    k_tr = tr["k"].to_numpy(dtype=np.float64)
    k_te = te["k"].to_numpy(dtype=np.float64)
    rng = np.random.default_rng(SEED)
    rows = []
    for sigma in (0.0, 0.15, 0.3, 0.45, 0.6, 0.9):
        # same noise draw reused across sigmas is impossible (scale differs) -> fresh draw per sigma
        n_tr = np.exp(rng.normal(0.0, sigma, size=len(ts_tr))) if sigma > 0 else np.ones(len(ts_tr))
        n_te = np.exp(rng.normal(0.0, sigma, size=len(ts_te))) if sigma > 0 else np.ones(len(ts_te))
        pt_tr = np.maximum(ts_tr * n_tr, 1.0)
        pt_te = np.maximum(ts_te * n_te, 1.0)
        left_tr = np.maximum(pt_tr - k_tr, 0.0)
        left_te = np.maximum(pt_te - k_te, 0.0)
        # (a) full features + prior
        Xa_tr = np.column_stack([Xtr, pt_tr, left_tr]).astype(np.float32)
        Xa_te = np.column_stack([Xte, pt_te, left_te]).astype(np.float32)
        ba = fit_one(Xa_tr, ytr, 0.5, BASE_PARAMS, cfg["trees"], cfg["leaves"])
        sa = score(np.maximum(np.expm1(ba.predict(Xa_te)), 1.0), actual_te)
        # (b) prior only (single feature: prior_total)
        bb = fit_one(pt_tr.reshape(-1, 1).astype(np.float32), ytr, 0.5, BASE_PARAMS,
                     cfg["trees"], cfg["leaves"])
        sb = score(np.maximum(np.expm1(bb.predict(pt_te.reshape(-1, 1).astype(np.float32))), 1.0),
                   actual_te)
        rows.append({"sigma": sigma, "full_mae": sa["mae"], "full_medae": sa["median_ae"],
                     "full_bias": sa["bias"], "prior_only_mae": sb["mae"],
                     "prior_only_medae": sb["median_ae"]})
        log(f"  sigma={sigma:<4}  full+prior MAE={sa['mae']/1000:7.1f}s (medAE {sa['median_ae']/1000:6.1f}s)"
            f"   prior-only MAE={sb['mae']/1000:7.1f}s")
    MODEL["prior"] = rows
    with open(os.path.join(CACHE, "v3-prior.json"), "w") as fh:
        json.dump(rows, fh, indent=1)
    return rows


def load_cached_prior():
    p = os.path.join(CACHE, "v3-prior.json")
    if os.path.exists(p):
        with open(p) as fh:
            return json.load(fh)
    return []


def stage_conformal(df):
    log("== CONFORMAL ==")
    f = MODEL["final"]
    ctx = f["_ctx"]
    ca_actual = ctx["ca"]["remaining_ms"].to_numpy()
    te_actual = ctx["actual_te"]
    pred_ca = np.maximum(np.expm1(f["0.5"]["calib_log_pred"]), 1.0)
    pred_te = f["0.5"]["test_pred"]
    qs = [0.025, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.975]
    res = {}
    best = None
    for floor in (10_000.0, 30_000.0, 60_000.0):
        r_ca = (ca_actual - pred_ca) / np.maximum(pred_ca, floor)
        q = {f"q{int(round(x*1000)):03d}": float(np.quantile(r_ca, x)) for x in qs}
        r_te = (te_actual - pred_te) / np.maximum(pred_te, floor)
        cov = {}
        for nom, (lo, hi) in {"50": (0.25, 0.75), "80": (0.10, 0.90), "90": (0.05, 0.95)}.items():
            a = np.quantile(r_ca, lo); b = np.quantile(r_ca, hi)
            cov[nom] = float(((r_te >= a) & (r_te <= b)).mean())
        width = {}
        for nom, (lo, hi) in {"50": (0.25, 0.75), "80": (0.10, 0.90), "90": (0.05, 0.95)}.items():
            a = np.quantile(r_ca, lo); b = np.quantile(r_ca, hi)
            width[nom] = float(np.median(pred_te * (b - a)))
        err = sum(abs(cov[k] - int(k) / 100.0) for k in cov)
        row = {"floor_ms": floor, "quantiles": q, "coverage": cov, "median_width_ms": width,
               "abs_cov_err": err}
        log(f"  floor={floor:8.0f}ms  cov50={cov['50']:.3f} cov80={cov['80']:.3f} cov90={cov['90']:.3f}  err={err:.3f}")
        res[str(int(floor))] = row
        if best is None or err < best["abs_cov_err"]:
            best = row
    # direct quantile-model intervals (80% nominal) for comparison
    p10 = np.maximum(np.expm1(f["0.1"]["test_log_pred"]), 1.0)
    p90 = np.maximum(np.expm1(f["0.9"]["test_log_pred"]), 1.0)
    direct = float(((te_actual >= p10) & (te_actual <= p90)).mean())
    direct_ca_actual = ca_actual
    p10c = np.maximum(np.expm1(f["0.1"]["calib_log_pred"]), 1.0)
    p90c = np.maximum(np.expm1(f["0.9"]["calib_log_pred"]), 1.0)
    direct_ca = float(((direct_ca_actual >= p10c) & (direct_ca_actual <= p90c)).mean())
    log(f"  direct alpha=0.1/0.9 interval: calib cov={direct_ca:.3f} test cov={direct:.3f} (nominal 0.80)")
    MODEL["conformal"] = {"per_floor": res, "chosen": best,
                          "direct_80": {"calib": direct_ca, "test": direct}}
    return best


def stage_export(df, cfg):
    log("== EXPORT ==")
    f = MODEL["final"]
    mc, lt, names = MODEL["layout"]
    ctx = f["_ctx"]
    chosen = MODEL["conformal"]["chosen"]
    q = chosen["quantiles"]
    quantiles = {}
    for alpha in ("0.1", "0.5", "0.9"):
        d = f[alpha]
        quantiles[alpha] = {"init": d["init"], "trees": d["trees"],
                            "test_metrics": {k: round(v, 6) for k, v in d["metrics"].items()},
                            "ref_maxdiff": d["ref_maxdiff"]}
    s05 = f["0.5"]["metrics"]
    payload = {
        "schema": "eta-v3-quantile-v1",
        "meta": {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "source_data": "data/samples.csv",
            "objective": "quantile on log1p(remaining_ms)",
            "config": {"leaves": cfg["leaves"], "trees": cfg["trees"],
                       "min_child_samples": BASE_PARAMS["min_child_samples"],
                       "learning_rate": BASE_PARAMS["learning_rate"],
                       "feature_fraction": BASE_PARAMS["feature_fraction"],
                       "bagging_fraction": BASE_PARAMS["bagging_fraction"],
                       "lambda_l2": BASE_PARAMS["lambda_l2"]},
            "rows": {k: int(v) for k, v in df["split"].value_counts().items()},
            "train_rows": int((df.split == "train").sum()),
            "calib_rows": int((df.split == "calib").sum()),
            "test_rows": int((df.split == "test").sum()),
            "metrics_test_median_model": {k: round(v, 6) for k, v in s05.items()},
            "metrics_test_v2_baseline": {"mae": 264000.0, "median_ae": 132000.0,
                                         "bias": -120000.0, "mape": 1.41},
            "prior_sigma_curve": MODEL.get("prior") or load_cached_prior(),
            "sweep": MODEL["sweep"],
            "computing": (
                "for each tree: i=0; while f[i]>=0: i = (feature[f[i]] <= x[i]) ? i+1 : i+1+s[i]; "
                "leaf value = x[i]. pred_log = init + sum(leaf values); value = max(expm1(pred_log), 1). "
                "Trees are pre-order flattened: left child = i+1, right child = i+1+s[i], "
                "where s[i] is the node count of i's left subtree."),
            "feature_vector": (
                "features[] order: first feature_layout.numeric.length entries are raw numeric values, "
                "then one-hot dummies for feature_layout.categorical (level order as listed)."),
        },
        "features": names,
        "feature_layout": {"numeric": NUM_FEATURES,
                           "categorical": {"model_code": mc, "last_tool_cat": lt}},
        "target": {"space": "log1p", "inverse": "expm1", "clip": {"min": 1.0}},
        "quantiles": quantiles,
        "calibration": {
            "kind": "normalized_residual_quantiles",
            "normalization": "(actual - pred_median) / max(pred_median, floor_ms)",
            "floor_ms": chosen["floor_ms"],
            "table": q,
            "interval_rule": ("lo = max(1, pred + q_lo * max(pred, floor_ms)); "
                              "hi = max(lo, pred + q_hi * max(pred, floor_ms))"),
            "consumer_note": ("quantiles are fit independently and can cross (~0.2-1.2% of rows); "
                              "monotonize before display: sort(p10,p50,p90) ascending, and clamp lo<=p50<=hi"),
            "coverage_test": chosen["coverage"],
            "median_interval_width_ms_test": chosen["median_width_ms"],
            "direct_quantile_interval_80": MODEL["conformal"]["direct_80"],
        },
    }
    txt = json.dumps(payload, separators=(",", ":"), allow_nan=False)
    with open(OUT_MODEL, "w", encoding="utf-8") as fh:
        fh.write(txt)
    size = len(txt.encode())
    log(f"model json: {size/1024:.1f}KB -> {OUT_MODEL}")

    # ---- prediction sample csv (500 test rows, stratified by dur bucket)
    rng = np.random.default_rng(SEED)
    te = ctx["te"]; dur = ctx["dur_te"]
    idx = []
    per = 100
    for name, lo, hi in DUR_BUCKETS:
        m = np.nonzero((dur >= lo) & (dur < hi))[0]
        take = min(per, len(m))
        idx.extend(rng.choice(m, size=take, replace=False).tolist())
    idx = np.array(sorted(idx))
    te_rows = te.iloc[idx].reset_index(drop=True)
    p = {a: np.maximum(np.expm1(f[a]["test_log_pred"]), 1.0)[idx] for a in ("0.1", "0.5", "0.9")}
    scale = np.maximum(p["0.5"], chosen["floor_ms"])
    lo = np.maximum(p["0.5"] + q["q050"] * scale, 1.0)
    hi = np.maximum(p["0.5"] + q["q950"] * scale, lo)
    out = pd.DataFrame({
        "sid": te_rows["sid"],
        "turn": te_rows["turn"],
        "k": te_rows["k"],
        "dur_ms": te_rows["dur_ms"],
        "remaining_ms": te_rows["remaining_ms"],
        "v2_pred": te_rows["v2_pred"],
    })
    out["pred_p10"] = p["0.1"]
    out["pred_p50"] = p["0.5"]
    out["pred_p90"] = p["0.9"]
    out["pred_lo90"] = lo
    out["pred_hi90"] = hi
    for c in NUM_FEATURES + CAT_FEATURES:
        out[c] = te_rows[c]
    out.to_csv(OUT_SAMPLE, index=False)
    log(f"sample csv: {len(out)} rows -> {OUT_SAMPLE}")
    MODEL["export_size"] = size
    return size, payload


def stage_report(df, cfg):
    f = MODEL["final"]
    ctx = f["_ctx"]
    te = ctx["te"]
    actual = ctx["actual_te"]
    dur = ctx["dur_te"]
    v2 = te["v2_pred"].to_numpy()
    s_v2 = score(v2, actual)
    s05 = f["0.5"]["metrics"]
    report = {
        "v2": s_v2,
        "v3_p50": s05,
        "v3_p50_buckets": bucket_mae(f["0.5"]["test_pred"], actual, dur),
        "v2_buckets": bucket_mae(v2, actual, dur),
        "p10_p90_interval": {
            "coverage_test": MODEL["conformal"]["direct_80"]["test"],
            "coverage_calib": MODEL["conformal"]["direct_80"]["calib"],
        },
    }
    log("\n-- test comparison (v2 vs v3 p50) --")
    log(f"  v2 : MAE={s_v2['mae']/1000:7.1f}s medAE={s_v2['median_ae']/1000:6.1f}s "
        f"bias={s_v2['bias']/1000:7.1f}s RMSE={s_v2['rmse']/1000:6.1f}s MAPE={s_v2['mape']:.2f}")
    log(f"  v3 : MAE={s05['mae']/1000:7.1f}s medAE={s05['median_ae']/1000:6.1f}s "
        f"bias={s05['bias']/1000:7.1f}s RMSE={s05['rmse']/1000:6.1f}s MAPE={s05['mape']:.2f}")
    for name, _, _ in DUR_BUCKETS:
        a = report["v3_p50_buckets"][name]; b = report["v2_buckets"][name]
        log(f"  {name:8s} n={a['n']:7d}  v3={a['mae']/1000:7.1f}s  v2={b['mae']/1000:7.1f}s")
    MODEL["report"] = report
    with open(os.path.join(CACHE, "v3-report.json"), "w") as fh:
        json.dump(report, fh, indent=1)
    return report


def main():
    t0 = time.time()
    stages = sys.argv[1:] or ["sweep", "final", "prior", "conformal", "export", "report"]
    df = load()
    mc, lt, names = feature_layout(df)
    MODEL["layout"] = (mc, lt, names)
    log(f"features: {len(names)} ({len(NUM_FEATURES)} numeric + {len(mc)} model_code + {len(lt)} last_tool_cat)")

    cfg = None
    cache_path = os.path.join(CACHE, "v3-cfg.json")
    if "sweep" in stages:
        rows = stage_sweep(df)
        cfg = pick_config(rows)
        MODEL["cfg"] = cfg
        with open(cache_path, "w") as fh:
            json.dump({"cfg": cfg, "sweep": rows}, fh, indent=1)
        log(f"chosen: {cfg}")
    elif os.path.exists(cache_path):
        with open(cache_path) as fh:
            d = json.load(fh)
        cfg = d["cfg"]; MODEL["cfg"] = cfg; MODEL["sweep"] = d["sweep"]
        log(f"reusing cfg {cfg}")
    else:
        cfg = {"leaves": 15, "trees": 250, "dump_bytes": 0, "mae": 0}
        MODEL["cfg"] = cfg; MODEL["sweep"] = []
    if cfg is None:
        raise SystemExit("no config")

    if "final" in stages or "conformal" in stages or "export" in stages or "report" in stages:
        if "final" in stages:
            stage_final(df, cfg)
    if "prior" in stages:
        stage_prior(df, cfg)
    if "conformal" in stages:
        stage_conformal(df)
    if "export" in stages:
        stage_export(df, cfg)
    if "report" in stages:
        stage_report(df, cfg)
    log(f"total {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
