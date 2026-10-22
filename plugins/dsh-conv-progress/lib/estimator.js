/**
 * dsh-conv-progress — progress / ETA estimator (pure functions, zero dsh imports).
 *
 * ── Why this model (v2) ─────────────────────────────────────────────────────
 * v1 extrapolated from step *counts*: "a turn usually takes N steps, a step
 * usually takes T ms". Offline replay of 7108 real turns showed the assumption
 * is wrong twice over:
 *   • steps per turn is not a stable parameter (p50 9, mean 21, p90 59, p99 far
 *     higher) — the agent decides how many steps to take *as it goes*;
 *   • the error is structural, not noise: v1 overshoots short turns (MAE 4.4m
 *     on turns under 30 s) and overshoots long turns too (MAE 9.6m above 15 m,
 *     +6.9m bias in the last 10 %).
 * Turn completion time is fundamentally unpredictable from (steps, elapsed)
 * alone, so the right target is the *conditional median of remaining time*,
 * not a mean extrapolation. v2 is therefore a fitted non-parametric survival
 * table (see `eta-model.js`, generated from real sessions):
 *
 *     ETA(k, elapsed) = median remaining wall-clock time
 *                       over historical turns that had completed k steps
 *                       and had been running for `elapsed` ms.
 *
 * Validated on a held-out 30 % split of sessions (completed turns, hygiene
 * filtered): MAE 5.7m → 4.4m, median AE 3.6m → 2.2m, mean signed error
 * +58 s → +6 s, MAPE 1.69 → 1.06.
 *
 * ── What is still formula-based ────────────────────────────────────────────
 *   • progress percent: `elapsed / (elapsed + ETA)`, blended with the todo
 *     plan fraction when the agent wrote one, monotonic within a turn, capped
 *     just below 100 % while running;
 *   • display smoothing: EMA over successive ETA values so the number does not
 *     dance between polls;
 *   • confidence: how well supported the table cell is (sample count) plus how
 *     much per-session history the calibrator has already seen. `low` keeps the
 *     UI contract "show elapsed only, hide the ETA".
 *
 * v1's step model is retained only for the informational "x / y steps" title
 * and as a fallback when the table has no cell at all.
 */
import {
  ETA_MODEL_META,
  STEP_P50_MS,
  STEP_MEAN_MS,
  lookupEtaMs,
  medianRemainingSteps,
} from './eta-model.js';

/**
 * Tunables. `priorStepMs` / `priorStepsPerTurn` are kept for config
 * compatibility (and for the fallback path); the fitted tables are the source
 * of truth for the ETA.
 */
export const DEFAULT_PARAMS = Object.freeze({
  /** Wall-clock prior for one step (one model call + its tools), ms. */
  priorStepMs: 13_200,
  /** Never trust a measured step shorter/longer than this when updating the EMA. */
  minStepMs: 1_000,
  maxStepMs: 20 * 60_000,
  /** EMA alpha for measured step duration (higher = trust the newest sample more). */
  stepAlpha: 0.35,

  /** Fallback steps-per-turn prior, used when the table has no cell. */
  priorStepsPerTurn: 9,
  minStepsPerTurn: 2,
  maxStepsPerTurn: 200,
  turnAlpha: 0.3,

  /** How many steps one todo item costs by default (plan model). */
  priorStepsPerTodo: 4,
  minStepsPerTodo: 1,
  maxStepsPerTodo: 20,
  todoAlpha: 0.4,

  /** percent = planPercentWeight * planPercent + (1 - planPercentWeight) * timePercent */
  planPercentWeight: 0.6,
  /** Credit given to a todo item that is `in_progress` (fraction of the item considered done). */
  inProgressCredit: 0.4,

  /** The bar stops just short of 100% while the turn is still running. */
  percentCap: 0.97,
  /** ...and never drops to 0 right after a turn starts. */
  percentFloor: 0.01,
  /** EMA alpha for the displayed ETA (keeps the number from dancing). */
  etaAlpha: 0.4,
  minEtaMs: 3_000,
  /** Absolute sanity cap on a single-turn ETA (3h). */
  maxEtaMs: 3 * 60 * 60_000,
});

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);
const ema = (prev, next, alpha) => prev + (next - prev) * alpha;
const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Fresh per-session estimation state. `params` may override DEFAULT_PARAMS. */
export function createModel(params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  return {
    params: p,
    /** Measured step duration EMA (ms) — informational / fallback only. */
    stepMs: p.priorStepMs,
    /** Measured steps-per-turn EMA — informational only in v2. */
    stepsPerTurn: p.priorStepsPerTurn,
    /** Measured steps-per-todo-item EMA. */
    stepsPerTodo: p.priorStepsPerTodo,
    stepSamples: 0,
    turnSamples: 0,
    todoSamples: 0,
    /** Current turn number (reset detection). */
    turn: null,
    /** Highest percent shown during the current turn (monotonicity guard). */
    turnPercent: 0,
    /** Smoothed ETA for the current turn, or null right after beginTurn. */
    etaMs: null,
  };
}

/** Start a new turn: forget per-turn smoothing, keep the calibration. */
export function beginTurn(model, turn) {
  model.turn = turn;
  model.turnPercent = 0;
  model.etaMs = null;
}

/** Fold one completed step duration into the step-time EMA (clamped). */
export function observeStepMs(model, durationMs) {
  const p = model.params;
  const value = clamp(durationMs, p.minStepMs, p.maxStepMs);
  if (model.stepSamples === 0) {
    model.stepMs = value;
  } else {
    model.stepMs = clamp(ema(model.stepMs, value, p.stepAlpha), p.minStepMs, p.maxStepMs);
  }
  model.stepSamples += 1;
}

