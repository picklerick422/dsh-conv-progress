/**
 * dsh-conv-progress — progress / ETA estimator (pure functions, zero dsh imports).
 *
 * Why a step-equivalent model?
 *   A conversation turn is a sequence of *steps* (one model call each, plus the
 *   tools that call issues). Steps are the only unit the harness reports
 *   reliably (`step/start`, `step/end`); wall-clock seconds are not. So every
 *   estimate is expressed in "step equivalents" and converted to time with a
 *   calibrated per-step duration:
 *
 *       total  = stepsDone + stepFraction + remainingSteps
 *       percent = progress so far / total
 *       eta     = currentStepRemaining + futureSteps * stepMs
 *
 *   Two independent estimators are blended:
 *     1. step model  — how many steps does a turn usually take? (turn history)
 *     2. plan model  — the todo plan says how many items are left, and how many
 *                      steps an item usually costs (plan history)
 *   The plan model is more semantic but only exists when the agent wrote a todo
 *   list; without one the step model alone drives the bar.
 */

/** Tunables. Every number here is a prior, not a measurement — they get replaced by history. */
export const DEFAULT_PARAMS = Object.freeze({
  /** Wall-clock prior for one step (one model call + its tools), ms. */
  priorStepMs: 25_000,
  /** Never trust a measured step shorter/longer than this when updating the EMA. */
  minStepMs: 1_000,
  maxStepMs: 20 * 60_000,
  /** EMA alpha for measured step duration (higher = trust the newest sample more). */
  stepAlpha: 0.35,

  /** How many steps a single turn takes by default. */
  priorStepsPerTurn: 8,
  minStepsPerTurn: 2,
  /** Turns longer than this are pathological for the estimate; clamp instead of extrapolating. */
  maxStepsPerTurn: 80,
  turnAlpha: 0.3,

  /** How many steps one todo item costs by default. */
  priorStepsPerTodo: 4,
  minStepsPerTodo: 1,
  maxStepsPerTodo: 20,
  todoAlpha: 0.4,

  /** remaining = planStepWeight * planRemaining + (1 - planStepWeight) * stepModelRemaining */
  planStepWeight: 0.65,
  /** percent = planPercentWeight * planPercent + (1 - planPercentWeight) * stepPercent */
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
    /** Measured step duration EMA (ms). */
    stepMs: p.priorStepMs,
    /** Measured steps-per-turn EMA. */
    stepsPerTurn: p.priorStepsPerTurn,
    /** Measured steps-per-todo-item EMA. */
    stepsPerTodo: p.priorStepsPerTodo,
    stepSamples: 0,
    turnSamples: 0,
    todoSamples: 0,
    /** Displayed percent of the current turn — monotonic inside one turn. */
    turnPercent: -1,
    /** Turn index the monotonic state belongs to. */
    percentTurn: -1,
    /** Smoothed ETA (ms) of the current turn. */
    etaMs: null,
  };
}

/** Reset the per-turn display state (called on `turn/start`). */
export function beginTurn(model, turn) {
  model.turnPercent = -1;
  model.percentTurn = turn;
  model.etaMs = null;
}

/** Fold one measured step duration (turn/end time minus turn/start time, divided by steps). */
export function observeStepMs(model, ms) {
  const p = model.params;
  if (!Number.isFinite(ms) || ms <= 0) return;
  const sample = clamp(ms, p.minStepMs, p.maxStepMs);
  model.stepMs = clamp(ema(model.stepMs, sample, p.stepAlpha), p.minStepMs, p.maxStepMs);
  model.stepSamples += 1;
}

/**
 * Fold one finished turn into the model.
 * `steps` is how many steps the finished turn burned; `todoDelta` is how many
 * todo items went from not-completed to completed during that turn (0 when the
 * turn had no plan).
 */
export function observeTurn(model, { durationMs, steps, todoDelta } = {}) {
  const p = model.params;
  if (Number.isFinite(steps) && steps > 0) {
    model.stepsPerTurn = clamp(
      ema(model.stepsPerTurn, clamp(steps, p.minStepsPerTurn, p.maxStepsPerTurn), p.turnAlpha),
      p.minStepsPerTurn,
      p.maxStepsPerTurn,
    );
    model.turnSamples += 1;
  }
  if (Number.isFinite(durationMs) && durationMs > 0) {
    if (Number.isFinite(steps) && steps > 0) observeStepMs(model, durationMs / steps);
  }
  if (Number.isFinite(todoDelta) && todoDelta > 0 && Number.isFinite(steps) && steps > 0) {
    const sample = clamp(steps / todoDelta, p.minStepsPerTodo, p.maxStepsPerTodo);
    model.stepsPerTodo = clamp(
      ema(model.stepsPerTodo, sample, p.todoAlpha),
      p.minStepsPerTodo,
      p.maxStepsPerTodo,
    );
    model.todoSamples += 1;
  }
}

/**
 * Estimate progress for the turn currently running.
 *
 * @param {object} model state from createModel()
 * @param {object} facts
 * @param {boolean} facts.running            is a turn running right now
 * @param {number}  facts.stepsDone          completed steps of the current turn
 * @param {number}  facts.stepStartedAt      epoch ms when the current step started (null before step/start)
 * @param {number}  facts.now                epoch ms "now"
 * @param {Array<{content:string,status:string}>|null} facts.todos latest todo plan (null when none)
 * @param {number}  [facts.turn]             current turn index
 * @returns {{percent:number,etaMs:number,remainingSteps:number,expectedSteps:number,basis:string,confidence:string,breakdown:object}}
 */
