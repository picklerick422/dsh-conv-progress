/**
 * estimator-v3.js — remaining-time prediction for one agent turn.
 *
 * v3 replaces the hand-fitted survival table of v2 with a gradient-boosted
 * quantile model (see `eta-v3-model.js`) over the features in `features.js`.
 * The model was fitted offline on 944k replay samples of 6,921 real turns; the
 * measured effect on a held-out 137k sample / 239 sessions split is
 * MAE 4.4m -> 2.0m, median AE 2.2m -> 36.6s, MAPE 1.41 -> 0.70.
 *
 * Kept deliberately separate from `estimator.js` (v2) so the plugin can fall
 * back to the previous behaviour if the model fails to load.
 */
import {
  DEFAULT_PARAMS,
  createModel as createModelV2,
  beginTurn as beginTurnV2,
  observeStepMs as observeStepMsV2,
  observeTurn as observeTurnV2,
} from './estimator.js';
import { FEATURE_NAMES, createFeatureState, applyEvent, buildFeatureMap, toVector } from './features.js';
import {
  ETA_V3_SCHEMA,
  MIN_ETA_MS,
  MAX_ETA_MS,
  predictRemainingMs,
  confidenceWithColdStart,
  describeModel as describeModelV3,
} from './eta-v3.js';
import { ETA_V3_MODEL } from './eta-v3-model.js';
import { medianRemainingSteps } from './eta-model.js';

const V3_CONFIDENCE_CUTS = { high: 0.35, medium: 0.9 };
const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const ema = (previous, next, alpha) => previous + (next - previous) * alpha;

/**
 * Guard the retrain→host contract: a model fitted with a feature the host cannot
 * compute would silently read `undefined` (→ 0) inside the trees and predict
 * garbage. Fail loudly at model creation instead.
 */
export function assertModelFeatures(model) {
  const known = new Set(FEATURE_NAMES);
  const unknown = (model?.features ?? []).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(`estimator-v3: model expects feature(s) the host cannot compute: ${unknown.join(', ')}`);
  }
  return true;
}

/** Model = v2 calibration state + feature replay state + the fitted booster. */
export function createModel(params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  assertModelFeatures(ETA_V3_MODEL);
  return {
    params: p,
    /** v2 estimator state: keeps the step-time EMA the v3 features consume. */
    v2: createModelV2(params),
    /** Feature replay state, advanced by `applyEvent`. */
    features: createFeatureState(),
    /** Smoothed ETA for the current turn, or null right after beginTurn. */
    etaMs: null,
    turn: null,
    turnPercent: 0,
    samples: 0,
    model: ETA_V3_MODEL,
  };
}

export function beginTurn(model, turn) {
  beginTurnV2(model.v2, turn);
  model.turn = turn;
  model.turnPercent = 0;
  model.etaMs = null;
  model.samples = 0;
}

/** Feed one committed session event into the feature state. */
export function observe(model, event) {
  applyEvent(model.features, event);
}

/** Fold one completed step duration into the step-time EMA (clamped). */
export function observeStepMs(model, durationMs) {
  observeStepMsV2(model.v2, durationMs);
}

/** Fold a finished turn into the session tempo EMAs. */
export function observeTurn(model, info) {
  observeTurnV2(model.v2, info);
}

/** Plan fraction, credited 40 % for `in_progress` items, or null without a plan. */
function planOf(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return null;
  let completed = 0;
  let inProgress = 0;
  for (const item of todos) {
    if (item?.status === 'completed') completed += 1;
    else if (item?.status === 'in_progress') inProgress += 1;
  }
  return { total: todos.length, completed, inProgress };
}

/**
 * Confidence from the calibrated expected relative error of the estimate's
 * range bucket — *not* from the interval width. Relative error is what a user
 * actually experiences ("is it 2m or 5m?"), and it is the only scale on which
 * the fitted buckets separate (short ETAs are inherently harder in relative
 * terms even though their absolute error is smaller).
 */
function confidenceOfBucket(calibration) {
  const mape = Number(calibration?.mape_calib);
  if (!Number.isFinite(mape)) return 'low';
  if (mape <= V3_CONFIDENCE_CUTS.high) return 'high';
  if (mape <= V3_CONFIDENCE_CUTS.medium) return 'medium';
  return 'low';
}

/**
 * Estimate progress and remaining time for the current turn.
 *
 * Same signature as the v2 estimator, so the host can swap implementations:
 * the fact bag carries the live turn summary, the feature replay state carries
 * the history (previous steps, tools, prompt shape, last plan).
 *
 * @param {ReturnType<typeof createModel>} model
 * @param {{
 *   running: boolean,
 *   turn?: number,
 *   stepsDone?: number,
 *   stepStartedAt?: number|null,
 *   turnStartedAt?: number|null,
 *   now?: number,
 *   todos?: {status?: string}[]|null,
 * }} facts
 */