/**
 * Fold a finished turn into the calibration EMAs.
 * The fitted tables are global and do not change at runtime; this only keeps
 * the fallback priors and the debug view honest.
 */
export function observeTurn(model, { durationMs, steps, todoDelta = 0 } = {}) {
  const p = model.params;
  const count = Math.max(1, Math.floor(steps || 0));
  if (Number.isFinite(durationMs) && durationMs > 0 && steps > 0) {
    observeStepMs(model, durationMs / count);
  }
  if (steps > 0) {
    const bounded = clamp(steps, p.minStepsPerTurn, p.maxStepsPerTurn);
    model.stepsPerTurn = model.turnSamples === 0 ? bounded : ema(model.stepsPerTurn, bounded, p.turnAlpha);
    model.turnSamples += 1;
  }
  if (todoDelta > 0 && steps > 0) {
    const perTodo = clamp(steps / todoDelta, p.minStepsPerTodo, p.maxStepsPerTodo);
    model.stepsPerTodo = model.todoSamples === 0 ? perTodo : ema(model.stepsPerTodo, perTodo, p.todoAlpha);
    model.todoSamples += 1;
  }
  return model;
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

/** `HH:MM`-free, digestible view of what drove the last estimate (debug/title). */
export function describeModel(model) {
  return {
    turn: model.turn,
    stepMs: Math.round(model.stepMs),
    stepsPerTurn: round(model.stepsPerTurn),
    stepsPerTodo: round(model.stepsPerTodo),
    samples: { steps: model.stepSamples, turns: model.turnSamples, todos: model.todoSamples },
    table: {
      stepP50Ms: ETA_MODEL_META.stepP50Ms,
      stepMeanMs: ETA_MODEL_META.stepMeanMs,
      trainTurns: ETA_MODEL_META.trainTurns,
      fittedAt: ETA_MODEL_META.fittedAt,
    },
  };
}

/**
 * Estimate progress and remaining time for the current turn.
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
      remainingSteps: 0,
      expectedSteps: stepsDone,
      confidence: 'high',
      basis: 'done',
      breakdown: { elapsedMs: 0, stepsDone, cell: null, cellSamples: 0, cellSource: 'done', reliability: 1 },
    };
  }

  // ── elapsed time inside the turn ──────────────────────────────────────────
  const turnStartedAt = Number.isFinite(facts.turnStartedAt) ? facts.turnStartedAt : null;
  const stepStartedAt = Number.isFinite(facts.stepStartedAt) ? facts.stepStartedAt : null;
  const stepElapsed = stepStartedAt === null ? 0 : Math.max(0, now - stepStartedAt);
  const elapsedMs =
    turnStartedAt !== null
      ? Math.max(0, now - turnStartedAt)
      : Math.max(0, stepsDone * model.stepMs + stepElapsed);

  // ── ETA: fitted conditional median, then display smoothing ────────────────
  const lookup = lookupEtaMs(stepsDone, elapsedMs);
  const rawEtaMs = clamp(lookup.etaMs, p.minEtaMs, p.maxEtaMs);
  model.etaMs = model.etaMs === null ? rawEtaMs : ema(model.etaMs, rawEtaMs, p.etaAlpha);
  const etaMs = Math.round(clamp(model.etaMs, p.minEtaMs, p.maxEtaMs));

  // ── percent: time share, plan-aware, monotonic within the turn ────────────
  const plan = planOf(facts.todos);
  const timePercent = clamp(elapsedMs / Math.max(1, elapsedMs + etaMs), 0, 0.99);
  let planPercent = null;
  if (plan !== null) {
    planPercent = clamp((plan.completed + plan.inProgress * p.inProgressCredit) / plan.total, 0, 1);
  }
  // A finished plan is *not* progress: the agent often keeps working after the
  // last todo (verification, cleanup). Blending planPercent=1 there would pin
  // the bar at 100 % while minutes of work remain, so once the plan is fully
  // credited the bar falls back to the time share.
  const planUsable = planPercent !== null && planPercent < 1;
  const rawPercent = planUsable
    ? p.planPercentWeight * planPercent + (1 - p.planPercentWeight) * timePercent
    : timePercent;
  const percent = clamp(Math.max(rawPercent, model.turnPercent), p.percentFloor, p.percentCap);
  model.turnPercent = Math.max(model.turnPercent, percent);

  // ── informational step counts (title only) ────────────────────────────────
  const remainingSteps = medianRemainingSteps(stepsDone);
  const expectedSteps = round(stepsDone + remainingSteps, 1);

  // ── confidence: table support + how much we have already measured ─────────
  let score = 0.18 + 0.5 * lookup.reliability + 0.05 * Math.min(4, stepsDone);
  if (model.turnSamples >= 1) score += 0.1;
  if (model.stepSamples >= 3) score += 0.05;
  if (planUsable) score += 0.03;
  score = clamp(score, 0.15, 0.9);
  const confidence = score >= 0.7 ? 'high' : score >= 0.45 ? 'medium' : 'low';

  return {
    percent,
    etaMs,
    remainingSteps: round(remainingSteps, 1),
    expectedSteps,
    confidence,
    basis: planUsable ? 'time-table+plan' : 'time-table',
    breakdown: {
      elapsedMs,
      stepElapsedMs: stepElapsed,
      etaRawMs: Math.round(rawEtaMs),
      etaSmoothedMs: etaMs,
      timePercent: round(timePercent, 4),
      planPercent: planPercent === null ? null : round(planPercent, 4),
      planItems: plan === null ? null : plan.total,
      cell: lookup.cell,
      cellSamples: lookup.samples,
      cellSource: lookup.source,
      reliability: round(lookup.reliability, 3),
      score: round(score, 3),
    },
  };
}

export { STEP_P50_MS, STEP_MEAN_MS, ETA_MODEL_META };
