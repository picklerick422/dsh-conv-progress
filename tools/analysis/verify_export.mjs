#!/usr/bin/env node
/**
 * verify_export.mjs — independent pure-JS re-evaluation of the exported ETA v3 model.
 *
 * Reads data/eta-v3-model.json and data/v3-pred-sample.csv (500 held-out test rows with Python
 * predictions) and checks that a from-scratch JS tree walk reproduces the Python predictions.
 *
 * Model JSON contract (schema "eta-v3-quantile-v1"):
 *   features[]            : ordered feature names; the first `feature_layout.numeric.length` are
 *                           numeric, the rest are one-hot dummies for model_code / last_tool_cat.
 *   quantiles[a] = {init, trees:[{f,x,s}]}
 *     trees are pre-order flattened; node i:
 *       f[i] < 0  -> leaf, value = x[i]
 *       f[i] >= 0 -> split on feature[f[i]] <= x[i]; left child = i+1, right child = i+1+s[i]
 *                    (s[i] = node count of i's left subtree)
 *     pred_log = init + sum(leaf values); value = max(expm1(pred_log), 1)
 *   calibration.table[q025..q975], rule: lo = max(1, pred + q_lo*max(pred,floor_ms)),
 *   hi = max(lo, pred + q_hi*max(pred, floor_ms))
 *
 * Usage: node tools/analysis/verify_export.mjs [--tol 1e-4] [--quiet]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const TOL = Number(opt("--tol", "1e-4"));
const MODEL_PATH = resolve(ROOT, opt("--model", "data/eta-v3-model.json"));
const SAMPLE_PATH = resolve(ROOT, opt("--sample", "data/v3-pred-sample.csv"));
const QUIET = args.includes("--quiet");

const log = (...a) => { if (!QUIET) console.log(...a); };

// ---------------------------------------------------------------- model load
const model = JSON.parse(readFileSync(MODEL_PATH, "utf8"));
if (model.schema !== "eta-v3-quantile-v1") throw new Error(`unexpected schema ${model.schema}`);
const features = model.features;
const numeric = model.feature_layout.numeric;
const cats = model.feature_layout.categorical || {};
const fidx = new Map(features.map((f, i) => [f, i]));
const N_NUM = numeric.length;

if (features.length !== N_NUM + Object.values(cats).reduce((s, lv) => s + lv.length, 0))
  throw new Error("feature count mismatch between features[] and feature_layout");

/** raw row (object of column -> number) -> ordered float array matching features[] */
function vectorize(row) {
  const v = new Array(features.length).fill(0);
  for (let i = 0; i < N_NUM; i++) v[i] = Number(row[numeric[i]]);
  let off = N_NUM;
  for (const [col, levels] of Object.entries(cats)) {
    const val = Number(row[col]);
    for (let j = 0; j < levels.length; j++) v[off + j] = val === levels[j] ? 1 : 0;
    off += levels.length;
  }
  return v;
}

function evalTree(t, v) {
  const { f, x, s } = t;
  let i = 0;
  let guard = 0;
  while (f[i] >= 0) {
    if (++guard > 64) throw new Error("tree walk did not terminate");
    i = v[f[i]] <= x[i] ? i + 1 : i + 1 + s[i];
  }
  return x[i];
}

const predLog = new Map();
for (const [alpha, q] of Object.entries(model.quantiles)) {
  predLog.set(alpha, (v) => {
    let s = q.init;
    const trees = q.trees;
    for (let ti = 0; ti < trees.length; ti++) s += evalTree(trees[ti], v);
    return s;
  });
}
const toMs = (lg) => Math.max(Math.expm1(lg), model.target?.clip?.min ?? 1);

// ---------------------------------------------------------------- csv
const text = readFileSync(SAMPLE_PATH, "utf8").replace(/\r/g, "");
const lines = text.split("\n").filter((s) => s.length);
const header = lines[0].split(",");
const numCols = new Set([...numeric, ...Object.keys(cats)]);
const rows = lines.slice(1).map((line) => {
  const cells = line.split(",");
  const o = {};
  for (let i = 0; i < header.length; i++) {
    const h = header[i];
    o[h] = numCols.has(h) ? Number(cells[i]) : cells[i];
  }
  return o;
});

// ---------------------------------------------------------------- compare
const cal = model.calibration || {};
const floor = cal.floor_ms;
const tbl = cal.table || {};
const ALPHA_KEYS = Object.keys(model.quantiles);
const alphaKey = (a) => {
  const k = ALPHA_KEYS.find((k) => Math.abs(Number(k) - a) < 1e-12);
  if (!k) throw new Error(`model has no quantile ${a} (has ${ALPHA_KEYS.join(",")})`);
  return k;
};
const checks = [
  ["pred_p10", alphaKey(0.1)],
  ["pred_p50", alphaKey(0.5)],
  ["pred_p90", alphaKey(0.9)],
];
const need = [...checks.map((c) => c[0]), "pred_lo90", "pred_hi90"];
for (const c of need) if (!(c in rows[0])) throw new Error(`sample csv missing column ${c}`);

let worst = { rel: 0 };
const perCol = {};
const cov = { lo: 0, hi: 0, n: 0 };
for (const row of rows) {
  const v = vectorize(row);
  for (const [col, alpha] of checks) {
    const py = Number(row[col]);
    const js = toMs(predLog.get(alpha)(v));
    const rel = Math.abs(js - py) / Math.max(1, Math.abs(py));
    perCol[col] = Math.max(perCol[col] || 0, rel);
    if (rel > worst.rel) worst = { rel, col, py, js };
  }
  // calibrated 90% interval from the residual table (also part of the JS contract)
  const p50 = toMs(predLog.get(alphaKey(0.5))(v));
  const scale = Math.max(p50, floor);
  const lo = Math.max(1, p50 + tbl.q050 * scale);
  const hi = Math.max(lo, p50 + tbl.q950 * scale);
  for (const [col, want] of [["pred_lo90", lo], ["pred_hi90", hi]]) {
    const py = Number(row[col]);
    const rel = Math.abs(want - py) / Math.max(1, Math.abs(py));
    perCol[col] = Math.max(perCol[col] || 0, rel);
    if (rel > worst.rel) worst = { rel, col, py, js: want };
  }
  cov.n++;
  const actual = Number(row.remaining_ms);
  if (actual >= lo && actual <= hi) cov.hi++;
}

log(`model      : ${MODEL_PATH.replace(ROOT + "/", "")} (${(readFileSync(MODEL_PATH).length / 1024).toFixed(1)} KB)`);
log(`sample     : ${SAMPLE_PATH.replace(ROOT + "/", "")} rows=${rows.length}`);
log(`features   : ${features.length} (${N_NUM} numeric + ${features.length - N_NUM} dummies)`);
log(`trees      : ${Object.entries(model.quantiles).map(([a, q]) => `a=${a}:${q.trees.length}`).join(" ")}`);
log(`tol        : rel < ${TOL}`);
for (const [c, v] of Object.entries(perCol)) log(`  ${c.padEnd(10)} max rel err = ${v.toExponential(3)}`);
log(`sample 90% interval coverage (from calib table): ${(cov.hi / cov.n * 100).toFixed(1)}%`);

const ok = worst.rel < TOL;
if (!ok) {
  console.error(`FAIL: max rel err ${worst.rel.toExponential(3)} on ${worst.col} ` +
    `python=${worst.py} js=${worst.js}`);
  process.exit(1);
}
console.log(`PASS: ${rows.length} rows x ${need.length} columns, max rel err ` +
  `${worst.rel.toExponential(3)} (< ${TOL})`);