export function estimate(model, facts = {}) {
  const p = model.params;
  const now = Number.isFinite(facts.now) ? facts.now : Date.now();
  const running = facts.running === true;
  const turnNumber = Number.isFinite(facts.turn) ? facts.turn : 0;
  const stepsDone = Math.max(0, Math.floor(facts.stepsDone ?? 0));

  if (model.turn !== turnNumber) beginTurn(model, turnNumber);

  if (!running) {
    model.etaMs = 0;
    model.turnPercent = 1;
    return {
      percent: 1,
      etaMs: 0,
      loMs: 0,
      hiMs: 0,
      confidence: 'high',
      remainingSteps: 0,
      expectedSteps: stepsDone,
      basis: 'done',
      breakdown: { elapsedMs: 0, stepsDone, bucket: null, confidenceBase: 'high', features: null },
    };
  }

  const turnStartedAt = Number.isFinite(facts.turnStartedAt) ? facts.turnStartedAt : null;
  const stepStartedAt = Number.isFinite(facts.stepStartedAt) ? facts.stepStartedAt : null;
  const stepElapsed = stepStartedAt === null ? 0 : Math.max(0, now - stepStartedAt);
  const elapsedMs =
    turnStartedAt !== null
      ? Math.max(0, now - turnStartedAt)
      : Math.max(0, stepsDone * model.v2.stepMs + stepElapsed);

  // ── ETA: quantile GBM → conformal interval → display smoothing ───────────
  const featureMap = buildFeatureMap(model.features, { now, stepMsEma: model.v2.stepMs });
  const vector = toVector(featureMap, model.model.features);
  const prediction = predictRemainingMs(model.model, vector);
  const rawEtaMs = clamp(prediction.etaMs, p.minEtaMs, Math.min(p.maxEtaMs, MAX_ETA_MS));
  model.etaMs = model.etaMs === null ? rawEtaMs : ema(model.etaMs, rawEtaMs, p.etaAlpha);
  const etaMs = Math.round(clamp(model.etaMs, MIN_ETA_MS, MAX_ETA_MS));
  model.samples += 1;

  // ── percent: time share, plan-aware, monotonic within the turn ────────────
  const plan = planOf(facts.todos);
  const timePercent = clamp(elapsedMs / Math.max(1, elapsedMs + etaMs), 0, 0.99);
  let planPercent = null;
  if (plan !== null) {
    planPercent = clamp((plan.completed + plan.inProgress * p.inProgressCredit) / plan.total, 0, 1);
  }
  // A finished plan is *not* progress: the agent often keeps working after the
  // last todo. Blending planPercent=1 there would pin the bar at 100 % while
  // minutes of work remain, so once the plan is fully credited the bar falls
  // back to the time share alone.
  const planUsable = planPercent !== null && planPercent < 1;
  const rawPercent = planUsable
    ? p.planPercentWeight * planPercent + (1 - p.planPercentWeight) * timePercent
    : timePercent;
  const percent = clamp(Math.max(rawPercent, model.turnPercent), p.percentFloor, p.percentCap);
  model.turnPercent = Math.max(model.turnPercent, percent);

  // ── informational step counts (title only) ────────────────────────────────
  const remainingSteps = medianRemainingSteps(stepsDone);
  const expectedSteps = round(stepsDone + remainingSteps, 1);

  // ── confidence: expected relative error of this bucket, cold-start penalty ─
  const confidenceBase = confidenceOfBucket(prediction.calibration);
  const isColdStart = (featureMap.n_prev_turns ?? 0) === 0;
  const confidence = confidenceWithColdStart({ confidence: confidenceBase }, isColdStart);

  return {
    percent,
    etaMs,
    loMs: Math.round(prediction.loMs),
    hiMs: Math.round(prediction.hiMs),
    confidence,
    remainingSteps,
    expectedSteps,
    basis: planUsable ? 'v3-quantile+plan' : 'v3-quantile',
    breakdown: {
      elapsedMs,
      stepElapsedMs: stepElapsed,
      etaRawMs: Math.round(prediction.etaMs),
      etaSmoothedMs: etaMs,
      timePercent: round(timePercent, 3),
      planPercent: planPercent === null ? null : round(planPercent, 3),
      planItems: plan?.total ?? 0,
      bucket: prediction.bucket,
      bucketMape: prediction.calibration?.mape_calib ?? null,
      confidenceBase,
      isColdStart,
      relWidth: round(prediction.relWidth, 3),
      samples: model.samples,
      features: featureMap,
    },
  };
}

/** Digest used by the host debug log and by tests. */
export function describeModel(model) {
  return {
    turn: model.turn,
    stepMs: Math.round(model.v2.stepMs),
    stepsPerTurn: round(model.v2.stepsPerTurn),
    samples: model.samples,
    schema: ETA_V3_SCHEMA,
    model: describeModelV3(model.model),
  };
}

export { DEFAULT_PARAMS, ETA_V3_SCHEMA };
