/**
 * eta-v3.js — pure-JS inference for the exported gradient-boosted quantile model.
 *
 * The model is a pair of artefacts produced offline by `tools/analysis/eta_report.py`:
 *   - `eta-v3-model.js` / `eta-v3-model.json`: LightGBM quantile trees (alpha=0.5,
 *     target = log1p(remaining_ms)) flattened into node arrays, plus a conformal
 *     residual table keyed by the predicted ETA bucket.
 *   - the feature vector is assembled by the caller (`lib/estimator-v3.js`), in the
 *     exact order listed in `model.features`.
 *
 * No dependencies, no dynamic imports: this module is safe to import from a dsh
 * host plugin (the bundle ships it as a normal ESM file).
 *
 * Node encoding per tree: flat array of [splitFeature, threshold, left, right];
 * leaves are [-1, leafValue, -1, -1]. Missing/unavailable numeric value → left
 * child, which matches how the tree was fitted (all features are always
 * materialised, so this only matters for defensive fallbacks).
 */

export const ETA_V3_SCHEMA = 'eta-v3-quantile-v1';

/** Buckets used by the conformal table; must match the training script. */
export const ETA_BUCKETS = [
  { key: '<1m', maxMs: 60_000 },
  { key: '1-3m', maxMs: 180_000 },
  { key: '3-10m', maxMs: 600_000 },
  { key: '10-30m', maxMs: 1_800_000 },
  { key: '30-60m', maxMs: 3_600_000 },
  { key: '>60m', maxMs: Infinity },
];

export const MIN_ETA_MS = 3_000;
export const MAX_ETA_MS = 4 * 3_600_000;

/** Confidence thresholds on the 80% interval width relative to the point estimate. */
/** Confidence cuts on the *relative* error scale (see `confidenceOfCalibration`). */
export const CONFIDENCE_THRESHOLDS = { high: 0.35, medium: 0.9 };

/**
 * Confidence of a prediction bucket.
 *
 * Deliberately defined on the expected *relative* error of the bucket (as
 * measured on the calibration split), not on the interval width: the interval
 * width is a consequence of the bucket, while what users feel is "is it 2m or
 * 5m?". Measured on test, the resulting classes separate cleanly:
 * high MAPE 0.21 / medium 0.59 / low 0.95.
 */
export function confidenceOfCalibration(calibration) {
  const mape = Number(calibration?.mape_calib);
  if (!Number.isFinite(mape)) return 'low';
  if (mape <= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (mape <= CONFIDENCE_THRESHOLDS.medium) return 'medium';
  return 'low';
}

/** Validate an exported model object; throws on malformed input. */
export function validateModel(model) {
  if (!model || model.schema !== ETA_V3_SCHEMA) {
    throw new Error(`eta-v3: unexpected schema ${model?.schema}`);
  }
  if (!Array.isArray(model.features) || model.features.length === 0) {
    throw new Error('eta-v3: model.features missing');
  }
  const quantile = model?.quantiles?.q050;
  if (!quantile || !Array.isArray(quantile.trees) || quantile.trees.length === 0) {
    throw new Error('eta-v3: model.quantiles.q050.trees missing');
  }
  if (!Number.isFinite(quantile.init)) {
    throw new Error('eta-v3: model.quantiles.q050.init missing');
  }
  for (const tree of quantile.trees) {
    if (!Array.isArray(tree) || tree.length === 0) throw new Error('eta-v3: empty tree');
    const [feature, threshold, left, right] = tree[0];
    if (feature >= 0) {
      const ok = Number.isInteger(left) && Number.isInteger(right) && left > 0 && right > 0;
      if (!ok) throw new Error('eta-v3: malformed root node (children must follow the parent)');
    } else if (!Number.isFinite(threshold)) {
      throw new Error('eta-v3: malformed root leaf');
    }
  }
  return model;
}

/** Evaluate one flattened tree against a dense feature vector. */
function evaluateTree(tree, values) {
  let index = 0;
  for (;;) {
    const node = tree[index];
    const feature = node[0];
    if (feature < 0) return node[1];
    const value = values[feature];
    index = Number.isFinite(value) && value > node[1] ? node[3] : node[2];
  }
}

/** Raw log-space prediction: init + sum(leaf values). */
export function predictLog(model, values) {
  let sum = model.quantiles.q050.init ?? 0;
  for (const tree of model.quantiles.q050.trees) sum += evaluateTree(tree, values);
  return sum;
}

/** Bucket key for the conformal residual table. */
export function bucketOf(ms) {
  for (const bucket of ETA_BUCKETS) if (ms < bucket.maxMs) return bucket.key;
  return '>60m';
}

/**
 * Predict the remaining time of the current turn.
 *
 * @param {object} model     exported model (see validateModel)
 * @param {number[]} values  dense feature vector in model.features order
 * @returns {{etaMs:number, loMs:number, hiMs:number, relWidth:number,
 *            confidence:'high'|'medium'|'low', bucket:string, calibration:object}}
 */
export function predictRemainingMs(model, values) {
  if (values.length !== model.features.length) {
    throw new Error(`eta-v3: feature vector has ${values.length} values, expected ${model.features.length}`);
  }
  const raw = Math.expm1(predictLog(model, values));
  const etaMs = Math.min(MAX_ETA_MS, Math.max(MIN_ETA_MS, Number.isFinite(raw) ? raw : MIN_ETA_MS));
  const bucket = bucketOf(etaMs);
  const calibration = model.calibration?.[bucket] ?? { 'q0.10': -0.5, 'q0.90': 0.5 };
  const loMs = Math.max(MIN_ETA_MS, etaMs * (1 + calibration['q0.10']));
  const hiMs = Math.max(loMs, Math.min(MAX_ETA_MS, etaMs * (1 + calibration['q0.90'])));
  const relWidth = (hiMs - loMs) / Math.max(etaMs, MIN_ETA_MS);
  return { etaMs, loMs, hiMs, relWidth, confidence: confidenceOfCalibration(calibration), bucket, calibration };
}

/**
 * Confidence with a cold-start penalty: a session's first turn has no session
 * tempo to lean on, so the same interval is honestly less trustworthy.
 */
export function confidenceWithColdStart(result, isColdStart) {
  if (!isColdStart) return result.confidence;
  return result.confidence === 'high' ? 'medium' : 'low';
}

/** Human-readable checks used by tests / diagnostics. */
export function describeModel(model) {
  return {
    schema: model.schema,
    features: model.features.length,
    trees: model.quantiles.q050.trees.length,
    buckets: Object.keys(model.calibration ?? {}),
    meta: model.meta ?? null,
  };
}