export function estimate(model, facts) {
  const p = model.params;
  const running = facts.running === true;
  const turn = Number.isFinite(facts.turn) ? facts.turn : model.percentTurn;
  if (turn !== model.percentTurn) beginTurn(model, turn);

  if (!running) {
    model.turnPercent = 1;
    model.etaMs = 0;
    return {
      percent: 1,
      etaMs: 0,
      remainingSteps: 0,
      expectedSteps: facts.stepsDone || 0,
      basis: 'done',
      confidence: 'high',
      breakdown: {},
    };
  }

  const stepsDone = Math.max(0, Number(facts.stepsDone) || 0);
  const stepElapsed =
    Number.isFinite(facts.stepStartedAt) && facts.now > facts.stepStartedAt
      ? facts.now - facts.stepStartedAt
      : 0;
  // How far through the current step are we? A step that already ran longer than
  // the EMA is treated as "almost done" rather than extrapolated to 100%.
  const stepFraction = facts.stepStartedAt ? clamp(stepElapsed / model.stepMs, 0, 0.9) : 0;
  const currentStepRemainingMs = facts.stepStartedAt
    ? Math.max(model.stepMs * 0.15, model.stepMs - stepElapsed)
    : model.stepMs;

  // ── estimator 1: step model ────────────────────────────────────────────────
  let expectedTurnSteps = Math.max(model.stepsPerTurn, p.minStepsPerTurn);
  // Late in a turn the "average turn" is no longer credible: widen it so the bar
  // keeps moving instead of pinning at the cap.
  if (stepsDone + 1 > expectedTurnSteps) {
    expectedTurnSteps = stepsDone + 1 + Math.max(2, (stepsDone + 1) * 0.5);
  }
  const stepModelRemaining = Math.max(0.5, expectedTurnSteps - stepsDone - stepFraction);

  // ── estimator 2: plan model (only with a todo plan) ────────────────────────
  let plan = null;
  const todos = Array.isArray(facts.todos) ? facts.todos : null;
  if (todos !== null && todos.length > 0) {
    const total = todos.length;
    const completed = todos.filter((item) => item && item.status === 'completed').length;
    const inProgress = todos.some((item) => item && item.status === 'in_progress');
    const pending = total - completed;
    if (pending > 0) {
      let planRemainingSteps = pending * model.stepsPerTodo;
      if (inProgress) planRemainingSteps -= model.stepsPerTodo * p.inProgressCredit;
      plan = {
        total,
        completed,
        inProgress,
        planRemainingSteps: Math.max(0.5, planRemainingSteps),
        planPercent: clamp((completed + (inProgress ? p.inProgressCredit : 0)) / total, 0, 1),
      };
    }
  }

  const remainingSteps = plan
    ? p.planStepWeight * plan.planRemainingSteps + (1 - p.planStepWeight) * stepModelRemaining
    : stepModelRemaining;

  const expectedSteps = stepsDone + stepFraction + remainingSteps;
  const stepPercent = expectedSteps > 0 ? (stepsDone + stepFraction) / expectedSteps : 0;
  const rawPercent = plan
    ? p.planPercentWeight * plan.planPercent + (1 - p.planPercentWeight) * stepPercent
    : stepPercent;

  // Monotonic inside one turn: steps can only move forward, so the bar must too.
  const percent = clamp(
    Math.max(model.turnPercent, rawPercent, p.percentFloor),
    p.percentFloor,
    p.percentCap,
  );
  model.turnPercent = percent;

  // ── ETA: current step remainder + the steps after it ───────────────────────
  const futureSteps = Math.max(0, remainingSteps - (facts.stepStartedAt ? 1 - stepFraction : 0));
  let etaMs = currentStepRemainingMs + futureSteps * model.stepMs;
  etaMs = clamp(etaMs, p.minEtaMs, p.maxEtaMs);
  model.etaMs = model.etaMs === null ? etaMs : ema(model.etaMs, etaMs, p.etaAlpha);

  // ── Confidence: how much history backs the number ──────────────────────────
  let score = 0.2 + 0.11 * Math.min(4, stepsDone);
  if (plan) score += 0.15;
  if (model.turnSamples >= 1) score += 0.1;
  if (model.turnSamples >= 3) score += 0.05;
  if (model.stepSamples >= 3) score += 0.05;
  score = clamp(score, 0.15, 0.9);
  const confidence = score >= 0.7 ? 'high' : score >= 0.45 ? 'medium' : 'low';

  return {
    percent: round(percent, 4),
    etaMs: Math.round(model.etaMs),
    remainingSteps: round(remainingSteps, 2),
    expectedSteps: round(expectedSteps, 2),
    basis: plan ? 'plan' : 'step-model',
    confidence,
    breakdown: {
      stepsDone,
      stepFraction: round(stepFraction, 3),
      stepMs: Math.round(model.stepMs),
      expectedTurnSteps: round(expectedTurnSteps, 2),
      stepModelRemaining: round(stepModelRemaining, 2),
      planRemainingSteps: plan ? round(plan.planRemainingSteps, 2) : null,
      planPercent: plan ? round(plan.planPercent, 3) : null,
      stepPercent: round(stepPercent, 3),
      confidenceScore: round(score, 3),
      samples: { steps: model.stepSamples, turns: model.turnSamples, todos: model.todoSamples },
    },
  };
}

export default { DEFAULT_PARAMS, createModel, beginTurn, observeStepMs, observeTurn, estimate };
